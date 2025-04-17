#!/usr/bin/env ruby

# -*- coding: utf-8 -*-

require 'redis'
require 'json'
require_relative '../_base'


uid = $$.to_s
#全局广播
#聊天室
Q.on :WEBSOCKET do |r|
  Q.recv do |data|
  end
end

Q.on :POST do |r|
    data = Hash.new
    data['type'] = Q.param('argv_1')
    data['room'] = Q.param('argv_2')
    resp_ok :json, data.to_json
end

Q.on :GET do |r|
    resp_ok :html, File::read('./index/page.html')
end

