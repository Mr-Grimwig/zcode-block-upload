#!/usr/bin/env node
/**
 * zcode-block-upload —— 阻止 ZCode 桌面端把工作区快照上传到阿里云 OSS
 *
 * 原理：ZCode 上传快照前必须先向服务端换取上传凭据：
 *     GET {origin}/api/v1/snapshot/upload-credential?workspace_id=<hash>
 * 拿到凭据（含 OSS 地址、签名、以及用于包裹 AES 密钥的 RSA 公钥）之后，才会
 * 打包工作区、加密并直传 OSS。本工具把这个端点路径替换成一个等长的、服务端
 * 不存在的路径，于是该请求返回 404，客户端在“取凭据”这一步就静默放弃——
 * 不打包、不加密、不落盘、不产生任何外发流量。这条失败分支正是服务端拒绝
 * 签发凭据时客户端本来就走的路径，因此不会影响对话、工具调用等其它功能。
 *
 * 关键约束：替换串必须与原文长度完全一致（逐字节替换，不增删任何字节），
 * 这样 app.asar 头部记录的文件偏移量全部保持有效，无需重建归档。
 *
 * 用法：
 *   node zcode-block-upload.js --verify            查看当前状态
 *   node zcode-block-upload.js --apply             打补丁（自动备份）
 *   node zcode-block-upload.js --restore           从备份还原
 *   node zcode-block-upload.js --apply --asar <path>   指定其它 app.asar
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { detectAsar } = require('./detect-asar');

const MARKER = '/api/v1/snapshot/upload-credential';
const REPLACEMENT = '/api/v1/snapshot/upload-disabled-x';

function parseArgs(argv) {
  const out = { mode: null, asar: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') out.mode = 'apply';
    else if (a === '--verify') out.mode = 'verify';
    else if (a === '--restore') out.mode = 'restore';
    else if (a === '--asar') out.asar = argv[++i];
    else if (a === '--help' || a === '-h') out.mode = 'help';
    else throw new Error('未知参数: ' + a);
  }
  if (!out.mode) out.mode = 'verify';
  return out;
}

/** 解析 asar 头，返回 { headerPickleSize, jsonLen, header, dataOffset } */
function readAsarHeader(fd) {
  const head = Buffer.alloc(16);
  fs.readSync(fd, head, 0, 16, 0);
  if (head.readUInt32LE(0) !== 4) throw new Error('不是有效的 asar 归档');
  const headerPickleSize = head.readUInt32LE(4);
  const jsonLen = head.readUInt32LE(12);
  if (jsonLen <= 0 || jsonLen > 64 * 1024 * 1024) throw new Error('asar 头长度异常: ' + jsonLen);
  const jsonBuf = Buffer.alloc(jsonLen);
  fs.readSync(fd, jsonBuf, 0, jsonLen, 16);
  let header;
  try {
    header = JSON.parse(jsonBuf.toString('utf8'));
  } catch (e) {
    throw new Error('asar 头 JSON 解析失败（归档可能已损坏）: ' + e.message);
  }
  return { headerPickleSize, jsonLen, header, dataOffset: 8 + headerPickleSize };
}

/** 统计整个归档中 marker 与 replacement 出现的次数 */
function scan(fd, size) {
  const CHUNK = 8 * 1024 * 1024;
  let carry = Buffer.alloc(0);
  let base = 0;
  const found = { marker: 0, replacement: 0 };
  while (base < size) {
    const len = Math.min(CHUNK, size - base);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, base);
    const hay = Buffer.concat([carry, buf]);
    for (const [key, needle] of [['marker', MARKER], ['replacement', REPLACEMENT]]) {
      const nb = Buffer.from(needle, 'binary');
      let i = hay.indexOf(nb);
      while (i !== -1) { found[key]++; i = hay.indexOf(nb, i + 1); }
    }
    carry = hay.slice(Math.max(0, hay.length - needle_len()));
    base += len;
  }
  function needle_len() { return Math.max(MARKER.length, REPLACEMENT.length); }
  return found;
}

