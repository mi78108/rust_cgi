#!/usr/bin/env ruby

require_relative '../_base'

if ENV['req_body_method'] == 'WEBSOCKET'
    recv do |data|
        STDOUT.puts data
        STDOUT.flush
    end
end

if ENV['req_method'] == 'POST'
    recv do |data|
        STDERR.puts  ">>>>>>>>>>>"+data
    end
  resp_ok :html, "OK"
end

if ENV['req_method'] == 'GET'
  resp_ok :html, File::read('./index/page.html')
end
