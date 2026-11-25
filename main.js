// ============================================================
// GitMate — 主进程
// 职责：创建窗口、提供 IPC（选目录 / 校验仓库 / 执行 git 命令）
// 设计原则：主进程保持"薄"，逻辑解析放在渲染进程，方便扩展
// ============================================================
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1000,
    minHeight: 640,
    backgroundColor: '#0e1016',
    icon: path.join(__dirname, 'build', 'icon.ico'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  // 渲染进程报错转发到主进程日志（排查界面无响应）
  win.webContents.on('console-message', (e, level, message, line, sourceId) => {
    if (level >= 2) console.error(`[renderer:${level}] ${message} (${path.basename(String(sourceId))}:${line})`);
  });
  win.webContents.on('render-process-gone', (e, details) => {
    console.error('[renderer-gone]', JSON.stringify(details));
  });
}

// ---------- 通用 git 命令执行器 ----------
function runGit(repo, args, timeout = 20000) {
  return new Promise((resolve) => {
    const child = spawn('git', args, {
      cwd: repo || undefined,
      env: { ...process.env, GIT_PAGER: 'cat', PAGER: 'cat', GIT_OPTIONAL_LOCKS: '0' },
      windowsHide: true,
    });
    let out = '';
    let err = '';
    let done = false;

    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        child.kill();
        resolve({ code: -1, out, err: err || '命令执行超时' });
      }
    }, timeout);

    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => {
      if (!done) { done = true; clearTimeout(timer); resolve({ code: -1, out, err: String(e) }); }
    });
    child.on('close', (code) => {
      if (!done) { done = true; clearTimeout(timer); resolve({ code, out, err }); }
    });
  });
}

// ---------- 内嵌终端：持久 Git Bash 会话 ----------
function findBashExe() {
  const candidates = [
    'D:\\git\\Git\\bin\\bash.exe',   // 本机 Git Bash 安装位置
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Git', 'bin', 'bash.exe'),
  ];
  for (const c of candidates) { try { if (fs.existsSync(c)) return c; } catch {} }
  return null;
}

let bashProc = null;   // 当前持久会话
let bashRepo = null;   // 会话对应的仓库目录（变更则重启会话）
const pendingBashResolvers = new Set(); // 在途命令的完成函数，会话重启时立即放行

function ensureBash(repoPath) {
  if (bashProc && bashRepo === repoPath) return bashProc;
  if (bashProc) {
    // 会话重启（切仓库/超时）：被卡住的在途命令立刻失败返回，不让队列阻塞半分钟
    for (const finish of pendingBashResolvers) {
      finish({ code: -1, out: '', err: '仓库已切换，命令已中止' });
    }
    pendingBashResolvers.clear();
    try { bashProc.kill(); } catch {}
    bashProc = null;
  }
  const exe = findBashExe();
  if (!exe) return null;
  bashProc = spawn(exe, ['--noprofile', '--norc'], {
    cwd: repoPath || os.homedir(),
    env: { ...process.env, TERM: 'dumb', GIT_PAGER: 'cat', PAGER: 'cat' },
    windowsHide: true,
  });
  bashProc.stdin.setDefaultEncoding('utf8');
  bashProc.stdout.setEncoding('utf8');
  bashProc.stderr.setEncoding('utf8');
  bashProc.stderr.on('data', () => {}); // 已 exec 2>&1 合流，兜底防缓冲堆积
  bashProc.on('exit', () => { bashProc = null; });
  bashRepo = repoPath;
  bashProc.stdin.write('exec 2>&1\n'); // stderr 合流到 stdout，输出顺序与真终端一致
  return bashProc;
}

let bashQueue = Promise.resolve(); // 命令串行执行，输出不会串行

// 在持久会话里执行一行命令，用标记抓输出与退出码
function runInBash(repoPath, cmdline, timeout = 30000) {
  return new Promise((resolve) => {
    const proc = ensureBash(repoPath);
    if (!proc) { resolve({ code: -2, out: '', err: '未找到 Git Bash（bash.exe）' }); return; }
    let buf = '';
    let done = false;
    let timer = null;
    const finish = (val) => {
      if (done) return;
      done = true;
      pendingBashResolvers.delete(finish);
      if (timer) clearTimeout(timer);
      try { proc.stdout.removeListener('data', onData); } catch {}
      resolve(val);
    };
    pendingBashResolvers.add(finish);
    const onData = (d) => {
      buf += d;
      const m = buf.match(/\x01(-?\d+)\x02/);
      if (m) {
        finish({ code: parseInt(m[1], 10), out: buf.slice(0, m.index), err: '' });
      }
    };
    proc.stdout.on('data', onData);
    timer = setTimeout(() => {
      try { proc.kill(); } catch {}
      bashProc = null; // 超时后会话可能被卡住的命令污染，重启
      finish({ code: -1, out: buf, err: '命令超时' });
    }, timeout);
    proc.stdin.write(cmdline + "\nprintf '\\x01%d\\x02\\n' $?\n");
  });
}

