// 翻訳に使うモデルの選択。vscode.lm が返すモデル（Copilot と、VS Code に登録した BYOK のモデル）から選ぶ。
import * as vscode from "vscode";
import { MockBackend, VscodeLmBackend, type TranslationBackend } from "./backends";

type StoredChoice = { kind: "mock" } | { kind: "vscode-lm"; id: string; vendor: string; name: string };

const STATE_KEY = "bilingualPdf.model";

interface ModelItem extends vscode.QuickPickItem {
  choice: StoredChoice;
}

export class ModelRegistry {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly log: vscode.LogOutputChannel,
  ) {}

  /** 結合テストなどで、モデルを呼ばないダミーに固定する。 */
  private get forcedMock(): boolean {
    return process.env.BILINGUAL_PDF_BACKEND === "mock";
  }

  private get stored(): StoredChoice | undefined {
    return this.context.globalState.get<StoredChoice>(STATE_KEY);
  }

  /** ツールバーに出す、選択中のモデルの名前。 */
  get label(): string | null {
    if (this.forcedMock) return new MockBackend().label;
    const stored = this.stored;
    if (!stored) return null;
    return stored.kind === "mock" ? new MockBackend().label : `${stored.name}（${stored.vendor}）`;
  }

  async list(): Promise<vscode.LanguageModelChat[]> {
    try {
      // 絞り込みなしで呼ぶと、この拡張から使えるすべてのモデルが返る。
      return await vscode.lm.selectChatModels();
    } catch (err) {
      this.log.warn(`モデルの一覧を取得できませんでした: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  /** 一覧から選ばせて保存する。キャンセルされたら undefined。 */
  async pick(): Promise<TranslationBackend | undefined> {
    const models = await this.list();
    const items: ModelItem[] = models.map((model) => ({
      label: model.name,
      description: `${model.vendor} · ${model.family}`,
      detail: `id: ${model.id} ／ 入力上限 ${model.maxInputTokens.toLocaleString()} トークン`,
      choice: { kind: "vscode-lm", id: model.id, vendor: model.vendor, name: model.name },
    }));
    items.push({
      label: "ダミー翻訳（検証用）",
      description: "モデルを呼ばず、表示だけを確かめる",
      choice: { kind: "mock" },
    });
    const picked = await vscode.window.showQuickPick(items, {
      title: "翻訳に使うモデル",
      placeHolder:
        models.length > 0
          ? "モデルを選んでください"
          : "使えるモデルが見つかりません。Copilot にサインインするか、VS Code の「言語モデルの管理」でモデルを追加してください",
      matchOnDescription: true,
    });
    if (!picked) return undefined;
    await this.context.globalState.update(STATE_KEY, picked.choice);
    this.changed.fire();
    return this.resolve(false);
  }

  /** 保存してある選択から呼び出し先を作る。未選択で interactive なら、その場で選ばせる。 */
  async resolve(interactive: boolean): Promise<TranslationBackend | undefined> {
    if (this.forcedMock) return new MockBackend();
    const stored = this.stored;
    if (stored?.kind === "mock") return new MockBackend();
    if (stored?.kind === "vscode-lm") {
      const [model] = await vscode.lm.selectChatModels({ vendor: stored.vendor, id: stored.id });
      if (model) return new VscodeLmBackend(model);
      this.log.warn(`保存してあったモデル ${stored.name}（${stored.vendor}）が見つかりません。`);
    }
    return interactive ? this.pick() : undefined;
  }

  dispose(): void {
    this.changed.dispose();
  }
}
