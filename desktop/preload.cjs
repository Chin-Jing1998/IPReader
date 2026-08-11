// 预加载脚本：通过 contextBridge 暴露极小的桌面接口给渲染层（保持 contextIsolation 安全）。
//   主题 IPC 协议 setThemeSource(mode, bgColor)——渲染层（settings.inline.ts）在主题模式
//   或主题风格变化时调用，主进程侧处理见 main.cjs 的 'set-theme-source'：
//     mode:    'light' | 'dark' | 'system'，落到 nativeTheme.themeSource，
//              让原生标题栏与系统控件跟随应用主题；
//     bgColor: 当前主题实际底色 hex（如 '#201c16'），用于同步原生窗口背景色并持久化。
//              这一项是必要的：原生底色是「网页首帧渲染前」与「关窗合成间隙」用户唯一
//              看得见的颜色，不同步就会在深色主题下关窗白闪。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  isDesktop: true,
  // 渲染层据此决定是否显示自绘标题条；旧产物混搭时 undefined→不显示，优雅降级
  isMac: process.platform === 'darwin',
  setThemeSource: (mode, bgColor) => ipcRenderer.send('set-theme-source', { mode, bgColor }),
  // 批注 md 落盘（v8）：选择保存目录 + 写入/删除 Markdown 文件
  chooseAnnoDir: () => ipcRenderer.invoke('anno-choose-dir'),
  saveAnnoMarkdown: (payload) => ipcRenderer.invoke('anno-save-md', payload),
});
