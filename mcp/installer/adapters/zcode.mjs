// adapters/zcode.mjs —— ZCode（Z.ai／智谱的 Agentic Development Environment）
//
// 键路径是**两层嵌套**的 mcp.servers，不是顶层 mcpServers——写入前须确保父级 mcp 对象存在
// （由 setDeep 逐层补齐）。
//
// 作用域为 User／Workspace 双层：
//   User      ~/.zcode/cli/config.json      —— 默认
//   Workspace <项目根>/.zcode/config.json   —— 加 --workspace 切换
//
// 附注：ZCode 的 MCP Servers 页面有跨 agent 导入功能，其官方声明的扫描路径把
// Claude Code 写成 ~/.claude/settings.json，与 Claude Code 官方文档（~/.claude.json
// 与项目根 .mcp.json）不符。本适配器不依赖该功能，直接写 ZCode 自己的配置。
import { join } from 'node:path';
import { makeJsonAdapter } from './common.mjs';

export const zcode = makeJsonAdapter({
  id: 'zcode',
  label: 'ZCode（User 档，--workspace 切工作区档）',
  agent: 'ZCode',
  scope: 'user',
  pathOf: (ctx) =>
    ctx.workspace
      ? join(ctx.projectRoot, '.zcode', 'config.json')
      : join(ctx.home, '.zcode', 'cli', 'config.json'),
  probePaths: (ctx) => [join(ctx.home, '.zcode')],
  keyPath: ['mcp', 'servers', '__name__'],
  entryOf: (spec) => ({
    command: spec.command,
    args: [...spec.args],
    env: { ...spec.env },
  }),
  seed: () => ({ mcp: { servers: {} } }),
  note: '键路径为两层嵌套 mcp.servers；--workspace 可改写 <项目根>/.zcode/config.json',
});
