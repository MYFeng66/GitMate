// ============================================================
// 用真实仓库数据渲染泳道图：npx electron scripts/swimlane-real.js -- <仓库路径> [条数]
// 输出：设计稿/swimlane-real.png
// ============================================================
const { app, BrowserWindow } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const repoArg = process.argv.includes('--') ? process.argv[process.argv.indexOf('--') + 1] : null;
const MAX = parseInt(process.argv[process.argv.indexOf('--') + 2] || '80', 10);
const REPO = repoArg || 'D:/Study/Projects/01Project1/zero-one-tms2611';

const LANE_W = 26, ROW_H = 34, TOP = 24, LEFT = 24;
const PALETTE = ['#b07cff', '#3ecf8e', '#58a6ff', '#f2a666', '#4dd4e8', '#e58ee0', '#f5b83d', '#ff7b72', '#8be9fd', '#c792ea', '#a5d6a7', '#ffcc80', '#90caf9'];

function gitLog() {
  return new Promise((resolve, reject) => {
    const p = spawn('git', ['log', `--max-count=${MAX}`, '--date=iso',
      '--pretty=format:%x01%H%x1f%P%x1f%h%x1f%an%x1f%ad%x1f%s%x1f%d'], { cwd: REPO });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.on('close', (code) => code === 0 ? resolve(out) : reject(new Error(out)));
    p.on('error', reject);
  });
}

function layout(commits) {
  const lanes = [];
  const rows = [];
  let cursor = 0;
  const nextColor = () => PALETTE[cursor++ % PALETTE.length];
  for (const c of commits) {
    let dotCol = lanes.findIndex((l) => l.head === c.id);
    if (dotCol === -1) { dotCol = lanes.length; lanes.push({ head: c.id, color: nextColor(), isNew: true, oldCol: -1 }); }
    const dotColor = lanes[dotCol].color;
    const p1 = (c.p && c.p[0]) || null;
    const mapped = [];
    const forkClosures = [];
    let dotMapped = -1;
    lanes.forEach((l, j) => {
      if (j === dotCol) { dotMapped = mapped.length; mapped.push({ head: p1, color: l.color, isNew: false, oldCol: j }); }
      else if (l.head === c.id) { forkClosures.push({ from: j, color: l.color }); }
      else { mapped.push({ head: l.head, color: l.color, isNew: l.isNew, oldCol: j }); }
    });
    const mergeEdges = [];
    for (let k = 1; k < c.p.length; k++) {
      const p = c.p[k];
      let col = mapped.findIndex((l) => l.head === p);
      if (col === -1) { mapped.push({ head: p, color: nextColor(), isNew: true, oldCol: -1 }); col = mapped.length - 1; }
      if (col !== dotMapped) mergeEdges.push({ to: col });
    }
    if (p1) {
      const dup = mapped.findIndex((l, idx) => idx !== dotMapped && l.head === p1);
      if (dup !== -1) { mapped[dotMapped].head = null; mergeEdges.push({ to: dup }); }
    }
    const colMap = [];
    const newLanes = [];
    for (let j = 0; j < mapped.length; j++) {
      if (mapped[j].head === null) { colMap[j] = -1; continue; }
      colMap[j] = newLanes.length;
      mapped[j].finalCol = newLanes.length;
      newLanes.push(mapped[j]);
    }
    lanes.length = 0; lanes.push(...newLanes);
    rows.push({ dotCol, dotColor, mapped, colMap, mergeEdges, forkClosures, commit: c });
  }
  return { rows, lanes };
}

