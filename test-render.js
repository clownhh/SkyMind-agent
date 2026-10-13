const { TUI, charWidth } = require("./agent");

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

// 确认危险命令后仍处于运行态，不能提交第二个任务。
for (const key of ["y", "n", "\x03"]) {
  const tui = new TUI();
  tui.running = true;
  const confirmation = tui.promptConfirm("shutdown");
  tui.handleKey(key);
  assert.strictEqual(tui.mode, "running");
  assert.strictEqual(tui.confirmCtx, null);
  assert.strictEqual(tui.abort.signal.aborted, key === "\x03");
  tui.input = "第二个任务";
  tui.handleKey("\r");
  tui.submit();
  assert.strictEqual(tui.history.length, 0, "确认后不能并发提交任务");
  confirmation.then(ok => assert.strictEqual(ok, key === "y"));
}
realWrite("测试I ✓ 确认/拒绝保持运行态，Ctrl+C 中断，阻止并发任务\n");
process.stdout.write = realWrite;
realWrite("全部渲染测试通过 ✓\n");
