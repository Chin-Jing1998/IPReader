// 预加载脚本：通过 contextBridge 暴露极小的桌面接口给渲染层（保持 contextIsolation 安全）。
//   沿用 site/electron/preload.cjs 的主题 IPC 协议：渲染层可调 setThemeSource(mode)
//   让原生标题栏跟随应用主题（quartz 侧当前未调用，保留为空壳能力，不影响页面）。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  isDesktop: true,
  // mode: 'light' | 'dark' | 'system'
  setThemeSource: (mode) => ipcRenderer.send('set-theme-source', mode),
});
