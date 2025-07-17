const { rejects } = require('assert');
const fs = require('fs');
const { resolve } = require('path');

const Q = {
    Method: {
        GET: 'GET',
        POST: 'POST',
        WEBSOCKET: 'WEBSOCKET'
    },
    req_path: process.env['req_path'],
    req_method: 'HTTP' == process.env['req_body_method'] ? process.env['req_method'] : process.env['req_body_method'],
    content_length: parseInt(process.env['Content-Length']),
    onclose: new Array(),

    header: (key) => {
        let value = process.env[key]
        return (value == undefined || value.length == 0) ? false : value;
    },
    param: (key) => {
        return Q.header(`req_param_${key}`)
    },
    param_or_else: (key, val) => {
        return (Q.param(key) === false) ? val : Q.param(key)
    },

    on: (method) => {
        let mapper = {
            trigger: false,
            map: (...path) => {
                let doing = {
                    do: (cbk) => {
                        if (mapper.trigger === false) {
                            if (Q.req_method === method) {
                                if (path.find(v => {
                                    if (typeof v === 'object') {
                                        console.error('>>> matching', typeof v, Q.req_path, v, v.test(Q.req_path))
                                        return v.test(Q.req_path)
                                    }
                                    if (typeof v === 'function') {
                                        console.error('>>> matching', typeof v, Q.req_path, v, v(Q.req_path))
                                        return v(Q.req_path)
                                    }
                                    console.error('>>> matching', typeof v, Q.req_path, v, v === Q.req_path)
                                    return v === Q.req_path
                                })) {
                                    mapper.trigger = true
                                    process.env['req_params'] ? cbk(...decodeURI(process.env['req_params']).split('&').map(v => v.split('=')[1])) : cbk()
                                }
                            }
                        }
                        return mapper;
                    }
                }
                return doing;
            }
        }
        return mapper;
    },

    map: (method, ...path) => {
        return new Promise((resolve, reject) => {
            if (Q.req_method === method) {
                if (path.find(v => {
                    console.error('1>>>>>>>>>>>>>>>>>======', typeof v, Q.req_path, v)
                    if (typeof v === 'object') {
                        console.error('2>>>>>>>>>>>>>>>>>======', typeof v, Q.req_path, v, v.test(Q.req_path))
                        return v.test(Q.req_path)
                    }
                    return v === Q.req_path
                })) {
                    let args = decodeURI(process.env['req_params']).split('&').map(v => v.split('=')[1]);
                    resolve(args)
                }
            }
        })
    },

    mapon: (method, path, cbk) => {
        if (Q.req_method === method && cbk) {
            if (path === Q.req_path) {
                process.env['req_params'] ? cbk(...decodeURI(process.env['req_params']).split('&').map(v => v.split('=')[1])) : cbk()
            }
        }
    },

    write: (val) => {
        return new Promise((resolve, reject) => {
            process.stdout.write(val, 'utf8', (erro) => {
                erro ? reject(errn) : resolve();
            });
        })
    },
    resp_body: async (code, status, content_type, content, header = {}) => {
        let head = Object.entries(Object.assign({
            'Connection': 'close',
            'Content-Type': `${content_type}`,
            'Content-Length': `${Buffer.byteLength(content, 'utf8')}`,
        }, header)).reduce((a, [k, v]) => {
            a += `${k}: ${v}\r\n`;
            return a;
        }, Buffer.from(`HTTP/1.0 ${code} ${status}\r\n`)).toString() + `\r\n`;

        await Q.write(head)
        await Q.write(content)
        process.exit(0)
    },
    resp_stream: async (code, status, content_type, content_length, cbk, header = {}) => {
        let head = Object.entries(Object.assign({
            'Connection': 'close',
            'Content-Type': `${content_type}`,
            'Content-Length': `${content_length}`,
        }, header)).reduce((a, [k, v]) => {
            a += `${k}: ${v}\r\n`;
            return a;
        }, Buffer.from(`HTTP/1.0 ${code} ${status}\r\n`)).toString() + `\r\n`;
        await Q.write(head)
        await cbk()
        process.exit(0)
    },
    resp_404: async (body) => {
        await Q.resp_body(404, 'Not Found', 'text/html', body)
    },
    resp_500: async (body) => {
        await Q.resp_body(500, 'Internal Server Error', 'text/html', body);
    },
    ok: async (mime, body) => {
        await Q.resp_body(200, 'OK', mime, body)
    },
    ok_html: async (body) => {
        await Q.ok('text/html', body)
    },
    ok_json: async (body) => {
        await Q.ok('application/json; charset=utf-8', JSON.stringify(body))
    },

    recv: async (cbk) => {
        return new Promise((resolve, reject) => {
            let chunks = [];
            process.stdin.on('data', (chunk) => {
                chunks.push(chunk)
            })
            process.stdin.on('end', () => {
                let data = Buffer.concat(chunk);
                cbk && cbk(data)
                resolve(data)
            })
        })
    },
    onData: (cbk) => {
        process.stdin.on('data', (chunk) => {
            cbk && cbk(chunk)
        })
    },

    ready: (cbk) => {
        let call_back = () => {
            process.stdin.off('readable', call_back)
            cbk && cbk()
        }
        process.stdin.on('readable', call_back)
    }

}

process.on('exit', async (ev) => {
    for (const cbk in Q.onclose) {
        await cbk()
    }
    console.error(`>>${process.pid}> Process On Exit event trigger `, ev)
    console.error(`>>${process.pid}> Process exit`)
})

process.stdin.on('close', async (ev) => {
    console.error(`>>${process.pid}> Process On Stdin Close event trigger`, ev)
    process.exit(0)
})

//Array.from(["beforeExit","uncaughtException", "unhandledRejection","SIGTERM", "SIGINT", "SIGHUP", 'exit']).forEach(sig => {
Array.from(["uncaughtException", "unhandledRejection"]).forEach(sig => {
    process.on(sig, (ev) => {
        console.error(`>>${process.pid}> Process On ${sig} Signal event trigger`, ev)
        process.exit(ev.errno)
    });
})

module.exports = Q