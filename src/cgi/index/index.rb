#!/usr/bin/env ruby

require_relative '../_base'

Q.on :WEBSOCKET do |r|
  r.recv do |data|
    STDOUT.puts data
    STDOUT.flush
  end
end

Q.on :GET do |r|
  resp_ok :html, File::read('./index/page.html')
end
