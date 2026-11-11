// 1 ページ分のブロックを翻訳する。キャッシュにあるものは即座に返し、残りをモデルに出す。
import * as vscode from "vscode";
import type { SourceBlock } from "../shared/protocol";
import { VscodeLmBackend, type TranslationBackend } from "./backends";
import { BlockStreamParser, chunkBlocks } from "./blockProtocol";
import type { TranslationCache } from "./cache";

/** 1 回のリクエストに入れる原文の上限（文字数）。訳文が出力上限で途中で切れるのを避ける。 */
const MAX_CHARS_PER_REQUEST = 6000;
/** 訳文が返らなかったブロックだけを出し直す回数を含めた、試行の上限。 */
const MAX_ATTEMPTS = 2;

export class TranslationService {
  constructor(
    private readonly cache: TranslationCache,
    private readonly log: vscode.LogOutputChannel,
  ) {}

  /**
   * ブロックを翻訳し、訳文が 1 ブロック分そろうたびに onBlock を呼ぶ。
   * 戻り値の missing は、最後まで訳文が返らなかったブロックの ID。
   */
  async translate(
    blocks: SourceBlock[],
    backend: TranslationBackend,
    onBlock: (id: string, text: string, cached: boolean) => void,
    token: vscode.CancellationToken,
  ): Promise<{ missing: string[] }> {
    await this.cache.load();
    const pending = new Map<string, SourceBlock>();
    for (const block of blocks) {
      const hit = backend.cacheable ? this.cache.get(backend.id, block.text) : undefined;
      if (hit !== undefined) onBlock(block.id, hit, true);
      else pending.set(block.id, block);
    }
    this.log.info(`翻訳: ${blocks.length} ブロック（キャッシュ ${blocks.length - pending.size}、新規 ${pending.size}）／${backend.label}`);

    for (let attempt = 1; attempt <= MAX_ATTEMPTS && pending.size > 0 && !token.isCancellationRequested; attempt++) {
      for (const chunk of chunkBlocks([...pending.values()], MAX_CHARS_PER_REQUEST)) {
        if (token.isCancellationRequested) break;
        const started = Date.now();
        if (backend instanceof VscodeLmBackend) {
          const tokens = await backend.countTokens(chunk, token).then(
            (n) => String(n),
            () => "不明",
          );
          this.log.info(`  リクエスト（試行 ${attempt}）: ${chunk.length} ブロック、入力およそ ${tokens} トークン`);
        }
        const parser = new BlockStreamParser();
        let received = 0;
        for await (const fragment of backend.stream(chunk, token)) {
          for (const parsed of parser.push(fragment)) {
            const source = pending.get(parsed.id);
            // 知らない ID、すでに受け取った ID、空の訳文は捨てる。
            if (!source || !parsed.text) continue;
            pending.delete(parsed.id);
            received++;
            if (backend.cacheable) this.cache.set(backend.id, source.text, parsed.text);
            onBlock(parsed.id, parsed.text, false);
          }
        }
        this.log.info(`  応答: ${received}/${chunk.length} ブロック、${Date.now() - started} ms${parser.hasPartial ? "（出力が途中で切れました）" : ""}`);
      }
    }
    return { missing: [...pending.keys()] };
  }
}
