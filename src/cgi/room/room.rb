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
      redis.subscribe('client_opt', "client_#{room}", "client_#{uid}") do |on|
        on.message do |c, val|
            STDERR.puts ">>>>>>>>>>>>>>>>>>>>>>> redis sub recv #{uid} #{c} #{val}"
            begin
                val = JSON.parse val.force_encoding('utf-8')
                if val['from'] != uid
                    if c == "client_#{room}"
                        # 同一房间 下发信息
                        STDERR.puts ">>>>>>>>>>>>>>>>>>>>>>> redis sub send"
                        val['type'] = 'room'
                        Q.send val.to_json
                    end
                    if c == "client_#{uid}"
                        # 指定发送 下发信息
                        val['type'] = 'private'
                        Q.send val.to_json
                    end
                    if c == 'client_opt'
                        # 操作信息 全部下发
                        val['type'] = 'broadcast'
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
  Q.send ({'opt' => 'info', 'event' => 'click' ,'value' => redis.hgetall("client_#{room}")}).to_json

  Q.recv do |data|
      info = JSON.parse data
      case info['opt']
          when 'input'
              redis.publish "client_#{room}", ({'opt' => 'text', 'from' => uid ,'to' => room, 'value' => info['value']}).to_json
              info['opt'] = 'info'
              info['value'] = {'Status': '发送成功'}
          when 'cmd'
              case info['value']
                  when '@refresh'
                      info['opt'] = 'info'
                      info['cmd'] = '@refresh'
                      info['value'] = redis.hgetall("client_#{room}")
                  when '@send'
                      redis.publish "client_#{info['to']}" , ({'opt' => 'text', 'cmd'=>'@send', 'from' => uid, 'room' => room, 'to' => info['to'], 'value' => info['text']}).to_json
                      info['opt'] = 'info'
                      info['rst'] = {'Status': '发送成功'}
                  when '@call'
                      redis.publish "client_#{info['to']}" , ({'opt' => 'info', 'cmd' => '@call', 'from' => uid, 'room' => info['room'], 'to' => info['to'], 'value' => {'Notice' => 'Invites',"value" => info['text']}}).to_json
                      info['opt'] = 'info'
                      info['rst'] = {'Status': '发送成功'}
                  else
                      info['opt'] = 'info'
                      info['rst'] = {text: 'unSupport'}.to_json
              end
          else
              info['opt'] = 'info'
              info['rst'] = ' 不支持'
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