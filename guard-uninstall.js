#!/usr/bin/env node
/**
 * guard-uninstall —— 卸载守卫：结束进程并移除开机自启
 * （只影响守卫本身，不会还原 app.asar；要还原补丁请运行 restore.cmd）
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const TOOL_DIR = __dirname;
const PIDFILE = path.join(TOOL_DIR, 'zcode-guard.pid');
const LAUNCHER_LOCAL = path.join(TOOL_DIR, 'zcode-guard-launcher.vbs');
const LAUNCHER_NAME = 'ZCodeBlockUploadGuard.vbs';
const startupDir = path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
const launcherInStartup = path.join(startupDir, LAUNCHER_NAME);

// 1) 结束正在运行的守卫进程（按命令行匹配，不会误杀其它 node 程序）
let killed = 0;
try {
  const out = execFileSync('powershell.exe', ['-NoProfile', '-Command',
    "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | " +
    "Where-Object { $_.CommandLine -like '*zcode-guard.js*' } | " +
    "ForEach-Object { Stop-Process -Id $_.ProcessId -Force; $_.ProcessId }"
  ], { encoding: 'utf8', timeout: 30000 });
  killed = out.trim() ? out.trim().split(/\s+/).length : 0;
  console.log(killed ? '已结束守卫进程 ' + killed + ' 个' : '没有正在运行的守卫进程');
} catch (e) {
  console.log('结束进程时出错（可能本来就没在运行）: ' + e.message);
}

// 2) 移除开机自启
for (const p of [launcherInStartup, LAUNCHER_LOCAL, PIDFILE]) {
  try {
    if (fs.existsSync(p)) { fs.unlinkSync(p); console.log('已删除: ' + p); }
  } catch (e) {
    console.log('删除失败 ' + p + ' : ' + e.message);
  }
}

console.log('\n守卫已卸载。app.asar 的补丁保持不变；如需还原原始文件请运行 restore.cmd。');
