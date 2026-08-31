// adapters/claude-code.mjs —— Claude Code 的 user 与 project 两个作用域
//
// Claude Code 是本次七个目标里唯一有三层作用域的：
//   local（默认）  ~/.claude.json 的 projects[<cwd>].mcpServers —— 私有、不可迁移
//   project        <项目根>/.mcp.json                          —— 随仓库进版本控制
//   user           ~/.claude.json 顶层 mcpServers               —— 跨全部项目
// 安装器只提供 project 与 user 两个目标：local 与 project 的差别仅在「是否进版本控制」，
// 而 local 无法迁移、每换一个工作目录就要重配一次，不值得作为推荐路径提供。
//
// user 作用域的写入优先走官方 CLI（claude mcp add --scope user）：
// ~/.claude.json 是 Claude Code 的主状态文件（本机实测 196 KB、70 个顶层键、66 个项目
// 条目，含会话历史与授权信息），由本工具整体反序列化再写回虽可行，但键序与格式
// 完全交给 JSON.stringify 重排，风险显著高于让 CLI 自己改。
// CLI 不在 PATH 时才回落到读—改—写。
import { join } from 'node:path';
import { readTextIfExists } from '../lib/io.mjs';
import { parseConfig, getDeep, ConfigParseError } from '../lib/json-edit.mjs';
import { makeJsonAdapter } from './common.mjs';
import { whichBin } from '../spec.mjs';

/** Claude Code 条目形态：显式声明 type，与本机既有条目一致。 */
function claudeEntry(spec) {
  return {
    type: 'stdio',
    command: spec.command,
    args: [...spec.args],
    env: { ...spec.env },
  };
}

const userBase = makeJsonAdapter({
  id: 'claude-code-user',
  label: 'Claude Code · user 作用域（跨全部项目）',
  agent: 'Claude Code',
  scope: 'user',
  pathOf: (ctx) => join(ctx.home, '.claude.json'),
  keyPath: ['mcpServers', '__name__'],
  entryOf: claudeEntry,
  note: '本机所有会话可用；换机需迁移 ~/.claude.json，故另需在换机参考配置中登记',
});

/** 拼 claude mcp add 的命令行。-- 之后是被执行的命令，不可省。 */
function claudeAddArgv(spec, scope) {
  const argv = ['claude', 'mcp', 'add', '--transport', 'stdio', '--scope', scope];
  for (const [k, v] of Object.entries(spec.env)) argv.push('--env', `${k}=${v}`);
  argv.push(spec.name, '--', spec.command, ...spec.args);
  return argv;
}

export const claudeCodeUser = {
  ...userBase,

  detect(ctx) {
    const base = userBase.detect(ctx);
    const cli = whichBin('claude', ctx.env.PATH);
    return { ...base, cli, note: `${base.note}${cli ? '' : '；未在 PATH 找到 claude CLI'}` };
  },

  plan(spec, ctx, mode) {
    const cli = whichBin('claude', ctx.env.PATH);
    const filePlan = userBase.plan(spec, ctx, mode);
    if (!cli || ctx.noCli) {
      return {
        actions: filePlan.actions,
        warnings: [
          ...filePlan.warnings,
          cli
            ? '已指定 --no-cli，改为直接读—改—写 ~/.claude.json'
            : 'PATH 中未找到 claude CLI，回落为直接读—改—写 ~/.claude.json',
        ],
      };
    }
    const argv =
      mode === 'remove'
        ? ['claude', 'mcp', 'remove', '--scope', 'user', spec.name]
        : claudeAddArgv(spec, 'user');
    return {
      actions: [
        {
          type: 'command',
          argv,
          cwd: ctx.home,
          backupTargets: [join(ctx.home, '.claude.json')],
          equivalent: filePlan.actions[0],
        },
      ],
      warnings: filePlan.warnings,
    };
  },
};

export const claudeCodeProject = makeJsonAdapter({
  id: 'claude-code-project',
  label: 'Claude Code · project 作用域（随仓库迁移）',
  agent: 'Claude Code',
  scope: 'project',
  pathOf: (ctx) => join(ctx.projectRoot, '.mcp.json'),
  keyPath: ['mcpServers', '__name__'],
  entryOf: claudeEntry,
  seed: () => ({ mcpServers: {} }),
  note: '.mcp.json 可进版本控制、随仓库分发；其中的绝对路径在他人机器上未必成立，团队共享前需确认',
});

/**
 * 额外探测：Claude Code 的 local 作用域（projects[<项目根>].mcpServers）。
 * 安装器不写它，但 --list 需要如实呈现「当前实际生效的是哪一层」。
 */
export function detectClaudeLocal(ctx) {
  const path = join(ctx.home, '.claude.json');
  const text = readTextIfExists(path);
  if (text === null) return { path, exists: false, entry: null };
  try {
    const cfg = parseConfig(text, path);
    const entry = getDeep(cfg.value, ['projects', ctx.projectRoot, 'mcpServers', ctx.serverName]);
    return { path, exists: true, entry: entry === undefined ? null : entry };
  } catch (e) {
    return {
      path,
      exists: true,
      entry: null,
      parseError: e instanceof ConfigParseError ? e.message : String(e),
    };
  }
}
