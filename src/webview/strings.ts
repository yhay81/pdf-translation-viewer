// The messages of the webview in the display language of VS Code. The extension host writes them
// into the page as JSON (see PdfEditorProvider.html); without that block, they are in English.
import { WEBVIEW_STRINGS, format, type WebviewStringKey, type WebviewStringTable } from "../shared/strings";

function read(): WebviewStringTable {
  const json = document.getElementById("l10n")?.textContent;
  if (!json) return WEBVIEW_STRINGS;
  try {
    return { ...WEBVIEW_STRINGS, ...(JSON.parse(json) as Partial<WebviewStringTable>) };
  } catch {
    return WEBVIEW_STRINGS;
  }
}

const table = read();

export function t(key: WebviewStringKey, ...args: (string | number)[]): string {
  return format(table[key], args);
}
