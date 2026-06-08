# OpsLab

本地运维控制台。在浏览器里管理常用命令、对接 SSH/Docker/K8s、用 AI 帮你写命令。

```
Browser (React + xterm.js)
   ↕  HTTP + WebSocket
Node Local Server (Express + Socket.IO)
   ├── Executors (spawn / ssh2)
   ├── AI Adapters (Claude / OpenAI / Ollama)
   ├── SQLite (commands / connections / history)
   └── AES-256-GCM 加密本地文件 (API key, SSH 密码)
```

只监听 `127.0.0.1`，启动时生成一次性 access token，浏览器从 URL 中读取。

## 功能

- 命令模板：`{{var}}` 占位符，自动生成填充表单
- **命令 or 脚本**：单条命令走系统 shell；选择 bash/python/node/powershell/ruby/perl 等解释器即可直接写多行脚本（Monaco 编辑器自动切语言高亮、变大；支持从 .sh/.py/.ps1 文件导入）
- 实时输出：xterm.js 渲染 ANSI 颜色
- 多目标：本地 PowerShell/Bash、SSH 远程、Docker、K8s 模板
- **交互式 Shell（Web Terminal）**：左侧 `⌨ Shell` 进真·PTY 终端，可跑 `vim` / `top` / `ssh` 等交互程序，支持窗口大小自适应、多标签、本地 + SSH 远程。本地用 node-pty（可选原生模块），远程用 SSH shell 通道
- **一次执行多条命令**，三种姿势：
  - 单条命令里的 shell 串联：`cmd1 && cmd2 ; cmd3 | grep ...`
  - **多标签终端**：终端页顶部 `+` 开新会话，每个 tab 独立执行不同命令
  - **Fan-out**：同一条命令选多个 SSH 连接 → 网格视图并行执行，每台主机一个面板
  - **Playbook**：把多个命令模板串成有序剧本，上一步输出可捕获为变量供下一步引用，可设"失败继续"
- AI 助手：编辑器侧栏对话生成命令，可一键塞入；支持 Claude / OpenAI（含兼容端点：DeepSeek/通义/本地代理）/ Ollama，多 provider 切换
- 安全护栏：高危命令（rm -rf /, mkfs, fork bomb 等）默认拦截需二次确认；AI 生成的命令永远不自动执行
- 执行历史：每次执行的完整输出落本地文件，可回看

## 系统要求

- Node.js 18+ （推荐 20 或 22）
- 操作系统：Windows / macOS / Linux 均可
- 原生模块：`better-sqlite3`（必需）；`node-pty`（可选，仅本地 Web Terminal 需要）。大部分平台直接装 prebuilt；如果不走 prebuilt，需要 Python + C++ 工具链

## 安装

```bash
cd opslab
npm install
```

> **WSL 用户注意**：如果代码在 WSL 文件系统里（`\\wsl$\...`），从 Windows 跑 `npm install` 会很慢。建议直接在 WSL Ubuntu 里跑。

## 启动

开发模式（前后端热重载）：

```bash
npm run dev
```

会启动：
- Server: `http://127.0.0.1:7821`
- Vite dev server: `http://127.0.0.1:5173`（带前端热更新，dev 时推荐用这个）

启动后控制台打印形如：

```
  OpsLab is running
  → http://127.0.0.1:7821/?token=xxxxx
```

把这个 URL 复制到浏览器即可。Token 会写入 `data/access.token` 并被前端记到 localStorage，之后访问 `http://127.0.0.1:7821/` 就行。

生产模式（单端口提供前后端）：

```bash
npm run build
npm start
```

## 数据位置

所有数据都放在 `opslab/data/`：

- `opslab.db` — SQLite 数据库（命令、连接、历史元数据）
- `secrets.bin` — AES-256-GCM 加密的密钥/密码
- `outputs/` — 每次执行的完整输出（`<execId>.log`）
- `access.token` — 访问令牌

