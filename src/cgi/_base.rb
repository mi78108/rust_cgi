def mime_type name
  mime = case name
         when :html
           'text/html'
         when :json
            'application/json'
         when :js
             'application/javascript'
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

def resp_500 msg=""
    resp 500, 'Internal Server Error', :text, msg
end

def resp_404 msg=""
    resp 404, 'Not Found', :text, msg
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
  Q.response = true
  exit 0
end


BEGIN {
class Array
    def some(&cbk)
        for v in self
            rst = cbk.call v
            return rst if rst != false
        end
    end

    def some_proc(&cbk)
       for v in self
           rst = cbk.call v[0]
           if rst != false
               if not v[1].nil?
                   return v[1].call(rst)
               end
               return rst
           end
       end
   end
end


class Req
    attr_accessor :response
    attr_reader :header, :req_method, :req_path
    def initialize()
        @req_path = ENV['req_path']
        @req_method = 'HTTP'.eql?(ENV['req_body_method']) ? ENV['req_method'] : ENV['req_body_method']
        @header = ENV.to_h
        @run_func = Hash.new
        @response = false

    end

    def param(name)
        value = ENV["req_param_#{name}"]
        if value.nil? or value.empty?
            return false
        else
            return value
        end
    end

    def ok(mime, body)
        resp_ok mime, body
    end

    def ok_json(body)
        ok :json, body
    end

    def ok_html(body)
        ok :html, body
    end

    def on(method, &cbk)
        @run_func[method.to_sym] = cbk
    end

    def run
        if @run_func.include? @req_method.to_sym
            @response = true
            begin
                @run_func[@req_method.to_sym].call(self)
            rescue => e
                STDERR.puts %Q{#{e.message}\n#{e.class}\n#{e.backtrace.join("\n")}}
                resp_500 "Server Script Error #{e.message}"
            end
        else
            resp_501 'unHandle'
        end
    end
end

}

 Q = Req.new()

END {
   Q.run
   #return 0 if Q.response
   #resp_501 'unHandle'
}
