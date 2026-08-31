// adapters/hermes.mjs —— Hermes Agent（Nous Research），YAML，仅全局
//
// 三个必须守住的事实：
//   1. 顶层键是 mcp_servers，不是 mcp: / servers:。官方专门提示过这个常见错误，
//      本适配器在检出顶层 mcp: 时会告警。
//   2. Hermes **不继承父进程完整环境**，只透传显式声明的 env 加一组安全基线。
//      因此 command 必须写绝对路径（不能指望 PATH 里有 node），env 必须写全。
//   3. config.yaml 是 Hermes 的主配置文件，写入只能做块级替换，不能整体反序列化重写。
//      具体校验与实现见 lib/yaml-edit.mjs 的文件头。
import { join } from 'node:path';
import { readTextIfExists } from '../lib/io.mjs';
import { upsertChild, removeChild, readChild, renderServerBlock } from '../lib/yaml-edit.mjs';

const TOP_KEY = 'mcp_servers';

export const hermes = {
  id: 'hermes',
  label: 'Hermes Agent（全局）',
  agent: 'Hermes Agent',
  scope: 'global',
  format: 'yaml',
  note: '仅全局作用域；不继承父进程环境，command 须绝对路径、env 须写全；运行中可用 /reload-mcp 热重载',

  pathOf: (ctx) => join(ctx.home, '.hermes', 'config.yaml'),

  detect(ctx) {
    const path = this.pathOf(ctx);
    const text = readTextIfExists(path);
    let entry = null;
    let parseError = null;
    if (text !== null) {
      try {
        entry = readChild(text, TOP_KEY, ctx.serverName);
      } catch (e) {
        parseError = String(e.message || e);
      }
    }
    return {
      id: this.id,
      label: this.label,
      scope: this.scope,
      paths: [{ path, exists: text !== null }],
      installed: text !== null,
      configured: entry !== null,
      entry,
      parseError,
      note: this.note,
    };
  },

  plan(spec, ctx, mode) {
    const path = this.pathOf(ctx);
    const text = readTextIfExists(path);
    if (text === null) {
      if (mode === 'remove') {
        return { actions: [{ type: 'noop', reason: `配置文件不存在：${path}` }], warnings: [] };
      }
      const seeded = `${TOP_KEY}:\n`;
      const r = upsertChild(seeded, TOP_KEY, spec.name, renderServerBlock(spec));
      return {
        actions: [
          { type: 'file', path, format: 'yaml', before: null, after: r.text, changed: true, existed: false },
        ],
        warnings: [...r.warnings, `${path} 原本不存在，将新建；Hermes 未安装时该文件不会被读取`],
      };
    }
    const r =
      mode === 'remove'
        ? removeChild(text, TOP_KEY, spec.name)
        : upsertChild(text, TOP_KEY, spec.name, renderServerBlock(spec));
    return {
      actions: [
        {
          type: 'file',
          path,
          format: 'yaml',
          before: text,
          after: r.text,
          changed: r.action !== 'noop',
          existed: true,
        },
      ],
      warnings: r.warnings,
    };
  },
};
