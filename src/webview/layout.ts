// Groups the fragments of text taken out of a PDF (runs) into lines, and then into blocks such as paragraphs.
// It is an estimate that looks only at positions, and depends on neither the DOM nor PDF.js.
// All coordinates are in the viewport at scale 1 (the unit is pt, the origin is the top left, and y points down).

export interface FontInfo {
  bold: boolean;
  italic: boolean;
  serif: boolean;
  mono: boolean;
  /** A font for mathematics (symbols, math italic and so on) */
  math: boolean;
}

export interface Run {
  str: string;
  x0: number;
  x1: number;
  baseline: number;
  top: number;
  bottom: number;
  size: number;
  font: string;
  /** Whether a space came just before */
  spaceBefore: boolean;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Line {
  runs: Run[];
  x0: number;
  x1: number;
  top: number;
  bottom: number;
  baseline: number;
  size: number;
  font: string;
  text: string;
  /** Three or more short fragments stand at the same height, as in a row of a table */
  tabular: boolean;
  /** The area repainted when the source text is erased. Its margins are adjusted so that it does not cut into the neighboring lines */
  erase: Rect;
}

export type Align = "left" | "center" | "right" | "justify";

export interface Block {
  id: string;
  lines: Line[];
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  text: string;
  /** The representative font size */
  size: number;
  /** The line pitch */
  pitch: number;
  font: string;
  firstBaseline: number;
  align: Align;
  /** Whether the first line has an indent */
  indentFirst: boolean;
  /** The width of the hanging indent (references and list items). 0 when there is none */
  hang: number;
  translatable: boolean;
  /** The bottom edge down to which the translation may extend when it does not fit in the box */
  maxBottom: number;
  /** The horizontal range in which the translation may be placed (used for one-line blocks) */
  regionLeft: number;
  regionRight: number;
}

export interface PageSize {
  width: number;
  height: number;
}

const LIST_ITEM = /^(?:[•◦▪■●○‣·*\-–—]|\(?\d{1,2}[.)]|\([a-zA-Z]\)|\[\d{1,3}\])\s/;

function overlap(a0: number, a1: number, b0: number, b1: number): number {
  return Math.min(a1, b1) - Math.max(a0, b0);
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Returns the value that accounts for the most characters. */
function dominant<T>(items: Iterable<[T, number]>): T | undefined {
  const counts = new Map<T, number>();
  for (const [key, weight] of items) counts.set(key, (counts.get(key) ?? 0) + weight);
  let best: T | undefined;
  let bestCount = -1;
  for (const [key, count] of counts) {
    if (count > bestCount) {
      best = key;
      bestCount = count;
    }
  }
  return best;
}

function finishLine(runs: Run[]): Line {
  runs.sort((a, b) => a.x0 - b.x0);
  const size = dominant(runs.map((r) => [Math.round(r.size * 10) / 10, r.str.length] as [number, number])) ?? runs[0].size;
  const main = runs.filter((r) => Math.abs(r.size - size) <= 0.05 * size);
  const font = dominant(main.map((r) => [r.font, r.str.length] as [string, number])) ?? runs[0].font;

  let text = "";
  let prev: Run | null = null;
  for (const run of runs) {
    if (prev) {
      const gap = run.x0 - prev.x1;
      const h = Math.max(prev.size, run.size);
      if ((run.spaceBefore || gap > 0.25 * h) && !text.endsWith(" ")) text += " ";
    }
    text += run.str;
    prev = run;
  }

  const x0 = Math.min(...runs.map((r) => r.x0));
  const x1 = Math.max(...runs.map((r) => r.x1));
  const top = Math.min(...runs.map((r) => r.top));
  const bottom = Math.max(...runs.map((r) => r.bottom));
  return {
    runs,
    x0,
    x1,
    top,
    bottom,
    baseline: median(main.map((r) => r.baseline)),
    size,
    font,
    text: text.replace(/\s+/g, " ").trim(),
    tabular: false,
    erase: { x: x0, y: top, w: x1 - x0, h: bottom - top },
  };
}

/**
 * The largest horizontal gap (as a multiple of the font size) across which fragments still count as one line.
 * The gap between the number and the title of a heading (1em) is joined, and the gap between the columns of a table (usually 1.2em or more) is split.
 */
const MAX_WORD_GAP = 1.15;

/** Groups runs into lines. It goes by the order in which they appear in the PDF, and afterwards joins fragments at the same height. */
export function buildLines(runs: Run[]): Line[] {
  const groups: Run[][] = [];
  let cur: Run[] | null = null;
  let baseline = 0;
  let size = 0;
  let right = 0;
  for (const run of runs) {
    if (cur) {
      const h = Math.max(size, run.size);
      const gap = run.x0 - right;
      // Superscripts and subscripts are treated as part of the same line. A run that jumps far back to the left, or lies far away, starts another line.
      if (Math.abs(run.baseline - baseline) <= 0.45 * h && gap > -0.5 * h && gap < MAX_WORD_GAP * h) {
        cur.push(run);
        if (run.size > size * 1.05) {
          size = run.size;
          baseline = run.baseline;
        }
        right = Math.max(right, run.x1);
        continue;
      }
    }
    cur = [run];
    groups.push(cur);
    baseline = run.baseline;
    size = run.size;
    right = run.x1;
  }

  // When the order of appearance is out of sequence, as in formulas, one line is split into several fragments, so adjacent fragments at the same height are joined.
  let lines = groups.map(finishLine);
  for (let merged = true; merged; ) {
    merged = false;
    outer: for (let i = 0; i < lines.length; i++) {
      for (let j = 0; j < lines.length; j++) {
        if (i === j) continue;
        const a = lines[i];
        const b = lines[j];
        const h = Math.max(a.size, b.size);
        const gap = b.x0 - a.x1;
        if (Math.abs(a.baseline - b.baseline) <= 0.3 * h && gap > -0.5 * h && gap < MAX_WORD_GAP * h && b.x0 > a.x0) {
          const joined = finishLine([...a.runs, ...b.runs]);
          lines = lines.filter((_, k) => k !== i && k !== j);
          lines.splice(Math.min(i, j), 0, joined);
          merged = true;
          break outer;
        }
      }
    }
  }
  return lines;
}

function markTabular(lines: Line[], page: PageSize): void {
  for (const line of lines) {
    if (line.x1 - line.x0 > 0.22 * page.width) continue;
    let sameRow = 0;
    for (const other of lines) {
      if (other === line) continue;
      if (Math.abs(other.baseline - line.baseline) <= 0.3 * line.size && overlap(line.x0, line.x1, other.x0, other.x1) <= 0) {
        sameRow++;
      }
    }
    line.tabular = sameRow >= 2;
  }
}

/** Estimates the usual line pitch of the page (as a multiple of the font size). */
function leadingRatio(lines: Line[]): number {
  const ratios: number[] = [];
  for (let i = 0; i + 1 < lines.length; i++) {
    const a = lines[i];
    const b = lines[i + 1];
    if (Math.abs(a.size - b.size) > 0.08 * a.size) continue;
    if (overlap(a.x0, a.x1, b.x0, b.x1) < 0.5 * Math.min(a.x1 - a.x0, b.x1 - b.x0)) continue;
    const ratio = (b.baseline - a.baseline) / a.size;
    if (ratio > 0.8 && ratio < 3) ratios.push(ratio);
  }
  return ratios.length >= 3 ? median(ratios) : 1.2;
}

interface Draft {
  lines: Line[];
  x0: number;
  x1: number;
  size: number;
  font: string;
  pitch: number;
  /** The left edge of the second and later lines */
  bodyLeft: number;
  centered: boolean;
  tabular: boolean;
}

const center = (l: { x0: number; x1: number }) => (l.x0 + l.x1) / 2;

/**
 * Whether two lines are centered on each other. The condition is that both the left edges and the right edges differ while the centers line up.
 * Without the check of the right edges, a paragraph with a small indent (only the left edge of its first line is shifted right) would be mistaken for centered text.
 */
function isCenteredPair(a: Line, b: Line, em: number): boolean {
  return Math.abs(center(a) - center(b)) < 0.6 * em && Math.abs(a.x0 - b.x0) > 0.7 * em && Math.abs(a.x1 - b.x1) > 0.7 * em;
}

function canMerge(draft: Draft, line: Line, dy: number, leading: number, fonts: Map<string, FontInfo>): boolean {
  if (draft.tabular || line.tabular) return false;
  const em = draft.size;
  if (Math.abs(line.size - em) > 0.08 * em) return false;
  if (overlap(draft.x0, draft.x1, line.x0, line.x1) < 0.5 * Math.min(draft.x1 - draft.x0, line.x1 - line.x0)) return false;
  if (LIST_ITEM.test(line.text)) return false;

  const n = draft.lines.length;
  const last = draft.lines[n - 1];
  if (n >= 2) {
    if (dy > draft.pitch * 1.25 + 0.5 || dy < draft.pitch * 0.7) return false;
  } else {
    if (dy > leading * em * 1.35 || dy < 0.7 * em) return false;
    // When body text follows right below a bold heading, the two are kept apart.
    const a = fonts.get(draft.font);
    const b = fonts.get(line.font);
    if (a && b && a.bold !== b.bold) return false;
  }

  const centeredPair = isCenteredPair(last, line, em);
  if (n >= 2) {
    if (draft.centered) return Math.abs(center(last) - center(line)) < 0.6 * em;
    // An indent (a new paragraph) or an outdent (a new list item) starts another block.
    return Math.abs(line.x0 - draft.bodyLeft) <= 0.7 * em;
  }
  if (centeredPair) return true;
  if (line.x0 > last.x0 + 0.7 * em) {
    // The second line is shifted to the right. If this is a hanging indent, the first line should reach the right edge.
    return last.x1 >= line.x1 - 2 * em;
  }
  return true;
}

function joinLines(lines: Line[]): string {
  let out = "";
  for (const line of lines) {
    if (!out) {
      out = line.text;
    } else if (/(?:^|[\s(“"])[A-Za-z]+-$/.test(out) && /^[a-z]/.test(line.text)) {
      // A word split by a hyphen at the end of a line is joined (the hyphen of a compound word stays).
      out = out.slice(0, -1) + line.text;
    } else {
      out += " " + line.text;
    }
  }
  return out;
}

function isTranslatable(text: string, lines: Line[], fonts: Map<string, FontInfo>): boolean {
  if (!/[A-Za-z]{3,}/.test(text)) return false;
  const letters = (text.match(/[A-Za-z]/g) ?? []).length;
  const visible = text.replace(/\s/g, "").length;
  if (letters < 0.5 * visible) return false;

  // Display equations are not translated. A block with few words and a noticeable share of characters in a math font counts as an equation
  // (a paragraph with formulas mixed into its text has many words, so it does not match here).
  let total = 0;
  let math = 0;
  for (const line of lines) {
    for (const run of line.runs) {
      const count = run.str.replace(/\s/g, "").length;
      total += count;
      if (fonts.get(run.font)?.math) math += count;
    }
  }
  const words = (text.match(/[A-Za-z]{3,}/g) ?? []).length;
  return !(words < 8 && total > 0 && math >= 0.15 * total);
}

/** Decides the alignment of a table cell by which of its left edge, right edge and center lines up with the cells of the same column (those above and below it). */
function columnAlign(block: Block, blocks: Block[]): Align {
  const tolerance = 0.25 * block.size;
  let left = 0;
  let right = 0;
  let middle = 0;
  for (const other of blocks) {
    if (other === block || other.lines.length !== 1 || !other.lines[0].tabular) continue;
    if (overlap(block.x0, block.x1, other.x0, other.x1) <= 0) continue;
    if (Math.abs(other.y0 - block.y0) > 8 * block.size) continue;
    if (Math.abs(other.x0 - block.x0) <= tolerance) left++;
    if (Math.abs(other.x1 - block.x1) <= tolerance) right++;
    if (Math.abs(center(other) - center(block)) <= tolerance) middle++;
  }
  if (left >= right && left >= middle) return "left";
  return right >= middle ? "right" : "center";
}

/** For each line, widens the rectangle to erase as far as it can go without cutting into the neighboring lines (those of other blocks). */
function computeEraseRects(blocks: Block[]): void {
  const all = blocks.flatMap((block) => block.lines.map((line) => ({ line, block })));
  for (const { line, block } of all) {
    const pad = 0.3 * line.size;
    let up = pad;
    let down = pad;
    let left = pad;
    let right = pad;
    for (const other of all) {
      if (other.block === block) continue;
      const o = other.line;
      const h = overlap(line.x0 - pad, line.x1 + pad, o.x0, o.x1) > 0;
      const v = overlap(line.top - pad, line.bottom + pad, o.top, o.bottom) > 0;
      if (h && o.bottom <= line.baseline) up = Math.min(up, Math.max(0, (line.top - o.bottom) / 2));
      if (h && o.top >= line.baseline) down = Math.min(down, Math.max(0, (o.top - line.bottom) / 2));
      if (v && o.x1 <= center(line)) left = Math.min(left, Math.max(0, (line.x0 - o.x1) / 2));
      if (v && o.x0 >= center(line)) right = Math.min(right, Math.max(0, (o.x0 - line.x1) / 2));
    }
    line.erase = {
      x: line.x0 - left,
      y: line.top - up,
      w: line.x1 - line.x0 + left + right,
      h: line.bottom - line.top + up + down,
    };
  }
}

/** Groups the runs of one page into blocks. */
export function segmentPage(runs: Run[], fonts: Map<string, FontInfo>, page: PageSize, pageNumber: number): Block[] {
  const lines = buildLines(runs);
  markTabular(lines, page);
  const leading = leadingRatio(lines);

  const drafts: Draft[] = [];
  for (const line of lines) {
    let best: Draft | null = null;
    let bestDy = Infinity;
    for (const draft of drafts) {
      const dy = line.baseline - draft.lines[draft.lines.length - 1].baseline;
      if (dy <= 0 || dy >= bestDy) continue;
      if (canMerge(draft, line, dy, leading, fonts)) {
        best = draft;
        bestDy = dy;
      }
    }
    if (!best) {
      drafts.push({
        lines: [line],
        x0: line.x0,
        x1: line.x1,
        size: line.size,
        font: line.font,
        pitch: leading * line.size,
        bodyLeft: line.x0,
        centered: false,
        tabular: line.tabular,
      });
      continue;
    }
    const last = best.lines[best.lines.length - 1];
    if (best.lines.length === 1) {
      best.centered = isCenteredPair(last, line, best.size);
    }
    best.lines.push(line);
    best.x0 = Math.min(best.x0, line.x0);
    best.x1 = Math.max(best.x1, line.x1);
    best.bodyLeft = Math.min(...best.lines.slice(1).map((l) => l.x0));
    const diffs: number[] = [];
    for (let i = 1; i < best.lines.length; i++) diffs.push(best.lines[i].baseline - best.lines[i - 1].baseline);
    best.pitch = median(diffs);
  }

  const blocks: Block[] = drafts.map((draft, index) => {
    const { lines: ls } = draft;
    const first = ls[0];
    const em = draft.size;
    const multi = ls.length >= 2;
    const text = joinLines(ls);
    const firstOffset = multi ? first.x0 - draft.bodyLeft : 0;
    return {
      id: `p${pageNumber}-${index}`,
      lines: ls,
      x0: draft.x0,
      y0: Math.min(...ls.map((l) => l.top)),
      x1: draft.x1,
      y1: Math.max(...ls.map((l) => l.bottom)),
      text,
      size: em,
      pitch: draft.pitch,
      font: draft.font,
      firstBaseline: first.baseline,
      align: !multi ? "left" : draft.centered ? "center" : "justify",
      indentFirst: !draft.centered && firstOffset > 0.7 * em,
      hang: !draft.centered && firstOffset < -0.7 * em ? -firstOffset : 0,
      translatable: isTranslatable(text, ls, fonts),
      maxBottom: 0,
      regionLeft: draft.x0,
      regionRight: draft.x1,
    };
  });

  const textLeft = Math.min(...blocks.map((b) => b.x0));
  const textRight = Math.max(...blocks.map((b) => b.x1));
  for (const block of blocks) {
    const em = block.size;

    let maxBottom = page.height * 0.97;
    for (const other of blocks) {
      if (other === block || other.y0 < block.y1 - 1) continue;
      if (overlap(block.x0, block.x1, other.x0, other.x1) > 0) maxBottom = Math.min(maxBottom, other.y0 - 0.25 * em);
    }
    block.maxBottom = Math.max(maxBottom, block.y1);

    if (block.lines.length >= 2) continue;

    // For a one-line block, the width of the body text in the same column (a block of two or more lines) is taken as the range in which it may be placed.
    // Of the nearby ones, the narrowest is chosen. Otherwise a single line inside a multi-column layout
    // would borrow the width of a block above it that spans the columns (such as the abstract), and spill into the next column.
    const candidates: { other: Block; distance: number; width: number }[] = [];
    for (const other of blocks) {
      if (other === block || other.lines.length < 2) continue;
      if (block.x0 < other.x0 - em || block.x1 > other.x1 + em) continue;
      const distance = other.y0 >= block.y1 ? other.y0 - block.y1 : block.y0 >= other.y1 ? block.y0 - other.y1 : 0;
      candidates.push({ other, distance, width: Math.round((other.x1 - other.x0) / em) });
    }
    const near = candidates.filter((c) => c.distance <= 0.3 * page.height);
    if (near.length) near.sort((a, b) => a.width - b.width || a.distance - b.distance);
    else candidates.sort((a, b) => a.distance - b.distance);
    const region: Block | null = (near[0] ?? candidates[0])?.other ?? null;
    let left = region ? Math.min(region.x0, block.x0) : Math.min(textLeft, block.x0);
    let right = region ? Math.max(region.x1, block.x1) : Math.max(textRight, block.x1);
    for (const other of blocks) {
      if (other === block || overlap(block.y0, block.y1, other.y0, other.y1) <= 0) continue;
      // The gap to a block alongside is shared half and half (so that the translations of adjacent table cells do not collide).
      if (other.x0 >= block.x1 - 1) right = Math.min(right, (block.x1 + other.x0) / 2 - 0.15 * em);
      if (other.x1 <= block.x0 + 1) left = Math.max(left, (other.x1 + block.x0) / 2 + 0.15 * em);
    }
    block.regionLeft = Math.min(left, block.x0);
    block.regionRight = Math.max(right, block.x1);

    if (block.lines[0].tabular) {
      // A table cell is aligned to the side on which its edge lines up with the cells above and below.
      block.align = columnAlign(block, blocks);
      continue;
    }
    const width = block.regionRight - block.regionLeft;
    const offsetLeft = block.x0 - block.regionLeft;
    const offsetRight = block.regionRight - block.x1;
    if (Math.abs(offsetLeft - offsetRight) < 0.06 * width && offsetLeft > 0.08 * width) block.align = "center";
    else if (offsetRight < 0.02 * width && offsetLeft > 0.3 * width) block.align = "right";
  }

  computeEraseRects(blocks);
  return blocks;
}
