#!/usr/bin/env node
/**
 * =====================================================================
 *  Skymind —— 基于 OpenAI 兼容接口的终端 AI 智能体（TUI + CLI）
 * =====================================================================
 *  TUI 模式：终端输入 `skymind` 直接进入交互式界面
 *    · 底部输入任务，回车执行
 *    · 实时展示模型思考 / 命令执行 / 工具输出 / 最终答复
 *    · 危险命令在界面内弹窗确认（y 执行 / n 拒绝）
 *    · Ctrl+C 中断任务、Ctrl+L 清屏、↑/↓ 翻历史
 *    · 鼠标滚轮 / PageUp / PageDown / Home / End 回看历史日志
 *  CLI 模式：`skymind "任务描述"` 单次执行，兼容旧用法
 *
 *  核心能力：
 *    1. 自动读取配置（优先级：环境变量 > ~/.codex/config.toml > ~/.codex/auth.json）
 *    2. 赋予 LLM 一个 bash 工具，让它通过执行 shell 命令来完成任务
 *    3. 支持并行工具调用、API 重试、请求超时保护、任务可中断
 *    4. 内置「自改进记忆」：任务结束后自动反思沉淀经验，
 *       下次会话自动注入 system prompt，实现跨会话自我进化
 *    5. 安全机制：危险命令需交互确认；连续重复命令触发死循环保护
 *
 *  用法示例：
 *    skymind                        # 进入 TUI
 *    skymind "帮我统计当前目录下有多少个文件"
 *    skymind --verbose "列出所有隐藏文件"
 *    skymind --no-learn "只执行任务，不学习"
 *    skymind --yes "..."            # 危险命令自动放行
 *    skymind --max-steps=10 "..."
 *    skymind --show-memory          # 只查看累积经验
 *    skymind --help
 * =====================================================================
 */

const { execSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");
const { StringDecoder } = require("node:string_decoder");

// =====================================================================
// 一、参数解析（放在最前面，保证 --help / --show-memory 不需要 API 配置）
// =====================================================================
const rawArgs = process.argv.slice(2);
const FLAGS = {
  noLearn: false,    // --no-learn      关闭任务后的反思学习
  yes: false,        // --yes           危险命令自动确认，不弹交互提示
  verbose: false,    // --verbose       打印每次执行的命令（CLI 模式用）
  showMemory: false, // --show-memory   只打印记忆库内容后退出
  help: false,       // --help/-h       打印用法后退出
  maxSteps: 100,     // --max-steps=N   最大工具调用轮数（防失控）
  forceTui: false,   // --tui           强制进入 TUI
  forceCli: false,   // --cli           强制 CLI 模式
};
const promptArgs = []; // 剩下的都是用户的任务描述

for (let i = 0; i < rawArgs.length; i++) {
  const a = rawArgs[i];
  if (a === "--no-learn") FLAGS.noLearn = true;
  else if (a === "--yes") FLAGS.yes = true;
  else if (a === "--verbose" || a === "-v") FLAGS.verbose = true;
  else if (a === "--show-memory") FLAGS.showMemory = true;
  else if (a === "--help" || a === "-h") FLAGS.help = true;
  else if (a === "--tui") FLAGS.forceTui = true;
  else if (a === "--cli") FLAGS.forceCli = true;
  else if (a.startsWith("--max-steps=")) FLAGS.maxSteps = Math.max(1, parseInt(a.split("=")[1], 10) || 100);
  else if (a === "--max-steps") FLAGS.maxSteps = Math.max(1, parseInt(rawArgs[++i], 10) || 100);
  else promptArgs.push(a);
}
const USER_PROMPT = promptArgs.join(" ");

const HELP_TEXT = `Skymind —— 基于 OpenAI 兼容接口的终端 AI 智能体（TUI + CLI）

启动:
  skymind               进入 TUI 交互界面（在下方输入任务，回车执行）
  skymind "任务描述"    单次执行任务（CLI 模式）

选项:
  --no-learn         任务结束后不进行反思学习（省一次 API 调用）
  --yes              危险命令自动放行，不做交互确认
  --verbose, -v      CLI 模式下打印 agent 执行的每条命令
  --max-steps=N      限制最多 N 轮工具调用（默认 100）
  --show-memory      只打印累积的经验记忆库后退出
  --tui              强制进入 TUI（即使带任务参数）
  --cli              强制 CLI 模式
  --help, -h         显示本帮助

配置（按优先级）:
  1. 环境变量  OPENAI_BASE_URL / OPENAI_API_KEY / OPENAI_MODEL
  2. ~/.codex/config.toml（base_url / experimental_bearer_token / model）
  3. ~/.codex/auth.json（OPENAI_API_KEY 兜底）

经验记忆保存在: ~/.10xagent/memory.md（跨会话自改进）`;

if (FLAGS.help) { console.log(HELP_TEXT); process.exit(0); }

// =====================================================================
// 二、自改进记忆（跨会话经验沉淀）
// =====================================================================
const MEMORY_PATH = path.join(os.homedir(), ".10xagent", "memory.md");
const MAX_MEMORY_CHARS = 8000; // 记忆库长度上限，防止无限膨胀

// 读取记忆库；文件不存在时返回空字符串
const loadMemory = () => {
  try {
    const m = fs.readFileSync(MEMORY_PATH, "utf8").trim();
    return m.length > MAX_MEMORY_CHARS ? m.slice(0, MAX_MEMORY_CHARS) + "\n…(超长截断)" : m;
  } catch {
    return "";
  }
};

// 写入记忆库（自动创建父目录）
const saveMemory = content => {
  fs.mkdirSync(path.dirname(MEMORY_PATH), { recursive: true });
  fs.writeFileSync(MEMORY_PATH, content.trim() + "\n", "utf8");
};

if (FLAGS.showMemory) {
  console.log(loadMemory() || "（记忆库为空）");
  process.exit(0);
}

// =====================================================================
// 三、配置读取（环境变量 > config.toml > auth.json）
// =====================================================================
const loadConfig = () => {
  const cfg = { OPENAI_BASE_URL: "", OPENAI_API_KEY: "", OPENAI_MODEL: "" };
  // ① 优先从 ~/.codex/config.toml 读取（Codex CLI 的标准配置）
  try {
    const text = fs.readFileSync(path.join(os.homedir(), ".codex", "config.toml"), "utf8");
    cfg.OPENAI_API_KEY = text.match(/experimental_bearer_token\s*=\s*"([^"]*)"/)?.[1]?.trim() ?? "";
    cfg.OPENAI_BASE_URL = (text.match(/^\s*base_url\s*=\s*"([^"]*)"/m)?.[1]?.trim() ?? "").replace(/\/+$/, "");
    cfg.OPENAI_MODEL = text.match(/^model\s*=\s*"([^"]*)"/m)?.[1]?.trim() ?? "";
  } catch {}
  // ② 兜底：仅当 config.toml 没读到密钥时，才尝试 OpenAI CLI 的 auth.json
  //    （注意不能用 ??，否则会拿 auth.json 的旧密钥覆盖掉 config.toml 里的有效密钥）
  if (!cfg.OPENAI_API_KEY) {
    try {
      const auth = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".codex", "auth.json"), "utf8"));
      cfg.OPENAI_API_KEY = auth.OPENAI_API_KEY ?? auth.tokens?.openai ?? "";
    } catch {}
  }
  return cfg;
};

