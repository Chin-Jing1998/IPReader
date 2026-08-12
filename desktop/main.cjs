// 专利知识库桌面端 · Electron 主进程（以 site/electron/main.cjs 为底改造）。
//   渲染层是 quartz 构建好的纯静态站（quartz-kb/public/），由 server.cjs 的本地
//   http 静态服务在 127.0.0.1 固定端口 47821 托管后加载——避免 file:// 协议下
//   fetch contentIndex.json 等资源被安全策略拦截。
//   系统要求：macOS 12+ / Windows 10+（Electron 43）。Electron 22 已于 2023-10 停止
//   安全支持，2026-08 升级至受支持版本，随之放弃 Windows 7/8.1（Electron 23 起不再支持）。
//
//   端口为何固定：浏览器按「协议 + 主机 + 端口」隔离 localStorage，页面里的
//   批注、笔记与高亮都存在那里。端口每次启动都变，等于每次都换一个空存储桶。
//
//   站点产物定位：
//     开发（npm start）  → ../quartz-kb/public
//     打包（electron-builder）→ extraResources 带入 Resources/kb-public，
//                             运行时经 process.resourcesPath 解析。
const { app, BrowserWindow, shell, nativeTheme, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { startStaticServer, probeHealth, DEFAULT_PORT } = require('./server.cjs');

const DIST = app.isPackaged
  ? path.join(process.resourcesPath, 'kb-public')
  : path.join(__dirname, '..', 'quartz-kb', 'public');

// 逃生口：端口长期被占时可改用其它端口启动（注意换端口后旧批注不可见，
// 需先在旧端口下导出 JSON 再于新端口导入）
const PORT = Number(process.env.PATENT_KB_PORT) || DEFAULT_PORT;

// 单实例锁：从根上避免"自己占自己的端口"这一最常见的冲突来源。
// 顶层 return 终止模块执行（CommonJS 模块体被包装成函数，此处合法且必要）——
// app.quit() 是异步的，若继续往下注册 whenReady 回调，退出完成前仍可能触发
// createWindow 去抢端口，那正是单实例锁本要防住的事。
if (!app.requestSingleInstanceLock()) {
  app.quit();
  return;
}

/**
 * 占用固定端口时的处置。
 * 明确不做「静默换端口」——换端口就换 origin，用户全部批注会凭空消失且毫无提示，
 * 那是数据丢失级别的事故，比一次明确的启动失败严重得多。
 * @returns {Promise<number|null>} 可继续使用的端口；null 表示应终止启动
 */
async function resolvePortConflict(err) {
  if (err.code !== 'EADDRINUSE') {
    console.error('本地静态服务启动失败', err);
    dialog.showErrorBox('启动失败', `本地静态服务无法启动：\n${err.message}`);
    return null;
  }
  // 占用者是本应用的另一实例（单实例锁未覆盖的场景，如打包版与开发版并存）→ 复用
  const who = await probeHealth(PORT);
  if (who) {
    return PORT;
  }
  dialog.showErrorBox(
    '端口被占用',
    `本地端口 ${PORT} 已被其它程序占用。\n\n` +
      `本应用固定使用该端口，以保证您的批注、笔记与高亮不丢失`+
      `（浏览器按「地址 + 端口」隔离本地数据，换端口等同于换了一个空数据库）。\n\n` +
      `请关闭占用该端口的程序后重试。\n` +
      `若需长期改用其它端口，可设置环境变量 PATENT_KB_PORT；` +
      `但改端口前请先在原端口下导出批注 JSON，再于新端口导入。`,
  );
  return null;
}

// ── 窗口底色持久化 ────────────────────────────────────────────────────
// 原生窗口背景色是「网页首帧渲染出来之前」和「关窗合成间隙」用户唯一看得见的颜色。
// 曾硬编码为浅色，深色主题下关窗那一瞬会露出白底（白闪）。因此：渲染层每次主题/风格
// 变化都把当前实际底色报上来，主进程即时改窗口底色并落盘，下次冷启动直接用对的颜色建窗。
// 路径惰性解析：app.getPath('userData') 依赖 app.name，模块加载期取值存在拿到
// 默认名目录（.../Electron）的风险；本文件所有调用点都在 app ready 之后。
const windowStateFile = () => path.join(app.getPath('userData'), 'window-state.json');
// 回落值 = 默认主题「宣纸」的亮/暗底色（与 quartz-kb 的 [data-style="xuanzhi"] 保持一致）
const DEFAULT_BG = { light: '#feefe5', dark: '#201c16' };
const THEME_MODES = ['light', 'dark', 'system'];
// 只接受 hex 颜色：这个值会直接进原生 API，来源虽是本地渲染层也不做无校验透传
const HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

/**
 * 读取持久化的主题状态。文件不存在（首次运行）或损坏一律回落默认值——
 * 一个装饰性的颜色偏好绝不该阻断启动。
 * @returns {{ mode: string, byScheme: { light: string, dark: string } }}
 */
function readWindowState() {
  try {
    const raw = JSON.parse(fs.readFileSync(windowStateFile(), 'utf8'));
    const byScheme = (raw && raw.byScheme) || {};
    return {
      mode: THEME_MODES.includes(raw && raw.mode) ? raw.mode : 'system',
      byScheme: {
        light: HEX_COLOR_RE.test(byScheme.light) ? byScheme.light : DEFAULT_BG.light,
        dark: HEX_COLOR_RE.test(byScheme.dark) ? byScheme.dark : DEFAULT_BG.dark,
      },
    };
  } catch {
    return { mode: 'system', byScheme: { ...DEFAULT_BG } };
  }
}

function writeWindowState(state) {
  try {
    const file = windowStateFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(state, null, 2), 'utf8');
  } catch (e) {
    // 落盘失败只影响「下次启动的首帧颜色」，不影响本次会话，记录即可
    console.error('窗口底色持久化失败', e);
  }
}

