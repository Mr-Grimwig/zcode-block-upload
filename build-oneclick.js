#!/usr/bin/env node
/**
 * build-oneclick —— 生成"一键安装"单文件：把整个工具包以 base64 内嵌进一个 .cmd
 *
 * 产物：
 *   · 一键安装.cmd（工具目录 + 桌面各一份）
 *
 * 该单文件的行为：
 *   1. 从自身尾部取出内嵌的工具包（base64 → zip）
 *   2. 解压到稳定位置 %LOCALAPPDATA%\ZCodeSnapshotBlock（覆盖式，可重复运行）
 *   3. 调用其中的 install.cmd：自动识别 node / app.asar / 配置路径，
 *      打补丁 + 写入 SessionStart 钩子 + 自检
 *
 * 为什么装到 LOCALAPPDATA：钩子配置里必须写绝对路径，装到稳定位置后
 * 桌面上的压缩包/单文件就可以随便删，也不会因为换目录而失效。
 *
 * 说明：zip 里不含本脚本自身，避免自我嵌套。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const TOOL = __dirname;
const OUT_NAME = '一键安装.cmd';
const DESKTOP = path.join(process.env.USERPROFILE || os.homedir(), 'Desktop');

// 打进包里的文件（不含本构建脚本，避免嵌套）
const FILES = [
  'README.md',
  'LICENSE',
  'detect-asar.js',
  'setup.js',
  'uninstall.js',
  'zcode-block-upload.js',
  'zcode-guard.js',
  'zcode-session-hook.js',
  'guard-install.js',
  'guard-uninstall.js',
  'hooks-config.example.json',
  'install.cmd',
  'uninstall.cmd',
  'apply.cmd',
  'verify.cmd',
  'restore.cmd',
  'install-guard.cmd',
  'uninstall-guard.cmd',
  'audit-tools/asar_slice.js',
  'audit-tools/ctx.js',
  'audit-tools/fuses_all.js'
];

function log(s) { process.stdout.write(s + '\n'); }

// ---- 1. 暂存到 ASCII 路径（避免 PowerShell 处理中文路径）----
const stage = path.join(os.tmpdir(), 'zc-oneclick-' + Date.now());
const root = path.join(stage, 'files');
fs.mkdirSync(root, { recursive: true });
let total = 0;
for (const f of FILES) {
  const src = path.join(TOOL, f);
  if (!fs.existsSync(src)) throw new Error('缺少文件: ' + f);
  const dst = path.join(root, f);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  total += fs.statSync(src).size;
}
log(`暂存 ${FILES.length} 个文件，原始大小 ${(total / 1024).toFixed(1)} KB`);

// ---- 2. 打包（内容平铺在根上）----
const zip = path.join(stage, 'payload.zip');
execFileSync('powershell.exe', ['-NoProfile', '-Command',
  `Compress-Archive -Path '${root}\\*' -DestinationPath '${zip}' -Force`], { stdio: 'inherit' });
const zipSize = fs.statSync(zip).size;
log(`内嵌包大小 ${(zipSize / 1024).toFixed(1)} KB`);

// ---- 3. base64（每行 76 字符，避免超长行）----
const b64 = fs.readFileSync(zip).toString('base64').replace(/(.{76})/g, '$1\n');

// ---- 4. 组装单文件 ----
// 注意：正文只使用 ASCII，中文提示交给解压后运行的 install.cmd / setup.js（Node，UTF-8 安全），
// 避免 cmd 在非 65001 代码页下把中文读坏。base64 载荷位于 exit 之后，cmd 永远不会解析到它。
const cmd = `@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
set "DEST=%LOCALAPPDATA%\\ZCodeSnapshotBlock"
echo.
echo === ZCode snapshot-upload block : one-click install ===
echo   target: %DEST%
echo.
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $self=[IO.File]::ReadAllText('%~f0'); $m=('#>>>'+'PAY'+'LOAD>>>'); $i=$self.LastIndexOf($m); if($i -lt 0){Write-Host '  [x] payload not found'; exit 1}; $b=$self.Substring($i+$m.Length) -replace '\\s',''; $zip=Join-Path $env:TEMP ('zc-' + [guid]::NewGuid().ToString('N') + '.zip'); [IO.File]::WriteAllBytes($zip,[Convert]::FromBase64String($b)); $dest=Join-Path $env:LOCALAPPDATA 'ZCodeSnapshotBlock'; New-Item -ItemType Directory -Force -Path $dest | Out-Null; Expand-Archive -LiteralPath $zip -DestinationPath $dest -Force; Remove-Item $zip -Force; Write-Host ('  extracted to ' + $dest)"
if errorlevel 1 goto :fail
if not exist "%DEST%\\install.cmd" goto :fail
call "%DEST%\\install.cmd"
exit /b 0

:fail
echo.
echo   [x] extraction failed. Please unzip zcode-block-upload.zip manually and run install.cmd.
echo.
pause
exit /b 1

#>>>PAYLOAD>>>
${b64}
`;

const outTool = path.join(TOOL, OUT_NAME);
fs.writeFileSync(outTool, cmd, 'utf8');
log('已生成: ' + outTool);

try {
  fs.mkdirSync(DESKTOP, { recursive: true });
  const outDesk = path.join(DESKTOP, OUT_NAME);
  fs.writeFileSync(outDesk, cmd, 'utf8');
  log('已复制到桌面: ' + outDesk);
} catch (e) {
  log('复制到桌面失败: ' + e.message);
}

// ---- 5. 清理暂存 ----
try {
  fs.rmSync(stage, { recursive: true, force: true });
} catch { /* 忽略 */ }
log('完成。文件大小 ' + (fs.statSync(outTool).size / 1024).toFixed(1) + ' KB');
