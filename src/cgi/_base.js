let fs = require('fs')

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
        this.close_func = []
        this.closed = false
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
        this.ok('application/json; charset=utf-8', body)
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

    param_or_else(name, val) {
        if (this.param(name) === false) {
            return val
        }
        return this.param(name)
    }

    read() {
        return process.stdin.read()
    }

    async write(data) {
        return await process.stdout.write(data, 'utf-8', () => {
            process.stdout.once('drain', () => {

            })
        })
        //return process.stdout.write(data)
    }

    recv(cbk) {
        process.stdin.on('readable', () => {
            let data = process.stdin.read()
            //console.error(`>>>>>>>>>>>>>>>>>> read len ${data.length}}`)
            cbk && cbk(data)
        })
    }

    recv_end(cbk) {
        process.stdin.on('end', () => {
            cbk && cbk
        })
    }

    ready(cbk) {
        let call_back = () => {
            process.stdin.off('readable', call_back)
            cbk && cbk()
        }
        process.stdin.on('readable', call_back)
    }

    recv_ready(cbk) {
        process.stdin.on('readable', () => {
            cbk && cbk()
        })
    }

    onclose(cbk) {
        this.close_func.push(cbk)
    }


    resp(code, status, mime, body, header = {}) {
        body = Buffer.from(body)
        process.stdout.write(`HTTP/1.0 ${code} ${status}\r\n`);
        for (let [k, v] of Object.entries(Object.assign({
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

process.stdin.on('close', async () => {
    console.error(">>> Process Stdin On Close trigger")
    if (Q.req_method === Q.Method.WEBSOCKET) {
        for (let func of Q.close_func) {
            await func(Q)
        }
        process.exit(0)
    }
})

process.on('exit', async (ev) => {
    console.error(`>>> Process On Exit event trigger `, ev)
    Q.closed = true
    if (!Q.response) {
        Q.resp_500('unmapped')
    }
    console.error(`>>> Process exit`)
    //process.exit(0)
})

//Array.from(["beforeExit","uncaughtException", "unhandledRejection","SIGTERM", "SIGINT", "SIGHUP", 'exit']).forEach(sig => {
Array.from(["uncaughtException", "unhandledRejection"]).forEach(sig => {
    process.on(sig, (ev) => {
        console.error(`>>> Process On Close trigger ${sig}`, ev)
        console.error(`>>> Process On Close trigger END ${sig}`, ev)
        process.exit(0)
    });
})

module.exports = Q;