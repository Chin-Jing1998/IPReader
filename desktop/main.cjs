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

  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1080,
    minHeight: 700,
    // quartz 亮色主题底色，避免启动白闪/黑闪失衡
    backgroundColor: '#faf8f8',
    title: '专利知识库',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      // Electron 20+ 本已默认开启，此处显式声明——升级换代时默认值一旦漂移，
      // 沉默地丢掉渲染进程沙箱是最不该出现的回归
      sandbox: true,
    },
  });
  win.setMenuBarVisibility(false);

  // 站内页面均在本地端口；万一出现外链（正常构建不应有）交给系统浏览器
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url) && !url.startsWith(`http://127.0.0.1:${port}`)) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
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

// 渲染层主题模式 → 原生窗口/标题栏外观（沿用 site 的主题 IPC 协议）
ipcMain.on('set-theme-source', (_e, mode) => {
  if (mode === 'light' || mode === 'dark' || mode === 'system') {
    nativeTheme.themeSource = mode;
  }
});

app.whenReady().then(createWindow);

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
