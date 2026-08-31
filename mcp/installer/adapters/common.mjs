// adapters/common.mjs —— 适配器公共骨架
//
// 十九家 agent 的 stdio 配置有一个压倒性的最大公约数：「server 名 → {command,args,env}」
// 的字典结构，差异只在外层包装（顶层键名、嵌套层级、字段改名、文件格式）。
// 故 JSON 系一律由本文件的工厂生成，各适配器只声明四件事：
//   落点路径怎么算、键路径是什么、条目对象长什么样、新建文件时的初值。
import { readTextIfExists, pathExists } from '../lib/io.mjs';
import {
  parseConfig,
  stringifyLike,
  getDeep,
  setDeep,
  deleteDeep,
  ConfigParseError,
} from '../lib/json-edit.mjs';

/**
 * @typedef {object} Action
 * @property {'file'|'command'|'noop'} type
 * @property {string} [path] 落点
 * @property {string|null} [before] 原内容（null=新建）
 * @property {string} [after] 将写入的内容
 * @property {boolean} [changed] 是否产生实际变更
 * @property {string[]} [argv] type=command 时的命令行
 * @property {string} [reason] type=noop 时的原因
 */

/**
 * 生成一个 JSON/JSONC 系适配器。
 *
 * @param {object} def
 * @param {string} def.id 目标标识（--agent 取值）
 * @param {string} def.label 中文名
 * @param {string} def.agent 所属 agent
 * @param {'user'|'project'|'global'} def.scope
 * @param {(ctx:object)=>string} def.pathOf 落点计算
 * @param {(ctx:object)=>string[]} [def.probePaths] 额外探测点（判断 agent 是否在位）
 * @param {string[]} def.keyPath 条目在 JSON 中的键路径（末位为 server 名占位，运行时替换）
 * @param {(spec:object)=>*} def.entryOf 条目对象
 * @param {(ctx:object)=>object} [def.seed] 新建文件时的初值
 * @param {string} [def.note] 附注（作用域语义、坑点）
 * @returns {object}
 */
export function makeJsonAdapter(def) {
  return {
    ...def,
    format: 'json',

    detect(ctx) {
      const path = def.pathOf(ctx);
      // 探测点分两类：role='config' 的是配置文件（其存在即证明该 agent 配置过），
      // role='data' 的是数据／缓存目录（只是「装过」的线索，不足以证明当前在用）。
      // 清单里可能混有目录（如 ~/.zcode、~/.local/share/mimocode），
      // 故只做存在性判断，不读内容；条目解析只针对主落点。
      const probes = [
        { path, role: 'config' },
        ...(def.probePaths ? def.probePaths(ctx) : []).map((p) =>
          typeof p === 'string' ? { path: p, role: 'config' } : p,
        ),
      ];
      const seen = probes.map((p) => ({ ...p, exists: pathExists(p.path) }));
      const text = readTextIfExists(path);
      let entry = null;
      let parseError = null;
      if (text !== null) {
        try {
          const cfg = parseConfig(text, path);
          entry = getDeep(cfg.value, keyPathFor(def, ctx));
        } catch (e) {
          parseError = e instanceof ConfigParseError ? e.message : String(e);
        }
      }
      return {
        id: def.id,
        label: def.label,
        scope: def.scope,
        paths: seen,
        installed: seen.some((s) => s.exists && s.role === 'config'),
        dataTraces: seen.filter((s) => s.exists && s.role === 'data').map((s) => s.path),
        configured: entry !== null && entry !== undefined,
        entry: entry === undefined ? null : entry,
        parseError,
        note: def.note || '',
      };
    },

    plan(spec, ctx, mode) {
      const path = def.pathOf(ctx);
      const text = readTextIfExists(path);
      const cfg = parseConfig(text, path, {
        fallback: def.seed ? def.seed(ctx) : {},
      });
      if (cfg.hadComments && !ctx.allowDropComments) {
        throw new ConfigParseError(
          path,
          '文件含 JSONC 注释，重新序列化会丢失注释。确认可丢弃时加 --allow-drop-comments，否则请手工编辑',
        );
      }
      const kp = keyPathFor(def, ctx);
      const warnings = [];
      let changed;
      if (mode === 'remove') {
        changed = deleteDeep(cfg.value, kp);
      } else {
        changed = setDeep(cfg.value, kp, def.entryOf(spec, ctx));
      }
      const after = stringifyLike(cfg.value, cfg);
      if (cfg.hadComments) warnings.push('原文件含注释，写回后注释将丢失');
      return {
        actions: [
          {
            type: 'file',
            path,
            format: 'json',
            before: text,
            after,
            changed: changed || text !== after,
            existed: cfg.existed,
          },
        ],
        warnings,
      };
    },
  };
}

/** 键路径末位统一替换为实际 server 名（便于测试注入别名）。 */
function keyPathFor(def, ctx) {
  const kp = [...def.keyPath];
  kp[kp.length - 1] = ctx.serverName;
  return kp;
}

/** 把 {command,args,env} 摊平成 OpenCode 系的 command 数组形态。 */
export function opencodeEntry(spec) {
  const entry = {
    type: 'local',
    command: [spec.command, ...spec.args],
    enabled: true,
  };
  if (Object.keys(spec.env).length) entry.environment = { ...spec.env };
  return entry;
}
