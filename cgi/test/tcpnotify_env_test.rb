#!/usr/bin/env ruby
# frozen_string_literal: true
# TcpNotify 服务端地址解析测试
#
#   默认: 127.0.0.1 + ENV['Cgi_Port']（spider 注入的自己的监听端口）
#   显式传 host/port 优先
require_relative '../_env_/ruby/_ext_notify_'

$pass = 0
$fail = 0

def check(label, got, want)
  ok = (got == want)
  puts("  #{ok ? 'OK  ' : 'FAIL'} #{label}: got=#{got.inspect} want=#{want.inspect}")
  ok ? $pass += 1 : $fail += 1
end

ENV_KEY = 'Cgi_Port'.freeze

def resolve(env)
  t = TcpNotify.allocate
  t.instance_variable_set(:@name, 'x')
  saved = ENV[ENV_KEY]
  ENV.delete(ENV_KEY)
  ENV[ENV_KEY] = env[ENV_KEY] if env.key?(ENV_KEY)
  r = t.send(:resolve_endpoint)
  saved.nil? ? ENV.delete(ENV_KEY) : ENV[ENV_KEY] = saved
  r
end

puts '=== 1. 默认: 127.0.0.1 + Cgi_Port ==='
check('Cgi_Port 有值', resolve(ENV_KEY => '8080'), ['127.0.0.1', 8080])
check('Cgi_Port 没有', resolve({}), ['127.0.0.1', 3000])
check('Cgi_Port 非数字', resolve(ENV_KEY => 'abc'), ['127.0.0.1', 3000])
check('Cgi_Port 为 0', resolve(ENV_KEY => '0'), ['127.0.0.1', 3000])
check('Cgi_Port 空串', resolve(ENV_KEY => ''), ['127.0.0.1', 3000])

puts "\n=== 2. 主机名写死 127.0.0.1 ==="
check('不跟 Host 头走', resolve(ENV_KEY => '8080'), ['127.0.0.1', 8080])

puts "\n=== 3. 显式传 host/port 优先 ==="
# initialize 里是 host || auto_host —— 显式传的赢
t = TcpNotify.allocate
t.instance_variable_set(:@name, 'x')
auto_host, auto_port = t.send(:resolve_endpoint)
check('显式 host', '10.0.0.9' || auto_host, '10.0.0.9')
check('显式 port', 9999 || auto_port, 9999)

puts "\n=== #{$pass} 通过, #{$fail} 失败 ==="
exit($fail.zero? ? 0 : 1)
