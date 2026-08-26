// shots.cjs —— 产品展示截图生成（node shots.cjs / npx electron shots.cjs）
//
// 与 smoke.cjs 的关系：机制同源、目的相反。
//   smoke.cjs 是审计工具——截图只作断言失败时的旁证，落 ./audit/，尺寸与状态服务于测试；
//   shots.cjs 是宣传物料——截图本身是产物，落 ../docs/screenshots/，供 README 图文引用。
// 因此本脚本复用 smoke 已验证的四套机制，不另起炉灶：
//   1. 本地静态服务 startStaticServer(DIST, { port: 0 })；显式随机端口的理由与 smoke 相同，
//      且在本脚本更关键——固定端口 47821 与正在运行的应用同源，第 6/7 张要预置的演示批注
//      会直接写进用户真实的 localStorage 桶。随机端口每次都是干净空桶，既不污染用户数据，
//      也保证截图不受用户既有主题/批注影响，重复运行构图恒定。
//   2. 建窗配置：1440×900（与 main.cjs 的生产建窗同尺寸）+ titleBarStyle:'hiddenInset'（仅
//      darwin）。平台门控不可省：缺了它渲染层自绘的 .kb-titlebar 会与系统原生标题栏双重叠加。
//   3. capturePage 的三次重试——多 Electron 实例连跑时偶发瞬时 UnknownVizError（GPU 进程竞态）。
//   4. 页面就绪等待：一律轮询「该页特有的 DOM 条件」直到成立（smoke 对图谱页的做法），
//      不用裸 setTimeout 撞运气；力导布局与入场动画另加一段固定沉降时间。
//
// 产物：每张 capturePage 得到 2880×1800（Retina 2x），随即 sips -Z 900 等比压到宽 900px，
// 控制仓库体积。同名覆盖，脚本可重复运行。
const path = require("path");

// —— 纯 node 启动时自举为 Electron 进程 ——
// require('electron') 在 node 下返回可执行文件路径、在 Electron 下返回 API 对象，
// 据此分流。目的是让 `node desktop/shots.cjs` 直接可用，无需调用方记住 npx electron。
if (!process.versions.electron) {
  const { spawnSync } = require("child_process");
  const electronPath = require("electron");
  const r = spawnSync(electronPath, [__filename, ...process.argv.slice(2)], {
    stdio: "inherit",
  });
  process.exit(r.status === null ? 1 : r.status);
}

const {
  app,
  BrowserWindow,
  ipcMain,
  nativeTheme,
} = require("electron");
const fs = require("fs");
const { execFileSync } = require("child_process");
const { startStaticServer } = require("./server.cjs");

const DIST = path.join(__dirname, "..", "quartz-kb", "public");
const OUT = path.join(__dirname, "..", "docs", "screenshots");

// README 展示宽度。GitHub 正文栏约 900px 宽，图片默认铺满，再大只是徒增仓库体积
const SHOT_WIDTH = 900;

// 展示用页面。第 2/9 张同页（明暗对照），第 6/7 张同页（批注前后）
const CHAPTER = "3-专利审查指南/2-实质审查/2-说明书和权利要求书/02-02-02-02";
// 词条页取「先用权」：释义 / 出处 / 相关法条 / 相关术语 四节俱全且首屏可一次看全
// （多数长词条的「出处」列表就占满一屏，另两节落在折线以下，展示效果反而不完整）
const TERM = "9-关键词索引/99-综合/term-0210";
const ANNO_PAGE = "1-专利法/2-授予专利权的条件/law-02-01";
// 检索关键词：命中要跨书、标题要彼此有区分度。实测比较过四个候选——
// 「新颖性」「创造性」命中最多，但前几条里连着三个页面同名（词条页、指南章节目录页、
// 索引分组页），结果列表看上去像重复渲染；「权利要求」命中页标题过长，三行一条撑满列表；
// 「抵触申请」命中横跨指南初审/实审/检索、答复指引与关键词索引，标题长短适中且各异。
const SEARCH_QUERY = "抵触申请";

// 力导布局沉降时间。局部图节点少、收敛快；全库图 2000+ 节点需要更久
const SETTLE_LOCAL_GRAPH = 2200;
const SETTLE_GLOBAL_GRAPH = 5000;

