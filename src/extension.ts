import * as vscode from "vscode";
import { PdfEditorProvider, type ReportEvent } from "./pdfEditorProvider";
import { TranslationCache } from "./translation/cache";
import { ModelRegistry } from "./translation/models";
import { TranslationService } from "./translation/service";

/** What the end-to-end test uses. */
export interface PdfTranslationApi {
  onReport: vscode.Event<ReportEvent>;
}

let cache: TranslationCache | undefined;

export function activate(context: vscode.ExtensionContext): PdfTranslationApi {
  const log = vscode.window.createOutputChannel("PDF Translation Viewer", { log: true });
  cache = new TranslationCache(context.globalStorageUri);
  const models = new ModelRegistry(context, log);
  const service = new TranslationService(cache, log);
  const provider = new PdfEditorProvider(context, models, service, log);

  context.subscriptions.push(
    log,
    models,
    provider,
    vscode.window.registerCustomEditorProvider(PdfEditorProvider.viewType, provider, {
      // Keeps the rendering and the translations when the tab is in the background.
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: false,
    }),
    vscode.commands.registerCommand("pdfTranslation.translateCurrentPage", () => {
      if (!provider.translateCurrentPage()) {
        void vscode.window.showInformationMessage(vscode.l10n.t("Open a PDF in PDF Translation Viewer first."));
      }
    }),
    vscode.commands.registerCommand("pdfTranslation.selectModel", () => models.pick()),
    vscode.commands.registerCommand("pdfTranslation.listModels", async () => {
      const list = await models.list();
      log.info(`Language models available to this extension: ${list.length}`);
      for (const model of list) {
        log.info(`  vendor=${model.vendor}  family=${model.family}  name=${model.name}  id=${model.id}  maxInputTokens=${model.maxInputTokens}`);
      }
      const vendors = [...new Set(list.map((model) => model.vendor))];
      log.info(
        vendors.length === 0
          ? "No model was returned. Check that you are signed in to GitHub Copilot, and the settings of your organization."
          : `Vendors: ${vendors.join(", ")}`,
      );
      log.show(true);
      return list.map((model) => ({ vendor: model.vendor, family: model.family, name: model.name, id: model.id }));
    }),
    vscode.commands.registerCommand("pdfTranslation.clearCache", async () => {
      await cache?.load();
      const count = cache?.size ?? 0;
      await cache?.clear();
      void vscode.window.showInformationMessage(vscode.l10n.t("Cleared the translation cache ({0} entries).", count));
    }),
  );

  return { onReport: provider.onReport };
}

export async function deactivate(): Promise<void> {
  await cache?.flush().catch(() => undefined);
}