function enqueueBash(repoPath, cmdline, timeout) {
  const task = () => runInBash(repoPath, cmdline, timeout);
  const p = bashQueue.then(task, task);
  bashQueue = p.then(() => {}, () => {});
  return p;
}

function shellQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

// ---------- IPC ----------
ipcMain.handle('pick-folder', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: '选择 Git 仓库文件夹',
    properties: ['openDirectory'],
  });
  if (r.canceled || !r.filePaths.length) return null;
  return r.filePaths[0];
});

ipcMain.handle('open-repo', async (_e, p) => {
  try {
    if (!p || !fs.existsSync(p)) return { ok: false, error: '路径不存在' };
    if (!fs.existsSync(path.join(p, '.git'))) {
      return { ok: false, error: '该文件夹不是 Git 仓库（未找到 .git）' };
    }
    return { ok: true, path: p, name: path.basename(p) };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
});

// 通用 git 通道：走内嵌 bash 会话执行（GUI 操作实时展示在终端），无 bash 时退回直接 spawn
ipcMain.handle('git', async (_e, { repo, args, timeout }) => {
  if (!Array.isArray(args)) return { code: -1, out: '', err: 'args 必须是数组' };
  if (findBashExe()) {
    const cmdline = 'git ' + args.map(shellQuote).join(' ');
    const r = await enqueueBash(repo, cmdline, timeout || 30000);
    return { code: r.code, out: r.out, err: r.code === 0 ? '' : (r.out.trim() || r.err || '命令失败') };
  }
  return runGit(repo, args, timeout);
});

// 内嵌终端：用户手敲命令（与 GUI 命令同一条会话、同一个队列）
ipcMain.handle('term-run', (_e, { repo, cmdline, timeout }) => {
  if (typeof cmdline !== 'string' || !cmdline.trim()) {
    return Promise.resolve({ code: -2, out: '', err: '空命令' });
  }
  return enqueueBash(repo, cmdline, timeout || 60000);
});

// 把文件复制到系统剪贴板（可在资源管理器/聊天窗口粘贴）
ipcMain.handle('copy-file', (_e, absPath) => {
  try {
    spawn('powershell.exe', ['-NoProfile', '-Command', `Set-Clipboard -Path "${absPath}"`], {
      windowsHide: true, timeout: 10000,
    }).on('close', (code) => { if (code !== 0) console.error('copy-file 失败 code=' + code); });
    return { ok: true };
  } catch (e) { return { ok: false, error: String(e) };
  }
});

// 在外部终端打开仓库目录（新开 cmd 窗口）
ipcMain.handle('open-terminal', (_e, repoPath) => {
  try {
    const child = spawn('cmd.exe', ['/c', 'start', 'cmd', '/K', `cd /d "${repoPath}"`], {
      cwd: repoPath, detached: true, stdio: 'ignore', windowsHide: false,
    });
    child.unref();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
});

// 自动 fetch 分流：独立一次性 git 进程执行，不占主命令队列。
// fetch 只读零风险，可并发于所有 UI 操作；全局互斥：同一时刻最多一个。
// （pull 会改工作区，留在主队列串行 + 守卫，不走这里）
let fetchBusy = false;
ipcMain.handle('git-fetch', async (_e, { repo, timeout }) => {
  if (fetchBusy) return { code: -2, out: '', err: '已有 fetch 进行中' };
  fetchBusy = true;
  try {
    return await runGit(repo, ['fetch', '--all', '--quiet'], timeout || 45000);
  } finally {
    fetchBusy = false;
  }
});

// 在资源管理器中显示文件
ipcMain.handle('show-in-folder', (_e, p) => {
  if (p && fs.existsSync(p)) shell.showItemInFolder(p);
});

// 把路径追加到 .gitignore（已存在则跳过）
ipcMain.handle('append-ignore', (_e, { repo, entry }) => {
  try {
    if (!repo || !entry) return { ok: false };
    const file = path.join(repo, '.gitignore');
    let content = '';
    if (fs.existsSync(file)) content = fs.readFileSync(file, 'utf8');
    const lines = content.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (lines.includes(entry)) return { ok: true, skipped: true };
    const sep = content && !content.endsWith('\n') ? '\n' : '';
    fs.writeFileSync(file, content + sep + entry + '\n', 'utf8');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
});

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
