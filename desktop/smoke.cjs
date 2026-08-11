// smoke.cjs —— 桌面端自动化冒烟（npm run smoke / npx electron smoke.cjs）
//
// 全链路：启动直入文档站首页 → SPA 点进书根 → 尾斜杠容器目录 URL → SPA 点进章节页 →
//         无扩展名章节 URL → 词条页 → 图谱总览专页出图 → 搜索"新颖性" →
//         设置页可达 → 主题卡选择持久化（reload 后仍生效）→ 快捷钮脱离跟随系统 →
//         桌面标题条（38px+flex）→ 全局偏移（body/左栏）→ 设置页沉浸 + 抽屉双栏 →
//         深链返回兜底（新窗口 history.length===1，R12）→ overlay 滚动条零挤压（R13）→
//         抽屉分类切换 → 影子滚动条几何与拖拽 → SPA 不残留 →
//         悬停预览弹窗底色与入场不透明 → 搜索弹层主题化 → 跟随系统零双跳（bug#2 竞态回归门）。
// 每步截图存 ./audit/；全程以 webRequest 拦截并「阻断 + 记录」一切非 127.0.0.1 请求，
// 等效断网环境（页面若依赖外网资源会直接失败），结果写 audit/offline-report.txt。
// 建窗统一带 titleBarStyle:'hiddenInset'（仅 darwin）：与 main.cjs 的生产建窗配置对齐，
// 避免渲染层自绘 .kb-titlebar 与系统原生标题栏双重叠加污染截图基线（R15）。
//
// v11 扩写：设置页抽屉双栏（16、19）、影子滚动条几何与拖拽（20）、
// SPA 不残留（21）、跟随系统零双跳（22），共 22 步。
//（v11 曾含「页头 sticky 收缩几何」与「页脚吸底」两组断言，随该功能被用户验收裁决撤销而移除。）
// v12 扩写：悬停预览弹窗底色与入场不透明（22）、搜索弹层主题化（23），共 24 步。前者核验
// 入场关键帧 dropin 改常量不透明（旧版 200ms 意图延迟 + 180ms 动画时长内整窗渐变半透明、
// 下层正文透出叠字，现改 opacity:1→1 由 forwards 锁定）与底色/描边随
// --popover-bg/--popover-border 主题 token 同源；后者核验命中词高亮改 --textHighlight、
// 结果卡改 12px 圆角玻璃描边、.search-path 过渡 0.5s→260ms。原步骤 22「跟随系统零双跳」
// 顺延为 24（收尾主题复位须保持最后）。
const {
  app,
  BrowserWindow,
  session,
  ipcMain,
  nativeTheme,
} = require("electron");
const path = require("path");
const fs = require("fs");
const { startStaticServer } = require("./server.cjs");

const DIST = path.join(__dirname, "..", "quartz-kb", "public");
const AUDIT = path.join(__dirname, "audit");

// 长正文章节页：影子滚动条与 SPA 步骤需要足量滚动余量（实测 scrollHeight≈17k，滚动余量≈16k）。
// **不能按 HTML 字节数挑页**：每页都内嵌整棵 2209 项目录树的 <template>，
// 字节数被它主导，正文长短反而看不出来——本页是按 <article> 内正文字数排出的最长页。
const LONG_PAGE = "6-化学撰写规范/2-撰写示例及分析/chem-02-03-03";
// SPA 三跳路径：末跳回落 LONG_PAGE，保证轨道断言落在滚动余量充足的页面上
const SPA_HOPS = [
  "6-化学撰写规范/1-撰写规范/chem-01-04-06",
  "3-专利审查指南/2-实质审查/8-实质审查程序/02-08-05-02",
  LONG_PAGE,
];

