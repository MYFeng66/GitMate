# GitMate

一个现代化、简单易用的 Git 桌面客户端。基于 Electron + 原生 HTML/CSS/JS，**无框架、无构建步骤**，容易看懂、容易扩展。

## ✨ 功能

- **变更页**：勾选即暂存的双区域（未暂存/已暂存），提交条全局固定；暂存/取消暂存/丢弃，支持部分文件提交
- **泳道图历史**：自算布局的提交泳道图（不依赖 `--graph`），贝塞尔曲线过渡、泳道色终身稳定、分支/HEAD 徽标；右键提交可 revert / reset / checkout 回到任意版本
- **分支页**：右键分支弹出操作菜单（切换 / 从此分支建立新分支 / 合并到当前 / 删除），显示上游与领先/落后状态；分支对比页（任意两分支两点 diff）
- **切分支守卫**：有未提交改动时四个选项——带着切换 / 提交后切换 / 贮藏(stash)后切换 / 取消；顶栏 📦 贮藏徽章可查看和恢复
- **内嵌终端**：Git Bash 真终端，GUI 操作的命令实时写入终端，底部 `❯` 可手敲任意命令（↑↓ 历史、clear 清屏）
- **命令日志**：展开可查看每条 GUI 操作对应的完整 git 命令及耗时
- **仓库管理**：侧栏多仓库切换（右键：打开 / 资源管理器 / 外部终端 / 复制路径 / 从列表移除）；克隆仓库；最近仓库记忆
- **自动化**：每 5 分钟后台自动 fetch（独立进程不占命令队列）；Git 报错自动翻译成中文
- **主题**：⚙ 设置 → 个性化，深色/浅色即时切换并持久化，终端配色跟随主题
- **实用细节**：右键文件加入 `.gitignore` / 在资源管理器中显示；所有破坏性操作均有确认弹窗

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
├── main.js          # Electron 主进程：窗口 + IPC（git / 选目录 / 终端 / fetch / .gitignore）
├── preload.js       # contextBridge 安全桥接
├── GitMate.bat      # 一键启动（脱离终端窗口）
├── package.json
├── scripts/         # 辅助脚本（图标生成、泳道图效果稿渲染）
├── 设计稿/          # 泳道图效果稿（SVG 渲染截图）
└── renderer/
    ├── index.html   # 页面结构（导航 / 顶栏 / 变更·历史·分支·对比 / 终端 / 欢迎页）
    ├── style.css    # 深色/浅色双主题（CSS 变量驱动）
    └── app.js       # 全部业务逻辑（状态、git 调用、泳道布局、渲染、事件）
```

## 🧩 如何扩展

- **加一个 git 操作**：在 `app.js` 里调 `git(['命令', '参数'])` 即可，主进程不用改
- **加一个视图**：`index.html` 加 `<section id="view-xxx" class="view">`，`app.js` 的 `switchTab` 加一个分支，`renderXxx()` 里渲染
- **加一个主进程能力**（如文件系统操作）：`main.js` 加 `ipcMain.handle`，`preload.js` 暴露同名方法
- 状态集中在 `state` 对象；所有 git 解析都是纯函数（`parseStatus` / `parseRefs`），方便单测

## ⚠️ 注意

- 「丢弃更改」「删除分支」「reset --hard」等破坏性操作都有确认弹窗，但仍请谨慎
- 泳道图基于提交窗口（最近 300 条）自算布局，极端乱的多人多分支历史与 IDEA 的泳道分配存在少量差异
- 桌面快捷方式指向 `GitMate.bat`，以开发模式运行（`npx electron .`），不打包 exe
