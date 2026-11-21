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
  selectedCommit: null, // 选中的提交 hash
  selectedCdFile: null, // 历史详情中选中的文件
  branches: [],
  currentBranch: '',
};

const MAX_LOG = 300;

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
function fmtGitErr(err) {
  return String(err && err.message ? err.message : err)
    .replace(/^error:\s?/gim, '')
    .replace(/fatal:\s?/i, '')
    .trim() || '未知错误';
}

/* ---------- 通用 git 调用 ---------- */
async function git(args, opts = {}) {
  if (!state.repo) throw new Error('未打开仓库');
  const r = await window.gitmate.git(state.repo.path, args, opts.timeout || 20000);
  if (r.code !== 0 && !opts.ignoreError) {
    const e = new Error(r.err || r.out || '命令失败');
    e.raw = r;
    throw e;
  }
  return r;
}

/* ---------- 模态框 ---------- */
let modalCb = null;
function showModal({ title, html, okText = '确定', danger = false, onOk }) {
  $('#modal-title').textContent = title;
  $('#modal-body').innerHTML = html;
  $('#modal-ok').textContent = okText;
  $('#modal-ok').className = danger ? 'btn-danger' : 'btn-primary';
  modalCb = onOk || null;
  $('#modal-wrap').classList.remove('hidden');
}
function hideModal() {
  $('#modal-wrap').classList.add('hidden');
  modalCb = null;
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
  $('#repo-name').textContent = state.repo.name;
  $('#repo-path').textContent = state.repo.path;
  $('#repo-mini').classList.remove('hidden');
  $('#repo-mini .repo-mini-name').textContent = state.repo.name;
  renderRecentRepos();
  refresh();
}

function showWelcome() {
  $('#welcome').classList.add('show');
  $('#repo-name').textContent = '未打开仓库';
  $('#repo-path').textContent = '';
  renderRecentRepos();
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
function parseStatus(text) {
  const res = { branch: '', upstream: '', ab: null, unstaged: [], staged: [] };
  const pushEntry = (list, entry) => {
    if (list.length && list[list.length - 1].path > entry.path) list.push(entry);
    else list.push(entry);
  };

  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (!line) continue;

    if (line.startsWith('# branch.head ')) res.branch = line.slice(14).trim();
    else if (line.startsWith('# branch.upstream ')) res.upstream = line.slice(18).trim();
    else if (line.startsWith('# branch.ab ')) {
      const m = line.match(/\+(\d+) -(\d+)/);
      if (m) res.ab = { ahead: +m[1], behind: +m[2] };
    } else if (line.startsWith('? ')) {
      pushEntry(res.unstaged, { path: line.slice(2), origPath: null, x: '?', y: '?', untracked: true });
    } else if (line.startsWith('u ')) {
      const f = line.slice(2).split(' ');
      const p = f.slice(10).join(' ');
      const entry = { path: p, origPath: null, x: 'U', y: 'U', conflict: true };
      pushEntry(res.unstaged, entry);
      pushEntry(res.staged, entry);
    } else if (line.startsWith('1 ') || line.startsWith('2 ')) {
      const xy = line.slice(2, 4);
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
      const entry = { path, origPath, x: xy[0], y: xy[1], untracked: false };
      if (entry.x !== ' ' && entry.x !== '?') pushEntry(res.staged, entry);
      if (entry.y !== ' ' && entry.y !== '?') pushEntry(res.unstaged, entry);
    }
  }
  return res;
}

const STATUS_LABEL = { M: '修改', A: '新增', D: '删除', U: '冲突', R: '重命名', C: '复制', T: '类型', '?': '未跟踪' };

/* ============================================================
 * 刷新主流程
 * ============================================================ */
