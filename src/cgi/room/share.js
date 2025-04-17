#!/usr/bin/node
let fs = require('fs')
let redis = require('redis')
const Q = require('../_base')

let uid = process.pid
Q.on(Q.Method.WEBSOCKET, () => {
    let room = Q.param_or_else('argv_1', 'default')
    redis.createClient({
        host: 'localhost',
        port: 6379
    }).connect().then(rds => {
        // 接收
        rds.subscribe(['client_opt', 'client_broadcast', `client_${room}`], (v, c) => {
            console.error(">>>>>>>>>>>>>>>>>>>>>>", c, v)
            if (c === 'client_opt') {

            }
            if (c === 'client_broadcast') {

            }
            if (c === `client_${room}`) {
                let val = JSON.parse(v)
                if (val.from !== uid){
                    val.opt = 'text'
                    Q.write(JSON.stringify(val))
                }
            }
        })
    })
    redis.createClient({
        host: 'localhost',
        port: 6379
    }).connect().then(rds => {
        Q.write(JSON.stringify({opt: 'text', value: `Room [${room}] uid [${uid}]`}))
        Q.write(JSON.stringify({opt: 'info', value: {Status: `${uid} 上线`}}))
        //redis
        rds.hSet(`room_${room}`, `uid_${uid}`, 'online')
        rds.hIncrBy(`room_${room}`, `count`, 1)
        rds.publish('client_opt', JSON.stringify({opt: 'info', value: `${uid} online`}))
        Q.write(JSON.stringify({opt: 'info', value: {Status: `${room} 就绪`}}))
        //
        Q.recv( async(val) => {
            if (val) {
                val = JSON.parse(val.toString())
                switch (val.opt) {
                    case 'input':
                        rds.publish(`client_${room}`, JSON.stringify({from: uid, to: 'broadcast', value: val.value}))
                        break;
                    case 'send':
                        break;
                    case 'cmd':
                        switch (val.value){
                            case '@refresh':
                                val.opt= 'info'
                                val.value = await rds.hGetAll(`client_${room}`)
                                break
                            case '@send':
                                break
                            default:
                                val.opt = 'info'
                                val.value = '命令不支持'
                        }
                        break
                    default:
                        val.opt = 'text'
                }
                Q.write(JSON.stringify(val))
            }
        })
        Q.onclose(async () => {
            try {
                console.error("*********************************** close start")
                await rds.publish('client_opt', JSON.stringify({opt: 'info', value: `${uid} offline`}))
                await rds.hDel(`room_${room}`, `uid_${uid}`)
                await rds.hIncrBy(`room_${room}`, `count`, -1)
                await rds.quit()
                console.error("*********************************** close end")
            } catch (e) {
                console.error(">>>>>>>>>>>>e", e)
            }
        })
    }).catch(e => {
        Q.write(JSON.stringify({opt: 'info', value: {Status: `redis 连接失败 ${e}`}}))
    })
})