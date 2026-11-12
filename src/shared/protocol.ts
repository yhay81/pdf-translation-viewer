// The messages between the extension host and the webview.

/** The source text of one block to translate. */
export interface SourceBlock {
  id: string;
  text: string;
}

/** Where the webview finds the files that PDF.js loads at run time. */
export interface WebviewAssets {
  workerUrl: string;
  cMapUrl: string;
  standardFontDataUrl: string;
  wasmUrl: string;
}

export type HostToWebview =
  | { type: "init"; fileName: string; data: Uint8Array; assets: WebviewAssets; modelLabel: string | null; targetLanguage: string }
  | { type: "modelChanged"; modelLabel: string | null }
  | { type: "retryPage"; page: number }
  | { type: "targetLanguageChanged"; targetLanguage: string }
  | { type: "blockTranslated"; requestId: number; id: string; text: string; cached: boolean }
  | { type: "translateDone"; requestId: number; missing: string[]; modelLabel: string }
  | { type: "translateError"; requestId: number; message: string }
  | { type: "command"; name: "translateCurrentPage" };

export type WebviewToHost =
  | { type: "ready" }
  | { type: "translatePage"; requestId: number; page: number; blocks: SourceBlock[] }
  | { type: "cancel"; requestId: number }
  | { type: "selectModel" }
  | { type: "report"; event: WebviewReport };

/** Progress that the webview reports to the extension host, for the log and the end-to-end test. */
export type WebviewReport =
  | { kind: "documentLoaded"; pages: number; workerKind: "worker" | "main-thread" }
  | { kind: "pageRendered"; page: number; ms: number }
  | {
      kind: "pageTranslated";
      page: number;
      /** Blocks sent for translation */
      requested: number;
      /** Blocks whose translation was laid over the page */
      placed: number;
      /** Blocks that came back untranslated, and so keep their original rendering */
      kept: number;
      /** Blocks whose translation did not fit and was cut short */
      clipped: number;
      /** Blocks where the text-free rendering really differed from the normal one */
      inkRemoved: number;
      missing: number;
    }
  | { kind: "error"; message: string };
