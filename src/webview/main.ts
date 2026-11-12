// The webview itself. It shows the original on the left and, beside it on the right, the background with its text removed plus the translation.
import * as pdfjs from "pdfjs-dist";
import type { PDFDocumentProxy, PDFPageProxy, PageViewport, RenderTask } from "pdfjs-dist";
import { DEFAULT_TARGET_LANGUAGE, isLeftUntranslated, languageTag } from "../shared/language";
import type { HostToWebview, WebviewReport, WebviewToHost } from "../shared/protocol";
import { segmentPage, type Block, type FontInfo, type Run } from "./layout";
import { t } from "./strings";
import { BASE, placeBlock, type Placed } from "./typeset";

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };

const host = acquireVsCodeApi();
const post = (message: WebviewToHost) => host.postMessage(message);
const report = (event: WebviewReport) => post({ type: "report", event });

/** The operators that draw text. Rendering with only these skipped gives the text-free background. */
const TEXT_OPS = new Set<number>([
  pdfjs.OPS.showText,
  pdfjs.OPS.showSpacedText,
  pdfjs.OPS.nextLineShowText,
  pdfjs.OPS.nextLineSetSpacingShowText,
]);

const ZOOM_STEP = 1.2;
const PAGE_GAP = 12;

interface SampledStyle {
  color: string;
  background: string;
  /** The normal rendering and the text-free rendering differed (= the text is really gone) */
  ink: boolean;
}

interface PageView {
  num: number;
  /** The size of the page (pt) */
  width: number;
  height: number;
  left: HTMLDivElement;
  right: HTMLDivElement;
  /** The normal rendering. It is shown as it is in the left pane */
  full: HTMLCanvasElement;
  /** The text-free rendering. It is not shown on screen, and is used to compose the right pane */
  bare: HTMLCanvasElement | null;
  /** The composed result shown in the right pane */
  composed: HTMLCanvasElement;
  textLayer: HTMLDivElement;
  debugLayer: HTMLDivElement;
  highlight: HTMLDivElement;
  badge: HTMLDivElement;
  page: PDFPageProxy | null;
  /** The scale at which full / bare were rendered (device pixels / pt). 0 means not rendered yet */
  pixelScale: number;
  generation: number;
  tasks: Set<RenderTask>;
  visible: boolean;
  blocks: Block[] | null;
  blockById: Map<string, Block>;
  fonts: Map<string, FontInfo>;
  translations: Map<string, string>;
  placed: Map<string, Placed>;
  kept: Set<string>;
  styles: Map<string, SampledStyle>;
  request: { id: number; requested: number; received: number } | null;
}

const state = {
  scale: 1,
  fitWidth: true,
  showBare: false,
  showBlocks: false,
  requestSeq: 0,
  modelLabel: null as string | null,
  targetLanguage: DEFAULT_TARGET_LANGUAGE,
};

let doc: PDFDocumentProxy | null = null;
const pages: PageView[] = [];
const requests = new Map<number, PageView>();
let renderQueue: Promise<void> = Promise.resolve();

// ---------------------------------------------------------------- The skeleton of the screen

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const toolbar = el("div");
toolbar.id = "toolbar";
const pageIndicator = el("span", "indicator", "– / –");
const zoomOut = el("button", "", "−");
const zoomLabel = el("span", "indicator", "100%");
const zoomIn = el("button", "", "＋");
const fitButton = el("button", "", t("fitWidth"));
const translateButton = el("button", "primary", t("translatePage"));
const modelButton = el("button", "", t("model", t("noModel")));
const bareToggle = el("label", "toggle");
const bareInput = el("input");
bareInput.type = "checkbox";
bareToggle.append(bareInput, t("textFree"));
const blocksToggle = el("label", "toggle");
const blocksInput = el("input");
blocksInput.type = "checkbox";
blocksToggle.append(blocksInput, t("blockOutlines"));
const statusText = el("span", "status");
zoomOut.title = t("zoomOut");
zoomIn.title = t("zoomIn");
translateButton.title = t("translatePageTitle", state.targetLanguage);
modelButton.title = t("modelTitle");
bareToggle.title = t("textFreeTitle");
blocksToggle.title = t("blockOutlinesTitle");
toolbar.append(pageIndicator, zoomOut, zoomLabel, zoomIn, fitButton, translateButton, modelButton, bareToggle, blocksToggle, statusText);

