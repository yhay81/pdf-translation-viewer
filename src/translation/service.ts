// Translates the blocks of one page. Blocks in the cache are answered at once, and the rest go to the model.
import * as vscode from "vscode";
import type { SourceBlock } from "../shared/protocol";
import { VscodeLmBackend, type TranslationBackend } from "./backends";
import { BlockStreamParser, chunkBlocks } from "./blockProtocol";
import type { TranslationCache } from "./cache";

/** The most source text (in characters) in one request, so that the answer does not hit the output limit midway. */
const MAX_CHARS_PER_REQUEST = 6000;
/** How many times a block is sent at most, counting the retry of blocks that got no translation. */
const MAX_ATTEMPTS = 2;

export class TranslationService {
  constructor(
    private readonly cache: TranslationCache,
    private readonly log: vscode.LogOutputChannel,
  ) {}

  /**
   * Translates the blocks, and calls onBlock each time the translation of one block is complete.
   * The result lists the IDs of the blocks that never got a translation.
   */
  async translate(
    blocks: SourceBlock[],
    backend: TranslationBackend,
    targetLanguage: string,
    onBlock: (id: string, text: string, cached: boolean) => void,
    token: vscode.CancellationToken,
  ): Promise<{ missing: string[] }> {
    await this.cache.load();
    const pending = new Map<string, SourceBlock>();
    for (const block of blocks) {
      const hit = backend.cacheable ? this.cache.get(backend.id, targetLanguage, block.text) : undefined;
      if (hit !== undefined) onBlock(block.id, hit, true);
      else pending.set(block.id, block);
    }
    this.log.info(
      `Translating ${blocks.length} blocks into ${targetLanguage} with ${backend.label}: ${blocks.length - pending.size} from the cache, ${pending.size} to request`,
    );

    for (let attempt = 1; attempt <= MAX_ATTEMPTS && pending.size > 0 && !token.isCancellationRequested; attempt++) {
      for (const chunk of chunkBlocks([...pending.values()], MAX_CHARS_PER_REQUEST)) {
        if (token.isCancellationRequested) break;
        const started = Date.now();
        if (backend instanceof VscodeLmBackend) {
          const tokens = await backend.countTokens(chunk, targetLanguage, token).then(
            (n) => String(n),
            () => "an unknown number of",
          );
          this.log.info(`  Request (attempt ${attempt}): ${chunk.length} blocks, about ${tokens} input tokens`);
        }
        const parser = new BlockStreamParser();
        let received = 0;
        for await (const fragment of backend.stream(chunk, targetLanguage, token)) {
          for (const parsed of parser.push(fragment)) {
            const source = pending.get(parsed.id);
            // Unknown IDs, IDs that were already answered and empty translations are dropped.
            if (!source || !parsed.text) continue;
            pending.delete(parsed.id);
            received++;
            if (backend.cacheable) this.cache.set(backend.id, targetLanguage, source.text, parsed.text);
            onBlock(parsed.id, parsed.text, false);
          }
        }
        this.log.info(`  Answer: ${received}/${chunk.length} blocks in ${Date.now() - started} ms${parser.hasPartial ? " (the output was cut off)" : ""}`);
      }
    }
    return { missing: [...pending.keys()] };
  }
}
