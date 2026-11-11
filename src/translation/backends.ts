// 翻訳の呼び出し先。VS Code の Language Model API（Copilot と、VS Code に登録した BYOK のモデル）と、
// モデルを呼ばない検証用のダミーの 2 つ。API キーを自前で持つ直接接続を足すときも、この形に合わせる。
import * as vscode from "vscode";
import type { SourceBlock } from "../shared/protocol";
import { buildPrompt } from "./blockProtocol";

export interface TranslationBackend {
  /** キャッシュのキーに使う識別子 */
  readonly id: string;
  /** 画面に出す名前 */
  readonly label: string;
  readonly cacheable: boolean;
  /** <b id="…">訳文</b> の並びを、届いた順に細切れで返す。 */
  stream(blocks: SourceBlock[], token: vscode.CancellationToken): AsyncIterable<string>;
}

export class VscodeLmBackend implements TranslationBackend {
  readonly cacheable = true;

  constructor(private readonly model: vscode.LanguageModelChat) {}

  get id(): string {
    return `vscode-lm:${this.model.vendor}:${this.model.id}`;
  }

  get label(): string {
    return `${this.model.name}（${this.model.vendor}）`;
  }

  countTokens(blocks: SourceBlock[], token: vscode.CancellationToken): Thenable<number> {
    return this.model.countTokens(buildPrompt(blocks), token);
  }

  async *stream(blocks: SourceBlock[], token: vscode.CancellationToken): AsyncIterable<string> {
    // Language Model API には system ロールがないので、指示も最初の User メッセージに入れる。
    const messages = [vscode.LanguageModelChatMessage.User(buildPrompt(blocks))];
    const response = await this.model.sendRequest(messages, { justification: "PDF の本文を日本語に翻訳するために使います。" }, token);
    for await (const fragment of response.text) yield fragment;
  }
}

const FILLER = "これは検証用のダミー訳文です。原文の文字数に合わせて長さを調整し、訳文が元の枠に収まるかどうかを確かめます。";

/** 原文とおおよそ同じ面積になる長さのダミー訳文を作る（全角 1 文字は半角およそ 2 文字分の幅）。 */
export function dummyJapanese(source: string): string {
  const length = Math.max(4, Math.round(source.length * 0.55));
  let out = "";
  while (out.length < length) out += FILLER;
  return out.slice(0, length);
}

export class MockBackend implements TranslationBackend {
  readonly id = "mock";
  readonly label = "ダミー翻訳";
  readonly cacheable = false;

  async *stream(blocks: SourceBlock[], token: vscode.CancellationToken): AsyncIterable<string> {
    for (const block of blocks) {
      const element = `<b id="${block.id}">${dummyJapanese(block.text)}</b>\n`;
      // タグの途中で切れた断片でも正しく取り出せることを確かめるため、わざと 3 つに分けて流す。
      const third = Math.ceil(element.length / 3);
      for (let i = 0; i < element.length; i += third) {
        await new Promise((resolve) => setTimeout(resolve, 8));
        if (token.isCancellationRequested) return;
        yield element.slice(i, i + third);
      }
    }
  }
}
