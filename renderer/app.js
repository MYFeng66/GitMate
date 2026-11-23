// ============================================================
// GitMate — 渲染进程逻辑
// 结构：状态 → 工具函数 → git 调用 → 各视图渲染 → 事件绑定
// ============================================================
'use strict';

const $ = (sel) => document.querySelector(sel);

// ---------- 全局状态 ----------
const state = {
  repos: [],            // 最近打开的仓库 [{path, name}]
  repo: null,           // 当前仓库 {path, name}
  tab: 'changes',       // 当前标签
  status: null,         // git status 解析结果
  selectedFile: null,   // {path, origPath, area} area: unstaged | staged
  commits: [],          // 提交历史
  graphRows: [],        // 泳道图行（commit 行 + 结构行）
  selectedCommit: null, // 选中的提交 hash
  selectedCdFile: null, // 历史详情中选中的文件
  branches: [],
  remoteBranches: [],
  currentBranch: '',
  historyFilter: '',   // 历史搜索词
  branchFilter: '',    // 分支搜索词
  selectedCmpFile: null, // 对比页选中的文件
  termHist: [],        // 终端命令历史
  termHistIdx: -1,
};

let lastFetchTime = 0;  // 上次自动 fetch 时间戳

const MAX_LOG = 150; // 泳道图模式下行数会变多，控制默认加载数量

/* ============================================================
 * 基础工具
 * ============================================================ */
function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function el(tag, cls, text) {
  const d = document.createElement(tag);
  if (cls) d.className = cls;
  if (text !== undefined) d.textContent = text;
  return d;
}
function relTime(iso) {
  const t = new Date(iso).getTime();
  if (isNaN(t)) return iso || '';
  const diff = (Date.now() - t) / 1000;
  if (diff < 60) return '刚刚';
  if (diff < 3600) return Math.floor(diff / 60) + ' 分钟前';
  if (diff < 86400) return Math.floor(diff / 3600) + ' 小时前';
  if (diff < 86400 * 30) return Math.floor(diff / 86400) + ' 天前';
  return new Date(iso).toLocaleDateString('zh-CN');
}
function toast(msg, type = 'info', ms = 3200) {
  const t = el('div', 'toast ' + type, msg);
  $('#toast-wrap').appendChild(t);
  setTimeout(() => { t.classList.add('fade'); setTimeout(() => t.remove(), 350); }, ms);
}
// 常见 git 报错 → 大白话翻译表（EasyGit 需求文档 第八章）
const ERR_MAP = [
  [/(non-fast-forward|fetch first|failed to push some refs)/i, '远端有你本地没有的新提交，先「拉取」再推送'],
  [/no tracking information/i, '当前分支还没有关联远端分支，推送一次（会自动建立关联）'],
  [/Permission denied \(publickey\)|Could not read from remote repository/i, 'SSH 密钥未配置或没有该仓库的访问权限'],
  [/CONFLICT/i, '存在冲突文件，需要先解决冲突再提交'],
  [/does not have any commits yet/i, '仓库还没有任何提交'],
  [/not a git repository/i, '这个文件夹不是 Git 仓库'],
  [/Your local changes to the following files would be overwritten/i, '本地改动会被这次操作覆盖，请先提交或丢弃改动'],
  [/nothing to commit/i, '没有可提交的内容'],
  [/Authentication failed/i, '认证失败：用户名/密码或令牌不对'],
];
function fmtGitErr(err) {
  const raw = String(err && err.message ? err.message : err);
  for (const [re, msg] of ERR_MAP) {
    if (re.test(raw)) return msg;
  }
  return raw.replace(/^error:\s?/gim, '').replace(/fatal:\s?/i, '').trim() || '未知错误';
}

