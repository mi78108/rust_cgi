#!/usr/bin/env ruby
# frozen_string_literal: true
#
# cgi/test/framework/notify_helper.rb — _base_.rb 组装期用到的假 Notify 子类
#
# 单独成文件, 供 test/framework/index require_relative 复用。
# CaptureNotify 把 do_send_packet 换成"记下来", 从而能在不开真 socket 的
# 前提下测 Notify 的线上协议(HEADER 拼解 / payload 保真 / 回环语义)。
#
# 为什么不用真 SocketNotify: 它在 initialize 里就 bind UDP 5000 + 加组播成员
# + 起 loop 线程, 每个 HTTP 请求都起一个真 socket 会互相抢端口且留后台线程。
# 协议本身与传输无关, 用假子类验更干净。
#
# 注意文件名必须带 .rb 后缀 —— require_relative 才找得到。

require_relative '../../../_env_/ruby/_ext_notify_'

class CaptureNotify < Notify
  attr_reader :sent

  def initialize(name)
    super(name)
    @sent = []
  end

  protected

  # 记录出站包, 不发
  def do_send_packet(bytes)
    @sent << bytes.dup
    bytes.bytesize
  end

  def header_fields = ["n=#{@name}", "h=testhost", "p=#{Process.pid}"]

  # 复用 SocketNotify 的解析语义, 但不依赖真实 socket 地址
  def parse_packet(data, addr)
    header, body = split_packet(data)
    return nil if header.to_s.empty?

    Message.new(
      kind: header_kv(header, :kind) || 'msg',
      name: header_kv(header, :name),
      host: header_kv(header, :host),
      pid: header_kv(header, :pid)&.to_i,
      seq: (header_kv(header, :seq) || 0).to_i,
      from: addr,
      channel: (header_kv(header, :channel) || 'default').to_sym,
      data: body,
      header: header
    )
  end
end