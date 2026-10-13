const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createServer } = require("node:http");
const { getEventListeners, once } = require("node:events");
const { createChatClient } = require("./api-client");

const completion = { choices: [{ message: { content: "OK" } }] };

async function withServer(handler, run) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1/`;
  const client = options => createChatClient({
    baseUrl, apiKey: "test-key", model: "test-model",
    toolDefinition: { type: "function", function: { name: "bash" } },
    timeoutMs: 1000, retryDelayMs: 1, ...options,
  });
  try {
    await run(client);
  } finally {
    const closed = new Promise(resolve => server.close(resolve));
    server.closeAllConnections();
    await closed;
  }
}

test("normalizes the URL, content blocks and tool calls; plain calls omit tools", async () => {
  const requests = [];
  await withServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body) });
    res.end(JSON.stringify({ choices: [{ message: { content: [null, "Hello ", { text: "world" }] } }] }));
  }, async client => {
    const call = client();
    assert.deepEqual(await call([{ role: "user", content: "hi" }]), {
      role: "assistant", content: "Hello world", tool_calls: [],
    });
    await call([], { useTools: false });
  });
  assert.equal(requests[0].url, "/v1/chat/completions");
  assert.equal(requests[0].auth, "Bearer test-key");
  assert.equal(requests[0].body.model, "test-model");
  assert.equal(requests[0].body.tools[0].function.name, "bash");
  assert.equal(requests[1].body.tools, undefined);
  assert.equal(requests[1].body.tool_choice, undefined);
});

for (const status of [400, 401, 403]) {
  test(`HTTP ${status} preserves non-JSON diagnostics and is not retried`, async () => {
    let requests = 0;
    await withServer((_req, res) => {
      requests++;
      res.writeHead(status);
      res.end("gateway rejected request");
    }, async client => {
      await assert.rejects(client()([]), new RegExp(`HTTP ${status}.*gateway rejected request`));
    });
    assert.equal(requests, 1);
  });
}

for (const status of [429, 503]) {
  test(`HTTP ${status} retries and releases abort listeners`, async () => {
    let requests = 0;
    await withServer((_req, res) => {
      if (++requests < 3) {
        res.writeHead(status);
        res.end("temporarily unavailable");
      } else res.end(JSON.stringify(completion));
    }, async client => {
      const controller = new AbortController();
      assert.equal((await client()([], { signal: controller.signal })).content, "OK");
      assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    });
    assert.equal(requests, 3);
  });
}

test("the timeout includes a response body stalled after headers", { timeout: 5000 }, async () => {
  let requests = 0;
  await withServer((_req, res) => {
    requests++;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.write('{"choices":'); // Headers arrive, but the body never completes.
  }, async client => {
    const controller = new AbortController();
    await assert.rejects(client({ timeoutMs: 100 })([], { signal: controller.signal }), /请求超时/);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  });
  assert.equal(requests, 3);
});

test("abort during response body reading stops without retry", { timeout: 5000 }, async () => {
  let requests = 0;
  const controller = new AbortController();
  await withServer((_req, res) => {
    requests++;
    res.write('{"choices":');
    setTimeout(() => controller.abort(), 50);
  }, async client => {
    await assert.rejects(client()([], { signal: controller.signal }), /任务已中断/);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  });
  assert.equal(requests, 1);
});

test("abort interrupts the retry delay and prevents further requests", { timeout: 5000 }, async () => {
  let requests = 0;
  const controller = new AbortController();
  await withServer((_req, res) => {
    requests++;
    res.writeHead(503);
    res.end("retry later");
    setTimeout(() => controller.abort(), 100);
  }, async client => {
    await assert.rejects(client({ retryDelayMs: 10_000 })([], { signal: controller.signal }), /任务已中断/);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  });
  assert.equal(requests, 1);
});

test("an already aborted signal sends no request", async () => {
  let requests = 0;
  await withServer((_req, res) => { requests++; res.end(JSON.stringify(completion)); }, async client => {
    await assert.rejects(client()([], { signal: AbortSignal.abort() }), /任务已中断/);
  });
  assert.equal(requests, 0);
});

for (const [label, response] of [
  ["missing message", '{"choices":[{}]}'],
  ["non-array tool calls", '{"choices":[{"message":{"tool_calls":{}}}]}'],
]) {
  test(`invalid response (${label}) exhausts retries with a useful error`, async () => {
    let requests = 0;
    await withServer((_req, res) => { requests++; res.end(response); }, async client => {
      await assert.rejects(client()([]), /缺少有效 message/);
    });
    assert.equal(requests, 3);
  });
}

test("tool calls with null content are preserved", async () => {
  const toolCalls = [{ id: "call_1", type: "function", function: { name: "bash", arguments: '{"cmd":"pwd"}' } }];
  await withServer((_req, res) => {
    res.end(JSON.stringify({ choices: [{ message: { content: null, tool_calls: toolCalls } }] }));
  }, async client => {
    assert.deepEqual(await client()([]), { role: "assistant", content: "", tool_calls: toolCalls });
  });
});
