// 从 git 历史 baeeb15 版本恢复 buildGraphRows（topo 序下稳定的布局实现）
const { execSync } = require('child_process');
const fs = require('fs');

const oldFile = execSync('git show baeeb15:renderer/app.js', { cwd: 'D:\\GitMate', maxBuffer: 64 * 1024 * 1024 }).toString('utf8');
const curPath = 'D:\\GitMate\\renderer\\app.js';
const cur = fs.readFileSync(curPath, 'utf8');

function extractBlock(src) {
  const a = src.indexOf('// 根据父提交关系计算每条泳道');
  const b = src.indexOf('async function loadHistoryData', a);
  if (a === -1 || b === -1) throw new Error('边界没找到');
  return src.slice(a, b);
}

const oldBlock = extractBlock(oldFile);
const curBlock = extractBlock(cur);
if (cur.indexOf(oldBlock) !== -1) { console.log('已一致，无需恢复'); process.exit(0); }
fs.writeFileSync(curPath, cur.replace(curBlock, oldBlock), 'utf8');
console.log('已恢复 baeeb15 版本的 buildGraphRows');
