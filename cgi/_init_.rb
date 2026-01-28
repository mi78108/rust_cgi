require 'uri'
require 'json'
require "pathname"
require_relative "_ext_"

class Req
  def initialize(path = Q::REQ_PATH)
    @path = path
    @method = Q::REQ_METHOD
    @args = ENV.keys.filter {|k| k =~ /Req_Argv_\d+/ }.sort.map{ |k| URI::decode_www_form_component(ENV[k]) }
    @params = ENV['Req_Params'] ? URI::decode_www_form_component(ENV['Req_Params']).split('&').map {|v| v.split('=')[1]} : Array.new
    @body_type = ENV['content-type'] ? ENV['content-type'] : ''
    @body_length = ENV['content-length'] ? ENV['content-length'].to_i : 0
  end

  def header(key)
    return ENV[key] if ENV.include? key
    return nil
  end
  def param(key)
    return URI::decode_www_form_component(header "Req_Param_#{key}")
  end
  def param_or(key, val)
    value = param(key)
    value.nil? ? val : value
  end
  def argv(val)
    return @args[val.to_i]
  end
  def match(val)
    return nil if ENV['REQ_URI_MATCH'].nil?
    return JSON.parse(ENV['REQ_URI_MATCH'])[val.to_i]
  end

   def body(length = @body_length)
    Q.recv(length)
   end

  def method_missing(method_name, *args, &block)
    method_str = method_name.to_s
    (prefix, core_method) = {
      "argv_" => :argv,
      "match_" => :match,
      "param_" => :param,
      "header_" => :header
    }.find { |prefix, _| method_str.start_with?(prefix) }

    return send(core_method, method_str.delete_prefix(prefix)) if prefix
    super
  end
end

