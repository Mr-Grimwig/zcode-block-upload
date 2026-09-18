#!/usr/bin/env node
/**
 * uninstall —— 卸载钩子配置（可选顺带还原 app.asar）
 *
 * 只会移除本工具写入的 SessionStart 钩子条目，文件里其它内容原样保留；
 * 如果整个配置文件只为本工具而存在，则一并删除。修改前自动备份。
 *
 * 用法：
 *   node uninstall.js                 只移除钩子配置
 *   node uninstall.js --restore-asar  同时把 app.asar 还原成原始文件
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const TOOL_DIR = __dirname;
const WORKER = path.join(TOOL_DIR, 'zcode-block-upload.js');
const NODE = process.execPath;
const argv = process.argv.slice(2);
const DO_RESTORE = argv.includes('--restore-asar');
const ASAR = (() => {
  const i = argv.indexOf('--asar');
  const explicit = i !== -1 && argv[i + 1] ? argv[i + 1] : null;
  return require('./detect-asar').detectAsar(explicit);
})();

function out(s) { process.stdout.write(s + '\n'); }
function stamp() { return new Date().toISOString().replace(/[:.]/g, '-'); }

out('=== ZCode 快照上传拦截 · 卸载钩子 ===');

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
  for (const c of cands) {
    if (fs.existsSync(path.join(c, '.zcode'))) return path.join(c, '.zcode', 'cli', 'config.json');
  }
  return path.join(cands[0] || os.homedir(), '.zcode', 'cli', 'config.json');
}

const CFG = resolveConfigPath();
if (!fs.existsSync(CFG)) {
  out('配置文件不存在，无需处理: ' + CFG);
} else {
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(CFG, 'utf8'));
  } catch (e) {
    out('[x] 配置文件不是合法 JSON，为安全起见未改动: ' + CFG);
    out('    ' + e.message);
    process.exit(1);
  }

  const events = cfg.hooks && cfg.hooks.events;
  let removed = 0;
  if (events && Array.isArray(events.SessionStart)) {
    const isOurs = e => e && Array.isArray(e.hooks) &&
      e.hooks.some(h => Array.isArray(h && h.args) &&
        h.args.some(a => String(a).includes('zcode-session-hook.js')));
    const kept = events.SessionStart.filter(e => {
      const ours = isOurs(e);
      if (ours) removed++;
      return !ours;
    });
    events.SessionStart = kept;
    if (kept.length === 0) delete events.SessionStart;
  }

  if (removed === 0) {
    out('配置里没有本工具的钩子条目，无需改动。');
  } else {
    // 判断这个文件是否只为本工具而存在
    const hookEventKeys = events ? Object.keys(events) : [];
    const hooksOtherKeys = cfg.hooks
      ? Object.keys(cfg.hooks).filter(k => !['enabled', 'timeoutMs', 'maxOutputBytes', 'events'].includes(k))
      : [];
    const topOtherKeys = Object.keys(cfg).filter(k => k !== 'hooks');
    const onlyOurs = hookEventKeys.length === 0 && hooksOtherKeys.length === 0 && topOtherKeys.length === 0;

    if (onlyOurs) {
      fs.copyFileSync(CFG, CFG + '.bak-' + stamp());
      fs.unlinkSync(CFG);
      out('已删除配置文件（它只为本工具创建）: ' + CFG);
      out('（删前留有备份 ' + path.basename(CFG) + '.bak-*）');
    } else {
      fs.copyFileSync(CFG, CFG + '.bak-' + stamp());
      fs.writeFileSync(CFG, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
      out('已移除本工具的钩子条目 ' + removed + ' 个，其它内容保留: ' + CFG);
    }
  }
}

// 顺手提示常驻守卫
const startupDir = path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
if (fs.existsSync(path.join(startupDir, 'ZCodeBlockUploadGuard.vbs'))) {
  out('\n[提示] 常驻守卫仍在开机自启中，如需一并移除请双击 uninstall-guard.cmd。');
}

if (DO_RESTORE) {
  out('\n=== 还原 app.asar ===');
  const restoreArgs = [WORKER, '--restore'];
  if (ASAR) restoreArgs.push('--asar', ASAR);
  const r = spawnSync(NODE, restoreArgs,
    { encoding: 'utf8', timeout: 10 * 60 * 1000, stdio: ['ignore', 'pipe', 'pipe'] });
  out(((r.stdout || '') + (r.stderr || '')).trim());
} else {
  out('\napp.asar 的补丁保持不变；如需还原请双击 restore.cmd（或加 --restore-asar）。');
}
