#!/usr/bin/env node
// 单个 URL 的 HTTP 探测助手（调试 / 手工排查用）。check-deploy.mjs 已经改成
// 在单个进程内完成探测，不再调用本文件，但保留它作为命令行探针很方便：
//
//   node --use-system-ca tools/http-probe.mjs https://example.com/app/app.js
//   node --use-system-ca tools/http-probe.mjs https://example.com/ --head
//
// 为什么用文件而不是 `node -e "<代码>"`：Windows PowerShell 会吞掉内联脚本里的
// 双引号，把传过去的代码改坏（这个坑已踩过一次）。
//
// 用法：
//   node --use-system-ca tools/http-probe.mjs <url> [--head|--get]
//
// 输出：一行 JSON  { s, ct, len, loc, err }
//   s    状态码（0 表示请求失败）
//   ct   Content-Type（去掉 charset）
//   len  实际收到的字节数（不是 Content-Length 头）
//   loc  Location 响应头（重定向用）
//   err  失败原因

import https from 'node:https';
import http from 'node:http';

const url = process.argv[2];
const mode = process.argv.includes('--head') ? 'HEAD' : 'GET';

if (!url) {
  console.log(JSON.stringify({ s: 0, ct: '', len: 0, err: 'missing url' }));
  process.exit(0);
}

const client = url.startsWith('https:') ? https : http;
const req = client.request(url, { method: mode, headers: { 'User-Agent': 'caj-deploy-check' }, timeout: 30000 }, (res) => {
  let len = 0;
  res.on('data', (c) => { len += c.length; });
  res.on('end', () => {
    console.log(JSON.stringify({
      s: res.statusCode,
      ct: (res.headers['content-type'] || '').split(';')[0],
      len: len || Number(res.headers['content-length'] || 0),
      loc: res.headers.location || '',
    }));
  });
});

req.on('error', (e) => console.log(JSON.stringify({ s: 0, ct: '', len: 0, err: e.message })));
req.on('timeout', () => { req.destroy(); console.log(JSON.stringify({ s: 0, ct: '', len: 0, err: 'timeout' })); });
req.end();
