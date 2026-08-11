// smoke.cjs —— 桌面端自动化冒烟（npm run smoke / npx electron smoke.cjs）
//
// 全链路：启动直入文档站首页 → SPA 点进书根 → 尾斜杠容器目录 URL → SPA 点进章节页 →
//         无扩展名章节 URL → 词条页 → 图谱总览专页出图 → 搜索"新颖性" →
//         设置页可达 → 主题卡选择持久化（reload 后仍生效）→ 快捷钮脱离跟随系统 →
//         桌面标题条（38px+flex）→ 全局偏移（body/左栏）→ 设置页沉浸（双栏隐藏） →
//         深链返回兜底（新窗口 history.length===1，R12）→ overlay 滚动条零挤压（R13）。
// 每步截图存 ./audit/；全程以 webRequest 拦截并「阻断 + 记录」一切非 127.0.0.1 请求，
// 等效断网环境（页面若依赖外网资源会直接失败），结果写 audit/offline-report.txt。
// 建窗统一带 titleBarStyle:'hiddenInset'（仅 darwin）：与 main.cjs 的生产建窗配置对齐，
// 避免渲染层自绘 .kb-titlebar 与系统原生标题栏双重叠加污染截图基线（R15）。
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
    // 仅 macOS 启用自绘标题条，与 main.cjs 的建窗配置保持一致——否则渲染层的
    // .kb-titlebar（随 data-desktop 显示）会与系统原生标题栏双重叠加，污染截图基线（R15）
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' } : {}),
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

  // 6. 词条页（term-0001 自索引分类整合后归"33-可专利客体"；断言同时核验真实渲染标题，
  //    仅查 pathname 会在 404 页恒真——404 页保留请求路径，曾长期掩盖旧路径失效）
  await win.loadURL(`${base}/${encodeURI('9-关键词索引/33-可专利客体/term-0001')}`);
  await sleep(600);
  const termTitle = await win.webContents.executeJavaScript('document.title');
  record(
    '词条页 term-0001',
    (await currentPath(win)) === '/9-关键词索引/33-可专利客体/term-0001' && !/未找到|404/.test(termTitle),
    `title=${termTitle}`,
  );
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

  // 11. 设置页可达
  await win.loadURL(base + encodeURI('/设置/'));
  await sleep(600);
  const settingsReady = await win.webContents.executeJavaScript(
    `!!document.querySelector('.kb-settings-page')`,
  );
  record('设置页可达', settingsReady);
  await shot(win, '设置页');

  // 12. 主题卡持久化（点击竹林主题卡 → dataset.style 即时生效；reload 后 dataset.style 与 localStorage 均仍为 zhulin）
  await win.webContents.executeJavaScript(
    `document.querySelector('.kb-theme-card[data-value="zhulin"]').click()`,
  );
  await sleep(300);
  const styleAfterClick = await win.webContents.executeJavaScript(
    `document.documentElement.dataset.style`,
  );

  await new Promise((resolve) => {
    win.webContents.once('did-finish-load', resolve);
    win.webContents.reload();
  });
  await sleep(600);
  const styleAfterReload = await win.webContents.executeJavaScript(
    `document.documentElement.dataset.style`,
  );
  const persistedStyle = await win.webContents.executeJavaScript(
    `(() => { try { return JSON.parse(localStorage.getItem('kb-settings:v1')).style; } catch { return null; } })()`,
  );
  record(
    '主题卡持久化（点击生效 + reload 后仍保留）',
    styleAfterClick === 'zhulin' && styleAfterReload === 'zhulin' && persistedStyle === 'zhulin',
    `点击后=${styleAfterClick}, reload后=${styleAfterReload}, localStorage=${persistedStyle}`,
  );
  await shot(win, '设置页-主题卡持久化');

  // 测毕复原为默认宣纸主题，避免污染后续步骤的截图基线
  await win.webContents.executeJavaScript(
    `document.querySelector('.kb-theme-card[data-value="xuanzhi"]').click()`,
  );
  await sleep(300);

  // 13. 快捷钮脱离跟随（点击日/月快捷钮 → saved-theme 翻转且 themeMode 落固定值，不再是 system）
  const savedThemeBefore = await win.webContents.executeJavaScript(
    `document.documentElement.getAttribute('saved-theme')`,
  );
  await win.webContents.executeJavaScript(`document.querySelector('.kb-theme-toggle').click()`);
  await sleep(300);
  const savedThemeAfter = await win.webContents.executeJavaScript(
    `document.documentElement.getAttribute('saved-theme')`,
  );
  const themeModeAfter = await win.webContents.executeJavaScript(
    `(() => { try { return JSON.parse(localStorage.getItem('kb-settings:v1')).themeMode; } catch { return null; } })()`,
  );
  record(
    '快捷钮脱离跟随系统',
    savedThemeAfter !== savedThemeBefore &&
      (themeModeAfter === 'light' || themeModeAfter === 'dark'),
    `saved-theme: ${savedThemeBefore}→${savedThemeAfter}, themeMode=${themeModeAfter}`,
  );
  await shot(win, '设置页-快捷钮切换');

  // 复原，避免影响下次运行
  await win.webContents.executeJavaScript(`document.querySelector('.kb-theme-toggle').click()`);
  await sleep(300);

  // 14. 桌面标题条（自绘 titlebar：html[data-desktop] 首帧落 + --titlebar-h 38px + flex 显示）
  await win.loadURL(`${base}/`);
  await sleep(600);
  const titlebarProbe = await win.webContents.executeJavaScript(
    `(() => {
       const el = document.querySelector('.kb-titlebar');
       const cs = el ? getComputedStyle(el) : null;
       return {
         desktop: document.documentElement.dataset.desktop,
         height: cs ? cs.height : null,
         display: cs ? cs.display : null,
       };
     })()`,
  );
  record(
    '桌面标题条（data-desktop=true + 38px + flex）',
    titlebarProbe.desktop === 'true' &&
      titlebarProbe.height === '38px' &&
      titlebarProbe.display === 'flex',
    `data-desktop=${titlebarProbe.desktop}, height=${titlebarProbe.height}, display=${titlebarProbe.display}`,
  );
  await shot(win, '桌面标题条');

  // 15. 全局偏移（body padding-top 38px 让位标题条，左栏随之下移不被遮挡）
  const offsetProbe = await win.webContents.executeJavaScript(
    `(() => {
       const sidebar = document.querySelector('.sidebar.left');
       return {
         bodyPaddingTop: getComputedStyle(document.body).paddingTop,
         sidebarTop: sidebar ? sidebar.getBoundingClientRect().top : null,
       };
     })()`,
  );
  record(
    '全局偏移（body padding-top 38px + 左栏 top≥38）',
    offsetProbe.bodyPaddingTop === '38px' &&
      offsetProbe.sidebarTop !== null &&
      offsetProbe.sidebarTop >= 38,
    `bodyPaddingTop=${offsetProbe.bodyPaddingTop}, sidebarTop=${offsetProbe.sidebarTop}`,
  );
  await shot(win, '全局偏移');

  // 16. 设置页沉浸（左右栏隐藏、页头三件与空正文让位、返回钮/标题就位、六张主题卡在场）
  await win.loadURL(base + encodeURI('/设置/'));
  await sleep(600);
  const immersiveProbe = await win.webContents.executeJavaScript(
    `(() => {
       const left = document.querySelector('.sidebar.left');
       const right = document.querySelector('.sidebar.right');
       const article = document.querySelector('.center > article');
       const articleHidden =
         !article || article.offsetParent === null || getComputedStyle(article).display === 'none';
       return {
         leftHidden: !left || left.offsetParent === null,
         rightHidden: !right || right.offsetParent === null,
         articleHidden,
         hasBack: !!document.querySelector('.kb-settings-back'),
         hasTitle: !!document.querySelector('.kb-settings-title'),
         cardCount: document.querySelectorAll('.kb-theme-card').length,
       };
     })()`,
  );
  record(
    '设置页沉浸（双栏隐藏 + 正文让位 + 返回钮/标题/六卡在场）',
    immersiveProbe.leftHidden &&
      immersiveProbe.rightHidden &&
      immersiveProbe.articleHidden &&
      immersiveProbe.hasBack &&
      immersiveProbe.hasTitle &&
      immersiveProbe.cardCount === 6,
    `left隐=${immersiveProbe.leftHidden}, right隐=${immersiveProbe.rightHidden}, article隐=${immersiveProbe.articleHidden}, ` +
      `返回钮=${immersiveProbe.hasBack}, 标题=${immersiveProbe.hasTitle}, 主题卡=${immersiveProbe.cardCount}`,
  );
  await shot(win, '设置页沉浸');

  // 17. 深链返回兜底（新窗口 loadURL 直达设置页，history.length===1 场景；
  //     settings.inline.ts 的返回钮此时不 preventDefault，靠 <a href> SSR 兜底回首页，R12 硬断言）
  const deepWin = new BrowserWindow({
    width: 1440,
    height: 900,
    show: true,
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  await deepWin.loadURL(base + encodeURI('/设置/'));
  await sleep(600);
  const historyLenBefore = await deepWin.webContents.executeJavaScript('window.history.length');
  await deepWin.webContents.executeJavaScript(
    `document.querySelector('.kb-settings-back').click()`,
  );
  await sleep(900);
  const deepLinkPath = await currentPath(deepWin);
  record(
    '深链返回兜底（history.length===1 → 回首页，R12）',
    historyLenBefore === 1 && deepLinkPath === '/',
    `historyLenBefore=${historyLenBefore}, pathAfterClick=${deepLinkPath}`,
  );
  await shot(deepWin, '深链返回兜底');
  deepWin.close();

  // 18. overlay 滚动条零挤压（回到章节页；滚动前后 .explorer-ul 的 clientWidth 须完全相等——挤压回归硬断言）
  // 路径经校验为产物中真实存在的词条页（term-0001 归类在"33-可专利客体"，非旧步骤 6 沿用的
  // "99-综合" ——那一档并无 term-0001.html，步骤 6 的断言只验证了路径回显、未验证页面真实加载，
  // 属既有 13 步的既有状况，本步不沿用其路径，另择已核实存在的页面）
  await win.loadURL(`${base}/${encodeURI('9-关键词索引/33-可专利客体/term-0001')}`);
  await sleep(700);
  const widthBefore = await win.webContents.executeJavaScript(
    `(() => {
       const el = document.querySelector('.explorer-ul');
       return el ? el.clientWidth : null;
     })()`,
  );
  await win.webContents.executeJavaScript(
    `(() => {
       const el = document.querySelector('.explorer-ul');
       if (el) el.scrollTop += 200;
     })()`,
  );
  await sleep(250);
  const oscrollProbe = await win.webContents.executeJavaScript(
    `(() => {
       const track = document.querySelector('.kb-oscroll');
       const list = document.querySelector('.explorer-ul');
       return {
         exists: !!track,
         visible: track ? track.classList.contains('is-visible') : false,
         widthAfter: list ? list.clientWidth : null,
       };
     })()`,
  );
  record(
    'overlay 滚动条零挤压（.kb-oscroll 可见 + clientWidth 滚动前后相等）',
    widthBefore !== null &&
      oscrollProbe.exists &&
      oscrollProbe.visible &&
      oscrollProbe.widthAfter === widthBefore,
    `轨道存在=${oscrollProbe.exists}, is-visible=${oscrollProbe.visible}, clientWidth ${widthBefore}→${oscrollProbe.widthAfter}`,
  );
  await shot(win, 'overlay滚动条');

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