let refreshing = false;
async function refresh() {
  if (!state.repo || refreshing) return;
  refreshing = true;
  try {
    const r = await git(['status', '--porcelain=v2', '-b']);
    state.status = parseStatus(r.out);
    state.currentBranch = state.status.branch;
    updateTopbar();
    if (state.tab === 'changes') await renderChanges();
    else if (state.tab === 'history') await renderHistory();
    else if (state.tab === 'branches') await renderBranches();
  } catch (e) {
    toast(fmtGitErr(e), 'error');
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
  const cnt = state.status.unstaged.length + state.status.staged.length;
  const badge = $('#chg-count');
  if (cnt > 0) { badge.textContent = cnt; badge.classList.remove('hidden'); }
  else badge.classList.add('hidden');
}

/* ============================================================
 * 变更视图
 * ============================================================ */
async function renderChanges() {
  const s = state.status;
  renderFileList($('#unstaged-list'), s.unstaged, 'unstaged');
  renderFileList($('#staged-list'), s.staged, 'staged');
  const n = s.staged.length;
  $('#commit-hint').textContent = n ? `已暂存 ${n} 个文件，将提交到 ${state.currentBranch || '当前分支'}` : '暂存文件后才能提交';
  $('#commit-btn').disabled = !n;

  // 保持选中文件的高亮 + 差异面板
  if (state.selectedFile) {
    const all = [...s.unstaged, ...s.staged];
    const still = all.find((f) => f.path === state.selectedFile.path && f.area === undefined);
    const found = all.find((f) => f.path === state.selectedFile.path);
    if (!found) {
      state.selectedFile = null;
      $('#diff-head').classList.add('hidden');
      $('#diff-body').innerHTML = '<div class="placeholder">选择左侧文件查看差异</div>';
    }
  }
  highlightSelection();
  if (state.selectedFile) await loadFileDiff();
}

function renderFileList(container, files, area) {
  container.innerHTML = '';
  if (!files.length) {
    container.appendChild(el('div', 'empty-hint', area === 'unstaged' ? '工作区很干净 ✓' : '暂无暂存内容'));
    return;
  }
  for (const f of files) {
    const letter = f.untracked ? '?' : (area === 'staged' ? f.x : f.y);
    const item = el('div', 'file-item');
    item.dataset.path = f.path;
    item.dataset.area = area;

    const badge = el('span', 'file-status fs-' + letter, letter);
    const name = el('span', 'file-name', f.origPath ? f.origPath + ' → ' + f.path : f.path.split('/').pop());
    const dir = el('span', 'file-dir', f.path.split('/').slice(0, -1).join('/'));
    const actions = el('span', 'file-actions');

    if (area === 'unstaged') {
      const stageBtn = el('button', 'fa-btn', '+ 暂存');
      stageBtn.addEventListener('click', (e) => { e.stopPropagation(); stageFile(f, area); });
      actions.appendChild(stageBtn);
      const disBtn = el('button', 'fa-btn danger', '✕ 丢弃');
      disBtn.addEventListener('click', (e) => { e.stopPropagation(); discardFile(f); });
      actions.appendChild(disBtn);
    } else {
      const unBtn = el('button', 'fa-btn', '− 取消');
      unBtn.addEventListener('click', (e) => { e.stopPropagation(); stageFile(f, area); });
      actions.appendChild(unBtn);
    }

    item.appendChild(badge);
    item.appendChild(name);
    if (dir.textContent) item.appendChild(dir);
    item.appendChild(actions);
    item.title = f.path;

    item.addEventListener('click', () => {
      state.selectedFile = { path: f.path, area };
      highlightSelection();
      loadFileDiff();
    });
    item.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showCtxMenu(e.clientX, e.clientY, fileCtxItems(f, area));
    });
    container.appendChild(item);
  }
}

