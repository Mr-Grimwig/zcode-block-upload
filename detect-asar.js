'use strict';
/**
 * detect-asar —— 定位 ZCode 的 app.asar（所有脚本共用的入口）
 *
 * 为什么需要它：本工具的其它脚本（补丁器、会话钩子、常驻守卫、卸载器）都必须知道
 * 目标归档在哪。写死一个路径只在开发者本人的机器上成立，所以这里按下面的顺序探测，
 * 保证换机器、换安装目录都能自动找到：
 *
 *   1. 显式传入的路径（--asar）
 *   2. 环境变量 ZCODE_ASAR
 *   3. 正在运行的 ZCode.exe 所在目录下的 resources/app.asar（最可靠：直接问系统）
 *   4. 常见安装位置（%LOCALAPPDATA%\Programs、Program Files、盘根的 zcode 目录等）
 *   5. 各盘根一层目录里扫名字含 zcode 的目录下的 resources/app.asar（兜底）
 *
 * 找不到时返回 null，由调用方决定如何提示——不给一个假的默认值，避免"以为在保护、
 * 其实打在了别处"这种最糟的情况。
 *
 * 注意：第 3 步依赖 PowerShell（仅 Windows 有）。调用方若在意启动耗时，
 * 应把探测结果缓存下来（会话钩子就是把 asar 路径写进状态文件复用的）。
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

/** 正在运行的 ZCode 进程所在目录 → app.asar（拿不到就返回 null） */
function fromRunningProcess() {
  try {
    const p = execFileSync('powershell.exe', ['-NoProfile', '-Command',
      "(Get-CimInstance Win32_Process -Filter \"Name='ZCode.exe'\" | " +
      "Sort-Object CreationDate | Select-Object -First 1 -ExpandProperty ExecutablePath)"
    ], { encoding: 'utf8', timeout: 25000 }).trim();
    if (p) return path.join(path.dirname(p), 'resources', 'app.asar');
  } catch { /* 非 Windows、PowerShell 不可用或进程未运行：交给后续候选 */ }
  return null;
}

/** 常见安装位置（按可能性排序） */
function commonCandidates() {
  const list = [];
  const add = p => { if (p) list.push(p); };
  add(path.join('D:', 'zcode', 'resources', 'app.asar'));
  add(path.join('C:', 'zcode', 'resources', 'app.asar'));
  for (const base of [
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs'),
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)']
  ]) {
    add(base && path.join(base, 'ZCode', 'resources', 'app.asar'));
  }
  return list;
}

/** 兜底：各盘根一层目录里找名字含 zcode 的目录 */
function scanDriveRoots() {
  for (const drive of ['D:', 'C:', 'E:', 'F:']) {
    try {
      for (const name of fs.readdirSync(drive + path.sep)) {
        if (!/zcode/i.test(name)) continue;
        const p = path.join(drive + path.sep, name, 'resources', 'app.asar');
        if (fs.existsSync(p)) return p;
      }
    } catch { /* 该盘不存在或不可读 */ }
  }
  return null;
}

/**
 * @param {string|null} explicit 显式指定的路径（最高优先级）
 * @returns {string|null} app.asar 的绝对路径，找不到返回 null
 */
function detectAsar(explicit) {
  const ordered = [];
  if (explicit) ordered.push(explicit);
  const env = (process.env.ZCODE_ASAR || '').trim();
  if (env) ordered.push(env);
  const running = fromRunningProcess();
  if (running) ordered.push(running);
  ordered.push(...commonCandidates());

  for (const c of ordered) {
    try { if (fs.existsSync(c)) return c; } catch { /* 忽略非法路径 */ }
  }
  return scanDriveRoots();
}

module.exports = { detectAsar };
