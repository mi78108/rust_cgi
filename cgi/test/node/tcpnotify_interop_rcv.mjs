#!/usr/bin/env node
// node 端常驻接收者 —— 供 ruby 互操作测试调用
//
// 用法: node cgi/test/node/tcpnotify_interop_rcv.mjs <port> <channel> <outfile> <ms>
//   订阅频道, 收到消息写进 outfile (一行一个), 跑够 ms 毫秒后退出。
import fs from 'node:fs';
import { TcpNotify } from '../../_env_/node/_ext_notify_.mjs';

const port = Number(process.argv[2] ?? 3000);
const channel = process.argv[3] ?? 'interop-test';
const outfile = process.argv[4] ?? '/tmp/node_interop.txt';
const ms = Number(process.argv[5] ?? 3000);

fs.writeFileSync(outfile, '');

const t = new TcpNotify('node-rcv', { port, channel });
const lines = [];

t.subscribe(channel, (msg) => {
  lines.push(msg.data.toString('utf8'));
  fs.writeFileSync(outfile, lines.join('\n'));
});

setTimeout(() => {
  t.stop();
  process.exit(0);
}, ms);
