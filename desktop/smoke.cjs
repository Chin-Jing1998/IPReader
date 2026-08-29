// smoke.cjs —— 桌面端自动化冒烟（npm run smoke / npx electron smoke.cjs）
//
// 全链路：启动直入文档站首页 → SPA 点进书根 → 尾斜杠容器目录 URL → SPA 点进章节页 →
//         无扩展名章节 URL → 词条页 → 图谱总览专页出图 → 搜索"新颖性" →
//         设置页可达 → 主题卡选择持久化（reload 后仍生效）→ 明暗分段控件脱离跟随系统 →
//         桌面标题条（38px+flex）→ 全局偏移（body/左栏）→ 设置页沉浸 + 抽屉双栏 →
//         深链返回兜底（新窗口 history.length===1，R12）→ overlay 滚动条零挤压（R13）→
//         抽屉分类切换 → 影子滚动条几何与拖拽 → SPA 不残留 →
//         悬停预览弹窗底色与入场不透明 → 搜索弹层主题化 → 跟随系统零双跳（bug#2 竞态回归门）→
//         更新检查的默认姿态（v9：区块就位但默认不自动检查，全程不点检查按钮）→
//         MCP 接入说明（v9：命令按真实路径拼装、可复制入剪贴板）。
// 每步截图存 ./audit/；全程以 webRequest 拦截并「阻断 + 记录」一切非 127.0.0.1 请求，
// 等效断网环境（页面若依赖外网资源会直接失败），结果写 audit/offline-report.txt。
// 外部请求计数恒为 0 仍是硬性门槛：v9 引入的更新检查是全应用唯一的联网功能，
// 它默认关闭，本冒烟也刻意不触发它——那个 0 正是「默认完全离线」的唯一凭据。
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
// 阶段5波C 扩写：侧边栏三级分组（27，C-3 合成节点层）、图谱标签行（28，C-4 法域标签
// 状态机），共 28 步。两步都排在既有 26 步之后、离线报告之前：27 会重载首页、28 会点
// 法域标签改动图谱隐藏集，放在中段会污染前面各步的截图基线与主题/搜索收尾状态。
// 阶段5.3 批 B5 新增：图谱页目录联动与 controller 存活（29），共 29 步，排在步 28 之后、
// 离线报告之前——沿用步 28 已加载的图谱总览页，不再重复 loadURL。同批为步 28 追加
// 图例行随法域标签收窄的 hidden 分布断言（既有断言不动，只追加）。
// 阶段5.6 波2 新增：图谱首帧零标签光栅化 + SPA 往返命中组装缓存与坐标播种（30），
// 共 30 步，排在步 29 之后、离线报告之前。它守的是两项性能机制的**存活**而非指标：
// firstFrameVisibleLabels=0（波1-1.2 标签门控）与 assemblyCacheHit/layoutSeeded
// （波2-2.2 组装缓存与坐标播种）为硬失败结构断言，时间只设 1200ms 宽熔断抓塌方。
// 阶段5.7 波A 新增：局部图截断上限 60→120（31）、图谱总览画布尺寸同步（32），共 32 步，
// 排在步 30 之后、离线报告之前——两步都要 loadURL 换页（31 去文档页看局部图，32 回图谱
// 总览点法域标签），放在中段会污染前面各步的图谱状态与截图基线。同批为步 30 追加
// 「图谱索引悬空内链恒零」子断言（既有断言一字不动，只追加合取项）：判据与构建期
// contentIndex.tsx 的过滤同源，取数复用页面已解析的 window.__graphIndex，不另发请求。
// 阶段5.7 波B 新增：图谱总览目录导航抽屉（33），共 33 步，排在步 32 之后、离线报告之前
// ——沿用步 32 已加载的图谱总览页与它遗留的「法域=全部 + 右栏已显现」状态，不再 loadURL：
// 右栏若在本步中途首次显现会改画布宽度并触发波A 的 RO 重建，把 33-c 的「重建计数增量 0」
// 污染成无意义的断言。九项分工见该步内注释；33-i 的 localStorage 复位是硬性收尾。
// 阶段5.4 批 D3 随 D1/D2 目录行为反转全面改写步 29（总步数不变）：目录条目点击恢复
// SPA 直达文档（kb:graphlocate 定位链路全站撤销）、图谱页书下 3 层默认展开且折叠态
// 隔离进独立键 fileTree-graph、状态条提示 4s 自动消失。现断言为：初始展开规模 +
// fileTree 双键隔离（v2 逐字节不变）、目录点击 SPA 落地文档页（含 63 隐藏书）+
// kb:graphlocate 恒 0 + 点击瞬间无图内重建、术语三态钮存活哨兵、状态条「未找到」
// 自动消失、法域↔目录过滤联动保留、首页对照门退化为一致性抽查。controller 存活
// 哨兵双轨保留：window.__graphRender 包装计数在跳转前同步快照 + 页内交互后复验，
// 术语钮 data-term-mode 真实转移——B3 批曾引入 TDZ 缺陷使 controller 恒 null，但步 28
// 纯 UI 状态机完全绕开、28/28 仍照绿，本步专治这一类「controller 死而不僵」复发。
// 阶段5.8 新增：目录树自定义排序（34）、目录树一键收起（35），共 35 步，排在步 33
// 之后、离线报告之前。两步都要 loadURL 换页（34 先回首页拖法域行、再硬跳章节页拖书目行，
// 35 去 law-01-01 点收起），放在中段会污染前面各步的图谱状态与截图基线。
// 两步各自持有硬性收尾：34-g 把 kb-explorer-order:v1 复位回步首快照，35-d 把
// fileTree-v2 写回步首快照——冒烟不得把「自定义排序」或「全部收起」留在用户的
// localStorage 里。全程不碰图谱页的一键收起：步 29 的「初始展开 ≥1000」正是
// 「绝不自动收起」的常设护栏，本批新钮若被误接进 nav 回调，那条断言会立刻变红。
// 新增两步实测合计约 20s，600s 超时预算无需上调。
const {
  app,
  BrowserWindow,
  session,
  ipcMain,
  nativeTheme,
  clipboard,
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

// —— 更新检查 IPC 桩（v9）：同上，同协议、不写盘、**不联网** ——
// 版本号取 package.json 而非 app.getVersion()：以 `electron smoke.cjs` 这种
// 单文件入口启动时，Electron 不把 desktop/package.json 认作应用清单，
// app.getVersion() 会返回 Electron 自身的版本（43.3.0），据此断言等于什么都没验。
// 生产路径上 main.cjs 用的 app.getVersion() 在打包后即等于此处这个值，两者同源。
const APP_VERSION = require("./package.json").version;
ipcMain.handle("update-get-config", () => ({
  version: APP_VERSION,
  // 恒为 false：本冒烟验证的正是「默认不自动检查」，读用户真实配置反而会让断言随环境漂移
  autoCheck: false,
  releasesUrl: "https://github.com/Chin-Jing1998/IPReader/releases",
}));
ipcMain.handle("update-set-auto", (_e, enabled) => ({
  autoCheck: enabled === true,
}));
// 'update-check' 与 'update-open-releases' 刻意不注册：前者会真的请求 GitHub，
// 让离线护栏的计数变成非零——而那个 0 是「默认完全离线」的唯一凭据；后者会拉起
// 系统浏览器。冒烟不点这两个入口，未注册即是最硬的保险。

// —— MCP 接入信息桩（v9）——
// 用固定的假路径而非真实值：本项断言验的是「命令按模板正确拼装并可复制」，
// 真实路径随机器而异，拿它做断言等于让结果随环境漂移。available 恒 true，
// 使区块在冒烟环境下必然显示，从而真正验到那段渲染逻辑。
const MCP_STUB = {
  available: true,
  serverPath: "/tmp/smoke-mcp/server.mjs",
  execPath: "/tmp/smoke-mcp/IPReader",
  platform: process.platform,
};
ipcMain.handle("mcp-get-info", () => MCP_STUB);
// 复制走真实剪贴板：断言据此核对内容，同时验证 IPC 链路本身
ipcMain.handle("copy-text", (_e, text) => {
  if (typeof text !== "string" || !text) return false;
  clipboard.writeText(text);
  return true;
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
  // capturePage 走 Chromium Viz 合成器，多 Electron 实例连跑时偶发瞬时
  // UnknownVizError（GPU 进程竞态）。截图仅留审计证据、不承载断言，
  // 对瞬时错误做有限重试；三次仍失败按真异常上抛，不掩盖持续性故障。
  let img;
  for (let attempt = 1; ; attempt++) {
    try {
      img = await win.capturePage();
      break;
    } catch (e) {
      if (attempt >= 3) throw e;
      await new Promise((r) => setTimeout(r, 300 * attempt));
    }
  }
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

  // 6. 词条页（term-0001 归"04-可专利客体"——2026-08-12 主题归并 37 组→20 组后组序由 33 变 04，
  //    目录编号取 site/scripts/lib/topics.mjs::TERM_TOPIC_GROUPS 的组序；断言同时核验真实渲染标题，
  //    仅查 pathname 会在 404 页恒真——404 页保留请求路径，曾长期掩盖旧路径失效）
  await win.loadURL(
    `${base}/${encodeURI("9-关键词索引/04-可专利客体/term-0001")}`,
  );
  await sleep(600);
  const termTitle = await win.webContents.executeJavaScript("document.title");
  record(
    "词条页 term-0001",
    (await currentPath(win)) === "/9-关键词索引/04-可专利客体/term-0001" &&
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

  // 13. 明暗分段控件脱离跟随（saved-theme 翻转且 themeMode 落固定值，不再是 system）
  //     v14 改造：左栏明暗快捷钮已删除，明暗入口只剩设置页抽屉的分段控件，故触发点
  //     由 .kb-theme-toggle 换成 [data-setting="themeMode"]；断言目标一字未改——
  //     取「当前实际亮暗的反面」那一段来点，等价于原快捷钮「读当前取反」的语义，
  //     仍同时核验「确实翻转」与「脱离跟随系统」两项。
  //     与步骤 24 的分工：本步验固定档（light/dark）的切换与落盘，24 验 system 档
  //     的 IPC 权威态竞态（零双跳），两步互不重叠。
  const savedThemeBefore = await win.webContents.executeJavaScript(
    `document.documentElement.getAttribute('saved-theme')`,
  );
  const flipTarget = savedThemeBefore === "dark" ? "light" : "dark";
  await win.webContents.executeJavaScript(
    `document.querySelector('[data-setting="themeMode"][data-value="${flipTarget}"]').click()`,
  );
  await sleep(300);
  const savedThemeAfter = await win.webContents.executeJavaScript(
    `document.documentElement.getAttribute('saved-theme')`,
  );
  const themeModeAfter = await win.webContents.executeJavaScript(
    `(() => { try { return JSON.parse(localStorage.getItem('kb-settings:v1')).themeMode; } catch { return null; } })()`,
  );
  record(
    "明暗分段控件切换（翻转生效 + 脱离跟随系统）",
    savedThemeAfter === flipTarget &&
      savedThemeAfter !== savedThemeBefore &&
      (themeModeAfter === "light" || themeModeAfter === "dark"),
    `saved-theme: ${savedThemeBefore}→${savedThemeAfter}（目标 ${flipTarget}）, themeMode=${themeModeAfter}`,
  );
  await shot(win, "设置页-明暗分段切换");

  // 复原为进入本步前的亮暗，避免影响下次运行
  await win.webContents.executeJavaScript(
    `document.querySelector('[data-setting="themeMode"][data-value="${savedThemeBefore}"]').click()`,
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

  // 16. 设置页沉浸 + 抽屉双栏（左右栏隐藏、占位正文让位、抽屉/返回钮/四 pane/六卡在场）
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
         catCount: document.querySelectorAll('.kb-settings-cat').length,
         aboutMail: (() => {
           const a = document.querySelector('.kb-settings-pane[data-pane-id="about"] a[href^="mailto:"]');
           return a ? a.getAttribute('href') : null;
         })(),
       };
     })()`,
  );
  record(
    "设置页沉浸 + 抽屉双栏（双栏隐藏 + 占位正文让位 + 抽屉/返回钮/四 pane/六卡）",
    immersiveProbe.leftHidden &&
      immersiveProbe.rightHidden &&
      immersiveProbe.hasArticle &&
      immersiveProbe.articleHidden &&
      immersiveProbe.hasDrawer &&
      immersiveProbe.hasBack &&
      !immersiveProbe.hasTitle &&
      // v9 起为四分类：外观 / 批注 / MCP / 关于
      immersiveProbe.paneCount === 4 &&
      immersiveProbe.activePane === "appearance" &&
      immersiveProbe.cardCount === 6 &&
      immersiveProbe.catCount === 4 &&
      immersiveProbe.aboutMail === "mailto:zhangjingjing962464@gmail.com",
    `left隐=${immersiveProbe.leftHidden}, right隐=${immersiveProbe.rightHidden}, ` +
      `占位正文在场=${immersiveProbe.hasArticle}/已隐=${immersiveProbe.articleHidden}, ` +
      `抽屉=${immersiveProbe.hasDrawer}, 返回钮=${immersiveProbe.hasBack}, 旧标题已删=${!immersiveProbe.hasTitle}, ` +
      `pane数=${immersiveProbe.paneCount}, 激活pane=${immersiveProbe.activePane}, 主题卡=${immersiveProbe.cardCount}, ` +
      `分类钮=${immersiveProbe.catCount}, 邮箱href命中=${immersiveProbe.aboutMail === "mailto:zhangjingjing962464@gmail.com"}`,
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
  // 路径经校验为产物中真实存在的词条页（term-0001 归类在"04-可专利客体"，2026-08-12 主题归并前
  // 为"33-可专利客体"；更早的旧步骤 6 曾沿用"99-综合" ——那一档并无 term-0001.html，其断言只验证了
  // 路径回显、未验证页面真实加载，属既有状况，本步不沿用其路径，另择已核实存在的页面）
  await win.loadURL(
    `${base}/${encodeURI("9-关键词索引/04-可专利客体/term-0001")}`,
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

  // 19. 设置页抽屉切换（分类钮 ↔ 面板 is-active 同步；三分类互斥；切回 appearance 复原）
  //     面板显隐由 CSS 降级门 `.kb-settings-page[data-panes-ready] .kb-settings-pane:not(.is-active)`
  //     承担，故断言用 offsetParent 而非 classList——脚本没落 data-panes-ready 时三 pane 全显。
  //     「关于」是纯静态面板（无 data-setting 控件），故只验切换互斥：切到它时另两个
  //     面板同时隐去，这正是 switchPane 按 data-pane/data-pane-id 通配的直接证据。
  await win.loadURL(base + encodeURI("/设置/"));
  await sleep(600);
  const drawerProbe = await win.webContents.executeJavaScript(
    `(() => {
       const q = (s) => document.querySelector(s);
       const anno = () => q('.kb-settings-pane[data-pane-id="anno"]');
       const appearance = () => q('.kb-settings-pane[data-pane-id="appearance"]');
       const about = () => q('.kb-settings-pane[data-pane-id="about"]');
       const mcp = () => q('.kb-settings-pane[data-pane-id="mcp"]');
       q('.kb-settings-cat[data-pane="anno"]').click();
       const afterAnno = {
         annoActive: anno().classList.contains('is-active'),
         annoVisible: anno().offsetParent !== null,
         appearanceHidden: appearance().offsetParent === null,
         catAria: q('.kb-settings-cat[data-pane="anno"]').getAttribute('aria-selected'),
       };
       q('.kb-settings-cat[data-pane="mcp"]').click();
       const afterMcp = {
         mcpActive: mcp().classList.contains('is-active'),
         mcpVisible: mcp().offsetParent !== null,
         annoHidden: anno().offsetParent === null,
         aboutHidden: about().offsetParent === null,
         catAria: q('.kb-settings-cat[data-pane="mcp"]').getAttribute('aria-selected'),
       };
       q('.kb-settings-cat[data-pane="about"]').click();
       const afterAbout = {
         aboutActive: about().classList.contains('is-active'),
         aboutVisible: about().offsetParent !== null,
         annoHidden: anno().offsetParent === null,
         appearanceHidden: appearance().offsetParent === null,
         mcpHidden: mcp().offsetParent === null,
         catAria: q('.kb-settings-cat[data-pane="about"]').getAttribute('aria-selected'),
       };
       q('.kb-settings-cat[data-pane="appearance"]').click();
       const restored = {
         appearanceActive: appearance().classList.contains('is-active'),
         appearanceVisible: appearance().offsetParent !== null,
         annoHidden: anno().offsetParent === null,
         aboutHidden: about().offsetParent === null,
         mcpHidden: mcp().offsetParent === null,
       };
       return { afterAnno, afterMcp, afterAbout, restored };
     })()`,
  );
  record(
    "设置页抽屉切换（切「批注」→「MCP」→「关于」四分类互斥 + 切回「外观」复原）",
    drawerProbe.afterAnno.annoActive &&
      drawerProbe.afterAnno.annoVisible &&
      drawerProbe.afterAnno.appearanceHidden &&
      drawerProbe.afterAnno.catAria === "true" &&
      drawerProbe.afterMcp.mcpActive &&
      drawerProbe.afterMcp.mcpVisible &&
      drawerProbe.afterMcp.annoHidden &&
      drawerProbe.afterMcp.aboutHidden &&
      drawerProbe.afterMcp.catAria === "true" &&
      drawerProbe.afterAbout.aboutActive &&
      drawerProbe.afterAbout.aboutVisible &&
      drawerProbe.afterAbout.annoHidden &&
      drawerProbe.afterAbout.appearanceHidden &&
      drawerProbe.afterAbout.mcpHidden &&
      drawerProbe.afterAbout.catAria === "true" &&
      drawerProbe.restored.appearanceActive &&
      drawerProbe.restored.appearanceVisible &&
      drawerProbe.restored.annoHidden &&
      drawerProbe.restored.aboutHidden &&
      drawerProbe.restored.mcpHidden,
    `切批注：anno激活=${drawerProbe.afterAnno.annoActive}/可见=${drawerProbe.afterAnno.annoVisible}, ` +
      `appearance隐=${drawerProbe.afterAnno.appearanceHidden}, aria-selected=${drawerProbe.afterAnno.catAria}；` +
      `切MCP：mcp激活=${drawerProbe.afterMcp.mcpActive}/可见=${drawerProbe.afterMcp.mcpVisible}, ` +
      `anno隐=${drawerProbe.afterMcp.annoHidden}, about隐=${drawerProbe.afterMcp.aboutHidden}, ` +
      `aria-selected=${drawerProbe.afterMcp.catAria}；` +
      `切关于：about激活=${drawerProbe.afterAbout.aboutActive}/可见=${drawerProbe.afterAbout.aboutVisible}, ` +
      `anno隐=${drawerProbe.afterAbout.annoHidden}, appearance隐=${drawerProbe.afterAbout.appearanceHidden}, ` +
      `mcp隐=${drawerProbe.afterAbout.mcpHidden}, aria-selected=${drawerProbe.afterAbout.catAria}；` +
      `切回：appearance激活=${drawerProbe.restored.appearanceActive}/可见=${drawerProbe.restored.appearanceVisible}, ` +
      `anno隐=${drawerProbe.restored.annoHidden}, about隐=${drawerProbe.restored.aboutHidden}, ` +
      `mcp隐=${drawerProbe.restored.mcpHidden}`,
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

  // 25. 更新检查的默认姿态（v9）
  //     检查更新是全应用唯一会联网的功能，因此本项断言的重点是「默认不联网」：
  //     开关默认未勾选，且本项刻意不点「检查更新」按钮——点了就会真的请求 GitHub，
  //     让离线护栏的计数变成非零，而那个零正是「完全离线」这句承诺的唯一凭据。
  //     区块本身须已由 settings.inline.ts 摘除 hidden（证明 IPC 桥接就位），
  //     版本号须等于主进程的 app.getVersion()（证明静态页里的那行已被权威值覆写）。
  await win.loadURL(base + encodeURI("/设置/"));
  await sleep(900); // initUpdatePanel 走 IPC 往返，给足时间
  const updateProbe = await win.webContents.executeJavaScript(
    `(() => {
       const block = document.querySelector('.kb-settings-pane[data-pane-id="about"] [data-update-block]');
       const box = block && block.querySelector('[data-setting="autoCheckUpdate"]');
       const ver = document.querySelector('[data-update-version]');
       return {
         hasBlock: !!block,
         hiddenRemoved: !!block && !block.hasAttribute('hidden'),
         hasButton: !!(block && block.querySelector('[data-setting="checkUpdate"]')),
         hasCheckbox: !!box,
         autoChecked: !!box && box.checked,
         statusEmpty: (() => {
           const s = block && block.querySelector('[data-update-status]');
           return !s || s.textContent.trim() === '';
         })(),
         version: ver ? ver.textContent.trim() : null,
       };
     })()`,
  );
  const wantVersion = `v${APP_VERSION}`;
  record(
    "更新检查默认姿态（区块就位 + 默认不自动检查 + 版本号取自主进程 + 未触发任何请求）",
    updateProbe.hasBlock &&
      updateProbe.hiddenRemoved &&
      updateProbe.hasButton &&
      updateProbe.hasCheckbox &&
      updateProbe.autoChecked === false &&
      updateProbe.statusEmpty &&
      updateProbe.version === wantVersion &&
      externalAttempts.length === 0,
    `区块在场=${updateProbe.hasBlock}, hidden已摘=${updateProbe.hiddenRemoved}, ` +
      `按钮=${updateProbe.hasButton}, 开关=${updateProbe.hasCheckbox}, ` +
      `自动检查默认=${updateProbe.autoChecked}（须 false）, 状态行空=${updateProbe.statusEmpty}, ` +
      `版本=${updateProbe.version}（主进程给出 ${wantVersion}）, 此刻外部请求=${externalAttempts.length}`,
  );
  await shot(win, "更新检查默认姿态");

  // 26. MCP 接入说明（v9，独立分类「MCP」，位于「关于」之上）
  //     区块须在确认服务文件存在后显示、降级说明同时隐去，两条命令按本机真实路径
  //     拼装（此处为桩值），复制钮把命令原样送进系统剪贴板。断言比对剪贴板内容，
  //     链路端到端。
  await win.webContents.executeJavaScript(
    `document.querySelector('.kb-settings-cat[data-pane="mcp"]').click()`,
  );
  await sleep(700);
  clipboard.writeText("__smoke_before__");
  await win.webContents.executeJavaScript(
    `document.querySelector('[data-setting="copyMcp"][data-mcp-target="claude"]').click()`,
  );
  await sleep(500);
  const mcpProbe = await win.webContents.executeJavaScript(
    `(() => {
       const b = document.querySelector('[data-mcp-block]');
       const fb = document.querySelector('[data-mcp-fallback]');
       const btn = b && b.querySelector('[data-setting="copyMcp"][data-mcp-target="claude"]');
       return {
         visible: !!b && b.offsetParent !== null,
         hiddenRemoved: !!b && !b.hasAttribute('hidden'),
         fallbackHidden: !!fb && fb.hasAttribute('hidden'),
         inOwnPane: !!b && b.closest('.kb-settings-pane').dataset.paneId === 'mcp',
         claude: (b && b.querySelector('[data-mcp-cmd="claude"]') || {}).textContent || '',
         codex: (b && b.querySelector('[data-mcp-cmd="codex"]') || {}).textContent || '',
         path: (b && b.querySelector('[data-mcp-path]') || {}).textContent || '',
         toolCount: b ? b.querySelectorAll('li').length : 0,
         copyLabel: btn ? btn.textContent : '',
       };
     })()`,
  );
  const clip = clipboard.readText();
  record(
    "MCP 独立分类（区块显示于 mcp 面板 + 降级说明隐去 + 命令按真实路径拼装 + 复制入剪贴板）",
    mcpProbe.visible &&
      mcpProbe.hiddenRemoved &&
      mcpProbe.inOwnPane &&
      mcpProbe.fallbackHidden &&
      mcpProbe.claude.includes(MCP_STUB.serverPath) &&
      mcpProbe.claude.includes("ELECTRON_RUN_AS_NODE=1") &&
      mcpProbe.codex.includes("[mcp_servers.ipreader]") &&
      mcpProbe.codex.includes(MCP_STUB.execPath) &&
      mcpProbe.path === MCP_STUB.serverPath &&
      mcpProbe.toolCount === 7 &&
      clip === mcpProbe.claude &&
      mcpProbe.copyLabel === "已复制",
    `可见=${mcpProbe.visible}, hidden已摘=${mcpProbe.hiddenRemoved}, ` +
      `位于 mcp 面板=${mcpProbe.inOwnPane}, 降级说明已隐=${mcpProbe.fallbackHidden}, ` +
      `claude 命令含服务路径=${mcpProbe.claude.includes(MCP_STUB.serverPath)}, ` +
      `codex 含表头=${mcpProbe.codex.includes("[mcp_servers.ipreader]")}, ` +
      `路径行=${mcpProbe.path}, 工具条目=${mcpProbe.toolCount}, ` +
      `剪贴板匹配=${clip === mcpProbe.claude}, 按钮回执="${mcpProbe.copyLabel}"`,
  );
  await shot(win, "MCP接入说明");

  // ============ 阶段5波C 新增两步（27–28） ============

  // 27. 侧边栏三级分组（C-3）
  //     explorer.inline.ts 取 /static/taxonomy.json 后，把 87 个顶层书目录整体摘下、
  //     按「国家 → 权利类型 → 文件归类」再父化到三层合成节点之下。合成节点没有对应
  //     页面，因此绝不能渲染成 <a>——真出现了就是一条指向不存在路径的死链，这正是
  //     本步的核心回归门（另两项为分组层确已建成、六类权利类型齐备）。
  //     取数是异步 fetch，故轮询等待分组层落地，不用固定 sleep 赌时序；taxonomy 取不到
  //     时目录树按设计回落平铺，此时合成节点数为 0，断言即失败——正是想要的行为。
  await win.loadURL(`${base}/`);
  let syntheticReady = false;
  for (let i = 0; i < 20; i += 1) {
    await sleep(300);
    syntheticReady = await win.webContents.executeJavaScript(
      `document.querySelectorAll('.explorer-ul [data-synthetic="true"]').length > 0`,
    );
    if (syntheticReady) break;
  }
  // 权利类型层的六个取值与 explorer.inline.ts 的 FIELD_ORDER、
  // quartz/util/graphSections.ts 的 FIELD_TABS 同源（taxonomy.json 的 field 字段）
  const FIELD_ROWS = ["专利", "商标", "著作权", "竞争法", "品种布图", "综合程序"];
  const groupProbe = await win.webContents.executeJavaScript(
    `(() => {
       const titleOf = (el) => {
         const t = el && el.querySelector('.folder-title');
         return t ? t.textContent.trim() : null;
       };
       const all = document.querySelectorAll('.explorer-ul [data-synthetic="true"]');
       // 直接子选择器锁死「顶层」：国家层必须挂在 explorer 根 ul 的第一级 li 上
       const country = document.querySelector(
         '.explorer-ul > li > [data-synthetic="true"][data-folderpath="synthetic:CN"]',
       );
       const fields = ${JSON.stringify(FIELD_ROWS)}.map((f) => {
         const el = document.querySelector(
           '.explorer-ul [data-synthetic="true"][data-folderpath="synthetic:CN/' + f + '"]',
         );
         return { field: f, found: !!el, title: titleOf(el) };
       });
       return {
         syntheticCount: all.length,
         // 合成节点容器内的 <a>：子树挂在兄弟节点 .folder-outer 里，不会被此选择器误收
         anchorInside: document.querySelectorAll('.explorer-ul [data-synthetic="true"] a').length,
         countryTopLevel: !!country,
         countryTitle: titleOf(country),
         fields,
       };
     })()`,
  );
  const fieldRowsOk =
    groupProbe.fields.length === 6 &&
    groupProbe.fields.every((f) => f.found && f.title === f.field);
  record(
    "侧边栏三级分组（合成节点 ≥7 + 顶层「中国」+ 合成节点内无 <a> + 六类权利类型齐备）",
    syntheticReady &&
      groupProbe.syntheticCount >= 7 &&
      groupProbe.countryTopLevel &&
      groupProbe.countryTitle === "中国" &&
      groupProbe.anchorInside === 0 &&
      fieldRowsOk,
    `合成节点=${groupProbe.syntheticCount}（须 ≥7）, 顶层国家层在场=${groupProbe.countryTopLevel}/标题="${groupProbe.countryTitle}", ` +
      `合成节点内 <a>=${groupProbe.anchorInside}（须 0，即不可点击）, ` +
      `权利类型行=[${groupProbe.fields.map((f) => `${f.field}→${f.found ? f.title : "缺失"}`).join(", ")}]（六类齐备→${fieldRowsOk}）`,
  );
  await shot(win, "侧边栏三级分组");

  // 28. 图谱标签行（C-4）
  //     工具条首行「中国 → 法域标签」：一枚国家徽标 + 七枚 .ge-field-tab（哨兵「全部」
  //     FIELD_ALL="*" 加六法域）。初始高亮不是写死的，而由 syncFieldTabs 从 hiddenSections
  //     反解——空隐藏集反解为「全部」，故初始态「全部」带 .active。
  //     点「商标」后 applyField 把非术语组切成只留商标域再 resetView。本步只验状态机
  //     （.active 的转移与 aria-pressed 同步），不验画布像素：像素随布局与显卡漂移，
  //     拿它做断言等于让结果随环境摇摆。
  await win.loadURL(`${base}/${encodeURI("0-图谱总览/")}`);
  let fieldNavReady = false;
  for (let i = 0; i < 30; i += 1) {
    await sleep(500);
    fieldNavReady = await win.webContents.executeJavaScript(
      `!!document.querySelector('.ge-fieldnav') &&
       !!document.querySelector('.ge-canvas svg, .ge-canvas canvas')`,
    );
    if (fieldNavReady) break;
  }
  await sleep(1200); // 力导布局落定后再采样，避免 resetView 与首帧动画重叠
  const fieldNavProbe = await win.webContents.executeJavaScript(
    `(() => {
       const tabs = Array.from(document.querySelectorAll('.ge-field-tab[data-field]'));
       const cn = document.querySelector('.ge-country[data-country="CN"]');
       const all = document.querySelector('.ge-field-tab[data-field="*"]');
       return {
         hasNav: !!document.querySelector('.ge-fieldnav'),
         tabCount: tabs.length,
         tabFields: tabs.map((t) => t.dataset.field),
         allActive: !!all && all.classList.contains('active'),
         cnActive: !!cn && cn.classList.contains('active'),
       };
     })()`,
  );
  await win.webContents.executeJavaScript(
    `document.querySelector('.ge-field-tab[data-field="商标"]').click()`,
  );
  await sleep(900);
  const fieldTabAfter = await win.webContents.executeJavaScript(
    `(() => {
       const tm = document.querySelector('.ge-field-tab[data-field="商标"]');
       const all = document.querySelector('.ge-field-tab[data-field="*"]');
       return {
         tmActive: !!tm && tm.classList.contains('active'),
         tmPressed: tm ? tm.getAttribute('aria-pressed') : null,
         allActive: !!all && all.classList.contains('active'),
         allPressed: all ? all.getAttribute('aria-pressed') : null,
       };
     })()`,
  );
  // 扩断言（阶段5.3 批 B5，追加于既有断言之后，既有条件与文案一字不动）：
  // 图例行 .ge-legend-item[data-section] 随法域标签同步收窄的 hidden 分布——商标法域在
  // SECTION_GROUPS 中恰有两组（"8"=商标、"15"=商标审查指南，见 quartz/util/graphSections.ts
  // 的 groupsOfField("商标")），故点「商标」后 14 枚图例钮应恰 2 枚可见、其余 12 枚 hidden；
  // 点回「全部」后 14 枚全可见，与挂载初始态一致。
  const TRADEMARK_LEGEND_GROUPS = ["8", "15"];
  const legendAfterTm = await win.webContents.executeJavaScript(
    `Array.from(document.querySelectorAll('.ge-legend-item[data-section]')).map((el) => ({ section: el.dataset.section, hidden: el.hidden }))`,
  );
  const legendTmOk =
    legendAfterTm.length === 14 &&
    legendAfterTm.every((it) =>
      TRADEMARK_LEGEND_GROUPS.includes(it.section) ? it.hidden === false : it.hidden === true,
    );
  await win.webContents.executeJavaScript(
    `document.querySelector('.ge-field-tab[data-field="*"]').click()`,
  );
  await sleep(900);
  const legendAfterAll = await win.webContents.executeJavaScript(
    `Array.from(document.querySelectorAll('.ge-legend-item[data-section]')).map((el) => ({ section: el.dataset.section, hidden: el.hidden }))`,
  );
  const legendAllOk =
    legendAfterAll.length === 14 && legendAfterAll.every((it) => it.hidden === false);
  record(
    "图谱标签行（.ge-fieldnav + 七枚标签 + 初始「全部」/中国高亮 + 点「商标」后高亮转移 + 图例行随标签收窄）",
    fieldNavReady &&
      fieldNavProbe.hasNav &&
      fieldNavProbe.tabCount === 7 &&
      fieldNavProbe.allActive &&
      fieldNavProbe.cnActive &&
      fieldTabAfter.tmActive &&
      fieldTabAfter.tmPressed === "true" &&
      fieldTabAfter.allActive === false &&
      fieldTabAfter.allPressed === "false" &&
      legendTmOk &&
      legendAllOk,
    `标签行在场=${fieldNavProbe.hasNav}, 标签数=${fieldNavProbe.tabCount}（须 7：${fieldNavProbe.tabFields.join(" / ")}）, ` +
      `初始「全部」高亮=${fieldNavProbe.allActive}, 中国徽标高亮=${fieldNavProbe.cnActive}；` +
      `点「商标」后：商标高亮=${fieldTabAfter.tmActive}（aria-pressed=${fieldTabAfter.tmPressed}）, ` +
      `「全部」已落灰=${!fieldTabAfter.allActive}（aria-pressed=${fieldTabAfter.allPressed}）；` +
      `图例行分布：点「商标」后=${JSON.stringify(legendAfterTm)}（组8/15可见、其余隐→${legendTmOk}）, ` +
      `点回「全部」后 14 枚全可见→${legendAllOk}`,
  );
  await shot(win, "图谱标签行");

  // ============ 阶段5.3 批 B5 新增一步（29）；阶段5.4 批 D3 随目录行为反转全面改写 ============

  // 29. 图谱页目录直达文档 + 书下 3 层默认展开 + 提示自动消失 + controller 存活
  //     沿用步 28 已加载的图谱总览页与其目录树，不再 loadURL。
  //     阶段5.4 批 D1/D2 反转后的事实基线（本步断言据此重写）：
  //     · 目录条目点击恢复 SPA 直达文档——folderClickBehavior:'link' 下书名/章名本就是
  //       <a data-for>，spa.inline.ts 的 window 级 click 委托接管跳转；原「拦截跳转 →
  //       派发 kb:graphlocate 图内定位」链路已全站撤销，kb:graphlocate 不再有派发点。
  //     · 图谱页折叠态隔离进独立键 fileTree-graph，默认展开深度放宽到 ≤6 层（书下
  //       3 层可见）——文档站 fileTree-v2 对图谱页零读零写。
  //     · 所有经 setStatus 写入的状态条提示（含搜索未命中的「未找到含…」）4s 自动清空。
  //     controller 存活哨兵双轨保留（B3 教训：controller 恒 null 时术语三态失效、
  //     定位恒走重建兜底，而纯 UI 状态机的步 28 完全绕开、照绿不报）：
  //     ① window.__graphRender 全量重建计数——图内「重建」的唯一窗口入口
  //        （graph.inline.ts `window.__graphRender = renderGraph`；renderCanvas 每次都重新
  //        读该全局引用，不缓存闭包），可在挂载完成后的任意时点用一次纯 executeJavaScript
  //        换上计数包装（原函数仍被转发调用，不改变行为）。跳转类子项在 click() 同步派发
  //        完成瞬间快照计数——同步重建路径必先落账；页内交互子项在交互后复验恒 0。
  //        TDZ 缺陷形态下 controller===null 强制走重建兜底，计数即非 0。
  //     ② 术语三态钮点击后 .ge-term-btn.active 的 data-term-mode 实际落点——缺陷形态下
  //        onTermModeClick 因 controller===null 提前 return，按钮态原地不动
  //        （点「显示」后仍是 hidden）；比深读 controller 内部状态更直接的外部可观测信号。

  // —— 初始态检查（a 之前）：书下 3 层默认展开规模 + fileTree 双键隔离 ——
  // v2 快照此刻读取即「进入图谱页前」的值：图谱页对该键零读零写，且步 28 是直接
  // loadURL 进图谱页，中间不存在任何会写 v2 的页面交互。
  const v2Before = await win.webContents.executeJavaScript(
    `localStorage.getItem('fileTree-v2')`,
  );
  const expandProbe = await win.webContents.executeJavaScript(
    `(() => ({
       open: document.querySelectorAll('.explorer-ul .folder-outer.open').length,
       total: document.querySelectorAll('.explorer-ul .folder-outer').length,
     }))()`,
  );
  const expandOk = expandProbe.open >= 1000;
  // 手动折叠任一文件夹再展开复原：书夹标题在 link 行为下是 <a>，点它会跳走，
  // 故经 .folder-icon 触发 toggleFolder。注意 .folder-icon 是 SVG 元素，
  // SVGElement 无 HTMLElement.click() 方法，须派发 MouseEvent（toggleFolder 读
  // evt.target 的 nodeName==="svg" 分支照常命中）。折叠再展开会写 fileTree-graph
  // 两次，终值可能与初值不同——隔离断言只要求 graph 键存在 + v2 逐字节不变。
  const TOGGLE_FOLDER = '.folder-container[data-folderpath="1-专利法/index"]';
  await win.webContents.executeJavaScript(
    `document.querySelector('.explorer-ul ${TOGGLE_FOLDER} .folder-icon')
       .dispatchEvent(new MouseEvent('click', { bubbles: true }))`,
  );
  await sleep(600);
  // 中途确认折叠确实发生（folder-outer 失去 open），防止点击空转导致假绿
  const collapsedMid = await win.webContents.executeJavaScript(
    `(() => {
       const c = document.querySelector('.explorer-ul ${TOGGLE_FOLDER}');
       return !!c && !!c.nextElementSibling &&
         !c.nextElementSibling.classList.contains('open');
     })()`,
  );
  await win.webContents.executeJavaScript(
    `document.querySelector('.explorer-ul ${TOGGLE_FOLDER} .folder-icon')
       .dispatchEvent(new MouseEvent('click', { bubbles: true }))`,
  );
  await sleep(600);
  const isolationProbe = await win.webContents.executeJavaScript(
    `({
       v2After: localStorage.getItem('fileTree-v2'),
       graphKey: localStorage.getItem('fileTree-graph'),
     })`,
  );
  const isolationOk =
    collapsedMid === true &&
    isolationProbe.v2After === v2Before &&
    typeof isolationProbe.graphKey === "string" &&
    isolationProbe.graphKey.length > 0;

  // —— 哨兵装置安装（保留 __graphRender 包装机制；kb:graphlocate 计数器验证全站撤销）——
  await win.webContents.executeJavaScript(
    `(() => {
       if (typeof window.__smokeOrigGraphRender === 'undefined') {
         window.__smokeOrigGraphRender = window.__graphRender;
       }
       window.__smokeRenderCalls = 0;
       window.__graphRender = function (...args) {
         window.__smokeRenderCalls += 1;
         // A.0（阶段5.10 波A）：顺手把 controller 捞到 window.__smokeCtl。
         // renderGraph 返回 Promise<GraphController>，故经 .then 透传、不改调用方语义；
         // 后续步骤据此直接调 getTransform()/syncSize()/getTermLayer() 做相机守恒与
         // 竞态存活断言，无须再从页面脚本的闭包里翻 controller。
         return window.__smokeOrigGraphRender.apply(this, args).then((c) => {
           window.__smokeCtl = c;
           return c;
         });
       };
       window.__smokeLocate = { count: 0, lastSlug: null };
       document.addEventListener('kb:graphlocate', (ev) => {
         window.__smokeLocate.count += 1;
         window.__smokeLocate.lastSlug = ev && ev.detail ? ev.detail.slug : null;
       });
       return typeof window.__smokeOrigGraphRender === 'function';
     })()`,
  );

  // a-d：点章节条目 law-01-01 —— SPA 直达文档页（path/title 变为落地页）+
  // kb:graphlocate 恒 0（定位链路已撤销）+ 落地页无 .ge-panel +
  // 点击同步派发完成瞬间重建计数 0（controller 存活哨兵①·同步快照：
  // click() 的事件派发是同步的，若点击处理链同步触发图内重建，计数必先落账；
  // SPA 换页本身异步 fetch 后换体，不会在本条 executeJavaScript 内销毁上下文）
  const navClickSnap = await win.webContents.executeJavaScript(
    `document.querySelector('.explorer-ul a[data-for="1-专利法/1-总则/law-01-01"]').click();
     ({ callsAtClick: window.__smokeRenderCalls })`,
  );
  await sleep(1200);
  const afterNav = await win.webContents.executeJavaScript(
    `({
       path: decodeURIComponent(location.pathname),
       title: document.title,
       locateCount: window.__smokeLocate.count,
       panelExists: !!document.querySelector('.ge-panel'),
     })`,
  );
  const navOk =
    afterNav.path === "/1-专利法/1-总则/law-01-01" &&
    afterNav.title === "第1条 · 立法目的" &&
    afterNav.locateCount === 0 &&
    afterNav.panelExists === false &&
    navClickSnap.callsAtClick === 0;

  // 回图谱总览页继续后续子项（SPA 已离开图谱页，须整页重载恢复画布与哨兵环境）
  await win.loadURL(`${base}/0-图谱总览/`);
  let graphReady1 = false;
  for (let i = 0; i < 30; i += 1) {
    await sleep(500);
    graphReady1 = await win.webContents.executeJavaScript(
      `!!document.querySelector('.ge-fieldnav') &&
       !!document.querySelector('.ge-canvas svg, .ge-canvas canvas')`,
    );
    if (graphReady1) break;
  }
  await sleep(1200); // 力导布局落定后再交互，与步 28 同款缓冲

  // e：controller 存活哨兵②——点术语层「显示」钮，active 钮须真落到 data-term-mode="shown"。
  // 整页重载后是全新 JS 上下文，先重装哨兵装置（__graphRender 包装守卫防重复包装；
  // kb:graphlocate 计数器须随上下文一并重建，供 f 子项复验），整轮「显示→隐藏」后
  // 再复验重建计数恒 0：setTermLayer 的内部重建不经 window.__graphRender 入口，
  // controller 存活时该计数在纯页内交互下应纹丝不动。
  await win.webContents.executeJavaScript(
    `(() => {
       if (typeof window.__smokeOrigGraphRender === 'undefined') {
         window.__smokeOrigGraphRender = window.__graphRender;
       }
       window.__smokeRenderCalls = 0;
       window.__graphRender = function (...args) {
         window.__smokeRenderCalls += 1;
         // A.0（阶段5.10 波A）：顺手把 controller 捞到 window.__smokeCtl。
         // renderGraph 返回 Promise<GraphController>，故经 .then 透传、不改调用方语义；
         // 后续步骤据此直接调 getTransform()/syncSize()/getTermLayer() 做相机守恒与
         // 竞态存活断言，无须再从页面脚本的闭包里翻 controller。
         return window.__smokeOrigGraphRender.apply(this, args).then((c) => {
           window.__smokeCtl = c;
           return c;
         });
       };
       window.__smokeLocate = { count: 0, lastSlug: null };
       document.addEventListener('kb:graphlocate', (ev) => {
         window.__smokeLocate.count += 1;
         window.__smokeLocate.lastSlug = ev && ev.detail ? ev.detail.slug : null;
       });
       return true;
     })()`,
  );
  await win.webContents.executeJavaScript(
    `document.querySelector('.ge-term-btn[data-term-mode="shown"]').click()`,
  );
  await sleep(1800);
  const termShown = await win.webContents.executeJavaScript(
    `(() => { const b = document.querySelector('.ge-term-btn.active'); return b ? b.dataset.termMode : null; })()`,
  );
  // 复原：切回「隐藏」，避免污染离线报告前的收尾截图基线与后续 f/g 两项的判定基准
  await win.webContents.executeJavaScript(
    `document.querySelector('.ge-term-btn[data-term-mode="hidden"]').click()`,
  );
  await sleep(1800);
  const termRestored = await win.webContents.executeJavaScript(
    `(() => { const b = document.querySelector('.ge-term-btn.active'); return b ? b.dataset.termMode : null; })()`,
  );
  const termRenderCalls = await win.webContents.executeJavaScript(
    `window.__smokeRenderCalls`,
  );
  const termOk =
    termShown === "shown" && termRestored === "hidden" && termRenderCalls === 0;

  // f：隐藏书条目同样直达文档——63-规范性文件制定管理办法 属 GRAPH_HIDDEN_BOOKS 五部之一
  //（不进图谱视图），但目录条目仍是普通链接：点击 SPA 落地该书首页，kb:graphlocate 恒 0。
  // 原「预检拦截提示」断言随定位链路撤销一并删除（EXPLORER_LOCATE_MISS 已不存在）
  await win.webContents.executeJavaScript(
    `document.querySelector('.explorer-ul a[data-for="63-规范性文件制定管理办法/index"]').click()`,
  );
  await sleep(1200);
  const afterBookNav = await win.webContents.executeJavaScript(
    `({
       path: decodeURIComponent(location.pathname),
       title: document.title,
       locateCount: window.__smokeLocate.count,
     })`,
  );
  const bookOk =
    // 书夹链接经 simplifySlug 剥掉 index 段后保留尾斜杠（文件条目无段可剥、无尾斜杠）
    afterBookNav.path === "/63-规范性文件制定管理办法/" &&
    afterBookNav.title.includes("规范性文件制定和管理办法") &&
    afterBookNav.locateCount === 0;

  // 再回图谱总览页做状态条自动消失与过滤联动两组页内断言
  await win.loadURL(`${base}/0-图谱总览/`);
  let graphReady2 = false;
  for (let i = 0; i < 30; i += 1) {
    await sleep(500);
    graphReady2 = await win.webContents.executeJavaScript(
      `!!document.querySelector('.ge-fieldnav') &&
       !!document.querySelector('.ge-canvas svg, .ge-canvas canvas')`,
    );
    if (graphReady2) break;
  }
  await sleep(1200);

  // 状态条自动消失（阶段5.4 新增）：搜索框输入不存在的词回车 → 「未找到含…」出现 →
  // STATUS_AUTO_CLEAR_MS=4000 到点自动清空；观察窗取 4.5s（≥4s + 500ms 余量），不压缩
  // 以免 flaky。命中词取 slug 与标题都不可能包含的串，确保走未命中分支。
  const MISS_QUERY = "绝不存在的检索词zzz9";
  await win.webContents.executeJavaScript(
    `(() => {
       const input = document.querySelector('.ge-search-input');
       input.value = ${JSON.stringify(MISS_QUERY)};
       input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
       return true;
     })()`,
  );
  let missStatus = "";
  for (let i = 0; i < 15; i += 1) {
    await sleep(200);
    missStatus = await win.webContents.executeJavaScript(
      `(document.querySelector('.ge-search-status') || {}).textContent || ""`,
    );
    if (missStatus.includes("未找到")) break;
  }
  await sleep(4500);
  const statusCleared = await win.webContents.executeJavaScript(
    `(document.querySelector('.ge-search-status') || {}).textContent || ""`,
  );
  const statusAutoOk =
    missStatus.includes("未找到") &&
    statusCleared.includes(MISS_QUERY) === false &&
    statusCleared === "";

  // g：过滤联动——点「商标」后左栏六个 synthetic:CN/<field> 分支 li 只留商标可见
  //（hidden 属性 + computed display 双查），点 .ge-reset 后六支全部恢复可见
  await win.webContents.executeJavaScript(
    `document.querySelector('.ge-field-tab[data-field="商标"]').click()`,
  );
  await sleep(800);
  const branchAfterTm = await win.webContents.executeJavaScript(
    `${JSON.stringify(FIELD_ROWS)}.map((f) => {
       const c = document.querySelector(
         '.folder-container[data-synthetic="true"][data-folderpath="synthetic:CN/' + f + '"]',
       );
       const li = c ? c.closest('li') : null;
       return {
         field: f,
         found: !!li,
         hidden: li ? li.hidden : null,
         display: li ? getComputedStyle(li).display : null,
       };
     })`,
  );
  const branchTmOk =
    branchAfterTm.length === 6 &&
    branchAfterTm.every((b) => {
      if (!b.found) return false;
      const wantHidden = b.field !== "商标";
      return (
        b.hidden === wantHidden && (wantHidden ? b.display === "none" : b.display !== "none")
      );
    });
  await win.webContents.executeJavaScript(`document.querySelector('.ge-reset').click()`);
  await sleep(800);
  const branchAfterReset = await win.webContents.executeJavaScript(
    `${JSON.stringify(FIELD_ROWS)}.map((f) => {
       const c = document.querySelector(
         '.folder-container[data-synthetic="true"][data-folderpath="synthetic:CN/' + f + '"]',
       );
       const li = c ? c.closest('li') : null;
       return { field: f, hidden: li ? li.hidden : null };
     })`,
  );
  const branchResetOk =
    branchAfterReset.length === 6 && branchAfterReset.every((b) => b.hidden === false);

  await shot(win, "图谱目录直达与controller存活");

  // h：首页一致性抽查——阶段5.4 定位联动全站撤销后，图谱页与非图谱页的目录点击
  // 行为已一致（均 SPA 直达文档），原「非图谱页不触发定位」对照门退化为轻量
  // 一致性抽查：首页点同一条目照常跳转、kb:graphlocate 恒 0，目录树无过滤残留
  //（li[hidden] 恒 0——首页从未收到过 kb:graphfield，也没有 bindGraphLinkage 写它）
  await win.loadURL(`${base}/`);
  await sleep(800);
  await win.webContents.executeJavaScript(
    `(() => {
       window.__smokeHomeLocate = 0;
       document.addEventListener('kb:graphlocate', () => { window.__smokeHomeLocate += 1; });
       return true;
     })()`,
  );
  await win.webContents.executeJavaScript(
    `document.querySelector('.explorer-ul a[data-for="1-专利法/1-总则/law-01-01"]').click()`,
  );
  await sleep(900);
  const homeAfter = await win.webContents.executeJavaScript(
    `({
       path: decodeURIComponent(location.pathname),
       locateCount: window.__smokeHomeLocate,
       hiddenLi: document.querySelectorAll('.explorer-ul li[hidden]').length,
     })`,
  );
  const homeOk =
    homeAfter.path === "/1-专利法/1-总则/law-01-01" &&
    homeAfter.locateCount === 0 &&
    homeAfter.hiddenLi === 0;

  // i：SPA 软导航落地后折叠钮仍然可用（阶段5.6 目录树 DOM 复用新增的覆盖点）
  //    上一句的点击是 SPA 软导航，目录树自此走「复用已建 DOM + 增量更新」那条路径：
  //    折叠监听在**建树时绑定一次且刻意不登记 window.addCleanup**（节点跨导航存活）。
  //    若有人把它改回「每次 nav 重绑 + cleanup 摘除」的旧写法，复用路径不再重绑，
  //    整棵目录树会当场失去折叠能力——而本步此前所有折叠断言都跑在 loadURL 之后的
  //    重建路径上，恰好照绿不报。取一个默认折叠、且不含当前页的书目录（其展开态
  //    不受「当前页祖先强制展开」干扰），折叠再展开、状态复原，不留痕迹。
  const REUSE_FOLDER = '.folder-container[data-folderpath="2-专利法实施细则/index"]';
  const reuseToggle = await win.webContents.executeJavaScript(
    `(async () => {
       const c = document.querySelector('.explorer-ul ${REUSE_FOLDER}');
       if (!c || !c.nextElementSibling) return { found: false };
       const outer = c.nextElementSibling;
       const before = outer.classList.contains('open');
       const hit = () => c.querySelector('.folder-icon')
         .dispatchEvent(new MouseEvent('click', { bubbles: true }));
       hit();
       await new Promise((r) => setTimeout(r, 250));
       const mid = outer.classList.contains('open');
       hit();
       await new Promise((r) => setTimeout(r, 250));
       return { found: true, before, mid, after: outer.classList.contains('open') };
     })()`,
  );
  const reuseToggleOk =
    reuseToggle.found === true &&
    reuseToggle.mid === !reuseToggle.before &&
    reuseToggle.after === reuseToggle.before;

  record(
    "图谱页目录直达文档＋书下 3 层展开＋提示自动消失＋controller 存活（初始展开规模与 fileTree 双键隔离 / 目录点击 SPA 落地含隐藏书 / 术语显隐钮存活 / 状态条 4s 自动消失 / 法域↔目录过滤联动 / 首页一致性抽查）",
    expandOk &&
      isolationOk &&
      navOk &&
      graphReady1 &&
      termOk &&
      bookOk &&
      graphReady2 &&
      statusAutoOk &&
      branchTmOk &&
      branchResetOk &&
      homeOk &&
      reuseToggleOk,
    `初始展开：.folder-outer.open=${expandProbe.open}/${expandProbe.total}（须 ≥1000）; ` +
      `fileTree 隔离：折叠再展开后 v2 逐字节不变=${isolationProbe.v2After === v2Before}, graph 键存在=${!!isolationProbe.graphKey}; ` +
      `a-d 目录直达：落地 path=${afterNav.path}, title="${afterNav.title}", kb:graphlocate=${afterNav.locateCount} 次（恒 0）, ` +
      `落地页 .ge-panel 存在=${afterNav.panelExists}（须 false）, 点击瞬间重建计数=${navClickSnap.callsAtClick}（哨兵①·同步快照）; ` +
      `e 术语钮：点「显示」后=${termShown}（须 shown，哨兵②）, 复原后=${termRestored}, 页内交互重建计数=${termRenderCalls}（恒 0）; ` +
      `f 隐藏书直达：落地 path=${afterBookNav.path}, title="${afterBookNav.title}", kb:graphlocate=${afterBookNav.locateCount} 次; ` +
      `状态条自动消失：回车后="${missStatus}" → 4.5s 后="${statusCleared}"（须空）; ` +
      `g 过滤：点「商标」后=${JSON.stringify(branchAfterTm)}；重置后六支 hidden=${JSON.stringify(branchAfterReset.map((b) => b.hidden))}；` +
      `h 首页抽查：跳转后 path=${homeAfter.path}, kb:graphlocate=${homeAfter.locateCount} 次, li[hidden]=${homeAfter.hiddenLi}; ` +
      `i SPA 落地后折叠钮：目标在场=${reuseToggle.found}, open ${reuseToggle.before}→${reuseToggle.mid}→${reuseToggle.after}（须翻转后复原）`,
  );

  // ============ 阶段5.6 波2 新增一步（30）============

  // 30. 图谱首帧零标签光栅化 + SPA 往返命中组装缓存与坐标播种
  //     两类断言分工明确：
  //     ① 结构断言（硬失败）——不随机器快慢漂移，是波1/波2 两项机制的存活证明：
  //        · firstFrameVisibleLabels === 0：波1-1.2 标签渲染门控。首帧 k≈0.05–0.2 使
  //          scaleOpacity 恒为 0，本就没有一个标签该显示；该值一旦非 0，说明门控被
  //          绕开（例如有人给 label.visible 开了第二条通路），6,202 个 Text 会在首帧
  //          全部 canvas 光栅化——那正是首次 render 2.0s 的病灶。
  //        · assemblyCacheHit && layoutSeeded：波2-2.2 模块级组装缓存与坐标播种。
  //          两者同时为真，才说明「二次打开跳过了全部组装趟、且没有再跑同步预热」。
  //     ② 时间断言（宽熔断）——SPA 二次打开 total < 1200ms。取值刻意远离实测中位
  //        （约 250ms）：本步的职责是抓「机制失效导致的塌方」，不是守护性能指标，
  //        指标的对照留给 /tmp 下的采数探针。CI 机器慢一倍也不会误报。
  //
  //     ⚠️ 返回图谱页必须走 SPA 软导航，不能用 loadURL：硬跳转新建 JS 上下文，
  //     模块级 assemblyCache 随之清空，cacheHit 恒 false，本步的断言就永远绿不了
  //     （或永远红）。条文页的目录树里没有图谱总览条目（GRAPH_EXCLUDE 只作用于图谱
  //     数据集，但该页本就不在 explorer 的可见树内），无从「点回去」，故用
  //     history.back() 触发 popstate——spa.inline.ts 对它的处理与点击链接同一条路径。
  //     哨兵沿用步 29e 所建，本步不重复安装（loadURL 已换上下文，也无从沿用计数值）。
  await win.loadURL(`${base}/0-图谱总览/`);
  let graphReady30 = false;
  for (let i = 0; i < 40; i += 1) {
    await sleep(500);
    graphReady30 = await win.webContents.executeJavaScript(
      `!!document.querySelector('.ge-fieldnav') &&
       !!document.querySelector('.ge-canvas canvas')`,
    );
    if (graphReady30) break;
  }
  // 埋点最新一条全量图记录；firstFrame 尚未落定时返回 null，由调用侧轮询
  const READ_GRAPH_MARK = `(() => {
     const p = window.__graphPerf;
     if (!p || !p.marks) return null;
     const full = p.marks.filter((m) => m.fullGraph);
     const m = full[full.length - 1];
     if (!m || m.firstFrame === null) return null;
     return {
       total: m.total,
       labels1st: m.firstFrameVisibleLabels,
       cacheHit: m.assemblyCacheHit,
       seeded: m.layoutSeeded,
       layoutSource: m.layoutSource,
       prewarmMs: m.prewarmed - m.nodesBuilt,
       termHidden: m.termHidden,
       nodes: m.nodeCount,
     };
   })()`;
  const waitGraphMark = async () => {
    for (let i = 0; i < 40; i += 1) {
      const m = await win.webContents.executeJavaScript(READ_GRAPH_MARK);
      if (m) return m;
      await sleep(300);
    }
    return null;
  };
  const hardMark = await waitGraphMark();
  const hardLabelsOk = !!hardMark && hardMark.labels1st === 0;
  // 波3-3.1 追加：硬跳转是新 JS 上下文，模块级 assemblyCache 必空，坐标只可能来自
  // 构建期产物 static/graphLayout.json。该值一旦退回 "prewarm"，说明产物缺失、key
  // 不匹配或节点覆盖不全（三者都会静默回落，功能不坏但首开又要多付约 230ms 预热），
  // 正是本断言要抓的那类无声失效。
  const hardPrebuiltOk = !!hardMark && hardMark.layoutSource === "prebuilt";

  // 力导预热后的基线快照要等实例销毁（SPA 离开图谱页）或自然收敛才写回缓存；
  // 此处只需给首帧之后的渲染留出落定时间，销毁写回由下一步的软导航触发
  await sleep(1500);

  // 图谱页 →（点目录条目）→ 条文页：SPA 软导航，模块缓存存活
  await win.webContents.executeJavaScript(
    `document.querySelector('.explorer-ul a[data-for="1-专利法/1-总则/law-01-01"]').click()`,
  );
  await sleep(1500);
  const leftGraph = await win.webContents.executeJavaScript(
    `decodeURIComponent(location.pathname)`,
  );
  // 清空埋点后再返回，确保读到的是「二次打开」那一条而非首开残留
  await win.webContents.executeJavaScript(
    `(() => { if (window.__graphPerf) window.__graphPerf.marks.length = 0; return true; })()`,
  );
  await win.webContents.executeJavaScript(`history.back()`);
  await sleep(1200);
  const spaMark = await waitGraphMark();
  const backPath = await win.webContents.executeJavaScript(
    `decodeURIComponent(location.pathname)`,
  );
  const spaStructOk =
    !!spaMark &&
    spaMark.cacheHit === true &&
    spaMark.seeded === true &&
    // 波3-3.1 追加：模块级快照优先于构建期产物——二次打开必须走 "cache"。
    // 若这里读到 "prebuilt"，说明快照写回（simulation "end" / destroyInstance 两处
    // saveAssemblySnapshot）失灵，坐标退化成「每次都是构建期那一版」，
    // 用户离开前的布局与拖动结果不再延续。
    spaMark.layoutSource === "cache" &&
    spaMark.labels1st === 0;
  const spaTimeOk = !!spaMark && spaMark.total < 1200;

  // 阶段5.7 波A-A2 追加子断言：图谱索引悬空内链恒零。
  // 取数复用页面上已解析完的 window.__graphIndex（图谱页此刻必已消费过它，是同一个
  // 共享 Promise），不另发 fetch——本冒烟全程离线护栏之下，多打一次请求既无必要，
  // 也会让「外部请求恒 0」之外的请求账变得难以对照。
  // 判据与构建期 contentIndex.tsx 的过滤逐字同源：links 的每个目标都必须落在
  // 「本批全部 slug 的 simplifySlug 全集」内。该值一旦非 0，说明过滤失效或被绕开，
  // 产物里重新混进了指向不存在页面的边（当前语料实测应滤除 30 条，产物侧恒 0）。
  const danglingProbe = await win.webContents.executeJavaScript(`
    (async () => {
      const idx = await window.__graphIndex;
      // simplifySlug 的等价实现：去掉 index 后缀、只剥前缀斜杠
      //（尾斜杠是容器页标记，必须保留，否则容器 slug 全部对不上）
      const simplify = (fp) => {
        let r = fp.endsWith("index") ? fp.slice(0, -5) : fp;
        if (r.startsWith("/")) r = r.slice(1);
        return r.length === 0 ? "/" : r;
      };
      const all = new Set(Object.keys(idx).map(simplify));
      let dangling = 0;
      let links = 0;
      const samples = [];
      for (const [slug, d] of Object.entries(idx)) {
        for (const dest of d.links || []) {
          links += 1;
          if (!all.has(dest)) {
            dangling += 1;
            if (samples.length < 3) samples.push(simplify(slug) + " -> " + dest);
          }
        }
      }
      return { entries: Object.keys(idx).length, links, dangling, samples };
    })()
  `);
  const danglingOk = !!danglingProbe && danglingProbe.dangling === 0;

  await shot(win, "图谱缓存命中与坐标播种");

  record(
    "图谱首帧零标签光栅化＋首开命中构建期坐标＋SPA 往返命中组装缓存与坐标播种＋图谱索引悬空内链恒零（结构断言硬失败：firstFrameVisibleLabels=0 / 首开 layoutSource=prebuilt / 二开 assemblyCacheHit+layoutSeeded+layoutSource=cache / contentIndexGraph 悬空链=0；时间宽熔断：二次打开 total<1200ms）",
    graphReady30 &&
      hardLabelsOk &&
      hardPrebuiltOk &&
      leftGraph === "/1-专利法/1-总则/law-01-01" &&
      backPath === "/0-图谱总览/" &&
      spaStructOk &&
      spaTimeOk &&
      danglingOk,
    `直开图谱：就绪=${graphReady30}, 首帧可见标签=${hardMark ? hardMark.labels1st : "无记录"}（须 0）, ` +
      `节点数=${hardMark ? hardMark.nodes : "-"}, 首开 cacheHit=${hardMark ? hardMark.cacheHit : "-"}（须 false，硬跳转无模块缓存）, ` +
      `首开 layoutSource=${hardMark ? hardMark.layoutSource : "-"}（须 prebuilt）, ` +
      `首开 prewarmMs=${hardMark ? hardMark.prewarmMs.toFixed(1) : "-"}ms; ` +
      `SPA 离开落地=${leftGraph}, popstate 返回落地=${backPath}; ` +
      `二次打开：cacheHit=${spaMark ? spaMark.cacheHit : "无记录"}（须 true）, ` +
      `layoutSeeded=${spaMark ? spaMark.seeded : "-"}（须 true）, ` +
      `layoutSource=${spaMark ? spaMark.layoutSource : "-"}（须 cache）, ` +
      `首帧可见标签=${spaMark ? spaMark.labels1st : "-"}（须 0）, ` +
      `total=${spaMark ? spaMark.total.toFixed(1) : "-"}ms（宽熔断 <1200ms）; ` +
      `图谱索引：条目=${danglingProbe ? danglingProbe.entries : "无记录"}, ` +
      `links=${danglingProbe ? danglingProbe.links : "-"}, ` +
      `悬空链=${danglingProbe ? danglingProbe.dangling : "-"}（须 0）` +
      `${danglingProbe && danglingProbe.samples.length > 0 ? `, 样例=${danglingProbe.samples.join(" | ")}` : ""}`,
  );

  // ============ 阶段5.7 波A 新增两步（31、32）============

  // 31. 局部图截断上限 60→120（波A-A1）
  //     两侧同时守：上限确已抬到 120（31a），且没有被抬过头或改成不截断（31b 的下界）。
  //     · 31a：term-0028 的一跳邻居实测 247（远超上限），故必截断——徽标文本须为
  //       「已显示 120/247 个关联」，且埋点节点数须恰为 121（120 个邻居 + 中心节点）。
  //     · 31b：law-01-18 的一跳邻居实测 95，落在旧上限 60 与新上限 120 之间——
  //       它在改造前会被截断、改造后必须完整显示。故断言无徽标且节点数 ≥62：
  //       「≥62」排除的是「上限仍为 60」（那样节点数恰 61），与 31a 的 121 一上一下
  //       把上限锁死在 120；不写死 96 是为了不让语料的正常增删把本步变成脆断。
  //     ⚠️ 目标页必须是普通文档页：容器页（如 1-专利法/）的产物 HTML 里没有
  //       .graph-container，根本不渲染局部图，拿它做本步的载体会恒红。
  const READ_LOCAL_MARK = `(() => {
     const p = window.__graphPerf;
     if (!p || !p.marks) return null;
     // 文档页可能同时存在局部图（.graph-container，depth:1）与全局图弹窗（depth:-1）
     // 两类记录，必须按 fullGraph 分流后取局部图的最后一条，否则读到的是另一张图。
     const local = p.marks.filter((m) => !m.fullGraph);
     const m = local[local.length - 1];
     if (!m || m.firstFrame === null) return null;
     return {
       nodes: m.nodeCount,
       links: m.linkCount,
       labels1st: m.firstFrameVisibleLabels,
       // 阶段5.10 波B：分流谓词回读。拖拽手感三参数（velocityDecay/alphaTarget/
       // 松手停机）全部按 fullGraph 分流，且只许改局部图那一路；此处断言严格 === false
       //（而非上面 filter 的宽松 !m.fullGraph）以确保该字段确为布尔假、不是 undefined
       // ——谓词若因改动退化成缺失值，filter 照样放行，断言才拦得住。
       full: m.fullGraph,
     };
   })()`;
  const READ_BADGE = `(() => {
     const b = document.querySelector('.graph-truncation-note');
     return b ? b.textContent : null;
   })()`;
  const openLocalGraph = async (url) => {
    await win.loadURL(url);
    let ready = false;
    for (let i = 0; i < 40; i += 1) {
      await sleep(300);
      ready = await win.webContents.executeJavaScript(
        `!!document.querySelector('.graph-container canvas')`,
      );
      if (ready) break;
    }
    let mark = null;
    for (let i = 0; i < 40; i += 1) {
      mark = await win.webContents.executeJavaScript(READ_LOCAL_MARK);
      if (mark) break;
      await sleep(300);
    }
    const badge = await win.webContents.executeJavaScript(READ_BADGE);
    return { ready, mark, badge };
  };

  const a31 = await openLocalGraph(
    `${base}/9-关键词索引/01-新颖性/term-0028`,
  );
  const a31Ok =
    a31.ready &&
    a31.badge === "已显示 120/247 个关联" &&
    !!a31.mark &&
    a31.mark.nodes === 121 &&
    a31.mark.full === false;
  await shot(win, "局部图截断上限120-超限页");

  const b31 = await openLocalGraph(`${base}/1-专利法/1-总则/law-01-18`);
  const b31Ok =
    b31.ready &&
    b31.badge === null &&
    !!b31.mark &&
    b31.mark.nodes >= 62 &&
    b31.mark.full === false;
  await shot(win, "局部图截断上限120-未超限页");

  record(
    "局部图截断上限 60→120（超限页徽标 120/247 且节点数 121；旧上限下会被截断的 95 邻居页现无徽标且节点数 ≥62）＋局部图页 fullGraph 谓词恒 false（波B 拖拽参数分流前提）",
    a31Ok && b31Ok,
    `term-0028（邻居 247，必截断）：就绪=${a31.ready}, 徽标=${a31.badge === null ? "无" : `「${a31.badge}」`}（须「已显示 120/247 个关联」）, ` +
      `节点数=${a31.mark ? a31.mark.nodes : "无记录"}（须 121＝120 邻居+中心）, 边数=${a31.mark ? a31.mark.links : "-"}, ` +
      `fullGraph=${a31.mark ? String(a31.mark.full) : "-"}（须 false）; ` +
      `law-01-18（邻居 95，旧上限 60 下会截断）：就绪=${b31.ready}, 徽标=${b31.badge === null ? "无" : `「${b31.badge}」`}（须无）, ` +
      `节点数=${b31.mark ? b31.mark.nodes : "无记录"}（须 ≥62，排除上限仍为 60 的 61）, ` +
      `fullGraph=${b31.mark ? String(b31.mark.full) : "-"}（须 false）`,
  );

  // 32. 图谱总览画布尺寸同步（波A-A3）
  //     渲染器的宽高是 createGraphInstance 里的一次性 const 快照，全仓无 renderer.resize；
  //     .ge-canvas 却会被同页内的布局变化改尺寸——点法域标签使非本域图例项 hidden 撤出
  //     布局流、工具栏折行减少而画布变高（下边缘露底），右栏 .ge-panel 显隐则改画布宽度
  //     （右侧露白）。A3 给容器装了 ResizeObserver（400ms 防抖 + crossfade 淡入重建），
  //     本步守的就是「容器变了、画布跟得上」。
  //     ⚠️ 量测口径必须是容器 offsetWidth/Math.max(offsetHeight,250) 对画布的
  //       getBoundingClientRect：前者与 graph.inline.ts 的尺寸快照逐字同源；若改用
  //       clientWidth，会因 .ge-canvas 的 1px 边框（全局 border-box）恒差 2px 而永远误红。
  //     ⚠️ 取画布须取容器内**最后一个** canvas：crossfade 期间旧画布留在容器里充当
  //       淡入底图（position:absolute），取第一个会读到即将退场的旧尺寸。
  //     b/c/d 三项只在视口宽 ≥1200px（$desktop 断点，画布与右栏并排）时断言——窄屏
  //     是纵向堆叠，右栏显隐不改画布宽度，那几项本就不适用。
  const MEASURE_CANVAS = `(() => {
     const box = document.querySelector('.ge-canvas');
     if (!box) return null;
     const list = box.querySelectorAll('canvas');
     const cv = list[list.length - 1];
     if (!cv) return null;
     const r = cv.getBoundingClientRect();
     const panel = document.querySelector('.ge-panel');
     return {
       boxW: box.offsetWidth,
       boxH: Math.max(box.offsetHeight, 250),
       cvW: Math.round(r.width * 100) / 100,
       cvH: Math.round(r.height * 100) / 100,
       canvases: list.length,
       panelHidden: panel ? panel.hidden : null,
       viewportW: document.documentElement.clientWidth,
     };
   })()`;
  const fitsBox = (m) =>
    !!m && Math.abs(m.cvW - m.boxW) <= 1 && Math.abs(m.cvH - m.boxH) <= 1;
  const fmtBox = (m) =>
    m
      ? `容器 ${m.boxW}×${m.boxH} / 画布 ${m.cvW}×${m.cvH}（Δ宽 ${(m.cvW - m.boxW).toFixed(2)}, Δ高 ${(m.cvH - m.boxH).toFixed(2)}）`
      : "无量测";

  await win.loadURL(`${base}/0-图谱总览/`);
  let graphReady32 = false;
  for (let i = 0; i < 40; i += 1) {
    await sleep(500);
    graphReady32 = await win.webContents.executeJavaScript(
      `!!document.querySelector('.ge-fieldnav') &&
       !!document.querySelector('.ge-canvas canvas')`,
    );
    if (graphReady32) break;
  }
  await sleep(1200); // 力导落定，与步 28/29 同款缓冲

  // a. 基线：初始态画布与容器同尺寸
  const m32a = await win.webContents.executeJavaScript(MEASURE_CANVAS);
  const wide32 = !!m32a && m32a.viewportW >= 1200;
  const a32Ok = fitsBox(m32a);

  // b. 点「商标」法域标签 → 图例行收窄、工具栏折行减少 → 容器变高
  //    等待 2s：400ms RO 防抖 + 约 230ms 重建 + 260ms 淡入，另留余量
  await win.webContents.executeJavaScript(
    `document.querySelector('.ge-field-tab[data-field="商标"]').click()`,
  );
  await sleep(2000);
  const m32b = await win.webContents.executeJavaScript(MEASURE_CANVAS);
  const b32Ok = !wide32 || fitsBox(m32b);
  await shot(win, "画布尺寸同步-法域商标");

  // c. 点回「全部」→ 容器变回原高，画布须再次跟上
  await win.webContents.executeJavaScript(
    `document.querySelector('.ge-field-tab[data-field="*"]').click()`,
  );
  await sleep(2000);
  const m32c = await win.webContents.executeJavaScript(MEASURE_CANVAS);
  const c32Ok = !wide32 || fitsBox(m32c);

  // d. 右栏面板显现 → 画布变窄。直接向 .graph-explorer 派发 graphnodeselect
  //    （panel 模式下图内点击本就是自 canvas 冒泡到这里的同一事件），dbl:true 走
  //    「切换选中 + 展示右栏」分支，比模拟画布坐标点击稳定得多。
  await win.webContents.executeJavaScript(
    `document.querySelector('.graph-explorer').dispatchEvent(
       new CustomEvent('graphnodeselect', { detail: { slug: '1-专利法/', dbl: true } }),
     )`,
  );
  await sleep(2000);
  const m32d = await win.webContents.executeJavaScript(MEASURE_CANVAS);
  const d32Ok = !wide32 || (fitsBox(m32d) && m32d.panelHidden === false);
  await shot(win, "画布尺寸同步-右栏显现");

  record(
    "图谱总览画布尺寸同步（容器 ResizeObserver 重建：基线／法域标签收窄／回全部／右栏显现四态下画布与容器差 ≤1px）",
    graphReady32 && a32Ok && b32Ok && c32Ok && d32Ok,
    `视口宽=${m32a ? m32a.viewportW : "-"}px（${wide32 ? "≥1200，b/c/d 全断言" : "<1200，窄屏纵向堆叠，b/c/d 不适用已跳过"}）; ` +
      `a 基线：${fmtBox(m32a)}; ` +
      `b 点「商标」后：${fmtBox(m32b)}; ` +
      `c 回「全部」后：${fmtBox(m32c)}; ` +
      `d 右栏显现后：${fmtBox(m32d)}，panel.hidden=${m32d ? m32d.panelHidden : "-"}（须 false）`,
  );

  // ============ 阶段5.7 波B 新增一步（33）============

  // 33. 图谱总览目录导航抽屉（波B）
  //     沿用步 32 已加载的图谱总览页，不再 loadURL——本步与步 32 同处一个上下文，
  //     且刻意依赖它遗留的两个状态：法域=「全部」、右栏已显现。后者尤其要紧：
  //     右栏若在本步中途才首次显现，会改变 .ge-canvas 宽度并触发波A 的 RO 重建，
  //     33-c 的「重建计数增量 0」就会被这条无关的重建污染，从而失去意义。
  //     九项分工：
  //       a 结构（SSR 骨架在场、初始收起、树为空壳——惰性未被写坏的凭据）
  //       b 首次点开：树可见耗时 + 法域行 6 / 书行 83
  //       c 点目录行 = selectNode：右栏标题真实转移 **且 __graphRender 计数增量 0**
  //         （增量非 0 即说明走了重建兜底，那是 700ms 的全量重建，不是 focus 定位）
  //       d 展开一本书：章行数与 __graphIndex 现算一致（不写死，随语料增删自适应）
  //       e 置灰联动：点「商标」后，data-group 不属 {8,15} 的行全部 dimmed；回「全部」全亮
  //       f 存活守门（R6）：两次法域切换各触发一次 RO 重建后，抽屉仍在、83 书行未被清
  //         ——抽屉挂在 .ge-body 而非 .ge-canvas，正是为了躲开重建时的 removeAllChildren
  //       g 尺寸中立：抽屉开→关→开，.ge-canvas 尺寸逐像素不动（脱流的凭据）
  //       h 钉住持久化：reload 后抽屉仍展开
  //       i 收尾复位 removeItem（硬性，同步骤 24 主题复位规约，防污染用户 localStorage）
  const TOC_STATS = `(() => {
     const root = document.querySelector('.ge-toc');
     if (!root) return null;
     const drawer = root.querySelector('.ge-toc-drawer');
     const toggle = root.querySelector('.ge-toc-toggle');
     const pin = root.querySelector('.ge-toc-pin');
     const tree = root.querySelector('.ge-toc-tree');
     const rows = tree ? Array.from(tree.querySelectorAll('.ge-toc-row')) : [];
     const withGroup = rows.filter((r) => r.dataset.group !== undefined);
     const dim = withGroup.filter((r) => r.classList.contains('ge-toc-row--dimmed'));
     const lit = withGroup.filter((r) => !r.classList.contains('ge-toc-row--dimmed'));
     const uniq = (list) => [...new Set(list.map((r) => r.dataset.group))].sort();
     let stored = 'ERR';
     try { stored = localStorage.getItem('graph-toc-pinned'); } catch (e) { stored = 'ERR'; }
     return {
       drawerHidden: drawer ? drawer.hidden : null,
       expanded: toggle ? toggle.getAttribute('aria-expanded') : null,
       pinned: pin ? pin.getAttribute('aria-pressed') : null,
       stored: stored,
       fields: rows.filter((r) => r.classList.contains('ge-toc-row--field')).length,
       rows: rows.length,
       books: withGroup.filter((r) => r.dataset.level === '1').length,
       dimmed: dim.length,
       dimmedGroups: uniq(dim),
       litGroups: uniq(lit),
     };
   })()`;
  const MEASURE_TOC_BOX = `(() => {
     const b = document.querySelector('.ge-canvas');
     return b ? { w: b.offsetWidth, h: b.offsetHeight } : null;
   })()`;
  const READ_RENDER_CALLS = `window.__smokeRenderCalls`;
  const fmtToc = (s) =>
    s
      ? `法域行 ${s.fields} / 书行 ${s.books} / 总行 ${s.rows}，drawer.hidden=${s.drawerHidden}，置灰 ${s.dimmed}`
      : "无量测";

  // a. 结构：SSR 骨架在场、初始收起、树是空壳（惰性未被写坏）
  const s33a = await win.webContents.executeJavaScript(TOC_STATS);
  const a33Ok =
    !!s33a && s33a.drawerHidden === true && s33a.expanded === "false" && s33a.rows === 0;

  // b. 首次点开：页内自计时（点击 → 首行 DOM 出现），再读结构
  //    轮询用 setTimeout(0) 而非 rAF：后者粒度 16ms，量不出 50ms 门槛内的差别
  const openMs = await win.webContents.executeJavaScript(
    `(async () => {
       const t0 = performance.now();
       document.querySelector('.ge-toc-toggle').click();
       for (let i = 0; i < 400; i += 1) {
         if (document.querySelector('.ge-toc-tree .ge-toc-row')) return performance.now() - t0;
         await new Promise((r) => setTimeout(r, 0));
       }
       return -1;
     })()`,
  );
  await sleep(400);
  const s33b = await win.webContents.executeJavaScript(TOC_STATS);
  const b33Ok =
    !!s33b && s33b.fields === 6 && s33b.books === 83 && s33b.drawerHidden === false;
  await shot(win, "图谱目录抽屉-展开态");

  // c. 点目录行 = selectNode。哨兵在本上下文中重装（步 29 装的那份已随 loadURL 失效），
  //    包装守卫沿用同一形状，避免二次包装叠加计数。
  await win.webContents.executeJavaScript(
    `(() => {
       if (typeof window.__smokeOrigGraphRender === 'undefined') {
         window.__smokeOrigGraphRender = window.__graphRender;
       }
       window.__smokeRenderCalls = 0;
       window.__graphRender = function (...args) {
         window.__smokeRenderCalls += 1;
         // A.0（阶段5.10 波A）：顺手把 controller 捞到 window.__smokeCtl。
         // renderGraph 返回 Promise<GraphController>，故经 .then 透传、不改调用方语义；
         // 后续步骤据此直接调 getTransform()/syncSize()/getTermLayer() 做相机守恒与
         // 竞态存活断言，无须再从页面脚本的闭包里翻 controller。
         return window.__smokeOrigGraphRender.apply(this, args).then((c) => {
           window.__smokeCtl = c;
           return c;
         });
       };
       return typeof window.__smokeOrigGraphRender === 'function';
     })()`,
  );
  // 期望标题一律从索引现取，不写死书名（语料改标题不该让冒烟变脆）
  const tocTitles = await win.webContents.executeJavaScript(
    `(async () => {
       const idx = await window.__graphIndex;
       return {
         guide: idx['3-专利审查指南/index'].title,
         law: idx['1-专利法/index'].title,
       };
     })()`,
  );
  const READ_PANEL = `(() => {
     const t = document.querySelector('.ge-panel-content .ge-title');
     const drawer = document.querySelector('.ge-toc-drawer');
     return {
       title: t ? t.textContent : null,
       drawerHidden: drawer ? drawer.hidden : null,
       calls: window.__smokeRenderCalls,
     };
   })()`;
  // c1：未钉住态点「3-专利审查指南」——标题须从步 32 遗留的「专利法」转移过来，
  //     且抽屉按定案自动收起
  await win.webContents.executeJavaScript(
    `document.querySelector('.ge-toc-link[data-slug="3-专利审查指南/index"]').click()`,
  );
  await sleep(600);
  const c33a = await win.webContents.executeJavaScript(READ_PANEL);
  // c2：重开抽屉 → 钉住 → 点「1-专利法」：标题再次转移，抽屉因钉住而保持展开
  await win.webContents.executeJavaScript(
    `document.querySelector('.ge-toc-toggle').click()`,
  );
  await sleep(200);
  await win.webContents.executeJavaScript(
    `document.querySelector('.ge-toc-pin').click()`,
  );
  await win.webContents.executeJavaScript(
    `document.querySelector('.ge-toc-link[data-slug="1-专利法/index"]').click()`,
  );
  await sleep(600);
  const c33b = await win.webContents.executeJavaScript(READ_PANEL);
  const c33Ok =
    c33a.title === tocTitles.guide &&
    c33a.drawerHidden === true &&
    c33a.calls === 0 &&
    c33b.title === tocTitles.law &&
    c33b.drawerHidden === false &&
    c33b.calls === 0;

  // d. 展开「1-专利法」：章行数须与索引现算一致
  const chapterExpected = await win.webContents.executeJavaScript(
    `(async () => {
       const idx = await window.__graphIndex;
       return Object.keys(idx).filter(
         (s) => s.startsWith('1-专利法/') && s.endsWith('/index') && s.split('/').length === 3,
       ).length;
     })()`,
  );
  await win.webContents.executeJavaScript(
    `(() => {
       const link = document.querySelector('.ge-toc-link[data-slug="1-专利法/index"]');
       link.closest('.ge-toc-row').querySelector('.ge-toc-caret').click();
       return true;
     })()`,
  );
  await sleep(300);
  const d33 = await win.webContents.executeJavaScript(
    `(() => {
       const link = document.querySelector('.ge-toc-link[data-slug="1-专利法/index"]');
       const kids = link.closest('.ge-toc-row').nextElementSibling;
       if (!kids || !kids.classList.contains('ge-toc-children')) return null;
       return {
         built: kids.dataset.built,
         hidden: kids.hidden,
         rows: kids.querySelectorAll(':scope > .ge-toc-row').length,
       };
     })()`,
  );
  const d33Ok =
    !!d33 && d33.built === "1" && d33.hidden === false && d33.rows === chapterExpected;

  // e. 置灰联动 + f 的两次 RO 重建：点「商标」→ 2s（400ms 防抖 + 约 230ms 重建 + 260ms 淡入）
  const callsBeforeField = await win.webContents.executeJavaScript(READ_RENDER_CALLS);
  await win.webContents.executeJavaScript(
    `document.querySelector('.ge-field-tab[data-field="商标"]').click()`,
  );
  await sleep(2000);
  const s33e1 = await win.webContents.executeJavaScript(TOC_STATS);
  await shot(win, "图谱目录抽屉-置灰联动");
  await win.webContents.executeJavaScript(
    `document.querySelector('.ge-field-tab[data-field="*"]').click()`,
  );
  await sleep(2000);
  const s33e2 = await win.webContents.executeJavaScript(TOC_STATS);
  // 商标法域 = 组 8（商标）+ 组 15（商标审查指南）；其余组的行须全部置灰
  const e33Ok =
    !!s33e1 &&
    s33e1.litGroups.join(",") === ["8", "15"].sort().join(",") &&
    s33e1.dimmed > 0 &&
    !!s33e2 &&
    s33e2.dimmed === 0;

  // f. 存活守门（R6）：两次法域切换后抽屉与 83 书行都还在，且确有重建发生过
  const callsAfterField = await win.webContents.executeJavaScript(READ_RENDER_CALLS);
  const rebuilds = callsAfterField - callsBeforeField;
  const f33Ok =
    !!s33e2 && s33e2.drawerHidden === false && s33e2.books === 83 && rebuilds >= 1;

  // g. 尺寸中立：抽屉开→关→开，.ge-canvas 逐像素不动（绝对定位脱流的凭据）
  const g33Open1 = await win.webContents.executeJavaScript(MEASURE_TOC_BOX);
  await win.webContents.executeJavaScript(
    `document.querySelector('.ge-toc-close').click()`,
  );
  await sleep(700);
  const g33Closed = await win.webContents.executeJavaScript(MEASURE_TOC_BOX);
  await win.webContents.executeJavaScript(
    `document.querySelector('.ge-toc-toggle').click()`,
  );
  await sleep(700);
  const g33Open2 = await win.webContents.executeJavaScript(MEASURE_TOC_BOX);
  const g33Ok =
    !!g33Open1 &&
    !!g33Closed &&
    !!g33Open2 &&
    g33Open1.w === g33Closed.w &&
    g33Open1.h === g33Closed.h &&
    g33Open1.w === g33Open2.w &&
    g33Open1.h === g33Open2.h;

  // h. 钉住持久化：整页重载后抽屉仍展开（挂载时 open = pinned）
  await win.webContents.reload();
  let ready33 = false;
  for (let i = 0; i < 40; i += 1) {
    await sleep(500);
    ready33 = await win.webContents.executeJavaScript(
      `!!document.querySelector('.ge-canvas canvas') &&
       document.querySelectorAll('.ge-toc-tree .ge-toc-row').length > 0`,
    );
    if (ready33) break;
  }
  const s33h = await win.webContents.executeJavaScript(TOC_STATS);
  const h33Ok =
    ready33 &&
    !!s33h &&
    s33h.drawerHidden === false &&
    s33h.pinned === "true" &&
    s33h.stored === "true" &&
    s33h.books === 83;
  await shot(win, "图谱目录抽屉-钉住后reload仍展开");

  // i. 收尾复位（硬性）：取消钉住 + removeItem，绝不把偏好留在用户的 localStorage 里
  const s33i = await win.webContents.executeJavaScript(
    `(() => {
       const pin = document.querySelector('.ge-toc-pin');
       if (pin && pin.getAttribute('aria-pressed') === 'true') pin.click();
       try { localStorage.removeItem('graph-toc-pinned'); } catch (e) {}
       let stored = 'ERR';
       try { stored = localStorage.getItem('graph-toc-pinned'); } catch (e) { stored = 'ERR'; }
       return { stored: stored, pinned: pin ? pin.getAttribute('aria-pressed') : null };
     })()`,
  );
  const i33Ok = !!s33i && s33i.stored === null && s33i.pinned === "false";

  record(
    "图谱总览目录导航抽屉（惰性首建 6 法域+83 书行／点行即 selectNode 且零重建／章行数与索引一致／置灰联动／RO 重建后存活／尺寸中立／钉住持久化／收尾复位）",
    a33Ok && b33Ok && c33Ok && d33Ok && e33Ok && f33Ok && g33Ok && h33Ok && i33Ok,
    `a 结构：drawer.hidden=${s33a ? s33a.drawerHidden : "无"}（须 true）, aria-expanded=${s33a ? s33a.expanded : "-"}, 树内行数=${s33a ? s33a.rows : "-"}（须 0，惰性）; ` +
      `b 首开：点开→树可见 ${typeof openMs === "number" ? openMs.toFixed(1) : openMs}ms（目标 ≤50ms）, ${fmtToc(s33b)}（须 6 法域 / 83 书）; ` +
      `c 点行定位：c1「${c33a.title}」（期望「${tocTitles.guide}」）未钉住→drawer.hidden=${c33a.drawerHidden}（须 true）, 重建计数=${c33a.calls}（须 0）; ` +
      `c2「${c33b.title}」（期望「${tocTitles.law}」）钉住→drawer.hidden=${c33b.drawerHidden}（须 false）, 重建计数=${c33b.calls}（须 0）; ` +
      `d 展开 1-专利法：built=${d33 ? d33.built : "-"}, 章行=${d33 ? d33.rows : "-"}（索引现算=${chapterExpected}）; ` +
      `e 置灰：点「商标」后未置灰组=${s33e1 ? JSON.stringify(s33e1.litGroups) : "-"}（须 ["15","8"]）、置灰行=${s33e1 ? s33e1.dimmed : "-"}；回「全部」后置灰行=${s33e2 ? s33e2.dimmed : "-"}（须 0）; ` +
      `f 存活：两次法域切换触发重建 ${rebuilds} 次（须 ≥1），drawer.hidden=${s33e2 ? s33e2.drawerHidden : "-"}, 书行=${s33e2 ? s33e2.books : "-"}（须 83）; ` +
      `g 尺寸中立：开 ${g33Open1 ? g33Open1.w + "×" + g33Open1.h : "-"} → 关 ${g33Closed ? g33Closed.w + "×" + g33Closed.h : "-"} → 开 ${g33Open2 ? g33Open2.w + "×" + g33Open2.h : "-"}（须逐像素等）; ` +
      `h 钉住 reload：就绪=${ready33}, drawer.hidden=${s33h ? s33h.drawerHidden : "-"}（须 false）, pin=${s33h ? s33h.pinned : "-"}, localStorage=${s33h ? s33h.stored : "-"}, 书行=${s33h ? s33h.books : "-"}; ` +
      `i 收尾：取消钉住后 pin=${s33i ? s33i.pinned : "-"}, localStorage=${s33i ? JSON.stringify(s33i.stored) : "-"}（须 null）`,
  );

  // ============ 阶段5.8 新增两步（34–35） ============
  // 页面内公共片段：合成指针事件 + 同级行取数 + 顺序表读取 + 「拖到首位」配方。
  // 以字符串注入各次 executeJavaScript（同 PARSE_COLOR_FN 的做法）。
  // 拖拽配方与步 20 的影子滚动条同源：合成 PointerEvent 优先，因为
  // explorer.inline.ts 的 setPointerCapture 外包了 try/catch（合成指针会抛
  // InvalidPointerId），move/up 一律挂 window，冒泡即可收到。
  const EXPLORER_ORDER_FNS = `
    const mkPtr = (type, x, y) => new PointerEvent(type, {
      bubbles: true, cancelable: true, composed: true,
      clientX: x, clientY: y, pointerId: 1, isPrimary: true,
      pointerType: 'mouse', button: 0, buttons: 1,
    });
    function orderRows(parentKey) {
      const c = document.querySelector('.explorer-ul .folder-container[data-folderpath="' + parentKey + '"]');
      if (!c || !c.nextElementSibling) return [];
      const ul = c.nextElementSibling.querySelector(':scope > ul');
      if (!ul) return [];
      return Array.from(ul.children).filter(
        (li) => li.tagName === 'LI' && !li.classList.contains('overflow-end'),
      );
    }
    function orderKeys(parentKey) {
      return orderRows(parentKey).map((li) => {
        const c = li.querySelector(':scope > .folder-container');
        return c ? c.dataset.folderpath : null;
      });
    }
    function orderTable() {
      try { return JSON.parse(localStorage.getItem('kb-explorer-order:v1') || 'null'); }
      catch (e) { return 'ERR'; }
    }
    function orderInvariants() {
      return {
        hiddenLis: document.querySelectorAll('.explorer-ul li[hidden]').length,
        anchorsInSynthetic: document.querySelectorAll('.explorer-ul [data-synthetic="true"] a').length,
        topLevelCN: !!document.querySelector(
          '.explorer-ul > li > [data-synthetic="true"][data-folderpath="synthetic:CN"]',
        ),
        siblingBroken: Array.from(document.querySelectorAll('.explorer-ul .folder-container')).filter(
          (c) => !(c.nextElementSibling && c.nextElementSibling.classList.contains('folder-outer')),
        ).length,
        handles: document.querySelectorAll('.explorer-drag-handle').length,
        orderables: document.querySelectorAll('.folder-container[data-orderable]').length,
      };
    }
    // 把 parentKey 下第 childIndex 行拖到同级首位。三段式：先移 8px 越过 4px 阈值
    // 并断言真的进入了拖拽态（防「事件派发了但状态机没启动」的空转假绿），
    // 再移到首行矩形内并断言指示线落位，最后抬指落定。
    function dragRowToTop(parentKey, childIndex) {
      const rows = orderRows(parentKey);
      const li = rows[childIndex];
      if (!li || rows.length < 2) return { error: 'rows=' + rows.length + ' idx=' + childIndex };
      const container = li.querySelector(':scope > .folder-container');
      const handle = container.querySelector(':scope > .explorer-drag-handle');
      if (!handle) return { error: 'no handle' };
      const hr = handle.getBoundingClientRect();
      const firstRow = rows[0].querySelector(':scope > .folder-container');
      const cx = hr.left + hr.width / 2;
      const cy = hr.top + hr.height / 2;
      handle.dispatchEvent(mkPtr('pointerdown', cx, cy));
      handle.dispatchEvent(mkPtr('pointermove', cx, cy - 8));
      const engaged = container.classList.contains('is-dragging');
      const globalFlag = document.documentElement.dataset.explorerDrag || null;
      const ty = firstRow.getBoundingClientRect().top + 1;
      handle.dispatchEvent(mkPtr('pointermove', cx, ty));
      const markedFirst = firstRow.classList.contains('is-drop-before');
      const markCount = document.querySelectorAll('.is-drop-before, .is-drop-after').length;
      handle.dispatchEvent(mkPtr('pointerup', cx, ty));
      return {
        engaged, globalFlag, markedFirst, markCount,
        residueDragging: document.querySelectorAll('.folder-container.is-dragging').length,
        residueMarks: document.querySelectorAll('.is-drop-before, .is-drop-after').length,
        residueFlag: document.documentElement.dataset.explorerDrag || null,
      };
    }
  `;
  const evalOrder = (body) =>
    win.webContents.executeJavaScript(`(() => {${EXPLORER_ORDER_FNS}\n${body}})()`);

  // 34. 目录树自定义排序（同级拖拽重排 + 双路径保持 + 恢复默认）
  //     开放重排的只有合成分组层的三层子项（法域行 / docType 行 / 书目行），判据是
  //     explorer.inline.ts 写在行上的 data-orderable（取值即落表用的父键）；顶层三巨头
  //     的父是根、章节层的父是真实目录，两者天然锁死。顺序表是**全站单表**
  //     kb-explorer-order:v1（图谱页与文档站共用同一棵缓存 DOM 树，分双键必然出现
  //     「存了不生效」的幽灵态），故本步收尾必须按步首快照原样复位。
  //     书层靶刻意选 CN/专利/D5（9 本）：D1 组只有 1 本，无从重排，拿它做靶必然假绿。
  //     d 段的 SPA 往返是**复用路径回归门**——手柄监听若被误登记 window.addCleanup，
  //     首次软导航后全站手柄哑火，而只测重建路径的用例会照常全绿，唯有此处能抓到。
  await win.loadURL(`${base}/`);
  let orderReady = false;
  for (let i = 0; i < 20; i += 1) {
    await sleep(300);
    orderReady = await win.webContents.executeJavaScript(
      `document.querySelectorAll('.explorer-ul .folder-container[data-orderable]').length > 0`,
    );
    if (orderReady) break;
  }
  // a. 步首快照（收尾据此复位）+ 默认序基线
  const s34a = await evalOrder(
    `return {
       orderBefore: (function () { try { return localStorage.getItem('kb-explorer-order:v1'); } catch (e) { return 'ERR'; } })(),
       treeBefore: (function () { try { return localStorage.getItem('fileTree-v2'); } catch (e) { return 'ERR'; } })(),
       fields: orderKeys('synthetic:CN'),
       inv: orderInvariants(),
     };`,
  );
  const a34Ok =
    orderReady &&
    !!s34a &&
    s34a.fields.length === 6 &&
    s34a.inv.orderables >= 100 &&
    s34a.inv.handles === s34a.inv.orderables;

  // b. 第一层（法域行）：把「商标」拖到首位
  const s34b = await evalOrder(
    `const before = orderKeys('synthetic:CN');
     const probe = dragRowToTop('synthetic:CN', before.indexOf('synthetic:CN/商标'));
     const table = orderTable();
     const after = orderKeys('synthetic:CN');
     return { before, probe, after, first: after[0], tableFirst: table && table.parents && table.parents['synthetic:CN'] ? table.parents['synthetic:CN'][0] : null, tableLen: table && table.parents && table.parents['synthetic:CN'] ? table.parents['synthetic:CN'].length : null };`,
  );
  const b34Ok =
    !!s34b &&
    s34b.probe.engaged === true &&
    s34b.probe.globalFlag === "on" &&
    s34b.probe.markedFirst === true &&
    s34b.probe.markCount === 1 &&
    s34b.probe.residueDragging === 0 &&
    s34b.probe.residueMarks === 0 &&
    s34b.probe.residueFlag === null &&
    s34b.first === "synthetic:CN/商标" &&
    s34b.tableFirst === "synthetic:CN/商标" &&
    s34b.tableLen === 6 &&
    s34b.after.length === s34b.before.length;
  await shot(win, "目录树自定义排序-法域行拖到首位");

  // c. 不变式复核：拖拽既不新增 hidden、也不给合成节点造出 <a>，
  //    更不能在 .folder-container 与其兄弟 .folder-outer 之间插进任何东西
  const s34c = await evalOrder(`return orderInvariants();`);
  const c34Ok =
    !!s34c &&
    s34c.hiddenLis === 0 &&
    s34c.anchorsInSynthetic === 0 &&
    s34c.topLevelCN === true &&
    s34c.siblingBroken === 0;

  // d. SPA 软导航往返（复用路径）后次序保持
  await win.webContents.executeJavaScript(
    `window.spaNavigate(new URL(${JSON.stringify("/" + encodeURI(SPA_HOPS[1]))}, location.href))`,
  );
  await sleep(900);
  await win.webContents.executeJavaScript(
    `window.spaNavigate(new URL("/", location.href))`,
  );
  await sleep(900);
  const s34d = await evalOrder(
    `return { path: location.pathname, fields: orderKeys('synthetic:CN'), inv: orderInvariants() };`,
  );
  const d34Ok =
    !!s34d &&
    s34d.path === "/" &&
    s34d.fields[0] === "synthetic:CN/商标" &&
    s34d.inv.handles === s34d.inv.orderables &&
    s34d.inv.handles > 0;

  // e. 硬跳（重建路径）后次序保持，并在书层再拖一次——双侧（DOM 与表）一致
  await win.loadURL(`${base}/${encodeURI(SPA_HOPS[1])}`);
  let bookReady = false;
  for (let i = 0; i < 20; i += 1) {
    await sleep(300);
    bookReady = await win.webContents.executeJavaScript(
      `document.querySelectorAll('.explorer-ul .folder-container[data-orderable]').length > 0`,
    );
    if (bookReady) break;
  }
  const s34e = await evalOrder(
    `const fields = orderKeys('synthetic:CN');
     const booksBefore = orderKeys('synthetic:CN/专利/D5');
     const probe = dragRowToTop('synthetic:CN/专利/D5', 1);
     const booksAfter = orderKeys('synthetic:CN/专利/D5');
     const table = orderTable();
     const stored = table && table.parents ? table.parents['synthetic:CN/专利/D5'] : null;
     return {
       fields, booksBefore, probe, booksAfter, stored,
       domMatchesTable: !!stored && stored.length === booksAfter.length && stored.every((k, i) => k === booksAfter[i]),
     };`,
  );
  const e34Ok =
    bookReady &&
    !!s34e &&
    s34e.fields[0] === "synthetic:CN/商标" &&
    s34e.booksBefore.length === 9 &&
    s34e.probe.engaged === true &&
    s34e.probe.markedFirst === true &&
    s34e.booksAfter.length === 9 &&
    s34e.booksAfter[0] === s34e.booksBefore[1] &&
    s34e.domMatchesTable === true;
  await shot(win, "目录树自定义排序-书目行拖到首位");

  // f. 恢复默认排序：两段式内联确认（首点只进确认态，防误触），
  //    执行后序回默认 + 顺序键删除 + 恢复钮隐去，而**折叠态键 fileTree-v2 不得被动**
  const s34f1 = await evalOrder(
    `const treeSnapshot = (function () { try { return localStorage.getItem('fileTree-v2'); } catch (e) { return 'ERR'; } })();
     const btn = document.querySelector('.explorer-action-reset');
     const visibleBefore = btn ? getComputedStyle(btn).display : null;
     if (btn) btn.click();
     return {
       treeSnapshot,
       visibleBefore,
       confirm: btn ? (btn.dataset.confirm || null) : null,
       fields: orderKeys('synthetic:CN'),
       order: (function () { try { return localStorage.getItem('kb-explorer-order:v1'); } catch (e) { return 'ERR'; } })(),
     };`,
  );
  await shot(win, "目录树自定义排序-恢复默认两段确认");
  await win.webContents.executeJavaScript(
    `document.querySelector('.explorer-action-reset').click()`,
  );
  await sleep(1500);
  const s34f2 = await evalOrder(
    `const btn = document.querySelector('.explorer-action-reset');
     return {
       fields: orderKeys('synthetic:CN'),
       books: orderKeys('synthetic:CN/专利/D5'),
       order: (function () { try { return localStorage.getItem('kb-explorer-order:v1'); } catch (e) { return 'ERR'; } })(),
       tree: (function () { try { return localStorage.getItem('fileTree-v2'); } catch (e) { return 'ERR'; } })(),
       resetDisplay: btn ? getComputedStyle(btn).display : null,
       hasCustomAttr: btn ? btn.hasAttribute('data-has-custom-order') : null,
       roots: document.querySelectorAll('.explorer-ul > li').length,
       inv: orderInvariants(),
     };`,
  );
  const f34Ok =
    !!s34f1 &&
    !!s34f2 &&
    s34f1.visibleBefore !== "none" &&
    s34f1.confirm === "on" &&
    s34f1.fields[0] === "synthetic:CN/商标" &&
    s34f2.fields[0] === "synthetic:CN/专利" &&
    s34f2.books[0] === s34e.booksBefore[0] &&
    s34f2.order === null &&
    s34f2.resetDisplay === "none" &&
    s34f2.hasCustomAttr === false &&
    // 只删顺序表，折叠习惯毫发无损
    s34f2.tree === s34f1.treeSnapshot &&
    // 就地重建不得留下双树叠加（3 个顶层 li + 1 条 overflow-end 占位）
    s34f2.roots === 4 &&
    s34f2.inv.handles === s34f2.inv.orderables;

  // g. 收尾：顺序表复位回步首快照（本就为 null 时删键）
  const s34g = await evalOrder(
    `const before = ${JSON.stringify(s34a ? s34a.orderBefore : null)};
     try {
       if (before === null) localStorage.removeItem('kb-explorer-order:v1');
       else localStorage.setItem('kb-explorer-order:v1', before);
     } catch (e) {}
     let now = 'ERR';
     try { now = localStorage.getItem('kb-explorer-order:v1'); } catch (e) {}
     return { restored: now === before, now: now };`,
  );
  const g34Ok = !!s34g && s34g.restored === true;

  record(
    "目录树自定义排序（三层可拖/顶层与章节层锁死 + 拖拽落定双侧一致 + 复用与重建两路径保持 + 恢复默认两段确认且不动折叠态 + 收尾复位）",
    a34Ok && b34Ok && c34Ok && d34Ok && e34Ok && f34Ok && g34Ok,
    `a 基线：可重排行=${s34a ? s34a.inv.orderables : "-"}／手柄=${s34a ? s34a.inv.handles : "-"}（须相等且 ≥100）, 法域行=${s34a ? s34a.fields.length : "-"}（须 6）, 默认首=${s34a ? s34a.fields[0] : "-"}; ` +
      `b 拖「商标」到首：进入拖拽态=${s34b ? s34b.probe.engaged : "-"}（须 true，防空转假绿）, 全局禁选=${s34b ? s34b.probe.globalFlag : "-"}, 首行指示线=${s34b ? s34b.probe.markedFirst : "-"}／指示线数=${s34b ? s34b.probe.markCount : "-"}（须 1）, ` +
      `DOM 首=${s34b ? s34b.first : "-"}／表首=${s34b ? s34b.tableFirst : "-"}（须均为 synthetic:CN/商标）, 表长=${s34b ? s34b.tableLen : "-"}（须 6，整段写入）, 抬指残留 dragging=${s34b ? s34b.probe.residueDragging : "-"}／指示线=${s34b ? s34b.probe.residueMarks : "-"}／全局标记=${s34b ? String(s34b.probe.residueFlag) : "-"}; ` +
      `c 不变式：li[hidden]=${s34c ? s34c.hiddenLis : "-"}（须 0）, 合成节点内 <a>=${s34c ? s34c.anchorsInSynthetic : "-"}（须 0）, 顶层直达链=${s34c ? s34c.topLevelCN : "-"}, container→outer 相邻破坏=${s34c ? s34c.siblingBroken : "-"}（须 0）; ` +
      `d 复用路径（SPA 往返）：落地=${s34d ? s34d.path : "-"}, 法域首=${s34d ? s34d.fields[0] : "-"}（须 synthetic:CN/商标）, 手柄=${s34d ? s34d.inv.handles : "-"}／可重排行=${s34d ? s34d.inv.orderables : "-"}（须相等且 >0——手柄监听若误登记 cleanup，此处必为 0）; ` +
      `e 重建路径（硬跳 ${SPA_HOPS[1]}）：法域首=${s34e ? s34e.fields[0] : "-"}, D5 书=${s34e ? s34e.booksBefore.length : "-"} 本（须 9）, 第二本拖到首=${s34e ? s34e.booksAfter[0] : "-"}（期望 ${s34e ? s34e.booksBefore[1] : "-"}）, DOM 与表逐项一致=${s34e ? s34e.domMatchesTable : "-"}; ` +
      `f 恢复默认：首点后 data-confirm=${s34f1 ? s34f1.confirm : "-"}（须 on）且序未变=${s34f1 ? s34f1.fields[0] : "-"}; 再点后法域首=${s34f2 ? s34f2.fields[0] : "-"}（须 synthetic:CN/专利）, 书首=${s34f2 ? s34f2.books[0] : "-"}, 顺序键=${s34f2 ? JSON.stringify(s34f2.order) : "-"}（须 null）, 恢复钮 display=${s34f2 ? s34f2.resetDisplay : "-"}（须 none）, fileTree-v2 未被动=${s34f1 && s34f2 ? s34f2.tree === s34f1.treeSnapshot : "-"}, 顶层 li=${s34f2 ? s34f2.roots : "-"}（须 4＝3 顶层+1 占位，防双树叠加）; ` +
      `g 收尾：顺序表复位=${g34Ok}（步首快照=${s34a ? JSON.stringify(s34a.orderBefore) : "-"}）`,
  );

  // 35. 目录树一键收起
  //     **绝不自动执行**：只有用户点这枚钮才收起（图谱页首访仍按「书下 3 层可见」
  //     铺开，步 29 的 open ≥1000 即这条纪律的常设护栏，本步全程不碰图谱页）。
  //     语义＝「全部置 collapsed，再用既有公式 refreshFolderOpenState 重算」，
  //     故净效果是「除当前页祖先链外全收」——祖先链恒为合成三层 + 书 + 章，
  //     b 段用结构化判据钉死（每个仍展开的节点必须是当前页祖先或 synthetic:），
  //     不写死数字，语料增删也不会把这条断言变成噪声。
  const COLLAPSE_PAGE = "1-专利法/1-总则/law-01-01";
  await win.loadURL(`${base}/${encodeURI(COLLAPSE_PAGE)}`);
  let collapseReady = false;
  for (let i = 0; i < 20; i += 1) {
    await sleep(300);
    collapseReady = await win.webContents.executeJavaScript(
      `!!document.querySelector('.explorer-action-collapse') &&
       document.querySelectorAll('.explorer-ul .folder-outer').length > 0`,
    );
    if (collapseReady) break;
  }
  const COLLAPSE_STATS = `(() => {
     const opens = Array.from(document.querySelectorAll('.explorer-ul .folder-outer.open'));
     const current = document.body.dataset.slug || '';
     const paths = opens.map((o) => (o.previousElementSibling ? o.previousElementSibling.dataset.folderpath : null));
     const btn = document.querySelector('.explorer-action-collapse');
     let saved = 'ERR';
     try { saved = localStorage.getItem('fileTree-v2'); } catch (e) {}
     let everyCollapsed = null, savedLen = null;
     try {
       const parsed = JSON.parse(saved || 'null');
       if (Array.isArray(parsed)) { everyCollapsed = parsed.every((e) => e.collapsed === true); savedLen = parsed.length; }
     } catch (e) {}
     return {
       open: opens.length,
       total: document.querySelectorAll('.explorer-ul .folder-outer').length,
       paths: paths,
       ancestorOnly: paths.every((p) => {
         if (!p) return false;
         if (p.indexOf('synthetic:') === 0) return true;
         return current.indexOf(p.replace(/\\/index$/, '')) === 0;
       }),
       disabled: btn ? btn.disabled : null,
       ariaDisabled: btn ? btn.getAttribute('aria-disabled') : null,
       everyCollapsed: everyCollapsed,
       savedLen: savedLen,
       saved: saved,
       slug: current,
     };
   })()`;
  // a. 快照（fileTree-v2 原值供收尾写回）+ 收起前规模 + 钮可用
  const s35a = await win.webContents.executeJavaScript(COLLAPSE_STATS);
  const a35Ok =
    collapseReady && !!s35a && s35a.open > 0 && s35a.disabled === false;

  // b. 点收起
  await win.webContents.executeJavaScript(
    `document.querySelector('.explorer-action-collapse').click()`,
  );
  await sleep(500);
  const s35b = await win.webContents.executeJavaScript(COLLAPSE_STATS);
  const b35Ok =
    !!s35b &&
    s35b.open < s35a.open &&
    s35b.open <= 6 &&
    s35b.ancestorOnly === true &&
    s35b.everyCollapsed === true &&
    s35b.savedLen === s35b.total &&
    s35b.disabled === true &&
    s35b.ariaDisabled === "true";
  await shot(win, "目录树一键收起");

  // c. SPA 往返后仍保持（复用路径逐导航整树重算，收起结果来自落盘态而非 DOM 残留）
  await win.webContents.executeJavaScript(
    `window.spaNavigate(new URL(${JSON.stringify("/" + encodeURI(SPA_HOPS[1]))}, location.href))`,
  );
  await sleep(900);
  await win.webContents.executeJavaScript(
    `window.spaNavigate(new URL(${JSON.stringify("/" + encodeURI(COLLAPSE_PAGE))}, location.href))`,
  );
  await sleep(900);
  const s35c = await win.webContents.executeJavaScript(COLLAPSE_STATS);
  const c35Ok = !!s35c && s35c.open <= 6 && s35c.ancestorOnly === true;

  // d. 收尾：fileTree-v2 写回步首快照（硬性——不把「全部收起」留给用户）
  const s35d = await win.webContents.executeJavaScript(
    `(() => {
       const before = ${JSON.stringify(s35a ? s35a.saved : null)};
       try {
         if (before === null) localStorage.removeItem('fileTree-v2');
         else localStorage.setItem('fileTree-v2', before);
       } catch (e) {}
       let now = 'ERR';
       try { now = localStorage.getItem('fileTree-v2'); } catch (e) {}
       return { restored: now === before, len: now ? now.length : null };
     })()`,
  );
  const d35Ok = !!s35d && s35d.restored === true;

  record(
    "目录树一键收起（点钮才收 + 除当前页祖先链外全收 + 落盘全 collapsed + 钮置灰 + SPA 往返保持 + 收尾复位）",
    a35Ok && b35Ok && c35Ok && d35Ok,
    `a 收起前：展开=${s35a ? s35a.open : "-"}/${s35a ? s35a.total : "-"}, 钮 disabled=${s35a ? s35a.disabled : "-"}（须 false）, 当前页=${s35a ? s35a.slug : "-"}; ` +
      `b 点收起后：展开=${s35b ? s35b.open : "-"}（须 <${s35a ? s35a.open : "-"} 且 ≤6）, 仍展开的节点=${s35b ? JSON.stringify(s35b.paths) : "-"}, 全为祖先或合成层=${s35b ? s35b.ancestorOnly : "-"}, ` +
      `落盘 every(collapsed)=${s35b ? s35b.everyCollapsed : "-"}（须 true）／条目=${s35b ? s35b.savedLen : "-"}（须 =${s35b ? s35b.total : "-"}）, 钮 disabled=${s35b ? s35b.disabled : "-"}／aria=${s35b ? s35b.ariaDisabled : "-"}; ` +
      `c SPA 往返后：展开=${s35c ? s35c.open : "-"}（须 ≤6）, 全为祖先或合成层=${s35c ? s35c.ancestorOnly : "-"}; ` +
      `d 收尾：fileTree-v2 写回=${d35Ok}（长度 ${s35d ? s35d.len : "-"}）`,
  );

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
// （阶段5波C 由 300s 上调：新增两步各带轮询等待——27 最长 6s 等 taxonomy 取数与再父化，
// 28 最长 15s 等图谱出图，另加两次力导落定等待与截图，26 步时代的预算留白再度告罄）
// （阶段5.3 批 B5 未上调：新增步 29 全程复用步 28 已加载的图谱页与其目录树、不再
// loadURL，累计新增等待约 12s，现有预算仍有充裕留白）
// （阶段5.6 波2 由 360s 上调至 420s：新增步 30 要一次 loadURL 直开图谱页 + 两次 SPA
// 软导航往返 + 两轮埋点轮询，累计新增等待约 25s，360s 的留白已不足以吸收机器慢档）
// （阶段5.7 波A 由 420s 上调至 600s：新增步 31 两次 loadURL 开局部图页、步 32 一次
// loadURL 开图谱页 + 三次交互各等 2s（400ms RO 防抖 + 约 230ms 重建 + 260ms 淡入 +
// 余量）。本机实测 32 步全程 77s、新增三步合计约 10s，420s 本就有约 5 倍余量；
// 上调是给慢档机器留统一空间——整体放大 5 倍即 (77+10)×5≈435s 已越过 420s。）
setTimeout(() => {
  console.error("冒烟超时，强制退出");
  app.exit(1);
}, 600000);
