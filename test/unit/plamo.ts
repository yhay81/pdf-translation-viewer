import assert from "node:assert/strict";
import { test } from "node:test";
import type { CancellationToken } from "vscode";
import { BlockStreamParser } from "../../src/translation/blockProtocol";
import { PLAMO_MODEL, PlamoBackend, PlamoError } from "../../src/translation/plamo";

const blocks = [{ id: "p1-0", text: "Salt & pepper" }];

function tokenFor(signal = new AbortController().signal): CancellationToken {
  return {
    get isCancellationRequested() { return signal.aborted; },
    onCancellationRequested(listener) {
      signal.addEventListener("abort", listener);
      return { dispose: () => signal.removeEventListener("abort", listener) };
    },
  };
}

async function collect(backend: PlamoBackend, token = tokenFor()): Promise<string[]> {
  const fragments: string[] = [];
  for await (const text of backend.stream(blocks, "Japanese", token)) fragments.push(text);
  return fragments;
}

test("PLaMo sends the page prompt and streams only translated text across UTF-8 and event boundaries", async (t) => {
  const event = (delta: object) => "data: " + JSON.stringify({ choices: [{ delta }] });
  const bytes = new TextEncoder().encode([
    ": keep-alive",
    event({ role: "assistant" }),
    event({ reasoning_content: "private reasoning" }),
    event({ content: '<b id="p1-0">塩' }),
    event({ content: "と胡椒</b>" }),
    'data: {"choices": [], "usage": {"total_tokens": 10}}',
    "data: [DONE]",
  ].join("\r\n\r\n"));
  const request = t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.equal(url, "https://api.platform.preferredai.jp/v1/chat/completions");
    assert.equal(init.method, "POST");
    assert.equal(new Headers(init.headers).get("Authorization"), "Bearer test-key");
    const body = JSON.parse(String(init.body));
    assert.equal(body.model, "plamo-3.1-prime");
    assert.equal(body.stream, true);
    assert.equal(body.messages[0].role, "user");
    assert.match(body.messages[0].content, /into natural, accurate Japanese/);
    assert.match(body.messages[0].content, /<b id="p1-0">Salt &amp; pepper<\/b>/);
    return new Response(new ReadableStream({
      start(controller) {
        for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
        controller.close();
      },
    }));
  });
  const backend = new PlamoBackend("test-key");
  const fragments = await collect(backend);
  assert.equal(request.mock.callCount(), 1);
  assert.deepEqual(fragments, ['<b id="p1-0">塩', "と胡椒</b>"]);
  const parser = new BlockStreamParser();
  assert.deepEqual(fragments.flatMap((fragment) => parser.push(fragment)), [{ id: "p1-0", text: "塩と胡椒" }]);
  assert.equal(backend.id, `plamo:${PLAMO_MODEL.id}`);
});

test("PLaMo reports HTTP failures and malformed or interrupted streams without including request or response text", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch");
  for (const [body, status, reason] of [
    ["private text", 401, 401],
    ["private text", 429, 429],
    ["data: private text\n\n", 200, "response"],
    ['data: {"error":{"message":"private text"}}\n\n', 200, "response"],
    ['data: {"choices":[]}\n\n', 200, "response"],
  ] as const) {
    fetch.mock.mockImplementation(async () => new Response(body, { status }));
    await assert.rejects(collect(new PlamoBackend("test-key")), (err) =>
      err instanceof PlamoError && err.reason === reason && !/private text|test-key/.test(err.message),
    );
  }
});

test("cancelling a PLaMo translation aborts its HTTP request, and an already cancelled page makes no request", async (t) => {
  const source = new AbortController();
  const token = tokenFor(source.signal);
  let started!: () => void;
  const pending = new Promise<void>((resolve) => { started = resolve; });
  const request = t.mock.method(globalThis, "fetch", (_url: string, init: RequestInit) => new Promise<Response>((_, reject) => {
    init.signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    started();
  }));
  const backend = new PlamoBackend("test-key");
  const result = collect(backend, token);
  await pending;
  source.abort();
  assert.deepEqual(await result, []);
  assert.deepEqual(await collect(backend, token), []);
  assert.equal(request.mock.callCount(), 1);
});
