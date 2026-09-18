#!/usr/bin/env node
/**
 * guard-install —— 把守卫装进"启动"文件夹，随登录自动运行（无需管理员权限）
 *
 * 会做三件事：
 *   1. 在本目录生成 zcode-guard-launcher.vbs（静默启动，不弹窗口）
 *   2. 复制到当前用户的启动文件夹
 *   3. 立刻启动一次，不用等下次登录
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const TOOL_DIR = __dirname;
const GUARD = path.join(TOOL_DIR, 'zcode-guard.js');
const LAUNCHER_NAME = 'ZCodeBlockUploadGuard.vbs';
const LAUNCHER_LOCAL = path.join(TOOL_DIR, 'zcode-guard-launcher.vbs');

const startupDir = path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
const launcherInStartup = path.join(startupDir, LAUNCHER_NAME);

function fail(msg) {
  console.error('错误: ' + msg);
  process.exit(1);
}

if (!fs.existsSync(GUARD)) fail('找不到 ' + GUARD);
if (!fs.existsSync(startupDir)) fail('找不到启动文件夹: ' + startupDir);

const nodeExe = process.execPath;
if (!fs.existsSync(nodeExe)) fail('找不到 node: ' + nodeExe);

// VBS 用 UTF-16LE + BOM 写入：路径里有中文，UTF-8 会被 WSH 读错
const vbs =
  'Set sh = CreateObject("WScript.Shell")\r\n' +
  `sh.CurrentDirectory = "${TOOL_DIR}"\r\n` +
  `sh.Run """${nodeExe}"" ""${GUARD}""", 0, False\r\n`;

const bom = Buffer.from([0xff, 0xfe]);
fs.writeFileSync(LAUNCHER_LOCAL, Buffer.concat([bom, Buffer.from(vbs, 'utf16le')]));
fs.copyFileSync(LAUNCHER_LOCAL, launcherInStartup);

console.log('已安装到启动文件夹: ' + launcherInStartup);
console.log('  node   : ' + nodeExe);
console.log('  脚本   : ' + GUARD);

try {
  execFileSync('wscript.exe', ['//B', launcherInStartup], { timeout: 20000 });
  console.log('已立即启动守卫（下次登录会自动启动）');
} catch (e) {
  console.log('立即启动失败（不影响开机自启）: ' + e.message);
}

console.log('\n守卫大约每 60 秒巡检一次，并在 app.asar 被更新替换时自动重打补丁。');
console.log('日志: ' + path.join(TOOL_DIR, 'zcode-guard.log'));
