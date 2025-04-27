#!/usr/bin/env ruby

# -*- coding: utf-8 -*-

require 'redis'
require 'json'
require_relative '../_base'


uid = $$.to_s
room = Q.param_or('argv_1', 'default')
expire_time = 60 * 30
room_key = "client_#{room}"
uid_key = "client_#{uid}"
#全局广播
#聊天室
Q.on :WEBSOCKET do |r|
  thread = Thread.new do
      redis = Redis.new
      redis.subscribe('client_opt', room_key, uid_key, '__keyevent@0__:expired') do |on|
        on.message do |c, val|
            STDERR.puts ">>>>>>>>>>>>>>>>>>>>>>> redis sub recv #{uid} #{c} #{val}"
            if c == '__keyevent@0__:expired'
              Q.send ({'opt' => 'info', 'value' => {"Notice" => "Room: #{room} -> 已过期关闭"}}).to_json
              Q.send ({'opt' => 'text', 'value' => "Room: #{room} 已过期关闭" }).to_json
              val == room_key && exit(0)
              next
            end
            begin
                val = JSON.parse val.force_encoding('utf-8')
                if val['from'] != uid
                    if c == room_key
                        # 同一房间 下发信息
                        STDERR.puts ">>>>>>>>>>>>>>>>>>>>>>> redis sub send"
                        val['type'] = 'room'
                        Q.send val.to_json
                    end
                    if c == uid_key
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
  redis.hset room_key, "#{uid}", 'online'
  redis.hincrby(room_key, "count", 1)
  redis.expire(room_key, expire_time)

  Q.send ({'opt' => 'text', 'value'=> "#{uid} 已上线"}).to_json
  Q.send ({'opt' => 'set', 'value' => {'uid' => uid, 'room' => room}}).to_json
  Q.send ({'opt' => 'info', 'event' => 'click' ,'value' => redis.hgetall(room_key)}).to_json

  Q.recv do |data|
      redis.expire(room_key, expire_time)
      info = JSON.parse data
      case info['opt']
          when 'input'
              redis.publish room_key, ({'opt' => 'text', 'from' => uid ,'to' => room, 'value' => info['value']}).to_json
              info['opt'] = 'info'
              info['value'] = {'Status': '发送成功'}
          when 'cmd'
              case info['value']
                  when '@refresh'
                      info['opt'] = 'info'
                      info['cmd'] = '@refresh'
                      info['value'] = redis.hgetall(room_key)
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
      redis.publish 'client_opt', ({'opt' => 'info', 'value' => {"Notice" => "#{room} -> #{uid} 已下线"}}).to_json
      redis.hincrby room_key, "count", -1
      redis.hdel room_key, uid
      redis.close
  end
end
