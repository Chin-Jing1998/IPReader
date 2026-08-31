// adapters/claude-desktop.mjs —— Claude Desktop（仅全局，无项目级）
//
// 落点是 MCP 专用文件，但同一文件也承载 Desktop 的其他偏好（本机实测另有
// isHardwareAccelerationDisabled、deploymentMode、preferences 等 6 个顶层键，
// mcpServers 下 38 个 server、其中多个带 API key），故仍须读—改—写，绝不整体覆盖。
//
// 条目形态与本机既有 37 个条目一致：不写 type 字段（Desktop 按「有 command 即 stdio」
// 隐式判别），只给 command / args / env。
import { join } from 'node:path';
import { makeJsonAdapter } from './common.mjs';

export const claudeDesktop = makeJsonAdapter({
  id: 'claude-desktop',
  label: 'Claude Desktop（全局）',
  agent: 'Claude Desktop',
  scope: 'global',
  pathOf: (ctx) =>
    join(ctx.home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'),
  keyPath: ['mcpServers', '__name__'],
  entryOf: (spec) => ({
    command: spec.command,
    args: [...spec.args],
    env: { ...spec.env },
  }),
  seed: () => ({ mcpServers: {} }),
  note: 'Desktop 只有单一全局层，没有项目级；改动后须重启 Claude Desktop 才生效',
});
