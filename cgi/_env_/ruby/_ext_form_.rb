#!/usr/bin/env ruby
# frozen_string_literal: true
#
# _ext_form_.rb — multipart/form-data 扩展模块
#
# 提供 Q::FormItem + Q::Form（解析 multipart HTTP body），
# 与 _base_.rb 中的 Req#body_form_data 配套使用。
#
# 用法（test 脚本或 _init_.rb 显式 require）：
#   require_relative '_ext_form_'
#
# 已踩：
#   - multipart part 之间用 boundary 分隔，可能含 \r\n 或 \n（兼容两种）
#   - 终止 boundary `--<boundary>--` 单独一行
#   - Content-Disposition 段里 name= 和 filename= 可能带引号要去掉

class Q
  class FormItem
    attr_reader :name, :filename, :content_type, :content

    def initialize(header, content)
      cd = (header['Content-Disposition'] || '').split(';').map(&:strip)
      name = nil
      filename = nil
      cd.each do |seg|
        k, v = seg.split('=', 2)
        next unless v
        # RFC 5987 扩展参数：filename*=UTF-8''%E6%8A%A5%E5%91%8A.txt
        # 浏览器上传非 ASCII 文件名时优先用这个，必须单独认。
        if k.casecmp('filename*').zero?
          filename = FormItem.decode_ext_param(v)
          next
        end
        next unless k.casecmp('name').zero? || k.casecmp('filename').zero?
        v = v.gsub(/\A"|"\z/, '')
        # 裸 filename 里也可能是 %XX 编码（部分客户端不加 filename*）
        filename = FormItem.unescape_percent(v) if k.casecmp('filename').zero?
        name = v if k.casecmp('name').zero?
      end
      @name = name
      @filename = filename
      @content_type = header['Content-Type'] || 'text/plain'
      @content = content
    end

    # 解 "UTF-8''%E6%8A%A5%E5%91%8A.txt" → "报告.txt"
    # charset'lang'pct-encoded 三段，charset 可能是 UTF-8 或 utf-8
    def self.decode_ext_param(v)
      v = v.gsub(/\A"|"\z/, '')
      parts = v.split("'", 3)
      enc = parts[0].to_s
      body = parts[2] || parts[-1].to_s
      body = unescape_percent(body)
      enc =~ /\Autf-8\z/i ? body.force_encoding('UTF-8') : body
    rescue StandardError
      v
    end

    # 只解 %XX，其余原样保留（避免把正常字符当转义）
    def self.unescape_percent(s)
      return s unless s.include?('%')
      s.gsub(/%([0-9A-Fa-f]{2})/) { [$1].pack('H2') }.force_encoding('UTF-8')
    rescue StandardError
      s
    end

    def file?
      !@filename.nil? && !@filename.empty?
    end

    def to_h
      {
        name:         @name,
        filename:     @filename,
        content_type: @content_type,
        size:         @content.bytesize,
      }
    end
  end

  class Form
    attr_reader :items

    def self.parse(boundary, &block)
      return nil unless boundary
      boundary = boundary.strip
      items = []
      STDIN.readline # 丢弃首行 CRLF
      loop do
        headers = {}
        while (line = STDIN.readline.chomp) != ''
          next unless line.include?(':')
          k, v = line.split(':', 2)
          headers[k.strip] = v.strip
        end
        content = +''
        finish_marker = nil
        loop do
          line = STDIN.readline
          if line.start_with?("--#{boundary}--\r\n") || line.start_with?("--#{boundary}--\n") || line.chomp == "--#{boundary}--"
            finish_marker = :final
            break
          elsif line.start_with?("--#{boundary}--") || line.start_with?("--#{boundary}")
            finish_marker = :more
            break
          else
            content << line
          end
        end
        content.chomp! # 去末尾 CRLF
        item = FormItem.new(headers, content)
        items << item
        block&.call(item)
        break if finish_marker == :final
      end
      new(items)
    end

    def initialize(items)
      @items = items
    end

    def [](name)
      @items.find { |i| i.name == name.to_s }
    end

    def each_file
      return enum_for(:each_file) unless block_given?
      @items.each { |i| yield i if i.file? }
    end

    def files_count
      @items.count(&:file?)
    end
  end
end