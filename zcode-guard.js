#!/usr/bin/env node
/**
 * zcode-guard —— ZCode 快照上传拦截守卫（常驻）
 *
 * 作用：保证 D:\zcode\resources\app.asar 始终处于"已拦截快照上传"的状态。
 *   · 启动时立即检查一次（开机自启时，ZCode 启动前补丁就已就位）
 *   · 监听 resources 目录，app.asar 一旦被替换（例如自动更新装完新版本）就自动重打补丁
 *   · 另有 60 秒定时巡检兜底，防止文件监听漏事件
 *
 * 打补丁的动作全部委托给同一个目录下的 zcode-block-upload.js（--apply），
 * 因此逻辑、备份、校验与手动运行完全一致。找不到目标端点串时不会乱改文件，
 * 只记录警告并生成 NEEDS-REVIEW.txt，等人工复查。
 *
 * 由 guard-install.js 装入启动文件夹，随登录自动运行；用 guard-uninstall.js 卸载。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const ASAR = (process.env.ZCODE_ASAR || '').trim() || require('./detect-asar').detectAsar();
const WORKER = path.join(__dirname, 'zcode-block-upload.js');
const LOG = path.join(__dirname, 'zcode-guard.log');
const PIDFILE = path.join(__dirname, 'zcode-guard.pid');
const REVIEW = path.join(__dirname, 'NEEDS-REVIEW.txt');

const POLL_MS = 60 * 1000;
const DEBOUNCE_MS = 2500;
const STABLE_MS = 2000;
const STABLE_TIMEOUT_MS = 30 * 1000;

function stamp() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function log(msg) {
  const line = `[${stamp()}] ${msg}\n`;
  try {
    if (fs.existsSync(LOG) && fs.statSync(LOG).size > 2 * 1024 * 1024) {
      fs.renameSync(LOG, LOG + '.1');
    }
  } catch { /* 轮转失败不影响主流程 */ }
  try { fs.appendFileSync(LOG, line, 'utf8'); } catch { /* 忽略 */ }
  process.stdout.write(line);
}

function sig(p) {
  try {
    const s = fs.statSync(p);
    return s.size + ':' + Math.round(s.mtimeMs);
  } catch {
    return null;
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- 单实例 ----------
try {
  if (fs.existsSync(PIDFILE)) {
    const old = parseInt(fs.readFileSync(PIDFILE, 'utf8').trim(), 10);
    if (old && old !== process.pid) {
      try {
        process.kill(old, 0);
        console.log('已有守卫在运行 (pid ' + old + ')，本次退出');
        process.exit(0);
      } catch { /* 旧进程已死，继续 */ }
    }
  }
} catch { /* 忽略 */ }
fs.writeFileSync(PIDFILE, String(process.pid), 'utf8');

function cleanup() {
  try {
    if (fs.readFileSync(PIDFILE, 'utf8').trim() === String(process.pid)) fs.unlinkSync(PIDFILE);
  } catch { /* 忽略 */ }
}
process.on('exit', cleanup);
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

// ---------- 核心 ----------
let lastSig = null;
let running = false;
let queued = false;
let debounceTimer = null;

async function waitStable() {
  const t0 = Date.now();
  let prev = sig(ASAR);
  while (Date.now() - t0 < STABLE_TIMEOUT_MS) {
    await sleep(STABLE_MS);
    const cur = sig(ASAR);
    if (cur && cur === prev) return cur;
    prev = cur;
  }
  return sig(ASAR);
}

function runApply() {
  return new Promise(resolve => {
    execFile(process.execPath, [WORKER, '--apply', '--asar', ASAR],
      { timeout: 10 * 60 * 1000, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const out = (stdout || '').trim();
        if (out) log(out);
        const errtxt = (stderr || '').trim();
        if (errtxt) log('stderr: ' + errtxt);
        if (err) log('apply 退出异常: ' + err.message);
        // 版本变化导致找不到目标端点串：不乱改，留下待复查标记
        if (/找不到目标端点串|请勿盲目替换/.test(out + errtxt)) {
          try {
            fs.writeFileSync(REVIEW,
              `[${stamp()}] app.asar 里找不到 /api/v1/snapshot/upload-credential。\n` +
              `可能 ZCode 改了代码结构，请用 audit-tools/ 重新确认上传链路后再处理。\n` +
              `归档: ${ASAR}\n`, 'utf8');
          } catch { /* 忽略 */ }
          log('警告：目标端点串不存在，已生成 NEEDS-REVIEW.txt，未修改文件');
        }
        resolve();
      });
  });
}

async function check(reason) {
  if (running) { queued = true; return; }
  running = true;
  try {
    const s = sig(ASAR);
    if (!s) {
      log('未找到 ' + ASAR + '（可能正在升级），稍后重试');
      return;
    }
    if (s === lastSig) return;

    const stable = await waitStable();
    if (!stable) { log('文件状态不稳定（仍在写入），放弃本次'); return; }
    log('检测到 app.asar 变化（' + reason + '）签名 ' + stable + '，开始检查');
    await runApply();
    lastSig = sig(ASAR);
    log('处理结束，当前签名 ' + lastSig);
  } catch (e) {
    log('检查出错: ' + (e && e.message ? e.message : String(e)));
  } finally {
    running = false;
    if (queued) { queued = false; setTimeout(() => check('排队事件'), 500); }
  }
}

function schedule(reason) {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => check(reason), DEBOUNCE_MS);
}

// ---------- 启动 ----------
log('守卫启动：监控 ' + (ASAR || '(未找到 app.asar)') + '（node ' + process.version + '，pid ' + process.pid + '）');
if (!ASAR) {
  log('错误：没找到 ZCode 的 app.asar，守卫无法工作。');
  log('      请改用 install.cmd 安装（会自动探测），或用环境变量 ZCODE_ASAR 指定。');
  process.exit(1);
}
check('启动检查');

let watchOk = false;
try {
  fs.watch(path.dirname(ASAR), { persistent: true }, (evt, fname) => {
    const f = fname ? String(fname).toLowerCase() : '';
    if (f && f !== 'app.asar') return;
    schedule('文件事件 ' + evt + (f ? ' ' + f : ''));
  });
  watchOk = true;
  log('已监听目录 ' + path.dirname(ASAR));
} catch (e) {
  log('目录监听不可用（' + e.message + '），改用定时巡检');
}

setInterval(() => check('定时巡检'), POLL_MS);

process.on('uncaughtException', e => log('未捕获异常（已忽略）: ' + (e && e.stack ? e.stack : String(e))));
process.on('unhandledRejection', e => log('未处理的 Promise 拒绝（已忽略）: ' + String(e)));
