#!/usr/bin/node
let fs = require('fs')
let {exec} = require('child_process')

if (process.env['req_body_method'] == 'WEBSOCKET') {
    let uid = process.pid
    process.stdin.on('readable', () => {
        let data = process.stdin.read()
        if (data) {
            console.error(`>>> [${uid}] req_body`, data.toString())
            process.stdout.write('Resp: ' + data.toString())
        }
    })
    process.stdin.on('end',()=>{
        console.error(`>>> [${uid}] ended`)
        process.exit()
    })


    Array.from(["uncaughtException", "SIGTERM"]).forEach(sig => {
        process.on(sig, (code) => {
            console.error('>>> ', uid, 'disconnected');
            // 断开
            process.exit()
        });
    })

}
if(process.env['req_body_method'] == 'HTTP') {
    if (process.env['req_method'] == 'POST') {
        let len = parseInt(process.env['Content-Length']);
        console.error(">>>>>>>>>>>>>>>>>>>>post len" + len)
        //process.stdin.on('readable', () => {
            process.stdin.on('data', () => {
            let data = process.stdin.read()
            if (data) {
                console.error(">>>>>>>>>>>>>>>>>>>>post " + data)
                process.exit(0)
            }
        })
    }
    if (process.env['req_method'] == 'GET') {
        let body = fs.readFileSync('./index.rb/page.html')
        process.stdout.write('HTTP/1.0 200 OK\r\n')
        process.stdout.write('Content-Type: text/html; charset=utf-8\r\n')
        process.stdout.write('Connection: close\r\n')
        process.stdout.write('Content-Length: ' + body.length + '\r\n\r\n')
        process.stdout.write(body)
    }
}
