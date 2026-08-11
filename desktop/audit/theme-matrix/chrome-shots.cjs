// chrome-shots.cjs —— 主题视觉矩阵审计（npx electron audit/theme-matrix/chrome-shots.cjs）
//
// 取景体系：6 主题（宣纸/水墨/青瓷/竹林/暮山/玄夜）× 亮暗 × 5 镜头 = 60 张。
//   镜头 1「局部图」   ：章节页右栏局部图谱（.graph-outer 裁切，沿用上轮取景）
//   镜头 2「全局弹窗」 ：局部图右上角钮展开的全局图模态（.global-graph-container 裁切）
//   镜头 3「图谱总览」 ：/0-图谱总览/ 专页画布（.ge-canvas 裁切）
//   镜头 4「悬停预览弹窗展开态」（本轮新增）：章节页对 article a.internal 派发
//        mouseenter，等 600ms（popover.inline.ts 的 150ms 意图延迟 + dropin 的
//        200ms animation-delay + 180ms 时长均已走完）后整窗截图。判读四项：
//        弹窗底色与正文同色温、描边可辨、无透字、滚动条槽色同弹窗底。
//   镜头 5「搜索弹层带结果」（本轮新增）：打开搜索输入「新颖性」等 2.5s（首次需
//        就地建全文索引）后整窗截图。判读三项：命中词高亮随主题、结果卡卡形、
//        无绿色残留（旧硬编码 rgba(132,165,157,.6)）。
//
// 判读方式：每镜头除 getComputedStyle 探针外，另从截图 NativeImage 直接取关键区域
// 像素（toBitmap() 为 BGRA，按 devicePixelRatio 换算物理坐标），故「无透字」
// 「槽色同底」「高亮确已上色」这类只能在成像上看出的项也有实测值，不靠肉眼。
//
// 另含两组专项：
//   ① 明暗切换协调性（宣纸 / 玄夜各一次）：rAF 采样器记录切换后 0–420ms 内三个
//      采样点（body 背景色、左栏玻璃 ::before 背景、正文 a.internal 背景）的颜色
//      序列，断言三者都在渐变（存在中间帧 ≠ 起点且 ≠ 终点）——成组同频而非瞬变。
//   ② 降级路径抽查：另建**无 preload** 窗口（等效浏览器），经 CDP
//      Emulation.setEmulatedMedia 施加 prefers-reduced-transparency: reduce 与
//      prefers-reduced-motion: reduce，核验弹窗实底化 / 去模糊、入场动画归零、
//      过渡时长压缩。
//
// 全程以 webRequest 阻断并记录一切非 127.0.0.1 请求（等效断网）。
// 产物：本目录下 <theme>-<mode>-<n>-<镜头名>.png 共 60 张 + report-5shots.txt/.json。
const {
  app,
  BrowserWindow,
  session,
  ipcMain,
  nativeTheme,
} = require("electron");
const path = require("path");
const fs = require("fs");
const { startStaticServer } = require("../../server.cjs");

const OUT = __dirname;
const DIST = path.join(__dirname, "..", "..", "..", "quartz-kb", "public");
const PRELOAD = path.join(__dirname, "..", "..", "preload.cjs");

// 六套主题：key 与 .kb-theme-card[data-value] 一致；expect 为 custom.scss 中该套
// [data-style] 块（dark 变体带 [saved-theme="dark"]）的 --light 事实值，逐轮从源码
// 抄录，用于核验「主题确已落地」而非只看属性写没写上。
const THEMES = [
  { key: "xuanzhi", name: "宣纸", light: "#feefe5", dark: "#201c16" },
  { key: "shuimo", name: "水墨", light: "#ecf5f8", dark: "#171a1c" },
  { key: "qingci", name: "青瓷", light: "#e3f7f4", dark: "#14201d" },
  { key: "zhulin", name: "竹林", light: "#eff5e8", dark: "#181f15" },
  { key: "mushan", name: "暮山", light: "#f8effb", dark: "#1a1620" },
  { key: "xuanye", name: "玄夜", light: "#ebf0ff", dark: "#10141d" },
];
const MODES = ["light", "dark"];