const cfg = loadConfig();
// 环境变量优先级最高，覆盖文件配置
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || cfg.OPENAI_BASE_URL;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || cfg.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || cfg.OPENAI_MODEL;

if (!OPENAI_BASE_URL || !OPENAI_API_KEY || !OPENAI_MODEL) {
  console.error(
    "缺少配置：请设置 OPENAI_BASE_URL / OPENAI_API_KEY / OPENAI_MODEL 环境变量，" +
    "或确保 ~/.codex/config.toml（或 auth.json）中存在对应配置。"
  );
  process.exit(1);
}

// 小工具函数：延时
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// =====================================================================
// 四、LLM 调用（带重试、超时、可中断、工具定义）
// =====================================================================
const API_TIMEOUT_MS = 300_000; // 单次请求超时上限：5 分钟

// 把模型返回的 content 统一转成字符串。
// 有些兼容网关（如 Anthropic 风格）会返回数组形式的分块内容，必须兼容。
const toText = v => {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.map(p => p.text ?? (typeof p === "string" ? p : JSON.stringify(p))).join("");
  return String(v);
};

// 定义 bash 工具描述（交给模型的 JSON Schema）
const TOOL_DEFINITION = {
  type: "function",
  function: {
    name: "bash",
    description: "在 Linux 终端执行一条 shell 命令，返回其 stdout/stderr。适合文件操作、程序运行、环境查询等。",
    parameters: {
      type: "object",
      properties: { cmd: { type: "string", description: "要执行的完整 shell 命令" } },
      required: ["cmd"],
      additionalProperties: false,
    },
  },
};

// 核心请求函数。
// @param useTools=false 时发送纯对话请求（用于反思），避免模型在反思时乱调工具
// @param signal        外部 AbortSignal，用户中断任务时终止本次请求
const call = async (messages, { useTools = true, signal = null } = {}) => {
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) { // 最多重试 3 次
    const controller = new AbortController();
    // 外部信号（用户 Ctrl+C）能直接中止本次网络请求
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener("abort", () => controller.abort(), { once: true });
    }
    const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS); // 超时保护
    try {
      const body = { model: OPENAI_MODEL, messages };
      if (useTools) {
        body.tool_choice = "auto"; // 是否用工具由模型自行决定
        body.tools = [TOOL_DEFINITION];
      }
      const res = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal, // 传 AbortSignal 实现超时中断
      });
      clearTimeout(timer);
      const data = await res.json();
      if (!res.ok) {
        lastErr = new Error(`API 请求失败 (HTTP ${res.status}): ${JSON.stringify(data).slice(0, 500)}`);
      } else if (!data.choices?.length) {
        lastErr = new Error(`API 响应异常，缺少 choices: ${JSON.stringify(data).slice(0, 500)}`);
      } else {
        const msg = data.choices[0].message;
        // 统一标准化返回：content 转字符串，tool_calls 缺省为空数组
        return { role: "assistant", content: toText(msg.content), tool_calls: msg.tool_calls ?? [] };
      }
    } catch (err) {
      clearTimeout(timer);
      lastErr = err.name === "AbortError"
        ? new Error(signal?.aborted ? "任务已中断" : `请求超时（${API_TIMEOUT_MS / 1000} 秒）`)
        : err;
    }
    if (attempt < 3) await sleep(1000 * attempt); // 指数退避：1s、2s
  }
  throw lastErr;
};

// 纯对话补全（不带工具），供反思使用
const callPlain = async (messages, signal = null) => {
  const m = await call(messages, { useTools: false, signal });
  return m.content ?? "";
};

// =====================================================================
// 五、安全保护：危险命令识别 + 交互确认
// =====================================================================
// 正则列表：匹配即视为危险命令（可自行增删）
const DANGEROUS_PATTERNS = [
  /\brm\s+-[a-z]*r[a-z]*\s+\/(\s|$)/,   // rm -rf /           删除根目录
  /\brm\s+-[a-z]*r[a-z]*\s+~(\s|$)/,    // rm -rf ~           删除家目录
  /\bmkfs\b/,                            // 格式化磁盘
  /\bdd\b.*of=\/dev\//,                  // dd 直接写块设备
  /\b:\(\)\s*\{\s*:\|:&\s*\}\s*;\s*:/,   // fork 炸弹
  /\bshutdown\b|\breboot\b|\bhalt\b/,    // 关机/重启
  /\bchmod\s+-R\s+777\s+\//,            // 全盘放开权限
  />\s*\/dev\/sd/,                       // 直接覆盖磁盘
];

// 判断命令是否危险
const isDangerous = cmd => DANGEROUS_PATTERNS.some(re => re.test(cmd));

// CLI 模式的交互式确认。非 TTY（如被其他程序调用）时默认拒绝，保证安全
const confirmDangerous = cmd => {
  if (!process.stdin.isTTY) return Promise.resolve(false);
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  return new Promise(resolve => {
    rl.question(`\n[安全提示] 将执行危险命令：\n  ${cmd}\n是否继续？(y/N) `, ans => {
      rl.close();
      resolve(/^y(es)?$/i.test(ans.trim()));
    });
  });
};

// =====================================================================
// 六、bash 工具执行（并行调用逐个执行，并附带各种保护）
// =====================================================================
const EXEC_TIMEOUT_MS = 120_000;    // 单条命令超时：2 分钟
const MAX_TOOL_OUTPUT = 10_000;     // 单条命令输出截断长度，防止撑爆上下文

