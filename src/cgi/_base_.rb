require 'uri'
require 'json'
require "pathname"

module Q
  CBK_ONCLOSE = Array.new
  REQ_PATH = URI::decode_uri_component(ENV['req_path'])
  REQ_ARGVS = ENV.keys.filter {|k| k =~ /req_argv_\d+/ }.sort.map{ |k| URI::decode_uri_component(ENV[k]) }
  REQ_METHOD = ENV['req_body_method'] == 'HTTP' ? ENV['req_method'] : ENV['req_body_method']
  REQ_PARAMS = ENV['req_params'] ? URI::decode_uri_component(ENV['req_params']).split('&').map {|v| v.split('=')[1]} : Array.new
  BUFFER_SIZE = 10 * 1024 * 1024

  @unmap = true

  def Q.const_missing( name )
    STDERR.puts "const #{name} NOT EXIST; Find in ENV"
    URI::decode_uri_component(ENV[name.to_s] ? ENV[name.to_s] : ENV[name.to_s.downcase])
  end

  def Q.header(key)
    return ENV[key] if ENV.include? key
    return nil
  end

  def Q.param(key)
    return URI::decode_uri_component(Q.header "req_param_#{key}")
  end
  def Q.param_or(key,val)
    value = Q.param(key)
    value.nil? ? val : value 
  end
  def Q.uri_matched
    JSON.parse(ENV['REQ_URI_MATCHED'])
  end

  def Q.map(method, *paths)
    if method.to_s == Q::REQ_METHOD
      for path in paths do                
        if (path == Q::REQ_PATH if path.instance_of? String) || (path =~ Q::REQ_PATH if path.instance_of? Regexp) || (path.call(Q::REQ_PATH) if path.instance_of? Proc)
          Q.log "Mapped on #{path}"
           @unmap = true
          (ENV['REQ_URI_MATCHED'] = path.match(Q::REQ_PATH).to_a.to_json) if path.instance_of? Regexp
          yield(Q::REQ_PARAMS) if block_given?
          break
        end
      end
      if paths.empty?
        Q.log "Mapped on defaults"
        yield(Q::REQ_PARAMS) if block_given?
      end
    end
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
  def Q.resp(code, status, mime, content, header = {})
    Q.write header.merge({
      'Connection': 'close',
      'Content-Type': mime,
      'Content-Length': content.bytesize,
    }).reduce("HTTP/1.0 #{code} #{status}\r\n") {|a,(k,v)| a + "#{k}: #{v}\r\n" } + "\r\n", false

    Q.write content, true
    exit 0
  end

  def Q.ok(mime, body, header={})
    Q.resp 200, 'OK', mime, body, header
  end

  def Q.ok_json(body, header = {})
    Q.ok 'application/json; charset=utf-8', body, header
  end
  def Q.ok_html(body, header = {})
    Q.ok 'text/html; charset=utf-8', body, header
  end
  def Q.resp_404(body, header={})
    Q.resp(404, 'Not Found', 'text/html', body, header)
  end
  def Q.resp_500(body, header={})
    Q.resp 500, 'Internal Server Error', 'text/html', body, header
  end
  def Q.resp_501(body, header={})
    Q.resp 501, 'Not Implemented', 'text/html', body, header
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
  if @unmap
    Q.resp_501 'unHandle'
  end
}
