// The end-to-end test, which runs inside a real VS Code. It opens the sample PDF in the custom
// editor, and checks the rendering in the webview (the worker starts, nothing violates the CSP)
// and the translation of one page with the dummy backend.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as vscode from "vscode";
import type { PdfTranslationApi } from "../../src/extension";
import type { WebviewReport } from "../../src/shared/protocol";

type Of<K extends WebviewReport["kind"]> = Extract<WebviewReport, { kind: K }>;

export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension<PdfTranslationApi>("yhay81.pdf-translation-viewer");
  assert.ok(extension, "the extension is not loaded");
  const api = await extension.activate();

  const reports: WebviewReport[] = [];
  const listeners = new Set<() => void>();
  api.onReport((event) => {
    reports.push(event.report);
    for (const listener of listeners) listener();
  });

  /** Waits for a report that matches. */
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
        reject(new Error(`No ${kind} report arrived within ${timeoutMs} ms. Reports so far: ${JSON.stringify(reports)}`));
      }, timeoutMs);
      if (!check()) listeners.add(check);
    });
  }

  // The runner opens the samples folder of the repository as the workspace. The extension under test
  // may be an unpacked package, which has no samples.
  const folder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(folder, "the samples folder is open");
  const pdf = vscode.Uri.joinPath(folder.uri, "sample.pdf");
  await vscode.commands.executeCommand("vscode.openWith", pdf, "pdfTranslation.viewer");

  const loaded = await waitFor("documentLoaded", () => true, 60_000);
  assert.equal(loaded.pages, 2, "number of pages");
  assert.equal(loaded.workerKind, "worker", "PDF.js runs in a worker");
  const rendered = await waitFor("pageRendered", (report) => report.page === 1, 60_000);

  await vscode.commands.executeCommand("pdfTranslation.translateCurrentPage");
  const translated = await waitFor("pageTranslated", () => true, 60_000);
  assert.equal(translated.page, 1);
  assert.ok(translated.requested >= 20, `blocks sent for translation: ${translated.requested}`);
  assert.equal(translated.missing, 0, "blocks without a translation");
  assert.equal(translated.placed + translated.kept, translated.requested, "every block is handled");
  assert.ok(translated.placed >= 20, `translations laid over the page: ${translated.placed}`);
  assert.equal(translated.inkRemoved, translated.placed, "the source text is gone under every translation");

  const models = await vscode.commands.executeCommand<{ id: string }[]>("pdfTranslation.listModels");
  assert.ok(models.some((model) => model.id === "plamo-3.1-prime"), "PLaMo is listed even without a VS Code model or API key");

  const errors = reports.filter((report) => report.kind === "error");
  assert.deepEqual(errors, [], "no error and no CSP violation in the webview");

  const result = { vscode: vscode.version, loaded, rendered, translated, models, reports: reports.length };
  if (process.env.PDF_TRANSLATION_RESULT) fs.writeFileSync(process.env.PDF_TRANSLATION_RESULT, JSON.stringify(result, null, 2));
  console.log(`[pdf-translation-viewer] ${JSON.stringify(result)}`);
}
