#!/usr/bin/env ruby
# frozen_string_literal: true
# 直接测 dispatch_msg 的 own 判断 —— 不依赖服务端分配的 id
#
# id=0 是**合法**的连接 id（第一个连接就分到 0）。
# 之前的实现用 `id != 0` 判断"帧里有没有 id" -> id=0 的连接永远不跳过自己。
require_relative '../_env_/ruby/_ext_notify_'

$pass = 0
$fail = 0

def check(label, got, want)
  ok = (got == want)
  puts("  #{ok ? 'OK  ' : 'FAIL'} #{label}: got=#{got.inspect} want=#{want.inspect}")
  ok ? $pass += 1 : $fail += 1
end

# 造一个只测 dispatch 的假实例（不连服务器）
def fake_notify(id)
  t = TcpNotify.allocate
  t.instance_variable_set(:@name, 'fake')
  t.instance_variable_set(:@id, id)
  t.instance_variable_set(:@notify_lock, Mutex.new)
  t.instance_variable_set(:@subs, {})
  t
end

def msg_for(from_id)
  Notify::Message.new(
    kind: 'msg', name: nil, host: nil, pid: from_id, seq: nil,
    from: from_id.to_s, channel: :room, data: 'x'.b, header: "id=#{from_id}"
  )
end

puts '=== own 判断 (want_echo=false 时跳过自己) ==='

# id=0 的连接, 收到 id=0 的消息 -> 应该跳过
t0 = fake_notify(0)
got = []
t0.notify(:room, false) { |m| got << m.pid }
t0.send(:dispatch_msg, msg_for(0))
check('id=0 跳过自己的消息', got.empty?, true)

# id=0 的连接, 收到 id=5 的消息 -> 不应该跳过
t0b = fake_notify(0)
got2 = []
t0b.notify(:room, false) { |m| got2 << m.pid }
t0b.send(:dispatch_msg, msg_for(5))
check('id=0 收到别人的消息', got2, [5])

# id=3 的连接, 收到 id=3 -> 跳过
t3 = fake_notify(3)
got3 = []
t3.notify(:room, false) { |m| got3 << m.pid }
t3.send(:dispatch_msg, msg_for(3))
check('id=3 跳过自己的消息', got3.empty?, true)

# id=3 的连接, 收到 id=0 -> 不跳过
t3b = fake_notify(3)
got4 = []
t3b.notify(:room, false) { |m| got4 << m.pid }
t3b.send(:dispatch_msg, msg_for(0))
check('id=3 收到 id=0 的消息', got4, [0])

puts "\n=== want_echo=true 时不过滤（broadcast 含发送者）==="
t5 = fake_notify(5)
got5 = []
t5.notify(:room) { |m| got5 << m.pid }
t5.send(:dispatch_msg, msg_for(5))
check('收到自己的（回环）', got5, [5])

puts "\n=== 帧里没有 id (nil) 时不误判 ==="
t6 = fake_notify(0)
got6 = []
t6.notify(:room, false) { |m| got6 << m.pid }
t6.send(:dispatch_msg, Notify::Message.new(
  kind: 'msg', name: nil, host: nil, pid: nil, seq: nil,
  from: '', channel: :room, data: 'x'.b, header: ''
))
check('nil id 不被当成自己的', got6, [nil])

puts "\n=== #{$pass} 通过, #{$fail} 失败 ==="
exit($fail.zero? ? 0 : 1)