// 执行一条命令并捕获输出；无论成败都返回文本结果
const executeCommand = cmd => {
  try {
    return execSync(cmd, {
      encoding: "utf8",
      timeout: EXEC_TIMEOUT_MS,
      stdio: ["pipe", "pipe", "pipe"], // 全管道捕获，不污染终端
    });
  } catch (err) {
    // 命令失败不是致命错误，把退出码和输出打包成文本交给模型分析
    return [
      `[命令退出码: ${err.status ?? "未知"}]`,
      err.stdout ? `stdout:\n${err.stdout}` : "",
      err.stderr ? `stderr:\n${err.stderr}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  }
};

// 解析模型传来的工具调用参数，提取 cmd 字符串
const parseToolCommand = rawArgs => {
  try {
    const args = JSON.parse(rawArgs ?? "{}");
    return typeof args.cmd === "string" ? args.cmd.trim() : "";
  } catch (err) {
    return { error: `[工具参数解析失败] ${err.message}\n原始参数: ${rawArgs}` };
  }
};

// =====================================================================
// 七、反思学习：从本次会话提炼经验，更新记忆库
// =====================================================================
const reflectAndLearn = async (sessionTranscript, task, signal = null) => {
  const oldMem = loadMemory();
  const prompt = `反思下面这次 agent 会话，提炼对未来运行有价值的经验教训，更新记忆库。

规则：
1. 只保留具体、可复用、可操作的经验（命令技巧、踩坑记录、环境限制、工具用法等）。
2. 每条格式为 "- 经验内容"，不要编号、不要分节标题。
3. 与旧经验重复的不要重复写；旧经验中过时/错误的可以删除或改写。
4. 总量控制在 30 条以内，每条尽量一句话。

旧记忆（可为空）：
---
${oldMem || "(空)"}
---

本次任务：${task}

本次会话记录：
---
${sessionTranscript.slice(0, 20000)}
---

请直接输出更新后的完整记忆库内容（Markdown 列表，每行以 "- " 开头），不要任何解释文字。`;

  const updated = await callPlain([{ role: "user", content: prompt }], signal);
  const clean = updated.replace(/```[a-z]*\n?/gi, "").trim(); // 去掉可能的代码块围栏
  if (!clean) return false;

  // 只提取 "- " 开头的行，过滤模型可能夹带的杂讯
  const items = clean
    .split("\n")
    .map(l => l.trim())
    .filter(l => /^[-*]\s+\S/.test(l) && l.length < 400)
    .map(l => l.replace(/^[-*]\s+/, "- "));
  if (!items.length) return false;

  const dedup = [...new Set(items)]; // 简单去重
  const newMem = dedup.join("\n").slice(0, MAX_MEMORY_CHARS);
  if (newMem !== oldMem) { // 有变化才写入，避免无意义写盘
    saveMemory(newMem);
    return true;
  }
  return false;
};

// =====================================================================
// 八、核心引擎：runAgent（CLI 与 TUI 共用，通过 callbacks 上报事件）
// =====================================================================
// callbacks 可选字段：
//   onThinking()                     开始向模型请求（思考中）
//   onCommand(cmd)                   即将执行某条命令
//   onOutput(cmd, output)            命令执行完成（output 为原始文本）
//   onAnswer(text)                   得到最终答复
//   onConfirm(cmd) -> Promise<bool>  危险命令确认（默认拒绝）
//   onLearn(saved, err)              反思学习完成（saved 表示是否有更新）
const runAgent = async ({ task, options = {}, callbacks = {}, signal = null }) => {
  const opts = { noLearn: false, yes: false, maxSteps: 100, ...options };
  const cb = {
    onThinking: () => {},
    onCommand: () => {},
    onOutput: () => {},
    onAnswer: () => {},
    onConfirm: async () => false,
    onLearn: () => {},
    ...callbacks,
  };

  // 组装 system prompt：基础设定 + 累积经验（实现跨会话自我进化）
  const mem = loadMemory();
  const systemPrompt =
    `你是简洁但十分智能的AI Agent。用 bash 工具执行操作，完成后直接用文本回复。环境信息：\n` +
    `os=${process.platform}\narch=${process.arch}\ncwd=${process.cwd()}` +
    `\n注意：工具输出最长约 ${MAX_TOOL_OUTPUT} 字符，超出会被截断，需要完整内容时请分步查看。` +
    (mem ? `\n\n## 累积经验（来自过往会话的自改进，可从中借鉴，也可补充）\n${mem}` : "");

  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: task || "（无任务）请直接回复 OK" },
  ];

  let finalAnswer = "";         // 最终的纯文本答复
  let lastCmd = "";             // 上一条命令（用于死循环检测）
  let sameCmdCount = 0;         // 连续相同命令的次数
  let loopProtected = false;    // 已触发死循环保护
  const aborted = () => signal?.aborted === true;

  for (let step = 0; step < opts.maxSteps; step++) {
    if (aborted()) { finalAnswer = "[已中断] 任务被用户中止。"; cb.onAnswer(finalAnswer); break; }

    // ---------- 第 1 步：让模型思考并决定是否调用工具 ----------
    cb.onThinking();
    const m = await call(messages, { signal });
    if (aborted()) { finalAnswer = "[已中断] 任务被用户中止。"; cb.onAnswer(finalAnswer); break; }

    // 没有工具调用 => 这就是最终答复
    if (!m.tool_calls.length) {
      finalAnswer = m.content || "（空答复）";
      cb.onAnswer(finalAnswer);
      break;
    }

    // ---------- 第 2 步：执行本轮所有工具调用（支持并行，逐个处理） ----------
    const toolResults = [];
    for (const tc of m.tool_calls) {
      // 2.1 工具名校验：只允许 bash
      if (tc.function?.name !== "bash") {
        toolResults.push({ tool_call_id: tc.id, content: `[不支持的工具] ${tc.function?.name}` });
        continue;
      }

      // 2.2 死循环保护：一旦模型被明确告知停止却仍调工具，直接拦下
      if (loopProtected) {
        toolResults.push({ tool_call_id: tc.id, content: "[循环保护] 请不要再调用工具，直接给出最终结论。" });
        continue;
      }

      // 2.3 解析命令参数
      const parsed = parseToolCommand(tc.function.arguments);
      if (parsed.error) {
        toolResults.push({ tool_call_id: tc.id, content: parsed.error });
        continue;
      }
      const cmd = parsed;
      if (!cmd) {
        toolResults.push({ tool_call_id: tc.id, content: "[参数错误] cmd 为空，请提供要执行的命令。" });
        continue;
      }

      // 2.4 死循环检测：连续 3 次执行同一条命令，判定为卡死
      if (cmd === lastCmd) sameCmdCount++;
      else { lastCmd = cmd; sameCmdCount = 1; }
      if (sameCmdCount >= 3) {
        loopProtected = true;
        toolResults.push({
          tool_call_id: tc.id,
          content: `[循环保护] 你已连续 3 次执行同一命令「${cmd}」，疑似死循环。请停止调用工具，直接给出最终结论。`,
        });
        continue;
      }

      // 2.5 危险命令确认（除非 --yes；onConfirm 由界面层实现）
      if (isDangerous(cmd) && !opts.yes) {
        const ok = await cb.onConfirm(cmd);
        if (!ok) {
          toolResults.push({
            tool_call_id: tc.id,
            content: `[安全拦截] 危险命令已被阻止：${cmd}\n请改用更安全的方式完成目标。`,
          });
          continue;
        }
      }

      // 2.6 执行（先上报命令，再执行，方便界面实时展示）
      cb.onCommand(cmd);
      const output = executeCommand(cmd);
      cb.onOutput(cmd, output);

      // 2.7 截断输出后回传给模型
      toolResults.push({ tool_call_id: tc.id, content: String(output).slice(0, MAX_TOOL_OUTPUT) });
    }

    messages.push(m, ...toolResults.map(r => ({ role: "tool", ...r })));
  }

  // 达到最大轮数仍没得到最终答复时，明确告知用户（而不是静默退出）
  if (!finalAnswer) {
    finalAnswer = `[已达最大工具轮数(${opts.maxSteps})，未得到最终答复]`;
    cb.onAnswer(finalAnswer);
  }

  // ---------- 自改进：任务结束后反思，沉淀经验 ----------
  // 条件：未禁用学习 && 确实执行过工具（有 tool 消息）&& 未被中断
  if (!opts.noLearn && !aborted() && messages.some(msg => msg.role === "tool")) {
    try {
      const transcript = messages
        .slice(1)
        .map(msg => {
          if (msg.role === "assistant" && msg.tool_calls?.length) {
            const cmds = msg.tool_calls
              .map(tc => {
                try {
                  return JSON.parse(tc.function.arguments).cmd;
                } catch {
                  return "(参数解析失败)";
                }
              })
              .join(" | ");
            return `[Agent 执行] ${cmds}`;
          }
          if (msg.role === "tool") return `[输出] ${String(msg.content).slice(0, 600)}`;
          if (msg.role === "assistant") return `[回答] ${String(msg.content).slice(0, 1000)}`;
          if (msg.role === "user") return `[用户] ${String(msg.content).slice(0, 500)}`;
          return "";
        })
        .filter(Boolean)
        .join("\n");

      const learned = await reflectAndLearn(transcript, task, signal);
      cb.onLearn(learned, null);
    } catch (err) {
      // 反思失败不影响任务结果，只提示不退出
      cb.onLearn(false, err);
    }
  }

  return finalAnswer;
};

