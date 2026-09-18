#!/usr/bin/env node
/**
 * zcode-session-hook —— ZCode 的 SessionStart 钩子（随 ZCode 会话启动运行）
 *
 * 由 ~/.zcode/cli/config.json 的 hooks.events.SessionStart 注册，ZCode 每次开始
 * 会话（startup / resume / clear / compact）时调用一次，保证 app.asar 处于
 * "已拦截快照上传"的状态。
 *
 * 两条路径：
 *   · 快路径（绝大多数情况）：签名与上次一致且已确认打过补丁 → 立刻退出，
 *     约 50~100ms，不阻塞会话；
 *   · 慢路径（仅当 app.asar 被更新替换后走一次）：委托 zcode-block-upload.js --apply
 *     重新打补丁，完成后记录签名。
 *
 * 两条铁律（钩子机制的硬要求）：
 *   1. 绝不向 stdout 输出任何内容 —— 钩子 stdout 会被当作 JSON 解析，非 JSON 输出
 *      会导致该次钩子运行被标记失败，additionalContext 之类还会被注入对话；
 *   2. 绝不以非 0 退出 —— 非 0 会被视为错误甚至阻塞会话。
 * 因此本脚本把一切信息写进 zcode-guard.log，并始终 exit 0。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { detectAsar } = require('./detect-asar');

const WORKER = path.join(__dirname, 'zcode-block-upload.js');
const STATE = path.join(__dirname, 'zcode-hook-state.json');
const LOG = path.join(__dirname, 'zcode-guard.log');
const REVIEW = path.join(__dirname, 'NEEDS-REVIEW.txt');
const WORKER_TIMEOUT_MS = 45 * 1000; // 小于钩子 timeoutMs(60s)，保证由我们自己先退出

function log(msg) {
  try {
    fs.appendFileSync(LOG, `[${new Date().toISOString()}] [session-hook] ${msg}\n`, 'utf8');
  } catch { /* 日志失败不影响判断 */ }
}

function sig(p) {
  try {
    const s = fs.statSync(p);
    return s.size + ':' + Math.round(s.mtimeMs);
  } catch {
    return null;
  }
}

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return {}; }
}

function writeState(o) {
  try { fs.writeFileSync(STATE, JSON.stringify(o, null, 2), 'utf8'); } catch { /* 忽略 */ }
}

try {
  const st = readState();

  // 目标归档：优先环境变量，其次复用状态文件里记下的路径（避免每次都花时间探测），
  // 最后才做一次完整探测。把路径写进状态文件是有意为之——这个脚本每次开会话都要跑，
  // 快路径必须尽量短。
  let ASAR = (process.env.ZCODE_ASAR || '').trim() || null;
  if (!ASAR && st.asar) {
    try { if (fs.statSync(st.asar).isFile()) ASAR = st.asar; } catch { ASAR = null; }
  }
  if (!ASAR) ASAR = detectAsar();
  if (!ASAR) {
    log('未找到 app.asar，跳过本次（用 install.cmd 安装可自动探测并把路径记下来）');
    process.exit(0);
  }

  const s = sig(ASAR);

  if (!s) {
    log('未找到 ' + ASAR + '（可能正在升级），跳过本次');
  } else if (st.sig === s && st.patched === true && st.asar === ASAR) {
    // 快路径：不写日志（避免每次会话都刷日志），但更新状态文件里的时间戳作为心跳，
    // 便于确认"钩子确实被调用了"：看 zcode-hook-state.json 的 checkedAt。
    writeState({
      asar: ASAR,
      sig: s,
      patched: true,
      checkedAt: new Date().toISOString(),
      by: 'session-hook',
      mode: 'fast'
    });
  } else {
    log('会话启动检查：当前签名 ' + s + '，上次 ' + (st.sig || '无'));
    const r = spawnSync(process.execPath, [WORKER, '--apply', '--asar', ASAR], {
      timeout: WORKER_TIMEOUT_MS,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'] // 捕获子进程输出，绝不转发到本进程 stdout
    });
    const out = (r.stdout || '') + '\n' + (r.stderr || '');
    const patched = /状态: 已打补丁/.test(out) || /已经是打补丁后的状态/.test(out);
    const markerGone = /找不到目标端点串|请勿盲目替换/.test(out);

    if (patched) {
      log('结果：已确认处于拦截状态');
    } else {
      log('结果：未能确认处于拦截状态');
      log('输出尾部：' + out.trim().split('\n').filter(Boolean).slice(-6).join(' | '));
    }
    if (markerGone) {
      try {
        fs.writeFileSync(REVIEW,
          `[${new Date().toISOString()}] app.asar 里找不到 /api/v1/snapshot/upload-credential。\n` +
          `可能 ZCode 改了代码结构，请用 audit-tools/ 重新确认上传链路后再处理。\n` +
          `归档: ${ASAR}\n`, 'utf8');
      } catch { /* 忽略 */ }
      log('警告：目标端点串不存在，未修改文件，已生成 NEEDS-REVIEW.txt');
    }
    writeState({
      asar: ASAR,
      sig: sig(ASAR),
      patched,
      checkedAt: new Date().toISOString(),
      by: 'session-hook',
      mode: 'slow'
    });
  }
} catch (e) {
  log('异常（已忽略）: ' + (e && e.message ? e.message : String(e)));
}

process.exit(0);