app.whenReady().then(async () => {
  try {
    const raw = await gitLog();
    const commits = [];
    for (const line of raw.replace(/\r/g, '').split('\n')) {
      const i = line.indexOf('\x01');
      if (i === -1 || !line.trim()) continue;
      const f = line.slice(i + 1).split('\x1f');
      commits.push({
        id: f[0], p: (f[1] || '').split(' ').filter(Boolean), h: f[2],
        a: f[3], d: (f[4] || '').slice(0, 10), s: f[5] || '', refs: f[6] || '',
        merge: /^Merge/.test(f[5] || ''),
      });
    }

    const { rows, lanes } = layout(commits);
    const H = TOP + commits.length * ROW_H + 40;
    const W = 1400;
    const cx = (col) => LEFT + col * LANE_W + 10;
    const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const curve = (x1, y1, x2, y2, color) => {
      const k = Math.max(9, (y2 - y1) * 0.55);
      return `<path d="M ${x1} ${y1} C ${x1} ${y1 + k}, ${x2} ${y2 - k}, ${x2} ${y2}" fill="none" stroke="${color}" stroke-width="2"/>`;
    };

    let s = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" style="display:block">`;
    s += `<rect width="${W}" height="${H}" fill="#17191f"/>`;
    rows.forEach((r, i) => {
      const y = TOP + i * ROW_H, mid = y + ROW_H / 2;
      for (const f of r.mapped) {
        if (f.isNew || f.oldCol === -1) continue;
        if (f.finalCol === f.oldCol) s += `<line x1="${cx(f.oldCol)}" y1="${y}" x2="${cx(f.oldCol)}" y2="${y + ROW_H}" stroke="${f.color}" stroke-width="2"/>`;
        else s += curve(cx(f.oldCol), y, cx(f.finalCol), y + ROW_H, f.color);
      }
      // 提交点泳道：上半段竖线 + 第一父延续
      const dotColor = r.dotColor, x0 = cx(r.dotCol);
      s += `<line x1="${x0}" y1="${y}" x2="${x0}" y2="${mid}" stroke="${dotColor}" stroke-width="2"/>`;
      const dfc = r.colMap[r.dotMapped];
      if (r.commit.p.length) {
        if (dfc === r.dotCol) s += `<line x1="${x0}" y1="${mid}" x2="${x0}" y2="${y + ROW_H}" stroke="${dotColor}" stroke-width="2"/>`;
        else s += curve(x0, mid, cx(dfc), y + ROW_H, dotColor);
      }
      for (const f of r.forkClosures) s += curve(cx(f.from), y, x0, mid, f.color);
      for (const e of r.mergeEdges) s += curve(x0, mid, cx(r.colMap[e.to]), y + ROW_H, r.mapped[e.to].color);
    });
    rows.forEach((r, i) => {
      const y = TOP + i * ROW_H, mid = y + ROW_H / 2;
      const c = r.commit;
      s += `<circle cx="${cx(r.dotCol)}" cy="${mid}" r="5" fill="${r.dotColor}" stroke="#17191f" stroke-width="2"/>`;
      const subjColor = c.merge ? '#8b8fa3' : '#d5d8e2';
      s += `<text x="470" y="${mid + 4.5}" font-family="Microsoft YaHei UI" font-size="13" fill="${subjColor}">${esc(c.s.slice(0, 48))}</text>`;
      s += `<text x="1060" y="${mid + 4}" font-family="Microsoft YaHei UI" font-size="12" fill="#787d90">${esc(c.a)}</text>`;
      s += `<text x="1200" y="${mid + 4}" font-family="Microsoft YaHei UI" font-size="12" fill="#787d90">${esc(c.d)}</text>`;
      if (c.refs.trim()) {
        const badge = c.refs.replace(/^\(|\)$/g, '').split(',')[0].trim().replace(/^HEAD -> /, 'HEAD · ');
        const w = badge.length * 7.2 + 24;
        s += `<rect x="790" y="${mid - 10}" width="${w}" height="20" rx="10" fill="rgba(124,108,255,0.25)"/>`;
        s += `<text x="802" y="${mid + 4}" font-family="Microsoft YaHei UI" font-size="11" fill="#c9b8ff">${esc(badge)}</text>`;
      }
    });
    if (lanes.length) {
      const lastY = TOP + (commits.length - 1) * ROW_H + ROW_H;
      s += lanes.map((l, i) => `<line x1="${cx(i)}" y1="${lastY}" x2="${cx(i)}" y2="${lastY + 28}" stroke="${l.color}" stroke-width="2"/>`).join('');
    }
    s += '</svg>';
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;background:#17191f}</style></head><body>${s}</body></html>`;

    const win = new BrowserWindow({ show: false, width: W, height: H, useContentSize: true, webPreferences: { offscreen: true } });
    win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    win.webContents.once('did-finish-load', async () => {
      await new Promise((r) => setTimeout(r, 400));
      const image = await win.webContents.capturePage({ x: 0, y: 0, width: W, height: H });
      const out = path.join(__dirname, '..', '设计稿', 'swimlane-real.png');
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, image.toPNG());
      console.log(`泳道数(峰值): ${Math.max(...rows.map(r => r.mapped.length))}，已生成: ${out}`);
      app.exit(0);
    });
    setTimeout(() => { console.log('超时'); app.exit(1); }, 20000);
  } catch (e) {
    console.error('失败: ' + e);
    app.exit(1);
  }
});
