import * as vscode from "vscode";
import { PdfEditorProvider, type ReportEvent } from "./pdfEditorProvider";
import { TranslationCache } from "./translation/cache";
import { ModelRegistry } from "./translation/models";
import { TranslationService } from "./translation/service";

/** 結合テストから使う窓口。 */
export interface BilingualPdfApi {
  onReport: vscode.Event<ReportEvent>;
}

let cache: TranslationCache | undefined;

export function activate(context: vscode.ExtensionContext): BilingualPdfApi {
  const log = vscode.window.createOutputChannel("Bilingual PDF", { log: true });
  cache = new TranslationCache(context.globalStorageUri);
  const models = new ModelRegistry(context, log);
  const service = new TranslationService(cache, log);
  const provider = new PdfEditorProvider(context, models, service, log);

  context.subscriptions.push(
    log,
    models,
    provider,
    vscode.window.registerCustomEditorProvider(PdfEditorProvider.viewType, provider, {
      // タブを切り替えても描画と訳文を保つ。
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: false,
    }),
    vscode.commands.registerCommand("bilingualPdf.translateCurrentPage", () => {
      if (!provider.translateCurrentPage()) {
        void vscode.window.showInformationMessage("Bilingual PDF Viewer で PDF を開いてから実行してください。");
      }
    }),
    vscode.commands.registerCommand("bilingualPdf.selectModel", () => models.pick()),
    vscode.commands.registerCommand("bilingualPdf.listModels", async () => {
      const list = await models.list();
      log.info(`利用できるモデル: ${list.length} 件`);
      for (const model of list) {
        log.info(`  vendor=${model.vendor}  family=${model.family}  name=${model.name}  id=${model.id}  maxInputTokens=${model.maxInputTokens}`);
      }
      const vendors = [...new Set(list.map((model) => model.vendor))];
      log.info(
        vendors.length === 0
          ? "モデルが 1 つも返りませんでした。Copilot へのサインインと、組織の設定を確認してください。"
          : `vendor の内訳: ${vendors.join(", ")}（copilot 以外が並んでいれば、VS Code に登録した BYOK のモデルもこの API から使えます）`,
      );
      log.show(true);
      return list.map((model) => ({ vendor: model.vendor, family: model.family, name: model.name, id: model.id }));
    }),
    vscode.commands.registerCommand("bilingualPdf.clearCache", async () => {
      await cache?.load();
      const count = cache?.size ?? 0;
      await cache?.clear();
      void vscode.window.showInformationMessage(`翻訳キャッシュを消しました（${count} 件）。`);
    }),
  );

  return { onReport: provider.onReport };
}

export async function deactivate(): Promise<void> {
  await cache?.flush().catch(() => undefined);
}