// —— 主题 IPC 桩：与 main.cjs 的 'apply-theme-source' 同协议，但**不写盘** ——
// 本脚本不加载 main.cjs，故 preload 暴露的 applyThemeSource 若无 handler 会直接 reject。
// 第 9 张要切深色，settings.inline.ts 正是经这条 invoke 拿主进程的权威亮暗态；缺了它
// 渲染层只能走降级路径，且每次点击都留下一条未处理的 rejection。
// window-state 落盘刻意不复制，避免生成截图污染用户的窗口状态文件。
const THEME_MODES = ["light", "dark", "system"];
ipcMain.handle("apply-theme-source", (_event, payload) => {
  const mode =
    payload && THEME_MODES.includes(payload.mode) ? payload.mode : null;
  if (mode) nativeTheme.themeSource = mode;
  return { dark: nativeTheme.shouldUseDarkColors };
});

// —— MCP 信息 IPC 桩：与 smoke.cjs 的 MCP_STUB 同构，路径取值相反 ——
// 桩本身是必需的：本脚本不加载 main.cjs，真 handler 缺席时 initMcpPanel 的 invoke 直接
// reject，[data-mcp-block] 保持 hidden，第 10 张只会截到「当前环境未检测到该服务」。
// 路径取值则与 smoke 分道：smoke 用 /tmp/smoke-mcp/ 这类明假路径，图的是断言不随机器漂移；
// 本脚本产出的是给人看的物料，故取「把 dmg 拖进应用程序文件夹后」的标准路径——它对读者
// 才是可照抄的那一份，同时避开了真 handler 在开发形态下会暴露的 /Users/<用户名>/… 。
// 脱敏必须发生在这一层而非截图后改 DOM：两条接入命令由 settings.inline.ts 的
// buildMcpCommands 从这两个路径拼出，只改 [data-mcp-path] 会漏掉命令正文里的同一路径。
const MCP_STUB = {
  available: true,
  serverPath:
    "/Applications/IPReader.app/Contents/Resources/mcp/server.mjs",
  execPath: "/Applications/IPReader.app/Contents/MacOS/IPReader",
  platform: "darwin",
};
ipcMain.handle("mcp-get-info", () => MCP_STUB);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 轮询页面内表达式直到为真。
 * 页面就绪一律走这里而非固定 sleep：静态站的资源加载、字体就绪、力导预热耗时随机器而变，
 * 固定等待要么不够（截到加载中）要么浪费。
 * @param {BrowserWindow} win
 * @param {string} expr 页面内求值的 JS 表达式，返回真值即视为就绪
 * @param {string} label 超时报错用的可读名
 * @param {{ timeout?: number, interval?: number }} [opt]
 */
async function waitFor(win, expr, label, opt = {}) {
  const timeout = opt.timeout ?? 20000;
  const interval = opt.interval ?? 200;
  const deadline = Date.now() + timeout;
  for (;;) {
    let ok = false;
    try {
      ok = await win.webContents.executeJavaScript(`!!(${expr})`);
    } catch {
      // 导航中途求值可能抛，视作未就绪继续轮询
    }
    if (ok) return;
    if (Date.now() > deadline) {
      throw new Error(`等待「${label}」超时（${timeout}ms）：${expr}`);
    }
    await sleep(interval);
  }
}

/** 打开页面并等到基本可读：DOM 就绪 + 字体加载完毕（字体未就绪时截图会是回落字形） */
async function open(win, base, urlPath, readyExpr, label) {
  await win.loadURL(`${base}/${encodeURI(urlPath)}`);
  await waitFor(win, readyExpr, label);
  await win.webContents.executeJavaScript(
    `document.fonts.ready.then(() => true)`,
  );
}

const shots = [];

/**
 * 截图 → 落盘 → 压到 SHOT_WIDTH 宽。
 * capturePage 走 Chromium Viz 合成器，多 Electron 实例连跑时偶发瞬时 UnknownVizError
 * （GPU 进程竞态），故对瞬时错误有限重试；三次仍失败按真异常上抛。
 */
async function shot(win, name) {
  let img;
  for (let attempt = 1; ; attempt++) {
    try {
      img = await win.capturePage();
      break;
    } catch (e) {
      if (attempt >= 3) throw e;
      await sleep(300 * attempt);
    }
  }
  const file = path.join(OUT, `${name}.png`);
  await fs.promises.writeFile(file, img.toPNG());
  // sips -Z 把「较长边」缩到给定值：截图恒为横向（1440×900 的 2x），故等价于按宽等比缩放
  execFileSync("/usr/bin/sips", ["-Z", String(SHOT_WIDTH), file], {
    stdio: "ignore",
  });
  const { size } = await fs.promises.stat(file);
  shots.push({ name, size });
  console.log(`📸 ${name}.png —— ${(size / 1024).toFixed(0)} KB`);
  return file;
}