function fileCtxItems(f, area) {
  const items = [];
  if (area === 'unstaged') {
    items.push({ label: '+ 暂存此文件', action: () => stageFile(f, area) });
    items.push({ label: '✕ 丢弃更改…', danger: true, action: () => discardFile(f) });
  } else {
    items.push({ label: '− 取消暂存', action: () => stageFile(f, area) });
  }
  items.push({ label: '添加到 .gitignore', action: () => addToIgnore(f) });
  items.push({ label: '在资源管理器中显示', action: () => window.gitmate.showInFolder(state.repo.path + '/' + f.path.replace(/\//g, '/')) });
  return items;
}

async function stageFile(f, area) {
  try {
    if (area === 'unstaged') {
      await git(f.untracked ? ['add', '--', f.path] : ['add', '--', f.path]);
    } else {
      await git(['restore', '--staged', '--', f.path]);
    }
    await refresh();
  } catch (e) { toast(fmtGitErr(e), 'error'); }
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
  if (!s.unstaged.length) return;
  const tracked = s.unstaged.filter((f) => !f.untracked).map((f) => f.path);
  const untracked = s.unstaged.filter((f) => f.untracked).map((f) => f.path);
  confirmModal('丢弃全部更改', `将丢弃 ${s.unstaged.length} 个文件的未暂存修改（${tracked.length} 个已跟踪 + ${untracked.length} 个未跟踪），无法撤销。确定继续？`, async () => {
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
  document.querySelectorAll('.file-item').forEach((d) => {
    d.classList.toggle('selected',
      state.selectedFile && d.dataset.path === state.selectedFile.path &&
      d.dataset.area === state.selectedFile.area);
  });
}

/* ---------- 文件差异 ---------- */
async function loadFileDiff() {
  const f = state.selectedFile;
  if (!f) return;
  $('#diff-head').classList.remove('hidden');
  $('#diff-file').textContent = f.path;
  $('#diff-area').textContent = f.area === 'staged' ? '已暂存' : '未暂存';
  const body = $('#diff-body');
  body.innerHTML = '<div class="placeholder">加载中…</div>';
  try {
    let r;
    if (f.area === 'staged') {
      r = await git(['diff', '--cached', '--', f.path]);
    } else {
      r = await git(['diff', '--', f.path]);
    }
    body.innerHTML = '';
    if (!r.out.trim()) {
      const s = state.status;
      const fu = s ? s.unstaged.find((x) => x.path === f.path) : null;
      body.innerHTML = fu && fu.untracked
        ? '<div class="placeholder">这是新文件（未跟踪），暂存后即可看到全部内容差异</div>'
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
  if (!state.status.staged.length) { toast('没有已暂存的文件', 'warn'); return; }
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

async function renderHistory() {
  const list = $('#commit-list');
  try {
    const r = await git([
      'log', `--max-count=${MAX_LOG}`, '--date=iso',
      '--pretty=format:%H%x1f%h%x1f%an%x1f%ad%x1f%s%x1f%d%x1e',
    ]);
    const records = r.out.split('\x1e').map((s) => s.replace(/^\n/, '')).filter((s) => s.trim());
    state.commits = records.map((rec) => {
      const [hash, short, author, date, subject, deco] = rec.split('\x1f');
      return { hash, short, author, date, subject: subject || '', refs: parseRefs(deco) };
    });
    list.innerHTML = '';
    if (!state.commits.length) {
      list.appendChild(el('div', 'empty-hint', '暂无提交记录'));
      return;
    }
    for (const c of state.commits) {
      const item = el('div', 'commit-item' + (state.selectedCommit === c.hash ? ' selected' : ''));
      const refs = c.refs.filter((x) => x !== 'HEAD' && !x.startsWith('HEAD ->'));
      if (refs.length || c.refs.some((x) => x.startsWith('HEAD'))) {
        const refBox = el('div', 'ci-refs');
        for (const rf of c.refs) {
          const isHead = rf.startsWith('HEAD');
          const name = isHead ? rf.replace(/^HEAD -> /, '') : rf;
          refBox.appendChild(el('span', 'ref-badge' + (isHead ? ' head' : ''), isHead ? 'HEAD · ' + name : name));
        }
        item.appendChild(refBox);
      }
      item.appendChild(el('div', 'ci-subject', c.subject));
      const meta = el('div', 'ci-meta');
      meta.appendChild(el('span', 'ci-hash', c.short));
      meta.appendChild(el('span', '', c.author));
      meta.appendChild(el('span', '', relTime(c.date)));
      item.appendChild(meta);
      item.addEventListener('click', () => selectCommit(c.hash));
      list.appendChild(item);
    }
    if (state.selectedCommit) await renderCommitDetail();
  } catch (e) {
    if (/does not have any commits yet|unknown revision/i.test(String(e))) {
      list.innerHTML = '';
      list.appendChild(el('div', 'empty-hint', '仓库还没有任何提交'));
    } else {
      toast(fmtGitErr(e), 'error');
    }
  }
}

async function selectCommit(hash) {
  state.selectedCommit = hash;
  state.selectedCdFile = null;
  document.querySelectorAll('.commit-item').forEach((d) => d.classList.remove('selected'));
  const items = document.querySelectorAll('.commit-item');
  const idx = state.commits.findIndex((c) => c.hash === hash);
  if (items[idx]) items[idx].classList.add('selected');
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
    const r = await git(['branch', '--list', '--format=%(HEAD)%09%(refname:short)%09%(upstream:short)%09%(upstream:track,upstream:remotename)']);
    state.branches = r.out.split('\n').filter(Boolean).map((line) => {
      const f = line.split('\t');
      return { current: f[0] === '*', name: f[1] || '', upstream: f[2] || '', track: f[3] || '' };
    });
    list.innerHTML = '';
    for (const b of state.branches) {
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
    if (!state.branches.length) list.appendChild(el('div', 'empty-hint', '暂无本地分支'));
  } catch (e) {
    list.innerHTML = '';
    list.appendChild(el('div', 'empty-hint', '加载失败：' + fmtGitErr(e)));
  }
}

async function switchBranch(name) {
  try {
    await git(['checkout', name]);
    toast(`已切换到 ${name}`, 'success');
    refresh();
  } catch (e) { toast(fmtGitErr(e), 'error'); }
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
  $('#stage-all-btn').addEventListener('click', async () => {
    if (!state.status.unstaged.length) return;
    try {
      await git(['add', '-A']);
      refresh();
    } catch (e) { toast(fmtGitErr(e), 'error'); }
  });
  $('#unstage-all-btn').addEventListener('click', async () => {
    if (!state.status.staged.length) return;
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

  // 模态框
  $('#modal-cancel').addEventListener('click', hideModal);
  $('#modal-ok').addEventListener('click', () => { const cb = modalCb; hideModal(); if (cb) cb(); });

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
function init() {
  loadRepos();
  bindEvents();
  const last = state.repos[0];
  if (last) openRepoPath(last.path).catch(() => showWelcome());
  else showWelcome();
}

init();
