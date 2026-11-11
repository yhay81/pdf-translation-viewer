// モデルとのやり取りの形式。原文を <b id="…">…</b> の並びで送り、同じ形で訳文を返させる。
// 返ってくる文字列はストリーミングで細切れに届くので、閉じタグまで届いたブロックから順に取り出す。
import type { SourceBlock } from "../shared/protocol";

/** プロンプトを変えたら上げる。翻訳キャッシュのキーに含めている。 */
export const PROMPT_VERSION = "1";

const INSTRUCTIONS = `You are a professional technical translator. Translate the blocks of one page of an English PDF into natural, accurate Japanese.

Input format: each block is written as <b id="ID">English text</b>.

Output rules:
- Output every block exactly once, in the same order, as <b id="ID">Japanese translation</b> with the same ID.
- Output nothing else: no explanations, no notes, no code fences.
- Never merge or split blocks, and never write "<b" or "</b>" inside a translation.
- Write body text in plain form (である体). Translate headings and captions concisely.
- Keep these unchanged: mathematical expressions, variable names, code, URLs, e-mail addresses, citation marks such as [12], numbers with units, and names of people, products, models, and datasets.
- Technical terms with an established Japanese translation should use it. If there is none, keep the English term.
- If a block has nothing to translate (only a formula, numbers, or code), output its original text unchanged.
- The text was extracted from a PDF, so words may be split by end-of-line hyphens or stray spaces. Repair them silently before translating.`;

/** 原文に < や & が含まれていても、ブロックの区切りと取り違えられないようにする。 */
function escapeText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function buildPrompt(blocks: SourceBlock[]): string {
  const body = blocks.map((block) => `<b id="${block.id}">${escapeText(block.text)}</b>`).join("\n");
  return `${INSTRUCTIONS}\n\nBlocks to translate:\n${body}`;
}

/** 1 回のリクエストに入れる原文の量を抑えるために、ブロックの列を文字数で分ける。 */
export function chunkBlocks(blocks: SourceBlock[], maxChars: number): SourceBlock[][] {
  const chunks: SourceBlock[][] = [];
  let current: SourceBlock[] = [];
  let size = 0;
  for (const block of blocks) {
    if (current.length > 0 && size + block.text.length > maxChars) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(block);
    size += block.text.length;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

export interface ParsedBlock {
  id: string;
  text: string;
}

const ENTITIES: Record<string, string> = { "&lt;": "<", "&gt;": ">", "&amp;": "&", "&quot;": '"', "&#39;": "'" };

/** ストリーミングで届く文字列から、完結した <b id="…">…</b> を順に取り出す。 */
export class BlockStreamParser {
  private buffer = "";

  push(chunk: string): ParsedBlock[] {
    this.buffer += chunk;
    const found: ParsedBlock[] = [];
    const pattern = /<b\s+id=["']?([^"'>\s]+)["']?\s*>([\s\S]*?)<\/b>/g;
    let consumed = 0;
    for (let match = pattern.exec(this.buffer); match; match = pattern.exec(this.buffer)) {
      const text = match[2]
        .replace(/&(?:lt|gt|amp|quot|#39);/g, (entity) => ENTITIES[entity])
        .replace(/\s+/g, " ")
        .trim();
      found.push({ id: match[1], text });
      consumed = pattern.lastIndex;
    }
    // 取り出し終えた部分は捨て、途中まで届いているブロックだけを残す。
    this.buffer = this.buffer.slice(consumed);
    return found;
  }

  /** まだ閉じていない（途中で切れた）出力が残っているか。 */
  get hasPartial(): boolean {
    return /<b[\s>]/.test(this.buffer);
  }
}