> 加密密钥从机器特征（hostname/平台/用户名）派生。换机器后旧的加密内容解不开（设计如此，避免泄露）。需要跨机器同步可设置环境变量 `OPSLAB_SECRET_SALT`。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `OPSLAB_PORT` | 7821 | 服务端口 |
| `OPSLAB_HOST` | 127.0.0.1 | 监听地址（**不要**设成 0.0.0.0 除非你知道后果） |
| `OPSLAB_WIN_SHELL` | powershell.exe | Windows 下使用的 shell，可改成 `pwsh.exe` 或 `cmd.exe` |
| `OPSLAB_SECRET_SALT` | (内置) | 加密 salt，自定义可跨机器迁移密钥 |
| `OPSLAB_TERM_GRACE_MS` | 120000 | Web Terminal 断线后服务端 PTY 的保活时长（毫秒），超时未重连即销毁；设 `0` 则断线立即销毁 |
| `OPSLAB_TERM_BUFFER_BYTES` | 262144 | Web Terminal 每会话保留、可在重连时回放的输出字节上限 |

## 首次使用

1. 启动后打开浏览器，左侧"命令"页已自动种入十几条常用命令（docker/k8s/系统/磁盘/端口）
2. 任一命令点 **▶ 执行** 即可
3. 想加 SSH：左侧"连接" → 新建 SSH 连接 → 填 host/账号/密码或私钥
4. 配 AI：左侧"AI 设置" → 添加 Claude/OpenAI/Ollama → 填 API key（Ollama 无需 key）
5. 编辑命令时点右上"✦ AI 助手"，告诉 AI "查端口 8080 占用"之类即可

## 命令 vs 脚本

新建命令时有个**解释器**下拉：

| 选择 | 行为 |
|---|---|
| `Auto`（默认） | 内容作为单条命令传给 OS shell（`bash -lc` 或 `powershell -Command`），适合一行 / 用 `&&` `;` 串联 |
| `bash` / `sh` / `zsh` | 把内容当 shell 脚本，写入临时 .sh 文件用对应解释器执行（编辑器变大、显示行号） |
| `powershell` / `pwsh` | 同上，临时 .ps1 |
| `python` / `python3` | 临时 .py，直接写 Python 代码 |
| `node` | 临时 .js |
| `ruby` / `perl` | 对应解释器 |
| `自定义…` | 任意解释器路径，例如 `/usr/bin/env zx`、`deno run` 等 |

SSH 远程执行：脚本会通过 stdin 管道（bash/python/node 等支持）或临时文件（PowerShell）送到远端解释器，**不会在本地写盘**。

**导入文件**：编辑器右上角 📂 按钮可以选 .sh / .py / .ps1 等本地文件直接灌进来，会自动剥掉 shebang 行并匹配解释器。

例子已自动种入（命令页搜 "示例"）：
- "示例：Python 脚本" — 用 Python 递归统计目录大小
- "示例：Bash 脚本" — 找内存占用超阈值的进程

## 多命令场景速查

### 1. Shell 串联（命令模板里直接写）

```bash
cd /tmp && ls && pwd                # 顺序，前面失败停
echo a ; sleep 1 ; echo b ; date    # 顺序，失败也继续
ps aux | grep node | head -5        # 管道
```

任何 shell 自身支持的语法都能直接放在模板字段里。

### 2. 多标签终端

进入 **终端** 页（左侧 ▶ 终端），顶部 tab 栏：
- `+` 开新标签页
- 每个 tab 选独立的命令 + 连接 + 变量
- 标签页有状态点（蓝色=运行中、绿=完成、红=失败），可随时切换查看

适合并行做无关的事：一个 tab 跟 nginx 日志，另一个 tab 看 K8s pod。

### 3. Fan-out：同一条命令多机并行

终端页里 "目标连接" 是**多选**。选 2 台以上 → 自动切换到 fan-out 模式：
- 右侧自动变成网格，每台主机一个面板
- 全部并发启动，输出独立流转
- "停止全部" 一键停所有

适合：在 5 台 web 节点上同时跑 `systemctl status nginx`、批量看磁盘等。

### 4. Playbook：把多条命令编成剧本

进入 **Playbook** 页 → 新建。可以做的事：
- 把多条已保存的命令模板按顺序排列，或写 inline 步骤
- 每步可单独覆盖连接、变量值
- **关键**：把某步的 stdout 捕获成变量（"输出捕获为变量"字段），后续步骤模板里用 `{{var}}` 直接引用
- 失败处理：每步可勾选"失败仍继续"

执行时左侧实时显示每步状态，点任一步骤切看它的终端输出。

**例子**：变量捕获
```
步骤1：echo "prod-cluster"          → captureAs: cluster_name
步骤2：kubectl --context {{cluster_name}} get pods
```

执行后第 2 步的命令会变成 `kubectl --context prod-cluster get pods`。

## Web Terminal（交互式 Shell）

