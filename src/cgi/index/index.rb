#!/usr/bin/env ruby

require_relative '../_base'





if ENV['req_body_method'] == 'WEBSOCKET'
  loop do
     data = STDIN.gets
    STDERR.puts data
    print data
  end
end

if ENV['req_method'] == 'POST'
    STDERR.puts ">>>>>>" + STDIN.gets

  resp 200, 'html', "OK"
end

if ENV['req_method'] == 'GET'
  resp 200, 'html', File::read('./index/page.html')
end
