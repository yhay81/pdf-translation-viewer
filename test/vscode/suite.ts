// 実際の VS Code の中で動かす結合テスト。サンプル PDF を custom editor で開き、
// Webview での描画（Worker の起動、CSP）と、ダミー翻訳による 1 ページの翻訳までを確かめる。
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import type { BilingualPdfApi } from "../../src/extension";
import type { WebviewReport } from "../../src/shared/protocol";

type Of<K extends WebviewReport["kind"]> = Extract<WebviewReport, { kind: K }>;

export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension<BilingualPdfApi>("local-spike.bilingual-pdf-viewer");
  assert.ok(extension, "拡張が読み込まれていません");
  const api = await extension.activate();

  const reports: WebviewReport[] = [];
  const listeners = new Set<() => void>();
  api.onReport((event) => {
    reports.push(event.report);
    for (const listener of listeners) listener();
  });

  /** 条件に合う報告が届くまで待つ。 */
  function waitFor<K extends WebviewReport["kind"]>(kind: K, match: (report: Of<K>) => boolean, timeoutMs: number): Promise<Of<K>> {
    return new Promise((resolve, reject) => {
      const check = () => {
        const found = reports.find((report): report is Of<K> => report.kind === kind && match(report as Of<K>));
        if (!found) return false;
        clearTimeout(timer);
        listeners.delete(check);
        resolve(found);
        return true;
      };
      const timer = setTimeout(() => {
        listeners.delete(check);
        reject(new Error(`${kind} の報告が ${timeoutMs} ms 以内に届きませんでした。届いた報告: ${JSON.stringify(reports)}`));
      }, timeoutMs);
      if (!check()) listeners.add(check);
    });
  }

  const pdf = vscode.Uri.file(path.join(extension.extensionPath, "samples", "sample.pdf"));
  await vscode.commands.executeCommand("vscode.openWith", pdf, "bilingualPdf.viewer");

  const loaded = await waitFor("documentLoaded", () => true, 30_000);
  assert.equal(loaded.pages, 2, "ページ数");
  assert.equal(loaded.workerKind, "worker", "PDF.js が Worker で動いていること");
  const rendered = await waitFor("pageRendered", (report) => report.page === 1, 30_000);

  await vscode.commands.executeCommand("bilingualPdf.translateCurrentPage");
  const translated = await waitFor("pageTranslated", () => true, 60_000);
  assert.equal(translated.page, 1);
  assert.ok(translated.requested >= 20, `翻訳を依頼したブロック数: ${translated.requested}`);
  assert.equal(translated.missing, 0, "訳文が返らなかったブロック");
  assert.equal(translated.placed + translated.kept, translated.requested, "すべてのブロックが処理されること");
  assert.ok(translated.placed >= 20, `置いた訳文の数: ${translated.placed}`);
  assert.equal(translated.inkRemoved, translated.placed, "訳文を置いたブロックでは原文の文字が消えていること");

  const models = await vscode.commands.executeCommand<unknown[]>("bilingualPdf.listModels");
  assert.ok(Array.isArray(models));

  const errors = reports.filter((report) => report.kind === "error");
  assert.deepEqual(errors, [], "Webview でエラーや CSP 違反が起きていないこと");

  const result = { vscode: vscode.version, loaded, rendered, translated, models, reports: reports.length };
  if (process.env.BILINGUAL_PDF_RESULT) fs.writeFileSync(process.env.BILINGUAL_PDF_RESULT, JSON.stringify(result, null, 2));
  console.log(`[bilingual-pdf] ${JSON.stringify(result)}`);
}
