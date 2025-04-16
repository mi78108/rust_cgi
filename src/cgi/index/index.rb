#!/usr/bin/env ruby

# -*- coding: utf-8 -*-

require 'redis'
require 'json'
require 'connection_pool'
require_relative '../_base'


#全局广播
#聊天室
Q.on :WEBSOCKET do |r|
  key = $$.to_s
  uid = $$.to_s
    if Q.param('argv_1') == 'room'
        if Q.param('argv_2')
            key = Q.param('argv_2')
        end
    end
  STDERR.puts ">>>>>>>>>>>>>>>>>>>>>>> #{key}"

  redis ||= ConnectionPool::Wrapper.new do
      Redis.new
  end

  thread = Thread.new do
      call_func = lambda do |c, val|
          if Q.param('argv_1') == 'room'
              return if c == 'client_broadcast'
            if c == "client_#{key}"
              info = JSON.parse(val)
              return if info['from'] == uid
            end
          end

        if c == 'client_opt'
            Q.send ({'opt' => 'info', 'value' => { 'value' => val }}).to_json
        end
        if c == 'client_broadcast'
            info = JSON.parse(val)
            return if uid == info['from']
            Q.send ({'opt' => 'text', 'value' => info['value'], 'from' => info['from'], 'to' => info['to'] }).to_json
        end
        if c == "client_#{key}"
            info = JSON.parse(val)
            Q.send ({'opt' => 'text', 'value' => info['value'], 'from' => info['from'], 'to' => info['to'] }).to_json
        end
      end
      redis.subscribe('client_opt', 'client_broadcast', "client_#{key}") do |on|
        on.message do |c, m|
            STDERR.puts ">>>>>>>>>>>>>>>>>>>>>>> redis sub recv #{c} #{m}"
            val = m.force_encoding('utf-8')
            call_func.call(c, val)
        end
      end
  end

  Q.on_close do
      Thread::kill thread
      #redis = Redis.new
      redis.publish 'client_opt', "#{uid} 已离线"
      count = redis.hget('clients', 'count').to_i
      redis.hset('clients', 'count', count - 1)
      redis.hdel 'clients', "#{uid}"
      redis.close
  end


  redis.publish 'client_opt', "#{uid} 已上线"
  redis.hset 'clients', "#{uid}", 'online'
  count = redis.hget('clients', 'count').to_i + 1
  redis.hset('clients', "count", count)

  Q.send({'opt' => 'text', 'value'=> "#{uid} 已上线"}.to_json)
  Q.send ({'opt' => 'set', 'value' => {'uid' => uid} }).to_json
  if Q.param('argv_1') == 'room'
    #Q.send ({'opt' => 'set', 'value' => {'sendTo' => "#{key}"} }).to_json
  else
    Q.send ({'opt' => 'info', 'value' => redis.hgetall('clients') }).to_json
  end

  Q.recv do |data|
      info = JSON.parse data
      case info['opt']
          when 'input'
              if Q.param('argv_1') == 'room'
                redis.publish "client_#{key}", ({'from' => uid, 'to' => key,'value' => info['value']}).to_json
              else
                redis.publish "client_broadcast",    ({'from' => uid ,'to' => 'broadcast','value' => info['value']}).to_json
              end

              info['opt'] = 'info'
              info['value'] = {'result': '发送成功'}
              Q.send info.to_json
          when 'send'
              STDERR.puts info.to_json
              redis.publish "client_#{info['to']}" , ({'from' => uid,'to' => info['to'],'value' => info['value']}).to_json
              Q.send ({'opt' => 'cmd', 'value' => {'result': '发送成功'} }).to_json
          when 'cmd'
              case info['value']
                  when '@refresh'
                      Q.send ({'opt' => 'info', 'value' => redis.hgetall('clients') }).to_json
                  else
                      Q.send ({'opt' => 'cmd', 'value' => 'unSupport'}).to_json
              end
          else
              Q.send info.to_json
      end
  end
end

Q.on :GET do |r|
  resp_ok :html, File::read('./index/page.html')
end

