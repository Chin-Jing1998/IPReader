// offline-guard.cjs —— 离线护栏：阻断并记录 MCP 服务进程内一切非回环的网络访问
//
// 与 desktop/smoke.cjs:137-148 的护栏同源——那边用 Electron 的 webRequest 拦截，
// 这里是纯 Node 进程，故在最底层的 net/dns/tls 与全局 fetch 上设卡。
// 「完全离线」由此从一句承诺变成可执行的断言：任何一次外部访问都会被拒绝并计数，
// 冒烟测试断言该计数恒为 0。
//
// 用法（由 smoke.mjs 注入，不参与生产运行）：
//   NODE_OPTIONS="--require ./offline-guard.cjs" IPREADER_OFFLINE_REPORT=/tmp/x.json node dist/server.mjs
const net = require('node:net');
const dns = require('node:dns');
const tls = require('node:tls');
const fs = require('node:fs');

const attempts = [];
const LOOPBACK = /^(127\.\d+\.\d+\.\d+|::1|localhost)$/i;

function record(kind, target) {
  attempts.push(`${kind} → ${target}`);
  const err = new Error(`[offline-guard] 已阻断外部访问：${kind} → ${target}`);
  err.code = 'EOFFLINE';
  return err;
}

// —— net：所有 TCP 连接的总入口，http/https/fetch 最终都经此 ——
const rawConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function patchedConnect(...args) {
  const opts = typeof args[0] === 'object' && args[0] !== null ? args[0] : { port: args[0], host: args[1] };
  const host = String(opts.host || opts.path || 'localhost');
  if (!LOOPBACK.test(host)) throw record('net.connect', `${host}:${opts.port ?? '?'}`);
  return rawConnect.apply(this, args);
};

// —— tls：https 的连接层，单独设卡以便报告区分 ——
const rawTlsConnect = tls.connect;
tls.connect = function patchedTlsConnect(...args) {
  const opts = typeof args[0] === 'object' && args[0] !== null ? args[0] : { port: args[0], host: args[1] };
  const host = String(opts.host || opts.servername || 'localhost');
  if (!LOOPBACK.test(host)) throw record('tls.connect', host);
  return rawTlsConnect.apply(this, args);
};

// —— dns：域名解析本身即外部行为，先于连接发生 ——
const rawLookup = dns.lookup;
dns.lookup = function patchedLookup(hostname, ...rest) {
  if (!LOOPBACK.test(String(hostname))) {
    const err = record('dns.lookup', hostname);
    const cb = rest[rest.length - 1];
    if (typeof cb === 'function') return cb(err);
    throw err;
  }
  return rawLookup.call(this, hostname, ...rest);
};

// —— 全局 fetch：Node 18+ 走 undici，不经上面的 net patch ——
if (typeof globalThis.fetch === 'function') {
  const rawFetch = globalThis.fetch;
  globalThis.fetch = function patchedFetch(input, init) {
    const url = String(typeof input === 'string' ? input : (input && input.url) || input);
    let host = '';
    try { host = new URL(url).hostname; } catch { host = url; }
    if (!LOOPBACK.test(host)) return Promise.reject(record('fetch', url));
    return rawFetch.call(this, input, init);
  };
}

// —— 退出时落报告，供父进程断言 ——
process.on('exit', () => {
  const out = process.env.IPREADER_OFFLINE_REPORT;
  if (!out) return;
  try {
    fs.writeFileSync(out, JSON.stringify({ externalAttempts: attempts.length, attempts }, null, 2));
  } catch {
    // 报告写不出不应影响被测进程的退出码
  }
});
