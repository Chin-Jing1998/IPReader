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
  // 同一协议的双向版：解析为 { dark }，即主进程侧 themeSource 生效后的权威亮暗态。
  // 渲染层不可用 matchMedia 自行判断——那读到的是上一次 themeSource 强制的旧值。
  // 旧壳上本项为 undefined，渲染层据此退回 setThemeSource 单向路径。
  applyThemeSource: (mode, bgColor) => ipcRenderer.invoke('apply-theme-source', { mode, bgColor }),
  // 批注 md 落盘（v8）：选择保存目录 + 写入/删除 Markdown 文件
  chooseAnnoDir: () => ipcRenderer.invoke('anno-choose-dir'),
  saveAnnoMarkdown: (payload) => ipcRenderer.invoke('anno-save-md', payload),
  // 更新检查（v9）：本应用唯一会联网的功能，默认关闭。
  //   getUpdateConfig 读当前版本号与「启动时自动检查」开关；setAutoCheckUpdate 写开关；
  //   checkUpdate 立即查一次（只取版本号，不下载）；openReleases 用系统浏览器打开发布页。
  // 请求在主进程侧发出，故不受页面 CSP 的 connect-src 'self' 约束，也不扩大渲染层权限。
  getUpdateConfig: () => ipcRenderer.invoke('update-get-config'),
  setAutoCheckUpdate: (enabled) => ipcRenderer.invoke('update-set-auto', enabled),
  checkUpdate: () => ipcRenderer.invoke('update-check'),
  openReleases: (url) => ipcRenderer.invoke('update-open-releases', url),
  // MCP 接入（v9）：getMcpInfo 返回本机的真实路径（打包/开发、mac/Windows 各不相同，
  // 故由主进程给出）；copyText 把拼好的配置命令送进系统剪贴板。
  getMcpInfo: () => ipcRenderer.invoke('mcp-get-info'),
  copyText: (text) => ipcRenderer.invoke('copy-text', text),
});
