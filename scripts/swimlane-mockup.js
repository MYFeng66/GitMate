// ============================================================
// GitMate 泳道图 IDEA 同款风格效果稿
// 运行：npx electron scripts/swimlane-mockup.js
// 输出：设计稿/swimlane-mockup.png
// ============================================================
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const LANE_W = 26, ROW_H = 34, TOP = 24, LEFT = 24;
const PALETTE = ['#b07cff', '#3ecf8e', '#58a6ff', '#f2a666', '#4dd4e8', '#e58ee0'];

// ---------- 数据（拓扑序 新→旧），模拟大仓库多人协作 ----------
const COMMITS = [
  { id: 'ME', s: "Merge remote-tracking branch 'origin/tms-j1-employee' into tms-j1-employee", a: 'gffish', d: '2026/11/19 19:47', p: ['MD', 'e2'], merge: true, badge: 'HEAD · tms-j1-employee' },
  { id: 'e2', s: '数据范围接口文档', a: 'aimiu', d: '2026/11/19 22:33', p: ['e1'], badge: 'origin/tms-j1-role-aimiu' },
  { id: 'e1', s: '角色接口文档设计', a: 'lsj', d: '2026/11/18 22:57', p: ['main4'] },
  { id: 'MD', s: "Merge branch 'tms-j1-role-Marry.N' into tms-j1-role", a: 'lsj', d: '2026/11/19 15:14', p: ['MC', 'd2'], merge: true },
  { id: 'd2', s: '新增负载字段适配系统业务需求', a: 'awei', d: '2026/11/19 15:32', p: ['d1'], badge: 'origin/arch-java' },
  { id: 'd1', s: '移除仓库中的settings.xml，本地保留个人配置', a: 'lsj', d: '2026/11/19 15:09', p: ['main4'] },
  { id: 'MC', s: "Merge remote-tracking branch 'origin/tms-j1-role' into tms-j1-role", a: 'lsj', d: '2026/11/19 15:19', p: ['MB', 'c3'], merge: true },
  { id: 'c3', s: '角色、角色-菜单权限 接口文档设计', a: 'lsj', d: '2026/11/19 15:11', p: ['c2'] },
  { id: 'c2', s: '移除settings.xml版本跟踪，本地保留私有配置', a: 'lsj', d: '2026/11/19 15:14', p: ['c1'] },
  { id: 'c1', s: '更新版本计划emmx', a: 'lsj', d: '2026/11/19 15:13', p: ['main3'] },
  { id: 'MB', s: "Merge branch 'tms-j1-profile' into tms-j1-profile-MYFeng66", a: 'Feng666Fen', d: '2026/11/19 19:28', p: ['MA', 'b2'], merge: true },
  { id: 'b2', s: '定义个人中心5个接口契约(空实现)，含Employee实体与数据层骨架', a: 'Feng666Fen', d: '2026/11/19 19:10', p: ['b1'], badge: '../tms-j1-profile-jlyi', highlight: true },
  { id: 'b1', s: '初步构建 tms-j1-employee 模块', a: '逆光', d: '2026/11/19 0:32', p: ['main2'] },
  { id: 'MA', s: "Merge remote-tracking branch 'origin/tms-j1-employee'", a: '逆光', d: '2026/11/19 19:28', p: ['main4', 'a3'], merge: true },
  { id: 'a3', s: 'README写错了，已修改', a: '逆光', d: '2026/11/19 19:28', p: ['a2'] },
  { id: 'a2', s: 'j1组织结构和接口文档定义', a: 'gffish', d: '2026/11/19 20:17', p: ['a1'] },
  { id: 'a1', s: 'j1组织结构和接口文档定义和接口文档', a: 'gffish', d: '2026/11/19 20:02', p: ['main3'] },
  { id: 'main4', s: '新增负载字段适配系统业务需求', a: 'awei', d: '2026/11/19 15:32', p: ['main3'] },
  { id: 'main3', s: 'apis、domain、j1-role 的结构目录创建', a: 'lsj', d: '2026/11/18 16:00', p: ['main2'] },
  { id: 'main2', s: 'chore: 停止跟踪个人本地配置文件', a: 'lsj', d: '2026/11/18 23:04', p: ['main1'] },
  { id: 'main1', s: '新增Java项目架构', a: 'awei', d: '2026/11/10 15:25', p: [], badge: 'origin & master' },
];

