// 本地只读静态服务（quartz public/ 专用），供 main.cjs 与 smoke.cjs 共用。
//   在 site/electron/main.cjs 的实现基础上补齐三条解析规则（Q2 实测 quartz 产物依赖）：
//     1. 路径先 decodeURIComponent（内容目录含中文，如 /1-专利法/1-总则/）；
//     2. 目录 URL（含尾斜杠或裸目录名）→ 目录下 index.html；
//     3. 无扩展名 URL → 追加 .html（quartz 页面产物为 <slug>.html）；
//   未命中一律回落 quartz 产出的 404.html（状态码仍为 404）。
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { promisify } = require('util');

// 异步压缩（阶段5.6 波1-1.5）：zlib.gzipSync 把 13.4MB 的 contentIndex.json 压一遍要
// 84ms，那 84ms 是**整个事件循环**停摆——首屏并发请求的 HTML/CSS/JS 全排在它后面。
// 改走线程池后主线程只等回调，同一时间窗内其余请求照常收发。
const gzipAsync = promisify(zlib.gzip);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
};

// 可压缩的扩展名。字体（woff/woff2）与图片（png/jpg/webp/avif）本身已压缩，再压是净亏
const COMPRESSIBLE = new Set(['.html', '.js', '.mjs', '.css', '.json', '.xml', '.txt', '.svg', '.map']);

// 小于此阈值的文件现压即可（压缩耗时可忽略），不占缓存
const COMPRESS_CACHE_MIN = 16 * 1024;
// 压缩缓存的总字节上限。产物静态且访问集中（contentIndex.json 13.4MB + postscript.js
// 828KB 就占了绝大部分收益），超限时整体清空即可，无需 LRU 的复杂度
const COMPRESS_CACHE_MAX = 32 * 1024 * 1024;
const gzipCache = new Map();
let gzipCacheBytes = 0;
// 在途压缩去重（1.5）：异步化之后，同一文件的并发请求会各自发起一次压缩——
// 首屏正是这种形态（页面与其内联脚本几乎同时取 contentIndex.json）。
// 以缓存键登记在途 Promise，后来者直接搭车，压缩只跑一遍。
const gzipInFlight = new Map();

/**
 * 启动后台预压缩的目标（1.5）：三个「首屏必取且体量最大」的产物。
 * 预热之后首个真实请求直接命中缓存，TTFB 不再包含那 84ms 的压缩。
 */
const PRECOMPRESS_TARGETS = [
  'static/contentIndex.json',
  'static/contentIndexGraph.json',
  'static/graphLayout.json',
  'static/graphLayout-terms.json',
  'postscript.js',
  'index.css',
];

/**
 * 内容安全策略。产物是本地构建的静态站，此处为纵深防御而非补现有洞：
 *   script-src / style-src 的 'unsafe-inline' 不可去——quartz 每页内联 2 个 script
 *     （contentIndex 的 fetchData、callout 折叠）与 5-6 个 style= 属性；
 *   不含 'unsafe-eval'——explorer 的 new Function 已在构建侧消除；
 *   connect-src 'self' 是这里最有价值的一条：它把「零数据外传」从产品承诺
 *     变成浏览器强制，纵使将来某处被注入也无法把批注内容发出去。
 */
const CSP = [
  "default-src 'self'",
  // 不含 'unsafe-eval'——两个来源均已在源码侧消除：
  //   1. PixiJS 8 内部以字符串生成 shader/uniform/UBO/粒子同步代码，已由
  //      graph.inline.ts 导入官方的 pixi.js/unsafe-eval 子模块整体替换为 polyfill；
  //   2. explorer.inline.ts 原用 new Function 还原 Explorer.tsx 序列化的三个函数，
  //      已改为直接内联（sortNodes / keepNode）。
  // 'unsafe-inline' 仍不可去：quartz 每页有 2 个内联 script（contentIndex 的
  // fetchData 与 callout 折叠），去掉需改上游的产物生成方式。
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  // blob: 是 PixiJS 8 的图谱渲染所必需——它用 createObjectURL 建 worker 与纹理源；
  // 漏掉这一项会让图谱总览页静默出不来图（本轮冒烟已实证）
  "img-src 'self' data: blob:",
  "worker-src 'self' blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
  "form-action 'none'",
].join('; ');

