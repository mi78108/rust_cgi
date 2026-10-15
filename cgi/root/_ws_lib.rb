# frozen_string_literal: true
# root/_ws_lib.rb — 主站 WebSocket 业务逻辑
#
# 仅提供: 常量 + 全局状态 + 工具函数. 不注册 Q.map (避免 require 时副作用 / bind 副作用)
#
# 用法 (在 cgi/root/index 里):
#   require_relative '_ws_lib'
#   Q.map(:WEBSOCKET) do |_|
#     ...调用这里的函数...
#   end

require 'json'

WS_CHANNEL     = 4444  # (保留兼容, 当前未使用 — 已迁到 Q.notify_fs)
ONLINE_TTL     = 60    # 秒, 客户端 N 秒没心跳算掉线
HEARTBEAT      = 15    # 秒, server 每 N 秒 ping 一次, 客户端必须回 pong
SYSTEM_INTERVAL = 5   # 秒, system snapshot 推送间隔

# 进程内共享状态 (每个 ws fork 进程独立 — fork 模型下不能用进程变量做跨进程通信)
# 跨进程数据走 Q.notify_fs('root', data) (你的实现: 监听 /tmp/notify_fs/<channel>)
# 本进程永远只服务一个 ws 连接, 用单值 hash 直接表示
$self_user        = {:id=>Process.pid}     # { name:, ip:, last_seen: } 或 nil (fork 模型下最多 1 个)
$ws_served_count  = 0       # 本进程累计处理的 ws 事件数 (page.html 上 "served" 显示)
$ws_last_seen_s   = 0       # 本进程最近一次 ws event 的 epoch s

# ── 在线用户工具 (本进程视角) ───────────────────────
def self_user_alive?
  return false if $self_user.nil?
  ($self_user[:last_seen] || 0) >= (Time.now.to_i - ONLINE_TTL)
end


def self_user_names
  self_user_alive? ? [$self_user[:name]] : []
end


# 心跳续期
def ws_keepalive
  $self_user[:last_seen] = Time.now.to_i if $self_user
  $ws_served_count += 1
  $ws_last_seen_s = Time.now.to_i
end

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

# 处理一帧 JSON (返回 :pong / :hello / :subscribe / :unsubscribe / :publish / :renamed / :bad_name / :unknown)
def ws_handle_frame(msg)
  ws_keepalive
  case msg['op']
  when 'ping'         then :pong
  when 'pong'         then :pong  # ack
  when 'subscribe'    then :subscribe
  when 'unsubscribe'  then :unsubscribe
  when 'publish'      then :publish
  when 'hello'        then :hello
  when 'set-name'
     name = msg['name'].to_s
    if name =~ /\A[a-zA-Z0-9_-]{1,20}\z/ && $self_user
      $self_user[:name] = name
      :renamed
    else
      :bad_name
    end
  else
    :unknown
  end
end