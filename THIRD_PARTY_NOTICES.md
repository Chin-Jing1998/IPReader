# 第三方组件声明

## Quartz v4

本项目的文档站（`quartz-kb/`）是 **Quartz v4.5.2** 的定制分支。

```
MIT License
Copyright (c) 2021 jackyzha0
```

许可全文见 [`quartz-kb/LICENSE.txt`](quartz-kb/LICENSE.txt)（原样保留）。上游项目：https://github.com/jackyzha0/quartz

本项目对其所作的主要改动记于 [`quartz-kb/README-patent.md`](quartz-kb/README-patent.md)，源码中的改动点以 `// ==== patent-kb: … ====` 注释块标识。改动包括：离线化（移除全部 CDN 与外部字体引用）、中文排版与四字体体系、术语链接、图谱总览页、翻页组件、选中文本批注系统，以及若干稳定性加固。

> MIT 的义务是在软件的副本或实质性部分中保留版权声明与许可全文。本仓库通过保留 `LICENSE.txt` 与本声明履行该义务；页面署名非该许可的要求。

## 运行时依赖

文档站的主要第三方组件：

| 组件 | 用途 |
|---|---|
| pixi.js | 知识图谱的 WebGL 渲染 |
| d3 | 图谱的力导向布局 |
| flexsearch | 全文搜索索引 |
| @floating-ui/dom | 悬浮预览与批注工具条的定位 |
| micromorph | SPA 换页的 DOM 变形 |
| rehype / remark 系列 | markdown 解析与 HTML 生成 |
| sharp | 构建期图像处理 |

桌面端（`desktop/`）：

| 组件 | 用途 |
|---|---|
| Electron | 应用外壳 |
| electron-builder | 打包与分发 |

内容生成器（`site/`）零第三方依赖，仅使用 Node 内置模块。

完整依赖树与各组件的许可信息见各子目录的 `package.json` 与 `package-lock.json`；本地安装后可用 `npx license-checker` 逐项列出。

## 字体

不内嵌任何字体文件。排版使用系统字体栈（黑体 / 宋体 / 楷体 / 仿宋），由各操作系统提供，不随本软件分发。
