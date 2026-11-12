// The text shown inside the webview, in English. The webview cannot call vscode.l10n, so the
// extension host looks each message up in the l10n bundle and hands the results to the webview.
// A new message here needs an entry in every l10n/bundle.l10n.*.json.
export const WEBVIEW_STRINGS = {
  fitWidth: "Fit width",
  zoomOut: "Zoom out",
  zoomIn: "Zoom in",
  translatePage: "Translate this page",
  translatePageTitle: "Translate the page on screen into {0}",
  model: "Model: {0}",
  noModel: "none",
  modelTitle: "Choose the model to translate with",
  textFree: "Text-free background",
  textFreeTitle: "Draw the whole right-hand page without its text, not only the translated blocks",
  blockOutlines: "Block outlines",
  blockOutlinesTitle: "Outline the blocks that the page was split into for translation",
  source: "Source",
  translation: "Translation",
  loading: "Loading {0}…",
  extracting: "Page {0}: extracting text…",
  nothingToTranslate: "Page {0}: nothing new to translate",
  translating: "Page {0}: translating… {1}/{2}",
  translatingBadge: "Translating {0}/{1}",
  translated: "Page {0}: {1} blocks translated ({2})",
  noteKept: "{0} left as in the source",
  noteClipped: "{0} cut short to fit",
  noteMissing: "{0} got no translation",
  targetLanguageChanged: "The target language is now {0}. Translate the page again.",
  modelChanged: "The model is now {0}. Translate the page again.",
  translateFailed: "Translation failed: {0}",
  renderFailed: "Could not render page {0}",
  translateStartFailed: "Could not start translating page {0}",
  textFreeFailed: "Could not render page {0} without its text",
  blocksFailed: "Could not find the text blocks",
  loadFailed: "Could not open the PDF",
  noData: "The PDF data did not arrive.",
} as const;

export type WebviewStringKey = keyof typeof WEBVIEW_STRINGS;
export type WebviewStringTable = Record<WebviewStringKey, string>;

/** Fills the placeholders {0}, {1}… of a message. */
export function format(message: string, args: readonly (string | number)[]): string {
  return message.replace(/\{(\d+)\}/g, (placeholder, index: string) => {
    const value = args[Number(index)];
    return value === undefined ? placeholder : String(value);
  });
}
