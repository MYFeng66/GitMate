// ============================================================
// GitMate — 预加载脚本
// 通过 contextBridge 把安全的 IPC 接口暴露给渲染进程
// ============================================================
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('gitmate', {
  // 打开目录选择对话框，返回选中路径或 null
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
  // 校验一个路径是否是 Git 仓库
  openRepo: (p) => ipcRenderer.invoke('open-repo', p),
  // 执行 git 命令：git(repo, ['status', ...], timeoutMs) => { code, out, err }
  git: (repo, args, timeout) => ipcRenderer.invoke('git', { repo, args, timeout }),
  // 在资源管理器中显示
  showInFolder: (p) => ipcRenderer.invoke('show-in-folder', p),
  // 追加到 .gitignore
  appendIgnore: (repo, entry) => ipcRenderer.invoke('append-ignore', { repo, entry }),
  // 内嵌终端：在持久 bash 会话里执行用户手敲的命令
  termRun: (repo, cmdline, timeout) => ipcRenderer.invoke('term-run', { repo, cmdline, timeout }),
  // 自动 fetch：独立进程执行，不占主命令队列
  gitFetch: (repo, timeout) => ipcRenderer.invoke('git-fetch', { repo, timeout }),
  // 在外部终端打开目录
  openTerminal: (repoPath) => ipcRenderer.invoke('open-terminal', repoPath),
  // 复制文件到系统剪贴板
  copyFile: (absPath) => ipcRenderer.invoke('copy-file', absPath),
  // .gitignore 读取（content 不传） / 保存（content 传入）
  ignoreFile: (repo, content) => ipcRenderer.invoke('ignore-file', { repo, content }),
});
