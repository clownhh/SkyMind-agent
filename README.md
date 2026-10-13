# Skymind — 终端 AI 智能体（TUI + CLI）

基于 **OpenAI 兼容接口**的终端 AI 智能体。在终端输入 `skymind` 直接进入交互式 TUI 界面；也可以带任务参数单次执行。支持**跨会话自改进**（经验沉淀到 `~/.10xagent/memory.md`）。

## 快速开始

```bash
skymind                       # 进入 TUI 交互界面
skymind "帮我统计当前目录有多少个文件"   # 单次执行（CLI 模式）
```

## TUI 界面

```
╭─ Skymind — 10xAgent TUI — 就绪 ────────────────╮
│ 12:55:37 [系统] 欢迎使用 Skymind TUI！...        │
│ 12:55:38 [用户] 统计当前目录文件数                │
│ 12:55:40 [命令] $ find . -maxdepth 1 -type f ... │
│ 12:55:40 [输出] 5                                │
│ 12:55:41 [答复] 当前目录共有 5 个文件。           │
│ 12:55:41 [系统] ✓ 任务结束，可继续输入新任务。    │
├──────────────────────────────────────────────────┤
│ > 输入任务…                                      │
├──────────────────────────────────────────────────┤
│ Ctrl+C 退出 · Ctrl+L 清屏 · ↑/↓ 历史 · Ctrl+U 清空│
╰──────────────────────────────────────────────────╯
```

### TUI 快捷键

| 按键 | 作用 |
|------|------|
| `Enter` | 提交任务 |
| `Ctrl+C` | 空闲时退出；运行中先中断任务，再按一次强制退出 |
| `Ctrl+L` | 清空日志区 |
| `↑ / ↓` | 浏览历史任务 |
| `Ctrl+U` | 清空当前输入 |
| `y / n` | 危险命令确认弹窗中执行 / 拒绝 |

任务执行过程**实时显示**：模型思考、每条 shell 命令、工具输出、最终答复都在界面中滚动展示。

## 常用选项（CLI 模式）

| 选项 | 说明 |
|------|------|
| `--no-learn` | 任务结束后跳过反思学习（省一次 API 调用） |
| `--yes` | 危险命令自动放行，不弹交互确认 |
| `--verbose, -v` | 打印 agent 执行的每条命令 |
| `--max-steps=N` | 限制最多 N 轮工具调用（默认 100） |
| `--show-memory` | 只打印累积的经验记忆库后退出 |
| `--tui` / `--cli` | 强制 TUI / CLI 模式 |
| `--help, -h` | 显示帮助 |

## 配置（按优先级）

1. 环境变量 `OPENAI_BASE_URL` / `OPENAI_API_KEY` / `OPENAI_MODEL`
2. `~/.codex/config.toml`（`base_url` / `experimental_bearer_token` / `model`）
3. `~/.codex/auth.json`（`OPENAI_API_KEY` 兜底，仅在 config.toml 无密钥时使用）

## 特性

- **TUI**：纯 ANSI 实现、零依赖，备用屏幕、滚动日志、危险命令弹窗确认、任务可中断
- **工具调用**：支持并行 tool calls，逐条执行并把 stdout/stderr 回传给模型
- **健壮性**：API 最多尝试 3 次（间隔 1 秒、2 秒；400/401/403 等非临时错误直接报告）、单请求 5 分钟超时（包含响应正文读取）、单命令 2 分钟超时、输出截断防止撑爆上下文；网络请求和重试等待可 Ctrl+C 中断
- **安全防护**：危险命令（`rm -rf /`、`mkfs`、`dd` 写设备、`shutdown`、fork 炸弹等）需交互确认，非交互环境默认拒绝
- **死循环保护**：连续 3 次执行同一命令自动判定为卡死并引导模型收尾
- **自改进记忆**：每次任务后自动反思，把可复用的经验写入 `~/.10xagent/memory.md`，下次会话注入 system prompt

## 安装 / 更新

需要 Node.js 18 或更新版本，无需安装 npm 依赖。Linux/macOS 下克隆仓库并安装 `skymind` 软链接：

```bash
git clone https://github.com/clownhh/SkyMind-agent.git
cd SkyMind-agent
mkdir -p "$HOME/bin"
chmod +x agent.js
ln -sf "$PWD/agent.js" "$HOME/bin/skymind"
export PATH="$HOME/bin:$PATH"
```

## 文件说明

- `agent.js` — 主脚本（核心引擎 + TUI + CLI 一体）
- `api-client.js` — API 请求、超时、重试和中断处理
- `test-api.js` — 使用本地 HTTP 服务验证请求和异常处理
- `test-render.js` — 直接验证真实 TUI 的渲染、滚动和危险命令确认状态

## 开发验证

测试不需要 API 密钥，不会调用远程模型或执行模型生成的命令：

```bash
node --check agent.js
node --test test-api.js
node test-render.js
```

GitHub Actions 在 Linux 和 Windows 上验证 Node.js 18、22、24。
