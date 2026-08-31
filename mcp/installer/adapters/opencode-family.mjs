// adapters/opencode-family.mjs —— OpenCode 与 MiMo Code
//
// MiMo Code 是 OpenCode 的 fork（官方 README 明示，旁证是其 macOS MDM 托管偏好文件名
// 仍为 ai.opencode.managed.plist），MCP 配置格式完全同构：
//   顶层键 mcp（不是 mcpServers）、type: "local"、command 为「可执行文件 + 全部参数」的
//   数组、环境变量键名是 environment（不是 env）、另有 enabled 布尔开关。
// 因此一个序列化分支覆盖两家，适配器之间只换路径与 $schema。
//
// ── MiMo Code 的落点为何选 mimocode.jsonc ──
// 其全局配置目录（$XDG_CONFIG_HOME/mimocode/，macOS 默认 ~/.config/mimocode/）内
// config.json → mimocode.json → mimocode.jsonc 三个文件**依次合并、后者覆盖前者**。
// 写在前两个文件里的条目会被同目录后序文件的同名键覆盖，而 mimocode.jsonc 是
// 用户可写层里优先级最高的一个，故选它作为回落落点。
// 官方另有 macOS MDM managed 层（/Library/Managed Preferences/…）整段覆盖全部用户级
// 设置，本工具不触碰该层，若企业下发了托管配置则以其为准。
//
// ── 为何仍以官方 CLI 为首选 ──
// 官方明确没有 --config／--config-file 这类 flag，路径改由 MIMOCODE_HOME／MIMOCODE_CONFIG／
// MIMOCODE_CONFIG_DIR 环境变量控制；加上上述多层合并规则，手工选错落点极易被覆盖。
// 但 `mimo mcp add` 是**引导式交互命令**，无法非交互传参，脚本无从代劳——
// 故本适配器的做法是：探测到 mimo 在 PATH 时提示优先手动跑一次官方命令，
// 计划本身仍按 mimocode.jsonc 回落路径生成，两条路都留给用户。
import { join } from 'node:path';
import { makeJsonAdapter, opencodeEntry } from './common.mjs';
import { whichBin } from '../spec.mjs';

/** MiMo 的全局配置目录：XDG_CONFIG_HOME 优先，未设置时按 macOS 默认。 */
function mimoConfigDir(ctx) {
  if (ctx.env.MIMOCODE_CONFIG_DIR) return ctx.env.MIMOCODE_CONFIG_DIR;
  if (ctx.env.MIMOCODE_HOME) return join(ctx.env.MIMOCODE_HOME, 'config');
  const xdg = ctx.env.XDG_CONFIG_HOME || join(ctx.home, '.config');
  return join(xdg, 'mimocode');
}

function opencodeConfigDir(ctx) {
  const xdg = ctx.env.XDG_CONFIG_HOME || join(ctx.home, '.config');
  return join(xdg, 'opencode');
}

export const opencode = makeJsonAdapter({
  id: 'opencode',
  label: 'OpenCode（全局）',
  agent: 'OpenCode',
  scope: 'user',
  pathOf: (ctx) => join(opencodeConfigDir(ctx), 'opencode.json'),
  probePaths: (ctx) => [
    join(opencodeConfigDir(ctx), 'opencode.jsonc'),
    join(ctx.projectRoot, 'opencode.json'),
  ],
  keyPath: ['mcp', '__name__'],
  entryOf: opencodeEntry,
  seed: () => ({ $schema: 'https://opencode.ai/config.json', mcp: {} }),
  note: 'command 为数组、env 键名为 environment；项目级另可写 <项目根>/opencode.json',
});

const mimoBase = makeJsonAdapter({
  id: 'mimo',
  label: 'MiMo Code（全局，回落写 mimocode.jsonc）',
  agent: 'MiMo Code',
  scope: 'user',
  pathOf: (ctx) => join(mimoConfigDir(ctx), 'mimocode.jsonc'),
  probePaths: (ctx) => [
    join(mimoConfigDir(ctx), 'mimocode.json'),
    join(mimoConfigDir(ctx), 'config.json'),
    // 数据目录只是「装过」的线索，不作为「已配置」的判据
    { path: join(ctx.home, '.local', 'share', 'mimocode'), role: 'data' },
  ],
  keyPath: ['mcp', '__name__'],
  entryOf: opencodeEntry,
  seed: () => ({ $schema: 'https://mimo.xiaomi.com/mimocode/config.json', mcp: {} }),
  note: '全局目录内 config.json→mimocode.json→mimocode.jsonc 依次合并，故落点选优先级最高的 .jsonc',
});

export const mimo = {
  ...mimoBase,

  detect(ctx) {
    const base = mimoBase.detect(ctx);
    return { ...base, cli: whichBin('mimo', ctx.env.PATH) };
  },

  plan(spec, ctx, mode) {
    const p = mimoBase.plan(spec, ctx, mode);
    const cli = whichBin('mimo', ctx.env.PATH);
    const warnings = [...p.warnings];
    if (cli) {
      warnings.push(
        `PATH 中存在 mimo（${cli}）。官方推荐先用引导式命令 \`mimo mcp add\` 注册；` +
          '该命令为交互式、无法由本工具代跑，如已用它注册过请勿再写文件以免两处并存',
      );
    }
    return { actions: p.actions, warnings };
  },
};