const panes = el("div");
panes.id = "panes";
function makePane(label: string): { pane: HTMLDivElement; list: HTMLDivElement } {
  const pane = el("div", "pane");
  const list = el("div", "pages");
  const tag = el("div", "pane-label");
  tag.append(el("span", "", label));
  pane.append(tag, list);
  return { pane, list };
}
const leftPane = makePane(t("source"));
const rightPane = makePane(t("translation"));
panes.append(leftPane.pane, rightPane.pane);
document.body.append(toolbar, panes);

function setStatus(text: string, isError = false): void {
  statusText.textContent = text;
  // The toolbar cuts a long status short; pointing at it shows all of it.
  statusText.title = text;
  statusText.classList.toggle("error", isError);
}

function fail(context: string, err: unknown): void {
  const message = `${context}: ${err instanceof Error ? err.message : String(err)}`;
  console.error(context, err);
  setStatus(message, true);
  report({ kind: "error", message });
}

// ---------------------------------------------------------------- Creating and sizing the pages

function makeLayer(parent: HTMLElement, className: string): HTMLDivElement {
  const layer = el("div", `layer ${className}`);
  parent.append(layer);
  return layer;
}

function createPageView(num: number, width: number, height: number): PageView {
  const left = el("div", "page");
  const right = el("div", "page");
  left.dataset.page = right.dataset.page = String(num);
  const full = el("canvas");
  const composed = el("canvas");
  left.append(full);
  right.append(composed);
  const highlightLayer = makeLayer(left, "highlight-layer");
  const highlight = el("div", "highlight");
  highlightLayer.append(highlight);
  const debugLayer = makeLayer(right, "debug-layer");
  const textLayer = makeLayer(right, "text-layer");
  const badge = el("div", "badge");
  right.append(badge);
  leftPane.list.append(left);
  rightPane.list.append(right);
  const view: PageView = {
    num,
    width,
    height,
    left,
    right,
    full,
    bare: null,
    composed,
    textLayer,
    debugLayer,
    highlight,
    badge,
    page: null,
    pixelScale: 0,
    generation: 0,
    tasks: new Set(),
    visible: false,
    blocks: null,
    blockById: new Map(),
    fonts: new Map(),
    translations: new Map(),
    placed: new Map(),
    kept: new Set(),
    styles: new Map(),
    request: null,
  };
  sizePage(view);
  return view;
}

function sizePage(view: PageView): void {
  const w = `${view.width * state.scale}px`;
  const h = `${view.height * state.scale}px`;
  for (const page of [view.left, view.right]) {
    page.style.width = w;
    page.style.height = h;
    for (const layer of page.querySelectorAll<HTMLElement>(":scope > .layer")) {
      layer.style.width = `${view.width * BASE}px`;
      layer.style.height = `${view.height * BASE}px`;
      layer.style.transform = `scale(${state.scale / BASE})`;
    }
  }
}

function targetPixelScale(): number {
  return state.scale * (window.devicePixelRatio || 1);
}

function fitScale(): number {
  const first = pages[0];
  if (!first) return 1;
  const available = leftPane.pane.clientWidth - 2 * PAGE_GAP;
  return Math.max(0.25, available / first.width);
}

function setScale(scale: number): void {
  const next = Math.min(6, Math.max(0.25, scale));
  if (Math.abs(next - state.scale) < 1e-4) return;
  const ratio = next / state.scale;
  const { scrollTop, scrollLeft } = leftPane.pane;
  state.scale = next;
  for (const view of pages) sizePage(view);
  leftPane.pane.scrollTop = rightPane.pane.scrollTop = scrollTop * ratio;
  leftPane.pane.scrollLeft = rightPane.pane.scrollLeft = scrollLeft * ratio;
  zoomLabel.textContent = `${Math.round(next * 100)}%`;
  scheduleRender();
}