// —— 演示批注注入 ——
// 直接构造 localStorage 数据，字段与 annotate-store.ts 的 Annotation 逐项对齐：
//   桶键 `kb-anno:v1:page:<slug>`（KEY_PREFIX + slug），值为 Annotation[]。
//   selector 的六个字段与 annotate-anchor.ts 的 selectorFromRange 同构：blockIndex 取
//   `.center article` 内 BLOCK_SELECTOR 的 DOM 序，start/end 是「块 textContent 的字符偏移」
//   （不是 DOM 路径——正文被术语链接切得很碎，偏移才稳），prefix/suffix 各取 32 字符上下文。
// 关键：偏移一律从**实时 DOM** 现算，不硬编码数字。构建产物一变，硬编码的偏移会静默错位，
// 而现算的偏移永远命中——脚本只需给出要标注的原文片段。
const INJECT_FN = `
  function injectAnnotations(specs) {
    const BLOCK_SELECTOR = "p, li, h1, h2, h3, h4, h5, h6, blockquote, td, th";
    const CONTEXT_LEN = 32;
    const article = document.querySelector('.center article');
    if (!article) return { ok: false, reason: '未找到 .center article' };
    const blocks = Array.from(article.querySelectorAll(BLOCK_SELECTOR));
    const slug = document.body.dataset.slug || '';
    // 已占区间：同块内允许多条批注，但不得相交——annotate.inline.ts 的
    // createFromPending 对交叠一律拒绝（叠加底色在中文小字上不可读），
    // 预置数据同样遵守，免得截出一个真人做不出来的状态
    const claimed = new Map();
    const items = [];
    const missed = [];
    for (const spec of specs) {
      let found = null;
      for (let i = 0; i < blocks.length && found === null; i++) {
        const text = blocks[i].textContent || '';
        const taken = claimed.get(i) || [];
        let at = text.indexOf(spec.exact);
        while (at !== -1) {
          const end = at + spec.exact.length;
          if (!taken.some((r) => at < r[1] && end > r[0])) {
            found = { block: i, start: at, end };
            break;
          }
          at = text.indexOf(spec.exact, at + 1);
        }
      }
      if (found === null) { missed.push(spec.exact); continue; }
      const taken = claimed.get(found.block) || [];
      taken.push([found.start, found.end]);
      claimed.set(found.block, taken);
      const text = blocks[found.block].textContent || '';
      // 固定时间戳：批注列表按 blockIndex 排序，时间戳不影响呈现，
      // 取定值可让重复运行产出完全一致的数据
      const stamp = '2026-01-01T00:00:00.000Z';
      items.push({
        id: 'demo' + String(items.length + 1).padStart(2, '0'),
        slug,
        kind: spec.kind,
        color: spec.color,
        note: spec.note || '',
        selector: {
          blockIndex: found.block,
          blockTag: blocks[found.block].tagName,
          start: found.start,
          end: found.end,
          exact: spec.exact,
          prefix: text.slice(Math.max(0, found.start - CONTEXT_LEN), found.start),
          suffix: text.slice(found.end, found.end + CONTEXT_LEN),
        },
        createdAt: stamp,
        updatedAt: stamp,
      });
    }
    localStorage.setItem('kb-anno:v1:page:' + slug, JSON.stringify(items));
    return { ok: missed.length === 0, slug, count: items.length, missed };
  }
`;

// 六条演示批注，覆盖「四色高亮 + 划线 + 笔记」全部形态。
// 片段取自专利法第 22 条正文，均落在首屏可见的前五个自然段内。
const DEMO_ANNOTATIONS = [
  { exact: "新颖性、创造性和实用性", kind: "highlight", color: "yellow" },
  { exact: "不属于现有技术", kind: "highlight", color: "blue" },
  {
    exact: "也没有任何单位或者个人就同样的发明或者实用新型",
    kind: "note",
    color: "yellow",
    note: "抵触申请：申请在先、公布在后的同样发明创造，破坏新颖性但不属于现有技术。",
  },
  { exact: "突出的实质性特点和显著的进步", kind: "underline", color: "blue" },
  {
    exact: "能够制造或者使用，并且能够产生积极效果",
    kind: "highlight",
    color: "green",
  },
  {
    exact: "申请日以前在国内外为公众所知的技术",
    kind: "highlight",
    color: "pink",
  },
];

