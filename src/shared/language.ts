// What the viewer needs to know about the target language, which the user names freely
// ("Japanese", "Brazilian Portuguese", "日本語"…) in the setting pdfTranslation.targetLanguage.

export const DEFAULT_TARGET_LANGUAGE = "Japanese";

/** The setting goes into the prompt, so line breaks and angle brackets are removed and the length is capped. */
export function cleanTargetLanguage(value: unknown): string {
  const text = typeof value === "string" ? value.replace(/[\r\n<>]+/g, " ").trim().slice(0, 80) : "";
  return text || DEFAULT_TARGET_LANGUAGE;
}

interface Known {
  name: RegExp;
  /** The BCP 47 tag for the lang attribute, which picks the right glyphs for Chinese, Japanese and Korean. */
  tag: string;
  /** Matches a character of the script the language is written in, when that is not Latin. */
  script?: RegExp;
}

const HAN = /[㐀-鿿]/;
const KNOWN: Known[] = [
  { name: /japanese|日本語/i, tag: "ja", script: /[぀-ヿ㐀-鿿]/ },
  { name: /traditional chinese|cantonese|繁體|正體/i, tag: "zh-Hant", script: HAN },
  { name: /chinese|mandarin|中文|简体|汉语/i, tag: "zh-Hans", script: HAN },
  { name: /korean|한국어/i, tag: "ko", script: /[ᄀ-ᇿ가-힯]/ },
  { name: /russian|русский/i, tag: "ru", script: /[Ѐ-ӿ]/ },
  { name: /ukrainian|українська/i, tag: "uk", script: /[Ѐ-ӿ]/ },
  { name: /bulgarian|belarusian|kazakh|mongolian|macedonian/i, tag: "", script: /[Ѐ-ӿ]/ },
  { name: /greek|ελληνικά/i, tag: "el", script: /[Ͱ-Ͽ]/ },
  { name: /arabic|العربية/i, tag: "ar", script: /[؀-ۿ]/ },
  { name: /persian|farsi|urdu|فارسی|اردو/i, tag: "", script: /[؀-ۿ]/ },
  { name: /hebrew|עברית/i, tag: "he", script: /[֐-׿]/ },
  { name: /thai|ไทย/i, tag: "th", script: /[฀-๿]/ },
  { name: /hindi|marathi|nepali|हिन्दी/i, tag: "hi", script: /[ऀ-ॿ]/ },
  { name: /english/i, tag: "en" },
  { name: /spanish|español/i, tag: "es" },
  { name: /french|français/i, tag: "fr" },
  { name: /german|deutsch/i, tag: "de" },
  { name: /portuguese|português/i, tag: "pt" },
  { name: /italian|italiano/i, tag: "it" },
  { name: /vietnamese|tiếng việt/i, tag: "vi" },
];

function find(language: string): Known | undefined {
  return KNOWN.find((known) => known.name.test(language));
}

/** The value for the lang attribute of translated text, or "" when the language is not recognized. */
export function languageTag(language: string): string {
  return find(language)?.tag ?? "";
}

function squash(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/[\s­-]+/g, "");
}

/**
 * Whether the model returned a block as it was, as it should for a line of names, a formula or a
 * reference. Such a block keeps its original rendering. When the target language has its own
 * script, a "translation" without a single character of that script counts as untranslated;
 * otherwise only a text that equals the source does.
 */
export function isLeftUntranslated(source: string, translation: string, language: string): boolean {
  const script = find(language)?.script;
  if (script) return !script.test(translation);
  return squash(source) === squash(translation);
}
