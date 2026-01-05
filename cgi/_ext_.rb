class Req 
  def body_form_data
    Form_data.new
  end
end

class Form_data
  def initialize()
    @boundary=ENV['content-type']
    if @boundary.include? 'form_data'
      @boundary = @boundary.split("boundary=")[1]
    end
    @header = Hash.new
    loop do
     line = STDIN.readline
     if line.include? ": "
       line.split(";").each do |kv|
         if kv.include? "="
          (k, v) = kv.split("=")
          @header[k.strip] = v.strip.gsub(/^"|"$/, '')
         end
       end
     end
     break if line == "\r\n"
    end
  end

  def to_s
    @header['filename']
  end
end
