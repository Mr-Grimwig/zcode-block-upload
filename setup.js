#!/usr/bin/env node
/**
 * setup —— 一键安装：解压后双击 install.cmd 即可，无需手改任何路径
 *
 * 自动完成：
 *   1. 认出自身所在目录（即解压位置）—— 钩子脚本路径由此得出
 *   2. 认出 node 可执行文件（就是正在运行本脚本的这个）
 *   3. 认出 ZCode 安装位置与 app.asar（优先取运行中进程的路径，再试常见位置与盘根浅扫）
 *   4. 给 app.asar 打补丁（已有补丁则跳过；自动备份原始文件）
 *   5. 找到/创建 ~/.zcode/cli/config.json，写入 SessionStart 钩子（保留文件里其它内容，并先备份）
 *   6. 自检：复核补丁状态、试跑一次钩子
 *
 * 用法：
 *   node setup.js [--asar <app.asar 路径>] [--skip-patch]
 * 卸载：
 *   node uninstall.js [--restore-asar]
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { detectAsar } = require('./detect-asar');

const TOOL_DIR = __dirname;
const HOOK_SCRIPT = path.join(TOOL_DIR, 'zcode-session-hook.js');
const WORKER = path.join(TOOL_DIR, 'zcode-block-upload.js');
const NODE = process.execPath;

const argv = process.argv.slice(2);
function flagValue(name) {
  const i = argv.indexOf(name);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : null;
}
const ASAR_OVERRIDE = flagValue('--asar');
const SKIP_PATCH = argv.includes('--skip-patch');

function out(s) { process.stdout.write(s + '\n'); }
function step(n, s) { out(`\n[${n}] ${s}`); }
function stamp() { return new Date().toISOString().replace(/[:.]/g, '-'); }

out('=== ZCode 快照上传拦截 · 一键安装 ===');

// ---------- 1. 自身位置 ----------
step(1, '工具目录（解压位置）');
if (!fs.existsSync(HOOK_SCRIPT) || !fs.existsSync(WORKER)) {
  out('  [x] 目录不完整：缺少 zcode-session-hook.js 或 zcode-block-upload.js');
  out('      请把压缩包完整解压后再运行，不要只复制单个文件。');
  process.exit(1);
}
out('  ' + TOOL_DIR);
out('  node: ' + NODE + '  (' + process.version + ')');

// ---------- 2. 定位 app.asar ----------
step(2, '定位 ZCode 的 app.asar');

// 探测逻辑统一放在 detect-asar.js，所有脚本共用同一套候选顺序，
// 避免"安装器找得到、补丁器找不到"这类不一致。
const ASAR = detectAsar(ASAR_OVERRIDE);
if (!ASAR) {
  out('  [x] 没找到 ZCode 的 app.asar。');
  out('      请确认 ZCode 已安装，或用 --asar "<路径>" 手动指定，');
  out('      例如: install.cmd --asar "D:\\zcode\\resources\\app.asar"');
  process.exit(1);
}
out('  找到: ' + ASAR);

// ---------- 3. 打补丁 ----------
step(3, '处理 app.asar（打补丁 / 已是补丁状态则跳过）');
if (SKIP_PATCH) {
  out('  已按 --skip-patch 跳过');
} else {
  const r = spawnSync(NODE, [WORKER, '--apply', '--asar', ASAR],
    { encoding: 'utf8', timeout: 10 * 60 * 1000, stdio: ['ignore', 'pipe', 'pipe'] });
  const text = ((r.stdout || '') + (r.stderr || '')).trim();
  const patched = /状态: 已打补丁/.test(text) || /已经是打补丁后的状态/.test(text);
  if (patched) {
    const m = text.match(/状态: 已打补丁[\s\S]*/);
    out('  ' + (text.includes('已经是打补丁后的状态') ? '已经是补丁状态，无需重复操作' : '已打补丁'));
    const bak = text.match(/备份到: (.*)/);
    if (bak) out('  备份: ' + bak[1].trim());
  } else {
    out('  [x] 打补丁失败：');
    out(text.split('\n').slice(-8).map(l => '      ' + l).join('\n'));
    out('  提示：若是新版 ZCode 改了代码结构，请先别继续，联系维护者复查。');
    process.exit(1);
  }
}

// ---------- 4. 写钩子配置 ----------
step(4, '配置 SessionStart 钩子（随 ZCode 启动自动检查）');

