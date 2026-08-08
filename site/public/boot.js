// 引导期错误捕获：在主模块加载前运行（经典脚本先于 deferred 的 module 执行），
//   记录早期 error / unhandledrejection 供 QA/诊断读取 window.__BOOT_ERR。
//   外部化为独立文件（而非内联），以便 CSP 的 script-src 去掉 'unsafe-inline'、收紧为 'self'。
window.__BOOT_ERR = '';
window.addEventListener('error', function (e) {
  window.__BOOT_ERR = (e.error && e.error.stack) || e.message || String(e);
});
window.addEventListener('unhandledrejection', function (e) {
  window.__BOOT_ERR = 'PROMISE: ' + ((e.reason && e.reason.stack) || e.reason);
});