const SECURITY_HEADERS = {
  'Content-Security-Policy': CSP,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

// 响应头合成：安全头恒在，调用方只关心自己那几个
function headers(extra) {
  return Object.assign({}, SECURITY_HEADERS, extra);
}

/**
 * Host 头白名单。仅监听回环只挡住了外部直连，挡不住 DNS rebinding——
 * 恶意站点把自己的域名解析到 127.0.0.1，即可用 http://恶意域:47821/ 读取站内文件。
 * 端口固定后该攻击从「需扫描」变为「可直接命中」，故补此校验。
 * （跨源仍读不到 localStorage 里的批注，但站内文本不该被任意网页读走。）
 */
function isAllowedHost(hostHeader, port) {
  if (!hostHeader) return false;
  const i = hostHeader.lastIndexOf(':');
  const host = i > 0 ? hostHeader.slice(0, i) : hostHeader;
  const p = i > 0 ? hostHeader.slice(i + 1) : '';
  if (p !== String(port)) return false;
  return host === '127.0.0.1' || host === 'localhost' || host === '[::1]';
}

// 弱校验器：静态产物只在重新构建时变化，mtime + size 足以判定
function etagOf(stat) {
  return `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
}

function acceptsGzip(req) {
  const ae = req.headers['accept-encoding'];
  return typeof ae === 'string' && ae.includes('gzip');
}

/**
 * 取文件的 gzip 结果，大文件走缓存（1.5 起改异步 + 在途去重）。
 * 三级取值：缓存命中 → 在途 Promise 搭车 → 新起一次线程池压缩。
 * 缓存上限与「超限整体清空」的策略原样保留。
 * @returns {Promise<Buffer>}
 */
function gzipOf(filePath, key, raw) {
  const hit = gzipCache.get(key);
  if (hit) return Promise.resolve(hit);
  const pending = gzipInFlight.get(key);
  if (pending) return pending;
  const task = gzipAsync(raw, { level: 6 })
    .then((out) => {
      if (raw.length >= COMPRESS_CACHE_MIN) {
        if (gzipCacheBytes + out.length > COMPRESS_CACHE_MAX) {
          gzipCache.clear();
          gzipCacheBytes = 0;
        }
        gzipCache.set(key, out);
        gzipCacheBytes += out.length;
      }
      return out;
    })
    .finally(() => {
      // 成败都要摘掉在途登记：失败还挂着的话，后续请求会永久搭上一个已 reject 的车
      gzipInFlight.delete(key);
    });
  gzipInFlight.set(key, task);
  return task;
}

/**
 * 后台预压缩单个产物（1.5）。键的算法必须与 sendFile 逐字一致
 *（`${filePath}:${size}:${mtimeMs}`），否则预热的结果请求侧命不中，白压一遍。
 * 失败一律静默：预热不是必需品，真实请求到来时按原路现压即可。
 */
async function precompress(distRoot, rel) {
  try {
    const filePath = path.join(distRoot, rel);
    if (!COMPRESSIBLE.has(path.extname(filePath).toLowerCase())) return;
    const stat = await fs.promises.stat(filePath);
    if (!stat.isFile()) return;
    const raw = await fs.promises.readFile(filePath);
    await gzipOf(filePath, `${filePath}:${stat.size}:${stat.mtimeMs}`, raw);
  } catch {
    /* 预热失败无副作用，静默 */
  }
}

// 判定文件存在且为普通文件
async function isFile(p) {
  try {
    return (await fs.promises.stat(p)).isFile();
  } catch {
    return false;
  }
}

async function isDirectory(p) {
  try {
    return (await fs.promises.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

// 请求路径 → 磁盘文件的解析（依次尝试：原样文件 → 目录 index.html → 追加 .html）
async function resolveFile(distRoot, urlPath) {
  const filePath = path.normalize(path.join(distRoot, urlPath));
  // 防目录穿越：解析结果必须仍位于 distRoot 之内
  if (filePath !== distRoot && !filePath.startsWith(distRoot + path.sep)) {
    return { status: 403 };
  }
  if (await isFile(filePath)) {
    return { status: 200, filePath };
  }
  if (await isDirectory(filePath)) {
    const indexPath = path.join(filePath, 'index.html');
    if (await isFile(indexPath)) {
      return { status: 200, filePath: indexPath };
    }
  }
  if (path.extname(filePath) === '') {
    const htmlPath = `${filePath}.html`;
    if (await isFile(htmlPath)) {
      return { status: 200, filePath: htmlPath };
    }
  }
  return { status: 404 };
}

// 固定端口：浏览器按「协议 + 主机 + 端口」隔离 localStorage，端口一变，
// 用户在页面里做的批注、笔记与高亮就会连同整个存储桶一起访问不到。
// 因此本应用必须每次启动都用同一个端口。
// 取值落在 IANA 未分配区间，且避开 macOS 的临时端口区（49152 起）——
// 固定端口若落在临时区，会与系统随机分配的端口撞车。
const DEFAULT_PORT = 47821;

// 身份探针路径：端口被占时用于判断占用者是不是本应用的另一个实例
const HEALTH_PATH = '/__patent-kb-health';

/**
 * 送出一份已确认存在的文件：先做 ETag 协商，再按类型选 gzip 或流式传输。
 * 文本走 gzip（实测 2026-08-29：contentIndex.json 13.4MB → 1.96MB、
 * postscript.js 828KB → 253KB、index.css 152KB → 28KB）；
 * 二进制走 stream，避免把大文件整块读进内存。
 */
async function sendFile(req, res, filePath, status) {
  const stat = await fs.promises.stat(filePath);
  const etag = etagOf(stat);
  const ext = path.extname(filePath).toLowerCase();

  // no-cache 不是「不缓存」，而是「可缓存但每次须重验」——配合 ETag 让重复加载走 304，
  // 省掉 contentIndex.json 的整份重传；产物重建后 mtime 变，校验器自然失效。
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers({ ETag: etag, 'Cache-Control': 'no-cache' }));
    res.end();
    return;
  }

  const base = {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    ETag: etag,
    'Cache-Control': 'no-cache',
  };

  if (COMPRESSIBLE.has(ext) && acceptsGzip(req)) {
    const raw = await fs.promises.readFile(filePath);
    const body = await gzipOf(filePath, `${filePath}:${stat.size}:${stat.mtimeMs}`, raw);
    res.writeHead(
      status,
      headers(
        Object.assign({}, base, {
          'Content-Encoding': 'gzip',
          'Content-Length': body.length,
          Vary: 'Accept-Encoding',
        }),
      ),
    );
    res.end(body);
    return;
  }

  res.writeHead(status, headers(Object.assign({}, base, { 'Content-Length': stat.size })));
  const stream = fs.createReadStream(filePath);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

/**
 * 启动只读本地静态服务。
 * @param {string} distRoot 站点产物根目录（quartz-kb/public）
 * @param {{ port?: number }} [options] port 默认 DEFAULT_PORT；传 0 表示随机端口
 *   （冒烟测试等不依赖 localStorage 的场景应显式传 0，避免与正在运行的应用抢端口）
 * @returns {Promise<{ server: import('http').Server, port: number }>}
 */
function startStaticServer(distRoot, options = {}) {
  const listenPort = options.port === undefined ? DEFAULT_PORT : options.port;
  // 实际端口（listenPort 为 0 时由内核分配），Host 校验要用，故在 listen 回调里回填
  let boundPort = listenPort;
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      try {
        // DNS rebinding 防护：先于任何文件访问
        if (!isAllowedHost(req.headers.host, boundPort)) {
          res.writeHead(403, headers({ 'Content-Type': 'text/plain; charset=utf-8' }));
          res.end('Forbidden');
          return;
        }

        // 中文目录/文件名：先剥 query 再整体解码
        let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
        if (urlPath === '' || urlPath === '/') urlPath = '/index.html';

        // 身份探针：先于文件解析处理，不落到静态目录
        if (urlPath === HEALTH_PATH) {
          res.writeHead(200, headers({ 'Content-Type': MIME['.json'] }));
          res.end(JSON.stringify({ app: 'patent-kb', pid: process.pid }));
          return;
        }

        const resolved = await resolveFile(distRoot, urlPath);
        if (resolved.status === 403) {
          res.writeHead(403, headers({ 'Content-Type': 'text/plain; charset=utf-8' }));
          res.end('Forbidden');
          return;
        }
        if (resolved.status === 404) {
          // 回落 quartz 产出的 404 页（保留 404 状态码）
          const notFoundPath = path.join(distRoot, '404.html');
          if (await isFile(notFoundPath)) {
            await sendFile(req, res, notFoundPath, 404);
          } else {
            res.writeHead(404, headers({ 'Content-Type': 'text/plain; charset=utf-8' }));
            res.end('Not found');
          }
          return;
        }

        await sendFile(req, res, resolved.filePath, 200);
      } catch {
        res.writeHead(500, headers({ 'Content-Type': 'text/plain; charset=utf-8' }));
        res.end('Server error');
      }
    });
    // 把端口一并挂到错误上，调用方判断 EADDRINUSE 时可直接取用
    server.on('error', (err) => reject(Object.assign(err, { port: listenPort })));
    // 仅监听回环地址，不对外暴露
    server.listen(listenPort, '127.0.0.1', () => {
      const addr = server.address();
      boundPort = typeof addr === 'object' && addr ? addr.port : listenPort;
      // 后台预压缩（1.5）：不 await，不影响 listen 的返回时机；压缩跑在线程池里，
      // 与随后到来的首屏请求并行而非串行。失败静默（precompress 内部已吞）
      void Promise.all(PRECOMPRESS_TARGETS.map((rel) => precompress(distRoot, rel)));
      resolve({ server, port: boundPort });
    });
  });
}

/**
 * 探测某端口上的服务是否为本应用（用于区分「自己的另一个实例」与「外来程序」）。
 * @param {number} port
 * @returns {Promise<{ app: string, pid: number } | null>} 非本应用或超时均返回 null
 */
function probeHealth(port) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port, path: HEALTH_PATH, timeout: 400 },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          resolve(null);
          return;
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try {
            const parsed = JSON.parse(body);
            resolve(parsed && parsed.app === 'patent-kb' ? parsed : null);
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
    req.on('error', () => resolve(null));
  });
}

module.exports = { startStaticServer, probeHealth, DEFAULT_PORT };
