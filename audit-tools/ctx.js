// ctx —— 在（压缩过的）JS 文件里按字符串取上下文，用于阅读 app.asar 里切出来的代码
//
// 【典型用法】先用 asar_slice.js 把可疑代码切出来存成 .js，再逐层追问：
//     node audit-tools/asar_slice.js D:\zcode\resources\app.asar 254501071 900 900 > part.js
//     node audit-tools/ctx.js part.js "getUploadKey" 500 700
//     node audit-tools/ctx.js part.js "tokenProvider" 300 500 3
//
// 与 grep 的区别：这类文件是"一行到底"的压缩代码，grep -o 带上下文容易回溯卡死，
// 这里用 indexOf 逐个命中再手动切片，稳定且可控。
//
// Usage: node ctx.js <file> <pattern> [before] [after] [maxHits]
const fs = require('fs');
const file = process.argv[2];
const pattern = process.argv[3];
const before = parseInt(process.argv[4] || '400', 10);
const after = parseInt(process.argv[5] || '600', 10);
const maxHits = parseInt(process.argv[6] || '5', 10);

const src = fs.readFileSync(file, 'utf8');
let idx = src.indexOf(pattern);
let n = 0;
while (idx !== -1 && n < maxHits) {
  console.log('===== hit ' + (n + 1) + ' @' + idx + ' (file total ' + src.length + ' chars) =====');
  console.log(src.slice(Math.max(0, idx - before), Math.min(src.length, idx + pattern.length + after)));
  console.log();
  n++;
  idx = src.indexOf(pattern, idx + pattern.length);
}
if (!n) console.log('no hits for "' + pattern + '" in ' + file);
