#!/usr/bin/env node
// installer/index.mjs —— ipreader MCP server 多端安装器
//
// 用法见 --help，完整说明见 ../docs/MCP-安装指南.md。
//
// 安全纪律（硬性，写在最前面）：
//   1. **默认只演练不落盘**。install / remove 不带 --write 时一律只打印落点与将写入的
//      差异，不碰任何文件。这条纪律不可由配置反转，只能由命令行上显式的 --write 解除。
//   2. **写入一律读—改—写 + 写前时间戳备份**。目标文件多为 agent 主配置（Claude Desktop
//      本机实测 38 个 server、Hermes config.yaml 684 行），整体覆盖会毁掉用户的全部配置。
//   3. **解析失败即停**。JSON/YAML 解析不过、或 JSONC 含注释而未显式放行时，报错退出，
//      绝不「尽力而为」地覆盖写。
//   4. **幂等**。已存在 ipreader 条目时更新而非追加，重复运行不产生重复条目。
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeWithBackup, backupFile, backupPathFor, unifiedDiff } from './lib/io.mjs';
import { ConfigParseError } from './lib/json-edit.mjs';
import { YamlEditError } from './lib/yaml-edit.mjs';
import { ADAPTERS, ADAPTER_IDS, getAdapter, detectClaudeLocal } from './adapters/index.mjs';
import {
  SERVER_NAME,
  resolveRuntime,
  buildSpec,
  runtimeErrorMessage,
  DEFAULT_APP_BUNDLE,
  REPO_DIST,
} from './spec.mjs';

const HELP = `ipreader MCP 多端安装器

用法：
  node installer/index.mjs list
  node installer/index.mjs install --agent <目标> [--write]
  node installer/index.mjs install --all
  node installer/index.mjs remove  --agent <目标> [--write]

命令：
  list      探测各目标 agent 是否在位、当前 ipreader 配置状态
  install   生成安装计划（默认只演练）
  remove    生成卸载计划（默认只演练）

目标（--agent 取值，逗号分隔或重复给出）：
${ADAPTERS.map((a) => `  ${a.id.padEnd(22)}${a.label}`).join('\n')}
  --all                 一次处理上述全部七个目标

运行实体：
  --target app          指向已装桌面版（默认）：${DEFAULT_APP_BUNDLE}
  --target repo         指向本仓库构建产物：${REPO_DIST}
  --target <绝对路径>   指向自定义位置（.app 包、含 server.mjs 的目录，或 server.mjs 本身）
  --node <路径>         Node 可执行文件的绝对路径；给 bare 则写裸 node 交由 PATH 解析
  --domains a,b,c       写入 IPREADER_MCP_DOMAINS，按书目域键收窄开放范围

写入控制：
  --write               真实落盘（不给则只演练）。落盘前自动备份为 <文件>.bak.<时间戳>
  --full                演练时打印完整新内容，而非仅打印差异
  --project-root <路径> project 作用域的项目根，默认当前工作目录
  --workspace           ZCode 改写工作区档 <项目根>/.zcode/config.json
  --no-cli              Claude Code user 作用域强制直接写文件，不走 claude CLI
  --allow-drop-comments 允许在重写 JSONC 时丢弃注释（默认遇注释即报错停止）
  --json                以 JSON 输出结果，供脚本消费
`;

/** 解析命令行。 */
export function parseArgs(argv) {
  const opts = {
    command: null,
    agents: [],
    all: false,
    write: false,
    full: false,
    json: false,
    workspace: false,
    noCli: false,
    allowDropComments: false,
    target: 'app',
    nodePath: null,
    domains: null,
    projectRoot: process.cwd(),
    help: false,
  };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case 'list': case 'install': case 'remove': opts.command = a; break;
      case '--list': opts.command = 'list'; break;
      case '--remove': opts.command = 'remove'; break;
      case '--agent': case '-a': opts.agents.push(...String(next()).split(',')); break;
      case '--all': opts.all = true; break;
      case '--write': opts.write = true; break;
      case '--dry-run': opts.write = false; break;
      case '--full': opts.full = true; break;
      case '--json': opts.json = true; break;
      case '--workspace': opts.workspace = true; break;
      case '--no-cli': opts.noCli = true; break;
      case '--allow-drop-comments': opts.allowDropComments = true; break;
      case '--target': opts.target = next(); break;
      case '--node': opts.nodePath = next(); break;
      case '--domains': opts.domains = next(); break;
      case '--project-root': opts.projectRoot = resolve(next()); break;
      case '--help': case '-h': opts.help = true; break;
      default: rest.push(a);
    }
  }
  opts.rest = rest;
  opts.agents = opts.agents.map((s) => s.trim()).filter(Boolean);
  return opts;
}

/** 装配适配器的运行上下文。 */
export function makeContext(opts, overrides = {}) {
  return {
    home: overrides.home || homedir(),
    env: overrides.env || process.env,
    projectRoot: overrides.projectRoot || opts.projectRoot,
    serverName: overrides.serverName || SERVER_NAME,
    workspace: opts.workspace,
    noCli: opts.noCli,
    allowDropComments: opts.allowDropComments,
  };
}