/** 流式计算文件 md5，避免把 300MB 归档整体读进内存 */
function md5File(p) {
  const h = crypto.createHash('md5');
  const fd = fs.openSync(p, 'r');
  const buf = Buffer.alloc(4 * 1024 * 1024);
  try {
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return h.digest('hex');
}

function listBackups(asar) {
  const dir = path.dirname(asar);
  const base = path.basename(asar);
  return fs.readdirSync(dir).filter(f => f.startsWith(base + '.orig-')).sort()
    .map(f => path.join(dir, f));
}

/**
 * 找当前文件对应的备份：备份名里带内容哈希（app.asar.orig-<时间>-<md5前8位>），
 * 所以升级换了新版本后会另建一份新备份，而不会拿旧版本的备份去覆盖新版本。
 */
function findBackup(asar, hash8) {
  const all = listBackups(asar);
  if (hash8) {
    const m = all.filter(p => p.includes(hash8));
    if (m.length) return m[m.length - 1];
  }
  return all.length ? all[all.length - 1] : null;
}

function backupPath(asar) {
  return findBackup(asar, null);
}

function doVerify(asar) {
  if (!fs.existsSync(asar)) throw new Error('找不到 ' + asar);
  const fd = fs.openSync(asar, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const { header, dataOffset } = readAsarHeader(fd);
    const found = scan(fd, size);
    let fileCount = 0;
    (function walk(n) {
      if (!n || !n.files) return;
      for (const k of Object.keys(n.files)) {
        const c = n.files[k];
        if (c.files) walk(c); else fileCount++;
      }
    })(header);
    console.log('归档        : ' + asar);
    console.log('大小        : ' + size.toLocaleString() + ' 字节');
    console.log('数据区起点  : ' + dataOffset.toLocaleString());
    console.log('文件条目数  : ' + fileCount.toLocaleString());
    console.log('原始端点串  : ' + found.marker + ' 处');
    console.log('替换后端点串: ' + found.replacement + ' 处');
    const baks = listBackups(asar);
    console.log('备份        : ' + (baks.length ? baks.length + ' 份，最新 ' + path.basename(baks[baks.length - 1]) : '（无）'));
    if (found.marker > 0 && found.replacement === 0) console.log('\n状态: 未打补丁 —— 快照上传处于原始可用状态');
    else if (found.replacement >= 3 && found.marker === 0) console.log('\n状态: 已打补丁 —— 取凭据请求会 404，快照不会被打包/加密/上传');
    else console.log('\n状态: 异常 —— 两种串同时存在或数量不符，请用 --restore 还原后重试');
    return found;
  } finally {
    fs.closeSync(fd);
  }
}

function doApply(asar) {
  if (fs.existsSync(asar + '.orig') === false) { /* 占位，保持逻辑清晰 */ }
  if (Buffer.byteLength(REPLACEMENT) !== Buffer.byteLength(MARKER)) {
    throw new Error('替换串长度必须与原文完全一致（要求 ' + Buffer.byteLength(MARKER) +
                    '，实际 ' + Buffer.byteLength(REPLACEMENT) + '）');
  }
  const found = doVerify(asar);
  if (found.replacement >= 3 && found.marker === 0) {
    console.log('\n已经是打补丁后的状态，无需重复操作。');
    return;
  }
  if (found.marker === 0) {
    throw new Error('归档里找不到目标端点串，可能版本已变化；请勿盲目替换，先人工确认。');
  }

  // 备份：按当前文件内容哈希命名，同一版本只备份一次；
  // 版本升级后（内容变了）会另建新备份，不会误用旧版本备份。
  const dir = path.dirname(asar);
  const base = path.basename(asar);
  console.log('计算内容哈希（用于命名备份）…');
  const hash8 = md5File(asar).slice(0, 8);
  let bak = findBackup(asar, hash8);
  if (!bak) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    bak = path.join(dir, base + '.orig-' + stamp + '-' + hash8);
    console.log('备份到: ' + bak);
    fs.copyFileSync(asar, bak);
  } else {
    console.log('沿用同版本已有备份: ' + bak);
  }

  // 逐处等长替换
  const markerBuf = Buffer.from(MARKER, 'binary');
  const replBuf = Buffer.from(REPLACEMENT, 'binary');
  const fd = fs.openSync(asar, 'r+');
  let patched = 0;
  try {
    const size = fs.fstatSync(fd).size;
    const CHUNK = 8 * 1024 * 1024;
    let base0 = 0;
    let carryOverlap = markerBuf.length - 1;
    while (base0 < size) {
      const len = Math.min(CHUNK, size - base0);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, base0);
      let idx = buf.indexOf(markerBuf);
      while (idx !== -1) {
        replBuf.copy(buf, idx);
        fs.writeSync(fd, buf, idx, replBuf.length, base0 + idx);
        patched++;
        idx = buf.indexOf(markerBuf, idx + markerBuf.length);
      }
      base0 += len - carryOverlap;
      if (len < CHUNK) break;
    }
  } finally {
    fs.closeSync(fd);
  }
  console.log('已替换 ' + patched + ' 处');
  if (patched !== found.marker) throw new Error('替换数量与扫描结果不一致，请用 --restore 还原');

  console.log('\n打补丁后的校验：');
  const after = doVerify(asar);
  if (after.marker !== 0 || after.replacement !== patched) {
    throw new Error('校验失败，请用 --restore 还原');
  }
  console.log('\n完成。重启 ZCode 后生效（当前已加载到内存的进程不受影响）。');
}