// =====================================================================
// 九、TUI（终端用户界面）：纯 ANSI 实现，零依赖
// =====================================================================
const CSI = "\x1b[";

// ---- 日志条目类型 → 颜色 / 中文标签 ----
const LOG_COLORS = { system: 250, user: 51, thinking: 226, command: 39, output: 244, answer: 46, error: 196, memory: 213 };
const LOG_LABELS = { system: "系统", user: "用户", thinking: "思考", command: "命令", output: "输出", answer: "答复", error: "错误", memory: "记忆" };

// 剥离文本中的 ANSI 控制序列（CSI 颜色/光标、OSC 标题、字符集选择），
// 命令输出常带这些转义码，原样进 TUI 会变乱码、污染颜色状态、导致换行宽度算错
const ANSI_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?]*[A-Za-z]|\x1b[()][A-Z0-9]/g;
// 显示宽度（CJK 字符按 2 列计；界面自绘的框线/破折号在常见终端为 1 列）
const charWidth = c => {
  const cp = c.codePointAt(0);
  if ((cp >= 0x2500 && cp <= 0x257f) || cp === 0x2014) return 1;
  return cp > 0xff ? 2 : 1;
};
const width = s => [...s].reduce((n, c) => n + charWidth(c), 0);
// 从头截断到指定显示宽度
const truncateWidth = (s, max) => {
  let n = 0, out = "";
  for (const c of [...s]) {
    const w = charWidth(c);
    if (n + w > max) break;
    n += w;
    out += c;
  }
  return out;
};
// 按显示宽度软换行：返回段数组，每段宽度 ≤ max（超宽单字符单独成段，极小终端兜底）
const wrapWidth = (s, max) => {
  s = s.replace(/\t/g, "    ").replace(/\r/g, ""); // tab 终端跳 8 列而计算按 1 列会超宽；\r 回车会回行首覆盖
  const segs = [];
  let cur = "", n = 0;
  for (const c of [...s]) {
    const w = charWidth(c);
    if (w > max) {
      if (cur) { segs.push(cur); cur = ""; n = 0; }
      segs.push(c);
      continue;
    }
    if (n + w > max) { segs.push(cur); cur = ""; n = 0; }
    cur += c;
    n += w;
  }
  if (cur || !segs.length) segs.push(cur);
  return segs;
};
// 带固定前缀的行按显示宽度软换行：首行 = 前缀+内容，续行缩进对齐到内容列
const wrapLine = (prefix, text, max) => {
  const pw = width(prefix);
  if (pw >= max) return wrapWidth(prefix + text, max); // 极窄终端：整体按满宽换行
  const avail = Math.max(1, max - pw);
  const body = wrapWidth(text, avail);
  const out = [prefix + body[0]];
  const indent = " ".repeat(pw);
  for (let i = 1; i < body.length; i++) out.push(indent + body[i]);
  return out;
};
// 从尾部保留，超长时加省略号（用于输入行）
const fitTail = (s, max) => {
  let n = 0;
  const chars = [...s];
  for (let i = chars.length - 1; i >= 0; i--) {
    const w = charWidth(chars[i]);
    if (n + w > max) return "…" + chars.slice(i + 1).join("");
    n += w;
  }
  return s;
};

const SPINNER = ["|", "/", "-", "\\"];

