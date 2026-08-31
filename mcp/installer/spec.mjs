// spec.mjs —— ipreader MCP server 的内部规范模型（单一事实源）
//
// 全部适配器都从本文件取 server 定义，一处改动全家跟随。适配器只负责把这里的
// 规范模型序列化成各家 agent 的配置形态（顶层键名、文件格式、嵌套层级），
// 不得自行拼装 command / args / env。
//
// 运行实体有两种形态：
//   app  —— 已装桌面版 IPReader.app 内的副本（默认）。借 Electron 自带的 Node 运行，
//           故 command 指向 app 的可执行文件、args 指向 app 内的 server.mjs，
//           并须置 ELECTRON_RUN_AS_NODE=1，否则 Electron 会以 GUI 模式启动。
//   repo —— 本仓库的 mcp/dist/server.mjs。用 Node 直接运行，无须桌面版。
//
// env 契约以 server 端实际实现为准（src/data.mjs）：当前只认 IPREADER_MCP_DOMAINS
// （旧名 PATENTREADER_MCP_DOMAINS 兜底）。数据包由 server.mjs 按「同目录 → ../dist/」
// 自行定位，不存在 IPREADER_DATA 一类环境变量，故安装器不写入该变量。
import { existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname, resolve, basename } from 'node:path';
import { delimiter } from 'node:path';

/** MCP server 在各家配置中的条目名。全局唯一，卸载与幂等更新均以它为键。 */
export const SERVER_NAME = 'ipreader';

/** 一句话说明，写入支持 description 字段的 agent（MiniMax Code 等）。 */
export const SERVER_DESCRIPTION =
  'IPReader 知识产权知识库（76 部法规与实务文献，纯离线 stdio）';

/** 数据包文件名，用于校验运行实体是否完整。 */
export const DATA_FILE = 'kb-data.json.gz';

/** 入口文件名。 */
export const ENTRY_FILE = 'server.mjs';

/** macOS 桌面版的默认安装位置。 */
export const DEFAULT_APP_BUNDLE = '/Applications/IPReader.app';

const HERE = dirname(fileURLToPath(import.meta.url));
/** 本仓库的 mcp/ 目录（installer/ 的上一级）。 */
export const MCP_ROOT = dirname(HERE);
/** 本仓库的构建产物目录。 */
export const REPO_DIST = join(MCP_ROOT, 'dist');

/**
 * 在 PATH 中解析可执行文件的绝对路径。
 *
 * 不用 process.execPath：安装器可能被某个 agent 内嵌的 Node 拉起（本机实测
 * Hermes Agent 自带 ~/.hermes/node/bin/node），该路径随该 agent 升级而变，
 * 写进配置会埋下失效隐患。
 *
 * @param {string} bin 可执行文件名
 * @param {string} [pathEnv] PATH 环境变量原值，缺省取 process.env.PATH
 * @returns {string|null} 绝对路径；PATH 中找不到时返回 null
 */
export function whichBin(bin, pathEnv = process.env.PATH || '') {
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    const p = join(dir, bin);
    try {
      const st = statSync(p);
      if (st.isFile() && st.mode & 0o111) return p;
    } catch {
      /* 该目录不存在或无权访问，继续下一个 */
    }
  }
  return null;
}

/**
 * 解析 --target 取值，得到运行实体描述与在位性校验结果。
 *
 * @param {object} [opts]
 * @param {string} [opts.target] 'app'（默认）、'repo'，或一个绝对路径
 *   （可指向 .app 包、含 server.mjs 的目录，或 server.mjs 本身）
 * @param {string} [opts.nodePath] Node 可执行文件路径；'bare' 表示写裸 node 交由 PATH 解析
 * @returns {{kind:'app'|'node', bundle?:string, entry:string, dataFile:string,
 *            command:string, args:string[], env:Record<string,string>,
 *            checks:{name:string, path:string, ok:boolean}[], ok:boolean, label:string}}
 */
export function resolveRuntime(opts = {}) {
  const target = opts.target || 'app';

  if (target === 'app') return appRuntime(DEFAULT_APP_BUNDLE);
  if (target === 'repo') return nodeRuntime(REPO_DIST, opts.nodePath);

  const abs = resolve(target);
  if (abs.endsWith('.app')) return appRuntime(abs);
  if (basename(abs) === ENTRY_FILE) return nodeRuntime(dirname(abs), opts.nodePath);
  // 指向 .app 内的 Resources/mcp 也按 app 形态处理（可执行文件在同一包内）
  const appMatch = abs.match(/^(.*\.app)\/Contents\/Resources\/mcp\/?$/);
  if (appMatch) return appRuntime(appMatch[1]);
  return nodeRuntime(abs, opts.nodePath);
}

