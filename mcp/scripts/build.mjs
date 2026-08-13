// build.mjs —— 把 src/ 打包成自包含的单文件 dist/server.mjs
//
// 分发形态即「预打包单文件」：SDK、zod、flexsearch 全部内联，用户拿到仓库或安装包后
// 无须 npm install、无须联网，直接 node dist/server.mjs 即可运行。
// dist/ 因此必须入库（见 .gitignore 的说明）。
//
// 用法：node scripts/build.mjs
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { statSync } from 'node:fs';

const MCP_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(MCP_DIR, 'dist', 'server.mjs');

const result = await build({
  entryPoints: [join(MCP_DIR, 'src', 'server.mjs')],
  outfile: OUT,
  bundle: true,
  platform: 'node',
  format: 'esm',
  // 取 node18 而非本机版本：桌面应用内以 Electron 自带的 Node 运行，
  // 版本随 Electron 走，放宽 target 可免去版本错配的风险
  target: 'node18',
  minify: true,
  legalComments: 'none',
  // 内联的依赖中有 CJS 模块（flexsearch），其 require/__dirname 在 ESM 下无定义，
  // 故补 createRequire 垫片。node: 前缀的内置模块由 platform:node 自动外部化。
  banner: {
    js: [
      "import { createRequire as __createRequire } from 'node:module';",
      "import { fileURLToPath as __fileURLToPath } from 'node:url';",
      "import { dirname as __pathDirname } from 'node:path';",
      'const require = __createRequire(import.meta.url);',
      'const __filename = __fileURLToPath(import.meta.url);',
      'const __dirname = __pathDirname(__filename);',
    ].join('\n'),
  },
  metafile: true,
});

const size = statSync(OUT).size;
const inputs = Object.keys(result.metafile.inputs).length;
console.log(`打包完成：${OUT}`);
console.log(`  ${(size / 1024).toFixed(0)} KB · 内联 ${inputs} 个模块 · 零运行时依赖`);
if (result.warnings.length) {
  console.log(`  警告 ${result.warnings.length} 条：`);
  for (const w of result.warnings) console.log(`    ${w.text}`);
}