class TUI {
  constructor() {
    this.logs = [];            // { type, ts, text }
    this.input = "";           // 输入框内容
    this.history = [];         // 已提交任务历史
    this.histIdx = 0;          // ↑/↓ 浏览位置
    this.scrollOffset = 0;     // 日志回看滚动偏移（行数，0=跟随最新）
    this.mode = "idle";        // idle | running | confirm
    this.confirmCtx = null;    // { cmd, resolve }
    this.thinking = false;     // 是否在等模型响应
    this.running = false;
    this.abort = new AbortController();
    this.spinnerIdx = 0;
    this.timer = null;
    this.decoder = new StringDecoder("utf8");
    this.keyBuf = "";
    this.cleaning = false;
  }

  // ---------- 生命周期 ----------
  start() {
    // 进入备用屏幕、隐藏光标；启用鼠标上报（1000=按键, 1002=按键+滚轮, 1006=SGR 坐标格式）
    process.stdout.write(`${CSI}?1049h${CSI}?25l${CSI}2J${CSI}H${CSI}?1000h${CSI}?1002h${CSI}?1006h`);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", chunk => this.onData(chunk));
    process.stdout.on("resize", () => this.render());
    process.on("exit", () => this.cleanup());
    this.appendLog("system", "欢迎使用 Skymind TUI！在下方输入任务后回车执行。");
    this.render();
  }

  cleanup() {
    if (this.cleaning) return;
    this.cleaning = true;
    clearInterval(this.timer);
    try { process.stdin.setRawMode(false); } catch {}
    try { process.stdin.pause(); } catch {}
    process.stdout.write(`${CSI}?1000l${CSI}?1002l${CSI}?1006l${CSI}?25h${CSI}?1049l`);
  }

  exit() {
    this.cleanup();
    process.exit(0);
  }

  // ---------- 键盘输入 ----------
  onData(chunk) {
    const s = this.decoder.write(chunk);
    if (!s) return;
    this.keyBuf += s;
    this.parseKeys();
  }

  parseKeys() {
    while (this.keyBuf.length) {
      const c = this.keyBuf[0];
      if (c === "\x1b") {
        // 转义序列：CSI 以 \x1b[ 开头，终止字节在 0x40-0x7e（长度可变，如 SGR 鼠标）
        if (this.keyBuf.length < 2) return;
        if (this.keyBuf[1] !== "[") { this.keyBuf = this.keyBuf.slice(1); continue; } // 孤立 ESC，丢弃
        let end = -1;
        for (let i = 2; i < this.keyBuf.length; i++) {
          const cc = this.keyBuf.charCodeAt(i);
          if (cc >= 0x40 && cc <= 0x7e) { end = i; break; }
        }
        if (end < 0) return; // 还没收到终止字节，继续等
        const seq = this.keyBuf.slice(0, end + 1);
        this.keyBuf = this.keyBuf.slice(end + 1);
        this.handleEscapeSeq(seq);
      } else {
        this.handleKey(c);
        this.keyBuf = this.keyBuf.slice(1);
      }
    }
  }