/**
 * 桌面版形态：借 Electron 主可执行文件以 Node 模式运行 app 内的 server.mjs。
 *
 * 路径取自 desktop/package.json 的 build.extraResources（from: ../mcp/dist → to: mcp），
 * 故 app 内是扁平的 Contents/Resources/mcp/server.mjs，**没有** dist 这一层。
 */
function appRuntime(bundle) {
  const exeDir = join(bundle, 'Contents', 'MacOS');
  const exe = join(exeDir, basename(bundle).replace(/\.app$/, ''));
  const mcpDir = join(bundle, 'Contents', 'Resources', 'mcp');
  const entry = join(mcpDir, ENTRY_FILE);
  const dataFile = join(mcpDir, DATA_FILE);
  const checks = [
    { name: '应用包', path: bundle, ok: existsSync(bundle) },
    { name: '可执行文件', path: exe, ok: existsSync(exe) },
    { name: 'MCP 入口', path: entry, ok: existsSync(entry) },
    { name: '数据包', path: dataFile, ok: existsSync(dataFile) },
  ];
  return {
    kind: 'app',
    label: `桌面版应用内副本（${bundle}）`,
    bundle,
    entry,
    dataFile,
    command: exe,
    args: [entry],
    env: { ELECTRON_RUN_AS_NODE: '1' },
    checks,
    ok: checks.every((c) => c.ok),
  };
}

/** 直跑形态：用 Node 运行指定目录下的 server.mjs。 */
function nodeRuntime(dir, nodePath) {
  const entry = join(dir, ENTRY_FILE);
  const dataFile = join(dir, DATA_FILE);
  let command;
  if (nodePath === 'bare') command = 'node';
  else if (nodePath) command = nodePath;
  else command = whichBin('node') || 'node';
  const checks = [
    { name: 'MCP 入口', path: entry, ok: existsSync(entry) },
    { name: '数据包', path: dataFile, ok: existsSync(dataFile) },
    {
      name: 'Node 可执行文件',
      path: command,
      ok: command === 'node' ? true : existsSync(command),
    },
  ];
  return {
    kind: 'node',
    label: `Node 直跑（${dir}）`,
    entry,
    dataFile,
    command,
    args: [entry],
    env: {},
    checks,
    ok: checks.every((c) => c.ok),
  };
}

/**
 * 由运行实体装配 server 规范模型。适配器的唯一输入。
 *
 * @param {ReturnType<typeof resolveRuntime>} runtime
 * @param {object} [opts]
 * @param {string} [opts.domains] IPREADER_MCP_DOMAINS 取值（逗号分隔的 domain 键）
 * @returns {{name:string, transport:'stdio', command:string, args:string[],
 *            env:Record<string,string>, description:string, runtime:object}}
 */
export function buildSpec(runtime, opts = {}) {
  const env = { ...runtime.env };
  if (opts.domains) env.IPREADER_MCP_DOMAINS = opts.domains;
  return {
    name: SERVER_NAME,
    transport: 'stdio',
    command: runtime.command,
    args: [...runtime.args],
    env,
    description: SERVER_DESCRIPTION,
    runtime,
  };
}

/**
 * 运行实体不完整时的报错文案（含已尝试的全部路径与补救指引）。
 * @param {ReturnType<typeof resolveRuntime>} runtime
 * @returns {string}
 */
export function runtimeErrorMessage(runtime) {
  const lines = [`运行实体不完整——${runtime.label}`, ''];
  for (const c of runtime.checks) {
    lines.push(`  ${c.ok ? '✓' : '✗'} ${c.name}：${c.path}`);
  }
  lines.push('');
  if (runtime.kind === 'app') {
    lines.push('补救：');
    lines.push('  1. 安装或重装桌面版 IPReader（默认落在 /Applications/IPReader.app）；');
    lines.push('  2. 应用装在别处时用 --target /实际路径/IPReader.app 指定；');
    lines.push('  3. 不装桌面版时改用 --target repo，指向本仓库的 mcp/dist/server.mjs。');
  } else {
    lines.push('补救：');
    lines.push('  1. 在 mcp/ 目录执行 npm run build 生成 dist/server.mjs 与 kb-data.json.gz；');
    lines.push('  2. 或改用 --target app 指向已装的桌面版。');
  }
  return lines.join('\n');
}
