#!/usr/bin/node
let fs = require('fs')
let { exec } = require('child_process')

if(process.env['req_body_method'] == 'WEBSOCKET'){
    let uid = process.pid
    process.stdin.on('readable',()=>{
        let data = process.stdin.read()
        if(data){
            console.error(`>>> [${uid}] req_body`,data.toString())
        }
    })


    Array.from(["uncaughtException","SIGTERM"]).forEach(sig =>{
        process.on(sig, (code)=>{
            console.error('>>> ',uid,'disconnected');
            // 断开
            process.exit()
        });
    })

}else{
    let body = fs.readFileSync('./home/page.html')
    process.stdout.write('HTTP/1.0 200 OK\r\n')
    process.stdout.write('Content-Type: text/html; charset=utf-8\r\n')
    process.stdout.write('Connection: close\r\n')
    process.stdout.write('Content-Lenght: ' + body.length + '\r\n\r\n')
    process.stdout.write(body)
}