/* ---------- 通用 git 调用（统一执行管道：预览命令 → 执行 → 日志 → 刷新） ---------- */
const cmdLogEntries = [];
function fmtCmd(args) {
  return 'git ' + args.map((a) =>(/[\s"]/.test(a) ? '"' + a + '"' : a)).join(' ');
}
function logCommand(args, r, ms) {
  const ok = r.code === 0;
  const entry = {
    text: fmtCmd(args),
    ok,
    ms,
    err: ok ? '' : String(r.err || r.out || '失败').trim().split('\n')[0].slice(0, 140),
  };
  cmdLogEntries.unshift(entry);
  if (cmdLogEntries.length > 80) cmdLogEntries.pop();
  renderCmdBar();
  termLogGui(args, r); // GUI 操作实时写入内嵌终端
}
function renderCmdBar() {
  const last = cmdLogEntries[0];
  $('#cmd-last').textContent = last
    ? `${last.text}   ${last.ok ? '✓ ' + last.ms + 'ms' : '✗ ' + (last.err || '失败')}`
    : '尚未执行命令';
}

/* ---------- 内嵌终端 ---------- */
function termAddLine(text, cls) {
  const out = $('#term-out');
  if (!out) return;
  const d = el('div', 'term-line ' + (cls || ''), text);
  out.appendChild(d);
  while (out.childElementCount > 500) out.removeChild(out.firstChild); // 控制内存
  out.scrollTop = out.scrollHeight;
}
function termNote(text) { termAddLine(text, 'tl-note'); }

// 动作类命令：会连输出一起写进终端；查询类（status/log/diff…）不刷屏
const ACTION_CMDS = new Set([
  'add', 'commit', 'push', 'pull', 'checkout', 'switch', 'merge', 'rebase',
  'stash', 'restore', 'clean', 'branch', 'tag', 'rm', 'mv', 'clone', 'config', 'fetch', 'init', 'reset',
]);

function termLogGui(args, r) {
  const isAction = ACTION_CMDS.has(String(args[0] || ''));
  if (!isAction) return;
  termAddLine('❯ ' + fmtCmd(args), 'tl-cmd-action');
  let outText = String(r.out || '').replace(/\n+$/, '');
  if (outText.trim()) {
    if (outText.length > 3000) outText = outText.slice(0, 3000) + '\n…（输出过长已截断）';
    termAddLine(outText, 'tl-out');
  }
  if (r.code !== 0) termAddLine('✗ ' + (r.err || '失败').slice(0, 200), 'tl-err');
}

async function git(args, opts = {}) {
  if (!state.repo) throw new Error('未打开仓库');
  const t0 = performance.now();
  const r = await window.gitmate.git(state.repo.path, args, opts.timeout || 20000);
  logCommand(args, r, Math.round(performance.now() - t0));
  if (r.code !== 0 && !opts.ignoreError) {
    const e = new Error(r.err || r.out || '命令失败');
    e.raw = r;
    throw e;
  }
  return r;
}

/* ---------- 模态框（按钮组动态生成，支持多选项） ---------- */
function setModalActions(choices) {
  const box = $('#modal-actions');
  box.innerHTML = '';
  for (const c of choices) {
    const b = el('button', (c.cls || 'btn-ghost'), c.label);
    b.addEventListener('click', () => { hideModal(); if (c.fn) c.fn(); });
    box.appendChild(b);
  }
}
function showModal({ title, html, okText = '确定', danger = false, onOk }) {
  $('#modal-title').textContent = title;
  $('#modal-body').innerHTML = html;
  setModalActions([
    { label: '取消', cls: 'btn-ghost' },
    { label: okText, cls: danger ? 'btn-danger' : 'btn-primary', fn: onOk },
  ]);
  $('#modal-wrap').classList.remove('hidden');
}
function showModalChoices({ title, html, choices }) {
  $('#modal-title').textContent = title;
  $('#modal-body').innerHTML = html;
  setModalActions(choices);
  $('#modal-wrap').classList.remove('hidden');
}
function hideModal() {
  $('#modal-wrap').classList.add('hidden');
}
function confirmModal(title, msg, onOk) {
  showModal({
    title,
    html: esc(msg),
    okText: '确认',
    danger: true,
    onOk,
  });
}
function promptModal(title, placeholder, value, onOk) {
  showModal({
    title,
    html: `<input id="modal-input" class="modal-input" placeholder="${esc(placeholder)}" value="${esc(value || '')}" />`,
    okText: '确定',
    onOk: () => {
      const v = $('#modal-input').value.trim();
      if (v) onOk(v);
    },
  });
  setTimeout(() => $('#modal-input') && $('#modal-input').select(), 30);
}

/* ---------- 右键菜单 ---------- */
function showCtxMenu(x, y, items) {
  const m = $('#ctx-menu');
  m.innerHTML = '';
  for (const it of items) {
    const b = el('button', 'ctx-item' + (it.danger ? ' danger' : ''), it.label);
    b.addEventListener('click', () => { hideCtxMenu(); it.action(); });
    m.appendChild(b);
  }
  m.classList.remove('hidden');
  const rect = m.getBoundingClientRect();
  m.style.left = Math.min(x, window.innerWidth - rect.width - 8) + 'px';
  m.style.top = Math.min(y, window.innerHeight - rect.height - 8) + 'px';
}
function hideCtxMenu() { $('#ctx-menu').classList.add('hidden'); }

/* ============================================================
 * 仓库管理
 * ============================================================ */
function loadRepos() {
  try { state.repos = JSON.parse(localStorage.getItem('gitmate.repos') || '[]'); } catch { state.repos = []; }
}
function saveRepos() {
  localStorage.setItem('gitmate.repos', JSON.stringify(state.repos.slice(0, 8)));
}

async function pickAndOpenRepo() {
  const p = await window.gitmate.pickFolder();
  if (p) await openRepoPath(p);
}

async function openRepoPath(p) {
  const r = await window.gitmate.openRepo(p);
  if (!r.ok) { toast(r.error, 'error'); return; }
  state.repo = { path: r.path, name: r.name };
  // 更新最近仓库列表
  state.repos = [{ path: r.path, name: r.name }, ...state.repos.filter((x) => x.path !== r.path)];
  saveRepos();
  enterRepo();
}

function enterRepo() {
  $('#welcome').classList.remove('show');
  $('#commit-bar').classList.remove('hidden');
  $('#repo-name').textContent = state.repo.name;
  $('#repo-path').textContent = state.repo.path;
  $('#repo-mini').classList.remove('hidden');
  $('#repo-mini .repo-mini-name').textContent = state.repo.name;
  renderSidebarRepos();
  termNote(`── 已打开仓库：${state.repo.name}（bash 会话已切换到该目录）──`);
  refresh();
  autoFetch(); // 打开/切换仓库时先静默 fetch，保证 ↑↓ 新鲜
}

function showWelcome() {
  $('#welcome').classList.add('show');
  $('#commit-bar').classList.add('hidden');
  setBanner(null);
  $('#repo-name').textContent = '未打开仓库';
  $('#repo-path').textContent = '';
  renderSidebarRepos();
  renderRecentRepos();
}

// 侧栏仓库列表（点谁切谁，学 Navicat 的连接列表）
function renderSidebarRepos() {
  const box = $('#sidebar-repos');
  if (!box) return;
  box.innerHTML = '';
  box.appendChild(el('div', 'rr-title', ' 仓库列表'));
  for (const r of state.repos.slice(0, 6)) {
    const active = state.repo && r.path === state.repo.path;
    const b = el('button', 'sb-repo-item' + (active ? ' active' : ''), (active ? '⭐ ' : '') + r.name);
    b.title = r.path;
    b.addEventListener('click', () => openRepoPath(r.path));
    box.appendChild(b);
  }
}

function renderRecentRepos() {
  const box = $('#recent-repos');
  box.innerHTML = '';
  if (!state.repos.length) return;
  const title = el('div', 'rr-title', '最近打开');
  box.appendChild(title);
  for (const r of state.repos) {
    const b = el('button', 'rr-item');
    b.innerHTML = `<b>${esc(r.name)}</b>${esc(r.path)}`;
    b.addEventListener('click', () => openRepoPath(r.path));
    box.appendChild(b);
  }
}

/* ============================================================
 * git status 解析（porcelain v2）
 * ============================================================ */
// 单列表模型：每个文件固定一行，x=下次提交状态，y=工作区状态
function parseStatus(text) {
  const res = { branch: '', upstream: '', ab: null, files: [] };
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (!line) continue;

    if (line.startsWith('# branch.head ')) res.branch = line.slice(14).trim();
    else if (line.startsWith('# branch.upstream ')) res.upstream = line.slice(18).trim();
    else if (line.startsWith('# branch.ab ')) {
      const m = line.match(/\+(\d+) -(\d+)/);
      if (m) res.ab = { ahead: +m[1], behind: +m[2] };
    } else if (line.startsWith('? ')) {
      res.files.push({ path: line.slice(2), origPath: null, x: '?', y: '?', untracked: true, conflict: false });
    } else if (line.startsWith('u ')) {
      const f = line.slice(2).split(' ');
      const p = f.slice(10).join(' ');
      res.files.push({ path: p, origPath: null, x: 'U', y: 'U', untracked: false, conflict: true });
    } else if (line.startsWith('1 ') || line.startsWith('2 ')) {
      // 关键：porcelain v2 中“未修改”用 '.' 表示，归一化为空格，与 v1 语义统一
      const xy = line.slice(2, 4).replace(/\./g, ' ');
      const rest = line.slice(5); // 去掉 "1 XY "
      const f = rest.split(' ');
      let path, origPath = null;
      if (line[0] === '1') {
        path = f.slice(6).join(' ');
      } else {
        // 重命名: "sub mH mI mW hH hI R100 new<TAB>old"
        const tail = f.slice(6).join(' ');
        const sp = tail.indexOf(' ');
        let p2 = sp === -1 ? '' : tail.slice(sp + 1);
        const tab = p2.indexOf('\t');
        if (tab >= 0) { origPath = p2.slice(tab + 1); p2 = p2.slice(0, tab); }
        path = p2;
      }
      res.files.push({
        path, origPath,
        x: xy[0], y: xy[1],
        untracked: false,
        conflict: xy[0] === 'U' || xy[1] === 'U',
      });
    }
  }
  return res;
}

// 双状态列用词（专业化，不用口水词）
const WORK_LABEL = { M: '已修改', D: '已删除', T: '类型变更', U: '冲突', '?': '未跟踪', ' ': '—' };
const INDEX_LABEL = { M: '已修改', A: '新增', D: '已删除', R: '重命名', C: '复制', T: '已修改', U: '待处理', ' ': '—' };

/* ============================================================
 * 刷新主流程
 * ============================================================ */
let refreshing = false;
async function refresh() {
  if (!state.repo || refreshing) return;
  refreshing = true;
  const gen = state.repoGen; // 记住本次刷新对应的仓库代数
  try {
    const r = await git(['status', '--porcelain=v2', '-b']);
    if (gen !== state.repoGen) return; // 仓库已切换，丢弃过期数据
    state.status = parseStatus(r.out);
    state.currentBranch = state.status.branch;
    updateTopbar();
    await updateBanner();
    if (gen !== state.repoGen) return;
    await updateStashBadge();
    if (state.tab === 'changes') await renderChanges();
    else if (state.tab === 'history') await renderHistory();
    else if (state.tab === 'branches') await renderBranches();
    else if (state.tab === 'compare') await renderCompare();
  } catch (e) {
    if (gen === state.repoGen) toast(fmtGitErr(e), 'error'); // 切仓引起的中止不报错
  } finally {
    refreshing = false;
  }
}

function updateTopbar() {
  const s = state.status;
  if (!s) return;
  $('#branch-wrap').classList.remove('hidden');
  $('#branch-name').textContent = s.branch || '(无分支)';
  $('#repo-mini .repo-mini-branch').textContent = s.branch || '';
  const ab = $('#ab-badge');
  if (s.ab && (s.ab.ahead || s.ab.behind)) {
    ab.textContent = `${s.ab.ahead ? '↑' + s.ab.ahead : ''}${s.ab.behind ? ' ↓' + s.ab.behind : ''}`;
    ab.classList.remove('hidden');
  } else {
    ab.classList.add('hidden');
  }
  const cnt = state.status.files.length;
  $('#ab-badge').title = lastFetchTime
    ? '上次同步：' + Math.max(1, Math.round((Date.now() - lastFetchTime) / 60000)) + ' 分钟前'
    : '尚未同步过远端';
  const badge = $('#chg-count');
  if (cnt > 0) { badge.textContent = cnt; badge.classList.remove('hidden'); }
  else badge.classList.add('hidden');
}

/* ============================================================
 * 变更视图（单列表 + 勾选即提交，隐藏暂存概念）
 * ============================================================ */
function checkedState(f) {
  return !f.conflict && f.x !== ' ' && f.x !== '?';
}

async function renderChanges() {
  renderChangeList();
  const n = state.status.files.filter(checkedState).length;
  $('#commit-btn').textContent = n ? `提交（${n} 个文件）` : '提交';
  $('#commit-btn').disabled = !n;
  highlightSelection();
  if (state.selectedFile) await loadFileDiff();
}

function renderChangeList() {
  const pendingZone = $('#change-list');
  const commitZone = $('#commit-zone-list');
  pendingZone.innerHTML = '';
  commitZone.innerHTML = '';
  const pending = state.status.files.filter((f) => !checkedState(f));
  const staged = state.status.files.filter(checkedState);

  $('#zone-pending-title').textContent = `改动区（${pending.length}）`;
  $('#zone-commit-title').textContent = `提交区（即将提交 ${staged.length}）`;

  if (!pending.length) pendingZone.appendChild(el('div', 'empty-hint', '没有待处理的改动 ✓'));
  for (const f of pending) pendingZone.appendChild(makeChangeRow(f, false));
  if (!staged.length) commitZone.appendChild(el('div', 'empty-hint', '从上面勾选要提交的文件'));
  for (const f of staged) commitZone.appendChild(makeChangeRow(f, true));
}

function makeChangeRow(f, staged) {
  const row = el('div', 'change-row' + (f.conflict ? ' conflict' : ''));
  row.dataset.path = f.path;

  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = staged;
  cb.disabled = f.conflict;
  cb.title = f.conflict
    ? '冲突文件需先解决（见顶部提示条）'
    : (staged ? '取消勾选：拿回改动区（git restore --staged）' : '勾选：放入提交区（git add）');
  cb.addEventListener('click', (e) => { e.stopPropagation(); toggleCheck(f, cb.checked); });

  const name = el('span', 'cr-name', f.origPath ? f.origPath + ' → ' + f.path : f.path);
  name.title = f.path;
  const st = el('span', 'cr-col',
    staged ? (INDEX_LABEL[f.x] || '—') : (f.conflict ? '冲突' : (WORK_LABEL[f.y] || '—')));
  if (f.conflict) st.classList.add('cr-red');

  row.appendChild(cb);
  row.appendChild(name);
  row.appendChild(st);

  row.addEventListener('click', () => {
    state.selectedFile = { path: f.path };
    highlightSelection();
    loadFileDiff();
  });
  row.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showCtxMenu(e.clientX, e.clientY, fileCtxItems(f));
  });
  return row;
}