// 自检用过滤器（默认全矩阵）：MATRIX_ONLY=xuanzhi,shuimo MATRIX_MODES=light
// 只影响跑哪几格，不改任何判据；跑局部时报告文件同样会被覆写，故最终产物一律取全量跑。
const ONLY = (process.env.MATRIX_ONLY || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const ONLY_MODES = (process.env.MATRIX_MODES || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const THEMES_RUN = ONLY.length
  ? THEMES.filter((t) => ONLY.includes(t.key))
  : THEMES;
const MODES_RUN = ONLY_MODES.length
  ? MODES.filter((m) => ONLY_MODES.includes(m))
  : MODES;
// 阶段开关（自检用）：MATRIX_PHASES=degrade 只跑降级抽查
const PHASES = (process.env.MATRIX_PHASES || "matrix,coord,degrade")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// 章节页：正文含站内链接（镜头 4 的 popover 触发源）且右栏有局部图
const CHAPTER = "6-化学撰写规范/2-撰写示例及分析/chem-02-03-03";
const OVERVIEW = "0-图谱总览/";
const SETTINGS = "设置/";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const shots = [];

function record(step, ok, detail) {
  results.push({ step, ok: !!ok, detail: detail || "" });
  console.log(`${ok ? "✅" : "❌"} ${step}${detail ? ` —— ${detail}` : ""}`);
}

// —— 主题 IPC 桩：与 main.cjs 的 'apply-theme-source' 同协议但不写盘 ——
const THEME_MODES = ["light", "dark", "system"];
ipcMain.handle("apply-theme-source", (_e, payload) => {
  const mode =
    payload && THEME_MODES.includes(payload.mode) ? payload.mode : null;
  if (mode) nativeTheme.themeSource = mode;
  return { dark: nativeTheme.shouldUseDarkColors };
});

// 页面内颜色解析（与 smoke.cjs 同源：产物里 rgba() 常被压缩成 8 位 hex，
// getComputedStyle 却回 rgb()/rgba()，比对前须先归一）
const PARSE_COLOR_FN = `
  function parseColor(str) {
    if (!str) return null;
    str = String(str).trim();
    const rgbMatch = /^rgba?\\(([^)]+)\\)$/i.exec(str);
    if (rgbMatch) {
      const body = rgbMatch[1].replace('/', ' ').replace(/,/g, ' ').trim();
      const parts = body.split(/\\s+/).map((s) => parseFloat(s));
      return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
    }
    const hexMatch = /^#([0-9a-f]{3}|[0-9a-f]{6})([0-9a-f]{2})?$/i.exec(str);
    if (hexMatch) {
      let hex = hexMatch[1];
      if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
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

// ============================ 像素采样 ============================
// capturePage 在 Retina 屏返回的 NativeImage：**getSize() 已是物理像素**（实测
// 2880x1800，与落盘 PNG 尺寸一致），不能按「getSize() 是 DIP、按缓冲长度反解
// scale」那套算——那样解出 scale=1，DIP 坐标会全部落到画面左上四分之一处，
// 采到的一律是页面底色（本轮首跑即栽在这里）。故 scale 由渲染层的
// devicePixelRatio 显式传入，DIP 坐标乘它即物理坐标。
// dipOrigin 为裁切原点（整窗截图时为 0,0），寻址前先减去。
function makeSampler(img, dpr, dipOrigin = { x: 0, y: 0 }) {
  const { width, height } = img.getSize();
  const buf = img.toBitmap();
  const stride = Math.round(buf.length / height);
  const at = (x, y) => {
    const px = Math.min(
      width - 1,
      Math.max(0, Math.round((x - dipOrigin.x) * dpr)),
    );
    const py = Math.min(
      height - 1,
      Math.max(0, Math.round((y - dipOrigin.y) * dpr)),
    );
    const i = py * stride + px * 4;
    return { r: buf[i + 2], g: buf[i + 1], b: buf[i], a: buf[i + 3] };
  };
  // width/height 对外仍以 DIP 暴露，调用处按 DIP 取景不必换算
  return {
    at,
    dpr,
    width: Math.round(width / dpr),
    height: Math.round(height / dpr),
  };
}

// 任何可能挂住的等待都套超时，宁可失败也不让脚本无限悬停
function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`超时 ${ms}ms：${label}`)), ms);
    }),
  ]);
}

const hex = (c) =>
  c
    ? "#" + [c.r, c.g, c.b].map((v) => v.toString(16).padStart(2, "0")).join("")
    : "-";
const dist = (a, b) =>
  a && b
    ? Math.round(
        Math.sqrt((a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2) * 10,
      ) / 10
    : null;

// 一组像素取中位色（避开个别文字/抗锯齿像素）
function medianColor(list) {
  if (!list.length) return null;
  const pick = (k) => {
    const v = list.map((c) => c[k]).sort((x, y) => x - y);
    return v[Math.floor(v.length / 2)];
  };
  return { r: pick("r"), g: pick("g"), b: pick("b"), a: 255 };
}

// 一组像素取「众数色」：按 8 级量化分桶取最大桶，再对桶内取中位。
// 底色判读必须用众数而非中位——散点网格里若有三成落在字形笔画上，中位会被拖黑。
function modeColor(list) {
  if (!list.length) return null;
  const buckets = new Map();
  for (const c of list) {
    const k = `${c.r >> 3}-${c.g >> 3}-${c.b >> 3}`;
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(c);
  }
  let best = null;
  for (const arr of buckets.values()) {
    if (!best || arr.length > best.length) best = arr;
  }
  return medianColor(best);
}

// 色相（0–360）与饱和度，用于「同色温」判读
function hsl(c) {
  const r = c.r / 255,
    g = c.g / 255,
    b = c.b / 255;
  const max = Math.max(r, g, b),
    min = Math.min(r, g, b),
    d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  const l = (max + min) / 2;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  return {
    h: Math.round(h),
    s: Math.round(s * 1000) / 1000,
    l: Math.round(l * 1000) / 1000,
  };
}
function hueGap(a, b) {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

async function shot(win, name, rect) {
  const img = rect ? await win.capturePage(rect) : await win.capturePage();
  const file = path.join(OUT, `${name}.png`);
  await fs.promises.writeFile(file, img.toPNG());
  shots.push(file);
  return { file, img };
}

async function rectOf(win, selector, pad = 0) {
  return win.webContents
    .executeJavaScript(
      `(() => {
       const el = document.querySelector(${JSON.stringify(selector)});
       if (!el) return null;
       const r = el.getBoundingClientRect();
       return { x: r.x, y: r.y, width: r.width, height: r.height };
     })()`,
    )
    .then((r) => {
      if (!r) return null;
      const P = pad;
      return {
        x: Math.max(0, Math.round(r.x - P)),
        y: Math.max(0, Math.round(r.y - P)),
        width: Math.round(r.width + P * 2),
        height: Math.round(r.height + P * 2),
        raw: r,
      };
    });
}

// ============================ 主流程 ============================
async function main() {
  await fs.promises.mkdir(OUT, { recursive: true });

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
      /* devtools 等非标准 URL 放行 */
    }
    callback({});
  });

  const { server, port } = await startStaticServer(DIST, { port: 0 });
  const base = `http://127.0.0.1:${port}`;
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    show: true,
    ...(process.platform === "darwin" ? { titleBarStyle: "hiddenInset" } : {}),
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const matrix = [];

  // 像素寻址的 DIP→物理比例：一次问渲染层，之后所有采样共用
  await win.loadURL(`${base}/`);
  await sleep(600);
  const DPR = await win.webContents.executeJavaScript(
    "window.devicePixelRatio",
  );
  console.log(`[env] devicePixelRatio=${DPR}`);

  // ===================== 一、60 张矩阵 =====================
  for (const theme of PHASES.includes("matrix") ? THEMES_RUN : []) {
    for (const mode of MODES_RUN) {
      const tag = `${theme.key}-${mode}`;
      const shotPrefix = `${theme.key}-${mode}`;
      const cell = { theme: theme.key, name: theme.name, mode, checks: [] };

      // —— 施加主题：走真实控件（设置页主题卡 + 主题模式段控件）——
      await win.loadURL(base + "/" + encodeURI(SETTINGS));
      await sleep(700);
      await win.webContents.executeJavaScript(
        `document.querySelector('[data-setting="themeMode"][data-value="${mode}"]').click()`,
      );
      await sleep(250);
      await win.webContents.executeJavaScript(
        `document.querySelector('.kb-theme-card[data-value="${theme.key}"]').click()`,
      );
      await sleep(400);

      // —— 镜头 1：局部图（章节页右栏）——
      await win.loadURL(base + "/" + encodeURI(CHAPTER));
      let localReady = false;
      for (let i = 0; i < 24; i += 1) {
        await sleep(400);
        localReady = await win.webContents.executeJavaScript(
          `!!document.querySelector('.graph-outer canvas, .graph-outer svg')`,
        );
        if (localReady) break;
      }
      await sleep(900);
      const applied = await win.webContents.executeJavaScript(
        `(() => {
           const cs = getComputedStyle(document.documentElement);
           return {
             style: document.documentElement.dataset.style || null,
             saved: document.documentElement.getAttribute('saved-theme'),
             light: cs.getPropertyValue('--light').trim(),
             popoverBg: cs.getPropertyValue('--popover-bg').trim(),
             popoverBorder: cs.getPropertyValue('--popover-border').trim(),
             textHighlight: cs.getPropertyValue('--textHighlight').trim(),
             durationTheme: cs.getPropertyValue('--duration-theme').trim(),
           };
         })()`,
      );
      const expectLight = mode === "dark" ? theme.dark : theme.light;
      const appliedOk =
        applied.style === theme.key &&
        applied.saved === mode &&
        applied.light.toLowerCase() === expectLight;
      cell.applied = applied;
      record(
        `矩阵 ${tag} 主题落地`,
        appliedOk,
        `data-style=${applied.style} saved-theme=${applied.saved} --light=${applied.light}(want ${expectLight}) --popover-bg=${applied.popoverBg} --textHighlight=${applied.textHighlight}`,
      );

      const r1 = await rectOf(win, ".graph-outer", 12);
      const s1 = await shot(win, `${shotPrefix}-1-局部图`, r1 || undefined);
      const px1 = makeSampler(s1.img, DPR);
      // 画布左上空白处（无节点）取样，核验图底随主题
      const canvasBg = medianColor([
        px1.at(16, 16),
        px1.at(24, 16),
        px1.at(16, 24),
        px1.at(px1.width - 16, px1.height - 16),
      ]);
      cell.checks.push({
        shot: 1,
        name: "局部图",
        file: path.basename(s1.file),
        ok: localReady && !!r1,
        detail: `画布就绪=${localReady} 取景=${r1 ? `${r1.width}x${r1.height}@(${r1.x},${r1.y})` : "-"} 图底像素=${hex(canvasBg)}（--light=${applied.light}）`,
      });

      // —— 镜头 2：全局弹窗 ——
      await win.webContents.executeJavaScript(
        `document.querySelector('.global-graph-icon').click()`,
      );
      let globalReady = false;
      for (let i = 0; i < 24; i += 1) {
        await sleep(400);
        globalReady = await win.webContents.executeJavaScript(
          `!!document.querySelector('.global-graph-outer.active .global-graph-container canvas, .global-graph-outer.active .global-graph-container svg')`,
        );
        if (globalReady) break;
      }
      await sleep(1200);
      const r2 = await rectOf(
        win,
        ".global-graph-outer.active .global-graph-container",
        0,
      );
      const s2 = await shot(win, `${shotPrefix}-2-全局弹窗`, r2 || undefined);
      const px2 = makeSampler(s2.img, DPR);
      const modalBg = medianColor([
        px2.at(10, 10),
        px2.at(20, 10),
        px2.at(10, 20),
        px2.at(px2.width - 12, 12),
      ]);
      cell.checks.push({
        shot: 2,
        name: "全局弹窗",
        file: path.basename(s2.file),
        ok: globalReady && !!r2,
        detail: `弹窗出图=${globalReady} 取景=${r2 ? `${r2.width}x${r2.height}` : "-"} 面板底像素=${hex(modalBg)}`,
      });
      // 关闭全局图（graph.inline.ts 注册 Escape）
      await win.webContents.executeJavaScript(
        `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`,
      );
      await sleep(400);

      // —— 镜头 3：图谱总览专页 ——
      await win.loadURL(base + "/" + encodeURI(OVERVIEW));
      let geReady = false;
      for (let i = 0; i < 30; i += 1) {
        await sleep(500);
        geReady = await win.webContents.executeJavaScript(
          `!!document.querySelector('.ge-canvas svg, .ge-canvas canvas')`,
        );
        if (geReady) break;
      }
      await sleep(1500);
      const r3 = await rectOf(win, ".ge-canvas", 0);
      const s3 = await shot(win, `${shotPrefix}-3-图谱总览`, r3 || undefined);
      const px3 = makeSampler(s3.img, DPR);
      const geBg = medianColor([
        px3.at(8, 8),
        px3.at(16, 8),
        px3.at(8, 16),
        px3.at(px3.width - 10, px3.height - 10),
      ]);
      const lightPx = await win.webContents.executeJavaScript(
        `(() => { ${PARSE_COLOR_FN} const c = parseColor(getComputedStyle(document.documentElement).getPropertyValue('--light').trim()); return c; })()`,
      );
      const geBgMatch = dist(geBg, lightPx);
      cell.checks.push({
        shot: 3,
        name: "图谱总览",
        file: path.basename(s3.file),
        ok: geReady && !!r3 && geBgMatch !== null && geBgMatch <= 12,
        detail: `画布出图=${geReady} 取景=${r3 ? `${r3.width}x${r3.height}` : "-"} 画布底像素=${hex(geBg)} vs --light=${hex(lightPx)}（Δ=${geBgMatch}≤12）`,
      });

      // —— 镜头 4：悬停预览弹窗展开态 ——
      await win.loadURL(base + "/" + encodeURI(CHAPTER));
      await sleep(900);
      await win.webContents.executeJavaScript(
        `(() => {
           const link = document.querySelector('article a.internal[href]');
           if (!link) return false;
           link.scrollIntoView({ block: 'center' });
           link.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
           return true;
         })()`,
      );
      await sleep(600); // 150ms 意图延迟 + 200ms delay + 180ms 动画，全部走完
      const popProbe = await win.webContents.executeJavaScript(
        `(() => {
           ${PARSE_COLOR_FN}
           const pop = document.querySelector('.popover.active-popover');
           const inner = pop ? pop.querySelector('.popover-inner') : null;
           if (!inner) return { found: false };
           const cs = getComputedStyle(inner);
           const rootCs = getComputedStyle(document.documentElement);
           const article = document.querySelector('article');
           const bodyBg = getComputedStyle(document.body).backgroundColor;
           const r = inner.getBoundingClientRect();
           return {
             found: true,
             popOpacity: getComputedStyle(pop).opacity,
             innerBg: cs.backgroundColor,
             innerBorderColor: cs.borderTopColor,
             innerBorderWidth: cs.borderTopWidth,
             backdrop: cs.backdropFilter || cs.webkitBackdropFilter,
             radius: cs.borderRadius,
             overflowY: cs.overflowY,
             scrollable: inner.scrollHeight > inner.clientHeight + 1,
             scrollHeight: inner.scrollHeight,
             clientHeight: inner.clientHeight,
             rect: { x: r.x, y: r.y, width: r.width, height: r.height },
             tokenBg: rootCs.getPropertyValue('--popover-bg').trim(),
             tokenBorder: rootCs.getPropertyValue('--popover-border').trim(),
             bodyBg,
             articleBg: article ? getComputedStyle(article).backgroundColor : null,
             parsed: {
               bg: parseColor(cs.backgroundColor),
               border: parseColor(cs.borderTopColor),
               token: parseColor(rootCs.getPropertyValue('--popover-bg').trim()),
               body: parseColor(bodyBg),
             },
           };
         })()`,
      );
      const s4 = await shot(win, `${shotPrefix}-4-悬停弹窗展开态`);
      const px4 = makeSampler(s4.img, DPR);
      let pop = { ok: false, detail: "弹窗未出现" };
      if (popProbe.found) {
        const R = popProbe.rect;
        // ① 弹窗内左侧 padding 带（padding-left:1rem，圆角 12px 之内）纵向取样
        //    → 弹窗底色成像；离散度即「有无透字」的成像证据
        const inside = [];
        for (let y = R.y + 16; y < R.y + R.height - 16; y += 10) {
          inside.push(px4.at(R.x + 6, y));
        }
        const insideMed = medianColor(inside);
        const insideSpread = Math.max(
          ...inside.map((c) => dist(c, insideMed) || 0),
        );
        // ② 弹窗外侧（正文区）散点网格取众数 → 正文底色成像（避开字形笔画）
        const outsidePts = [];
        for (let dy = 6; dy < R.height - 6; dy += 14) {
          for (const dx of [-30, -22, -14]) {
            outsidePts.push(px4.at(R.x + dx, R.y + dy));
          }
          for (const dx of [14, 22, 30]) {
            outsidePts.push(px4.at(R.x + R.width + dx, R.y + dy));
          }
        }
        const outside = modeColor(outsidePts);
        // ③ 左描边像素（1px，取中高度）
        const borderPx = px4.at(R.x, R.y + R.height / 2);
        // ④ 滚动条槽（右缘 9px 槽中心，取靠底部避开 thumb）
        const trackPx = px4.at(R.x + R.width - 5, R.y + R.height - 18);
        const bodyParsed = popProbe.parsed.body;
        const bgParsed = popProbe.parsed.bg;
        // 判读一：同色温——弹窗底色与正文底色的色相差 ≤ 30°（两者近中性则免检）
        const hIn = hsl(insideMed);
        const hOut = outside ? hsl(outside) : null;
        const warmSameSign =
          insideMed && outside
            ? Math.sign(insideMed.r - insideMed.b) ===
              Math.sign(outside.r - outside.b)
            : false;
        const hueOk =
          !!hOut &&
          (hueGap(hIn.h, hOut.h) <= 30 || (hIn.s < 0.08 && hOut.s < 0.08)) &&
          warmSameSign;
        // 判读二：描边可辨——描边成像与弹窗底色成像的距离 ≥ 4
        const borderDelta = dist(borderPx, insideMed);
        const borderOk = borderDelta !== null && borderDelta >= 4;
        // 判读三：无透字——底色 alpha ≥ 0.97、弹窗 opacity=1、底色带内像素离散 ≤ 6
        const alphaOk = !!bgParsed && bgParsed.a >= 0.97;
        const opacityOk = popProbe.popOpacity === "1";
        const uniformOk = insideSpread <= 6;
        // 判读四：滚动条槽色同弹窗底（::-webkit-scrollbar-track 恒 transparent）
        const trackDelta = dist(trackPx, insideMed);
        const trackOk = trackDelta !== null && trackDelta <= 8;
        // 底色/描边与 token 同源（与 smoke 同判据）
        const bgTokenOk =
          !!bgParsed &&
          !!popProbe.parsed.token &&
          bgParsed.r === popProbe.parsed.token.r &&
          bgParsed.g === popProbe.parsed.token.g &&
          bgParsed.b === popProbe.parsed.token.b;
        pop = {
          ok:
            hueOk &&
            borderOk &&
            alphaOk &&
            opacityOk &&
            uniformOk &&
            trackOk &&
            bgTokenOk,
          detail:
            `底色=${popProbe.innerBg}(token=${popProbe.tokenBg} 同源→${bgTokenOk}, alpha=${bgParsed ? Math.round(bgParsed.a * 100) / 100 : "-"}≥0.97→${alphaOk}) opacity=${popProbe.popOpacity}→${opacityOk}; ` +
            `成像底=${hex(insideMed)}(离散${insideSpread}≤6→${uniformOk}) 正文底成像=${hex(outside)} 色相${hIn.h}°vs${hOut ? hOut.h : "-"}°(Δ${hOut ? hueGap(hIn.h, hOut.h) : "-"}≤30 且暖冷同向=${warmSameSign}→${hueOk}); ` +
            `描边成像=${hex(borderPx)}(Δ底=${borderDelta}≥4→${borderOk}, css=${popProbe.innerBorderColor}/${popProbe.innerBorderWidth}); ` +
            `槽像素=${hex(trackPx)}(Δ底=${trackDelta}≤8→${trackOk}, 可滚=${popProbe.scrollable} ${popProbe.scrollHeight}/${popProbe.clientHeight}); ` +
            `backdrop=${popProbe.backdrop} 圆角=${popProbe.radius} 弹窗几何=${Math.round(R.width)}x${Math.round(R.height)}@(${Math.round(R.x)},${Math.round(R.y)}) body底=${popProbe.bodyBg}`,
        };
      }
      cell.checks.push({
        shot: 4,
        name: "悬停预览弹窗展开态",
        file: path.basename(s4.file),
        ...pop,
      });
      record(`矩阵 ${tag} 镜头4 悬停弹窗`, pop.ok, pop.detail);

      // 收尾 hover 态
      await win.webContents.executeJavaScript(
        `(() => {
           const link = document.querySelector('article a.internal[href]');
           if (link) link.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }));
         })()`,
      );
      await sleep(250);

      // —— 镜头 5：搜索弹层带结果 ——
      await win.loadURL(`${base}/`);
      await sleep(700);
      await win.webContents.executeJavaScript(
        `(() => {
           document.querySelector('.search > .search-button').click();
           const bar = document.querySelector('.search .search-bar');
           bar.value = '新颖性';
           bar.dispatchEvent(new Event('input', { bubbles: true }));
         })()`,
      );
      await sleep(2500);
      const searchProbe = await win.webContents.executeJavaScript(
        `(() => {
           ${PARSE_COLOR_FN}
           const rootCs = getComputedStyle(document.documentElement);
           const hl = document.querySelector('.search-layout .highlight');
           const card = document.querySelector('.result-card:not(.focus)');
           const cardCs = card ? getComputedStyle(card) : null;
           const space = document.querySelector('.search > .search-container > .search-space > *');
           const hlBg = hl ? getComputedStyle(hl).backgroundColor : null;
           const token = rootCs.getPropertyValue('--textHighlight').trim();
           const a = parseColor(hlBg), t = parseColor(token);
           const rHl = hl ? hl.getBoundingClientRect() : null;
           const rCard = card ? card.getBoundingClientRect() : null;
           const rSpace = space ? space.getBoundingClientRect() : null;
           return {
             count: document.querySelectorAll('.results-container .result-card').length,
             hlFound: !!hl,
             hlBg,
             token,
             hlMatch: !!a && !!t && a.r === t.r && a.g === t.g && a.b === t.b,
             hlIsOldGreen: !!a && a.r === 132 && a.g === 165 && a.b === 157,
             hlParsed: a,
             cardRadius: cardCs ? cardCs.borderRadius : null,
             cardBorder: cardCs ? cardCs.borderTopColor : null,
             glassBorder: rootCs.getPropertyValue('--glass-border').trim(),
             rHl: rHl ? { x: rHl.x, y: rHl.y, width: rHl.width, height: rHl.height } : null,
             rCard: rCard ? { x: rCard.x, y: rCard.y, width: rCard.width, height: rCard.height } : null,
             rSpace: rSpace ? { x: rSpace.x, y: rSpace.y, width: rSpace.width, height: rSpace.height } : null,
           };
         })()`,
      );
      const s5 = await shot(win, `${shotPrefix}-5-搜索弹层带结果`);
      const px5 = makeSampler(s5.img, DPR);
      let searchCell = { ok: false, detail: "搜索弹层未就绪" };
      if (searchProbe.hlFound && searchProbe.rHl) {
        // 结果卡面板底成像（卡内右侧空白）——高亮期望合成色的底
        const cardPx = searchProbe.rCard
          ? medianColor([
              px5.at(
                searchProbe.rCard.x + searchProbe.rCard.width - 8,
                searchProbe.rCard.y + 6,
              ),
              px5.at(
                searchProbe.rCard.x + searchProbe.rCard.width - 14,
                searchProbe.rCard.y + 10,
              ),
            ])
          : null;
        // 高亮上色的成像证据：改用「期望合成色命中率」而非取众数。
        // 众数法在冷色三套（水墨/暮山/玄夜）会给出假阴性——高亮块只一个词宽，
        // 其底纹像素被 inset 下缘线与抗锯齿摊到多个量化桶，单桶都赢不过卡底桶，
        // 众数于是落回卡底、Δ=0。改判据：按 token 的 alpha 把 --textHighlight
        // 合成到卡底成像上得期望色，再统计高亮矩形内逐像素落在该色 ±16 内的比例，
        // ≥12% 即认定确已上色（文字笔画与下缘线占去其余像素）。
        const hlPts = [];
        for (let dx = 1; dx < Math.max(2, searchProbe.rHl.width); dx += 1) {
          for (let dy = 1; dy < Math.max(2, searchProbe.rHl.height); dy += 1) {
            hlPts.push(px5.at(searchProbe.rHl.x + dx, searchProbe.rHl.y + dy));
          }
        }
        const hlPx = modeColor(hlPts);
        const tk = searchProbe.hlParsed;
        const hlExpect =
          tk && cardPx
            ? {
                r: Math.round(tk.a * tk.r + (1 - tk.a) * cardPx.r),
                g: Math.round(tk.a * tk.g + (1 - tk.a) * cardPx.g),
                b: Math.round(tk.a * tk.b + (1 - tk.a) * cardPx.b),
              }
            : null;
        const hlHits = hlExpect
          ? hlPts.filter((p) => (dist(p, hlExpect) || 999) <= 16).length
          : 0;
        const hlRatio = hlPts.length
          ? Math.round((hlHits / hlPts.length) * 1000) / 10
          : 0;
        // 卡角像素：12px 圆角 ⇒ 卡的角点像素应仍是面板底（非卡底），据此验卡形
        const cornerPx = searchProbe.rCard
          ? px5.at(searchProbe.rCard.x + 1, searchProbe.rCard.y + 1)
          : null;
        const greenHit =
          hlPx &&
          Math.abs(hlPx.r - 132) <= 6 &&
          Math.abs(hlPx.g - 165) <= 6 &&
          Math.abs(hlPx.b - 157) <= 6;
        const radiusOk = searchProbe.cardRadius === "12px";
        const hlOk = searchProbe.hlMatch && !searchProbe.hlIsOldGreen;
        const hlPainted = hlRatio >= 12;
        searchCell = {
          ok:
            searchProbe.count > 0 && hlOk && radiusOk && !greenHit && hlPainted,
          detail:
            `命中=${searchProbe.count} 条; 高亮 css=${searchProbe.hlBg}(token=${searchProbe.token} 同源→${searchProbe.hlMatch}, 旧绿→${searchProbe.hlIsOldGreen}); ` +
            `高亮成像众数=${hex(hlPx)}(命中旧绿→${greenHit}) 期望合成=${hex(hlExpect)} 命中率=${hlRatio}%(≥12%→${hlPainted}, 采样${hlPts.length}px); 卡圆角=${searchProbe.cardRadius}(=12px→${radiusOk}) 卡描边=${searchProbe.cardBorder}(--glass-border=${searchProbe.glassBorder}); ` +
            `卡内底成像=${hex(cardPx)} 卡角像素=${hex(cornerPx)}(圆角处应仍为面板底) 面板几何=${searchProbe.rSpace ? `${Math.round(searchProbe.rSpace.width)}x${Math.round(searchProbe.rSpace.height)}` : "-"}`,
        };
      }
      cell.checks.push({
        shot: 5,
        name: "搜索弹层带结果",
        file: path.basename(s5.file),
        ...searchCell,
      });
      record(`矩阵 ${tag} 镜头5 搜索弹层`, searchCell.ok, searchCell.detail);

      await win.webContents.executeJavaScript(
        `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`,
      );
      await sleep(300);

      matrix.push(cell);
      record(
        `矩阵 ${tag} 五镜头齐备`,
        cell.checks.length === 5 && cell.checks.every((c) => c.ok),
        cell.checks.map((c) => `${c.shot}${c.ok ? "✓" : "✗"}`).join(" "),
      );
    }
  }

  // ============ 二、明暗切换协调性（宣纸 / 玄夜）============
  const coord = [];
  for (const key of PHASES.includes("coord") ? ["xuanzhi", "xuanye"] : []) {
    // 先落到该主题 + 浅色
    await win.loadURL(base + "/" + encodeURI(SETTINGS));
    await sleep(700);
    await win.webContents.executeJavaScript(
      `document.querySelector('[data-setting="themeMode"][data-value="light"]').click()`,
    );
    await sleep(250);
    await win.webContents.executeJavaScript(
      `document.querySelector('.kb-theme-card[data-value="${key}"]').click()`,
    );
    await sleep(400);
    await win.loadURL(base + "/" + encodeURI(CHAPTER));
    await sleep(1000);

    const seq = await win.webContents.executeJavaScript(
      `(() => new Promise((resolve) => {
         const sidebar = document.querySelector('.page > #quartz-body > .sidebar');
         const link = document.querySelector('article a.internal[href]');
         if (link) link.scrollIntoView({ block: 'center' });
         const samples = [];
         const read = () => ({
           body: getComputedStyle(document.body).backgroundColor,
           sidebarBefore: sidebar ? getComputedStyle(sidebar, '::before').backgroundColor : null,
           link: link ? getComputedStyle(link).backgroundColor : null,
         });
         const t0 = performance.now();
         samples.push({ t: 0, ...read() });
         const toggle = document.querySelector('.kb-theme-toggle');
         if (!toggle) { resolve({ ok: false, reason: 'no .kb-theme-toggle' }); return; }
         toggle.click();
         const frame = () => {
           const t = Math.round((performance.now() - t0) * 10) / 10;
           samples.push({ t, ...read() });
           if (t < 420) requestAnimationFrame(frame);
           else resolve({ ok: true, savedTheme: document.documentElement.getAttribute('saved-theme'), samples });
         };
         requestAnimationFrame(frame);
       }))()`,
    );
    // 三通道各自：起点 ≠ 终点，且存在中间帧同时 ≠ 起点与终点（=在渐变）
    const channels = ["body", "sidebarBefore", "link"];
    const verdict = {};
    for (const ch of channels) {
      const vals = seq.samples ? seq.samples.map((s) => s[ch]) : [];
      const first = vals[0];
      const last = vals[vals.length - 1];
      const mids = seq.samples
        ? seq.samples.filter(
            (s) => s.t > 0 && s.t < 420 && s[ch] !== first && s[ch] !== last,
          )
        : [];
      verdict[ch] = {
        first,
        last,
        changed: first !== last,
        midCount: mids.length,
        midWindow: mids.length
          ? `${mids[0].t}–${mids[mids.length - 1].t}ms`
          : "-",
        distinct: new Set(vals).size,
        gradual: first !== last && mids.length >= 2,
        trace: mids.slice(0, 3).map((s) => `${s.t}:${s[ch]}`),
      };
    }
    const allGradual = channels.every((c) => verdict[c].gradual);
    // 同频：三通道中间帧窗口相互重叠（成组同频，而非各自为政）
    coord.push({
      theme: key,
      savedTheme: seq.savedTheme,
      frames: seq.samples ? seq.samples.length : 0,
      verdict,
    });
    record(
      `切换协调性 ${key}（三通道 0–420ms 均在渐变）`,
      allGradual,
      channels
        .map(
          (c) =>
            `${c}: ${verdict[c].first} → ${verdict[c].last}（变=${verdict[c].changed}, 中间帧${verdict[c].midCount}@${verdict[c].midWindow}, 取值数${verdict[c].distinct}）`,
        )
        .join(" | ") + `；采样帧=${seq.samples ? seq.samples.length : 0}`,
    );
  }

  // ============ 三、降级路径抽查（无 preload 窗口 = 等效浏览器）============
  const degraded = {};
  const tick = (m) => console.log(`   [降级] ${m}`);
  const plain = PHASES.includes("degrade")
    ? new BrowserWindow({
        width: 1280,
        height: 860,
        show: true,
        webPreferences: { contextIsolation: true, nodeIntegration: false },
      })
    : null;
  if (plain) {
    tick("窗口已建（无 preload）");
    plain.webContents.debugger.attach("1.3");
    tick("CDP 已附着");
  }

  async function emulate(features) {
    await withTimeout(
      plain.webContents.debugger.sendCommand("Emulation.setEmulatedMedia", {
        media: "screen",
        features,
      }),
      15000,
      "Emulation.setEmulatedMedia",
    );
    tick(`已施加 ${features.map((f) => `${f.name}=${f.value}`).join(",")}`);
  }

  // 载入：不依赖 loadURL 的 promise（CDP 附着后它偶发不落定），以
  // did-finish-load 事件为准，并统一套超时
  async function load(w, url) {
    const done = new Promise((resolve) => {
      w.webContents.once("did-finish-load", resolve);
    });
    w.loadURL(url).catch(() => {
      /* 交由 did-finish-load / 超时判定 */
    });
    await withTimeout(done, 30000, `载入 ${url}`);
    tick(`已载入 ${decodeURI(url)}`);
  }

  async function popoverProbe(w) {
    await w.webContents.executeJavaScript(
      `(() => {
         const link = document.querySelector('article a.internal[href]');
         if (!link) return false;
         link.scrollIntoView({ block: 'center' });
         link.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
         return true;
       })()`,
    );
    await sleep(700);
    return w.webContents.executeJavaScript(
      `(() => {
         ${PARSE_COLOR_FN}
         const pop = document.querySelector('.popover.active-popover');
         const inner = pop ? pop.querySelector('.popover-inner') : null;
         if (!inner) return { found: false };
         const cs = getComputedStyle(inner);
         const rootCs = getComputedStyle(document.documentElement);
         const body = getComputedStyle(document.body);
         return {
           found: true,
           bg: cs.backgroundColor,
           bgAlpha: (parseColor(cs.backgroundColor) || {}).a,
           backdrop: cs.backdropFilter,
           webkitBackdrop: cs.webkitBackdropFilter,
           animationName: cs.animationName,
           animationDuration: cs.animationDuration,
           transform: cs.transform,
           innerTransition: cs.transitionDuration,
           bodyTransition: body.transitionDuration,
           glassSolid: rootCs.getPropertyValue('--glass-bg-solid').trim(),
           popoverBgToken: rootCs.getPropertyValue('--popover-bg').trim(),
           durationTheme: rootCs.getPropertyValue('--duration-theme').trim(),
           mqTransparency: matchMedia('(prefers-reduced-transparency: reduce)').matches,
           mqMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
         };
       })()`,
    );
  }

  // ① prefers-reduced-transparency: reduce
  if (!plain) {
    // 阶段被跳过：占位以便报告结构不变
    degraded.skipped = true;
  } else {
    // 顺序红线：**必须先载入真实页面再施加 CDP 媒体特征**。窗口停在 about:blank
    // 时 Emulation.setEmulatedMedia 的响应永不落定（实测挂死 15s 超时），本轮首跑
    // 即栽在这里；载入后施加则即时返回，再重载一次让 load-time 门在降级态下重跑。
    await load(plain, base + "/" + encodeURI(CHAPTER));
    await emulate([{ name: "prefers-reduced-transparency", value: "reduce" }]);
    await load(plain, base + "/" + encodeURI(CHAPTER));
    await sleep(1200);
    tick("开始 popover 探针①");
    const dTrans = await withTimeout(
      popoverProbe(plain),
      20000,
      "popoverProbe①",
    );
    const solidParsed = dTrans.found
      ? await plain.webContents.executeJavaScript(
          `(() => { ${PARSE_COLOR_FN} return parseColor(getComputedStyle(document.documentElement).getPropertyValue('--glass-bg-solid').trim()); })()`,
        )
      : null;
    const bgParsed = dTrans.found
      ? await plain.webContents.executeJavaScript(
          `(() => { ${PARSE_COLOR_FN} const inner = document.querySelector('.popover.active-popover .popover-inner'); return inner ? parseColor(getComputedStyle(inner).backgroundColor) : null; })()`,
        )
      : null;
    const transOk =
      dTrans.found &&
      dTrans.mqTransparency === true &&
      (dTrans.backdrop === "none" || !dTrans.backdrop) &&
      !!bgParsed &&
      bgParsed.a === 1 &&
      !!solidParsed &&
      bgParsed.r === solidParsed.r &&
      bgParsed.g === solidParsed.g &&
      bgParsed.b === solidParsed.b;
    degraded.transparency = { ...dTrans, bgParsed, solidParsed, ok: transOk };
    tick("探针①完成，截图中");
    await withTimeout(
      shot(plain, "降级-reduced-transparency-弹窗"),
      20000,
      "capturePage①",
    );
    record(
      "降级① prefers-reduced-transparency:reduce → 弹窗完全不透明 + backdrop none",
      transOk,
      `mq命中=${dTrans.mqTransparency} 弹窗底=${dTrans.bg}(alpha=${bgParsed ? bgParsed.a : "-"}=1) --glass-bg-solid=${dTrans.glassSolid} 同源→${!!solidParsed && !!bgParsed && bgParsed.r === solidParsed.r && bgParsed.g === solidParsed.g && bgParsed.b === solidParsed.b}; backdrop-filter=${dTrans.backdrop}/-webkit=${dTrans.webkitBackdrop}`,
    );

    // ② prefers-reduced-motion: reduce
    await emulate([{ name: "prefers-reduced-motion", value: "reduce" }]);
    await load(plain, base + "/" + encodeURI(CHAPTER));
    await sleep(1200);
    tick("开始 popover 探针②");
    const dMotion = await withTimeout(
      popoverProbe(plain),
      20000,
      "popoverProbe②",
    );
    const motionOk =
      dMotion.found &&
      dMotion.mqMotion === true &&
      (dMotion.animationName === "none" ||
        dMotion.animationDuration === "0.08s") &&
      dMotion.transform === "none" &&
      dMotion.durationTheme === "80ms" &&
      dMotion.bodyTransition === "0.08s";
    degraded.motion = { ...dMotion, ok: motionOk };
    tick("探针②完成，截图中");
    await withTimeout(
      shot(plain, "降级-reduced-motion-弹窗"),
      20000,
      "capturePage②",
    );
    record(
      "降级② prefers-reduced-motion:reduce → 弹窗无缩放动画 + 过渡压至 80ms",
      motionOk,
      `mq命中=${dMotion.mqMotion} animation-name=${dMotion.animationName} animation-duration=${dMotion.animationDuration} transform=${dMotion.transform}; --duration-theme=${dMotion.durationTheme} body transition-duration=${dMotion.bodyTransition} 弹窗 transition-duration=${dMotion.innerTransition}`,
    );

    plain.webContents.debugger.detach();
    tick("CDP 已卸载");
  }

  // ============================ 报告 ============================
  const pass = results.filter((r) => r.ok).length;
  const lines = [
    `验证时间：${new Date().toISOString()}`,
    `产物目录：${DIST}`,
    `离线护栏：阻断非 127.0.0.1 请求，外部尝试 ${externalAttempts.length} 次`,
    `截图张数：${shots.length}（矩阵 ${matrix.length * 5} 张 + 降级 2 张）`,
    "",
    `结果：${pass}/${results.length} PASS`,
    "",
    ...results.map(
      (r) =>
        `${r.ok ? "PASS" : "FAIL"}  ${r.step}${r.detail ? `  —— ${r.detail}` : ""}`,
    ),
    "",
    "—— 逐格镜头明细 ——",
    ...matrix.flatMap((c) => [
      `[${c.theme}-${c.mode}] ${c.name} --light=${c.applied.light}`,
      ...c.checks.map(
        (k) =>
          `   ${k.ok ? "✓" : "✗"} 镜头${k.shot} ${k.name}（${k.file}）：${k.detail}`,
      ),
    ]),
  ];
  await fs.promises.writeFile(
    path.join(OUT, "report-5shots.txt"),
    lines.join("\n") + "\n",
    "utf8",
  );
  await fs.promises.writeFile(
    path.join(OUT, "report-5shots.json"),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        externalAttempts,
        shots: shots.map((s) => path.basename(s)),
        results,
        matrix,
        coordination: coord,
        degraded,
      },
      null,
      2,
    ),
    "utf8",
  );
  console.log(lines.slice(0, 6).join("\n"));
  console.log(`报告：${path.join(OUT, "report-5shots.txt")}`);

  try {
    server.close();
  } catch {
    /* 服务已关，忽略 */
  }
  app.exit(results.every((r) => r.ok) ? 0 : 1);
}

app.whenReady().then(() =>
  main().catch((err) => {
    console.error("矩阵脚本异常：", err);
    app.exit(2);
  }),
);