  handleEscapeSeq(seq) {
    const map = { "\x1b[A": "up", "\x1b[B": "down", "\x1b[C": "right", "\x1b[D": "left" };
    if (map[seq]) { this.handleKey(map[seq]); return; }
    // SGR 鼠标事件：\x1b[<按钮;列;行M(按下) / m(释放)。滚轮向上=64、向下=65；
    // 只处理按下（大写 M），释放事件（小写 m）忽略，避免一格滚轮重复滚动
    const mouse = seq.match(/^\x1b\[<(\d+);(\d+);(\d+)M$/);
    if (mouse) {
      const btn = Number(mouse[1]);
      if (btn === 64) this.scrollLogs(3);       // 滚轮向上：offset+3 → 回看更早日志
      else if (btn === 65) this.scrollLogs(-3); // 滚轮向下：offset-3 → 回到最新
      return;
    }
    // 键盘翻页 / 定位：PageUp、PageDown、Home、End
    if (seq === "\x1b[5~") this.scrollLogs(this.viewRows || 10); // PageUp 回看一屏
    else if (seq === "\x1b[6~") this.scrollLogs(-(this.viewRows || 10)); // PageDown 回最新一屏
    else if (seq === "\x1b[H" || seq === "\x1b[1~") { this.scrollOffset = 1e9; this.render(); } // Home 到顶部（render 时钳制为最大回看）
    else if (seq === "\x1b[F" || seq === "\x1b[4~") { this.scrollOffset = 0; this.render(); }    // End 回到最新
  }

  scrollLogs(delta) {
    if (!this.logs.length) return;
    // delta 为正 → 向上回看更早日志；为负 → 向下回到最新（offset 最小 0）
    this.scrollOffset = Math.max(0, this.scrollOffset + delta);
    this.render();
  }

  handleKey(key) {
    // ---- 确认模式：y / n 决定危险命令去留 ----
    if (this.mode === "confirm") {
      if (key === "y" || key === "Y") this.confirmCtx?.resolve(true);
      else if (key === "n" || key === "N" || key === "\x03" || key === "\x1b") this.confirmCtx?.resolve(false);
      else return;
      this.mode = "idle";
      this.confirmCtx = null;
      this.render();
      return;
    }

    // ---- 运行中：只响应中断 / 清屏 ----
    if (this.mode === "running") {
      if (key === "\x03") {
        if (this.abort.signal.aborted) {
          this.appendLog("system", "再次按下 Ctrl+C，强制退出。");
          this.exit();
        } else {
          this.abort.abort();
          this.appendLog("system", "已请求中断，正在停止当前任务…（再按 Ctrl+C 强制退出）");
        }
      } else if (key === "\x0c") {
        this.logs = [];
        this.scrollOffset = 0;
        this.render();
      }
      return;
    }

    // ---- idle：完整键盘 ----
    if (key === "\x03") this.exit();                          // Ctrl+C 退出
    else if (key === "\x0c") { this.logs = []; this.scrollOffset = 0; this.render(); } // Ctrl+L 清屏
    else if (key === "\r" || key === "\n") this.submit();     // 回车提交
    else if (key === "\x7f" || key === "\x08") { this.input = this.input.slice(0, -1); this.render(); } // 退格
    else if (key === "\x15") { this.input = ""; this.render(); } // Ctrl+U 清空输入
    else if (key === "up") this.moveHistory(-1);
    else if (key === "down") this.moveHistory(1);
    else if (key.length === 1 && key >= " ") { this.input += key; this.render(); }
  }

  moveHistory(dir) {
    if (!this.history.length) return;
    this.histIdx = Math.max(0, Math.min(this.history.length, this.histIdx + dir));
    this.input = this.histIdx < this.history.length ? this.history[this.histIdx] : "";
    this.render();
  }

  // ---------- 日志 ----------
  appendLog(type, text) {
    // 命令输出常含 ANSI 控制序列 / tab / 回车：先归一成纯文本再进日志区，
    // 否则转义码泄漏（乱码、颜色污染、宽度算错）或 tab 按 1 列算但终端跳 8 列导致超宽
    let t = String(text)
      .replace(ANSI_RE, "")
      .replace(/\t/g, "    ")
      .replace(/\r/g, "")
      .replace(/\s+$/, "")
      .trim();
    if (!t) return;
    // 单条输出过长时折叠，避免日志区爆炸（完整内容仍会回传模型）
    const MAX = { output: 2000, answer: 3000, thinking: 200 }[type] || 800;
    if (t.length > MAX) t = t.slice(0, MAX) + "\n…（已折叠）";
    const ts = new Date().toTimeString().slice(0, 8);
    for (const ln of t.split("\n")) {
      this.logs.push({ type, ts, text: ln });
    }
    if (this.logs.length > 2000) this.logs.splice(0, this.logs.length - 2000);
    this.render();
  }

  // ---------- 任务执行 ----------
  submit() {
    const task = this.input.trim();
    if (!task) return;
    this.history.push(task);
    this.histIdx = this.history.length;
    this.scrollOffset = 0; // 新任务开始时回到最新，方便看新输出
    this.input = "";
    this.appendLog("user", task);
    this.runTask(task);
  }

  async runTask(task) {
    this.mode = "running";
    this.running = true;
    this.thinking = true;
    this.abort = new AbortController();
    // 转圈动画
    this.timer = setInterval(() => {
      this.spinnerIdx = (this.spinnerIdx + 1) % SPINNER.length;
      this.render();
    }, 120);
    try {
      const answer = await runAgent({
        task,
        options: { noLearn: FLAGS.noLearn, yes: FLAGS.yes, maxSteps: FLAGS.maxSteps },
        signal: this.abort.signal,
        callbacks: {
          onThinking: () => { this.thinking = true; },
          onCommand: cmd => { this.thinking = false; this.appendLog("command", `$ ${cmd}`); },
          onOutput: (_cmd, output) => { this.thinking = false; this.appendLog("output", String(output)); },
          onAnswer: ans => { this.thinking = false; this.appendLog("answer", ans); },
          onConfirm: cmd => this.promptConfirm(cmd),
          onLearn: (saved, err) => {
            this.thinking = false;
            if (saved) this.appendLog("memory", `已根据本次会话更新记忆库 → ${MEMORY_PATH}`);
            else if (err) this.appendLog("error", `反思失败（不影响任务结果）: ${err.message}`);
          },
        },
      });
      if (this.abort.signal.aborted) this.appendLog("system", "✓ 任务已中断");
      else this.appendLog("system", `✓ 任务结束（答复长度 ${width(answer)} 字符），可继续输入新任务。`);
    } catch (err) {
      this.thinking = false;
      this.appendLog("error", `执行失败: ${err.message}`);
    } finally {
      clearInterval(this.timer);
      this.timer = null;
      this.mode = "idle";
      this.running = false;
      this.thinking = false;
      this.render();
    }
  }

  // 危险命令确认：返回 Promise，等用户在界面按 y/n
  promptConfirm(cmd) {
    return new Promise(resolve => {
      this.mode = "confirm";
      this.confirmCtx = { cmd, resolve };
      this.render();
    });
  }

  // ---------- 渲染 ----------
  render() {
    // 兜底：PTY 未设置窗口大小时 rows/columns 可能为 0，给个默认值避免空白屏
    let { rows, columns } = process.stdout;
    if (!rows || !columns) { rows = 24; columns = 80; }
    const out = [];
    out.push(`${CSI}?25l${CSI}H${CSI}2J`);

    // ① 标题行
    const statusText =
      this.mode === "running" ? `${SPINNER[this.spinnerIdx]} 运行中` :
      this.mode === "confirm" ? "⚠ 需确认" : "就绪";
    let title = ` Skymind — 10xAgent TUI — ${statusText} `;
    if (width(title) > columns - 3) title = truncateWidth(title, Math.max(1, columns - 4)) + "…";
    const pad = Math.max(1, columns - width(title) - 3);
    out.push(`\x1b[38;5;45m╭─${title}${"─".repeat(pad)}╮\x1b[0m\r\n`);

    // ② 日志区（软换行；支持回看滚动：scrollOffset>0 时窗口整体上移，0=跟随最新）
    const logRows = Math.max(1, rows - 4);
    const thinkRow = this.thinking && this.mode === "running" ? 1 : 0; // 思考中占位提前预留 1 行，防日志填满时多输出一行把界面推出屏幕
    const budget = Math.max(1, logRows - thinkRow);
    this.viewRows = budget; // 供 PageUp/PageDown 翻页步长使用
    // 从最新条目开始收集，每个条目保留其内部换行段的正序；收集到「一屏 + 回看偏移」即停，避免超长日志拖慢渲染
    const chunks = [];   // 每项 { color, segs }，收集顺序：最新→最旧，segs 保持阅读顺序
    let totalRows = 0;
    for (let i = this.logs.length - 1; i >= 0; i--) {
      const item = this.logs[i];
      const prefix = `${item.ts} [${LOG_LABELS[item.type] || item.type}] `;
      const segs = wrapLine(prefix, item.text, Math.max(1, columns - 2));
      const color = LOG_COLORS[item.type] || 250;
      chunks.push({ color, segs });
      totalRows += segs.length;
      if (totalRows >= budget + this.scrollOffset) break;
    }
    // 按显示顺序展开成行（旧→新，最新条目在底部；条目内部保持正常阅读顺序）
    const allLines = [];   // 每项 { color, text }
    for (let c = chunks.length - 1; c >= 0; c--) {
      for (const seg of chunks[c].segs) allLines.push({ color: chunks[c].color, text: seg });
    }
    const maxScroll = Math.max(0, allLines.length - budget); // 最多能回看多少行
    this.scrollOffset = Math.min(this.scrollOffset, maxScroll);
    const start = maxScroll - this.scrollOffset; // 从底部回退 scrollOffset 行作为可视区底部
    const view = allLines.slice(start, start + budget);
    for (const ln of view) out.push(`\x1b[38;5;${ln.color}m${ln.text}\x1b[0m\r\n`);
    // 空白填充到思考行之前；思考中占位贴底（不写进 logs，避免刷屏）
    for (let i = view.length; i < budget; i++) out.push("\r\n");
    if (thinkRow) out.push(`\x1b[38;5;226m${SPINNER[this.spinnerIdx]} 思考中…\x1b[0m\r\n`);

    // ③ 分隔线
    out.push(`\x1b[38;5;45m├─${"─".repeat(Math.max(1, columns - 3))}┤\x1b[0m\r\n`);

    // ④ 输入行
    if (this.mode === "confirm") {
      const t = `⚠ 危险命令：${truncateWidth(this.confirmCtx?.cmd || "", columns - 24)}  [y] 执行  [n] 拒绝`;
      out.push(`\x1b[38;5;196m> ${truncateWidth(t, columns - 2)}\x1b[0m\r\n`);
    } else if (this.mode === "running") {
      out.push(`\x1b[38;5;226m> ${SPINNER[this.spinnerIdx]} 运行中… 按 Ctrl+C 中断\x1b[0m\r\n`);
    } else {
      out.push(`\x1b[38;5;51m> \x1b[0m${fitTail(this.input, Math.max(1, columns - 4))}\r\n`);
    }

    // ⑤ 状态行
    const hint =
      this.mode === "confirm" ? "y 确认执行 · n 拒绝" :
      this.mode === "running" ? "Ctrl+C 中断任务 · Ctrl+L 清屏" :
      this.scrollOffset > 0
        ? `已回看 ${this.scrollOffset} 行 · 滚轮/PageUp/PageDown 上下滚动 · Ctrl+L 清屏`
        : "Ctrl+C 退出 · Ctrl+L 清屏 · ↑/↓ 历史 · 滚轮回看 · Ctrl+U 清空输入";
    out.push(`\x1b[38;5;244m ${truncateWidth(hint, columns - 2)}\x1b[0m\r\n`);

    // ⑥ 光标定位：idle 时显示在输入行
    if (this.mode === "idle") {
      const col = Math.min(3 + width(this.input), columns - 1);
      out.push(`${CSI}${rows - 1};${col}H${CSI}?25h`);
    }
    process.stdout.write(out.join(""));
  }
}

// =====================================================================


const assert = require("assert");
let captured = "";
const realWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = s => { captured += s; };
Object.defineProperty(process.stdout, "columns", { value: 40, configurable: true });
Object.defineProperty(process.stdout, "rows", { value: 24, configurable: true });

const stripAnsi = s => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
const disp = s => [...stripAnsi(s)].reduce((n,c)=>n+charWidth(c),0);
const PREFIX_W = 16;
const stripPrefix = l => {
  let n = 0, i = 0;
  const chars = [...l];
  while (i < chars.length && n < PREFIX_W) { n += charWidth(chars[i]); i++; }
  return chars.slice(i).join("");
};
const logArea = lines => {
  const sep = lines.findIndex(l => l.startsWith("├"));
  return lines.slice(1, sep).filter(l => l.trim() !== "");
};

// ========== 测试A：单条长输出 → 日志区按正常阅读顺序逐字符重建 ==========
const tuiA = new TUI();
const textA = "find: 找到 " + "A".repeat(80) + " 个文件，其中中文路径：" + "测试目录".repeat(10) + " 处理完毕。";
tuiA.appendLog("output", textA);
captured = "";
tuiA.render();
let linesA = captured.split("\r\n").map(stripAnsi);
const logA = logArea(linesA);
const rebuilt = logA.map(stripPrefix).join("");
assert.strictEqual(rebuilt, textA, "内容重建不一致！\n期望: " + textA + "\n实际: " + rebuilt);
assert.ok(logA.length > 1, "长行应被换行为多行");
for (const l of logA) assert.ok(disp(l) <= 38, "超宽: " + disp(l));
assert.ok(/^\d{2}:\d{2}:\d{2} \[输出\]/.test(logA[0]), "带时间戳的首行应在该条顶部");
assert.ok(logA[0].includes("find: 找到"), "首行应含内容开头");
realWrite(`测试A ✓ ${textA.length} 字长输出换行 ${logA.length} 行，阅读顺序逐字符重建一致\n`);

// ========== 测试B：多条目 → 边框精确、行宽不超、最新内容在底部 ==========
const tuiB = new TUI();
for (let i = 1; i <= 30; i++) tuiB.appendLog("system", `第 ${i} 条日志，内容编号 ${i} 用于填满屏幕`);
tuiB.appendLog("answer", "最后一条答案！");
captured = "";
tuiB.render();
let linesB = captured.split("\r\n").map(stripAnsi);
assert.strictEqual(disp(linesB[0]), 40, "顶边框=" + disp(linesB[0]));
assert.strictEqual(disp(linesB[linesB.findIndex(l => l.startsWith("├"))]), 40, "分隔线宽度");
const logB = logArea(linesB);
for (const l of logB) assert.ok(disp(l) <= 38, "日志超宽");
assert.ok(logB.some(l => l.includes("最后一条答案")), "最新答案应可见");
assert.ok(!logB.some(l => l.includes("第 1 条")), "最旧日志应已滚出屏幕");
realWrite("测试B ✓ 30+1 条日志：边框=40、日志行≤38、最新内容在屏、旧内容滚出\n");

// ========== 测试C：极窄终端（30 列）不溢出 ==========
const tuiC = new TUI();
Object.defineProperty(process.stdout, "columns", { value: 30, configurable: true });
tuiC.appendLog("output", "窄屏测试：" + "中".repeat(40) + " end");
captured = "";
tuiC.render();
const linesC = captured.split("\r\n").map(stripAnsi);
const logC = logArea(linesC);
for (const l of logC) assert.ok(disp(l) <= 30, `窄屏超宽(${disp(l)}): ${l}`);
const rebuiltC = logC.map(stripPrefix).join("");
assert.strictEqual(rebuiltC, "窄屏测试：" + "中".repeat(40) + " end", "窄屏重建不一致: " + rebuiltC);
realWrite("测试C ✓ 30 列窄屏：无超宽行、内容完整\n");


// ========== 测试D：思考中占位不导致界面溢出（24 行终端，日志填满 + 思考中） ==========
const tuiD = new TUI();
tuiD.mode = "running"; tuiD.running = true; tuiD.thinking = true;
for (let i = 1; i <= 25; i++) tuiD.appendLog("system", `第 ${i} 条日志填充屏幕空间`);
captured = "";
tuiD.render();
const linesD = captured.split("\r\n").filter(l => l !== "");
assert.ok(linesD.length <= 24, `思考中占位溢出：24 行终端渲染出 ${linesD.length} 行`);
assert.ok(captured.includes("思考中"), "思考中占位应显示在日志区底部");
realWrite(`测试D ✓ 思考中占位不溢出：${linesD.length} 行 ≤ 24 行\n`);

// ========== 测试E：ANSI 转义序列被剥离，不污染 TUI ==========
Object.defineProperty(process.stdout, "columns", { value: 40, configurable: true }); // 恢复测试C改过的窄屏
const tuiE = new TUI();
tuiE.appendLog("output", "\x1b[31m红色\x1b[0m 普通 \x1b]0;标题\x07尾部");
captured = "";
tuiE.render();
assert.ok(!captured.includes("\x1b[31m") && !captured.includes("\x1b]0;"), "ANSI 转义泄漏进渲染输出");
const lineE = captured.split("\r\n").map(stripAnsi).find(l => l.includes("红色"));
realWrite("DBG lineE=" + JSON.stringify(lineE) + " raw=" + JSON.stringify(captured.split("\r\n").find(l => l.includes("红色"))) + "\n");
assert.ok(lineE && lineE.includes("普通") && lineE.includes("尾部"), "剥离后内容应完整保留: " + lineE);
realWrite("测试E ✓ ANSI 转义序列剥离，内容保留\n");

// ========== 测试F：tab 替换为空格，日志行不因跳列而超宽 ==========
const tuiF = new TUI();
tuiF.appendLog("output", "a\tb\tc");
captured = "";
tuiF.render();
const lineF = captured.split("\r\n").map(stripAnsi).find(l => l.includes("a"));
assert.ok(lineF && !lineF.includes("\t"), "tab 应被替换: " + JSON.stringify(lineF));
realWrite("测试F ✓ tab 已替换为空格\n");

// ========== 测试G：鼠标滚轮回看历史日志 ==========
const tuiG = new TUI();
Object.defineProperty(process.stdout, "columns", { value: 40, configurable: true });
Object.defineProperty(process.stdout, "rows", { value: 24, configurable: true });
for (let i = 1; i <= 40; i++) tuiG.appendLog("system", `第 ${i} 条历史日志`);
tuiG.appendLog("answer", "最新答复在底部");
const logLines = tuiG.logs.map(l => l.text); // 41 条
captured = "";
tuiG.render();
let linesG = captured.split("\r\n").map(stripAnsi);
let logG = logArea(linesG);
assert.ok(logG.some(l => l.includes("最新答复在底部")), "初始应显示最新内容");
assert.ok(!logG.some(l => l.includes("第 1 条")), "初始不应看到最旧内容");
tuiG.scrollLogs(9);   // 滚轮向上回看 9 行
captured = "";
tuiG.render();
linesG = captured.split("\r\n").map(stripAnsi);
logG = logArea(linesG);
assert.strictEqual(tuiG.scrollOffset, 9, "回看偏移应为 9");
assert.ok(!logG.some(l => l.includes("最新答复在底部")), "回看后最新答复应滚出可视区");
assert.ok(logG.some(l => l.includes("第 13 条")), "回看 9 行后顶部应能看到第 13 条: " + logG[0]);
assert.ok(captured.includes("已回看"), "状态行应显示回看位置");
tuiG.scrollLogs(100); // 滚轮继续向上回看到底
captured = "";
tuiG.render();
logG = logArea(captured.split("\r\n").map(stripAnsi));
assert.ok(logG.some(l => l.includes("第 1 条")), "回看到底应能看到第 1 条");
tuiG.scrollLogs(-100); // 滚轮向下回到最新
captured = "";
tuiG.render();
logG = logArea(captured.split("\r\n").map(stripAnsi));
assert.ok(logG.some(l => l.includes("最新答复在底部")), "滚轮向下应回到最新");
assert.strictEqual(tuiG.scrollOffset, 0, "回到最新后偏移应为 0");
realWrite("测试G ✓ 滚轮回看：+9 行/回到底/回最新 正常，偏移 " + tuiG.scrollOffset + "\n");

// ========== 测试H：SGR 鼠标/翻页序列解析 ==========
const tuiH = new TUI();
for (let i = 1; i <= 50; i++) tuiH.appendLog("system", `第 ${i} 条滚动测试`);
const h0 = tuiH.scrollOffset;
tuiH.onData("\x1b[<64;10;20M");   // 滚轮向上（64, 按下）
assert.strictEqual(tuiH.scrollOffset, h0 + 3, "滚轮向上应 +3 行偏移");
tuiH.onData("\x1b[<64;10;20m");   // 释放事件应忽略
assert.strictEqual(tuiH.scrollOffset, h0 + 3, "释放事件不应重复滚动");
tuiH.onData("\x1b[<65;10;20M");   // 滚轮向下
assert.strictEqual(tuiH.scrollOffset, h0, "滚轮向下应 -3 行偏移");
tuiH.onData("\x1b[<0;10;20M");    // 左键点击应忽略
assert.strictEqual(tuiH.scrollOffset, h0, "非滚轮按键应忽略");
tuiH.onData("\x1b[5~");           // PageUp 回看一屏（viewRows=20）
assert.strictEqual(tuiH.scrollOffset, h0 + 20, "PageUp 应 +1 屏偏移");
tuiH.onData("\x1b[H");            // Home 回看到底
assert.ok(tuiH.scrollOffset > h0 + 20, "Home 应回看到底（offset 被钳制为最大回看）");
const topOffset = tuiH.scrollOffset;
tuiH.onData("\x1b[6~");           // PageDown 回最新一屏
assert.strictEqual(tuiH.scrollOffset, Math.max(0, topOffset - 20), "PageDown 应 -1 屏偏移");
tuiH.onData("\x1b[F");            // End 回到最新
assert.strictEqual(tuiH.scrollOffset, 0, "End 应回到最新");
realWrite(`测试H ✓ 鼠标/翻页序列解析：滚轮±3、PageUp/Down、Home/End、忽略释放与点击\n`);

realWrite("全部渲染测试通过 ✓\n");