const line = (n = 60) => '─'.repeat(n);

/** list 子命令。 */
function runList(opts, ctx) {
  const runtime = resolveRuntime({ target: opts.target, nodePath: opts.nodePath });
  const report = { runtime: describeRuntime(runtime), targets: [] };

  if (!opts.json) {
    console.log(`ipreader MCP 安装状态\n${line()}`);
    console.log(`运行实体：${runtime.label}`);
    for (const c of runtime.checks) console.log(`  ${c.ok ? '✓' : '✗'} ${c.name}：${c.path}`);
    console.log(`  → ${runtime.ok ? '完整可用' : '不完整，安装前须先补齐（见下方提示）'}`);
    console.log(`\n目标 agent 探测（共 ${ADAPTERS.length} 项）\n${line()}`);
  }

  for (const ad of ADAPTERS) {
    const d = ad.detect(ctx);
    report.targets.push(d);
    if (opts.json) continue;
    console.log(`\n■ ${d.label}  [${d.id}]`);
    for (const p of d.paths) {
      console.log(`  ${p.exists ? '✓' : '✗'} ${p.path}${p.role === 'data' ? '（数据目录）' : ''}`);
    }
    console.log(`  agent 在位：${d.installed ? '是' : '否（未检出任何配置文件）'}`);
    if (d.dataTraces && d.dataTraces.length && !d.installed) {
      console.log(`  线索：检出数据目录 ${d.dataTraces.join('、')}，疑为装过但未留配置`);
    }
    if (d.parseError) console.log(`  ⚠ 解析失败：${d.parseError}`);
    console.log(`  ipreader 条目：${d.configured ? '已配置' : '未配置'}`);
    if (d.configured) {
      const body = typeof d.entry === 'string' ? d.entry : JSON.stringify(d.entry);
      console.log(`    ${body.replace(/\n/g, '\n    ')}`);
    }
    if (d.cli) console.log(`  官方 CLI：${d.cli}`);
    if (d.note) console.log(`  附注：${d.note}`);
  }

  const local = detectClaudeLocal(ctx);
  report.claudeLocal = local;
  if (!opts.json) {
    console.log(`\n■ 附：Claude Code · local 作用域（本工具不写，仅探测）`);
    console.log(`  ${local.exists ? '✓' : '✗'} ${local.path}`);
    console.log(`  项目根：${ctx.projectRoot}`);
    console.log(`  ipreader 条目：${local.entry ? `已配置 ${JSON.stringify(local.entry)}` : '未配置'}`);
    if (!runtime.ok) console.log(`\n${line()}\n${runtimeErrorMessage(runtime)}`);
  } else {
    console.log(JSON.stringify(report, null, 2));
  }
  return 0;
}

function describeRuntime(runtime) {
  return {
    kind: runtime.kind,
    label: runtime.label,
    command: runtime.command,
    args: runtime.args,
    env: runtime.env,
    ok: runtime.ok,
    checks: runtime.checks,
  };
}

/** install / remove 子命令。 */
function runPlan(opts, ctx, mode) {
  const targets = opts.all
    ? ADAPTERS
    : opts.agents.map((id) => {
        const ad = getAdapter(id);
        if (!ad) {
          throw new Error(`未知目标：${id}\n可用目标：${ADAPTER_IDS.join('、')}`);
        }
        return ad;
      });
  if (!targets.length) {
    throw new Error(`未指定目标。用 --agent <目标> 或 --all。\n可用目标：${ADAPTER_IDS.join('、')}`);
  }

  const runtime = resolveRuntime({ target: opts.target, nodePath: opts.nodePath });
  if (mode === 'install' && !runtime.ok) {
    throw new Error(runtimeErrorMessage(runtime));
  }
  const spec = buildSpec(runtime, { domains: opts.domains });
  const now = new Date();

  const results = [];
  let failed = 0;

  if (!opts.json) {
    console.log(
      `ipreader MCP ${mode === 'install' ? '安装' : '卸载'}计划` +
        `（${opts.write ? '真实写入' : '演练 · 不落盘'}）\n${line()}`,
    );
    if (mode === 'install') {
      console.log(`运行实体：${runtime.label}`);
      console.log(`  command：${spec.command}`);
      console.log(`  args   ：${JSON.stringify(spec.args)}`);
      console.log(`  env    ：${JSON.stringify(spec.env)}`);
    }
    console.log(`目标 ${targets.length} 项：${targets.map((t) => t.id).join('、')}`);
  }

  targets.forEach((ad, idx) => {
    const head = `【${idx + 1}/${targets.length}】${ad.label}  [${ad.id}]`;
    let plan;
    try {
      plan = ad.plan(spec, ctx, mode);
    } catch (e) {
      failed++;
      const msg = e instanceof ConfigParseError || e instanceof YamlEditError ? e.message : String(e.stack || e);
      results.push({ id: ad.id, error: msg });
      if (!opts.json) console.log(`\n${head}\n  ✗ 中止：${msg}`);
      return;
    }
    const rendered = renderPlan(ad, plan, opts, now, mode);
    results.push({ id: ad.id, ...rendered.summary });
    if (!opts.json) console.log(`\n${head}\n${rendered.text}`);

    if (opts.write) {
      for (const act of plan.actions) applyAction(act, now, opts.json);
    }
  });

  if (opts.json) console.log(JSON.stringify({ mode, write: opts.write, results }, null, 2));
  else {
    console.log(`\n${line()}`);
    if (!opts.write) {
      console.log('以上为演练结果，未写入任何文件。确认无误后在同一条命令后加 --write 落盘。');
    }
    if (failed) console.log(`${failed} 个目标因错误中止。`);
  }
  return failed ? 1 : 0;
}

