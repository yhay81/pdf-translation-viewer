// The model picker offers VS Code language models and the PLaMo API.
import * as vscode from "vscode";
import { MockBackend, VscodeLmBackend, type TranslationBackend } from "./backends";
import { PLAMO_MODEL, PlamoBackend } from "./plamo";

type StoredChoice = { kind: "mock" } | { kind: "plamo" } | { kind: "vscode-lm"; id: string; vendor: string; name: string };

const STATE_KEY = "pdfTranslation.model";
const PLAMO_SECRET = "pdfTranslation.plamoApiKey";

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
    if (stored.kind === "plamo") return PLAMO_MODEL.name;
    return stored.kind === "mock" ? new MockBackend().label : `${stored.name} (${stored.vendor})`;
  }

  async listVscodeModels(): Promise<vscode.LanguageModelChat[]> {
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
    for (const model of await this.listVscodeModels()) {
      if (model.maxInputTokens >= MIN_INPUT_TOKENS) models.push(model);
      else this.log.info(`Not offered, because its input limit is ${model.maxInputTokens} tokens: ${model.name} (${model.vendor})`);
    }
    const items: ModelItem[] = models.map((model) => ({
      label: model.name,
      description: `${model.vendor} · ${model.family}`,
      detail: vscode.l10n.t("ID: {0} · up to {1} input tokens", model.id, model.maxInputTokens.toLocaleString()),
      choice: { kind: "vscode-lm", id: model.id, vendor: model.vendor, name: model.name },
    }));
    items.push({
      label: PLAMO_MODEL.name,
      description: PLAMO_MODEL.vendor,
      detail: vscode.l10n.t("Sends the page text to the PLaMo API using your API key."),
      choice: { kind: "plamo" },
    });
    if (this.offersMock) {
      items.push({
        label: vscode.l10n.t("Dummy translation (for development)"),
        description: vscode.l10n.t("Lays out placeholder text without calling a model"),
        choice: { kind: "mock" },
      });
    }
    const picked = await vscode.window.showQuickPick(items, {
      title: vscode.l10n.t("Model to Translate With"),
      placeHolder: vscode.l10n.t("Choose a model"),
      matchOnDescription: true,
    });
    if (!picked) return undefined;
    const backend = await this.backendFor(picked.choice);
    if (!backend) return undefined;
    await this.context.globalState.update(STATE_KEY, picked.choice);
    this.changed.fire();
    return backend;
  }

  async setPlamoApiKey(): Promise<void> {
    const saved = await this.context.secrets.get(PLAMO_SECRET);
    await this.promptForPlamoKey(Boolean(saved));
  }

  private async promptForPlamoKey(hasSavedKey: boolean): Promise<string | undefined> {
    const input = await vscode.window.showInputBox({
      title: vscode.l10n.t("Set PLaMo API Key"),
      prompt: hasSavedKey
        ? vscode.l10n.t("Enter a new PLaMo API key, or leave it empty to remove the saved key.")
        : vscode.l10n.t("Enter your PLaMo API key. VS Code will store it securely."),
      password: true,
      ignoreFocusOut: true,
      validateInput: (value) => (hasSavedKey || value.trim()) ? undefined : vscode.l10n.t("Enter a PLaMo API key."),
    });
    if (input === undefined) return undefined;
    const key = input.trim();
    if (key) await this.context.secrets.store(PLAMO_SECRET, key);
    else await this.context.secrets.delete(PLAMO_SECRET);
    return key || undefined;
  }

  /** Restores the chosen model or asks for one when it is no longer available. */
  async resolve(): Promise<TranslationBackend | undefined> {
    if (this.forcedMock) return new MockBackend();
    const stored = this.stored;
    if (stored) {
      const backend = await this.backendFor(stored);
      if (backend || stored.kind !== "vscode-lm") return backend;
    }
    return this.pick();
  }

  private async backendFor(choice: StoredChoice): Promise<TranslationBackend | undefined> {
    if (choice.kind === "mock") return new MockBackend();
    if (choice.kind === "plamo") {
      const saved = await this.context.secrets.get(PLAMO_SECRET);
      const key = saved || process.env.PLAMO_API_KEY?.trim() || await this.promptForPlamoKey(false);
      return key ? new PlamoBackend(key) : undefined;
    }
    const [model] = await vscode.lm.selectChatModels({ vendor: choice.vendor, id: choice.id });
    if (model) return new VscodeLmBackend(model);
    this.log.warn(`The chosen model ${choice.name} (${choice.vendor}) is no longer available.`);
    return undefined;
  }

  dispose(): void {
    this.changed.dispose();
  }
}