async function toggleCheck(f, checked) {
  try {
    if (checked) await git(['add', '--', f.path]);
    else await git(['restore', '--staged', '--', f.path]);
    await refresh();
  } catch (e) {
    toast(fmtGitErr(e), 'error');
    await refresh();
  }
}

function fileCtxItems(f) {
  const items = [];
  items.push({
    label: f.untracked ? '✕ 删除此新文件…' : '✕ 丢弃更改…',
    danger: true,
    action: () => discardFile(f),
  });
  items.push({ label: '添加到 .gitignore', action: () => addToIgnore(f) });
  items.push({ label: '在资源管理器中显示', action: () => window.gitmate.showInFolder(state.repo.path + '\\' + f.path.replace(/\//g, '\\')) });
  return items;
}

function discardFile(f) {
  if (f.untracked) {
    confirmModal('删除未跟踪文件', `将永久删除新文件「${f.path}」，此操作无法撤销。确定继续？`, async () => {
      try {
        await git(['clean', '-f', '--', f.path]);
        toast('已删除', 'success');
        refresh();
      } catch (e) { toast(fmtGitErr(e), 'error'); }
    });
  } else {
    confirmModal('丢弃更改', `将「${f.path}」恢复为上次提交的版本，未提交的修改会丢失。确定继续？`, async () => {
      try {
        await git(['restore', '--', f.path]);
        toast('已丢弃更改', 'success');
        refresh();
      } catch (e) { toast(fmtGitErr(e), 'error'); }
    });
  }
}

async function discardAll() {
  const s = state.status;
  if (!s.files.length) return;
  const tracked = s.files.filter((f) => !f.untracked && !f.conflict).map((f) => f.path);
  const untracked = s.files.filter((f) => f.untracked).map((f) => f.path);
  confirmModal('丢弃全部更改', `将丢弃全部 ${s.files.length} 个文件的未提交更改（含未跟踪文件的删除），此操作无法撤销。确定继续？`, async () => {
    try {
      if (tracked.length) await git(['restore', '--', ...tracked]);
      if (untracked.length) await git(['clean', '-f', '--', ...untracked]);
      toast('已全部丢弃', 'success');
      refresh();
    } catch (e) { toast(fmtGitErr(e), 'error'); }
  });
}

async function addToIgnore(f) {
  const r = await window.gitmate.appendIgnore(state.repo.path, '/' + f.path);
  if (r.ok && !r.skipped) { toast('已加入 .gitignore', 'success'); refresh(); }
  else if (r.skipped) toast('.gitignore 中已存在', 'warn');
  else toast('写入 .gitignore 失败', 'error');
}

function highlightSelection() {
  document.querySelectorAll('.change-row').forEach((d) => {
    d.classList.toggle('selected', state.selectedFile && d.dataset.path === state.selectedFile.path);
  });
}

/* ---------- 文件差异 ---------- */
async function loadFileDiff() {
  const f = state.selectedFile;
  if (!f) return;
  $('#diff-head').classList.remove('hidden');
  $('#diff-file').textContent = f.path;
  const body = $('#diff-body');
  body.innerHTML = '<div class="placeholder">加载中…</div>';
  try {
    const r = await git(['diff', 'HEAD', '--', f.path]);
    body.innerHTML = '';
    if (!r.out.trim()) {
      const sf = state.status.files.find((x) => x.path === f.path);
      body.innerHTML = sf && sf.untracked
        ? '<div class="placeholder">这是新文件（未跟踪），勾选提交后即可入库</div>'
        : '<div class="placeholder">无差异</div>';
      return;
    }
    renderDiff(body, r.out);
  } catch (e) {
    body.innerHTML = '';
    body.appendChild(el('div', 'placeholder', '加载差异失败：' + fmtGitErr(e)));
  }
}

function renderDiff(container, text) {
  const frag = document.createDocumentFragment();
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    let cls = 'diff-line';
    if (line.startsWith('diff ')) cls += ' dl-file';
    else if (line.startsWith('+++') || line.startsWith('---')) cls += ' dl-meta';
    else if (line.startsWith('@@')) cls += ' dl-hunk';
    else if (line.startsWith('+')) cls += ' dl-add';
    else if (line.startsWith('-')) cls += ' dl-del';
    else if (line.startsWith('\\')) cls += ' dl-meta';
    const d = el('div', cls, line || ' ');
    frag.appendChild(d);
  }
  container.appendChild(frag);
}

/* ---------- 提交 ---------- */
async function doCommit() {
  const msg = $('#commit-msg').value.trim();
  if (!msg) { toast('请填写提交信息', 'warn'); return; }
  const n = state.status.files.filter(checkedState).length;
  if (!n) { toast('没有勾选任何文件，先在「变更」页勾选', 'warn'); return; }
  try {
    const r = await git(['commit', '-m', msg]);
    $('#commit-msg').value = '';
    const short = (r.out.match(/\[[\w/.-]+ ([a-f0-9]+)\]/) || [])[1];
    toast(short ? `已提交 ${short}` : '提交成功', 'success');
    refresh();
  } catch (e) {
    const raw = (e.raw && (e.raw.err + e.raw.out)) || '';
    if (/nothing to commit/i.test(raw)) toast('没有可提交的内容', 'warn');
    else if (/needs merge/i.test(raw)) toast('存在冲突文件未解决，无法提交', 'error');
    else toast(fmtGitErr(e), 'error');
  }
}

/* ============================================================
 * 历史视图
 * ============================================================ */
function parseRefs(deco) {
  if (!deco) return [];
  return deco.trim().replace(/^\(|\)$/g, '').split(',').map((s) => s.trim()).filter(Boolean);
}

/* ---------- 泳道图（自算泳道布局，不依赖 git --graph 的 ASCII） ---------- */
const LANE_COLORS = ['#3ecf8e', '#58a6ff', '#c297ff', '#f5b83d', '#ff7b72', '#4dd4e8', '#e58ee0', '#a8d08d', '#f2a666', '#7ee787'];
function laneColor(col) { return LANE_COLORS[((col % LANE_COLORS.length) + LANE_COLORS.length) % LANE_COLORS.length]; }

const ROW_H = 52;   // 提交行高度（与 CSS .commit-item 一致）
const LANE_W = 12;  // 每条泳道宽度

// 根据父提交关系计算每条泳道，输出每行的 SVG（IDEA 风格：日期序 + 平滑曲线 + 泳道色稳定）
function buildGraphRows(commits) {
  const lanes = [];   // 在途泳道：{ head: 下一个期望出现的提交 hash | null=待回收, color, isNew, oldCol }
  const rows = [];
  let colorCursor = 0;
  const nextColor = () => LANE_COLORS[colorCursor++ % LANE_COLORS.length];
  const cx = (col) => col * LANE_W + 6;
  const curve = (x1, y1, x2, y2, color) => {
    const k = Math.max(8, (y2 - y1) * 0.55);
    return `<path d="M ${x1} ${y1} C ${x1} ${y1 + k}, ${x2} ${y2 - k}, ${x2} ${y2}" fill="none" stroke="${color}" stroke-width="2"/>`;
  };

  for (const c of commits) {
    let dotCol = lanes.findIndex((l) => l.head === c.hash);
    if (dotCol === -1) {
      dotCol = lanes.length;
      lanes.push({ head: c.hash, color: nextColor(), isNew: true, oldCol: -1 });
    }
    const dotColor = lanes[dotCol].color;

    const p1 = (c.parents && c.parents[0]) || null;

    // pass 1: 构建 mapped（新列顺序）+ 各类边的坐标
    const mapped = [];
    const forkClosures = []; // 分叉闭合：其他分支线也指向本提交（日期序下的分叉点）
    let dotMapped = -1;
    lanes.forEach((l, j) => {
      if (j === dotCol) {
        dotMapped = mapped.length;
        mapped.push({ head: p1, color: l.color, isNew: false, oldCol: j });
      } else if (l.head === c.hash) {
        forkClosures.push({ from: j, color: l.color });
      } else {
        mapped.push({ head: l.head, color: l.color, isNew: l.isNew, oldCol: j });
      }
    });
    const mergeEdges = [];
    for (let k = 1; k < (c.parents || []).length; k++) {
      const p = c.parents[k];
      let col = mapped.findIndex((l) => l.head === p);
      if (col === -1) {
        mapped.push({ head: p, color: nextColor(), isNew: true, oldCol: -1 });
        col = mapped.length - 1;
      }
      if (col !== dotMapped) mergeEdges.push({ to: col });
    }
    if (p1) {
      const dup = mapped.findIndex((l, idx) => idx !== dotMapped && l.head === p1);
      if (dup !== -1) { mapped[dotMapped].head = null; mergeEdges.push({ to: dup }); }
    }

    // pass 2: 回收空泳道（根提交），并给幸存泳道记录最终列
    const colMap = new Array(mapped.length);
    const newLanes = [];
    for (let j = 0; j < mapped.length; j++) {
      if (mapped[j].head === null) { colMap[j] = -1; continue; }
      colMap[j] = newLanes.length;
      mapped[j].finalCol = newLanes.length;
      newLanes.push(mapped[j]);
    }
    lanes.length = 0;
    lanes.push(...newLanes);

    // pass 3: 绘制存活泳道（新泳道由合并曲线接入，上方无线）
    const width = Math.max(mapped.length, 1) * LANE_W + 6;
    let inner = '';
    for (const f of newLanes) {
      if (f.isNew || f.oldCol === -1) continue;
      if (f.finalCol === f.oldCol) {
        inner += `<line x1="${cx(f.oldCol)}" y1="0" x2="${cx(f.oldCol)}" y2="${ROW_H}" stroke="${f.color}" stroke-width="2"/>`;
      } else {
        inner += curve(cx(f.oldCol), 0, cx(f.finalCol), ROW_H, f.color);
      }
    }
    // 提交点泳道：上半段竖线 + 下段（第一父延续）
    inner += `<line x1="${cx(dotCol)}" y1="0" x2="${cx(dotCol)}" y2="${ROW_H / 2}" stroke="${dotColor}" stroke-width="2"/>`;
    if (p1) {
      const dfc = colMap[dotMapped];
      if (dfc === dotCol) inner += `<line x1="${cx(dotCol)}" y1="${ROW_H / 2}" x2="${cx(dotCol)}" y2="${ROW_H}" stroke="${dotColor}" stroke-width="2"/>`;
      else inner += curve(cx(dotCol), ROW_H / 2, cx(dfc), ROW_H, dotColor);
    }
    for (const f of forkClosures) {
      inner += curve(cx(f.from), 0, cx(dotCol), ROW_H / 2, f.color);
    }
    for (const e of mergeEdges) {
      inner += curve(cx(dotCol), ROW_H / 2, cx(colMap[e.to]), ROW_H, mapped[e.to].color);
    }
    inner += `<circle cx="${cx(dotCol)}" cy="${ROW_H / 2}" r="4.5" fill="${dotColor}" stroke="#0e1016" stroke-width="1.5"/>`;

    const svg = `<svg width="${width}" height="${ROW_H}" viewBox="0 0 ${width} ${ROW_H}" style="flex-shrink:0;display:block;overflow:visible">${inner}</svg>`;
    rows.push({ type: 'commit', svg, commit: c });
  }

  // 最后一行：在途泳道向下延伸一小段，表示历史未完（加载窗口截断）
  if (rows.length) {
    const extra = lanes.map((l, i) =>
      `<line x1="${cx(i)}" y1="${ROW_H}" x2="${cx(i)}" y2="${ROW_H + 26}" stroke="${l.color}" stroke-width="2"/>`).join('');
    rows[rows.length - 1].svg = rows[rows.length - 1].svg.replace('</svg>', extra + '</svg>');
  }
  return rows;
}

async function loadHistoryData() {
  // 日期序（与 IDEA 一致）：所有在途分支的泳道持续展开；%P 取父提交自行布局
  const r = await git([
    'log', `--max-count=${MAX_LOG}`, '--date=iso',
    '--pretty=format:%x01%H%x1f%P%x1f%h%x1f%an%x1f%ad%x1f%s%x1f%d%x02',
  ]);
  const lines = r.out.replace(/\r/g, '').split('\n');
  const commits = [];
  for (const line of lines) {
    const i = line.indexOf('\x01');
    if (i === -1 || !line.trim()) continue;
    const f = line.slice(i + 1).replace(/\x02$/, '').split('\x1f');
    commits.push({
      hash: f[0],
      parents: (f[1] || '').split(' ').filter(Boolean),
      short: f[2], author: f[3], date: f[4],
      subject: f[5] || '', refs: parseRefs(f[6]),
    });
  }
  state.commits = commits;
  state.graphRows = buildGraphRows(commits);
}

function makeCommitRow(graph, c) {
  const item = el('div', 'commit-item' + (state.selectedCommit === c.hash ? ' selected' : ''));
  item.dataset.hash = c.hash;
  if (graph) item.innerHTML = graph; // graph 参数现在是构建好的 SVG 字符串
  const body = el('div', 'ci-body');
  item.appendChild(body);

  const subjRow = el('div', 'ci-subject-row');
  subjRow.appendChild(el('span', 'ci-subject', c.subject));
  const maxRefs = 3; // 徽标太多会撑爆行，最多展示 3 个 + ＋N
  for (const rf of c.refs.slice(0, maxRefs)) {
    const isHead = rf.startsWith('HEAD');
    subjRow.appendChild(el('span', 'ref-badge' + (isHead ? ' head' : ''),
      isHead ? rf.replace(/^HEAD -> /, 'HEAD·') : rf));
  }
  if (c.refs.length > maxRefs) {
    subjRow.appendChild(el('span', 'ref-badge', '+' + (c.refs.length - maxRefs)));
  }
  body.appendChild(subjRow);

  const meta = el('div', 'ci-meta');
  meta.appendChild(el('span', 'ci-hash', c.short));
  meta.appendChild(el('span', '', c.author));
  meta.appendChild(el('span', '', relTime(c.date)));
  body.appendChild(meta);

  item.addEventListener('click', () => selectCommit(c.hash));
  item.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showCtxMenu(e.clientX, e.clientY, commitCtxItems(c));
  });
  return item;
}

// 历史页右键菜单：回到历史版本三件套（revert / reset / checkout）
function commitCtxItems(c) {
  const items = [];
  const isTip = state.commits[0] && state.commits[0].hash === c.hash; // 最新提交重置无意义
  items.push({ label: '↩ 抵消此提交（revert）', action: () => revertCommit(c) });
  if (!isTip) {
    items.push({ label: '⏪ 重置分支到此版本（丢弃之后的提交）', danger: true, action: () => resetToCommit(c) });
  }
  items.push({ label: '👁 临时查看此版本（detached HEAD）', action: () => checkoutCommit(c) });
  return items;
}

function revertCommit(c) {
  confirmModal('抵消此提交（revert）', `生成一个反向提交，抵消「${c.short} ${c.subject}」的改动，历史不变。已推送的也能用。`, async () => {
    try {
      await git(['revert', '--no-edit', c.hash]);
      toast(`已抵消 ${c.short}`, 'success');
      refresh();
    } catch (e) {
      const raw = (e.raw && e.raw.err) || '';
      if (/conflict/i.test(raw)) toast('抵消时遇到冲突，解决后提交即可', 'error');
      else toast(fmtGitErr(e), 'error');
      refresh();
    }
  });
}

function resetToCommit(c) {
  const count = state.commits.findIndex((x) => x.hash === c.hash);
  confirmModal('重置到此版本（高危）', `分支将回退到「${c.short} ${c.subject}」，之后的提交将丢弃（文件改动一并丢弃，无法撤销）。`, async () => {
    try {
      await git(['reset', '--hard', c.hash]);
      toast(`已重置到 ${c.short}`, 'success');
      refresh();
    } catch (e) { toast(fmtGitErr(e), 'error'); refresh(); }
  });
}

async function checkoutCommit(c) {
  const dirty = state.status && state.status.files.filter((f) => !f.conflict).length > 0;
  const go = async () => {
    try {
      await git(['checkout', c.hash]);
      toast(`正在查看 ${c.short}（顶部提示条可返回）`, 'success');
      refresh();
    } catch (e) { toast(fmtGitErr(e), 'error'); }
  };
  if (dirty) guardThen(go, c.short);
  else go();
}

function renderCommitList() {
  const list = $('#commit-list');
  list.innerHTML = '';
  if (!state.commits.length) {
    list.appendChild(el('div', 'empty-hint', '仓库还没有任何提交'));
    return;
  }
  const q = (state.historyFilter || '').toLowerCase();
  if (q) {
    // 搜索模式：过滤会破坏泳道结构，退化为平铺列表
    const shown = state.commits.filter((c) =>
      c.subject.toLowerCase().includes(q) || (c.author || '').toLowerCase().includes(q));
    if (!shown.length) { list.appendChild(el('div', 'empty-hint', '没有匹配的提交')); return; }
    for (const c of shown) list.appendChild(makeCommitRow(null, c));
    return;
  }
  for (const row of state.graphRows) {
    list.appendChild(makeCommitRow(row.svg, row.commit));
  }
}

async function renderHistory() {
  const list = $('#commit-list');
  try {
    await loadHistoryData();
  } catch (e) {
    if (/does not have any commits yet|unknown revision/i.test(String(e))) {
      list.innerHTML = '';
      list.appendChild(el('div', 'empty-hint', '仓库还没有任何提交'));
      return;
    }
    toast(fmtGitErr(e), 'error');
    return;
  }
  renderCommitList();
  if (state.selectedCommit) await renderCommitDetail();
}

async function selectCommit(hash) {
  state.selectedCommit = hash;
  state.selectedCdFile = null;
  document.querySelectorAll('.commit-item').forEach((d) => d.classList.toggle('selected', d.dataset.hash === hash));
  await renderCommitDetail();
}

async function renderCommitDetail() {
  const c = state.commits.find((x) => x.hash === state.selectedCommit);
  if (!c) return;
  const head = $('#commit-detail-head');
  head.classList.remove('hidden');
  $('#cd-subject').textContent = c.subject;
  $('#cd-meta').innerHTML = '';
  $('#cd-meta').appendChild(el('span', 'ci-hash', c.short));
  $('#cd-meta').appendChild(el('span', '', c.author));
  $('#cd-meta').appendChild(el('span', '', new Date(c.date).toLocaleString('zh-CN')));
  const refsBox = $('#cd-refs');
  refsBox.innerHTML = '';
  for (const rf of c.refs) {
    const isHead = rf.startsWith('HEAD');
    refsBox.appendChild(el('span', 'ref-badge' + (isHead ? ' head' : ''), isHead ? rf.replace(/^HEAD -> /, 'HEAD · ') : rf));
  }

  // 文件列表
  const filesBox = $('#cd-files');
  filesBox.innerHTML = '<div class="empty-hint">加载中…</div>';
  let files = [];
  try {
    const r = await git(['diff-tree', '--no-commit-id', '--name-status', '-r', '--find-renames', c.hash]);
    files = r.out.split('\n').filter(Boolean).map((line) => {
      const tab = line.indexOf('\t');
      const status = line.slice(0, tab).charAt(0);
      let rest = line.slice(tab + 1);
      let orig = null;
      if (status === 'R' || status === 'C') {
        const t2 = rest.indexOf('\t');
        if (t2 >= 0) { orig = rest.slice(0, t2); rest = rest.slice(t2 + 1); }
      }
      return { path: rest, orig, status };
    });
  } catch (e) { /* 首个提交 diff-tree 会失败，忽略 */ }
  filesBox.innerHTML = '';
  if (!files.length) filesBox.appendChild(el('div', 'empty-hint', '（初始提交）'));
  for (const f of files) {
    const item = el('div', 'file-item' + (state.selectedCdFile === f.path ? ' selected' : ''));
    item.appendChild(el('span', 'file-status fs-' + (f.status === 'R' ? 'R' : f.status), f.status === 'R' ? 'R' : f.status));
    item.appendChild(el('span', 'file-name', f.orig ? f.orig + ' → ' + f.path : f.path));
    item.addEventListener('click', () => {
      state.selectedCdFile = f.path;
      renderCommitDetail();
    });
    filesBox.appendChild(item);
  }

  // 差异
  const diffBox = $('#cd-diff');
  diffBox.innerHTML = '<div class="placeholder">加载中…</div>';
  try {
    const target = state.selectedCdFile || files[0]?.path;
    if (!target) { diffBox.innerHTML = ''; return; }
    const args = state.selectedCdFile
      ? ['show', '--format=', c.hash, '--', state.selectedCdFile]
      : ['show', '--format=', c.hash];
    const r = await git(args);
    diffBox.innerHTML = '';
    if (!r.out.trim()) diffBox.innerHTML = '<div class="placeholder">无差异</div>';
    else renderDiff(diffBox, r.out);
  } catch (e) {
    diffBox.innerHTML = '';
    diffBox.appendChild(el('div', 'placeholder', '加载差异失败：' + fmtGitErr(e)));
  }
}

/* ============================================================
 * 分支视图
 * ============================================================ */
async function renderBranches() {
  const list = $('#branch-list');
  list.innerHTML = '<div class="empty-hint">加载中…</div>';
  try {
    const fmt = '%(HEAD)%09%(refname:short)%09%(upstream:short)%09%(upstream:track)';
    const [lr, rr] = await Promise.all([
      git(['branch', '--list', '--format=' + fmt]),
      git(['branch', '-r', '--list', '--format=%(refname:short)']),
    ]);
    state.branches = lr.out.split('\n').filter(Boolean).map((line) => {
      const f = line.split('\t');
      return { current: f[0] === '*', name: f[1] || '', upstream: f[2] || '', track: f[3] || '' };
    });
    state.remoteBranches = rr.out.split('\n').map((s) => s.trim())
      .filter((s) => s && !/HEAD\s*->/.test(s) && !/\bHEAD$/.test(s));

    // 搜索过滤
    const q = (state.branchFilter || '').toLowerCase();
    const localShown = q ? state.branches.filter((b) => b.name.toLowerCase().includes(q)) : state.branches;
    const remoteShown = q ? state.remoteBranches.filter((n) => n.toLowerCase().includes(q)) : state.remoteBranches;

    // ---------- 本地分支 ----------
    list.innerHTML = '';
    list.appendChild(el('div', 'group-label', `本地分支（${localShown.length}）`));
    for (const b of localShown) {
      const item = el('div', 'branch-item' + (b.current ? ' current' : ''));
      if (b.current) item.appendChild(el('span', 'branch-dot'));
      item.appendChild(el('span', 'bi-name', b.name));
      if (b.upstream) {
        item.appendChild(el('span', 'bi-upstream', '⇄ ' + b.upstream));
        if (b.track) item.appendChild(el('span', 'bi-track', b.track.replace(/[[\]]/g, '')));
      }
      const actions = el('span', 'bi-actions');
      if (!b.current) {
        const sw = el('button', 'fa-btn', '切换');
        sw.addEventListener('click', () => switchBranch(b.name));
        actions.appendChild(sw);
        const mg = el('button', 'fa-btn', '合并到当前');
        mg.addEventListener('click', () => mergeBranch(b.name));
        actions.appendChild(mg);
        const del = el('button', 'fa-btn danger', '删除');
        del.addEventListener('click', () => deleteBranch(b.name));
        actions.appendChild(del);
      }
      item.appendChild(actions);
      list.appendChild(item);
    }
    if (!localShown.length) list.appendChild(el('div', 'empty-hint', q ? '没有匹配的本地分支' : '暂无本地分支'));

    // ---------- 远程分支 ----------
    list.appendChild(el('div', 'group-label', `远程分支（${remoteShown.length}）`));
    if (!remoteShown.length) {
      list.appendChild(el('div', 'empty-hint', q ? '没有匹配的远程分支' : '暂无远程分支（推送一次后会出现）'));
    }
    for (const name of remoteShown) {
      const localName = name.replace(/^[^/]+\//, ''); // origin/feature → feature
      const checkedOut = state.currentBranch === localName;
      const item = el('div', 'branch-item' + (checkedOut ? ' current' : ''));
      if (checkedOut) item.appendChild(el('span', 'branch-dot'));
      item.appendChild(el('span', 'bi-name', name));
      if (checkedOut) item.appendChild(el('span', 'tag bi-checked', '已检出'));
      const actions = el('span', 'bi-actions');
      if (!checkedOut) {
        const co = el('button', 'fa-btn', '检出');
        co.addEventListener('click', () => checkoutRemote(name));
        actions.appendChild(co);
      }
      const mg = el('button', 'fa-btn', '合并到当前');
      mg.addEventListener('click', () => mergeBranch(name));
      actions.appendChild(mg);
      const del = el('button', 'fa-btn danger', '删除远程');
      del.addEventListener('click', () => deleteRemoteBranch(name));
      actions.appendChild(del);
      item.appendChild(actions);
      list.appendChild(item);
    }
  } catch (e) {
    list.innerHTML = '';
    list.appendChild(el('div', 'empty-hint', '加载失败：' + fmtGitErr(e)));
  }
}

// 检出远程分支：git checkout origin/xxx 会自动创建本地跟踪分支 xxx
async function checkoutRemote(name) {
  const localName = name.replace(/^[^/]+\//, '');
  guardThen(async () => {
    try {
      await git(['checkout', name]);
      toast(`已检出 ${name}${state.currentBranch !== localName ? '（自动创建本地分支 ' + localName + '）' : ''}`, 'success');
      refresh();
    } catch (e) { toast(fmtGitErr(e), 'error'); }
  }, name);
}

// 删除远程分支
function deleteRemoteBranch(name) {
  const remoteBranch = name.replace(/^[^/]+\//, '');
  confirmModal('删除远程分支', `将执行 git push origin --delete ${remoteBranch}，远程分支「${name}」会被删除（本地不受影响）。确定继续？`, async () => {
    try {
      await git(['push', 'origin', '--delete', remoteBranch], { timeout: 60000 });
      toast('远程分支已删除', 'success');
      refresh();
    } catch (e) { toast(fmtGitErr(e), 'error'); }
  });
}

// 切分支守卫：有未提交改动时给出 4 个选项（带着走 / 提交后走 / 贮藏后走 / 取消）
function guardThen(switchFn, branchName) {
  const dirty = state.status && state.status.files.filter((f) => !f.conflict).length > 0;
  if (!dirty) { switchFn(); return; }
  const n = state.status.files.length;
  showModalChoices({
    title: '有未提交的改动',
    html: `你有 <b>${n}</b> 个文件的改动未提交，切换分支时怎么处理？<br><br>` +
          `· <b>带着切换</b>：改动跟到新分支，仍是未提交状态（若与新分支的文件冲突会切换失败，不会丢数据）<br>` +
          `· <b>提交后切换</b>：改动先钉进当前分支的历史，新分支上看到不到<br>` +
          `· <b>贮藏后切换</b>：改动放进保险柜（stash），切回来后随时取出，最灵活<br>` +
          `· <b>取消</b>：留在当前分支`,
    choices: [
      { label: '带着切换', cls: 'btn-primary', fn: switchFn },
      { label: '提交后切换', cls: 'btn-primary', fn: () => commitThenSwitch(branchName) },
      { label: '贮藏后切换', cls: 'btn-primary', fn: () => stashThenSwitch(branchName) },
      { label: '取消', cls: 'btn-ghost' },
    ],
  });
}

// 选项 2：弹窗填提交信息 → 全部提交 → 切换
function commitThenSwitch(branchName) {
  const n = state.status.files.length;
  showModal({
    title: '提交后切换',
    html: `将提交全部 <b>${n}</b> 个文件的改动（git add -A + git commit），然后切换到 <b>${esc(branchName)}</b>。` +
          `<textarea id="wip-msg" class="modal-input" rows="3" placeholder="提交信息（改动未写完可写 WIP: xxx，回头再补）"></textarea>`,
    okText: '提交并切换',
    onOk: async () => {
      const msg = $('#wip-msg').value.trim();
      if (!msg) { toast('请填写提交信息', 'warn'); return; }
      try {
        await git(['add', '-A']);
        await git(['commit', '-m', msg]);
        toast('已提交', 'success');
        await git(['checkout', branchName]);
        toast(`已切换到 ${branchName}`, 'success');
        refresh();
      } catch (e) {
        toast(fmtGitErr(e), 'error');
        refresh();
      }
    },
  });
  setTimeout(() => { const t = $('#wip-msg'); if (t) t.focus(); }, 50);
}

// 选项 3：贮藏（stash）后切换；切回来后顶栏徽章提醒取出
async function stashThenSwitch(branchName) {
  try {
    await git(['stash', 'push', '-u', '-m', `切到 ${branchName} 前的自动贮藏（原分支：${state.currentBranch}）`]);
    toast('改动已存入贮藏（stash），工作区已变干净；切回来后点顶栏「📦 贮藏」取出', 'success', 6000);
    await git(['checkout', branchName]);
    toast(`已切换到 ${branchName}`, 'success');
    refresh();
  } catch (e) {
    toast(fmtGitErr(e), 'error');
    refresh();
  }
}

// 贮藏管理：列出所有 stash，可取出（pop）/删除（drop）
function stashModal() {
  git(['stash', 'list']).then((r) => {
    const lines = r.out.split('\n').filter((s) => s.startsWith('stash@{'));
    let html;
    if (!lines.length) {
      html = '当前没有贮藏的内容。';
    } else {
      html = '以下是你贮藏的改动（不属于任何分支），「取出并恢复」会把它应用到当前分支并删除该条；取出时若与当前分支冲突会提示：<div class="stash-list">' +
        lines.map((line, i) => {
          const end = line.indexOf('}');
          const ref = line.slice(0, end + 1);
          const msg = esc(line.slice(end + 2).trim());
          return `<div class="stash-row"><span class="stash-msg">${i + 1}. ${msg}</span>` +
            `<span><button class="fa-btn" data-ref="${esc(ref)}" data-act="pop">取出并恢复</button> ` +
            `<button class="fa-btn danger" data-ref="${esc(ref)}" data-act="drop">删除</button></span></div>`;
        }).join('') + '</div>';
    }
    showModal({ title: '贮藏的改动（stash）', html, okText: '关闭' });
    document.querySelectorAll('#modal-body .fa-btn').forEach((b) => {
      b.addEventListener('click', async () => {
        try {
          if (b.dataset.act === 'pop') {
            await git(['stash', 'pop', b.dataset.ref]);
            toast('已取出贮藏的改动，恢复到工作区', 'success');
          } else {
            await git(['stash', 'drop', b.dataset.ref]);
            toast('已删除该条贮藏', 'success');
          }
          hideModal();
          refresh();
        } catch (e) { toast(fmtGitErr(e), 'error'); }
      });
    });
  }).catch((e) => toast(fmtGitErr(e), 'error'));
}

// 顶栏贮藏徽章：有未取出的 stash 时醒目显示
async function updateStashBadge() {
  try {
    const r = await git(['stash', 'list'], { ignoreError: true });
    const cnt = r.out.split('\n').filter((s) => s.startsWith('stash@{')).length;
    state.stashCount = cnt;
    const b = $('#stash-badge');
    if (cnt > 0) {
      b.textContent = `📦 贮藏 ${cnt}`;
      b.classList.remove('hidden');
    } else {
      b.classList.add('hidden');
    }
  } catch { /* 忽略 */ }
}

async function switchBranch(name) {
  guardThen(async () => {
    try {
      await git(['checkout', name]);
      toast(`已切换到 ${name}`, 'success');
      refresh();
    } catch (e) { toast(fmtGitErr(e), 'error'); }
  }, name);
}

function mergeBranch(name) {
  confirmModal('合并分支', `将「${name}」合并到当前分支「${state.currentBranch}」？`, async () => {
    try {
      await git(['merge', name]);
      toast('合并成功', 'success');
      refresh();
    } catch (e) {
      showModal({
        title: '合并失败',
        html: `可能存在冲突，请解决冲突后提交。<pre>${esc((e.raw && e.raw.err) || fmtGitErr(e))}</pre>`,
        okText: '知道了',
        onOk: null,
      });
      refresh();
    }
  });
}

function deleteBranch(name) {
  confirmModal('删除分支', `确定删除分支「${name}」？（若未合并将无法删除，可用命令行 -D 强删）`, async () => {
    try {
      await git(['branch', '-d', name]);
      toast('分支已删除', 'success');
      refresh();
    } catch (e) { toast(fmtGitErr(e), 'error'); }
  });
}

async function createBranch() {
  const input = $('#new-branch-name');
  const name = input.value.trim();
  if (!name) { toast('请输入分支名', 'warn'); return; }
  if (!/^[^ ~^:?*[\]\\]+$/.test(name)) { toast('分支名包含非法字符', 'error'); return; }
  try {
    await git(['checkout', '-b', name]);
    input.value = '';
    toast(`已创建并切换到 ${name}`, 'success');
    refresh();
  } catch (e) { toast(fmtGitErr(e), 'error'); }
}

/* ============================================================
 * 推送 / 拉取
 * ============================================================ */
async function doPush() {
  if (!state.repo) return;
  const s = state.status;
  const upstream = s ? s.upstream : '';
  toast('推送中…', 'info', 8000);
  try {
    if (upstream) await git(['push'], { timeout: 90000 });
    else {
      await promptOrPushSetUpstream();
      return;
    }
    toast('推送成功', 'success');
    refresh();
  } catch (e) {
    showModal({
      title: '推送失败',
      html: `<pre>${esc((e.raw && e.raw.err) || fmtGitErr(e))}</pre>`,
      okText: '知道了',
    });
    refresh();
  }
}

async function promptOrPushSetUpstream() {
  const branch = state.currentBranch;
  promptModal('设置上游并推送', '远程仓库名（通常是 origin）', 'origin', async (remote) => {
    try {
      await git(['push', '-u', remote, branch], { timeout: 90000 });
      toast('推送成功（已设置上游）', 'success');
      refresh();
    } catch (e) {
      showModal({
        title: '推送失败',
        html: `<pre>${esc((e.raw && e.raw.err) || fmtGitErr(e))}</pre>`,
        okText: '知道了',
      });
      refresh();
    }
  });
}

async function doPull() {
  if (!state.repo) return;
  toast('拉取中…', 'info', 8000);
  try {
    await git(['pull', '--no-edit'], { timeout: 90000 });
    toast('拉取成功', 'success');
    refresh();
  } catch (e) {
    const raw = (e.raw && e.raw.err) || '';
    if (/no tracking information/i.test(raw)) {
      toast('当前分支没有上游，请先推送一次（会自动设置上游）', 'warn');
    } else if (/(conflict|merge)/i.test(raw)) {
      showModal({
        title: '拉取出现冲突',
        html: `存在冲突文件，请在「变更」页解决冲突后提交。<pre>${esc(raw)}</pre>`,
        okText: '知道了',
      });
      refresh();
    } else {
      showModal({
        title: '拉取失败',
        html: `<pre>${esc(raw || fmtGitErr(e))}</pre>`,
        okText: '知道了',
      });
      refresh();
    }
  }
}

/* ============================================================
 * 提示条（仅异常时出现，"我该怎么办"）
 * ============================================================ */
function setBanner(text, actionLabel, handler) {
  const b = $('#banner');
  if (!text) { b.classList.add('hidden'); return; }
  b.classList.remove('hidden');
  $('#banner-text').textContent = text;
  const btn = $('#banner-action');
  btn.textContent = actionLabel || '';
  btn.classList.toggle('hidden', !actionLabel);
  btn.onclick = handler || null;
}

async function updateBanner() {
  const s = state.status;
  if (!s) { setBanner(null); return; }

  // 1) 合并冲突进行中
  const conflicts = s.files.filter((f) => f.conflict).length;
  if (conflicts > 0) {
    setBanner(`你在合并冲突中，还剩 ${conflicts} 个文件没解决`, '去处理', () => switchTab('changes'));
    return;
  }
  // 2) 分离头指针
  if (s.branch === '(detached)') {
    setBanner('你不在任何分支上（分离头指针），现在提交的记录可能丢失', '建新分支', () =>
      promptModal('从当前位置新建分支', '分支名', '', async (name) => {
        try {
          await git(['checkout', '-b', name]);
          toast(`已创建并切换到 ${name}`, 'success');
          refresh();
        } catch (e) { toast(fmtGitErr(e), 'error'); }
      }));
    return;
  }
  // 3) 合并进行中（暂无冲突文件）
  const mh = await git(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], { ignoreError: true });
  if (mh.code === 0) {
    setBanner('合并进行中：解决冲突并提交以完成合并', '去处理', () => switchTab('changes'));
    return;
  }
  // 4) 落后远端很多
  if (s.ab && s.ab.behind >= 20) {
    setBanner(`你已落后远端 ${s.ab.behind} 个提交，建议拉取`, '拉取', () => doPull());
    return;
  }
  setBanner(null); // 其余情况一律不出声
}

/* ============================================================
 * 分支对比（轻量版）：两个分支 → 差异文件清单 → 点文件看 diff
 * ============================================================ */
async function renderCompare() {
  const refs = [...state.branches.map((b) => b.name), ...state.remoteBranches];
  const aSel = $('#cmp-a');
  const bSel = $('#cmp-b');
  const sig = refs.join('|');
  if (aSel.dataset.sig !== sig) {
    aSel.dataset.sig = sig;
    bSel.dataset.sig = sig;
    const cur = state.currentBranch;
    const other = refs.find((r) => r !== cur) || refs[0]; // 默认选两个不同分支，避免 A==B
    for (const [sel, def] of [[aSel, cur || refs[0]], [bSel, other]]) {
      sel.innerHTML = '';
      for (const r of refs) {
        const o = document.createElement('option');
        o.value = r;
        o.textContent = r;
        sel.appendChild(o);
      }
      sel.value = refs.includes(def) ? def : (refs[0] || '');
    }
  }
  if (aSel.value && bSel.value) await loadCompareDiff();
}

async function loadCompareDiff() {
  const a = $('#cmp-a').value;
  const b = $('#cmp-b').value;
  if (!a || !b) return;
  const list = $('#compare-list');
  list.innerHTML = '<div class="empty-hint">对比中…</div>';
  // 头部显示实际对比的分支，避免看不出在比什么
  $('#cmp-file').textContent = `${a} ⇄ ${b}`;
  $('#cmp-diff-head').classList.remove('hidden');
  let files = [];
  try {
    // 两点直接 diff：比较两个分支的最终内容，交换方向结果一致，符合直觉
    const r = await git(['diff', '--name-status', '--find-renames', a, b]);
    files = r.out.split('\n').filter(Boolean).map((line) => {
      const tab = line.indexOf('\t');
      const status = line.slice(0, tab).charAt(0);
      let rest = line.slice(tab + 1);
      let orig = null;
      if (status === 'R' || status === 'C') {
        const t2 = rest.indexOf('\t');
        if (t2 >= 0) { orig = rest.slice(0, t2); rest = rest.slice(t2 + 1); }
      }
      return { path: rest, orig, status };
    });
  } catch (e) {
    list.innerHTML = '';
    list.appendChild(el('div', 'empty-hint', '对比失败：' + fmtGitErr(e)));
    return;
  }
  list.innerHTML = '';
  $('#cmp-diff-body').innerHTML = '<div class="placeholder">点左侧文件查看两个分支间的差异</div>';
  if (!files.length) {
    list.appendChild(el('div', 'empty-hint', '两个分支的最终内容完全一致 ✓'));
    return;
  }
  // 按目录分组
  const groups = new Map();
  for (const f of files) {
    const parts = f.path.split('/');
    const dir = parts.length > 1 ? parts.slice(0, -1).join('/') : '/';
    if (!groups.has(dir)) groups.set(dir, []);
    groups.get(dir).push(f);
  }
  for (const dir of [...groups.keys()].sort()) {
    list.appendChild(el('div', 'group-label', dir));
    for (const f of groups.get(dir)) {
      const sym = { A: '+', D: '−', M: '~', R: '→', C: '+', T: '~', U: '!' }[f.status] || f.status;
      const item = el('div', 'file-item');
      item.appendChild(el('span', 'file-status fs-' + (f.status === 'A' ? 'A' : f.status === 'D' ? 'D' : f.status === 'R' ? 'R' : 'M'), sym));
      item.appendChild(el('span', 'file-name', f.orig ? f.orig + ' → ' + f.path : f.path.split('/').pop()));
      item.title = f.path;
      item.addEventListener('click', () => viewCompareFile(a, b, f));
      list.appendChild(item);
    }
  }
}

async function viewCompareFile(a, b, f) {
  $('#cmp-diff-head').classList.remove('hidden');
  $('#cmp-file').textContent = (f.orig ? f.orig + ' → ' + f.path : f.path) + `  (${a} ⇄ ${b})`;
  const body = $('#cmp-diff-body');
  body.innerHTML = '<div class="placeholder">加载中…</div>';
  try {
    const r = await git(['diff', a, b, '--', f.orig || f.path]);
    body.innerHTML = '';
    if (!r.out.trim()) body.innerHTML = '<div class="placeholder">无差异</div>';
    else renderDiff(body, r.out);
  } catch (e) {
    body.innerHTML = '';
    body.appendChild(el('div', 'placeholder', '加载差异失败：' + fmtGitErr(e)));
  }
}

/* ============================================================
 * 自动 fetch（只读零风险；pull 永远手动）
 * ============================================================ */
async function autoFetch() {
  if (!state.repo) return;
  const gen = state.repoGen;
  try {
    // 独立进程执行，不占主命令队列：fetch 期间 UI 命令（点文件/勾选/提交）零阻塞
    const r = await window.gitmate.gitFetch(state.repo.path, 45000);
    if (gen !== state.repoGen) return; // fetch 期间切了仓库，结果作废
    if (r.code === 0) {
      lastFetchTime = Date.now();
      await refresh();
    }
  } catch { /* 静默失败，不打扰 */ }
}
setInterval(autoFetch, 5 * 60 * 1000);

/* ============================================================
 * 克隆远程仓库
 * ============================================================ */
function cloneModal() {
  showModal({
    title: '克隆远程仓库',
    html: `<input id="clone-url" class="modal-input" placeholder="仓库地址（https:// 开头或 git@ 开头）" />` +
          `<input id="clone-dest" class="modal-input" placeholder="目标文件夹（如 D:\\Projects\\blog）" />`,
    okText: '克隆',
    onOk: async () => {
      const url = $('#clone-url').value.trim();
      const dest = $('#clone-dest').value.trim();
      if (!url || !dest) { toast('请填写地址和目标文件夹', 'warn'); return; }
      toast('克隆中，请稍候…', 'info', 120000);
      const t0 = performance.now();
      const r = await window.gitmate.git(null, ['clone', url, dest], 300000);
      logCommand(['clone', url, dest], r, Math.round(performance.now() - t0));
      if (r.code === 0) {
        toast('克隆成功', 'success');
        openRepoPath(dest);
      } else {
        showModal({ title: '克隆失败', html: `<pre>${esc(r.err || r.out || '未知错误')}</pre>`, okText: '知道了' });
      }
    },
  });
  setTimeout(() => { const i = $('#clone-url'); if (i) i.focus(); }, 50);
}

/* ============================================================
 * 标签切换
 * ============================================================ */
async function switchTab(tab) {
  state.tab = tab;
  document.querySelectorAll('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + tab));
  if (!state.repo) return;
  if (tab === 'changes') await renderChanges();
  else if (tab === 'history') await renderHistory();
  else if (tab === 'branches') await renderBranches();
  else if (tab === 'compare') await renderCompare();
}

/* ============================================================
 * 事件绑定
 * ============================================================ */
function bindEvents() {
  // 导航
  document.querySelectorAll('.nav-btn').forEach((b) =>
    b.addEventListener('click', () => switchTab(b.dataset.tab)));

  // 打开仓库
  $('#open-repo-btn').addEventListener('click', pickAndOpenRepo);
  $('#welcome-open-btn').addEventListener('click', pickAndOpenRepo);

  // 顶栏操作
  $('#refresh-btn').addEventListener('click', refresh);
  $('#push-btn').addEventListener('click', doPush);
  $('#pull-btn').addEventListener('click', doPull);

  // 变更操作
  $('#check-all-btn').addEventListener('click', async () => {
    if (!state.status.files.length) return;
    try {
      await git(['add', '-A']);
      refresh();
    } catch (e) { toast(fmtGitErr(e), 'error'); }
  });
  $('#uncheck-all-btn').addEventListener('click', async () => {
    if (!state.status.files.length) return;
    try {
      await git(['restore', '--staged', '.']);
      refresh();
    } catch (e) { toast(fmtGitErr(e), 'error'); }
  });
  $('#discard-all-btn').addEventListener('click', discardAll);
  $('#commit-btn').addEventListener('click', doCommit);
  $('#commit-msg').addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key === 'Enter') doCommit();
  });

  // 分支
  $('#new-branch-btn').addEventListener('click', createBranch);
  $('#new-branch-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') createBranch(); });
  $('#branch-search').addEventListener('input', (e) => {
    state.branchFilter = e.target.value;
    if (state.tab === 'branches') renderBranches();
  });

  // 历史
  $('#history-search').addEventListener('input', (e) => {
    state.historyFilter = e.target.value;
    if (state.tab === 'history') renderHistory();
  });

  // 对比
  $('#cmp-go-btn').addEventListener('click', () => loadCompareDiff());
  $('#cmp-swap-btn').addEventListener('click', () => {
    const a = $('#cmp-a'), b = $('#cmp-b');
    [a.value, b.value] = [b.value, a.value];
    loadCompareDiff();
  });
  $('#cmp-a').addEventListener('change', () => loadCompareDiff());
  $('#cmp-b').addEventListener('change', () => loadCompareDiff());

  // 克隆
  $('#welcome-clone-btn').addEventListener('click', cloneModal);

  // 内嵌终端：手敲命令（Enter 执行、↑↓ 翻历史、clear 清屏）
  const termInput = $('#term-input');
  termInput.addEventListener('keydown', async (e) => {
    if (e.key === 'Enter') {
      const cmd = termInput.value.trim();
      termInput.value = '';
      if (!cmd) return;
      state.termHist.unshift(cmd);
      state.termHistIdx = -1;
      if (cmd === 'clear' || cmd === 'cls') { $('#term-out').innerHTML = ''; return; }
      termAddLine('❯ ' + cmd, 'tl-cmd-user');
      const r = await window.gitmate.termRun(state.repo ? state.repo.path : null, cmd, 300000);
      let outText = String(r.out || '').replace(/\n+$/, '');
      if (outText) {
        if (outText.length > 20000) outText = outText.slice(0, 20000) + '\n…（输出过长已截断）';
        termAddLine(outText, 'tl-out');
      }
      if (r.code !== 0) termAddLine(`✗ 退出码 ${r.code}${r.err ? '：' + r.err : ''}`, 'tl-err');
      refresh();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (state.termHistIdx < state.termHist.length - 1) {
        state.termHistIdx++;
        termInput.value = state.termHist[state.termHistIdx];
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (state.termHistIdx > 0) {
        state.termHistIdx--;
        termInput.value = state.termHist[state.termHistIdx];
      } else {
        state.termHistIdx = -1;
        termInput.value = '';
      }
    }
  });
  // 点击终端区域自动聚焦输入框（选中文字时不抢焦点）
  $('#cmd-log').addEventListener('click', (e) => {
    if (!String(window.getSelection())) termInput.focus();
  });

  // 命令与日志栏：展开时显示分割线（拖动=日志变高、上方内容上挤），收起时隐藏
  $('#cmdbar-toggle').addEventListener('click', () => {
    const log = $('#cmd-log');
    log.classList.toggle('hidden');
    $('#vs-cmdbar').classList.toggle('hidden', log.classList.contains('hidden'));
    $('#cmdbar-toggle').textContent = log.classList.contains('hidden') ? '▾ 命令与日志' : '▴ 命令与日志';
  });

  // 模态框（按钮组动态生成）；点背景关闭
  $('#modal-wrap').addEventListener('click', (e) => { if (e.target === $('#modal-wrap')) hideModal(); });

  // 贮藏徽章
  $('#stash-badge').addEventListener('click', stashModal);

  // 全局
  document.addEventListener('click', () => hideCtxMenu());
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { hideModal(); hideCtxMenu(); }
    if (e.key === 'F5') { e.preventDefault(); refresh(); }
  });
  window.addEventListener('unhandledrejection', (e) => {
    toast(fmtGitErr(e.reason), 'error');
  });
}

