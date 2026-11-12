// The custom editor that opens *.pdf. It hands the bytes of the PDF to the webview, and passes the
// webview's translation requests on to the translation service.
import * as path from "node:path";
import * as vscode from "vscode";
import { cleanTargetLanguage } from "./shared/language";
import type { HostToWebview, WebviewReport, WebviewToHost } from "./shared/protocol";
import { WEBVIEW_STRINGS } from "./shared/strings";
import type { ModelRegistry } from "./translation/models";
import { PlamoError } from "./translation/plamo";
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
  if (err instanceof PlamoError) {
    switch (err.reason) {
      case 401:
      case 403:
        return vscode.l10n.t("PLaMo denied access (HTTP {0}). Check your key with the Set PLaMo API Key command and verify your account permissions.", err.reason);
      case 429:
        return vscode.l10n.t("PLaMo's usage limit was reached. Check your API quota and try again later.");
      case "connection":
        return vscode.l10n.t("The connection to PLaMo failed. Check your connection and try again.");
      case "response":
        return vscode.l10n.t("PLaMo returned an invalid or incomplete response. Try translating the page again.");
      default:
        return vscode.l10n.t("The PLaMo API request failed (HTTP {0}).", err.reason);
    }
  }
  if (err instanceof vscode.LanguageModelError) {
    switch (err.code) {
      case vscode.LanguageModelError.NoPermissions.name:
        return vscode.l10n.t("This extension is not allowed to use the model. Allow it in the dialog that VS Code shows, or check the settings of your organization.");
      case vscode.LanguageModelError.Blocked.name:
        return vscode.l10n.t("The request was blocked, by a usage limit or a content filter. {0}", err.message);
      case vscode.LanguageModelError.NotFound.name:
        return vscode.l10n.t("The chosen model was not found. Choose a model again.");
    }
  }
  return err instanceof Error ? err.message : String(err);
}

/** The language to translate into, from the setting pdfTranslation.targetLanguage. */
function targetLanguage(): string {
  return cleanTargetLanguage(vscode.workspace.getConfiguration("pdfTranslation").get("targetLanguage"));
}

export class PdfEditorProvider implements vscode.CustomReadonlyEditorProvider<PdfDocument> {
  static readonly viewType = "pdfTranslation.viewer";

  private readonly panels = new Set<vscode.WebviewPanel>();
  private readonly reported = new vscode.EventEmitter<ReportEvent>();
  /** The progress reports of the webviews, for the end-to-end test. */
  readonly onReport = this.reported.event;
  private readonly subscriptions: vscode.Disposable[] = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly models: ModelRegistry,
    private readonly service: TranslationService,
    private readonly log: vscode.LogOutputChannel,
  ) {
    this.subscriptions.push(
      models.onDidChange(() => this.broadcast({ type: "modelChanged", modelLabel: models.label })),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("pdfTranslation.targetLanguage")) {
          this.broadcast({ type: "targetLanguageChanged", targetLanguage: targetLanguage() });
        }
      }),
    );
  }

  openCustomDocument(uri: vscode.Uri): PdfDocument {
    return new PdfDocument(uri);
  }

  resolveCustomEditor(document: PdfDocument, panel: vscode.WebviewPanel): void {
    const webview = panel.webview;
    const assetRoot = vscode.Uri.joinPath(this.context.extensionUri, "dist", "webview");
    // The PDF itself goes to the webview in a message, so the webview only needs to read the extension's own dist/webview.
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
          // readFile returns a Node Buffer, which postMessage would turn into JSON ({ type: "Buffer", data: [...] }).
          // Copied into a plain Uint8Array, it travels to the webview as binary.
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
            targetLanguage: targetLanguage(),
          });
          break;
        }
        case "translatePage": {
          const source = new vscode.CancellationTokenSource();
          requests.set(message.requestId, source);
          try {
            const previousModel = this.models.label;
            const backend = await this.models.resolve();
            if (source.token.isCancellationRequested) break;
            if (!backend) {
              send({ type: "translateError", requestId: message.requestId, message: vscode.l10n.t("No model is chosen.") });
              break;
            }
            // Replacing an unavailable model clears the webview's old translations. Ask for its
            // full set of blocks again before sending any of the old request to the new model.
            if (previousModel !== null && previousModel !== this.models.label) {
              send({ type: "retryPage", page: message.page });
              break;
            }
            const { missing } = await this.service.translate(
              message.blocks,
              backend,
              targetLanguage(),
              (id, text, cached) => send({ type: "blockTranslated", requestId: message.requestId, id, text, cached }),
              source.token,
            );
            send({ type: "translateDone", requestId: message.requestId, missing, modelLabel: backend.label });
          } catch (err) {
            this.log.error(`Translating page ${message.page} failed`, err);
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

  /** Tells the viewer in front to translate the page on screen. */
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
    // blob: starts the PDF.js worker, and wasm-unsafe-eval runs the image decoders of PDF.js, which are WebAssembly.
    const csp = [
      "default-src 'none'",
      `script-src ${source} blob: 'wasm-unsafe-eval'`,
      "worker-src blob:",
      `style-src ${source} 'unsafe-inline'`,
      `font-src ${source} data: blob:`,
      `img-src ${source} data: blob:`,
      `connect-src ${source} data: blob:`,
    ].join("; ");
    // The messages of the webview in the display language. As a JSON data block it is not run as a script,
    // and < is escaped so that no text can close the element.
    const strings = Object.fromEntries(Object.entries(WEBVIEW_STRINGS).map(([key, message]) => [key, vscode.l10n.t(message)]));
    const l10n = JSON.stringify(strings).replace(/</g, "\\u003c");
    return `<!DOCTYPE html>
<html lang="${vscode.env.language}">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${style}">
<title>PDF Translation Viewer</title>
</head>
<body>
<script id="l10n" type="application/json">${l10n}</script>
<script type="module" src="${script}"></script>
</body>
</html>`;
  }

  dispose(): void {
    for (const subscription of this.subscriptions) subscription.dispose();
    this.reported.dispose();
  }
}
