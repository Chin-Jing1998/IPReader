// 主题初始化（v8 起主题控制权移交 settings.inline.ts）：
// 本脚本只负责首帧初始值（兼容无设置桶的旧会话，行为与 darkmode.inline 原逻辑一致）。
// 按钮绑定、系统偏好监听与 themechange 派发均由 settings.inline.ts 按主题模式统一管理；
// 主页面亮暗切换按钮已随布局移除。
const userPref = window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark"
const currentTheme = localStorage.getItem("theme") ?? userPref
document.documentElement.setAttribute("saved-theme", currentTheme)