function dataRootCandidates() {
  const list = [];
  const push = v => { if (v && !list.includes(v)) list.push(v); };
  push((process.env.ZCODE_DATA_BASE_DIR || '').trim());
  push(process.env.USERPROFILE);
  push(process.env.HOME && /^[A-Za-z]:[\\/]/.test(process.env.HOME) ? process.env.HOME : null);
  push(os.homedir());
  return list;
}
function resolveConfigPath() {
  const cands = dataRootCandidates();
  // 优先选已存在 .zcode 目录的那个（说明就是 ZCode 真正在用的数据根）
  for (const c of cands) {
    if (fs.existsSync(path.join(c, '.zcode'))) return path.join(c, '.zcode', 'cli', 'config.json');
  }
  return path.join(cands[0] || os.homedir(), '.zcode', 'cli', 'config.json');
}

const CFG = resolveConfigPath();
let cfg = {};
if (fs.existsSync(CFG)) {
  const raw = fs.readFileSync(CFG, 'utf8');
  try {
    cfg = JSON.parse(raw);
  } catch (e) {
    out('  [x] 现有配置不是合法 JSON，为避免破坏它已中止: ' + CFG);
    out('      错误: ' + e.message + '（修正该文件后重试）');
    process.exit(1);
  }
  const bak = CFG + '.bak-' + stamp();
  fs.copyFileSync(CFG, bak);
  out('  已备份原配置: ' + bak);
} else {
  fs.mkdirSync(path.dirname(CFG), { recursive: true });
}

cfg.hooks = cfg.hooks && typeof cfg.hooks === 'object' && !Array.isArray(cfg.hooks) ? cfg.hooks : {};
cfg.hooks.enabled = true;
if (!Number.isInteger(cfg.hooks.timeoutMs) || cfg.hooks.timeoutMs <= 0) cfg.hooks.timeoutMs = 60000;
if (!Number.isInteger(cfg.hooks.maxOutputBytes) || cfg.hooks.maxOutputBytes <= 0) cfg.hooks.maxOutputBytes = 32768;

const events = cfg.hooks.events && typeof cfg.hooks.events === 'object' && !Array.isArray(cfg.hooks.events)
  ? cfg.hooks.events : {};
const existing = Array.isArray(events.SessionStart) ? events.SessionStart : [];
const isOurs = e => e && Array.isArray(e.hooks) &&
  e.hooks.some(h => Array.isArray(h && h.args) &&
    h.args.some(a => String(a).includes('zcode-session-hook.js')));
const kept = existing.filter(e => !isOurs(e));
if (existing.length !== kept.length) out('  已移除本工具的旧钩子条目 ' + (existing.length - kept.length) + ' 个');
const removedOthers = 0; // 其它宿主的钩子一律保留
void removedOthers;

kept.push({
  hooks: [{
    type: 'process',
    command: NODE,
    args: [HOOK_SCRIPT],
    timeoutMs: 60000,
    statusMessage: '检查快照上传拦截状态'
  }]
});
events.SessionStart = kept;
cfg.hooks.events = events;

fs.writeFileSync(CFG, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
out('  已写入: ' + CFG);
out('  钩子命令: ' + NODE);
out('  钩子脚本: ' + HOOK_SCRIPT);

// ---------- 5. 自检 ----------
step(5, '自检');
const v = spawnSync(NODE, [WORKER, '--verify', '--asar', ASAR],
  { encoding: 'utf8', timeout: 5 * 60 * 1000, stdio: ['ignore', 'pipe', 'pipe'] });
const vtext = ((v.stdout || '') + (v.stderr || '')).trim();
if (/状态: 已打补丁/.test(vtext)) {
  const m = vtext.match(/替换后端点串: (\d+) 处/);
  out('  补丁状态: 正常（' + (m ? m[1] : '?') + ' 处端点已替换）');
} else {
  out('  [!] 补丁状态异常：');
  out(vtext.split('\n').slice(-6).map(l => '      ' + l).join('\n'));
}

const h = spawnSync(NODE, [HOOK_SCRIPT], { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] });
const hOut = (h.stdout || '') + (h.stderr || '');
if (h.status === 0 && hOut.length === 0) {
  out('  钩子试跑: 正常（退出码 0、无输出）');
} else {
  out('  [!] 钩子试跑异常: 退出码 ' + h.status + '，输出 ' + hOut.length + ' 字节');
}

out('\n=== 完成 ===');
out('还需要做一件事：重启 ZCode，让补丁进入内存。');
out('之后每次开新会话钩子都会自动检查一次；');
out('确认钩子在工作：看 ' + path.join(TOOL_DIR, 'zcode-hook-state.json') + ' 里的 checkedAt 是否在刷新。');
out('卸载: 双击 uninstall.cmd    还原 app.asar: 双击 restore.cmd');
