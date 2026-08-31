// adapters/index.mjs —— 七个安装目标的注册表
//
// 顺序即 --all 的执行顺序，也是 --list 与文档的呈现顺序。
import { claudeCodeUser, claudeCodeProject, detectClaudeLocal } from './claude-code.mjs';
import { claudeDesktop } from './claude-desktop.mjs';
import { hermes } from './hermes.mjs';
import { zcode } from './zcode.mjs';
import { opencode, mimo } from './opencode-family.mjs';

export const ADAPTERS = [
  claudeCodeUser,
  claudeCodeProject,
  claudeDesktop,
  hermes,
  zcode,
  mimo,
  opencode,
];

export { detectClaudeLocal };

/** 按 id 取适配器；支持不区分大小写与短横线归一。 */
export function getAdapter(id) {
  const norm = String(id).trim().toLowerCase();
  return ADAPTERS.find((a) => a.id === norm) || null;
}

export const ADAPTER_IDS = ADAPTERS.map((a) => a.id);
