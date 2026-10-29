#!/usr/bin/env ruby
# frozen_string_literal: true
# node <-> ruby 互操作测试
#
# 方向 1: node 发 -> ruby 收
# 方向 2: ruby 发 -> node 收
#
# 验证两套实现说的是同一个 BDR 协议。
require_relative '../_env_/ruby/_ext_notify_'

CH = 'interop-test'
PORT = (ENV['TEST_PORT'] || '3000').to_i
HERE = File.dirname(__FILE__)
NODE_BASE = File.expand_path('../_env_/node/_ext_notify_.mjs', HERE)

$pass = 0
$fail = 0

def check(label, got, want)
  ok = (got == want)
  puts("  #{ok ? 'OK  ' : 'FAIL'} #{label}: got=#{got.inspect} want=#{want.inspect}")
  ok ? $pass += 1 : $fail += 1
end

def node_send(msg, port, channel)
  script = <<~JS
    import('#{NODE_BASE}').then(async (m) => {
      const t = new m.TcpNotify('node-tx', { port: #{port}, channel: '#{channel}' });
      await new Promise(r => setTimeout(r, 400));
      t.send(#{msg.to_json});
      await new Promise(r => setTimeout(r, 400));
      t.stop();
      process.exit(0);
    });
  JS
  # 写到临时文件再跑 —— node -e 的引号转义太容易出错
  f = '/tmp/node_interop_tx.mjs'
  File.write(f, script)
  `node #{f} 2>&1`
end

puts '=== 方向 1: node 发 -> ruby 收 ==='
recv = []
ruby_peer = TcpNotify.new("ruby-peer", port: PORT, channel: CH)
ruby_peer.notify(CH) { |m| recv << m.data }
sleep(0.6)

node_send('from-node', PORT, CH)
sleep(1.0)

puts "  ruby 收到: #{recv.map { |d| d.dup.force_encoding('UTF-8') }.inspect}"
check('ruby 收到 node 发的', recv.first&.dup&.force_encoding('UTF-8'), 'from-node')

puts "\n=== 方向 2: ruby 发 -> node 收 ==="
out = '/tmp/node_interop.txt'
rcv = File.expand_path('node/tcpnotify_interop_rcv.mjs', HERE)
pid = spawn('node', rcv, PORT.to_s, CH, out, '4000', out: File::NULL, err: File::NULL)
sleep(1.2)   # 等 node 连上并订阅好

ruby_peer.notify(CH, 'from-ruby')
sleep(1.2)

got = File.exist?(out) ? File.read(out).split("\n").reject(&:empty?) : []
puts "  node 收到: #{got.inspect}"
check('node 收到 ruby 发的', got.include?('from-ruby'), true)

# 中文
ruby_peer.notify(CH, '中文')
sleep(0.8)
got2 = File.exist?(out) ? File.read(out).split("\n").reject(&:empty?) : []
puts "  node 收到: #{got2.inspect}"
check('node 收到 ruby 发的中文', got2.include?('中文'), true)

Process.kill('TERM', pid) rescue nil
Process.wait(pid) rescue nil
ruby_peer.stop

puts "\n=== #{$pass} 通过, #{$fail} 失败 ==="
exit($fail.zero? ? 0 : 1)
