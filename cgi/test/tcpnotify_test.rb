#!/usr/bin/env ruby
# frozen_string_literal: true
# TcpNotify 测试 —— 连真实的 spider (TCP 广播端口)
#
# 覆盖:
#   1. 握手, 拿到连接 id
#   2. 单连接发 + 收 (回环)
#   3. 两个连接互发
#   4. want_echo=false 跳过自己发的
#   5. 二进制 payload (中文)
#   6. 大 payload
require_relative '../_env_/ruby/_ext_notify_'

HOST = '127.0.0.1'
PORT = 3000
CH   = 'tcptest'

$pass = 0
$fail = 0

def check(label, got, want)
  ok = (got == want)
  puts("  #{ok ? 'OK  ' : 'FAIL'} #{label}: got=#{got.inspect} want=#{want.inspect}")
  ok ? $pass += 1 : $fail += 1
end

def wait_until(timeout = 3.0)
  t0 = Time.now
  sleep(0.02) until yield || (Time.now - t0) > timeout
  yield
end

puts '=== 1. 握手 ==='
a = TcpNotify.new('alice', host: HOST, port: PORT, channel: CH)
puts "  alice id=#{a.id} channel=#{a.channel} connected=#{a.connected?}"
check('id 是整数', a.id.is_a?(Integer), true)
# 注意: 第一个连接分到 id=0 —— id 0 是**合法**的, 不是"没有 id"
check('id >= 0', a.id >= 0, true)

b = TcpNotify.new('bob', host: HOST, port: PORT, channel: CH)
puts "  bob id=#{b.id}"
check('两个连接 id 不同', a.id != b.id, true)

puts "\n=== 2. 单连接发 + 收 (回环) ==="
recv_a = []
a.notify(CH) { |m| recv_a << m.data }
a.notify(CH, 'hello')
wait_until { !recv_a.empty? }
check('收到自己发的 (回环)', recv_a.first, 'hello')

puts "\n=== 3. 两个连接互发 ==="
recv_b = []
b.notify(CH) { |m| recv_b << [m.data, m.header] }
a.notify(CH, 'from-alice')
wait_until { !recv_b.empty? }
check('bob 收到 alice 的消息', recv_b.first&.first, 'from-alice')
puts "  bob 看到的 header: #{recv_b.first&.last.inspect}"
check('header 里有 id', recv_b.first&.last.to_s.start_with?('id='), true)
check('header 的 id 是 alice 的', recv_b.first&.last, "id=#{a.id}")

# 反向
recv_a2 = []
a.notify(CH) { |m| recv_a2 << m.data }
b.notify(CH, 'from-bob')
wait_until { !recv_a2.empty? }
check('alice 收到 bob 的消息', recv_a2.first, 'from-bob')

puts "\n=== 4. want_echo=false 跳过自己发的 ==="
recv_c = []
recv_d = []
c = TcpNotify.new('carol', host: HOST, port: PORT, channel: CH)
d = TcpNotify.new('dave',  host: HOST, port: PORT, channel: CH)
c.notify(CH, false) { |m| recv_c << m.data }
d.notify(CH, false) { |m| recv_d << m.data }
c.notify(CH, 'carol-says')
sleep(0.6)
check('carol 没收到自己的 (want_echo=false)', recv_c.empty?, true)
check('dave 收到了 carol 的', recv_d.first, 'carol-says')

puts "\n=== 4b. id=0 的连接也要能正确跳过自己 ==="
# 第一个连接分到 id=0 —— own 判断不能把 0 当成"没有 id"
recv_z = []
recv_z2 = []
z = TcpNotify.new('zero', host: HOST, port: PORT, channel: "#{CH}-zero")
z.notify("#{CH}-zero", false) { |m| recv_z << m.data }
z2 = TcpNotify.new('zero2', host: HOST, port: PORT, channel: "#{CH}-zero")
z2.notify("#{CH}-zero", false) { |m| recv_z2 << m.data }
z.notify("#{CH}-zero", 'zero-says')
sleep(0.6)
check('零号连接没收到自己的', recv_z.empty?, true)
check('另一个连接收到了', recv_z2.first, 'zero-says')
z.stop
z2.stop

puts "\n=== 5. 二进制 payload (中文) ==="
recv_e = []
e = TcpNotify.new('erin', host: HOST, port: PORT, channel: CH)
e.notify(CH) { |m| recv_e << m.data }
e.notify(CH, '中文测试')
wait_until { !recv_e.empty? }
check('中文原样收到', recv_e.first.dup.force_encoding('UTF-8'), '中文测试')
check('字节数正确', recv_e.first&.bytesize, '中文测试'.bytesize)

puts "\n=== 6. 大 payload (100KB) ==="
recv_f = []
f = TcpNotify.new('frank', host: HOST, port: PORT, channel: CH)
f.notify(CH) { |m| recv_f << m.data }
big = 'x' * 100_000
f.notify(CH, big)
wait_until(5.0) { !recv_f.empty? }
check('100KB 原样收到', recv_f.first&.bytesize, 100_000)

puts "\n=== 7. 频道隔离 ==="
recv_g = []
g = TcpNotify.new('gina', host: HOST, port: PORT, channel: 'other-room')
# want_echo=false —— 否则会收到自己发的（broadcast 含发送者, 这是对的）
g.notify('other-room', false) { |m| recv_g << m.data }
g.notify('other-room', 'should-not-reach')
sleep(0.6)
check('别的频道收不到 room1 的消息', recv_g.empty?, true)

# 显式验证: room1 的连接发的消息, other-room 收不到
recv_g2 = []
g.notify('other-room', false) { |m| recv_g2 << m.data }
a2 = TcpNotify.new('alice2', host: HOST, port: PORT, channel: CH)
a2.notify(CH, 'room1-only')
sleep(0.6)
check('other-room 收不到 room1 的消息', recv_g2.empty?, true)
a2.stop

puts "\n=== 8. 断开一个不影响另一个 ==="
recv_h = []
h = TcpNotify.new('hank', host: HOST, port: PORT, channel: CH)
h.notify(CH) { |m| recv_h << m.data }
a.stop
sleep(0.4)
h.notify(CH, 'after-stop')
wait_until { !recv_h.empty? }
check('另一个连接仍可用', recv_h.first, 'after-stop')

[b, c, d, e, f, g, h].each { |x| x.stop }

puts "\n=== #{$pass} 通过, #{$fail} 失败 ==="
exit($fail.zero? ? 0 : 1)
