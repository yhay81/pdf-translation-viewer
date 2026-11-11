// The format of the exchange with the model. The source goes out as a list of <b id="…">…</b>
// elements, and the translation comes back in the same form. The answer arrives in fragments, so
// each block is taken out as soon as its closing tag has arrived.
import type { SourceBlock } from "../shared/protocol";

/** Raise this when the prompt changes. It is part of the key of the translation cache. */
export const PROMPT_VERSION = "2";

function instructions(targetLanguage: string): string {
  const rules = [
    `Output every block exactly once, in the same order, as <b id="ID">translation</b> with the same ID.`,
    `Output nothing else: no explanations, no notes, no code fences.`,
    `Never merge or split blocks, and never write "<b" or "</b>" inside a translation.`,
    `Translate headings and captions concisely.`,
    `Keep these unchanged: mathematical expressions, variable names, code, URLs, e-mail addresses, citation marks such as [12], numbers with units, and names of people, products, models, and datasets.`,
    `Use the established ${targetLanguage} translation of a technical term when there is one. If there is none, keep the original term.`,
    `If a block has nothing to translate (only a formula, numbers, code, or names), or is already in ${targetLanguage}, output its original text unchanged.`,
    `The text was extracted from a PDF, so words may be split by end-of-line hyphens or stray spaces. Repair them silently before translating.`,
  ];
  // Academic and technical Japanese is written in the plain style.
  if (/japanese|日本語/i.test(targetLanguage)) rules.splice(3, 0, `Write body text in the plain form (である体).`);
  return `You are a professional technical translator. Translate the blocks of one page of a PDF into natural, accurate ${targetLanguage}.

Input format: each block is written as <b id="ID">source text</b>.

Output rules:
${rules.map((rule) => `- ${rule}`).join("\n")}`;
}

/** Keeps a < or & in the source from being taken for the boundary of a block. */
function escapeText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function buildPrompt(blocks: SourceBlock[], targetLanguage: string): string {
  const body = blocks.map((block) => `<b id="${block.id}">${escapeText(block.text)}</b>`).join("\n");
  return `${instructions(targetLanguage)}\n\nBlocks to translate:\n${body}`;
}

/** Splits the blocks by length, to limit how much source text goes into one request. */
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

/** Takes the complete <b id="…">…</b> elements out of a text that arrives in fragments. */
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
    // Drop what has been taken out, and keep only the block that has arrived in part.
    this.buffer = this.buffer.slice(consumed);
    return found;
  }

  /** Whether output that was never closed (cut off midway) is left. */
  get hasPartial(): boolean {
    return /<b[\s>]/.test(this.buffer);
  }
}