class Rsp
  attr_accessor :header

  def initialize()
    @code = 200
    @status = 'OK'
    @version = 'HTTP/1.0'
    @header = {
      'Connection' => 'close',
      'Content-Type' => 'application/json; charset=uft-8',
    }
  end

  %i[code body].each do |method_name|
    define_method(method_name) do |val|
      instance_variable_set("@#{method_name}", val)
      self
    end
  end

  def type val
    @header['Content-Type'] = val
    return self
  end
  def page val
    @body = File.read(val)
    return self
  end
  def ok body
    @code = 200
    @body = body
    return self
  end
  def json
    type 'application/json; charset=utf-8'
    return self
  end
  def html
    type 'text/html; charset=utf-8'
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
  def render(v = {},  &block)
    ctx = binding
    if block_given?
      Q.make_hkv v
      instance_exec(v, &block)
      block.parameters.map { |_, name| name }.compact.each do |name|
        ctx.local_variable_set name, v
      end
      block.binding.local_variables.each do |name|
        ctx.local_variable_set name, block.binding.local_variable_get(name)
      end

      Q.log "local_variables_block:", block.binding.local_variables
      Q.log "parameters_block:", block.parameters
    end
    Q.log "local_variables_Q:", Q.instance_variables
    Q.log "local_variables_resp:", instance_variables
    Q.instance_variables.each do |name|
      instance_variable_set name, Q.instance_variable_get(name)
    end
    Q.log "instance_variables_self:", self.binding.instance_variables
    Q.log "instance_variables_resp_final:", instance_variables

    body( @body.gsub(%r|[@#]{(?<code>.*?)}|) do |match|
      Q.log "template matched #{match}"
      begin
        instance_eval do
          eval($~[:code], ctx)
        end
      rescue => e
        "[ERROR: #{e.message}]"
      end
    end )
    return self
  end

  def finally
    if Q::REQ_BODY_METHOD == "HTTP"
      Q.resp @code, @status, @header, @body
    else
      Q.write "", true
    end
  end
end




module Q
  CBK_ONCLOSE = Array.new
  BUFFER_SIZE = 10 * 1024 * 1024
  REQ_PATH = URI::decode_www_form_component(ENV['Req_Path'])
  REQ_BODY_METHOD = ENV['Req_Body_Method']
  REQ_ARGV_PARAMS = URI::decode_www_form_component(ENV['Req_Argv_Params'])
  REQ_METHOD = REQ_BODY_METHOD == 'HTTP' ? ENV['Req_Method'] : ENV['Req_Body_Method']
  SCRIPT_DIR = ENV['Req_Script_Dir']
  SCRIPT_NAME = ENV['Req_Script_Name']
  SCRIPT_PATH = ENV['Req_Script_Path']
  SCRIPT_BASENAME = ENV['Req_Script_Basename']
  @@UNMAP = true
  @RESP = Rsp.new

  def self.handle_response
    if @@UNMAP
      Q.fail_501 'unHandle'
    else
      @RESP.finally unless @RESP.header['send']
    end
  end

  #  def Q.const_missing( name )
  #    STDERR.puts "const #{name} NOT EXIST; Find in ENV"
  #    URI::decode_uri_component(ENV[name.to_s] ? ENV[name.to_s] : ENV[name.to_s.downcase])
  #  end


  def Q.call_block &block
    begin
      @@UNMAP = false
      #yield(Req.new, @RESP) if block_given?
      instance_exec(Req.new, @RESP, &block) if block_given?
      # rescue StandardError => e
    rescue Exception => e
      Q.log e
      Q.fail_500 e.to_s
    end
  end

  def Q.map(method=nil, *path_matches, &block)
    return unless @@UNMAP
    map_dir = "./#{Q::SCRIPT_NAME.sub("/#{Q::SCRIPT_BASENAME}","")}"
    map_path = Q::REQ_PATH.sub(Q::REQ_PATH.sub("/#{Q::REQ_ARGV_PARAMS}",""), "")
    map_path = '/' if map_path.empty?
    Q.log "Ready Map #{map_path} on #{method} with #{path_matches}"
    Dir.chdir(map_dir) if Dir.exist? map_dir
    if method.nil? and path_matches.empty?
      Q.log "Mapped on default"
      Q.call_block(&block)
      return Q
    end
    if method.to_s == Q::REQ_METHOD
      if path_matches.empty?
        Q.log "Mapped #{method} on default"
        Q.call_block(&block)
        return Q
      end
      for match in path_matches do
        match_result = case match
                       when String then match == map_path
                       when Regexp then (match_data = match.match(map_path)) && (ENV['REQ_URI_MATCH'] = match_data.to_a.to_json; true)
                       when Proc then match.call map_path
                       else false
                       end
        if match_result
          Q.log "Mapped #{method} on #{match}"
          Q.call_block(&block)
          return Q
        end
      end
      Q.log "unHandle path #{map_path}"
      return Q
    end
    Q.log "unHandle method #{map_path}"
    return Q
  end

  def Q.log(*info)
    info.each do |v|
      STDERR.puts ">>[#{Process.pid}]> LOG <#{caller.last}> INFO: #{v}"
      STDERR.flush
    end
  end
  def Q.write(content, flush = true)
    count = STDOUT.write content
    STDOUT.flush if flush
    return count
  end
  def Q.resp(code, status, header, content)
    return if @RESP.header['send']
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
  def Q.fail_404(body, header={})
    header['Content-Type'] = 'text/html'
    Q.resp 404, 'Not Found', header, body
  end
  def Q.fail_500(body, header={})
    header['Content-Type'] = 'text/html'
    Q.resp 500, 'Internal Server Error', header, body
  end
  def Q.fail_501(body, header={})
    header['Content-Type'] = 'text/html'
    Q.resp 501, 'Not Implemented', header, body
  end
  def Q.redirect_301(body, header={})
    header['Content-Type'] = 'text/html'
    header['Location'] = body
    Q.resp 301, 'Moved Permanently', header, body
  end
  def Q.redirect_302(body, header={})
    header['Content-Type'] = 'text/html'
    header['Location'] = body
    Q.resp 302, 'Found', header, body
  end

  def Q.render_while(body, v={})
    Q.make_hkv v
    yield(v) if block_given?
    escaped_body = body.gsub(/["\\]/) { |c| "\\#{c}" }
    return eval(%Q{"#{escaped_body}"})
  end

  def Q.render_sub(body, v={}, &block)
    if block_given?
      Q.make_hkv v
      block.call v
      body.gsub(%r|[@#]{(?<code>.*?)}|) do |match|
        Q.log "template matched #{match}"
        begin
          instance_eval($~[:code])
        rescue => e
          "[ERROR: #{e.message}]"
        end
      end
    end
  end

  def Q.make_hkv hash
    def hash.method_missing(name, *args)
      if name.to_s.end_with?("=")
        key = name.to_s.chomp("=").to_sym
        self[key] = args.first
      else
        self[name.to_sym] || self[name.to_s] # 兼容符号/字符串键
      end
    end

    def hash.respond_to_missing?(name, include_private = false)
      true
    end
  end


  def Q.read(length)
    # 注意阻塞，会持续到EOF
    data = length&.positive? ? STDIN.read(length) : STDIN.read
    yield(data) if block_given?
    data
  end

  def Q.recv(uio = STDIN)
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

  def Q.notify(id, only=true)
    member = '224.0.0.1'
    if not @udp_server.nil? and not block_given?
      return @udp_server.send({:f=>Process.pid, :c=>id}.to_json, 0, member, @udp_id) if only
      
      return @udp_server.send(id, 0, member, @udp_id)
    end
    if @udp_server.nil?
      require 'socket'
      @udp_id = id
      @udp_server = UDPSocket.new
      @udp_server.setsockopt(Socket::SOL_SOCKET, Socket::SO_REUSEADDR, true)
      @udp_server.setsockopt(Socket::SOL_SOCKET, Socket::SO_REUSEPORT, true)

      @udp_server.setsockopt(Socket::IPPROTO_IP, Socket::IP_ADD_MEMBERSHIP, IPAddr.new(member).hton + IPAddr.new('127.0.0.1').hton)
      @udp_server.bind(member, @udp_id)
    end
    if block_given?
      @udp_server_thread = Thread::new do
        loop do
          body, addr = @udp_server.recvfrom(65507);
          #Q.log "recv #{body} from #{addr}"
          if only
            content = JSON.parse(body)
            next if Process.pid.to_s.eql? content['f'].to_s
            
            yield(content['c'], content['f'])
          else
            yield body, addr
          end
        end
      end
      Q.on_close do
        @udp_server_thread.kill
        @udp_server.close
        Q.log "#{@udp_id} Shutdown Notify"
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
  STDERR.puts ">>[#{Process.pid}]> **************Process #{$$} END***************"
  Q::CBK_ONCLOSE.each_with_index do |cbk, index|
    Q.log "CBK_ONCLOSE [#{index + 1}] called ..."
    cbk && cbk.call()
  end
  Q.handle_response
}
