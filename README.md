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
| `--max-steps=N` | 限制最多 N 轮工具调用（默认 30） |
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
- **健壮性**：API 自动重试 3 次（指数退避）、单请求 5 分钟超时、单命令 2 分钟超时、输出截断防止撑爆上下文、任务可 Ctrl+C 中断
- **安全防护**：危险命令（`rm -rf /`、`mkfs`、`dd` 写设备、`shutdown`、fork 炸弹等）需交互确认，非交互环境默认拒绝
- **死循环保护**：连续 3 次执行同一命令自动判定为卡死并引导模型收尾
- **自改进记忆**：每次任务后自动反思，把可复用的经验写入 `~/.10xagent/memory.md`，下次会话注入 system prompt

## 安装 / 更新

`skymind` 是 `agent.js` 的软链接（安装在 `~/bin/skymind`）：

```bash
ln -sf /home/veins/codex_projects/10xagent/agent.js ~/bin/skymind
```

## 文件说明

- `agent.js` — 主脚本（核心引擎 + TUI + CLI 一体）
- `agent.js.tui-backup` / `agent.js.old` / `agent.js.bak` — 历史备份
