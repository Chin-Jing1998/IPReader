// installer/test/snapshot.test.mjs —— 安装器的适配器序列化快照测试
//
// 断言风格沿用 mcp/smoke.mjs：自备 ok() 计数、中文分节输出、失败即非零退出。
//
// 测试全程在临时目录里造一份假 HOME，**不读也不写任何真实 agent 配置**。
// 运行实体不走真实探测，改用固定的 fake runtime，使快照在任何机器上都可复现。
//
//   node installer/test/snapshot.test.mjs            跑测试
//   node installer/test/snapshot.test.mjs --update    重写快照（改了序列化逻辑后用）
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAdapter, ADAPTERS } from '../adapters/index.mjs';
import { buildSpec, resolveRuntime, runtimeErrorMessage, whichBin } from '../spec.mjs';
import { backupPathFor } from '../lib/io.mjs';
import { ConfigParseError } from '../lib/json-edit.mjs';
import { YamlEditError } from '../lib/yaml-edit.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SNAP_DIR = join(HERE, '__snapshots__');
const UPDATE = process.argv.includes('--update');

let passed = 0;
const failures = [];

function ok(name, cond, detail) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}${detail ? ` —— ${detail}` : ''}`);
  } else {
    failures.push(`${name}${detail ? `：${detail}` : ''}`);
    console.log(`  ✗ ${name}${detail ? ` —— ${detail}` : ''}`);
  }
}

/** 固定的运行实体，脱离本机 /Applications 的实际状态。 */
const APP_RUNTIME = {
  kind: 'app',
  label: '桌面版应用内副本（/Applications/IPReader.app）',
  bundle: '/Applications/IPReader.app',
  entry: '/Applications/IPReader.app/Contents/Resources/mcp/server.mjs',
  dataFile: '/Applications/IPReader.app/Contents/Resources/mcp/kb-data.json.gz',
  command: '/Applications/IPReader.app/Contents/MacOS/IPReader',
  args: ['/Applications/IPReader.app/Contents/Resources/mcp/server.mjs'],
  env: { ELECTRON_RUN_AS_NODE: '1' },
  checks: [],
  ok: true,
};

const REPO_RUNTIME = {
  kind: 'node',
  label: 'Node 直跑（/opt/ipreader/dist）',
  entry: '/opt/ipreader/dist/server.mjs',
  dataFile: '/opt/ipreader/dist/kb-data.json.gz',
  command: '/usr/local/bin/node',
  args: ['/opt/ipreader/dist/server.mjs'],
  env: {},
  checks: [],
  ok: true,
};

const SPEC_APP = buildSpec(APP_RUNTIME);
const SPEC_REPO = buildSpec(REPO_RUNTIME);

// ── 沙箱 HOME ──────────────────────────────────────────────
const SANDBOX = mkdtempSync(join(tmpdir(), 'ipreader-installer-test-'));
const HOME = join(SANDBOX, 'home');
const PROJECT = join(SANDBOX, 'project');
const FAKEBIN = join(SANDBOX, 'bin');
mkdirSync(HOME, { recursive: true });
mkdirSync(PROJECT, { recursive: true });
mkdirSync(FAKEBIN, { recursive: true });
// 假的 claude CLI，供 claude-code-user 的 CLI 分支探测
writeFileSync(join(FAKEBIN, 'claude'), '#!/bin/sh\nexit 0\n');
chmodSync(join(FAKEBIN, 'claude'), 0o755);

function write(rel, content) {
  const p = join(HOME, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content, 'utf8');
  return p;
}

/** 造一份带既有内容的假配置，用于验证「读—改—写不动其余条目」。 */
function seedFixtures() {
  write(
    '.claude.json',
    JSON.stringify(
      {
        numStartups: 3,
        mcpServers: { memory: { type: 'stdio', command: 'npx', args: ['-y', 'server-memory'] } },
        projects: { [PROJECT]: { mcpServers: {} } },
      },
      null,
      2,
    ) + '\n',
  );
  write(
    'Library/Application Support/Claude/claude_desktop_config.json',
    JSON.stringify(
      {
        mcpServers: {
          'antv-chart': { command: 'npx', args: ['-y', '@antv/mcp-server-chart'] },
          ipreader: {
            command: '/Applications/PatentReader.app/Contents/MacOS/PatentReader',
            args: ['/Applications/PatentReader.app/Contents/Resources/mcp/server.mjs'],
            env: { ELECTRON_RUN_AS_NODE: '1' },
          },
        },
        isHardwareAccelerationDisabled: false,
      },
      null,
      2,
    ) + '\n',
  );
  write(
    '.hermes/config.yaml',
    [
      'model: some-model',
      'mcp_servers:',
      '  pandoc:',
      '    command: uvx',
      '    args:',
      '      - mcp-pandoc',
      '    enabled: true',
      '  ipreader:',
      '    command: /old/path/IPReader',
      '    args:',
      '      - /old/path/server.mjs',
      '    enabled: true',
      'custom_providers: []',
      '',
    ].join('\n'),
  );
  write(
    '.config/opencode/opencode.json',
    JSON.stringify({ $schema: 'https://opencode.ai/config.json', plugin: [], provider: {} }, null, 2) +
      '\n',
  );
}
seedFixtures();

const BASE_CTX = {
  home: HOME,
  projectRoot: PROJECT,
  serverName: 'ipreader',
  workspace: false,
  noCli: false,
  allowDropComments: false,
  env: { PATH: FAKEBIN },
};
const ctx = (over = {}) => ({ ...BASE_CTX, ...over, env: { ...BASE_CTX.env, ...(over.env || {}) } });

/** 把沙箱绝对路径替换成占位符，使快照与临时目录名无关。 */
function normalize(s) {
  return String(s)
    .split(HOME).join('<HOME>')
    .split(PROJECT).join('<PROJECT>')
    .split(FAKEBIN).join('<BIN>');
}

/** 把一个计划序列化成可读快照文本。 */
function renderSnapshot(id, plan) {
  const out = [`# 目标：${id}`];
  for (const w of plan.warnings) out.push(`# 告警：${normalize(w)}`);
  for (const act of plan.actions) {
    if (act.type === 'noop') {
      out.push(`# 动作：noop（${normalize(act.reason)}）`);
      continue;
    }
    if (act.type === 'command') {
      out.push(`# 动作：command`);
      out.push(`# 命令：${act.argv.map(normalize).join(' ')}`);
      out.push(`# 备份：${(act.backupTargets || []).map((t) => normalize(t)).join('、')}`);
      if (act.equivalent) {
        out.push(`# 等价落盘：${normalize(act.equivalent.path)}`);
        out.push('----');
        out.push(normalize(act.equivalent.after).replace(/\n$/, ''));
      }
      continue;
    }
    out.push(`# 动作：file（${act.existed ? '读—改—写' : '新建'}，changed=${act.changed}）`);
    out.push(`# 落点：${normalize(act.path)}`);
    out.push('----');
    out.push(normalize(act.after).replace(/\n$/, ''));
  }
  return out.join('\n') + '\n';
}