/* ============================================================
 * 启动
 * ============================================================ */
/* ---------- 可拖动分割线（横向/纵向通用，尺寸记忆到 localStorage） ---------- */
function applyPaneSize(pane, size, axis) {
  if (axis === 'x') {
    pane.style.width = size + 'px';
  } else {
    pane.style.height = size + 'px';
    pane.style.flex = 'none'; // 纵向面板原先用 flex 比例分配，改为固定高度后锁定
  }
}
function attachDrag(handle, pane, key, min, max, axis, invert) {
  const saved = parseInt(localStorage.getItem(key), 10);
  if (saved >= min && saved <= max) applyPaneSize(pane, saved, axis);
  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const start = axis === 'x' ? e.clientX : e.clientY;
    const rect = pane.getBoundingClientRect();
    const startSize = axis === 'x' ? rect.width : rect.height;
    handle.classList.add('dragging');
    document.body.style.cursor = axis === 'x' ? 'col-resize' : 'row-resize';
    const move = (ev) => {
      const delta = (axis === 'x' ? ev.clientX : ev.clientY) - start;
      const size = invert ? startSize - delta : startSize + delta;
      applyPaneSize(pane, Math.min(Math.max(size, min), max), axis);
    };
    const up = () => {
      handle.classList.remove('dragging');
      document.body.style.cursor = '';
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      localStorage.setItem(key, String(Math.round(axis === 'x' ? pane.getBoundingClientRect().width : pane.getBoundingClientRect().height)));
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });
}
function initSplitters() {
  // [手柄, 面板, 存储键, 最小, 最大, 轴向, 是否反向]
  // 右侧 diff 面板不设下限：列表可以自由拉到任意宽（泳道多时不被遮住）
  const defs = [
    ['#vs-sidebar', '#sidebar', 'gm.split.sidebar', 150, 420, 'x', false],
    ['#vs-changes', '#view-changes .changes-col', 'gm.split.changes', 220, 1600, 'x', false],
    ['#vs-history', '#view-history .hist-col', 'gm.split.history', 220, 2000, 'x', false],
    ['#vs-compare', '#view-compare .compare-col', 'gm.split.compare', 220, 1600, 'x', false],
    ['#hs-zones', '#view-changes .changes-zone', 'gm.split.zones', 120, 620, 'y', false],
    ['#vs-commitbar', '#commit-bar', 'gm.split.commitbar', 56, 320, 'y', true],   // 提交条上边缘：向上拉变高
    ['#vs-cmdbar', '#cmd-log', 'gm.split.cmdlog', 60, 520, 'y', true],   // 命令日志展开后：向上拉变高，把上方内容往上挤
  ];
  for (const [handleSel, paneSel, key, min, max, axis, invert] of defs) {
    const handle = $(handleSel);
    const pane = $(paneSel);
    if (!handle || !pane) continue;
    attachDrag(handle, pane, key, min, max, axis, invert);
  }
}

function init() {
  loadRepos();
  bindEvents();
  initSplitters();
  renderCmdBar();
  const last = state.repos[0];
  if (last) openRepoPath(last.path).catch(() => showWelcome());
  else showWelcome();
}

init();
