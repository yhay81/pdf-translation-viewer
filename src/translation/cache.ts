// 翻訳結果のキャッシュ。原文・モデル・プロンプトの版が同じなら、同じ訳文を使い回す。
import { createHash } from "node:crypto";
import * as vscode from "vscode";
import { PROMPT_VERSION } from "./blockProtocol";

const TARGET_LANGUAGE = "ja";

export class TranslationCache {
  private entries = new Map<string, string>();
  private loaded: Promise<void> | null = null;
  private saveTimer: NodeJS.Timeout | undefined;

  constructor(private readonly directory: vscode.Uri) {}

  private get file(): vscode.Uri {
    return vscode.Uri.joinPath(this.directory, "translations-v1.json");
  }

  load(): Promise<void> {
    this.loaded ??= (async () => {
      try {
        const raw = await vscode.workspace.fs.readFile(this.file);
        this.entries = new Map(Object.entries(JSON.parse(new TextDecoder().decode(raw)) as Record<string, string>));
      } catch {
        // まだファイルがない、または壊れている場合は空から始める。
      }
    })();
    return this.loaded;
  }

  private key(backendId: string, source: string): string {
    return createHash("sha256").update(JSON.stringify([PROMPT_VERSION, backendId, TARGET_LANGUAGE, source])).digest("hex").slice(0, 32);
  }

  get(backendId: string, source: string): string | undefined {
    return this.entries.get(this.key(backendId, source));
  }

  set(backendId: string, source: string, translation: string): void {
    this.entries.set(this.key(backendId, source), translation);
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.flush(), 1000);
  }

  get size(): number {
    return this.entries.size;
  }

  async flush(): Promise<void> {
    clearTimeout(this.saveTimer);
    await vscode.workspace.fs.createDirectory(this.directory);
    const json = JSON.stringify(Object.fromEntries(this.entries));
    await vscode.workspace.fs.writeFile(this.file, new TextEncoder().encode(json));
  }

  async clear(): Promise<void> {
    this.entries.clear();
    await this.flush();
  }
}
