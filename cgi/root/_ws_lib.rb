# frozen_string_literal: true
# root/_ws_lib.rb — 主站 WebSocket 业务逻辑
#
# 仅提供: 常量 + 全局状态 + 工具函数. 不注册 Q.map (避免 require 时副作用 / bind 副作用)
#
require 'json'

ONLINE_TTL     = 60    # 秒, 客户端 N 秒没心跳算掉线
HEARTBEAT      = 15    # 秒, server 每 N 秒 ping 一次, 客户端必须回 pong
SYSTEM_INTERVAL = 5   # 秒, system snapshot 推送间隔


# 当前客户端 ip (从 env 推断)
def ws_client_ip
  (ENV['Req_Header_X-Forwarded-For'] || ENV['REMOTE_ADDR'] || 'unknown').to_s.split(',').first.strip
end

# 系统快照 (用于 ws 推送给前端展示)
# - uptime: 秒 (int)
# - load: 1min / 5min / 15min (Float)
# - mem: total/avail/free/used (单位 KB, 整数)
# - served: 本进程累计 event 数
# - last_seen_s: 本进程最近 event 的 epoch s
def ws_system_snapshot
  uptime = begin
    up, _idle = File.read('/proc/uptime').split.map(&:to_f)
    up.to_i
  rescue
    -1
  end

  load = begin
    File.read('/proc/loadavg').split.first(3).map(&:to_f)
  rescue
    []
  end

  mem = begin
    info = {}
    File.foreach('/proc/meminfo') do |line|
      k, v = line.split(':')
      next unless v
      info[k] = v.strip.split.first.to_i  # KB
    end
    total = info['MemTotal'] || 0
    avail = info['MemAvailable'] || 0
    free  = info['MemFree'] || 0
    used  = total - avail
    { total_kb: total, avail_kb: avail, free_kb: free, used_kb: used,
      used_pct: total.positive? ? (used * 100.0 / total).round(1) : 0 }
  rescue
    { total_kb: 0, avail_kb: 0, free_kb: 0, used_kb: 0, used_pct: 0 }
  end

  { ts: Time.now.to_i, uptime_s: uptime, load: load, mem: mem,
    served: $ws_served_count.to_i, last_seen_s: $ws_last_seen_s.to_i }
end