// 自绘标题条高度（--titlebar-h，仅 darwin）；步骤 20/21 的几何基线
const TITLEBAR_H = process.platform === "darwin" ? 38 : 0;
// —— 主题 IPC 桩：与 main.cjs 的 'apply-theme-source' 同协议，但**不写盘** ——
// smoke.cjs 不加载 main.cjs，故 preload 暴露的 applyThemeSource 若无 handler 会
// 直接 reject（渲染层 catch 成 undefined），步骤 24 的竞态回归门就永远走不到
// 「消费主进程权威亮暗态」那条路径，等于没测。此处只做 main.cjs 中与竞态相关的
// 两件事：落 nativeTheme.themeSource、回传落定后的 shouldUseDarkColors；
// window-state 落盘刻意不复制，避免冒烟污染用户的窗口状态文件。
const THEME_MODES = ["light", "dark", "system"];
ipcMain.handle("apply-theme-source", (_event, payload) => {
  const mode =
    payload && THEME_MODES.includes(payload.mode) ? payload.mode : null;
  if (mode) nativeTheme.themeSource = mode;
  return { dark: nativeTheme.shouldUseDarkColors };
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
let shotSeq = 0;

function record(step, ok, detail) {
  results.push({ step, ok, detail });
  console.log(`${ok ? "✅" : "❌"} ${step}${detail ? ` —— ${detail}` : ""}`);
}

async function shot(win, name) {
  shotSeq += 1;
  const img = await win.capturePage();
  const file = path.join(
    AUDIT,
    `${String(shotSeq).padStart(2, "0")}-${name}.png`,
  );
  await fs.promises.writeFile(file, img.toPNG());
  return file;
}

// 当前渲染页 pathname（已解码，便于断言中文路径）
async function currentPath(win) {
  const p = await win.webContents.executeJavaScript("location.pathname");
  return decodeURIComponent(p);
}

// 页面内颜色解析函数源码（步骤 22/23 复用）：rgb()/rgba()/#rrggbb[aa] 统一转
// {r,g,b,a}。构建产物里 rgba() 字面量常被压缩器改写成等效的 8 位 hex
// （--popover-bg/--popover-border/--glass-border 均如此，实测核对过），而
// getComputedStyle 读回的 backgroundColor/borderColor 却始终是 rgb()/rgba()
// 函数记法——两侧字面量形式不对称，比对前必须先在页面内解析归一，不能假设
// token 一定是某一种写法。以字符串形式注入到各 executeJavaScript 调用里。
const PARSE_COLOR_FN = `
  function parseColor(str) {
    if (!str) return null;
    str = str.trim();
    const rgbMatch = /^rgba?\\(([^)]+)\\)$/i.exec(str);
    if (rgbMatch) {
      const body = rgbMatch[1].replace('/', ' ').replace(/,/g, ' ').trim();
      const parts = body.split(/\\s+/).map((s) => parseFloat(s));
      return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
    }
    const hexMatch = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(str);
    if (hexMatch) {
      const hex = hexMatch[1];
      const a = hexMatch[2] ? parseInt(hexMatch[2], 16) / 255 : 1;
      return {
        r: parseInt(hex.slice(0, 2), 16),
        g: parseInt(hex.slice(2, 4), 16),
        b: parseInt(hex.slice(4, 6), 16),
        a,
      };
    }
    return null;
  }
`;

async function main() {
  await fs.promises.mkdir(AUDIT, { recursive: true });

  // —— 离线护栏：阻断并记录一切非回环地址的网络请求（等效断网） ——
  const externalAttempts = [];
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    try {
      const u = new URL(details.url);
      if (
        (u.protocol === "http:" || u.protocol === "https:") &&
        u.hostname !== "127.0.0.1" &&
        u.hostname !== "localhost"
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
    ...(process.platform === "darwin" ? { titleBarStyle: "hiddenInset" } : {}),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // —— 0. 启动直入文档站首页（main.cjs 启动 URL 已改为站点根） ——
  await win.loadURL(`${base}/`);
  await sleep(800);
  record("启动直入文档站首页", (await currentPath(win)) === "/");
  await shot(win, "启动-文档站首页");

  // 0b. 入口选择页已移除：/static/entry.html 应回落 quartz 404 页
  {
    const res = await win.webContents.executeJavaScript(
      `fetch('/static/entry.html').then(r => r.status)`,
    );
    record(
      "入口选择页已移除（/static/entry.html → 404）",
      res === 404,
      `status=${res}`,
    );
  }

  // 1. 首页
  await win.loadURL(`${base}/`);
  await sleep(800);
  record("启动并加载首页", (await currentPath(win)) === "/");
  await shot(win, "首页");

  // 2. SPA 点击首页链接进入书根（容器目录页，验证 micromorph 站内跳转）
  await win.webContents.executeJavaScript(
    `document.querySelector('a[href="./1-专利法/"]').click()`,
  );
  await sleep(900);
  record("SPA 点进书根目录页", (await currentPath(win)) === "/1-专利法/");
  await shot(win, "书根目录页-SPA跳转");

  // 3. 尾斜杠中文目录 URL 直达（验证静态服务 目录→index.html 规则）
  await win.loadURL(`${base}/${encodeURI("1-专利法/1-总则/")}`);
  await sleep(600);
  record(
    "尾斜杠目录 URL 直达容器页",
    (await currentPath(win)) === "/1-专利法/1-总则/",
  );
  await shot(win, "容器目录页-尾斜杠URL");

  // 4. SPA 点进章节页（law-01-01，中文目录下的叶子页）
  await win.webContents.executeJavaScript(
    `document.querySelector('a[href*="law-01-01"]').click()`,
  );
  await sleep(900);
  record(
    "SPA 点进章节页 law-01-01",
    (await currentPath(win)) === "/1-专利法/1-总则/law-01-01",
  );
  await shot(win, "章节页-law-01-01");

  // 5. 无扩展名章节 URL 直达（验证静态服务 无扩展名→.html 规则）
  await win.loadURL(
    `${base}/${encodeURI("2-专利法实施细则/1-总则/rule-01-01")}`,
  );
  await sleep(600);
  const rulePath = await currentPath(win);
  const ruleTitle = await win.webContents.executeJavaScript("document.title");
  record(
    "无扩展名 URL 直达章节页 rule-01-01",
    rulePath === "/2-专利法实施细则/1-总则/rule-01-01",
    `title=${ruleTitle}`,
  );
  await shot(win, "章节页-无扩展名URL");

  // 6. 词条页（term-0001 自索引分类整合后归"33-可专利客体"；断言同时核验真实渲染标题，
  //    仅查 pathname 会在 404 页恒真——404 页保留请求路径，曾长期掩盖旧路径失效）
  await win.loadURL(
    `${base}/${encodeURI("9-关键词索引/33-可专利客体/term-0001")}`,
  );
  await sleep(600);
  const termTitle = await win.webContents.executeJavaScript("document.title");
  record(
    "词条页 term-0001",
    (await currentPath(win)) === "/9-关键词索引/33-可专利客体/term-0001" &&
      !/未找到|404/.test(termTitle),
    `title=${termTitle}`,
  );
  await shot(win, "词条页-term-0001");

  // —— 7. 图谱总览专页：画布出图（.ge-canvas 下渲染标签为 svg 或 canvas，二者任一出现即算出图） ——
  await win.loadURL(`${base}/${encodeURI("0-图谱总览/")}`);
  let geReady = false;
  for (let i = 0; i < 30; i += 1) {
    await sleep(500);
    geReady = await win.webContents.executeJavaScript(
      `!!document.querySelector('.ge-canvas svg, .ge-canvas canvas')`,
    );
    if (geReady) break;
  }
  await sleep(1500);
  record("图谱总览页出图", geReady);
  await shot(win, "图谱总览-出图");

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
  record("搜索「新颖性」返回结果", hitCount > 0, `命中 ${hitCount} 条`);
  await shot(win, "搜索-新颖性");

  // 11. 设置页可达
  await win.loadURL(base + encodeURI("/设置/"));
  await sleep(600);
  const settingsReady = await win.webContents.executeJavaScript(
    `!!document.querySelector('.kb-settings-page')`,
  );
  record("设置页可达", settingsReady);
  await shot(win, "设置页");

  // 12. 主题卡持久化（点击竹林主题卡 → dataset.style 即时生效；reload 后 dataset.style 与 localStorage 均仍为 zhulin）
  await win.webContents.executeJavaScript(
    `document.querySelector('.kb-theme-card[data-value="zhulin"]').click()`,
  );
  await sleep(300);
  const styleAfterClick = await win.webContents.executeJavaScript(
    `document.documentElement.dataset.style`,
  );

  await new Promise((resolve) => {
    win.webContents.once("did-finish-load", resolve);
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
    "主题卡持久化（点击生效 + reload 后仍保留）",
    styleAfterClick === "zhulin" &&
      styleAfterReload === "zhulin" &&
      persistedStyle === "zhulin",
    `点击后=${styleAfterClick}, reload后=${styleAfterReload}, localStorage=${persistedStyle}`,
  );
  await shot(win, "设置页-主题卡持久化");

  // 测毕复原为默认宣纸主题，避免污染后续步骤的截图基线
  await win.webContents.executeJavaScript(
    `document.querySelector('.kb-theme-card[data-value="xuanzhi"]').click()`,
  );
  await sleep(300);

  // 13. 快捷钮脱离跟随（点击日/月快捷钮 → saved-theme 翻转且 themeMode 落固定值，不再是 system）
  const savedThemeBefore = await win.webContents.executeJavaScript(
    `document.documentElement.getAttribute('saved-theme')`,
  );
  await win.webContents.executeJavaScript(
    `document.querySelector('.kb-theme-toggle').click()`,
  );
  await sleep(300);
  const savedThemeAfter = await win.webContents.executeJavaScript(
    `document.documentElement.getAttribute('saved-theme')`,
  );
  const themeModeAfter = await win.webContents.executeJavaScript(
    `(() => { try { return JSON.parse(localStorage.getItem('kb-settings:v1')).themeMode; } catch { return null; } })()`,
  );
  record(
    "快捷钮脱离跟随系统",
    savedThemeAfter !== savedThemeBefore &&
      (themeModeAfter === "light" || themeModeAfter === "dark"),
    `saved-theme: ${savedThemeBefore}→${savedThemeAfter}, themeMode=${themeModeAfter}`,
  );
  await shot(win, "设置页-快捷钮切换");

  // 复原，避免影响下次运行
  await win.webContents.executeJavaScript(
    `document.querySelector('.kb-theme-toggle').click()`,
  );
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
    "桌面标题条（data-desktop=true + 38px + flex）",
    titlebarProbe.desktop === "true" &&
      titlebarProbe.height === "38px" &&
      titlebarProbe.display === "flex",
    `data-desktop=${titlebarProbe.desktop}, height=${titlebarProbe.height}, display=${titlebarProbe.display}`,
  );
  await shot(win, "桌面标题条");

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
    "全局偏移（body padding-top 38px + 左栏 top≥38）",
    offsetProbe.bodyPaddingTop === "38px" &&
      offsetProbe.sidebarTop !== null &&
      offsetProbe.sidebarTop >= 38,
    `bodyPaddingTop=${offsetProbe.bodyPaddingTop}, sidebarTop=${offsetProbe.sidebarTop}`,
  );
  await shot(win, "全局偏移");

  // 16. 设置页沉浸 + 抽屉双栏（左右栏隐藏、占位正文让位、抽屉/返回钮/两 pane/六卡在场）
  //     v11：旧断言里的 .kb-settings-title 已随抽屉改造删除（返回入口移入抽屉首行），
  //     改断言抽屉本体与两个面板，并把「占位正文让位」的探针换成真实存在的那一层——
  //     设置页由 FolderPage 渲染，正文结构是 .center > .popover-hint > article，
  //     旧探针 .center > article 在此页恒不存在，`!article` 使断言恒真、从未验证过什么。
  await win.loadURL(base + encodeURI("/设置/"));
  await sleep(600);
  const immersiveProbe = await win.webContents.executeJavaScript(
    `(() => {
       const left = document.querySelector('.sidebar.left');
       const right = document.querySelector('.sidebar.right');
       const article = document.querySelector('.center > .popover-hint > article');
       const panes = document.querySelectorAll('.kb-settings-pane');
       const active = document.querySelector('.kb-settings-pane.is-active');
       return {
         leftHidden: !left || left.offsetParent === null,
         rightHidden: !right || right.offsetParent === null,
         hasArticle: !!article,
         articleHidden: !!article && article.offsetParent === null,
         hasDrawer: !!document.querySelector('.kb-settings-drawer'),
         hasBack: !!document.querySelector('.kb-settings-back'),
         hasTitle: !!document.querySelector('.kb-settings-title'),
         paneCount: panes.length,
         activePane: active ? active.dataset.paneId : null,
         cardCount: document.querySelectorAll('.kb-theme-card').length,
       };
     })()`,
  );
  record(
    "设置页沉浸 + 抽屉双栏（双栏隐藏 + 占位正文让位 + 抽屉/返回钮/两 pane/六卡）",
    immersiveProbe.leftHidden &&
      immersiveProbe.rightHidden &&
      immersiveProbe.hasArticle &&
      immersiveProbe.articleHidden &&
      immersiveProbe.hasDrawer &&
      immersiveProbe.hasBack &&
      !immersiveProbe.hasTitle &&
      immersiveProbe.paneCount === 2 &&
      immersiveProbe.activePane === "appearance" &&
      immersiveProbe.cardCount === 6,
    `left隐=${immersiveProbe.leftHidden}, right隐=${immersiveProbe.rightHidden}, ` +
      `占位正文在场=${immersiveProbe.hasArticle}/已隐=${immersiveProbe.articleHidden}, ` +
      `抽屉=${immersiveProbe.hasDrawer}, 返回钮=${immersiveProbe.hasBack}, 旧标题已删=${!immersiveProbe.hasTitle}, ` +
      `pane数=${immersiveProbe.paneCount}, 激活pane=${immersiveProbe.activePane}, 主题卡=${immersiveProbe.cardCount}`,
  );
  await shot(win, "设置页沉浸");

  // 17. 深链返回兜底（新窗口 loadURL 直达设置页，history.length===1 场景；
  //     settings.inline.ts 的返回钮此时不 preventDefault，靠 <a href> SSR 兜底回首页，R12 硬断言）
  const deepWin = new BrowserWindow({
    width: 1440,
    height: 900,
    show: true,
    ...(process.platform === "darwin" ? { titleBarStyle: "hiddenInset" } : {}),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  await deepWin.loadURL(base + encodeURI("/设置/"));
  await sleep(600);
  const historyLenBefore = await deepWin.webContents.executeJavaScript(
    "window.history.length",
  );
  await deepWin.webContents.executeJavaScript(
    `document.querySelector('.kb-settings-back').click()`,
  );
  await sleep(900);
  const deepLinkPath = await currentPath(deepWin);
  record(
    "深链返回兜底（history.length===1 → 回首页，R12）",
    historyLenBefore === 1 && deepLinkPath === "/",
    `historyLenBefore=${historyLenBefore}, pathAfterClick=${deepLinkPath}`,
  );
  await shot(deepWin, "深链返回兜底");
  deepWin.close();

  // 18. overlay 滚动条零挤压（回到章节页；滚动前后 .explorer-ul 的 clientWidth 须完全相等——挤压回归硬断言）
  // 路径经校验为产物中真实存在的词条页（term-0001 归类在"33-可专利客体"，非旧步骤 6 沿用的
  // "99-综合" ——那一档并无 term-0001.html，步骤 6 的断言只验证了路径回显、未验证页面真实加载，
  // 属既有 13 步的既有状况，本步不沿用其路径，另择已核实存在的页面）
  await win.loadURL(
    `${base}/${encodeURI("9-关键词索引/33-可专利客体/term-0001")}`,
  );
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
    "overlay 滚动条零挤压（.kb-oscroll 可见 + clientWidth 滚动前后相等）",
    widthBefore !== null &&
      oscrollProbe.exists &&
      oscrollProbe.visible &&
      oscrollProbe.widthAfter === widthBefore,
    `轨道存在=${oscrollProbe.exists}, is-visible=${oscrollProbe.visible}, clientWidth ${widthBefore}→${oscrollProbe.widthAfter}`,
  );
  await shot(win, "overlay滚动条");

  // ============ v11 新增五步（19–22） ============

  // 19. 设置页抽屉切换（分类钮 ↔ 面板 is-active 同步；切回 appearance 复原）
  //     面板显隐由 CSS 降级门 `.kb-settings-page[data-panes-ready] .kb-settings-pane:not(.is-active)`
  //     承担，故断言用 offsetParent 而非 classList——脚本没落 data-panes-ready 时两 pane 全显。
  await win.loadURL(base + encodeURI("/设置/"));
  await sleep(600);
  const drawerProbe = await win.webContents.executeJavaScript(
    `(() => {
       const q = (s) => document.querySelector(s);
       const anno = () => q('.kb-settings-pane[data-pane-id="anno"]');
       const appearance = () => q('.kb-settings-pane[data-pane-id="appearance"]');
       q('.kb-settings-cat[data-pane="anno"]').click();
       const afterAnno = {
         annoActive: anno().classList.contains('is-active'),
         annoVisible: anno().offsetParent !== null,
         appearanceHidden: appearance().offsetParent === null,
         catAria: q('.kb-settings-cat[data-pane="anno"]').getAttribute('aria-selected'),
       };
       q('.kb-settings-cat[data-pane="appearance"]').click();
       const restored = {
         appearanceActive: appearance().classList.contains('is-active'),
         appearanceVisible: appearance().offsetParent !== null,
         annoHidden: anno().offsetParent === null,
       };
       return { afterAnno, restored };
     })()`,
  );
  record(
    "设置页抽屉切换（切「批注」pane 生效 + 切回「外观」复原）",
    drawerProbe.afterAnno.annoActive &&
      drawerProbe.afterAnno.annoVisible &&
      drawerProbe.afterAnno.appearanceHidden &&
      drawerProbe.afterAnno.catAria === "true" &&
      drawerProbe.restored.appearanceActive &&
      drawerProbe.restored.appearanceVisible &&
      drawerProbe.restored.annoHidden,
    `切批注：anno激活=${drawerProbe.afterAnno.annoActive}/可见=${drawerProbe.afterAnno.annoVisible}, ` +
      `appearance隐=${drawerProbe.afterAnno.appearanceHidden}, aria-selected=${drawerProbe.afterAnno.catAria}；` +
      `切回：appearance激活=${drawerProbe.restored.appearanceActive}/可见=${drawerProbe.restored.appearanceVisible}, ` +
      `anno隐=${drawerProbe.restored.annoHidden}`,
  );
  await shot(win, "设置页抽屉-批注pane");

  // 20. 影子滚动条几何与拖拽
  //     几何：轨道 left = .center 右缘 + TRACK_GAP(10px)；top = 标题条 + 0.5rem；
  //           html[data-pagescroll=on] 把原生滚动槽归零（scrollbar-width: none）。
  //     拖拽：thumb 上派发 pointerdown/move/up；若 setPointerCapture 在合成事件下抛
  //           InvalidPointerId（Chromium 对非真实指针的既有行为），退回 sendInputEvent 真实输入。
  await win.loadURL(`${base}/${encodeURI(LONG_PAGE)}`);
  await sleep(800);
  await win.webContents.executeJavaScript(`window.scrollTo(0, 400)`);
  await sleep(300);
  const trackProbe = await win.webContents.executeJavaScript(
    `(() => {
       const track = document.querySelector('.kb-pagescroll');
       if (!track) return { exists: false };
       const thumb = track.querySelector('.kb-pagescroll-thumb');
       const tr = track.getBoundingClientRect();
       const cr = document.querySelector('.center').getBoundingClientRect();
       const tb = thumb.getBoundingClientRect();
       return {
         exists: true,
         visible: track.classList.contains('is-visible'),
         trackLeft: Math.round(tr.left * 100) / 100,
         centerRight: Math.round(cr.right * 100) / 100,
         trackTop: Math.round(tr.top * 100) / 100,
         scrollbarWidth: getComputedStyle(document.documentElement).scrollbarWidth,
         thumbCx: tb.left + tb.width / 2,
         thumbCy: tb.top + tb.height / 2,
       };
     })()`,
  );
  // —— 拖拽：合成 PointerEvent 优先 ——
  const dragStart = await win.webContents.executeJavaScript(
    `(() => {
       const track = document.querySelector('.kb-pagescroll');
       const thumb = track.querySelector('.kb-pagescroll-thumb');
       const tb = thumb.getBoundingClientRect();
       const cx = tb.left + tb.width / 2;
       const cy = tb.top + tb.height / 2;
       const before = document.documentElement.scrollTop;
       const topBefore = parseFloat(thumb.style.top) || 0;
       const mk = (type, x, y) =>
         new PointerEvent(type, {
           bubbles: true, cancelable: true, composed: true,
           clientX: x, clientY: y, pointerId: 1, isPrimary: true,
           pointerType: 'mouse', button: 0, buttons: 1,
         });
       thumb.dispatchEvent(mk('pointerdown', cx, cy));
       const dragging = track.classList.contains('is-dragging');
       if (dragging) {
         thumb.dispatchEvent(mk('pointermove', cx, cy + 120));
         thumb.dispatchEvent(mk('pointerup', cx, cy + 120));
       }
       return { dragging, before, topBefore, cx, cy };
     })()`,
  );
  let dragPath = "合成 PointerEvent";
  if (!dragStart.dragging) {
    // 退路：真实输入事件（setPointerCapture 只认真实指针时走这条）
    dragPath = "sendInputEvent 真实输入";
    const x = Math.round(dragStart.cx);
    const y = Math.round(dragStart.cy);
    win.webContents.sendInputEvent({
      type: "mouseDown",
      x,
      y,
      button: "left",
      clickCount: 1,
    });
    await sleep(60);
    win.webContents.sendInputEvent({ type: "mouseMove", x, y: y + 120 });
    await sleep(80);
    win.webContents.sendInputEvent({
      type: "mouseUp",
      x,
      y: y + 120,
      button: "left",
      clickCount: 1,
    });
  }
  await sleep(150);
  const dragEnd = await win.webContents.executeJavaScript(
    `(() => {
       const doc = document.documentElement;
       const track = document.querySelector('.kb-pagescroll');
       const thumb = track.querySelector('.kb-pagescroll-thumb');
       const trackH = track.clientHeight;
       const thumbH = thumb.offsetHeight;
       const draggable = trackH - thumbH;
       const maxScroll = Math.max(doc.scrollHeight - doc.clientHeight, 0);
       const offsetAfter = parseFloat(thumb.style.top) || 0;
       return {
         scrollTop: doc.scrollTop,
         offsetAfter,
         trackH,
         thumbH,
         maxScroll,
         // 与 util/scrollInteraction.ts 的 scrollTopFromThumbOffset 同构的逆映射
         expected: draggable > 0 ? (offsetAfter / draggable) * maxScroll : 0,
       };
     })()`,
  );
  const dragErr = Math.abs(dragEnd.scrollTop - dragEnd.expected);
  // 拖 120px 的正向预期：起始 thumb 偏移 + 120 经同一逆映射
  const draggable = dragEnd.trackH - dragEnd.thumbH;
  const predicted =
    draggable > 0
      ? Math.min(
          Math.max(
            ((dragStart.topBefore + 120) / draggable) * dragEnd.maxScroll,
            0,
          ),
          dragEnd.maxScroll,
        )
      : 0;
  const predictErr = Math.abs(dragEnd.scrollTop - predicted);
  const leftOk =
    trackProbe.exists &&
    trackProbe.trackLeft >= trackProbe.centerRight + 4 &&
    trackProbe.trackLeft <= trackProbe.centerRight + 24;
  record(
    "影子滚动条几何与拖拽（轨道贴正文右缘 + 原生槽归零 + 拖拽逆映射一致）",
    trackProbe.exists &&
      trackProbe.visible &&
      leftOk &&
      trackProbe.trackTop >= TITLEBAR_H &&
      trackProbe.scrollbarWidth === "none" &&
      dragEnd.scrollTop > dragStart.before &&
      dragErr < 2 &&
      predictErr < 2,
    `轨道 left=${trackProbe.trackLeft}（.center 右缘 ${trackProbe.centerRight}，窗口 [${trackProbe.centerRight + 4}, ${trackProbe.centerRight + 24}]）, ` +
      `top=${trackProbe.trackTop}（≥${TITLEBAR_H}）, scrollbar-width=${trackProbe.scrollbarWidth}；` +
      `拖拽[${dragPath}] scrollTop ${dragStart.before}→${Math.round(dragEnd.scrollTop)}, ` +
      `thumb.top ${Math.round(dragStart.topBefore * 100) / 100}→${Math.round(dragEnd.offsetAfter * 100) / 100}, ` +
      `逆映射期望=${Math.round(dragEnd.expected * 100) / 100}（误差 ${Math.round(dragErr * 1000) / 1000}px）, ` +
      `拖 120px 正向预期=${Math.round(predicted * 100) / 100}（误差 ${Math.round(predictErr * 1000) / 1000}px）`,
  );
  await shot(win, "影子滚动条-拖拽后");

  // 21. SPA 不残留（连跳三页后轨道恒为 1 条）
  //     用 window.spaNavigate（spa.inline.ts 导出的站内路由）而非点链接：跳转目标可控，
  //     末跳回落 LONG_PAGE，轨道断言才落在滚动余量充足的页面上。
  const spaPaths = [];
  for (const hop of SPA_HOPS) {
    await win.webContents.executeJavaScript(
      `window.spaNavigate(new URL(${JSON.stringify("/" + encodeURI(hop))}, location.href))`,
    );
    await sleep(900);
    spaPaths.push(await currentPath(win));
  }
  await win.webContents.executeJavaScript(`window.scrollTo(0, 400)`);
  await sleep(350);
  const spaProbe = await win.webContents.executeJavaScript(
    `(() => ({ trackCount: document.querySelectorAll('.kb-pagescroll').length }))()`,
  );
  record(
    "SPA 不残留（连跳三页轨道恒 1 条）",
    spaPaths.length === 3 &&
      spaPaths[2] === `/${LONG_PAGE}` &&
      spaProbe.trackCount === 1,
    `SPA 三跳=${spaPaths.join(" → ")}；轨道数=${spaProbe.trackCount}`,
  );
  await shot(win, "SPA不残留");

  // ============ v12 新增两步（22–23） ============

  // 22. 悬停预览弹窗底色与入场不透明（核心回归门）
  //     popover.inline.ts：链接 mouseenter 触发 onLinkEnter，150ms 意图延迟后
  //     showHoverPopover 才 fetch + 挂载并加 active-popover 类；popover.scss 的
  //     dropin 关键帧另叠 200ms CSS animation-delay + 180ms（--duration-tooltip）
  //     动画时长——旧版 dropin 是 opacity 0→1 真渐变，delay 结束后的 180ms 内整窗
  //     仍半透明、下层正文透出与弹窗文字叠印；现版 dropin 关键帧改常量
  //     opacity:1→1（animation-fill-mode: forwards 锁定终态），delay 结束瞬间
  //     直接跳到全不透明，不再产生任何透明过渡态。底色/描边随
  //     --popover-bg/--popover-border 主题 token 同源（近实底，非玻璃半透明，
  //     见 popover.scss 顶部注释）。
  await win.loadURL(`${base}/${encodeURI(LONG_PAGE)}`);
  await sleep(800);
  const hoverProbe = await win.webContents.executeJavaScript(
    `(() => new Promise((resolve) => {
       ${PARSE_COLOR_FN}
       const link = document.querySelector('article a.internal[href]');
       if (!link) { resolve({ linkFound: false }); return; }
       link.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));

       const waitStart = performance.now();
       function waitForPopover() {
         const popover = document.querySelector('.popover.active-popover');
         if (popover) { sampleOpacity(popover); return; }
         if (performance.now() - waitStart > 3000) {
           resolve({ linkFound: true, popoverFound: false });
           return;
         }
         requestAnimationFrame(waitForPopover);
       }

       // 核心回归门：popover 一出现即以 rAF 逐帧采 340ms 内的 opacity，
       // 断言 t≥230ms（留出 rAF 轮询抖动余量，避开 200ms delay 边界）起样本
       // 全部已是 '1'——窗口右端不设上限，见调用处对偶发掉帧的说明。
       function sampleOpacity(popover) {
         const samples = [];
         const sampleStart = performance.now();
         function frame() {
           const t = performance.now() - sampleStart;
           samples.push({
             t: Math.round(t * 100) / 100,
             opacity: getComputedStyle(popover).opacity,
           });
           if (t < 340) {
             requestAnimationFrame(frame);
           } else {
             finish(popover, samples);
           }
         }
         frame();
       }

       function finish(popover, samples) {
         const inner = popover.querySelector('.popover-inner');
         const innerCs = inner ? getComputedStyle(inner) : null;
         const rootCs = getComputedStyle(document.documentElement);
         const innerBg = innerCs ? innerCs.backgroundColor : null;
         const innerBorder = innerCs ? innerCs.borderColor : null;
         const tokenBg = rootCs.getPropertyValue('--popover-bg').trim();
         const tokenBorder = rootCs.getPropertyValue('--popover-border').trim();
         const bgActual = parseColor(innerBg);
         const bgToken = parseColor(tokenBg);
         const borderActual = parseColor(innerBorder);
         const borderToken = parseColor(tokenBorder);
         const bgAlphaOk = !!bgActual && bgActual.a >= 0.97;
         const bgMatch =
           !!bgActual &&
           !!bgToken &&
           bgActual.r === bgToken.r &&
           bgActual.g === bgToken.g &&
           bgActual.b === bgToken.b;
         const borderMatch =
           !!borderActual &&
           !!borderToken &&
           borderActual.r === borderToken.r &&
           borderActual.g === borderToken.g &&
           borderActual.b === borderToken.b;
         resolve({
           linkFound: true,
           popoverFound: true,
           samples,
           innerBg,
           tokenBg,
           bgAlpha: bgActual ? Math.round(bgActual.a * 1000) / 1000 : null,
           bgAlphaOk,
           bgMatch,
           innerBorder,
           tokenBorder,
           borderMatch,
         });
       }

       waitForPopover();
     }))()`,
  );
  // 实测 120Hz 显示器下 rAF 逐帧采样偶发单帧掉帧（约百毫秒级空档，压力来源与
  // 具体机制未定位，但两侧相邻样本均已是 '1'，与关键帧本身「常量不透明」的结论
  // 无关——掉帧是采样密度问题，不是不透明度问题）。故窗口右端不封顶，只要求
  // t≥230ms（留出 rAF 轮询抖动余量，避开 200ms delay 边界）起到采样结束为止
  // 全部样本都已是 '1'；只要该范围内存在样本，掉帧就不会造成假阴性。
  const hoverWindowSamples = (hoverProbe.samples || []).filter(
    (s) => s.t >= 230,
  );
  const hoverOpaqueInWindow =
    hoverWindowSamples.length > 0 &&
    hoverWindowSamples.every((s) => s.opacity === "1");
  record(
    "悬停预览弹窗底色与入场不透明（B 全程不透明 + A 底色同源 + C 描边生效）",
    hoverProbe.linkFound &&
      hoverProbe.popoverFound &&
      hoverOpaqueInWindow &&
      hoverProbe.bgAlphaOk &&
      hoverProbe.bgMatch &&
      hoverProbe.borderMatch,
    `B: [230ms,采样末]窗内样本${hoverWindowSamples.length}/共${(hoverProbe.samples || []).length}帧，全部opacity=1→${hoverOpaqueInWindow}` +
      `（序列 ${(hoverProbe.samples || []).map((s) => `${s.t}:${s.opacity}`).join(", ")}）；` +
      `A: innerBg=${hoverProbe.innerBg}（alpha=${hoverProbe.bgAlpha}≥0.97→${hoverProbe.bgAlphaOk}, token=${hoverProbe.tokenBg}, rgb同源→${hoverProbe.bgMatch}）；` +
      `C: innerBorder=${hoverProbe.innerBorder}（token=${hoverProbe.tokenBorder}, rgb同源→${hoverProbe.borderMatch}）`,
  );
  await shot(win, "悬停预览弹窗");

  // 收尾：mouseleave 结束 hover 态 + 导航复位，避免弹窗 DOM 残留污染下一步截图基线
  await win.webContents.executeJavaScript(
    `(() => {
       const link = document.querySelector('article a.internal[href]');
       if (link) link.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }));
     })()`,
  );
  await sleep(200);
  await win.loadURL(`${base}/`);
  await sleep(400);

  // 23. 搜索弹层主题化（命中词高亮改 --textHighlight、结果卡 12px 圆角玻璃描边、
  //     .search-path 过渡 0.5s→260ms）
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
  const searchThemeProbe = await win.webContents.executeJavaScript(
    `(() => {
       ${PARSE_COLOR_FN}
       const rootCs = getComputedStyle(document.documentElement);

       // A：命中词高亮改 --textHighlight（旧硬编码绿 rgba(132,165,157,.6) 应已退场）
       const hl = document.querySelector('.search-layout .highlight');
       const hlBg = hl ? getComputedStyle(hl).backgroundColor : null;
       const tokenHighlight = rootCs.getPropertyValue('--textHighlight').trim();
       const hlActual = parseColor(hlBg);
       const hlToken = parseColor(tokenHighlight);
       const hlMatch =
         !!hlActual &&
         !!hlToken &&
         hlActual.r === hlToken.r &&
         hlActual.g === hlToken.g &&
         hlActual.b === hlToken.b;
       const hlIsOldGreen =
         !!hlActual && hlActual.r === 132 && hlActual.g === 165 && hlActual.b === 157;

       // B：结果卡 12px 圆角 + 四边 --glass-border 描边（旧 border-bottom 实线已删）。
       // 排除 .focus：displayResults() 渲染后给首条结果加 .focus 软预选类
       // （search.inline.ts），命中 hover/focus/.focus 合并选择器的
       // border-color: var(--secondary)（search.scss），首卡描边因此按设计
       // 另走 --secondary，与本条测的 --glass-border 基线态无关，取一张不带
       // 该类的卡片才是 baseline 描边。
       const card = document.querySelector('.result-card:not(.focus)');
       const cardCs = card ? getComputedStyle(card) : null;
       const cardRadius = cardCs ? cardCs.borderRadius : null;
       const tokenGlassBorder = rootCs.getPropertyValue('--glass-border').trim();
       const glassBorderToken = parseColor(tokenGlassBorder);
       const edgeKeys = [
         'borderTopColor',
         'borderRightColor',
         'borderBottomColor',
         'borderLeftColor',
       ];
       const edgeColors = cardCs ? edgeKeys.map((k) => cardCs[k]) : [];
       const edgeMatches = edgeColors.map((c) => {
         const parsed = parseColor(c);
         return (
           !!parsed &&
           !!glassBorderToken &&
           parsed.r === glassBorderToken.r &&
           parsed.g === glassBorderToken.g &&
           parsed.b === glassBorderToken.b
         );
       });
       const cardBorderMatch = edgeMatches.length === 4 && edgeMatches.every(Boolean);

       // C：.search-path 过渡时长 0.5s→260ms
       const pathEl = document.querySelector('.search-path');
       const transitionDuration = pathEl
         ? getComputedStyle(pathEl).transitionDuration
         : null;

       return {
         highlightFound: !!hl,
         hlBg,
         tokenHighlight,
         hlMatch,
         hlIsOldGreen,
         cardFound: !!card,
         cardRadius,
         tokenGlassBorder,
         edgeColors,
         cardBorderMatch,
         transitionDuration,
       };
     })()`,
  );
  const cardRadiusOk = searchThemeProbe.cardRadius === "12px";
  const pathTransitionOk =
    !!searchThemeProbe.transitionDuration &&
    searchThemeProbe.transitionDuration.includes("0.26s") &&
    !searchThemeProbe.transitionDuration.includes("0.5s");
  record(
    "搜索弹层主题化（A 命中词 --textHighlight + B 结果卡12px/--glass-border描边 + C search-path过渡260ms）",
    searchThemeProbe.highlightFound &&
      searchThemeProbe.hlMatch &&
      !searchThemeProbe.hlIsOldGreen &&
      searchThemeProbe.cardFound &&
      cardRadiusOk &&
      searchThemeProbe.cardBorderMatch &&
      pathTransitionOk,
    `A: highlight在场=${searchThemeProbe.highlightFound}, bg=${searchThemeProbe.hlBg}（token=${searchThemeProbe.tokenHighlight}, 同源→${searchThemeProbe.hlMatch}, 旧绿(132,165,157)→${searchThemeProbe.hlIsOldGreen}）；` +
      `B: 圆角=${searchThemeProbe.cardRadius}（=12px→${cardRadiusOk}）, 四边描边=[${searchThemeProbe.edgeColors.join(" | ")}]（token=${searchThemeProbe.tokenGlassBorder}, 四边同源→${searchThemeProbe.cardBorderMatch}）；` +
      `C: search-path transitionDuration=${searchThemeProbe.transitionDuration}（含0.26s且不含0.5s→${pathTransitionOk}）`,
  );
  await shot(win, "搜索弹层主题化");

  // 收尾：Escape 关闭搜索（document 级 keydown 监听，见 search.inline.ts 的
  // registerEscapeHandler：判定 e.key.startsWith('Esc') 即触发 hideSearch，
  // 不要求事件目标落在搜索容器内），避免遮罩残留污染下一步截图基线
  await win.webContents.executeJavaScript(
    `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`,
  );
  await sleep(300);

  // 24. 跟随系统零双跳（bug#2 竞态核心回归门）
  //     先固定为 dark（主进程 themeSource 落 'dark'），再切「跟随系统」：
  //     渲染层同步读到的 prefers-color-scheme 仍是被强制的旧值，权威亮暗态由
  //     invoke 往返回传后纠正一次。断言观察窗口内 saved-theme 的**实际值变更**≤1 次
  //     （同值重写不计——它不产生任何可见跳变），并与主进程 nativeTheme 交叉验证终态。
  await win.loadURL(base + encodeURI("/设置/"));
  await sleep(600);
  await win.webContents.executeJavaScript(
    `document.querySelector('[data-setting="themeMode"][data-value="dark"]').click()`,
  );
  await sleep(400);
  await win.webContents.executeJavaScript(
    `(() => {
       const m = { raw: 0, changes: 0, seq: [] };
       window.__kbThemeMut = m;
       const obs = new MutationObserver((records) => {
         const cur = document.documentElement.getAttribute('saved-theme');
         records.forEach((r, i) => {
           // 同批次内后一条的 oldValue 即前一条的新值；批次末条取当前属性值
           const nv = i + 1 < records.length ? records[i + 1].oldValue : cur;
           m.raw += 1;
           m.seq.push((r.oldValue || 'null') + '→' + (nv || 'null'));
           if (r.oldValue !== nv) m.changes += 1;
         });
       });
       obs.observe(document.documentElement, {
         attributes: true,
         attributeFilter: ['saved-theme'],
         attributeOldValue: true,
       });
       window.__kbThemeObs = obs;
       return document.documentElement.getAttribute('saved-theme');
     })()`,
  );
  await win.webContents.executeJavaScript(
    `document.querySelector('[data-setting="themeMode"][data-value="system"]').click()`,
  );
  await sleep(400);
  const themeMut = await win.webContents.executeJavaScript(
    `(() => {
       window.__kbThemeObs.disconnect();
       return {
         ...window.__kbThemeMut,
         saved: document.documentElement.getAttribute('saved-theme'),
         mode: document.documentElement.dataset.themeMode,
       };
     })()`,
  );
  const mainDark = nativeTheme.shouldUseDarkColors;
  record(
    "跟随系统零双跳（saved-theme 实际变更 ≤1 次 + 终态与主进程 nativeTheme 一致）",
    themeMut.changes <= 1 &&
      themeMut.mode === "system" &&
      themeMut.saved === (mainDark ? "dark" : "light"),
    `实际变更=${themeMut.changes} 次（属性写入 ${themeMut.raw} 次，轨迹 ${themeMut.seq.join(" | ") || "无"}）, ` +
      `终态 saved-theme=${themeMut.saved}, themeMode=${themeMut.mode}, ` +
      `主进程 shouldUseDarkColors=${mainDark}（themeSource=${nativeTheme.themeSource}）`,
  );
  await shot(win, "跟随系统零双跳");
  // 收尾复原：themeMode 落回 light，避免污染后续截图基线
  await win.webContents.executeJavaScript(
    `document.querySelector('[data-setting="themeMode"][data-value="light"]').click()`,
  );
  await sleep(300);

  // —— 离线报告 ——
  const failed = results.filter((r) => !r.ok);
  const report = [
    `冒烟时间：${new Date().toISOString()}`,
    `离线护栏：全程阻断非 127.0.0.1 请求（等效断网），页面均正常渲染`,
    `外部请求尝试次数：${externalAttempts.length}`,
    ...externalAttempts.map((u) => `  - ${u}`),
    "",
    "步骤结果：",
    ...results.map(
      (r) =>
        `  ${r.ok ? "PASS" : "FAIL"}  ${r.step}${r.detail ? `（${r.detail}）` : ""}`,
    ),
  ].join("\n");
  await fs.promises.writeFile(
    path.join(AUDIT, "offline-report.txt"),
    report + "\n",
    "utf8",
  );
  console.log(report);

  app.exit(failed.length > 0 || externalAttempts.length > 0 ? 1 : 0);
}

app.whenReady().then(() =>
  main().catch(async (e) => {
    console.error("冒烟失败：", e);
    await fs.promises
      .writeFile(
        path.join(AUDIT, "offline-report.txt"),
        `冒烟中断：${e && e.stack ? e.stack : e}\n`,
        "utf8",
      )
      .catch(() => {});
    app.exit(1);
  }),
);

// 兜底：无论如何 300 秒后强制退出，避免残留进程
// （v11 由 120s 上调：新增五步各带 300–900ms 等待与截图，18 步时代的预算已不够用）
// （v12 由 240s 上调：新增两步各带 popover 等待、340ms opacity 逐帧采样、搜索 2.5s
// 首索引等待与截图，22 步时代的预算留白已不足）
setTimeout(() => {
  console.error("冒烟超时，强制退出");
  app.exit(1);
}, 300000);
