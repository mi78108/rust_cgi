def mime_type name
  mime = case name
         when :html
           'text/html'
         when :json
           'application/json'
          else
              'text/text'
         end
  return mime + '; charset=utf-8'
end

def recv &cb
    buffer_size = ENV['Req_Buffer_Size'].to_i
    if ENV['req_body_method'] == 'HTTP'
        buffer_size = ENV['Content-Length'].to_i
    end
    recv_length buffer_size, &cb
end

def recv_length buffer_size, &cb
    loop do
        if select([STDIN])
            break if STDIN.eof?
            data = STDIN.read_nonblock buffer_size
            cb.call(data) if block_given?
        end
    end
end

def resp_ok mime, body
    resp 200, "OK", mime, body
end

def resp_501 msg=""
    resp 501, 'Not Implemented', :text, msg
end

def resp code, status, mime, body, header={}
  print "HTTP/1.0 #{code} #{status}\r\n"
  _header = {
    "Connection" => "close",
    "Content-Type" => "#{mime_type(mime)}",
    "Content-Length" => "#{body.length}",
  }
 _header.update(header)
  _header.each { |k, v| print "#{k}: #{v}\r\n"}
  print "\r\n"
  print body
  exit 0
end


BEGIN {
class Req
    def initialize()
        @header = {}
        STDERR.puts "Req init ...."
    end

    def test()
        STDERR.puts '>>>>>>>>>>>>>>>>>>>>>>'
    end

    def get_param(name, &cb)
        value = ENV["req_get_param_#{name}"]
        if value.nil?
            return false
        else
            if block_given?
                return cb.call(value)
            end
            return true
        end
    end
end

}

 Q = Req.new()

END {
    resp_501 'unHandle'
}
