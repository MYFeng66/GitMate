# GitMate

一个现代化、简单易用的 Git 桌面客户端。基于 Electron + 原生 HTML/CSS/JS，**无框架、无构建步骤**，容易看懂、容易扩展。

## ✨ 功能

- **变更页**：查看/暂存/取消暂存/丢弃文件更改，一键全部暂存，填写提交信息一键提交（支持 Ctrl+Enter）
- **差异视图**：文件级 diff，增删行高亮；点击提交历史也能看任意提交的变更
- **历史页**：最近 300 条提交，分支/HEAD 徽标，点开看单次提交的文件列表和差异
- **分支页**：新建、切换、合并、删除本地分支，显示上游与领先/落后状态
- **推送/拉取**：一键 push / pull，无上游时自动引导设置；冲突时给出清晰提示
- **实用细节**：右键文件可加入 `.gitignore` / 在资源管理器中显示；最近仓库记忆；Toast + 模态框交互；现代化暗色主题

## 🚀 运行

```bash
cd D:\GitMate
npm install
npm start
```

> 国内网络下载 Electron 慢的话：
> ```powershell
> $env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
> npm install
> ```

## 📁 项目结构

```
GitMate/
├── main.js          # Electron 主进程：窗口 + IPC（选目录、执行 git、.gitignore 写入）
├── preload.js       # contextBridge 安全桥接
├── package.json
└── renderer/
    ├── index.html   # 页面结构（导航 / 顶栏 / 三个视图 / 欢迎页）
    ├── style.css    # 现代暗色主题
    └── app.js       # 全部业务逻辑（状态、git 调用、渲染、事件）
```

## 🧩 如何扩展

- **加一个 git 操作**：在 `app.js` 里调 `git(['命令', '参数'])` 即可，主进程不用改
- **加一个视图**：`index.html` 加 `<section id="view-xxx" class="view">`，`app.js` 的 `switchTab` 加一个分支，`renderXxx()` 里渲染
- **加一个主进程能力**（如文件系统操作）：`main.js` 加 `ipcMain.handle`，`preload.js` 暴露同名方法
- 状态集中在 `state` 对象；所有 git 解析都是纯函数（`parseStatus` / `parseRefs`），方便单测

## ⚠️ 注意

- 「丢弃更改」「删除分支」等破坏性操作都有确认弹窗，但仍请谨慎
- 图形化提交图谱（--graph）暂未实现，历史以列表呈现
