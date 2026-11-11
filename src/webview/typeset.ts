// Fits a translation into a box at the same position and of the same size as the source block, and places it there.
import type { Block, FontInfo } from "./layout";

/**
 * The layer of translations is typeset at BASE times the pt coordinates of the page, and a CSS transform brings it to the display scale.
 * Even small text then stays clear of the browser's minimum font size, and zooming does not move the line breaks.
 */
export const BASE = 4;

/** The text is shrunk within the box down to this scale. Rather than going smaller, it extends into the blank space below. */
const K_SOFT = 0.85;
/** The lower limit of shrinking. If the text does not fit even at this scale, it is cut short. */
const K_MIN = 0.7;
/** The lower limit for shrinking a one-line block while keeping it on one line. Below this, the text wraps. */
const K_MIN_SINGLE = 0.6;

const LATIN_SERIF = '"Times New Roman", Times';
const LATIN_SANS = "Helvetica, Arial";
const JAPANESE_SERIF = '"Hiragino Mincho ProN", "Yu Mincho", YuMincho, "Noto Serif CJK JP", "Noto Serif JP"';
const JAPANESE_SANS = '"Hiragino Sans", "Hiragino Kaku Gothic ProN", "Yu Gothic", YuGothic, "Noto Sans CJK JP", "Noto Sans JP"';
const MONO = 'Menlo, Consolas, "Courier New", "Osaka-Mono", "MS Gothic", monospace';

export interface BlockStyle {
  color: string;
  background: string;
  font: FontInfo | undefined;
  /** The language of the translation (BCP 47), or an empty string when it is unknown */
  lang: string;
}

/**
 * Chooses a font that matches the typeface of the source (serif, sans-serif or monospace). Japanese fonts are named
 * only when the translation is in Japanese; for other languages the choice is left to the browser, which goes by the lang attribute.
 */
function fontFamily(font: FontInfo | undefined, lang: string): string {
  if (font?.mono) return MONO;
  const japanese = lang === "ja";
  if (font?.serif) return `${LATIN_SERIF}, ${japanese ? `${JAPANESE_SERIF}, ` : ""}serif`;
  return `${LATIN_SANS}, ${japanese ? `${JAPANESE_SANS}, ` : ""}sans-serif`;
}

export interface Placed {
  el: HTMLDivElement;
  /** The scale relative to the font size of the source */
  scale: number;
  clipped: boolean;
}

export function placeBlock(layer: HTMLElement, block: Block, text: string, style: BlockStyle): Placed {
  const el = document.createElement("div");
  el.className = "tb";
  if (style.lang) el.lang = style.lang;
  el.dataset.id = block.id;
  el.title = block.text;
  el.style.color = style.color;
  el.style.setProperty("--tb-bg", style.background);
  el.style.fontFamily = fontFamily(style.font, style.lang);
  el.style.fontWeight = style.font?.bold ? "700" : "400";

  // The bottom edge of an inline block with zero width and zero height sits on the baseline of the text. It serves to measure where the baseline of the first line is.
  const probe = document.createElement("span");
  probe.className = "tb-probe";
  el.append(probe, text);
  layer.append(el);

  const apply = (k: number) => {
    el.style.fontSize = `${block.size * BASE * k}px`;
    el.style.lineHeight = `${block.pitch * BASE * k}px`;
  };
  const single = block.lines.length === 1;
  let result: { scale: number; clipped: boolean } | null = null;
  if (single) result = fitSingleLine(el, block, apply);
  result ??= fitParagraph(el, block, apply, single);

  // The baseline of the first line is matched to that of the source.
  el.style.top = `${block.firstBaseline * BASE - probe.offsetTop}px`;
  probe.remove();
  if (result.clipped) el.classList.add("clipped");
  return { el, ...result };
}

function fitSingleLine(el: HTMLDivElement, block: Block, apply: (k: number) => void): { scale: number; clipped: boolean } | null {
  const regionLeft = block.regionLeft * BASE;
  const regionRight = block.regionRight * BASE;

  el.style.whiteSpace = "nowrap";
  el.style.left = "0px";
  apply(1);
  const natural = el.offsetWidth;
  // The text is shrunk only when it is longer than the range in which it may be placed.
  const k = Math.min(1, (regionRight - regionLeft) / Math.max(natural, 1));
  if (k < K_MIN_SINGLE) {
    el.style.whiteSpace = "";
    return null;
  }
  apply(k);
  const width = el.offsetWidth;
  // The text is placed with the same alignment as the source, and moved inward only by as much as it sticks out of the range.
  const mid = ((block.x0 + block.x1) / 2) * BASE;
  const anchored = block.align === "center" ? mid - width / 2 : block.align === "right" ? block.x1 * BASE - width : block.x0 * BASE;
  const left = Math.max(regionLeft, Math.min(anchored, regionRight - width));
  el.style.left = `${left}px`;
  return { scale: k, clipped: false };
}

function fitParagraph(el: HTMLDivElement, block: Block, apply: (k: number) => void, wasSingle: boolean): { scale: number; clipped: boolean } {
  const left = wasSingle ? block.regionLeft : block.x0;
  const right = wasSingle ? block.regionRight : block.x1;
  el.style.left = `${left * BASE}px`;
  el.style.width = `${(right - left) * BASE}px`;
  el.style.textAlign = block.align;
  if (block.indentFirst) el.style.textIndent = "1em";
  if (block.hang > 0) {
    el.style.paddingLeft = `${block.hang * BASE}px`;
    el.style.textIndent = `${-block.hang * BASE}px`;
  }

  // Up to the same number of lines as the source counts as "within the box".
  const boxLimit = (block.lines.length + 0.15) * block.pitch * BASE;
  const extendedLimit = Math.max(boxLimit, (block.maxBottom - block.y0) * BASE);
  const fits = (limit: number) => el.offsetHeight <= limit + 1;

  const largest = (low: number, high: number, limit: number): number | null => {
    apply(high);
    if (fits(limit)) return high;
    apply(low);
    if (!fits(limit)) return null;
    for (let i = 0; i < 6; i++) {
      const mid = (low + high) / 2;
      apply(mid);
      if (fits(limit)) low = mid;
      else high = mid;
    }
    return low;
  };

  const k = largest(K_SOFT, 1, boxLimit) ?? largest(K_SOFT, 1, extendedLimit) ?? largest(K_MIN, K_SOFT, extendedLimit);
  if (k !== null) {
    apply(k);
    return { scale: k, clipped: false };
  }
  apply(K_MIN);
  el.style.height = `${extendedLimit}px`;
  return { scale: K_MIN, clipped: true };
}