/** 把计划渲染成可核对的文本。 */
function renderPlan(ad, plan, opts, now, mode) {
  const out = [];
  const summary = { actions: [], warnings: plan.warnings };
  for (const act of plan.actions) {
    if (act.type === 'noop') {
      out.push(`  · 无需改动：${act.reason}`);
      summary.actions.push({ type: 'noop', reason: act.reason });
      continue;
    }
    if (act.type === 'command') {
      out.push(`  方式：调用官方 CLI（更稳妥，路径与格式由 agent 自行处理）`);
      out.push(`  命令：${act.argv.map(shellQuote).join(' ')}`);
      for (const t of act.backupTargets || []) {
        out.push(`  写前备份：${backupPathFor(t, now)}`);
      }
      summary.actions.push({ type: 'command', argv: act.argv });
      if (act.equivalent) {
        out.push(`  等价落盘：${act.equivalent.path}`);
        out.push(indent(diffBlock(act.equivalent, opts)));
      }
      continue;
    }
    // type === 'file'
    out.push(`  落点：${act.path}${act.existed ? '（已存在，读—改—写）' : '（将新建）'}`);
    if (act.existed) out.push(`  写前备份：${backupPathFor(act.path, now)}`);
    if (!act.changed) {
      out.push(
        mode === 'remove'
          ? '  · 未检出 ipreader 条目，无需卸载'
          : '  · 现有条目与目标一致，无需改动（幂等）',
      );
      summary.actions.push({ type: 'file', path: act.path, changed: false });
      continue;
    }
    out.push(indent(diffBlock(act, opts)));
    summary.actions.push({ type: 'file', path: act.path, changed: true, after: act.after });
  }
  for (const w of plan.warnings) out.push(`  ⚠ ${w}`);
  return { text: out.join('\n'), summary };
}

/** 新建文件打印完整内容，既有文件打印统一差异；--full 一律打印完整内容。 */
function diffBlock(act, opts) {
  if (act.before === null || opts.full) {
    return `${act.before === null ? '将写入的完整内容' : '将写入的完整内容（--full）'}：\n${act.after.replace(/\n$/, '')}`;
  }
  const d = unifiedDiff(act.before, act.after, act.path);
  return `将写入的差异：\n${d}`;
}

const indent = (s, pad = '  ') => s.split('\n').map((l) => pad + l).join('\n');

function shellQuote(s) {
  return /^[A-Za-z0-9_./:=-]+$/.test(s) ? s : `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/** 真实落盘。仅在 --write 时调用。 */
function applyAction(act, now, quiet) {
  if (act.type === 'noop') return;
  if (act.type === 'file') {
    if (!act.changed) return;
    const r = writeWithBackup(act.path, act.after, { now });
    if (!quiet) console.log(`  ✓ 已写入 ${r.written}${r.backup ? `（备份 ${r.backup}）` : ''}`);
    return;
  }
  if (act.type === 'command') {
    for (const t of act.backupTargets || []) {
      const bak = backupFile(t, now);
      if (bak && !quiet) console.log(`  ✓ 已备份 ${t} → ${bak}`);
    }
    const [cmd, ...args] = act.argv;
    const r = spawnSync(cmd, args, { cwd: act.cwd, stdio: 'inherit' });
    if (r.status !== 0) throw new Error(`命令执行失败（退出码 ${r.status}）：${act.argv.join(' ')}`);
    if (!quiet) console.log('  ✓ 命令执行完毕');
  }
}

export function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  if (opts.help || !opts.command) {
    console.log(HELP);
    return opts.command ? 0 : opts.help ? 0 : 1;
  }
  const ctx = makeContext(opts);
  try {
    if (opts.command === 'list') return runList(opts, ctx);
    return runPlan(opts, ctx, opts.command);
  } catch (e) {
    console.error(`\n✗ ${e.message}`);
    return 1;
  }
}

// 直接运行时执行 main；被 import（测试）时不执行。
// 本仓库路径含中文，file:// URL 会被百分号编码，故须经 fileURLToPath 还原后再比较。
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exit(main());
}
