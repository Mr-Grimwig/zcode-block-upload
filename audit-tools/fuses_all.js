// fuses_all —— 读 Electron 的 fuse 配置，重点确认 asar 完整性校验是否开启
//
// 【为什么重要】Electron 有一组编译期开关（fuse），其中一个叫
// EnableEmbeddedAsarIntegrityValidation：一旦开启，改动 app.asar 会让应用直接启动失败。
// 本工具靠改 app.asar 实现拦截，所以在给"新版本"打补丁前必须先确认这一位是关的；
// 升级后复查时也建议先跑一遍。
//
// 【怎么读】Electron 二进制里有一段"fuse wire"：
//     32 字节哨兵字符串 dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX
//     1 字节版本
//     1 字节个数 N
//     N 个字符的 ASCII 位串，按 fuse 索引顺序，'1' = 开启，'0' = 关闭
// 索引 4 就是 EnableEmbeddedAsarIntegrityValidation。本脚本会打印全部命中位置，
// 并对"版本 1 + 位串"的结构给出解读（命中可能是误报，比如内嵌文本里恰好出现该字符串）。
//
// 用法: node fuses_all.js <ZCode.exe 路径>
const fs = require('fs');
const file = process.argv[2];
const SENTINEL = Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX', 'ascii');

const fd = fs.openSync(file, 'r');
const size = fs.fstatSync(fd).size;
const CHUNK = 32 * 1024 * 1024;
let carry = Buffer.alloc(0);
let base = 0;
const hits = [];

while (base < size) {
  const len = Math.min(CHUNK, size - base);
  const buf = Buffer.alloc(len);
  fs.readSync(fd, buf, 0, len, base);
  const hay = Buffer.concat([carry, buf]);
  const shift = carry.length;
  let i = hay.indexOf(SENTINEL);
  while (i !== -1) {
    hits.push(base - shift + i);
    i = hay.indexOf(SENTINEL, i + 1);
  }
  carry = hay.slice(Math.max(0, hay.length - SENTINEL.length));
  base += len;
}

console.log('total sentinel occurrences: ' + hits.length);
for (const h of hits) {
  const after = Buffer.alloc(24);
  fs.readSync(fd, after, 0, 24, h + SENTINEL.length);
  const printable = after.toString('latin1').replace(/[^\x20-\x7e]/g, '.');
  console.log('offset ' + h + '  next24hex=' + after.toString('hex') + '  ascii="' + printable + '"');
  // A real wire starts with version 1 then a small count, then (id,0/1) pairs.
  if (after[0] === 1 && after[1] >= 4 && after[1] <= 12) {
    const count = after[1];
    let ok = true;
    const pairs = [];
    for (let n = 0; n < count; n++) {
      const id = after[2 + n * 2];
      const val = after[3 + n * 2];
      if (![0, 1].includes(val)) { ok = false; break; }
      pairs.push([id, val]);
    }
    if (ok) {
      const NAMES = ['RunAsNode','EnableCookieEncryption','EnableNodeOptionsEnvironmentVariable','EnableNodeCliInspectArguments','EnableEmbeddedAsarIntegrityValidation','OnlyLoadAppFromAsar','LoadBrowserProcessSpecificV8Snapshot','GrantFileProtocolExtraPrivileges'];
      console.log('    ^^ PLAUSIBLE FUSE WIRE (version 1, ' + count + ' fuses)');
      for (const [id, val] of pairs) console.log('       [' + id + '] ' + (NAMES[id] || 'fuse#' + id) + ' = ' + (val ? 'ENABLED' : 'disabled'));
    }
  }
}
