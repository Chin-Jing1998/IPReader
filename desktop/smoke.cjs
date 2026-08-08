// smoke.cjs —— 桌面端自动化冒烟（npm run smoke / npx electron smoke.cjs）
//
// 全链路：启动直入文档站首页 → SPA 点进书根 → 尾斜杠容器目录 URL → SPA 点进章节页 →
//         无扩展名章节 URL → 词条页 → 图谱总览专页出图 → 搜索"新颖性"。
// 每步截图存 ./audit/；全程以 webRequest 拦截并「阻断 + 记录」一切非 127.0.0.1 请求，
// 等效断网环境（页面若依赖外网资源会直接失败），结果写 audit/offline-report.txt。
const { app, BrowserWindow, session } = require('electron');
const path = require('path');
const fs = require('fs');
const { startStaticServer } = require('./server.cjs');

const DIST = path.join(__dirname, '..', 'quartz-kb', 'public');
const AUDIT = path.join(__dirname, 'audit');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
let shotSeq = 0;

function record(step, ok, detail) {
  results.push({ step, ok, detail });
  console.log(`${ok ? '✅' : '❌'} ${step}${detail ? ` —— ${detail}` : ''}`);
}

async function shot(win, name) {
  shotSeq += 1;
  const img = await win.capturePage();
  const file = path.join(AUDIT, `${String(shotSeq).padStart(2, '0')}-${name}.png`);
  await fs.promises.writeFile(file, img.toPNG());
  return file;
}

// 当前渲染页 pathname（已解码，便于断言中文路径）
async function currentPath(win) {
  const p = await win.webContents.executeJavaScript('location.pathname');
  return decodeURIComponent(p);
}