let renderTimer: number | undefined;
function scheduleRender(): void {
  window.clearTimeout(renderTimer);
  renderTimer = window.setTimeout(() => {
    for (const view of pages) if (view.visible) enqueueRender(view);
  }, 120);
}

// ---------------------------------------------------------------- Rendering

function cancelTasks(view: PageView): void {
  for (const task of view.tasks) task.cancel();
  view.tasks.clear();
}

/** Renders one page onto a new canvas. With withoutText, only the operators that draw text are skipped. */
async function draw(view: PageView, page: PDFPageProxy, viewport: PageViewport, withoutText: boolean): Promise<HTMLCanvasElement | null> {
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(viewport.width);
  canvas.height = Math.round(viewport.height);
  const task = page.render({
    canvas,
    viewport,
    operationsFilter: withoutText ? (index, operatorList) => !TEXT_OPS.has(operatorList.fnArray[index]) : undefined,
  });
  view.tasks.add(task);
  try {
    await task.promise;
    return canvas;
  } catch (err) {
    if (err instanceof pdfjs.RenderingCancelledException) return null;
    throw err;
  } finally {
    view.tasks.delete(task);
  }
}

function needsBare(view: PageView): boolean {
  return state.showBare || view.translations.size > 0 || view.request !== null;
}

async function render(view: PageView): Promise<void> {
  if (!doc) return;
  const generation = ++view.generation;
  cancelTasks(view);
  const started = performance.now();
  const page = (view.page ??= await doc.getPage(view.num));
  const base = page.getViewport({ scale: 1 });
  if (Math.abs(base.width - view.width) > 0.5 || Math.abs(base.height - view.height) > 0.5) {
    view.width = base.width;
    view.height = base.height;
    sizePage(view);
  }
  const pixelScale = targetPixelScale();
  const viewport = page.getViewport({ scale: pixelScale });
  const full = await draw(view, page, viewport, false);
  if (!full || generation !== view.generation) return;
  const bare = needsBare(view) ? await draw(view, page, viewport, true) : null;
  if (generation !== view.generation) return;

  view.full.replaceWith(full);
  view.full = full;
  view.bare = bare;
  view.pixelScale = pixelScale;
  restyle(view);
  compose(view);
  if (state.showBlocks) void drawDebug(view);
  report({ kind: "pageRendered", page: view.num, ms: Math.round(performance.now() - started) });
}

function enqueueRender(view: PageView): void {
  renderQueue = renderQueue
    .then(() => (view.visible && view.pixelScale !== targetPixelScale() ? render(view) : undefined))
    .catch((err) => fail(t("renderFailed", view.num), err));
}

/** Prepares the text-free rendering at the current scale if there is none yet. */
async function ensureBare(view: PageView): Promise<void> {
  if (view.bare || !view.page || view.pixelScale === 0) return;
  const generation = view.generation;
  const bare = await draw(view, view.page, view.page.getViewport({ scale: view.pixelScale }), true);
  if (bare && generation === view.generation) view.bare = bare;
}

function release(view: PageView): void {
  if (view.request || view.pixelScale === 0) return;
  view.generation++;
  cancelTasks(view);
  view.full.width = view.full.height = 0;
  view.composed.width = view.composed.height = 0;
  view.bare = null;
  view.pixelScale = 0;
}

/** Makes the image of the right pane. It copies the normal rendering, and overwrites only the lines of the blocks already translated with the text-free rendering. */
function compose(view: PageView): void {
  if (view.pixelScale === 0) return;
  const { full, bare, composed } = view;
  if (composed.width !== full.width || composed.height !== full.height) {
    composed.width = full.width;
    composed.height = full.height;
  }
  const ctx = composed.getContext("2d", { alpha: false })!;
  if (state.showBare && bare) {
    ctx.drawImage(bare, 0, 0);
    return;
  }
  ctx.drawImage(full, 0, 0);
  if (!bare) return;
  for (const id of view.placed.keys()) {
    const block = view.blockById.get(id);
    if (block) erase(ctx, view, bare, block);
  }
}

