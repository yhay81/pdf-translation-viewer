// *.pdf を開く custom editor。Webview に PDF の中身を渡し、Webview からの翻訳依頼を翻訳サービスへつなぐ。
import * as path from "node:path";
import * as vscode from "vscode";
import type { HostToWebview, WebviewReport, WebviewToHost } from "./shared/protocol";
import type { ModelRegistry } from "./translation/models";
import type { TranslationService } from "./translation/service";

class PdfDocument implements vscode.CustomDocument {
  constructor(readonly uri: vscode.Uri) {}
  dispose(): void {}
}

export interface ReportEvent {
  uri: string;
  report: WebviewReport;
}

function describeError(err: unknown): string {
  if (err instanceof vscode.LanguageModelError) {
    switch (err.code) {
      case vscode.LanguageModelError.NoPermissions.name:
        return "このモデルを使う許可がありません。確認のダイアログで許可するか、組織の設定を確認してください。";
      case vscode.LanguageModelError.Blocked.name:
        return `リクエストが拒否されました（利用上限、またはコンテンツのフィルター）。${err.message}`;
      case vscode.LanguageModelError.NotFound.name:
        return "選んだモデルが見つかりません。モデルを選び直してください。";
    }
  }
  return err instanceof Error ? err.message : String(err);
}

export class PdfEditorProvider implements vscode.CustomReadonlyEditorProvider<PdfDocument> {
  static readonly viewType = "bilingualPdf.viewer";

  private readonly panels = new Set<vscode.WebviewPanel>();
  private readonly reported = new vscode.EventEmitter<ReportEvent>();
  /** Webview からの進捗報告。結合テストで使う。 */
  readonly onReport = this.reported.event;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly models: ModelRegistry,
    private readonly service: TranslationService,
    private readonly log: vscode.LogOutputChannel,
  ) {
    models.onDidChange(() => this.broadcast({ type: "modelChanged", modelLabel: models.label }));
  }

  openCustomDocument(uri: vscode.Uri): PdfDocument {
    return new PdfDocument(uri);
  }

  resolveCustomEditor(document: PdfDocument, panel: vscode.WebviewPanel): void {
    const webview = panel.webview;
    const assetRoot = vscode.Uri.joinPath(this.context.extensionUri, "dist", "webview");
    // PDF の中身はメッセージで渡すので、Webview に読ませるのは拡張自身の dist/webview だけでよい。
    webview.options = { enableScripts: true, localResourceRoots: [assetRoot] };
    const asset = (...segments: string[]) => webview.asWebviewUri(vscode.Uri.joinPath(assetRoot, ...segments)).toString();

    let disposed = false;
    const requests = new Map<number, vscode.CancellationTokenSource>();
    const send = (message: HostToWebview) => {
      if (!disposed) void webview.postMessage(message);
    };

    this.panels.add(panel);
    panel.onDidDispose(() => {
      disposed = true;
      this.panels.delete(panel);
      for (const source of requests.values()) source.cancel();
    });

    webview.onDidReceiveMessage(async (message: WebviewToHost) => {
      switch (message.type) {
        case "ready": {
          // readFile が返すのは Node の Buffer で、そのまま postMessage すると JSON（{ type: "Buffer", data: [...] }）に
          // 変換されてしまう。素の Uint8Array に写せば、バイナリのまま Webview へ転送される。
          const data = new Uint8Array(await vscode.workspace.fs.readFile(document.uri));
          send({
            type: "init",
            fileName: path.basename(document.uri.path),
            data,
            assets: {
              workerUrl: asset("pdf.worker.min.mjs"),
              cMapUrl: asset("cmaps") + "/",
              standardFontDataUrl: asset("standard_fonts") + "/",
              wasmUrl: asset("wasm") + "/",
            },
            modelLabel: this.models.label,
          });
          break;
        }
        case "translatePage": {
          const source = new vscode.CancellationTokenSource();
          requests.set(message.requestId, source);
          try {
            const backend = await this.models.resolve(true);
            if (!backend) {
              send({ type: "translateError", requestId: message.requestId, message: "モデルが選ばれていません。" });
              break;
            }
            const { missing } = await this.service.translate(
              message.blocks,
              backend,
              (id, text, cached) => send({ type: "blockTranslated", requestId: message.requestId, id, text, cached }),
              source.token,
            );
            send({ type: "translateDone", requestId: message.requestId, missing, modelLabel: backend.label });
          } catch (err) {
            this.log.error(`翻訳に失敗しました（${message.page} ページ）`, err);
            send({ type: "translateError", requestId: message.requestId, message: describeError(err) });
          } finally {
            requests.delete(message.requestId);
            source.dispose();
          }
          break;
        }
        case "cancel":
          requests.get(message.requestId)?.cancel();
          break;
        case "selectModel":
          await this.models.pick();
          break;
        case "report":
          this.log.info(`[webview] ${JSON.stringify(message.event)}`);
          this.reported.fire({ uri: document.uri.toString(), report: message.event });
          break;
      }
    });

    webview.html = this.html(webview, assetRoot);
  }

  /** 前面にあるビューアに「表示中のページを翻訳」を指示する。 */
  translateCurrentPage(): boolean {
    const active = [...this.panels].find((panel) => panel.active) ?? [...this.panels].find((panel) => panel.visible);
    if (!active) return false;
    void active.webview.postMessage({ type: "command", name: "translateCurrentPage" } satisfies HostToWebview);
    return true;
  }

  private broadcast(message: HostToWebview): void {
    for (const panel of this.panels) void panel.webview.postMessage(message);
  }

  private html(webview: vscode.Webview, assetRoot: vscode.Uri): string {
    const script = webview.asWebviewUri(vscode.Uri.joinPath(assetRoot, "main.js"));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(assetRoot, "style.css"));
    const source = webview.cspSource;
    // blob: は PDF.js の Worker を起動するため、wasm-unsafe-eval は PDF.js の画像デコーダー（WASM）のために必要。
    const csp = [
      "default-src 'none'",
      `script-src ${source} blob: 'wasm-unsafe-eval'`,
      "worker-src blob:",
      `style-src ${source} 'unsafe-inline'`,
      `font-src ${source} data: blob:`,
      `img-src ${source} data: blob:`,
      `connect-src ${source} data: blob:`,
    ].join("; ");
    return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${style}">
<title>Bilingual PDF Viewer</title>
</head>
<body>
<script type="module" src="${script}"></script>
</body>
</html>`;
  }

  dispose(): void {
    this.reported.dispose();
  }
}
