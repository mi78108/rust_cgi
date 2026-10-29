#!/usr/bin/env ruby
# frozen_string_literal: true
# TcpNotify 显式 host/port 覆盖 —— 真连一次, 验证参数生效
require_relative '../_env_/ruby/_ext_notify_'

$pass = 0
$fail = 0

def check(label, got, want)
  ok = (got == want)
  puts("  #{ok ? 'OK  ' : 'FAIL'} #{label}: got=#{got.inspect} want=#{want.inspect}")
  ok ? $pass += 1 : $fail += 1
end

PORT = ENV.fetch('TEST_PORT', '3000').to_i

puts '=== 1. 显式 host/port 被采纳 ==='
t = TcpNotify.new('explicit', host: '127.0.0.1', port: PORT, channel: 'explicit-test')
check('host', t.host, '127.0.0.1')
check('port', t.port, PORT)
check('channel', t.channel, 'explicit-test')
check('连上了', t.connected?, true)
t.stop

puts "\n=== 2. 不传 host/port -> 默认 127.0.0.1 + Cgi_Port/3000 ==="
t2 = TcpNotify.new('default', channel: 'default-test')
check('host', t2.host, '127.0.0.1')
expected_port = (ENV['Cgi_Port'] || '').to_i
expected_port = 3000 if expected_port <= 0
check('port', t2.port, expected_port)
t2.stop

puts "\n=== 3. 只传 host, port 走默认 ==="
t3 = TcpNotify.new('hostonly', host: '127.0.0.1', channel: 'hostonly-test')
check('host', t3.host, '127.0.0.1')
check('port', t3.port, expected_port)
t3.stop

puts "\n=== 4. 只传 port, host 走默认 ==="
t4 = TcpNotify.new('portonly', port: PORT, channel: 'portonly-test')
check('host', t4.host, '127.0.0.1')
check('port', t4.port, PORT)
t4.stop

puts "\n=== #{$pass} 通过, #{$fail} 失败 ==="
exit($fail.zero? ? 0 : 1)