function erase(ctx: CanvasRenderingContext2D, view: PageView, bare: HTMLCanvasElement, block: Block): void {
  const s = view.pixelScale;
  for (const line of block.lines) {
    const x = Math.max(0, Math.floor(line.erase.x * s));
    const y = Math.max(0, Math.floor(line.erase.y * s));
    const w = Math.min(bare.width, Math.ceil((line.erase.x + line.erase.w) * s)) - x;
    const h = Math.min(bare.height, Math.ceil((line.erase.y + line.erase.h) * s)) - y;
    if (w > 0 && h > 0) ctx.drawImage(bare, x, y, w, h, x, y, w, h);
  }
}

// ---------------------------------------------------------------- Extracting the text and forming blocks

function clamp(value: number | undefined, min: number, max: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value !== 0 ? Math.min(max, Math.max(min, value)) : fallback;
}

const BOLD_NAME = /bold|black|heavy|demi|medi|cmbx|cmssbx|sfbx|ptmb|phvb|-bd\b/i;
const ITALIC_NAME = /ital|obli|cmti|cmsl|cmmi|sfti|-it\b/i;
const MONO_NAME = /courier|mono|consolas|menlo|cmtt|lmtt|typewriter|inconsolata|firacode|sourcecode/i;
const SANS_NAME = /sans|helvet|arial|gothic|cmss|lmss|verdana|tahoma|calibri|segoe|roboto|frutiger|univers|futura|avenir|myriad|lato|phv/i;
const SERIF_NAME =
  /times|roman|serif|georgia|garamond|palatino|minion|cambria|cmr\d|cmbx|cmti|cmsl|cmcsc|lmr|nimbusrom|utopia|charter|bookman|century|schoolbook|sfrm|sfbx|sfti|baskerville|caslon|didot|stix|libertin|termes|pagella|ptm|mincho/i;

const MATH_NAME = /math|cmmi|cmsy|cmex|msam|msbm|eusm|eufm|rsfs|symbol|mtsy|mtex|rmtmi/i;

interface PdfFont {
  /** The PostScript name. It is present only when fontExtraProperties: true is passed to getDocument. */
  name?: string;
  bold?: boolean;
  black?: boolean;
  italic?: boolean;
  isMonospace?: boolean;
  isSerifFont?: boolean;
}

/** Estimates the kind of font of the source (whether it is serif, bold or monospace) from the font name and from what PDF.js determined. */
function describeFont(page: PDFPageProxy, fontName: string, family: string | undefined): FontInfo {
  let font: PdfFont = {};
  try {
    if (page.commonObjs.has(fontName)) font = (page.commonObjs.get(fontName) ?? {}) as PdfFont;
  } catch {
    // When the font is not loaded yet, only what PDF.js determined is used.
  }
  // The subset tag (ABCDEF+) at the start of the name of an embedded font is removed.
  const name = String(font.name ?? "").replace(/^[A-Z]{6}\+/, "");
  const math = MATH_NAME.test(name);
  // The flags in the font descriptor of a PDF are often unreliable (with TeX fonts, for example), so what the name says takes priority.
  const named = name !== "";
  const mono = MONO_NAME.test(name) || (!named && (font.isMonospace === true || family === "monospace"));
  const sans = SANS_NAME.test(name);
  const serif = !mono && !sans && (SERIF_NAME.test(name) || font.isSerifFont === true || (!named && family === "serif"));
  return {
    bold: BOLD_NAME.test(name) || font.bold === true || font.black === true,
    italic: ITALIC_NAME.test(name) || font.italic === true,
    serif,
    mono,
    math,
  };
}