async function createWindow() {
  let port;
  try {
    ({ port } = await startStaticServer(DIST, { port: PORT }));
  } catch (e) {
    port = await resolvePortConflict(e);
    if (port === null) {
      app.quit();
      return;
    }
  }

  // 建窗底色取上次会话上报的实际底色，按当前亮/暗态二选一。
  // themeSource 已在 whenReady 中按持久化的 mode 设好，故此处 shouldUseDarkColors
  // 反映的是「用户在应用内选定的模式」而非单纯的系统外观。
  const { byScheme } = readWindowState();

  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1080,
    minHeight: 700,
    backgroundColor: nativeTheme.shouldUseDarkColors ? byScheme.dark : byScheme.light,
    // 首帧渲染完成前不显示：即便底色已持久化，仍要避免空窗口先亮一下再上内容
    show: false,
    title: 'Patentia',
    autoHideMenuBar: true,
    // 仅 macOS 启用自绘标题条：Windows 上 hiddenInset 会退化为 hidden，且未配合
    // titleBarOverlay 时窗口控制按钮（最小化/最大化/关闭）会消失，必须平台门控
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      // Electron 20+ 本已默认开启，此处显式声明——升级换代时默认值一旦漂移，
      // 沉默地丢掉渲染进程沙箱是最不该出现的回归
      sandbox: true,
    },
  });
  // SPA 每次导航都会改 document.title，不拦截会让调度中心/窗口菜单标题随页面漂移；
  // 窗口标题固定为构造时的 Patentia（与 productName 一致）
  win.on('page-title-updated', (e) => { e.preventDefault(); });
  win.setMenuBarVisibility(false);
  win.once('ready-to-show', () => win.show());

  // 站内页面均在本地端口；万一出现外链（正常构建不应有）交给系统浏览器
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url) && !url.startsWith(`http://127.0.0.1:${port}`)) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  // 主框架内 mailto（设置页「关于」的联系邮箱）：显式交给系统邮件客户端。
  // Electron 默认的外部协议链路今日也放行，此处显式化以防默认行为随版本漂移。
  win.webContents.on('will-navigate', (e, url) => {
    if (url.startsWith('mailto:')) {
      e.preventDefault();
      shell.openExternal(url);
    }
  });

  // 页面长时间无响应：给用户一个明确的选择，而不是让他对着卡死的窗口干等。
  // 重载不会丢批注——每次标注操作都已即时写入 localStorage（annotate.inline.ts 的 persist）
  win.webContents.on('unresponsive', async () => {
    const { response } = await dialog.showMessageBox(win, {
      type: 'warning',
      title: '页面无响应',
      message: '页面暂时没有响应。',
      detail: '可以继续等待，或重新载入当前页。您已做的批注、笔记与高亮不会丢失。',
      buttons: ['继续等待', '重新载入'],
      defaultId: 0,
      cancelId: 0,
    });
    if (response === 1) win.webContents.reload();
  });

  // 启动首屏 = 文档站首页（server.cjs 对 "/" 解析为 index.html，见 server.cjs:88）
  win.loadURL(`http://127.0.0.1:${port}/`);
}

