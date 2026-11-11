// 訳文を、原文のブロックと同じ位置・大きさの枠に収めて置く。
import type { Block, FontInfo } from "./layout";

/**
 * 訳文のレイヤーは、ページの pt 座標を BASE 倍した大きさで組版し、CSS の transform で表示倍率に合わせる。
 * 小さい文字でもブラウザの最小フォントサイズに掛からず、ズームしても改行位置が変わらない。
 */
export const BASE = 4;

/** ここまでは枠の中で縮める。これより小さくするくらいなら、下の余白へ伸ばす。 */
const K_SOFT = 0.85;
/** 縮小の下限。これでも収まらなければ省略表示にする。 */
const K_MIN = 0.7;
/** 1 行のブロックを 1 行のまま縮める下限。これを下回るなら折り返す。 */
const K_MIN_SINGLE = 0.6;

const SERIF = '"Times New Roman", Times, "Hiragino Mincho ProN", "Yu Mincho", YuMincho, "Noto Serif CJK JP", "Noto Serif JP", serif';
const SANS = 'Helvetica, Arial, "Hiragino Sans", "Hiragino Kaku Gothic ProN", "Yu Gothic", YuGothic, "Noto Sans CJK JP", "Noto Sans JP", sans-serif';
const MONO = 'Menlo, Consolas, "Courier New", "Osaka-Mono", "MS Gothic", monospace';

export interface BlockStyle {
  color: string;
  background: string;
  font: FontInfo | undefined;
}

export interface Placed {
  el: HTMLDivElement;
  /** 原文のフォントサイズに対する倍率 */
  scale: number;
  clipped: boolean;
}

export function placeBlock(layer: HTMLElement, block: Block, text: string, style: BlockStyle): Placed {
  const el = document.createElement("div");
  el.className = "tb";
  el.lang = "ja";
  el.dataset.id = block.id;
  el.title = block.text;
  el.style.color = style.color;
  el.style.setProperty("--tb-bg", style.background);
  el.style.fontFamily = style.font?.mono ? MONO : style.font?.serif ? SERIF : SANS;
  el.style.fontWeight = style.font?.bold ? "700" : "400";

  // 幅も高さも 0 のインラインブロックは、下端が文字のベースラインに乗る。1 行目のベースライン位置を測るために使う。
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

  // 1 行目のベースラインを原文に合わせる。
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
  // 置いてよい範囲より長いときだけ縮める。
  const k = Math.min(1, (regionRight - regionLeft) / Math.max(natural, 1));
  if (k < K_MIN_SINGLE) {
    el.style.whiteSpace = "";
    return null;
  }
  apply(k);
  const width = el.offsetWidth;
  // 原文と同じ揃え方で置き、範囲からはみ出す分だけ内側へずらす。
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

  // 原文と同じ行数までを「枠の中」とみなす。
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
