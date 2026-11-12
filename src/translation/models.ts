// The choice of the model to translate with, among the models that vscode.lm offers: GitHub Copilot
// and the other language models registered in VS Code.
import * as vscode from "vscode";
import { MockBackend, VscodeLmBackend, type TranslationBackend } from "./backends";

type StoredChoice = { kind: "mock" } | { kind: "vscode-lm"; id: string; vendor: string; name: string };

const STATE_KEY = "pdfTranslation.model";

/**
 * Some extensions register entries that are not models to send a request to, such as a prompt to
 * set the extension up. They report an input limit of 0 or 1 token. The list to choose from leaves
 * out every entry whose limit is too small for even a short paragraph.
 */
const MIN_INPUT_TOKENS = 256;

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

  /** The end-to-end test fixes the backend to the dummy, so that it calls no model. */
  private get forcedMock(): boolean {
    return process.env.PDF_TRANSLATION_BACKEND === "mock";
  }

  /** The dummy is offered only while developing the extension, never in an installed one. */
  private get offersMock(): boolean {
    return this.context.extensionMode !== vscode.ExtensionMode.Production;
  }

  private get stored(): StoredChoice | undefined {
    const stored = this.context.globalState.get<StoredChoice>(STATE_KEY);
    return stored?.kind === "mock" && !this.offersMock ? undefined : stored;
  }

  /** The name of the chosen model, for the toolbar. */
  get label(): string | null {
    if (this.forcedMock) return new MockBackend().label;
    const stored = this.stored;
    if (!stored) return null;
    return stored.kind === "mock" ? new MockBackend().label : `${stored.name} (${stored.vendor})`;
  }

  async list(): Promise<vscode.LanguageModelChat[]> {
    try {
      // Without a selector, this returns every model the extension may use.
      return await vscode.lm.selectChatModels();
    } catch (err) {
      this.log.warn(`Could not list the language models: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  /** Lets the user choose from the list and stores the choice. Returns undefined when cancelled. */
  async pick(): Promise<TranslationBackend | undefined> {
    const models: vscode.LanguageModelChat[] = [];
    for (const model of await this.list()) {
      if (model.maxInputTokens >= MIN_INPUT_TOKENS) models.push(model);
      else this.log.info(`Not offered, because its input limit is ${model.maxInputTokens} tokens: ${model.name} (${model.vendor})`);
    }
    const items: ModelItem[] = models.map((model) => ({
      label: model.name,
      description: `${model.vendor} · ${model.family}`,
      detail: vscode.l10n.t("ID: {0} · up to {1} input tokens", model.id, model.maxInputTokens.toLocaleString()),
      choice: { kind: "vscode-lm", id: model.id, vendor: model.vendor, name: model.name },
    }));
    if (this.offersMock) {
      items.push({
        label: vscode.l10n.t("Dummy translation (for development)"),
        description: vscode.l10n.t("Lays out placeholder text without calling a model"),
        choice: { kind: "mock" },
      });
    }
    const picked = await vscode.window.showQuickPick(items, {
      title: vscode.l10n.t("Model to Translate With"),
      placeHolder:
        models.length > 0
          ? vscode.l10n.t("Choose a model")
          : vscode.l10n.t("No language model is available. Sign in to GitHub Copilot, or add a model to VS Code from the model picker of the Chat view."),
      matchOnDescription: true,
    });
    if (!picked) return undefined;
    await this.context.globalState.update(STATE_KEY, picked.choice);
    this.changed.fire();
    return this.resolve(false);
  }

  /** Makes the backend for the stored choice. When there is none and interactive is set, asks the user. */
  async resolve(interactive: boolean): Promise<TranslationBackend | undefined> {
    if (this.forcedMock) return new MockBackend();
    const stored = this.stored;
    if (stored?.kind === "mock") return new MockBackend();
    if (stored?.kind === "vscode-lm") {
      const [model] = await vscode.lm.selectChatModels({ vendor: stored.vendor, id: stored.id });
      if (model) return new VscodeLmBackend(model);
      this.log.warn(`The stored model ${stored.name} (${stored.vendor}) is no longer available.`);
    }
    return interactive ? this.pick() : undefined;
  }

  dispose(): void {
    this.changed.dispose();
  }
}
