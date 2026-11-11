// 拡張ホストの代役。acquireVsCodeApi を用意し、PDF を渡し、翻訳依頼にはフィクスチャの訳文を返す。
// URL の ?pdf= で別の PDF、?mode=dummy でフィクスチャを使わないダミー訳、?auto=1 で読み込み直後の自動翻訳に切り替えられる。
import { FIXTURES } from "/harness/fixtures/ja.js";

const params = new URLSearchParams(location.search);
const pdfUrl = params.get("pdf") ?? "/samples/sample.pdf";
const mode = params.get("mode") ?? "fixture";
const delay = Number(params.get("delay") ?? 60);
const auto = params.get("auto") === "1";
let started = false;

const normalize = (text) => text.toLowerCase().replace(/[^a-z0-9]+/g, "");
const fixtures = FIXTURES.map((entry) => ({ ...entry, key: normalize(entry.source) }));

/** 原文の先頭がフィクスチャと合えば、その訳文を返す。 */
function lookup(source) {
  const text = normalize(source);
  for (const entry of fixtures) {
    const at = text.indexOf(entry.key);
    if (at < 0 || at > 6) continue;
    // 短い見出しやセルは、本文の書き出しと取り違えないよう、長さもほぼ同じものに限る。
    if (entry.key.length < 24 && text.length > entry.key.length + 6) continue;
    return entry.keep ? source : entry.ja;
  }
  return undefined;
}

/** モデルを呼ばないダミー訳。原文のおよそ 0.55 倍の長さにする。 */
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
        modelLabel: mode === "dummy" ? "ダミー翻訳" : "フィクスチャ訳",
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
      toWebview({ type: "translateDone", requestId: message.requestId, missing, modelLabel: mode === "dummy" ? "ダミー翻訳" : "フィクスチャ訳" });
      break;
    }
    case "cancel":
      cancelled.add(message.requestId);
      break;
    case "selectModel":
      console.info("[mock-host] モデル選択が呼ばれました（ハーネスでは何もしません）");
      break;
    case "report":
      reports.push(message.event);
      console.info("[report]", JSON.stringify(message.event));
      // ?auto=1 なら、1 ページ目が描けた時点で翻訳を始める（画面の自動撮影用）。
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
