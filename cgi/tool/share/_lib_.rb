#!/usr/bin/env ruby
# frozen_string_literal: true
#
# _lib_.rb — tool/share 各脚本的公共部分
#
# 定位：只放「多个脚本逐字相同的机械代码」——常量、路径拼装、
#       meta.json 读写、JSON 响应封装、分片扫描。
#       不放任何业务判断（密码校验、授权、失效判定、文件名清洗各脚本
#       语义有别，见文件末尾「刻意不抽」）。
#
# 用法（每个脚本）：
#   require_relative '../../_base_'
#   require_relative '_lib_'          # ← 本文件
#
# 抽出来的依据：这 9 个脚本（create/delete/download/edit/finish/index/
# list/preview/upload）在写这块代码时是各写各的，逐字对比后确认完全一致。
# 本文件只做搬迁，不改一行逻辑。
#
# ---------- 存储根目录 ----------
#
# SPIDER_DATA 未设置时默认 /tmp/share —— 部署时用环境变量改，不用改代码。
SHARE_ROOT = ENV.fetch('SPIDER_DATA', nil).to_s.empty? ? '/tmp/share' : ENV['SPIDER_DATA']

# 建根目录。index / preview 只读不写，这两个脚本没有这句 ——
# 保持原样：让「只读脚本」不去碰文件系统。
def ensure_share_root!
  FileUtils.mkdir_p(SHARE_ROOT) unless File.directory?(SHARE_ROOT)
end

# 脚本顶部原样是 `FileUtils.mkdir_p(SHARE_ROOT) unless File.directory?(SHARE_ROOT)`
# 这一行就地执行；搬进方法后由脚本显式调一次，行为一致。
# 上面各脚本顶部的 SHARE_ROOT + mkdir 两行已删，改为 require 后调用本方法。

# ---------- 存储布局 ----------
#
#   $SPIDER_DATA/<token>/meta.json   元信息
#   $SPIDER_DATA/<token>/data        原始字节（分片上传时 finish 合并而成）
#   $SPIDER_DATA/<token>/part/<n>    每个分片一个文件（幂等：重传直接覆盖）
#   token = SecureRandom.hex(8) → 16 位 hex

def dir_of(token)   = File.join(SHARE_ROOT, token)
def meta_path(token) = File.join(dir_of(token), 'meta.json')
def data_path(token) = File.join(dir_of(token), 'data')

# ---------- meta.json 读写 ----------

def load_meta(token)
  p = meta_path(token)
  return nil unless File.file?(p)
  JSON.parse(File.read(p)) rescue nil
end

def save_meta(token, m)
  File.write(meta_path(token), m.to_json)
end

# ---------- 分片 ----------

# 已收到的分片号 → [0, 2, 5, ...]（升序）
# 两个脚本叫不同名字（list 的 scan_parts / finish+upload 的 got_parts），
# 实现逐字相同，统一成 got_parts。
def got_parts(token)
  pdir = File.join(dir_of(token), 'part')
  return [] unless File.directory?(pdir)
  Dir.children(pdir).select { |f| f =~ /\A\d+\z/ }.map(&:to_i).sort
end

# ---------- JSON 响应 ----------

# 9 个脚本都是这一句。
def json(rsp, code, payload)
  rsp.code(code).type_json.body(payload.to_json).finish
end

# ---------- 刻意不抽（语义各脚本不同，合并会改行为）----------
#
# dead_reason / dead?    list 返回 'quota'/'expired'/nil（字符串，给前端看），
#                        download 返回 :quota/:expired/:none（符号，给 reap_if_dead 用），
#                        preview 返回 true/false（布尔）。判定条件一样但返回形式不同，
#                        统一形式会影响各脚本现有调用点，本次不动。
#
# sanitize_name           create/upload 去控制字符 [\x00-\x1f\x7f]；
#                        download 额外去 " \r \n —— 因为它要塞进 Content-Disposition
#                        响应头，换行会截断头部、引号会破坏 header 语法。
#                        是真实的业务差异，不能合并。
#
# 授权校验（by == c / pw 匹配）  delete 允许 c 或 pw 任一通过，
#                        edit 只认 c。策略不同，留在各自脚本里。