// ── 崩溃兜底 ──────────────────────────────────────────────────────────
// 自愈须节流：短时间内反复崩溃说明是确定性问题（例如某页必崩），
// 无条件重载只会把白屏换成死循环。
const CRASH_WINDOW_MS = 3 * 60 * 1000;
const CRASH_MAX = 3;
let crashTimes = [];

function shouldAutoReload() {
  const now = Date.now();
  crashTimes = crashTimes.filter((t) => now - t <= CRASH_WINDOW_MS).concat(now);
  return crashTimes.length <= CRASH_MAX;
}

// 渲染进程终止。不处理就是一片白屏——用户既看不到原因，也无从恢复。
app.on('render-process-gone', (_e, contents, details) => {
  console.error('渲染进程终止：', details);
  if (details.reason === 'clean-exit') return;
  if (shouldAutoReload()) {
    contents.reload();
    return;
  }
  dialog.showErrorBox(
    '页面反复崩溃',
    `页面在 3 分钟内连续崩溃 ${CRASH_MAX} 次，已停止自动重载。\n\n` +
      `崩溃原因：${details.reason}\n\n` +
      `请重启应用。若问题持续出现，请连同上述原因一并反馈。`,
  );
});

// GPU/工具进程崩溃通常不致命（Chromium 会自行重建），记录即可
app.on('child-process-gone', (_e, details) => {
  console.error('子进程终止：', details.type, details.reason);
});

// 兜底：未捕获异常不静默吞掉，否则故障只会以"某功能忽然不工作"的形式浮现
process.on('uncaughtException', (err) => {
  console.error('未捕获异常：', err);
  dialog.showErrorBox('发生未预期的错误', String((err && err.stack) || err));
});

process.on('unhandledRejection', (reason) => {
  console.error('未处理的 Promise 拒绝：', reason);
});

// 渲染层主题模式 + 当前主题实际底色 → 原生窗口/标题栏外观（协议见 preload.cjs）。
// 载荷双形态容错：新 preload 发对象 { mode, bgColor }，历史版本发裸字符串 mode——
// 打包产物与站点产物可能不同步更新，收窄成单一形态会在混搭时静默丢主题。
/**
 * 应用一次主题上报，并回报「生效后」的亮暗态。
 * @param {Electron.WebContents} sender 上报方，用于定位其所属窗口
 * @param {{ mode?: string, bgColor?: string }|string} arg
 * @returns {boolean} nativeTheme.shouldUseDarkColors（themeSource 赋值后同步更新）
 */
function applyThemeSourcePayload(sender, arg) {
  const payload = typeof arg === 'string' ? { mode: arg } : arg || {};
  const mode = THEME_MODES.includes(payload.mode) ? payload.mode : null;
  // 先落 themeSource，下面才能按「生效后的亮暗态」判断该写哪一槽
  if (mode) nativeTheme.themeSource = mode;

  const bgColor = HEX_COLOR_RE.test(payload.bgColor) ? payload.bgColor : null;
  if (bgColor) {
    // 即时生效：本次会话内切过主题后再关窗，也不会闪出建窗时那个旧色
    const win = BrowserWindow.fromWebContents(sender);
    if (win && !win.isDestroyed()) win.setBackgroundColor(bgColor);
  }
  if (!mode && !bgColor) return nativeTheme.shouldUseDarkColors;

  // 双槽持久化：渲染层单次只能报出当前亮暗侧的颜色，故只覆写对应那一槽，
  // 另一槽保留上次记录——否则跨模式冷启动会拿错颜色。
  const state = readWindowState();
  const scheme = nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
  const next = {
    mode: mode || state.mode,
    byScheme: bgColor ? { ...state.byScheme, [scheme]: bgColor } : state.byScheme,
  };
  // 值未变不写盘：主题上报是高频动作（每次导航初始化也会报一次），无谓的同步写会拖慢主进程
  if (next.mode !== state.mode || next.byScheme[scheme] !== state.byScheme[scheme]) {
    writeWindowState(next);
  }
  return nativeTheme.shouldUseDarkColors;
}

