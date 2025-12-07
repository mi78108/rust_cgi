require 'uri'
require 'json'
require "pathname"

class Req
  def initialize()
    @path = URI::decode_uri_component(ENV['req_path'])
    @method = ENV['req_body_method'] == 'HTTP' ? ENV['req_method'] : ENV['req_body_method']
    @argvs = ENV.keys.filter {|k| k =~ /req_argv_\d+/ }.sort.map{ |k| URI::decode_uri_component(ENV[k]) }
    @params = ENV['req_params'] ? URI::decode_uri_component(ENV['req_params']).split('&').map {|v| v.split('=')[1]} : Array.new 
  end

  def header(key)
    return ENV[key] if ENV.include? key
    return nil
  end
  def param(key)
    return URI::decode_uri_component(header "req_param_#{key}")
  end
  def param_or(key, val)
    value = param(key)
    value.nil? ? val : value 
  end
  def argv(val)
    return @argvs[val.to_i]
  end
  def match(val)
    return nil if ENV['REQ_URI_MATCH'].nil?
    return JSON.parse(ENV['REQ_URI_MATCH'])[val.to_i] 
  end

  def method_missing(method_name, *args, &block)
    method_str = method_name.to_s
    if method_str.start_with?("argv_")
      return argv(method_str.split("_", 2)[1])
    end
    if method_str.start_with?("match_")
      return match(method_str.split("_", 2)[1])
    end
    if method_str.start_with?("param_")
      return param(method_str.split("_", 2)[1])
    end
    if method_str.start_with?("header_")
      return header(method_str.split("_", 2)[1])
    end
    super
  end
end

class Rsp
  attr_accessor :header

  def initialize()
    @body
    @code = 200
    @status = 'OK'
    @version = 'HTTP/1.0'
    @header = {
      'Connection' => 'close',
      'Content-Type' => 'application/json; charset=uft-8',
    }
  end

  def type val
    @header['Content-Type'] = val
    return self
  end
  def code(val)
    @code = val
    return self
  end
  def body val
    @body = val
    return self
  end
  def ok body
    @code = 200
    @body = body
    return self
  end
  def ok_json body
    type 'application/json; charset=utf-8'
    ok body.to_json
  end
  def fail_404 body
    @code = 404
    @status = "Not Found"
    @body = body
    return self
  end
  def finally
    Q.resp @code, @status, @header, @body
  end
end



module Q
  CBK_ONCLOSE = Array.new
  BUFFER_SIZE = 10 * 1024 * 1024
  REQ_PATH = URI::decode_uri_component(ENV['req_path'])
  REQ_BODY_METHOD = ENV['req_body_method']
  REQ_METHOD = REQ_BODY_METHOD == 'HTTP' ? ENV['req_method'] : ENV['req_body_method']
  @@UNMAP = true
  @RESP = Rsp.new

  def self.handle_response
    if @@UNMAP
      resp_501 'unHandle'
    else
      @RESP.finally unless @RESP.header['send'] && REQ_BODY_METHOD == 'HTTP'
    end
  end
  
#  def Q.const_missing( name )
#    STDERR.puts "const #{name} NOT EXIST; Find in ENV"
#    URI::decode_uri_component(ENV[name.to_s] ? ENV[name.to_s] : ENV[name.to_s.downcase])
#  end


  def Q.call_block
      @@UNMAP = false
      begin
        yield(Req.new, @RESP) if block_given?
      rescue StandardError => e
        Q.resp_501 e.to_s
      end
  end

  def Q.map(method=nil, *paths, &block)
    Q.log "Ready Map #{method} with #{paths}"
    if method.nil? and paths.empty?
      Q.log "Mapped on default"
      Q.call_block(&block)
      return Q
    end
    if method.to_s == Q::REQ_METHOD
      for path in paths do                
        if (path == Q::REQ_PATH if path.instance_of? String) || (path =~ Q::REQ_PATH if path.instance_of? Regexp) || (path.call(Q::REQ_PATH) if path.instance_of? Proc)
          (ENV['REQ_URI_MATCH'] = path.match(Q::REQ_PATH).to_a.to_json) if path.instance_of? Regexp
          Q.log "Mapped #{method} on #{path}"
          Q.call_block(&block)
          return Q
        end
      end
      Q.log "Mapped #{method} on default"
      Q.call_block(&block)
      return Q
    end
    return Q
  end 

  def Q.log(*info)
    info.each do |v|
      STDERR.puts ">>[#{Process.pid}]> LOG <#{caller.first}> INFO: #{v}"
      STDERR.flush
    end
  end
  def Q.write(content, flush = true)
    count = STDOUT.write content
    STDOUT.flush if flush
    return count
  end
  def Q.resp(code, status, header, content)
    Q.write ({
      "Connection" => 'close',
      "Content-Type" => 'text/html; charset=utf-8',
      "Content-Length" => content.nil? ? 0 : content.bytesize
    }.merge(header).reduce("HTTP/1.0 #{code} #{status}\r\n") {|a, (k,v)|
        a + "#{k}: #{v}\r\n"
    } + "\r\n"), false

    Q.write content, true
    @RESP.header['send'] = true
    exit 0
  end

  def Q.ok(mime, body, header={})
    header['Content-Type'] = mime
    Q.resp 200, 'OK', header, body
  end
  def Q.ok_json(body, header = {})
    Q.ok 'application/json; charset=utf-8', body, header
  end
  def Q.ok_html(body, header = {})
    Q.ok 'text/html; charset=utf-8', body, header
  end
  def Q.resp_404(body, header={})
    header['Content-Type'] = 'text/html'
    Q.resp 404, 'Not Found', header, body
  end
  def Q.resp_500(body, header={})
    header['Content-Type'] = 'text/html'
    Q.resp 500, 'Internal Server Error', header, body
  end
  def Q.resp_501(body, header={})
    header['Content-Type'] = 'text/html'
    Q.resp 501, 'Not Implemented', header, body
  end

  def Q.recv
    # 注意阻塞，会持续到EOF
    yield(STDIN.read) if block_given?
  end

  def Q.on_data(uio = STDIN)
    loop do
      begin
        result = uio.read_nonblock(Q::BUFFER_SIZE)
        yield result if block_given?
      rescue IO::WaitReadable
        IO.select([uio])
        retry
      rescue EOFError
        STDERR.puts ">>[#{Process.pid}]> #{uio.to_s} EOF..."
        break
      end
    end
  end

  def Q.on_close(&cbk)
    Q::CBK_ONCLOSE.push(cbk)
  end
end


BEGIN{
  STDERR.puts ">>[#{Process.pid}]> *************Process #{$$} BEGIN*************"
}

END {
  STDERR.puts ">>[#{Process.pid}]> **************Process #{$$} END*************"
  Q::CBK_ONCLOSE.each_with_index do |cbk, index|
    Q.log "CBK_ONCLOSE [#{index + 1}] called ..."
    cbk && cbk.call()
  end
  Q.handle_response
}
