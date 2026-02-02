class Req
  def body_form_data(&block)
    if block.nil?
      return Form_data.new
    end
    return Form_data.new block 
  end
end

class Form_item
  attr_accessor :header, :finished, :content
  def initialize(boundary, header, block)
    @boundary = boundary
    @header = Hash.new
    @finished = false
    header.each do |line|
      if line.include? ":"
        (k, v) = line.split(":")
        @header[k.strip] = v.strip
        if v.include? ";"
          v.split(";").each do |kv|
            if kv.include? "="
              (kk, vv) = kv.split("=")
              @header[kk.strip] = vv.strip.gsub(/^"|"$/, '')
            end
          end
        end
      end
    end

    if not block.nil?
      @cbk = block.call(@header)
      if @cbk.instance_of? Proc
        loop do
          line = STDIN.readline
          break if finished? line
          @cbk.call(line)
        end
        return
      end
    end

    @content = STDIN.each.take_while do |line|
      not finished? line
    end.map do |v|
      v.rstrip
      # if v.valid_encoding?
      #   v.chomp
      # else
      #   v
      # end
    end
  end

  def finished? line
    #line = line[0..@boundary.length]

    return false if not line.valid_encoding?
    if line.to_s.strip.eql? ('--' + @boundary)
      return true
    end
    if line.to_s.strip.eql? ('--' + @boundary + '--')
      @finished = true
      return true
    end
    return  false
  end
end

class Form_data
  attr_accessor :items
  def initialize(block = nil)
    @boundary=ENV['content-type']
    if not @boundary.include? 'form-data'
      return nil
    end
    @boundary = @boundary.split("boundary=").last
    _ = STDIN.readline
    @items = Array.new
    loop do
      Q.log "Part #{@items.size}"
      content = STDIN.each.take_while do |line|
        not line == "\r\n"
      end
      @items.push Form_item.new @boundary.strip, content, block
      break if @items.last.finished
    end
  end

  def item(key, val)
    @items.filter do |v|
      v.header[key] == val
    end.first
  end
end
