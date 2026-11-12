// The interface shared by VS Code language models, the direct PLaMo API and the development dummy.
import * as vscode from "vscode";
import type { SourceBlock } from "../shared/protocol";
import { buildPrompt } from "./blockProtocol";

export interface TranslationBackend {
  /** Identifies the backend in the key of the translation cache */
  readonly id: string;
  /** The name shown on screen */
  readonly label: string;
  readonly cacheable: boolean;
  /** Yields a list of <b id="…">translation</b> elements, in fragments as they arrive. */
  stream(blocks: SourceBlock[], targetLanguage: string, token: vscode.CancellationToken): AsyncIterable<string>;
}

export class VscodeLmBackend implements TranslationBackend {
  readonly cacheable = true;

  constructor(private readonly model: vscode.LanguageModelChat) {}

  get id(): string {
    return `vscode-lm:${this.model.vendor}:${this.model.id}`;
  }

  get label(): string {
    return `${this.model.name} (${this.model.vendor})`;
  }

  countTokens(blocks: SourceBlock[], targetLanguage: string, token: vscode.CancellationToken): Thenable<number> {
    return this.model.countTokens(buildPrompt(blocks, targetLanguage), token);
  }

  async *stream(blocks: SourceBlock[], targetLanguage: string, token: vscode.CancellationToken): AsyncIterable<string> {
    // The Language Model API has no system role, so the instructions go into the first user message.
    const messages = [vscode.LanguageModelChatMessage.User(buildPrompt(blocks, targetLanguage))];
    const justification = vscode.l10n.t("PDF Translation Viewer sends the text of the page to translate it into {0}.", targetLanguage);
    const response = await this.model.sendRequest(messages, { justification }, token);
    for await (const fragment of response.text) yield fragment;
  }
}

const FILLER = "これは検証用のダミー訳文です。原文の文字数に合わせて長さを調整し、訳文が元の枠に収まるかどうかを確かめます。";

/** Placeholder Japanese that covers about the same area as the source: a full-width character is about as wide as two Latin ones. */
export function dummyJapanese(source: string): string {
  const length = Math.max(4, Math.round(source.length * 0.55));
  let out = "";
  while (out.length < length) out += FILLER;
  return out.slice(0, length);
}

export class MockBackend implements TranslationBackend {
  readonly id = "mock";
  readonly cacheable = false;

  get label(): string {
    return vscode.l10n.t("Dummy translation");
  }

  async *stream(blocks: SourceBlock[], _targetLanguage: string, token: vscode.CancellationToken): AsyncIterable<string> {
    for (const block of blocks) {
      const element = `<b id="${block.id}">${dummyJapanese(block.text)}</b>\n`;
      // Sent in three pieces on purpose, to exercise the parser on fragments that end inside a tag.
      const third = Math.ceil(element.length / 3);
      for (let i = 0; i < element.length; i += third) {
        await new Promise((resolve) => setTimeout(resolve, 8));
        if (token.isCancellationRequested) return;
        yield element.slice(i, i + third);
      }
    }
  }
}
