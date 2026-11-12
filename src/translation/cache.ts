// The cache of translations. The same source text, model, target language and prompt version
// give the same translation again without a request.
import { createHash } from "node:crypto";
import * as vscode from "vscode";
import { PROMPT_VERSION } from "./blockProtocol";

/** The oldest entries are dropped beyond this many. */
const MAX_ENTRIES = 20_000;

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
        // No file yet, or a broken one: start empty.
      }
    })();
    return this.loaded;
  }

  private key(backendId: string, targetLanguage: string, source: string): string {
    return createHash("sha256").update(JSON.stringify([PROMPT_VERSION, backendId, targetLanguage, source])).digest("hex").slice(0, 32);
  }

  get(backendId: string, targetLanguage: string, source: string): string | undefined {
    return this.entries.get(this.key(backendId, targetLanguage, source));
  }

  set(backendId: string, targetLanguage: string, source: string, translation: string): void {
    const key = this.key(backendId, targetLanguage, source);
    // A Map keeps insertion order, so re-inserting makes the entry the newest.
    this.entries.delete(key);
    this.entries.set(key, translation);
    for (const oldest of this.entries.keys()) {
      if (this.entries.size <= MAX_ENTRIES) break;
      this.entries.delete(oldest);
    }
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.flush().catch(() => undefined), 1000);
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
