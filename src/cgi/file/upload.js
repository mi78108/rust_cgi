#!/usr/bin/node

let fs = require('fs')
let {exec} = require('child_process')

let rtn = function (body) {
    body = JSON.stringify(body)
    process.stdout.write('HTTP/1.0 200 OK\r\n')
    //process.stdout.write('Content-Type: text/html; charset=utf-8\r\n')
    process.stdout.write('Content-Type: application/json; charset=utf-8\r\n')
    process.stdout.write('Connection: close\r\n')
    process.stdout.write('Content-Length: ' + body.length + '\r\n\r\n')
    process.stdout.write(body)
    process.exit()
}

let uid = process.pid
let file_name = process.env['Upload-File-Name']
if (file_name === undefined || file_name.length === 0) {
    rtn({msg: 'Not Support', code: 401})
}

if (process.env['req_method'] == 'POST') {
    // 直传
    let writeStream = fs.createWriteStream('/tmp/' + file_name)
    process.stdin.pipe(writeStream)
    writeStream.on('finish', () => {
        rtn({msg: 'Finish', code: 200})
    })
    //formData
}


if (process.env['req_body_method'] == 'WEBSOCKET') {
    process.stdin.on('readable', () => {
        let data = process.stdin.read()
        if (data) {
            console.error(`>>> [${uid}] req_body`, data.toString())
        }
    })

    Array.from(["uncaughtException", "SIGTERM"]).forEach(sig => {
        process.on(sig, (code) => {
            console.error('>>> ', uid, 'disconnected');
            // 断开
            process.exit()
        });
    })

}