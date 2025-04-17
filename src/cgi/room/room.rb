#!/usr/bin/env ruby

# -*- coding: utf-8 -*-

require 'redis'
require 'json'
require_relative '../_base'


uid = $$.to_s
room = Q.param_or('argv_1', 'default')
#全局广播
#聊天室
Q.on :WEBSOCKET do |r|
  thread = Thread.new do
      redis = Redis.new
      redis.subscribe('client_opt', 'client_broadcast', "client_#{room}") do |on|
        on.message do |c, val|
            STDERR.puts ">>>>>>>>>>>>>>>>>>>>>>> redis sub recv #{uid} #{c} #{val}"
            begin
                val = JSON.parse val.force_encoding('utf-8')
                if val['from'] != uid
                    if c == "client_#{room}"
                        STDERR.puts ">>>>>>>>>>>>>>>>>>>>>>> redis sub send"
                        Q.send val.to_json
                    end
                    if c == 'client_opt'
                        Q.send val.to_json
                    end
                end
            rescue
                STDERR.puts ">>>>>>>>>>>>>>>>>>>>>>> Redis Subscribe Err #{$!}  #{$@}"
            end
        end
      end
      redis.close
  end


  redis = Redis.new
  redis.publish 'client_opt', ({'opt' => 'info', 'value' => {"Notice" => "#{room} -> #{uid} 已上线"}}).to_json
  redis.hset "client_#{room}", "#{uid}", 'online'
  redis.hincrby("client_#{room}", "count", 1)

  Q.send ({'opt' => 'text', 'value'=> "#{uid} 已上线"}).to_json
  Q.send ({'opt' => 'set', 'value' => {'uid' => uid, 'room' => room}}).to_json
  Q.send ({'opt' => 'info', 'value' => redis.hgetall("client_#{room}")}).to_json

  Q.recv do |data|
      info = JSON.parse data
      case info['opt']
          when 'input'
              redis.publish "client_#{room}", ({'opt' => 'text', 'from' => uid ,'to' => room,'value' => info['value']}).to_json
              info['opt'] = 'info'
              info['value'] = {'Status': '发送成功'}
          when 'send'
              STDERR.puts info.to_json
              redis.publish "client_#{info['to']}" , ({'from' => uid,'to' => info['to'],'value' => info['value']}).to_json
              info['opt'] = 'info'
              info['value'] = {'Status': '发送成功'}
          when 'cmd'
              case info['value']
                  when '@refresh'
                      info['opt'] = 'info'
                      info['value'] = redis.hgetall("client_#{room}")
                  else
                      info['opt'] = 'info'
                      info['value'] = 'unSupport'
              end
          else
              info['opt'] = 'info'
              info['value'] += ' 不支持'
      end
      Q.send info.to_json
  end

  Q.on_close do
      Thread::kill thread
      #redis = Redis.new
      redis.publish 'client_opt', ({'opt' => 'info', 'value' => {"Notice" => "#{room} -> #{uid} 已下线"}}).to_json
      redis.hincrby "client_#{room}", "count", -1
      redis.hdel "client_#{room}", uid
      redis.close
  end
end