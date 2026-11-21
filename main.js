// ============================================================
// GitMate — 主进程
// 职责：创建窗口、提供 IPC（选目录 / 校验仓库 / 执行 git 命令）
// 设计原则：主进程保持"薄"，逻辑解析放在渲染进程，方便扩展
// ============================================================
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
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

// 通用 git 通道：渲染进程自己拼参数、自己解析输出
ipcMain.handle('git', (_e, { repo, args, timeout }) => {
  if (!Array.isArray(args)) return { code: -1, out: '', err: 'args 必须是数组' };
  return runGit(repo, args, timeout);
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