async function ensureBlocks(view: PageView): Promise<Block[]> {
  if (view.blocks) return view.blocks;
  const page = view.page!;
  const viewport = page.getViewport({ scale: 1 });
  const content = await page.getTextContent();
  const runs: Run[] = [];
  let spaceBefore = false;
  for (const item of content.items) {
    if (!("str" in item)) continue;
    if (!item.str.trim()) {
      spaceBefore = true;
      continue;
    }
    const m = pdfjs.Util.transform(viewport.transform, item.transform) as number[];
    const size = Math.hypot(m[2], m[3]);
    const rotated = Math.abs(Math.atan2(m[1], m[0])) > 0.02;
    if (size >= 1 && !rotated && item.dir !== "ttb") {
      const style = content.styles[item.fontName];
      const ascent = clamp(style?.ascent, 0.6, 1.1, 0.9);
      const descent = clamp(style?.descent, -0.45, -0.05, -0.22);
      runs.push({
        str: item.str,
        x0: m[4],
        x1: m[4] + item.width,
        baseline: m[5],
        top: m[5] - ascent * size,
        bottom: m[5] - descent * size,
        size,
        font: item.fontName,
        spaceBefore,
      });
      if (!view.fonts.has(item.fontName)) view.fonts.set(item.fontName, describeFont(page, item.fontName, style?.fontFamily));
    }
    spaceBefore = false;
  }
  const blocks = runs.length ? segmentPage(runs, view.fonts, { width: viewport.width, height: viewport.height }, view.num) : [];
  view.blocks = blocks;
  view.blockById = new Map(blocks.map((block) => [block.id, block]));
  return blocks;
}

// ---------------------------------------------------------------- Placing the translations

const DEFAULT_STYLE: SampledStyle = { color: "#000000", background: "#ffffff", ink: false };

function rgb(r: number, g: number, b: number): string {
  return `rgb(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)})`;
}

/**
 * Finds the text color and the background color from the pixel differences between the normal rendering and the text-free rendering.
 * The color of the pixels that differ the most (the core of the glyphs) is taken as the text color.
 */
function sampleStyle(view: PageView, block: Block): SampledStyle {
  const bare = view.bare;
  if (!bare || view.pixelScale === 0) return DEFAULT_STYLE;
  const s = view.pixelScale;
  const line = block.lines[0];
  const x = Math.max(0, Math.floor(line.x0 * s));
  const y = Math.max(0, Math.floor(line.top * s));
  const w = Math.min(bare.width - x, Math.ceil((line.x1 - line.x0) * s));
  const h = Math.min(bare.height - y, Math.ceil((line.bottom - line.top) * s));
  if (w <= 0 || h <= 0) return DEFAULT_STYLE;
  const a = view.full.getContext("2d")!.getImageData(x, y, w, h).data;
  const b = bare.getContext("2d")!.getImageData(x, y, w, h).data;

  let max = 0;
  const bg = [0, 0, 0];
  for (let i = 0; i < a.length; i += 4) {
    const d = Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
    if (d > max) max = d;
    bg[0] += b[i];
    bg[1] += b[i + 1];
    bg[2] += b[i + 2];
  }
  const pixels = a.length / 4;
  const background = rgb(bg[0] / pixels, bg[1] / pixels, bg[2] / pixels);
  if (max < 48) return { ...DEFAULT_STYLE, background };

  const fg = [0, 0, 0];
  let count = 0;
  for (let i = 0; i < a.length; i += 4) {
    const d = Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
    if (d >= 0.75 * max) {
      fg[0] += a[i];
      fg[1] += a[i + 1];
      fg[2] += a[i + 2];
      count++;
    }
  }
  return { color: rgb(fg[0] / count, fg[1] / count, fg[2] / count), background, ink: true };
}

function place(view: PageView, block: Block, text: string): void {
  view.placed.get(block.id)?.el.remove();
  let style = view.styles.get(block.id);
  if (!style && view.bare) {
    style = sampleStyle(view, block);
    view.styles.set(block.id, style);
  }
  style ??= DEFAULT_STYLE;
  const placed = placeBlock(view.textLayer, block, text, { ...style, font: view.fonts.get(block.font), lang: languageTag(state.targetLanguage) });
  placed.el.addEventListener("mouseenter", () => showHighlight(view, block));
  placed.el.addEventListener("mouseleave", () => (view.highlight.style.display = "none"));
  view.placed.set(block.id, placed);
  if (view.bare && !state.showBare) erase(view.composed.getContext("2d", { alpha: false })!, view, view.bare, block);
}