/** 快照断言：与 __snapshots__/<name>.txt 比对；--update 时重写。 */
function matchSnapshot(name, actual) {
  const file = join(SNAP_DIR, `${name}.txt`);
  if (UPDATE || !existsSync(file)) {
    mkdirSync(SNAP_DIR, { recursive: true });
    writeFileSync(file, actual, 'utf8');
    ok(`快照 ${name}`, true, UPDATE ? '已更新' : '首次生成');
    return;
  }
  const expected = readFileSync(file, 'utf8');
  if (expected === actual) {
    ok(`快照 ${name}`, true);
  } else {
    const el = expected.split('\n');
    const al = actual.split('\n');
    let i = 0;
    while (i < el.length && i < al.length && el[i] === al[i]) i++;
    ok(`快照 ${name}`, false, `第 ${i + 1} 行起不符\n    期望：${el[i]}\n    实际：${al[i]}`);
  }
}

function planOf(id, spec, over, mode = 'install') {
  return getAdapter(id).plan(spec, ctx(over), mode);
}

async function main() {
  console.log(`安装器快照测试 · 沙箱 ${SANDBOX}\n`);

  // ============ 一、七个目标的安装序列化 ============
  console.log('一、七个安装目标的序列化快照（app 运行实体）');
  matchSnapshot('install-claude-code-user-cli', renderSnapshot('claude-code-user', planOf('claude-code-user', SPEC_APP)));
  matchSnapshot(
    'install-claude-code-user-file',
    renderSnapshot('claude-code-user', planOf('claude-code-user', SPEC_APP, { noCli: true })),
  );
  matchSnapshot('install-claude-code-project', renderSnapshot('claude-code-project', planOf('claude-code-project', SPEC_APP)));
  matchSnapshot('install-claude-desktop', renderSnapshot('claude-desktop', planOf('claude-desktop', SPEC_APP)));
  matchSnapshot('install-hermes', renderSnapshot('hermes', planOf('hermes', SPEC_APP)));
  matchSnapshot('install-zcode', renderSnapshot('zcode', planOf('zcode', SPEC_APP)));
  matchSnapshot('install-mimo', renderSnapshot('mimo', planOf('mimo', SPEC_APP)));
  matchSnapshot('install-opencode', renderSnapshot('opencode', planOf('opencode', SPEC_APP)));

  // ============ 二、repo 运行实体与可选项 ============
  console.log('\n二、repo 运行实体、域白名单与工作区档');
  matchSnapshot('install-repo-claude-code-project', renderSnapshot('claude-code-project', planOf('claude-code-project', SPEC_REPO)));
  const specDomains = buildSpec(REPO_RUNTIME, { domains: 'patent-law,examination-guideline' });
  matchSnapshot('install-repo-domains-opencode', renderSnapshot('opencode', planOf('opencode', specDomains)));
  matchSnapshot('install-zcode-workspace', renderSnapshot('zcode', planOf('zcode', SPEC_APP, { workspace: true })));

  // ============ 三、幂等 ============
  console.log('\n三、幂等：已存在条目时更新而非追加');
  const dtPlan = planOf('claude-desktop', SPEC_APP);
  const dtAfter = JSON.parse(dtPlan.actions[0].after);
  ok(
    'Desktop 旧条目被更新',
    dtAfter.mcpServers.ipreader.command === APP_RUNTIME.command,
    dtAfter.mcpServers.ipreader.command,
  );
  ok('Desktop 无重复 ipreader 键', (dtPlan.actions[0].after.match(/"ipreader":/g) || []).length === 1);
  ok('Desktop 其余条目原样保留', !!dtAfter.mcpServers['antv-chart'] && dtAfter.isHardwareAccelerationDisabled === false);
  matchSnapshot('idempotent-claude-desktop', renderSnapshot('claude-desktop', dtPlan));

  const hmPlan = planOf('hermes', SPEC_APP);
  ok('Hermes 无重复 ipreader 键', (hmPlan.actions[0].after.match(/^ {2}ipreader:$/gm) || []).length === 1);
  ok('Hermes 其余条目原样保留', /^ {2}pandoc:$/m.test(hmPlan.actions[0].after) && /^custom_providers: \[\]$/m.test(hmPlan.actions[0].after));
  ok('Hermes 顶层其他键不动', /^model: some-model$/m.test(hmPlan.actions[0].after));
  matchSnapshot('idempotent-hermes', renderSnapshot('hermes', hmPlan));

  // 二次施加：把第一次的结果当输入，应当无变化
  const secondPass = getAdapter('claude-desktop').plan(SPEC_APP, ctx(), 'install');
  const twice = JSON.parse(secondPass.actions[0].after);
  ok('重复运行结果稳定', JSON.stringify(twice) === JSON.stringify(dtAfter));

  // ============ 四、卸载 ============
  console.log('\n四、卸载（--remove）');
  const rmDesktop = planOf('claude-desktop', SPEC_APP, {}, 'remove');
  ok('Desktop 卸载后无 ipreader', !JSON.parse(rmDesktop.actions[0].after).mcpServers.ipreader);
  ok('Desktop 卸载不误伤其他 server', !!JSON.parse(rmDesktop.actions[0].after).mcpServers['antv-chart']);
  matchSnapshot('remove-claude-desktop', renderSnapshot('claude-desktop', rmDesktop));

  const rmHermes = planOf('hermes', SPEC_APP, {}, 'remove');
  ok('Hermes 卸载后无 ipreader 块', !/^ {2}ipreader:$/m.test(rmHermes.actions[0].after));
  ok('Hermes 卸载保留 pandoc', /^ {2}pandoc:$/m.test(rmHermes.actions[0].after));
  matchSnapshot('remove-hermes', renderSnapshot('hermes', rmHermes));

  const rmOpencode = planOf('opencode', SPEC_APP, {}, 'remove');
  ok('OpenCode 未配置时卸载为无变更', rmOpencode.actions[0].changed === false);
  matchSnapshot('remove-opencode-noop', renderSnapshot('opencode', rmOpencode));

  const rmUser = planOf('claude-code-user', SPEC_APP, {}, 'remove');
  ok(
    'Claude Code user 卸载走 CLI',
    rmUser.actions[0].type === 'command' && rmUser.actions[0].argv.join(' ') === 'claude mcp remove --scope user ipreader',
    rmUser.actions[0].argv.join(' '),
  );

  // ============ 五、解析失败即停 ============
  console.log('\n五、解析失败与写入拒绝');
  write('broken/claude_desktop_config.json', '{ "mcpServers": { oops }');
  let threw = null;
  try {
    getAdapter('claude-desktop').plan(SPEC_APP, ctx({ home: join(HOME, 'broken-home') }), 'install');
  } catch (e) {
    threw = e;
  }
  ok('落点不存在时按新建处理而非报错', threw === null);

  const brokenHome = join(SANDBOX, 'broken-home');
  mkdirSync(join(brokenHome, 'Library/Application Support/Claude'), { recursive: true });
  writeFileSync(
    join(brokenHome, 'Library/Application Support/Claude/claude_desktop_config.json'),
    '{ "mcpServers": { oops }',
    'utf8',
  );
  threw = null;
  try {
    getAdapter('claude-desktop').plan(SPEC_APP, ctx({ home: brokenHome }), 'install');
  } catch (e) {
    threw = e;
  }
  ok('JSON 损坏时抛 ConfigParseError', threw instanceof ConfigParseError, threw && threw.message.split('\n')[0]);
  ok(
    '损坏文件未被改写',
    readFileSync(join(brokenHome, 'Library/Application Support/Claude/claude_desktop_config.json'), 'utf8') ===
      '{ "mcpServers": { oops }',
  );

  const jsoncHome = join(SANDBOX, 'jsonc-home');
  mkdirSync(join(jsoncHome, '.config/opencode'), { recursive: true });
  writeFileSync(
    join(jsoncHome, '.config/opencode/opencode.json'),
    '{\n  // 自定义供应商\n  "provider": {}\n}\n',
    'utf8',
  );
  threw = null;
  try {
    getAdapter('opencode').plan(SPEC_APP, ctx({ home: jsoncHome }), 'install');
  } catch (e) {
    threw = e;
  }
  ok('JSONC 含注释时默认拒绝写入', threw instanceof ConfigParseError, threw && threw.message.split('\n')[1]);
  const allowed = getAdapter('opencode').plan(SPEC_APP, ctx({ home: jsoncHome, allowDropComments: true }), 'install');
  ok('显式放行后可写且给出告警', allowed.warnings.some((w) => w.includes('注释')), allowed.warnings.join('；'));

  const tabHome = join(SANDBOX, 'tab-home');
  mkdirSync(join(tabHome, '.hermes'), { recursive: true });
  writeFileSync(join(tabHome, '.hermes/config.yaml'), 'mcp_servers:\n\tpandoc:\n\t\tcommand: uvx\n', 'utf8');
  threw = null;
  try {
    getAdapter('hermes').plan(SPEC_APP, ctx({ home: tabHome }), 'install');
  } catch (e) {
    threw = e;
  }
  ok('YAML 含 Tab 缩进时抛 YamlEditError', threw instanceof YamlEditError, threw && threw.message);

  const inlineHome = join(SANDBOX, 'inline-home');
  mkdirSync(join(inlineHome, '.hermes'), { recursive: true });
  writeFileSync(join(inlineHome, '.hermes/config.yaml'), 'model: x\nmcp_servers: {}\n', 'utf8');
  threw = null;
  try {
    getAdapter('hermes').plan(SPEC_APP, ctx({ home: inlineHome }), 'install');
  } catch (e) {
    threw = e;
  }
  ok('YAML 行内写法时抛 YamlEditError', threw instanceof YamlEditError, threw && threw.message);

  const wrongKeyHome = join(SANDBOX, 'wrongkey-home');
  mkdirSync(join(wrongKeyHome, '.hermes'), { recursive: true });
  writeFileSync(join(wrongKeyHome, '.hermes/config.yaml'), 'mcp:\n  servers:\n    x: 1\nmcp_servers:\n  pandoc:\n    command: uvx\n', 'utf8');
  const wrongKeyPlan = getAdapter('hermes').plan(SPEC_APP, ctx({ home: wrongKeyHome }), 'install');
  ok(
    'Hermes 检出错误写法 mcp: 时告警',
    wrongKeyPlan.warnings.some((w) => w.includes('mcp_servers')),
    wrongKeyPlan.warnings.join('；'),
  );

  // ============ 六、运行实体校验 ============
  console.log('\n六、运行实体探测与报错指引');
  const missing = resolveRuntime({ target: '/nonexistent/Ghost.app' });
  ok('不存在的 app 判为不完整', missing.ok === false);
  const msg = runtimeErrorMessage(missing);
  ok('报错列出全部已尝试路径', (msg.match(/\/nonexistent\/Ghost\.app/g) || []).length >= 3);
  ok('报错给出三条补救指引', msg.includes('--target /实际路径') && msg.includes('--target repo'));

  const appRt = resolveRuntime({ target: '/tmp/Demo.app' });
  ok(
    'app 形态的 entry 不含 dist 一层',
    appRt.entry === '/tmp/Demo.app/Contents/Resources/mcp/server.mjs',
    appRt.entry,
  );
  ok('app 形态强制 ELECTRON_RUN_AS_NODE', appRt.env.ELECTRON_RUN_AS_NODE === '1');
  const bareRt = resolveRuntime({ target: '/opt/x/dist', nodePath: 'bare' });
  ok('--node bare 写裸 node', bareRt.command === 'node');
  ok('whichBin 能在假 PATH 中定位', whichBin('claude', FAKEBIN) === join(FAKEBIN, 'claude'));

  // ============ 七、备份路径 ============
  console.log('\n七、备份路径');
  const stamp = backupPathFor('/a/b/config.json', new Date(2026, 7, 31, 9, 5, 6));
  ok('备份名带时间戳', stamp === '/a/b/config.json.bak.20260831-090506', stamp);

  // ============ 八、注册表自洽 ============
  console.log('\n八、注册表');
  ok('注册七个目标', ADAPTERS.length === 7, ADAPTERS.map((a) => a.id).join('、'));
  ok('每个目标都有 plan 与 detect', ADAPTERS.every((a) => typeof a.plan === 'function' && typeof a.detect === 'function'));
  ok('id 无重复', new Set(ADAPTERS.map((a) => a.id)).size === 7);

  // ============ 汇总 ============
  console.log(`\n${'—'.repeat(52)}`);
  rmSync(SANDBOX, { recursive: true, force: true });
  if (failures.length) {
    console.log(`${passed} 项通过，${failures.length} 项失败：`);
    failures.forEach((f) => console.log(`  ✗ ${f}`));
    process.exit(1);
  }
  console.log(`全部 ${passed} 项断言通过 · 未触碰任何真实 agent 配置`);
  process.exit(0);
}

main().catch((err) => {
  console.error('\n测试异常终止：', err && err.stack ? err.stack : err);
  rmSync(SANDBOX, { recursive: true, force: true });
  process.exit(1);
});
