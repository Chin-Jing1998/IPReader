// updater.cjs —— 更新检测（只查版本号，不下载、不安装）
//
// 为什么只做「检测 + 提示」而不做自动升级：macOS 的 Squirrel.Mac 要求应用经
// Developer ID 签名并公证，而本发行版 identity 显式为 null（未签名），
// autoUpdater 在未签名应用上会直接抛 Could not get code signature。
// 与其两端行为不一致，不如统一为「发现新版 → 提示 → 由用户自行下载」。
//
// 与「完全离线」的关系：本模块是全应用唯一会发出外部请求的地方，且
//   1. 默认不启用——「启动时自动检查」开关默认关闭，不点按钮就永不联网；
//   2. 只向 GitHub Releases API 取一个 JSON，读其中的版本号与说明，不下载任何文件；
//   3. 请求发自主进程，不经渲染层，故页面侧的 connect-src 'self' 保持不变。
const { net } = require('electron');

// 公开仓库的 latest release 接口。用 api.github.com 而非解析 releases 页面：
// 前者是稳定契约，后者的 HTML 结构随时会变。
const FEED_URL = 'https://api.github.com/repos/Chin-Jing1998/PatentReader/releases/latest';
const RELEASES_PAGE = 'https://github.com/Chin-Jing1998/PatentReader/releases';
// 国内网络访问 GitHub 常有长尾延迟，给足时间；但不能无限等——用户点了按钮就该有回音
const TIMEOUT_MS = 12000;
// 响应体上限：正常 latest release 的 JSON 约 3–8KB，超出即视为异常来源
const MAX_BYTES = 512 * 1024;

/**
 * 语义化版本比较，返回 -1 / 0 / 1。
 * 只比较主次修订三段数字；预发布后缀（-beta.1 之类）一律按「低于同号正式版」处理。
 * @param {string} a
 * @param {string} b
 */
function compareVersions(a, b) {
  const parse = (v) => {
    const s = String(v || '').trim().replace(/^v/i, '');
    const [core, pre] = s.split('-');
    const nums = core.split('.').map((x) => parseInt(x, 10));
    return {
      nums: [nums[0] || 0, nums[1] || 0, nums[2] || 0],
      pre: pre || null,
    };
  };
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    if (pa.nums[i] !== pb.nums[i]) return pa.nums[i] > pb.nums[i] ? 1 : -1;
  }
  if (pa.pre === pb.pre) return 0;
  if (!pa.pre) return 1;   // 正式版 > 预发布
  if (!pb.pre) return -1;
  return pa.pre > pb.pre ? 1 : -1;
}

/** 拉取 latest release 的元数据。任何失败都归一为 { ok:false, reason }，不抛异常。 */
function fetchLatest() {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };

    let request;
    try {
      request = net.request({ method: 'GET', url: FEED_URL });
    } catch (e) {
      done({ ok: false, reason: 'network', detail: e && e.message });
      return;
    }

    // GitHub API 拒绝无 User-Agent 的请求
    request.setHeader('User-Agent', 'PatentReader-Desktop');
    request.setHeader('Accept', 'application/vnd.github+json');

    const timer = setTimeout(() => {
      try { request.abort(); } catch { /* abort 失败无需处理，超时结果已定 */ }
      done({ ok: false, reason: 'timeout' });
    }, TIMEOUT_MS);

    request.on('response', (response) => {
      const status = response.statusCode;
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BYTES) {
          try { request.abort(); } catch { /* 同上 */ }
          clearTimeout(timer);
          done({ ok: false, reason: 'oversize' });
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        clearTimeout(timer);
        if (status === 403 || status === 429) return done({ ok: false, reason: 'rate-limit' });
        if (status === 404) return done({ ok: false, reason: 'no-release' });
        if (status !== 200) return done({ ok: false, reason: 'http', detail: String(status) });
        try {
          const json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          done({
            ok: true,
            tag: String(json.tag_name || ''),
            name: String(json.name || ''),
            notes: String(json.body || ''),
            url: String(json.html_url || RELEASES_PAGE),
            publishedAt: String(json.published_at || ''),
          });
        } catch {
          done({ ok: false, reason: 'parse' });
        }
      });
      response.on('error', () => { clearTimeout(timer); done({ ok: false, reason: 'network' }); });
    });

    request.on('error', (e) => {
      clearTimeout(timer);
      done({ ok: false, reason: 'network', detail: e && e.message });
    });

    request.end();
  });
}

const REASON_TEXT = {
  network: '无法连接到 GitHub，请检查网络后重试',
  timeout: '连接超时，请稍后重试',
  'rate-limit': 'GitHub 接口访问频次受限，请过一会儿再试',
  'no-release': '尚未发布任何版本',
  oversize: '响应异常，已中止',
  parse: '响应内容无法解析',
  http: '服务器返回异常',
};

/**
 * 执行一次检查。
 * @param {string} currentVersion 当前应用版本（app.getVersion()）
 * @returns {Promise<{status:'update'|'latest'|'error', current:string, latest?:string,
 *                    url?:string, notes?:string, message:string}>}
 */
async function checkForUpdate(currentVersion) {
  const res = await fetchLatest();
  if (!res.ok) {
    return {
      status: 'error',
      current: currentVersion,
      message: REASON_TEXT[res.reason] || '检查失败',
      url: RELEASES_PAGE,
    };
  }

  const latest = res.tag.replace(/^v/i, '');
  if (!latest) {
    return { status: 'error', current: currentVersion, message: '未能识别最新版本号', url: RELEASES_PAGE };
  }

  if (compareVersions(latest, currentVersion) > 0) {
    return {
      status: 'update',
      current: currentVersion,
      latest,
      url: res.url || RELEASES_PAGE,
      // 更新说明可能很长，截断后再交给界面——提示框不该变成一篇公告
      notes: res.notes.slice(0, 600),
      publishedAt: res.publishedAt,
      message: `有新版本 ${latest} 可用（当前 ${currentVersion}）`,
    };
  }

  return {
    status: 'latest',
    current: currentVersion,
    latest,
    url: RELEASES_PAGE,
    message: `已是最新版本（${currentVersion}）`,
  };
}

module.exports = { checkForUpdate, compareVersions, RELEASES_PAGE, FEED_URL };