/** After a re-render, gives a color to the translations whose color could not be measured yet. */
function restyle(view: PageView): void {
  if (!view.bare) return;
  for (const [id, placed] of view.placed) {
    if (view.styles.has(id)) continue;
    const block = view.blockById.get(id);
    if (!block) continue;
    const style = sampleStyle(view, block);
    view.styles.set(id, style);
    placed.el.style.color = style.color;
    placed.el.style.setProperty("--tb-bg", style.background);
  }
}

function showHighlight(view: PageView, block: Block): void {
  const h = view.highlight.style;
  h.display = "block";
  h.left = `${block.x0 * BASE}px`;
  h.top = `${block.y0 * BASE}px`;
  h.width = `${(block.x1 - block.x0) * BASE}px`;
  h.height = `${(block.y1 - block.y0) * BASE}px`;
}

async function drawDebug(view: PageView): Promise<void> {
  view.debugLayer.replaceChildren();
  if (!state.showBlocks || !view.page || view.pixelScale === 0) return;
  const blocks = await ensureBlocks(view);
  for (const block of blocks) {
    for (const line of block.lines) {
      const mark = el("div", "debug-line");
      mark.style.cssText = `left:${line.erase.x * BASE}px;top:${line.erase.y * BASE}px;width:${line.erase.w * BASE}px;height:${line.erase.h * BASE}px`;
      view.debugLayer.append(mark);
    }
    const box = el("div", block.translatable ? "debug-block" : "debug-block skipped");
    box.style.cssText = `left:${block.x0 * BASE}px;top:${block.y0 * BASE}px;width:${(block.x1 - block.x0) * BASE}px;height:${(block.y1 - block.y0) * BASE}px`;
    box.dataset.label = `${block.id.split("-")[1]} · ${block.align}`;
    view.debugLayer.append(box);
  }
}

// ---------------------------------------------------------------- Translation

function currentPage(): PageView | undefined {
  const top = leftPane.pane.scrollTop + leftPane.pane.clientHeight * 0.35;
  return pages.find((view) => view.left.offsetTop + view.left.offsetHeight > top) ?? pages[pages.length - 1];
}

function setBadge(view: PageView, text: string): void {
  view.badge.textContent = text;
  view.badge.style.display = text ? "block" : "none";
}

async function translate(view: PageView): Promise<void> {
  if (view.request) return;
  try {
    setStatus(t("extracting", view.num));
    if (view.pixelScale === 0) await render(view);
    const blocks = await ensureBlocks(view);
    await ensureBare(view);
    const targets = blocks.filter((b) => b.translatable && !view.translations.has(b.id) && !view.kept.has(b.id));
    if (targets.length === 0) {
      setStatus(t("nothingToTranslate", view.num));
      return;
    }
    const id = ++state.requestSeq;
    view.request = { id, requested: targets.length, received: 0 };
    requests.set(id, view);
    setBadge(view, t("translatingBadge", 0, targets.length));
    setStatus(t("translating", view.num, 0, targets.length));
    post({ type: "translatePage", requestId: id, page: view.num, blocks: targets.map((b) => ({ id: b.id, text: b.text })) });
  } catch (err) {
    fail(t("translateStartFailed", view.num), err);
  }
}

function onBlockTranslated(message: Extract<HostToWebview, { type: "blockTranslated" }>): void {
  const view = requests.get(message.requestId);
  const block = view?.blockById.get(message.id);
  if (!view || !block || !view.request) return;
  view.request.received++;
  if (isLeftUntranslated(block.text, message.text, state.targetLanguage)) {
    // When the translation is the same as the source (a line of only a formula or proper names, for example), the original rendering stays.
    view.kept.add(block.id);
  } else {
    view.translations.set(block.id, message.text);
    place(view, block, message.text);
  }
  const { received, requested } = view.request;
  setBadge(view, t("translatingBadge", received, requested));
  setStatus(t("translating", view.num, received, requested));
}

function finishRequest(requestId: number): PageView | undefined {
  const view = requests.get(requestId);
  requests.delete(requestId);
  if (view) setBadge(view, "");
  return view;
}

