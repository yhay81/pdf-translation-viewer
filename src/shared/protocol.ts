// 拡張ホストと Webview の間でやり取りするメッセージの型。

/** 翻訳に出す 1 ブロック分の原文。 */
export interface SourceBlock {
  id: string;
  text: string;
}

/** Webview が読み込む PDF.js の付属ファイルの場所。 */
export interface WebviewAssets {
  workerUrl: string;
  cMapUrl: string;
  standardFontDataUrl: string;
  wasmUrl: string;
}

export type HostToWebview =
  | { type: "init"; fileName: string; data: Uint8Array; assets: WebviewAssets; modelLabel: string | null }
  | { type: "modelChanged"; modelLabel: string | null }
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

/** Webview から拡張ホストへ送る進捗の報告。ログと結合テストで使う。 */
export type WebviewReport =
  | { kind: "documentLoaded"; pages: number; workerKind: "worker" | "main-thread" }
  | { kind: "pageRendered"; page: number; ms: number }
  | {
      kind: "pageTranslated";
      page: number;
      /** 翻訳に出したブロック数 */
      requested: number;
      /** 訳文を重ねたブロック数 */
      placed: number;
      /** 訳文が原文のままだったので、原本の表示を残したブロック数 */
      kept: number;
      /** 枠に収まらず省略表示になったブロック数 */
      clipped: number;
      /** 文字なし描画で実際に文字が消えていたブロック数 */
      inkRemoved: number;
      missing: number;
    }
  | { kind: "error"; message: string };