// 旧单向通道：站点产物与打包壳各自更新，旧站点跑在新壳上时仍走这里，不可删。
ipcMain.on('set-theme-source', (e, arg) => {
  applyThemeSourcePayload(e.sender, arg);
});

// 新通道：回传主进程侧的权威亮暗态。渲染层 send 后同步读 matchMedia 拿到的仍是
// 上一次 themeSource 强制的旧值，切到「跟随系统」时会先按旧值渲染再纠正（双跳）。
ipcMain.handle('apply-theme-source', (event, payload) => ({ dark: applyThemeSourcePayload(event.sender, payload) }));

// ── 批注 md 落盘（v8）──────────────────────────────────────────────
// 渲染层（annotate.inline.ts）在批注变更后调 saveAnnoMarkdown 写 Markdown 文件。
// 安全模型：只接受「本会话内经 anno-choose-dir 选定的目录」为根，
// relativePath 解析后必须仍位于根内（防目录穿越），根目录按 webContents 隔离。
const annoDirs = new Map(); // webContents.id -> 根目录

ipcMain.handle('anno-choose-dir', async (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win) return null;
  const r = await dialog.showOpenDialog(win, {
    title: '选择批注保存目录',
    buttonLabel: '选择',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (r.canceled || r.filePaths.length === 0) return null;
  const dir = r.filePaths[0];
  annoDirs.set(e.sender.id, dir);
  return dir;
});

ipcMain.handle('anno-save-md', (e, payload) => {
  const root = annoDirs.get(e.sender.id);
  if (!root || !payload || typeof payload !== 'object') {
    throw new Error('未选择批注保存目录，请在设置中先选择目录');
  }
  const { relativePath, content, remove } = payload;
  if (typeof relativePath !== 'string' || relativePath.length === 0 || relativePath.includes('\0')) {
    throw new Error('非法文件路径');
  }
  const target = path.resolve(root, relativePath);
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error('路径越界，拒绝写入');
  }
  if (remove) {
    fs.rmSync(target, { force: true });
    return true;
  }
  if (typeof content !== 'string') {
    throw new Error('文件内容非法');
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, 'utf8');
  return true;
});

// ── Dock 图标随系统深浅色自动切换 ──────────────────────────────────────
// 浅色模式用浅底图标（方案 A），深色模式用深蓝底图标（方案 B）。
// macOS Dock 图标支持运行时替换；Finder/启动台中的包图标（icns）保持浅底不变。
const DOCK_ICON_LIGHT = app.isPackaged
  ? path.join(process.resourcesPath, 'icons', 'icon-light.png')
  : path.join(__dirname, 'build', 'icon.png');
const DOCK_ICON_DARK = app.isPackaged
  ? path.join(process.resourcesPath, 'icons', 'icon-dark.png')
  : path.join(__dirname, 'build', 'icon-dark.png');

function applyDockIcon() {
  if (process.platform !== 'darwin') return;
  const file = nativeTheme.shouldUseDarkColors ? DOCK_ICON_DARK : DOCK_ICON_LIGHT;
  app.dock.setIcon(file);
}

// 系统外观变化（浅色↔深色、手动切换）时即时跟随
nativeTheme.on('updated', applyDockIcon);

app.whenReady().then(() => {
  // 建窗前先恢复主题模式：createWindow 与 applyDockIcon 都读 shouldUseDarkColors，
  // 不先设 themeSource，用户选定的 light/dark 在首帧会被系统外观顶掉。
  nativeTheme.themeSource = readWindowState().mode;
  createWindow();
  applyDockIcon();
});

// 第二次启动：聚焦已有窗口而非再开一个（配合单实例锁）
app.on('second-instance', () => {
  const [win] = BrowserWindow.getAllWindows();
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