function onTranslateDone(message: Extract<HostToWebview, { type: "translateDone" }>): void {
  const view = finishRequest(message.requestId);
  if (!view?.request) return;
  const { requested } = view.request;
  view.request = null;
  const clipped = [...view.placed.values()].filter((p) => p.clipped).length;
  const inkRemoved = [...view.styles.values()].filter((s) => s.ink).length;
  const notes = [
    t("translated", view.num, view.placed.size, message.modelLabel),
    view.kept.size ? t("noteKept", view.kept.size) : "",
    clipped ? t("noteClipped", clipped) : "",
    message.missing.length ? t("noteMissing", message.missing.length) : "",
  ].filter(Boolean);
  setStatus(notes.join(" · "));
  report({
    kind: "pageTranslated",
    page: view.num,
    requested,
    placed: view.placed.size,
    kept: view.kept.size,
    clipped,
    inkRemoved,
    missing: message.missing.length,
  });
}

function onTranslateError(message: Extract<HostToWebview, { type: "translateError" }>): void {
  const view = finishRequest(message.requestId);
  if (!view) return;
  view.request = null;
  setStatus(t("translateFailed", message.message), true);
  report({ kind: "error", message: message.message });
}

function clearTranslations(): void {
  for (const view of pages) {
    if (view.request) {
      post({ type: "cancel", requestId: view.request.id });
      finishRequest(view.request.id);
      view.request = null;
    }
    for (const placed of view.placed.values()) placed.el.remove();
    view.placed.clear();
    view.translations.clear();
    view.kept.clear();
    view.styles.clear();
    view.highlight.style.display = "none";
    compose(view);
  }
}

function setTargetLanguage(language: string, announce: boolean): void {
  if (language === state.targetLanguage) return;
  state.targetLanguage = language;
  translateButton.title = t("translatePageTitle", language);
  clearTranslations();
  if (announce) setStatus(t("targetLanguageChanged", language));
}

// ---------------------------------------------------------------- Loading

/** Normalizes the contents of the PDF that arrived from the host to a Uint8Array. */
function toBytes(data: unknown): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  // The case where a Node Buffer arrived converted to JSON ({ type: "Buffer", data: [...] }).
  const json = data as { data?: unknown } | null;
  if (json && Array.isArray(json.data)) return Uint8Array.from(json.data as number[]);
  throw new Error(t("noData"));
}

async function load(message: Extract<HostToWebview, { type: "init" }>): Promise<void> {
  setModelLabel(message.modelLabel);
  setTargetLanguage(message.targetLanguage, false);
  setStatus(t("loading", message.fileName));

  // A webview cannot start a script in the extension folder, which is on another origin, directly as a Worker.
  // The script is fetched first, and handed over as a blob URL.
  const workerSource = await (await fetch(message.assets.workerUrl)).blob();
  pdfjs.GlobalWorkerOptions.workerSrc = URL.createObjectURL(new Blob([workerSource], { type: "text/javascript" }));
  const worker = new pdfjs.PDFWorker();
  await worker.promise;
  const workerKind = worker.port instanceof Worker ? "worker" : "main-thread";

  const bytes = toBytes(message.data);
  doc = await pdfjs.getDocument({
    data: bytes,
    worker,
    cMapUrl: message.assets.cMapUrl,
    cMapPacked: true,
    standardFontDataUrl: message.assets.standardFontDataUrl,
    wasmUrl: message.assets.wasmUrl,
    // Fonts and CMaps are to be fetched from this document (the main thread), not from the Worker.
    useWorkerFetch: false,
    // The PostScript names of the fonts (used to tell bold, serif and math fonts) are to be passed to the main thread.
    fontExtraProperties: true,
  }).promise;

  const first = await doc.getPage(1);
  const size = first.getViewport({ scale: 1 });
  for (let num = 1; num <= doc.numPages; num++) pages.push(createPageView(num, size.width, size.height));
  pages[0].page = first;
  state.scale = fitScale();
  zoomLabel.textContent = `${Math.round(state.scale * 100)}%`;
  for (const view of pages) sizePage(view);

  // Only the pages near the visible area are rendered, and the canvases of the pages far from it are released.
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const view = pages[Number((entry.target as HTMLElement).dataset.page) - 1];
        view.visible = entry.isIntersecting;
        if (view.visible) enqueueRender(view);
        else release(view);
      }
    },
    { root: leftPane.pane, rootMargin: "100% 0px" },
  );
  for (const view of pages) observer.observe(view.left);

  updateIndicator();
  setStatus("");
  report({ kind: "documentLoaded", pages: doc.numPages, workerKind });
}