命令模板和 Playbook 是"跑一条、看输出"；如果你想要一个**真正可交互的 shell**（跑 `vim`、`top`、`htop`、`ssh`、回答 `sudo` 密码提示、用上下键翻历史……），用左侧 **`⌨ Shell`** 页。

- **本地或远程**：顶部"连接"下拉切本地 shell / 任意 SSH 连接（切换会重开会话）
- **真 PTY**：本地走 [`node-pty`](https://github.com/microsoft/node-pty)，远程走 SSH 的 shell 通道；窗口大小随浏览器自适应（`resize`），程序看到的是一个正常 TTY
- **多标签**：顶部 `+` 开多个独立会话，标签上的状态点表示 连接中 / 已连接 / 重连中 / 已断开
- **断线自动重连**：网络抖动、电脑休眠、`tsx watch` 重启 dev server 等导致 socket 掉线时，服务端 PTY 会保活一段时间（默认 2 分钟，见 `OPSLAB_TERM_GRACE_MS`）。前端自动重连并**回放断线期间漏掉的输出**，原有滚屏保留、长任务继续跑，无需手动操作。只有真正 `exit` 退出 shell 才需要点"重新连接"开新会话；若超过保活时长或服务端进程已重启（会话确实没了），前端会提示并自动开一个新会话
- **复制粘贴**：选中即可用 `Ctrl/Cmd+Shift+C` 复制、`Ctrl/Cmd+Shift+V` 粘贴；裸 `Ctrl+C` 直接发给 shell（SIGINT），不会被前端拦截
- 与命令模板不同，这里**保留**你的 rc/profile、别名、彩色提示符——它就是个完整的登录 shell

> **本地终端需要 node-pty**：它是可选原生模块。没装时本地终端会提示安装命令，但 **SSH 终端不依赖它，开箱即用**。在你实际运行服务端的环境里装（WSL 用户在 WSL 里装）：
> ```bash
> npm install node-pty -w server   # 然后重启服务
> ```
> 大多数平台有 prebuilt，无需编译。

## 安全说明

- 默认只听 `127.0.0.1`，本机其他用户/程序也需 token 才能调
- 高危命令拦截清单见 `server/src/executors/safety.ts`，可自行扩展（仅作用于命令模板执行）
- AI 生成的命令 **永远** 不自动执行：必须点"执行"按钮
- SSH 密码/私钥、AI key 全部 AES-256-GCM 加密，不落明文
- **Web Terminal 是完整的交互式 shell**，不套高危命令拦截（无法对交互输入做有意义的解析）；它的权限与"终端"页执行命令一致，同样靠 `127.0.0.1` + token 保护。关闭标签会立即销毁服务端 PTY；断线时为支持自动重连会保活一小段时间（默认 2 分钟，可用 `OPSLAB_TERM_GRACE_MS` 调整或设 `0` 关闭），超时未重连即销毁。重连用的 sessionId 是本地随机生成的不可猜值，且仍受 token 门禁保护

## 项目结构

```
opslab/
├── server/                # Node + Express + Socket.IO
│   └── src/
│       ├── index.ts       # 入口
│       ├── db.ts          # SQLite 仓储
│       ├── secrets.ts     # 加密
│       ├── seed.ts        # 内置命令模板
│       ├── routes/        # REST 路由
│       ├── executors/     # local / ssh / runner / pty (Web Terminal) / template / safety
│       └── ai/            # claude / openai / ollama adapters
├── client/                # React + Vite + Tailwind
│   └── src/
│       ├── pages/         # …Runner, WebTerminal, Playbooks, Connections …
│       ├── components/    # TerminalView, VariableForm, AIAssistPanel
│       └── lib/           # api / socket / store / types
└── data/                  # 用户数据 (不入 git)
```

## 故障排查

- **`better-sqlite3` 装失败**：装编译工具链（Linux `apt install build-essential python3`，Mac `xcode-select --install`，Windows `npm install -g windows-build-tools`），然后 `npm rebuild better-sqlite3`。
- **AI 无响应**：检查"AI 设置"里 provider 是否启用、是否设了 API key；Ollama 需自己确保 `ollama serve` 已起。
- **SSH 连不上**：连接列表里点"测试"，错误信息会显示在右侧。
- **想清空所有数据**：删 `data/` 目录即可，下次启动会重建。

## 后续可加

- Sessions 持久化跨刷新（当前刷新会清屏，但执行记录都在历史里）
- 团队共享（导出/导入命令包）
