class Req {
  constructor() {
    this.Method = {
      GET: 'GET',
      POST: 'POST',
      WEBSOCKET: 'WEBSOCKET'
    }
    //this.header = process.env
    this.req_path = process.env['req_path']
    this.req_method = 'HTTP' == process.env['req_body_method'] ? process.env['req_method'] : process.env['req_body_method']
    this.content_length = parseInt(process.env['Content-Length'])
    this.response = false;
  }

  on(method, cbk) {
    if (this.req_method == method) {
      this.response = true;
      cbk(this)
    }
  }

  ok(mime, body) {
    this.resp(200, 'OK', mime, body)
  }

  ok_html(body) {
    this.ok('text/html', body)
  }
  ok_json(body) {
    this.ok('application/json', JSON.stringify(body))
  }

  header(name) {
    let value = process.env[name]
    if (value == undefined || value.length == 0) {
      return false
    } else {
      return value
    }
  }

  param(name) {
    return this.header(`req_param_${name}`)
  }

  read(){
    return process.stdin.read()
  }
  write(data){
    return process.stdout.write(data)
  }

  recv(cbk){
    process.stdin.on('readable', () => {
      let data = process.stdin.read()
      cbk && cbk(data)
    })
  }

  recv_end(cbk){
    process.stdin.on('end', () => {
      cbk && cbk
    })
  }

  ready(cbk){
    let call_back = ()=>{
      process.stdin.off('readable',call_back)
      cbk && cbk()
    }
    process.stdin.on('readable',call_back)
  }


  resp(code, status, mime, body, header = {}) {
    body = Buffer.from(body)
    process.stdout.write(`HTTP/1.0 ${code} ${status}\r\n`);
    for ( let [k,v] of Object.entries(Object.assign({
      'Connection': 'close',
      'Content-Type': `${mime}`,
      'Content-Length': `${body.length}`,
    }, header))) {
      process.stderr.write(`${k} -> ${v} \r\n`)
      process.stdout.write(`${k}: ${v}\r\n`)
    }
    process.stdout.write(`\r\n`)
    process.stdout.write(body)
    this.response = true;
    process.exit(0)
  }

  resp_500(body) {
    this.resp(500, 'Internal Server Error', 'text/html', body)
  }
  resp_404(body) {
    this.resp(404, 'Not Found', 'text/html', body)
  }
}

let Q = new Req();
process.on('exit', (code) => {
  if(Q.response === false) {
    Q.resp_500('unHandle')
  }
})
module.exports = Q;
