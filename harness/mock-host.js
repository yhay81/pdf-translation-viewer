// A stand-in for the extension host. It provides acquireVsCodeApi, hands over the PDF, and answers translation requests with the translations in the fixtures.
// In the URL, ?pdf= switches to another PDF, ?mode=dummy to dummy translations that do not use the fixtures, and ?auto=1 to translating automatically right after loading.
import { FIXTURES } from "/harness/fixtures/ja.js";

const params = new URLSearchParams(location.search);
const pdfUrl = params.get("pdf") ?? "/samples/sample.pdf";
const mode = params.get("mode") ?? "fixture";
const delay = Number(params.get("delay") ?? 60);
const auto = params.get("auto") === "1";
let started = false;

const normalize = (text) => text.toLowerCase().replace(/[^a-z0-9]+/g, "");
const fixtures = FIXTURES.map((entry) => ({ ...entry, key: normalize(entry.source) }));

/** Returns the translation of a fixture when the start of the source matches it. */
function lookup(source) {
  const text = normalize(source);
  for (const entry of fixtures) {
    const at = text.indexOf(entry.key);
    if (at < 0 || at > 6) continue;
    // A short heading or cell matches only a source of nearly the same length, so that the opening of a body paragraph is not mistaken for it.
    if (entry.key.length < 24 && text.length > entry.key.length + 6) continue;
    return entry.keep ? source : entry.ja;
  }
  return undefined;
}

/** A dummy translation that calls no model. It is made about 0.55 times as long as the source. */
function dummy(source) {
  const seed = "これは表示の確認に使うダミーの訳文です。実際の翻訳ではありません。";
  const length = Math.max(4, Math.round(source.length * 0.55));
  let out = "";
  while (out.length < length) out += seed;
  return out.slice(0, length);
}

const reports = [];
const requests = [];
const cancelled = new Set();
window.__reports = reports;
window.__requests = requests;

const toWebview = (message) => window.postMessage(message, location.origin);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function onMessage(message) {
  switch (message.type) {
    case "ready": {
      const data = new Uint8Array(await (await fetch(pdfUrl)).arrayBuffer());
      toWebview({
        type: "init",
        fileName: pdfUrl.split("/").pop(),
        data,
        assets: {
          workerUrl: "/dist/webview/pdf.worker.min.mjs",
          cMapUrl: "/dist/webview/cmaps/",
          standardFontDataUrl: "/dist/webview/standard_fonts/",
          wasmUrl: "/dist/webview/wasm/",
        },
        modelLabel: mode === "dummy" ? "Dummy translation" : "Fixture translation",
        targetLanguage: "Japanese",
      });
      break;
    }
    case "translatePage": {
      requests.push(message);
      const missing = [];
      for (const block of message.blocks) {
        if (cancelled.has(message.requestId)) return;
        await sleep(delay);
        const text = mode === "dummy" ? dummy(block.text) : (lookup(block.text) ?? dummy(block.text));
        toWebview({ type: "blockTranslated", requestId: message.requestId, id: block.id, text, cached: false });
      }
      toWebview({ type: "translateDone", requestId: message.requestId, missing, modelLabel: mode === "dummy" ? "Dummy translation" : "Fixture translation" });
      break;
    }
    case "cancel":
      cancelled.add(message.requestId);
      break;
    case "selectModel":
      console.info("[mock-host] Model selection was requested (the harness does nothing)");
      break;
    case "report":
      reports.push(message.event);
      console.info("[report]", JSON.stringify(message.event));
      // With ?auto=1, translation starts as soon as page 1 is rendered (for taking screenshots automatically).
      if (auto && !started && message.event.kind === "pageRendered" && message.event.page === 1) {
        started = true;
        toWebview({ type: "command", name: "translateCurrentPage" });
      }
      break;
  }
}

window.acquireVsCodeApi = () => ({
  postMessage(message) {
    void onMessage(message).catch((err) => console.error("[mock-host]", err));
  },
});