function setModelLabel(label: string | null): void {
  // The initial choice can be made while the first translation is waiting for the picker.
  if (state.modelLabel && state.modelLabel !== label) {
    clearTranslations();
    setStatus(t("modelChanged", label ?? t("noModel")));
  }
  state.modelLabel = label;
  modelButton.textContent = t("model", label ?? t("noModel"));
}

function updateIndicator(): void {
  const view = currentPage();
  pageIndicator.textContent = view ? `${view.num} / ${pages.length}` : "– / –";
}

// ---------------------------------------------------------------- Interaction

function syncScroll(from: HTMLElement, to: HTMLElement): void {
  from.addEventListener(
    "scroll",
    () => {
      if (Math.abs(to.scrollTop - from.scrollTop) > 1) to.scrollTop = from.scrollTop;
      if (Math.abs(to.scrollLeft - from.scrollLeft) > 1) to.scrollLeft = from.scrollLeft;
      updateIndicator();
    },
    { passive: true },
  );
}
syncScroll(leftPane.pane, rightPane.pane);
syncScroll(rightPane.pane, leftPane.pane);

zoomIn.addEventListener("click", () => {
  state.fitWidth = false;
  setScale(state.scale * ZOOM_STEP);
});
zoomOut.addEventListener("click", () => {
  state.fitWidth = false;
  setScale(state.scale / ZOOM_STEP);
});
fitButton.addEventListener("click", () => {
  state.fitWidth = true;
  setScale(fitScale());
});
translateButton.addEventListener("click", () => {
  const view = currentPage();
  if (view) void translate(view);
});
modelButton.addEventListener("click", () => post({ type: "selectModel" }));

bareInput.addEventListener("change", async () => {
  state.showBare = bareInput.checked;
  for (const view of pages) {
    if (view.pixelScale === 0) continue;
    try {
      if (state.showBare) await ensureBare(view);
      compose(view);
    } catch (err) {
      fail(t("textFreeFailed", view.num), err);
    }
  }
});
blocksInput.addEventListener("change", () => {
  state.showBlocks = blocksInput.checked;
  for (const view of pages) void drawDebug(view).catch((err) => fail(t("blocksFailed"), err));
});

new ResizeObserver(() => {
  if (state.fitWidth && pages.length) setScale(fitScale());
}).observe(leftPane.pane);

window.addEventListener("message", (event: MessageEvent<HostToWebview>) => {
  const message = event.data;
  if (!message || typeof message.type !== "string") return;
  switch (message.type) {
    case "init":
      void load(message).catch((err) => fail(t("loadFailed"), err));
      break;
    case "modelChanged":
      setModelLabel(message.modelLabel);
      break;
    case "retryPage": {
      const view = pages[message.page - 1];
      if (view) void translate(view);
      break;
    }
    case "targetLanguageChanged":
      setTargetLanguage(message.targetLanguage, true);
      break;
    case "blockTranslated":
      onBlockTranslated(message);
      break;
    case "translateDone":
      onTranslateDone(message);
      break;
    case "translateError":
      onTranslateError(message);
      break;
    case "command":
      translateButton.click();
      break;
  }
});

// Run-time errors and CSP violations are reported to the host (the log and the end-to-end test pick them up).
window.addEventListener("error", (event) => report({ kind: "error", message: `error: ${event.message}` }));
window.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason as unknown;
  // A cancelled rendering is normal: zooming and switching pages both cause it.
  if (reason instanceof pdfjs.RenderingCancelledException) return;
  report({ kind: "error", message: `unhandledrejection: ${reason instanceof Error ? reason.message : String(reason)}` });
});
document.addEventListener("securitypolicyviolation", (event) =>
  report({ kind: "error", message: `CSP: ${event.violatedDirective} ${event.blockedURI}` }),
);

post({ type: "ready" });