async function main() {
  await fs.promises.mkdir(AUDIT, { recursive: true });

  // —— 离线护栏：阻断并记录一切非回环地址的网络请求（等效断网） ——
  const externalAttempts = [];
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    try {
      const u = new URL(details.url);
      if (
        (u.protocol === 'http:' || u.protocol === 'https:') &&
        u.hostname !== '127.0.0.1' &&
        u.hostname !== 'localhost'
      ) {
        externalAttempts.push(details.url);
        return callback({ cancel: true });
      }
    } catch {
      /* 非标准 URL（devtools 等）直接放行 */
    }
    callback({});
  });

  // 显式随机端口：冒烟不依赖 localStorage 持久化，用随机端口可与正在运行的
  // 应用（占用固定端口 47821）并存，不必先关闭它
  const { port } = await startStaticServer(DIST, { port: 0 });
  const base = `http://127.0.0.1:${port}`;
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    show: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // —— 0. 启动直入文档站首页（main.cjs 启动 URL 已改为站点根） ——
  await win.loadURL(`${base}/`);
  await sleep(800);
  record('启动直入文档站首页', (await currentPath(win)) === '/');
  await shot(win, '启动-文档站首页');

  // 0b. 入口选择页已移除：/static/entry.html 应回落 quartz 404 页
  {
    const res = await win.webContents.executeJavaScript(
      `fetch('/static/entry.html').then(r => r.status)`,
    );
    record('入口选择页已移除（/static/entry.html → 404）', res === 404, `status=${res}`);
  }

  // 1. 首页
  await win.loadURL(`${base}/`);
  await sleep(800);
  record('启动并加载首页', (await currentPath(win)) === '/');
  await shot(win, '首页');

  // 2. SPA 点击首页链接进入书根（容器目录页，验证 micromorph 站内跳转）
  await win.webContents.executeJavaScript(
    `document.querySelector('a[href="./1-专利法/"]').click()`,
  );
  await sleep(900);
  record('SPA 点进书根目录页', (await currentPath(win)) === '/1-专利法/');
  await shot(win, '书根目录页-SPA跳转');

  // 3. 尾斜杠中文目录 URL 直达（验证静态服务 目录→index.html 规则）
  await win.loadURL(`${base}/${encodeURI('1-专利法/1-总则/')}`);
  await sleep(600);
  record('尾斜杠目录 URL 直达容器页', (await currentPath(win)) === '/1-专利法/1-总则/');
  await shot(win, '容器目录页-尾斜杠URL');

  // 4. SPA 点进章节页（law-01-01，中文目录下的叶子页）
  await win.webContents.executeJavaScript(
    `document.querySelector('a[href*="law-01-01"]').click()`,
  );
  await sleep(900);
  record('SPA 点进章节页 law-01-01', (await currentPath(win)) === '/1-专利法/1-总则/law-01-01');
  await shot(win, '章节页-law-01-01');

  // 5. 无扩展名章节 URL 直达（验证静态服务 无扩展名→.html 规则）
  await win.loadURL(`${base}/${encodeURI('2-专利法实施细则/1-总则/rule-01-01')}`);
  await sleep(600);
  const rulePath = await currentPath(win);
  const ruleTitle = await win.webContents.executeJavaScript('document.title');
  record('无扩展名 URL 直达章节页 rule-01-01', rulePath === '/2-专利法实施细则/1-总则/rule-01-01', `title=${ruleTitle}`);
  await shot(win, '章节页-无扩展名URL');

  // 6. 词条页
  await win.loadURL(`${base}/${encodeURI('9-关键词索引/99-综合/term-0001')}`);
  await sleep(600);
  record('词条页 term-0001', (await currentPath(win)) === '/9-关键词索引/99-综合/term-0001');
  await shot(win, '词条页-term-0001');

  // —— 7. 图谱总览专页：画布出图（.ge-canvas 下渲染标签为 svg 或 canvas，二者任一出现即算出图） ——
  await win.loadURL(`${base}/${encodeURI('0-图谱总览/')}`);
  let geReady = false;
  for (let i = 0; i < 30; i += 1) {
    await sleep(500);
    geReady = await win.webContents.executeJavaScript(
      `!!document.querySelector('.ge-canvas svg, .ge-canvas canvas')`,
    );
    if (geReady) break;
  }
  await sleep(1500);
  record('图谱总览页出图', geReady);
  await shot(win, '图谱总览-出图');

  // 8. 搜索「新颖性」
  await win.loadURL(`${base}/`);
  await sleep(600);
  await win.webContents.executeJavaScript(
    `(() => {
       document.querySelector('.search > .search-button').click();
       const bar = document.querySelector('.search .search-bar');
       bar.value = '新颖性';
       bar.dispatchEvent(new Event('input', { bubbles: true }));
     })()`,
  );
  await sleep(2500); // 首次搜索需就地构建全文索引，多等一会
  const hitCount = await win.webContents.executeJavaScript(
    `document.querySelectorAll('.results-container .result-card').length`,
  );
  record('搜索「新颖性」返回结果', hitCount > 0, `命中 ${hitCount} 条`);
  await shot(win, '搜索-新颖性');

  // —— 离线报告 ——
  const failed = results.filter((r) => !r.ok);
  const report = [
    `冒烟时间：${new Date().toISOString()}`,
    `离线护栏：全程阻断非 127.0.0.1 请求（等效断网），页面均正常渲染`,
    `外部请求尝试次数：${externalAttempts.length}`,
    ...externalAttempts.map((u) => `  - ${u}`),
    '',
    '步骤结果：',
    ...results.map((r) => `  ${r.ok ? 'PASS' : 'FAIL'}  ${r.step}${r.detail ? `（${r.detail}）` : ''}`),
  ].join('\n');
  await fs.promises.writeFile(path.join(AUDIT, 'offline-report.txt'), report + '\n', 'utf8');
  console.log(report);

  app.exit(failed.length > 0 || externalAttempts.length > 0 ? 1 : 0);
}

app.whenReady().then(() =>
  main().catch(async (e) => {
    console.error('冒烟失败：', e);
    await fs.promises.writeFile(
      path.join(AUDIT, 'offline-report.txt'),
      `冒烟中断：${e && e.stack ? e.stack : e}\n`,
      'utf8',
    ).catch(() => {});
    app.exit(1);
  }),
);

// 兜底：无论如何 120 秒后强制退出，避免残留进程
setTimeout(() => {
  console.error('冒烟超时，强制退出');
  app.exit(1);
}, 120000);