// ---------- 泳道布局（与应用内 buildGraphRows 同算法） ----------
function layout() {
  const lanes = [];
  const rows = [];
  let cursor = 0;
  const nextColor = () => PALETTE[cursor++ % PALETTE.length];

  for (const c of COMMITS) {
    let dotCol = lanes.findIndex((l) => l.head === c.id);
    if (dotCol === -1) { dotCol = lanes.length; lanes.push({ head: c.id, color: nextColor(), isNew: true }); }
    const dotColor = lanes[dotCol].color;

    const p1 = (c.p && c.p[0]) || null;
    const mapped = lanes.map((l, j) => ({ head: j === dotCol ? p1 : l.head, color: l.color, isNew: l.isNew && j !== dotCol }));
    const mergeEdges = [];
    for (let k = 1; k < c.p.length; k++) {
      const p = c.p[k];
      let col = mapped.findIndex((l) => l.head === p);
      if (col === -1) { mapped.push({ head: p, color: nextColor(), isNew: true }); col = mapped.length - 1; }
      if (col !== dotCol) mergeEdges.push({ to: col });
    }
    if (p1) {
      const dup = mapped.findIndex((l, idx) => idx !== dotCol && l.head === p1);
      if (dup !== -1) { mapped[dotCol].head = null; mergeEdges.push({ to: dup }); }
    }

    const colMap = [];
    const newLanes = [];
    for (let j = 0; j < mapped.length; j++) {
      if (mapped[j].head === null) { colMap[j] = -1; continue; }
      colMap[j] = newLanes.length;
      newLanes.push(mapped[j]);
    }
    lanes.length = 0; lanes.push(...newLanes);
    rows.push({ dotCol, dotColor, mapped, colMap, mergeEdges, commit: c });
  }
  return { rows, lanes };
}

// ---------- 渲染 SVG ----------
function renderSvg(state) {
  const { rows, lanes } = state;
  const H = TOP + COMMITS.length * ROW_H + 30;
  const W = 1240;
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
    const c = r.commit;
    if (c.highlight) s += `<rect x="8" y="${y}" width="${W - 16}" height="${ROW_H}" rx="6" fill="rgba(124,108,255,0.10)"/>`;
    for (let j = 0; j < r.mapped.length; j++) {
      if (r.mapped[j].isNew) continue;
      const col = r.mapped[j].color, m = r.colMap[j], x = cx(j);
      if (m === -1) s += `<line x1="${x}" y1="${y}" x2="${x}" y2="${mid}" stroke="${col}" stroke-width="2"/>`;
      else if (m === j) s += `<line x1="${x}" y1="${y}" x2="${x}" y2="${y + ROW_H}" stroke="${col}" stroke-width="2"/>`;
      else {
        s += `<line x1="${x}" y1="${y}" x2="${x}" y2="${mid}" stroke="${col}" stroke-width="2"/>`;
        s += curve(x, mid, cx(m), y + ROW_H, col);
      }
    }
    for (const e of r.mergeEdges) {
      s += curve(cx(r.dotCol), mid, cx(r.colMap[e.to]), y + ROW_H, r.mapped[e.to].color);
    }
  });

  rows.forEach((r, i) => {
    const y = TOP + i * ROW_H, mid = y + ROW_H / 2;
    const c = r.commit;
    const x = cx(r.dotCol);
    s += `<circle cx="${x}" cy="${mid}" r="5.5" fill="${r.dotColor}" stroke="#17191f" stroke-width="2"/>`;
    const subjColor = c.merge ? '#8b8fa3' : '#d5d8e2';
    s += `<text x="210" y="${mid + 4.5}" font-family="Microsoft YaHei UI" font-size="13" fill="${subjColor}">${esc(c.s)}</text>`;
    s += `<text x="950" y="${mid + 4}" font-family="Microsoft YaHei UI" font-size="12" fill="#787d90">${esc(c.a)}</text>`;
    s += `<text x="1080" y="${mid + 4}" font-family="Microsoft YaHei UI" font-size="12" fill="#787d90">${esc(c.d)}</text>`;
    if (c.badge) {
      const t = c.badge;
      const w = t.length * 7.2 + 24;
      const bx = 700, by = mid - 10;
      s += `<rect x="${bx}" y="${by}" width="${w}" height="20" rx="10" fill="rgba(124,108,255,0.25)"/>`;
      s += `<text x="${bx + 12}" y="${mid + 4}" font-family="Microsoft YaHei UI" font-size="11" fill="#c9b8ff">${esc(t)}</text>`;
    }
  });

  s += '</svg>';

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;background:#17191f}</style></head><body>${s}</body></html>`;
  return { html, W, H };
}

app.whenReady().then(() => {
  const { html, W, H } = renderSvg(layout());
  const win = new BrowserWindow({
    show: false, width: W, height: H,
    webPreferences: { offscreen: true },
    useContentSize: true,
  });
  let saved = false;
  win.webContents.on('paint', (e, dirty, image) => {
    if (saved || image.isEmpty()) return;
    const size = image.getSize();
    if (size.width < W - 4 || size.height < H - 4) return; // 等整页渲染
    saved = true;
    const out = path.join(__dirname, '..', '设计稿', 'swimlane-mockup.png');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, image.toPNG());
    console.log('已生成: ' + out);
    app.exit(0);
  });
  win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  setTimeout(() => { if (!saved) { console.log('超时'); app.exit(1); } }, 15000);
});