async function main() {
  await fs.promises.mkdir(OUT, { recursive: true });

  const { port } = await startStaticServer(DIST, { port: 0 });
  const base = `http://127.0.0.1:${port}`;
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    show: true,
    // 仅 macOS 启用自绘标题条，与 main.cjs 的生产建窗配置一致——否则渲染层的
    // .kb-titlebar（随 data-desktop 显示）会与系统原生标题栏双重叠加
    ...(process.platform === "darwin" ? { titleBarStyle: "hiddenInset" } : {}),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // 就绪判据：正文与左栏目录树都已渲染
  const PAGE_READY = `document.querySelector('.center article') && document.querySelector('.explorer-ul')`;
  // 右栏局部图：画布已由 PixiJS 挂上（元素在 SSR 产物里就有，故必须看到 canvas/svg 子节点）
  const GRAPH_READY = `document.querySelector('.graph-container canvas, .graph-container svg')`;
  // 章节页另等反向链接列表在场。
  // 不等 .toc——TableOfContents 有 minEntries 门槛（toc.length > 1），而章节页正文
  // 只有「关联」一个二级标题，本就不渲染大纲（词条页则由 custom.scss 显式隐藏），
  // 大纲形态见第 1 张首页。此处若硬等 .toc 会永远超时。
  const CHAPTER_READY = `${PAGE_READY} && ${GRAPH_READY} && document.querySelector('.backlinks li')`;

  // —— 1. 首页（右栏含关系图与大纲） ——
  await open(win, base, "/", `${PAGE_READY} && ${GRAPH_READY}`, "首页正文与目录树");
  await sleep(SETTLE_LOCAL_GRAPH);
  await shot(win, "01-home");

  // —— 2. 章节页（左栏目录树 / 中栏正文 / 右栏局部关联图与反向链接，三栏齐备） ——
  await open(win, base, CHAPTER, CHAPTER_READY, "章节页三栏");
  await sleep(SETTLE_LOCAL_GRAPH);
  await shot(win, "02-chapter");

  // —— 3. 图谱总览（力导布局，须等其铺开稳定后再截） ——
  await win.loadURL(`${base}/${encodeURI("0-图谱总览/")}`);
  await waitFor(
    win,
    `document.querySelector('.ge-canvas svg, .ge-canvas canvas')`,
    "图谱总览出图",
    { timeout: 30000, interval: 500 },
  );
  await sleep(SETTLE_GLOBAL_GRAPH);
  await shot(win, "03-graph");

  // —— 4. 全文搜索（弹层打开且已出结果） ——
  await open(win, base, "/", PAGE_READY, "首页（搜索前）");
  await win.webContents.executeJavaScript(
    `(() => {
       document.querySelector('.search > .search-button').click();
       const bar = document.querySelector('.search .search-bar');
       bar.value = ${JSON.stringify(SEARCH_QUERY)};
       bar.dispatchEvent(new Event('input', { bubbles: true }));
     })()`,
  );
  // 首次搜索要就地构建全文索引，耗时随机器而变——轮询到出卡为止，不固定等待
  await waitFor(
    win,
    `document.querySelectorAll('.results-container .result-card').length > 0`,
    "搜索结果卡",
    { timeout: 30000, interval: 300 },
  );
  await sleep(700);
  await shot(win, "04-search");

  // —— 5. 术语词条页 ——
  await open(win, base, TERM, `${PAGE_READY} && ${GRAPH_READY}`, "词条页");
  await sleep(SETTLE_LOCAL_GRAPH);
  await shot(win, "05-term");

  // —— 6. 批注高亮（预置演示数据后刷新，annotate.inline.ts 在 nav 时重新锚定并包裹） ——
  await open(win, base, ANNO_PAGE, PAGE_READY, "批注示例页");
  const injected = await win.webContents.executeJavaScript(
    `(() => { ${INJECT_FN} return injectAnnotations(${JSON.stringify(DEMO_ANNOTATIONS)}); })()`,
  );
  if (!injected.ok) {
    throw new Error(
      `演示批注注入失败：${injected.reason ?? `以下片段未在正文中找到 ${JSON.stringify(injected.missed)}`}`,
    );
  }
  await new Promise((resolve) => {
    win.webContents.once("did-finish-load", resolve);
    win.webContents.reload();
  });
  await waitFor(
    win,
    `document.querySelectorAll('mark.kb-mark').length >= ${DEMO_ANNOTATIONS.length}`,
    "演示批注已渲染",
  );
  // 刻意不点开笔记气泡：气泡是 fixed 浮层，落在笔记标记正上方，实测会盖住首段
  // （连同那条黄色高亮一并遮掉）。本张的取景意图是「四色高亮 + 划线 + 笔记标记」
  // 六种形态同屏可辨，笔记正文改由下一张的抽屉列表呈现，两张互补且都无遮挡。
  await sleep(500);
  await shot(win, "06-annotate");

  // —— 7. 批注管理抽屉（复用第 6 步的数据，展现有内容的列表） ——
  await win.webContents.executeJavaScript(
    `document.dispatchEvent(new CustomEvent('kb-anno-open-drawer'))`,
  );
  await waitFor(
    win,
    `(() => {
       const d = document.querySelector('.kb-anno-drawer');
       return d && !d.hidden && d.querySelectorAll('.kb-anno-row').length > 0;
     })()`,
    "批注抽屉列表",
    { timeout: 5000 },
  );
  await sleep(500);
  await shot(win, "07-annotate-drawer");

  // —— 8. 设置页 · 界面主题（六套主题卡） ——
  await win.loadURL(base + encodeURI("/设置/"));
  await waitFor(
    win,
    `document.querySelectorAll('.kb-settings-page .kb-theme-card').length === 6`,
    "设置页六张主题卡",
  );
  await win.webContents.executeJavaScript(
    `document.fonts.ready.then(() => true)`,
  );
  await sleep(600);
  await shot(win, "08-settings-theme");

  // —— 9. 深色态章节页（与第 2 张同页，明暗对照） ——
  await win.webContents.executeJavaScript(
    `document.querySelector('[data-setting="themeMode"][data-value="dark"]').click()`,
  );
  await waitFor(
    win,
    `document.documentElement.getAttribute('saved-theme') === 'dark'`,
    "深色态生效",
    { timeout: 5000 },
  );
  await open(win, base, CHAPTER, CHAPTER_READY, "章节页三栏（深色）");
  await waitFor(
    win,
    `document.documentElement.getAttribute('saved-theme') === 'dark'`,
    "章节页深色态",
    { timeout: 5000 },
  );
  await sleep(SETTLE_LOCAL_GRAPH);
  await shot(win, "09-chapter-dark");

  // —— 10. 设置页 · MCP 接入（命令区已由上方的桩填充） ——
  // 排在深色态之后，故须先切回浅色：本张与前八张同为宣纸亮态，第 9 张是全集里唯一的暗态样张。
  await win.loadURL(base + encodeURI("/设置/"));
  await waitFor(
    win,
    `document.querySelector('.kb-settings-page .kb-settings-cat[data-pane="mcp"]')`,
    "设置页分类钮",
  );
  await win.webContents.executeJavaScript(
    `document.querySelector('[data-setting="themeMode"][data-value="light"]').click()`,
  );
  await waitFor(
    win,
    `document.documentElement.getAttribute('saved-theme') === 'light'`,
    "设置页切回浅色",
    { timeout: 5000 },
  );
  await win.webContents.executeJavaScript(
    `document.querySelector('.kb-settings-cat[data-pane="mcp"]').click()`,
  );
  // 就绪判据取「命令文本已填充」而非「面板已切换」：面板切换是同步的 class 翻转，
  // 而命令来自一次 await 的 IPC——只等前者会截到两个空的 <code>
  await waitFor(
    win,
    `(() => {
       const block = document.querySelector('[data-mcp-block]');
       if (!block || block.hasAttribute('hidden')) return false;
       const claude = document.querySelector('[data-mcp-cmd="claude"]');
       return claude && claude.textContent.trim().length > 0;
     })()`,
    "MCP 接入命令已填充",
  );
  await win.webContents.executeJavaScript(
    `document.fonts.ready.then(() => true)`,
  );
  await sleep(600);
  await shot(win, "10-settings-mcp");

  const total = shots.reduce((sum, s) => sum + s.size, 0);
  console.log(
    `\n共 ${shots.length} 张，合计 ${(total / 1024 / 1024).toFixed(2)} MB，落于 ${OUT}`,
  );
  app.exit(0);
}

app.whenReady().then(() =>
  main().catch((e) => {
    console.error("截图失败：", e);
    app.exit(1);
  }),
);

// 兜底：无论如何 240 秒后强制退出，避免残留进程
setTimeout(() => {
  console.error("截图超时，强制退出");
  app.exit(1);
}, 240000);
