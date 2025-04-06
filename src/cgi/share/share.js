#!/usr/bin/node
let fs = require('fs')
let { exec } = require('child_process')

if(process.env['req_body_method'] == 'WEBSOCKET'){
    let uid = process.pid
    // 登记
    exec(`echo ${uid} >> /tmp/share_online`)
    exec(`mkfifo /tmp/share_${uid}`)
    let sendto = (pid, data) =>{
        fs.appendFile(`/tmp/share_${pid}`, data, (e)=>{
        })
    }
    // 广播
    let broadcast = (_data)=>{
        let data = fs.readFileSync('/tmp/share_online')
        data.toString('utf-8').split("\n").filter(v=> v != uid).forEach(pid=>{
            sendto(pid,_data)
            //process.kill(pid,'SIGPIPE')
        })
    }
    console.error(`>>> [${uid}] connected`);
    process.stdin.on('readable',()=>{
        let data = process.stdin.read()
        if(data){
            console.error(`>>> [${uid}] req_body`,data.toString())
            data = JSON.parse(data)
            if(data['opt'] == 'broadcast'){
                broadcast(data['data'])
            }
        }
    })

    // 接收
    fs.createReadStream(`/tmp/share_${uid}`,{flags: 'r+' ,autoClose: false }).on('data', data=>{
        console.error(`>>> [${uid}] fifo recv `,data.toString())
        process.stdout.write(data)
    })
    //process.on('SIGPIPE',(code)=>{
    //})

    Array.from(["uncaughtException","SIGTERM"]).forEach(sig =>{
        process.on(sig, (code)=>{
            console.error('>>> ',uid,'disconnected');
            // 断开
            exec(`sed -i '/${uid}/d' /tmp/share_online`)
            exec(`rm /tmp/share_${uid}`)
            process.exit()
        });
    })

}else{
    let body = fs.readFileSync('./_share.html')
    process.stdout.write('HTTP/1.0 200 OK\r\n')
    process.stdout.write('Content-Type: text/html; charset=utf-8\r\n')
    process.stdout.write('Connection: close\r\n')
    process.stdout.write('Content-Lenght: ' + body.length + '\r\n\r\n')
    process.stdout.write(body)
}
