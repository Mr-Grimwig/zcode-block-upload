#!/usr/bin/env node
'use strict';
/**
 * asar_slice —— 从 app.asar 里按字节偏移切出一段内容，并标出它属于哪个文件
 *
 * 【用途】ZCode 每次升级都可能改动代码结构。升级后想复查"拦截是否还有效、有没有新增
 * 外发通道"时，先用 grep 拿到关键字符串的字节偏移，再用本脚本把上下文切出来读：
 *
 *     cd D:\zcode\resources
 *     grep -abo "upload-credential" app.asar            # 列出所有命中偏移
 *     node asar_slice.js app.asar 253995697             # 看该偏移附近 700/900 字节
 *     node asar_slice.js app.asar 253995697 1500 1500   # 自定义前后长度
 *     node asar_slice.js app.asar --dump-header         # 打印归档头信息（顺带校验归档完好）
 *
 * 【为什么不用 grep -C】app.asar 里是打成一行（或极长行）的压缩 JS，grep 在这类输入上
 * 取上下文会因回溯而卡死；按字节切片又快又准。
 *
 * 【asar 格式（本脚本解析的就是它）】
 *     u32@0  = 4
 *     u32@4  = header pickle 大小
 *     u32@8  = 字符串 pickle 大小
 *     u32@12 = JSON 头长度
 *     偏移 16 起 = JSON 头（记录每个文件的 offset/size）
 *     数据区起点 = 8 + u32@4
 * 结构是"头部记偏移 + 数据顺序排列"，所以只要不增删字节就不会破坏归档——
 * 这正是主程序采用"等长替换"打补丁的原因。
 *
 * 用法: node asar_slice.js <archive> <offset|--dump-header> [before] [after]
 */
const fs = require('fs');

const archive = process.argv[2];
const fd = fs.openSync(archive, 'r');
const fileSize = fs.fstatSync(fd).size;

// Layout: u32@0 = 4 | u32@4 = headerPickleSize | u32@8 = stringPickleSize
//         u32@12 = jsonLength    | json @ 16        | data @ 8 + u32@4
const head = Buffer.alloc(16);
fs.readSync(fd, head, 0, 16, 0);

const headerPickleSize = head.readUInt32LE(4);
const jsonLen = head.readUInt32LE(12);

const jsonBuf = Buffer.alloc(jsonLen);
fs.readSync(fd, jsonBuf, 0, jsonLen, 16);

if (process.argv[3] === '--dump-header') {
  console.log('first16hex=' + head.toString('hex'));
  console.log('headerPickleSize=' + headerPickleSize + ' jsonLen=' + jsonLen);
  console.log('dataOffset=' + (8 + headerPickleSize));
  process.exit(0);
}

const header = JSON.parse(jsonBuf.toString('utf8'));
const dataOffset = 8 + headerPickleSize;

// 把嵌套的文件树摊平成 path -> {offset,size}，便于"偏移 → 所属文件"的反查
const entries = [];
(function walk(node, prefix) {
  if (!node || !node.files) return;
  for (const name of Object.keys(node.files)) {
    const child = node.files[name];
    const full = prefix ? prefix + '/' + name : name;
    if (child.files) walk(child, full);
    else if (typeof child.offset === 'string') entries.push({ path: full, offset: parseInt(child.offset, 10), size: child.size });
  }
})(header, '');
entries.sort((a, b) => a.offset - b.offset);

function owner(pos) {
  let lo = 0, hi = entries.length - 1, best = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (entries[mid].offset <= pos) { best = entries[mid]; lo = mid + 1; } else hi = mid - 1;
  }
  if (best && pos < best.offset + best.size) return best;
  return null; // 落在文件之间的空隙，或归档尾部的额外数据
}

const off = parseInt(process.argv[3], 10);
const before = parseInt(process.argv[4] || '700', 10);
const after = parseInt(process.argv[5] || '900', 10);

const start = Math.max(0, off - before);
const len = Math.min(after + before, fileSize - start);
const buf = Buffer.alloc(len);
fs.readSync(fd, buf, 0, len, start);

const e = owner(off);
console.log('### file: ' + (e ? e.path + '  (entrySize=' + e.size + ', entryOffset=' + e.offset + ')' : 'unknown'));
console.log('### absOffset=' + off + '  dataOffset=' + dataOffset);
console.log(buf.toString('utf8').replace(/\0/g, '.'));