/** 扫描任意文件里是否含有某个字符串 */
function fileContains(file, needle) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const CHUNK = 8 * 1024 * 1024;
    const nb = Buffer.from(needle, 'binary');
    let carry = Buffer.alloc(0);
    let base = 0;
    while (base < size) {
      const len = Math.min(CHUNK, size - base);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, base);
      const hay = Buffer.concat([carry, buf]);
      if (hay.indexOf(nb) !== -1) return true;
      carry = hay.slice(Math.max(0, hay.length - nb.length));
      base += len;
    }
    return false;
  } finally {
    fs.closeSync(fd);
  }
}

function doRestore(asar) {
  const baks = listBackups(asar);
  if (!baks.length) throw new Error('没有找到备份文件，无法还原');
  const bak = baks[baks.length - 1];
  if (baks.length > 1) {
    console.log('存在 ' + baks.length + ' 份备份，本次使用最新的：');
    for (const b of baks) console.log('   ' + path.basename(b));
  }
  if (fileContains(bak, REPLACEMENT)) {
    throw new Error('该备份本身已是打过补丁的版本（含有 ' + REPLACEMENT +
                    '），不是原始文件；请确认备份列表后手动指定');
  }
  const now = new Date().toISOString().replace(/[:.]/g, '-');
  const keep = asar + '.patched-' + now;
  fs.copyFileSync(asar, keep);
  fs.copyFileSync(bak, asar);
  console.log('已用备份还原: ' + path.basename(bak));
  console.log('打补丁版本另存为: ' + path.basename(keep));
  doVerify(asar);
}

function main() {
  const args = parseArgs(process.argv);
  if (args.mode === 'help') {
    console.log('用法: node zcode-block-upload.js [--verify|--apply|--restore] [--asar <path>]');
    console.log('未指定 --asar 时自动探测（见 detect-asar.js）。');
    return;
  }
  const asar = detectAsar(args.asar);
  if (!asar) {
    console.error('错误: 没找到 ZCode 的 app.asar。');
    console.error('      · 用 --asar "<路径>" 指定，或设置环境变量 ZCODE_ASAR；');
    console.error('      · 一般直接运行 install.cmd / setup.js 即可（会自动探测并配好一切）。');
    process.exit(1);
  }
  console.log('目标端点串: ' + MARKER + '  (' + Buffer.byteLength(MARKER) + ' 字节)');
  console.log('替换为    : ' + REPLACEMENT + '  (' + Buffer.byteLength(REPLACEMENT) + ' 字节)');
  console.log('目标归档  : ' + asar + '\n');
  if (args.mode === 'verify') doVerify(asar);
  else if (args.mode === 'apply') doApply(asar);
  else if (args.mode === 'restore') doRestore(asar);
}

try {
  main();
} catch (e) {
  console.error('\n错误: ' + e.message);
  process.exit(1);
}
