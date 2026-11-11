// DOM にも VS Code にも依存しない部分（翻訳のやり取りの形式、ブロック分割）の単体テスト。
import assert from "node:assert/strict";
import { test } from "node:test";
import { BlockStreamParser, buildPrompt, chunkBlocks } from "../../src/translation/blockProtocol";
import { buildLines, segmentPage, type FontInfo, type Run } from "../../src/webview/layout";

// ---------------------------------------------------------------- 翻訳のやり取り

test("ストリームの途中で切れた断片から、閉じたブロックだけを順に取り出す", () => {
  const parser = new BlockStreamParser();
  assert.deepEqual(parser.push('<b id="p1-0">こん'), []);
  assert.equal(parser.hasPartial, true);
  assert.deepEqual(parser.push('にちは</b>\n<b id="p1-1">A &amp; B は\n  x &lt; y</b>'), [
    { id: "p1-0", text: "こんにちは" },
    { id: "p1-1", text: "A & B は x < y" },
  ]);
  assert.equal(parser.hasPartial, false);
});

test("タグの途中で切れても取り出せる", () => {
  const parser = new BlockStreamParser();
  const found = [];
  for (const piece of ["<b i", 'd="p2-3"', ">訳文で", "ある。</", "b>"]) found.push(...parser.push(piece));
  assert.deepEqual(found, [{ id: "p2-3", text: "訳文である。" }]);
});

test("前後の余計な文や、引用符のない ID も受け付ける", () => {
  const parser = new BlockStreamParser();
  const found = parser.push("以下が訳文です。\n```\n<b id=p1-2>一つ目</b>\n<b id='p1-3'>二つ目</b>\n```");
  assert.deepEqual(found, [
    { id: "p1-2", text: "一つ目" },
    { id: "p1-3", text: "二つ目" },
  ]);
});

test("出力が途中で終わったら hasPartial で分かる", () => {
  const parser = new BlockStreamParser();
  assert.equal(parser.push('<b id="a">完結</b><b id="b">途中まで').length, 1);
  assert.equal(parser.hasPartial, true);
});

test("ブロックを文字数で分ける。順序は保ち、長すぎるブロックは単独で送る", () => {
  const blocks = [
    { id: "a", text: "x".repeat(2500) },
    { id: "b", text: "x".repeat(2500) },
    { id: "c", text: "x".repeat(2500) },
    { id: "d", text: "x".repeat(9000) },
    { id: "e", text: "x".repeat(10) },
  ];
  const chunks = chunkBlocks(blocks, 6000);
  assert.deepEqual(
    chunks.map((chunk) => chunk.map((block) => block.id)),
    [["a", "b"], ["c"], ["d"], ["e"]],
  );
  assert.deepEqual(chunkBlocks([], 6000), []);
});

test("プロンプトには全ブロックが 1 回ずつ入り、原文の < と & はエスケープされる", () => {
  const prompt = buildPrompt([
    { id: "p1-0", text: "if a < b && c > d" },
    { id: "p1-1", text: "plain text" },
  ]);
  assert.equal(prompt.split('<b id="p1-0">').length, 2);
  assert.ok(prompt.includes('<b id="p1-0">if a &lt; b &amp;&amp; c &gt; d</b>'));
  assert.ok(prompt.includes('<b id="p1-1">plain text</b>'));
});

// ---------------------------------------------------------------- ブロック分割

const font = (over: Partial<FontInfo> = {}): FontInfo => ({ bold: false, italic: false, serif: true, mono: false, math: false, ...over });
const FONTS = new Map<string, FontInfo>([
  ["body", font()],
  ["bold", font({ bold: true })],
  ["math", font({ math: true, italic: true })],
]);
const PAGE = { width: 600, height: 800 };

/** x0 から x1 までを占める 1 行分の run を作る。 */
function run(str: string, x0: number, x1: number, baseline: number, size = 10, fontName = "body"): Run {
  return { str, x0, x1, baseline, top: baseline - 0.9 * size, bottom: baseline + 0.22 * size, size, font: fontName, spaceBefore: false };
}

test("字下げで始まる段落の短い最終行を切り離さず、次の字下げで段落を分ける", () => {
  const runs = [
    // 1 つ目の段落（1 行目だけ 10pt 字下げ、最終行は短い）
    run("Existing tools usually follow one of two routes. The", 60, 300, 100),
    run("first converts the document to plain text and then it", 50, 300, 112),
    run("translates the result, which is simple but loses the", 50, 300, 124),
    run("original design.", 50, 120, 136),
    // 2 つ目の段落
    run("In this paper we take a third route. The page is", 60, 300, 148),
    run("drawn twice by the same rendering engine and then", 50, 300, 160),
    run("combined.", 50, 95, 172),
  ];
  const blocks = segmentPage(runs, FONTS, PAGE, 1);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].lines.length, 4);
  assert.equal(blocks[0].align, "justify");
  assert.equal(blocks[0].indentFirst, true);
  assert.ok(blocks[0].text.endsWith("original design."));
  assert.equal(blocks[1].lines.length, 3);
  assert.equal(blocks[0].id, "p1-0");
});

test("左右の端がどちらもずれていて中心がそろう 2 行は、中央揃えとみなす", () => {
  const runs = [
    run("Layout-Preserving Translation of PDF Documents", 100, 500, 60, 16, "bold"),
    run("inside a Code Editor", 215, 385, 80, 16, "bold"),
  ];
  const [title] = segmentPage(runs, FONTS, PAGE, 1);
  assert.equal(title.lines.length, 2);
  assert.equal(title.align, "center");
  assert.equal(title.indentFirst, false);
});

test("見出しの番号と題（空き 1em）は 1 行にまとめ、表の列（空き 1.3em）は分ける", () => {
  const heading = buildLines([run("1", 50, 57, 100, 14, "bold"), run("Introduction", 71, 160, 100, 14, "bold")]);
  assert.equal(heading.length, 1);
  assert.equal(heading[0].text, "1 Introduction");

  const header = buildLines([run("Document type", 50, 110, 200, 9), run("Pages", 122, 145, 200, 9), run("Blocks", 157, 184, 200, 9)]);
  assert.deepEqual(
    header.map((line) => line.text),
    ["Document type", "Pages", "Blocks"],
  );
});

test("表のセルは縦につなげず、同じ列のセルと端がそろう側に揃える", () => {
  const runs = [
    run("Document type", 50, 110, 300, 9),
    run("Pages", 132, 155, 300, 9),
    run("Fit", 200, 212, 300, 9),
    run("Manuals", 50, 85, 314, 9),
    run("40", 145, 155, 314, 9),
    run("96.4", 194, 212, 314, 9),
    run("Reports", 50, 84, 325, 9),
    run("40", 145, 155, 325, 9),
    run("93.1", 194, 212, 325, 9),
  ];
  const blocks = segmentPage(runs, FONTS, PAGE, 2);
  assert.equal(blocks.length, 9);
  const byText = new Map(blocks.map((block) => [block.text, block]));
  assert.equal(byText.get("Document type")?.align, "left");
  assert.equal(byText.get("Pages")?.align, "right");
  assert.equal(byText.get("Manuals")?.translatable, true);
  assert.equal(byText.get("96.4")?.translatable, false);
  // 隣のセルとの空きを半分ずつ分け合うので、置いてよい範囲は重ならない。
  const pages = byText.get("Pages")!;
  const fit = byText.get("Fit")!;
  assert.ok(pages.regionRight < fit.regionLeft);
});

test("別行立ての数式は訳さず、数式が混ざるだけの段落は訳す", () => {
  const equation = segmentPage(
    [run("I", 320, 326, 100, 10, "math"), run("bare", 326, 340, 102, 7), run("(x)", 340, 352, 100, 10, "math"), run("x ∈ R,", 370, 400, 100, 10, "math"), run("otherwise.", 410, 455, 100)],
    FONTS,
    PAGE,
    1,
  );
  assert.equal(equation.some((block) => block.translatable), false);

  const paragraph = segmentPage(
    [
      run("A page is a list of drawing operators. Let", 50, 250, 100),
      run("P", 254, 260, 100, 10, "math"),
      run("be this list and", 264, 300, 100),
      run("let the set of text operators be given. We render the", 50, 300, 112),
      run("full list to obtain an image of the whole page.", 50, 280, 124),
    ],
    FONTS,
    PAGE,
    1,
  );
  assert.equal(paragraph.length, 1);
  assert.equal(paragraph[0].translatable, true);
});

test("行末のハイフンで分かれた単語はつなぎ、複合語のハイフンは残す", () => {
  const split = segmentPage(
    [run("The reader wants the transla-", 50, 300, 100), run("tion to appear next to the original text.", 50, 290, 112)],
    FONTS,
    PAGE,
    1,
  );
  assert.equal(split[0].text, "The reader wants the translation to appear next to the original text.");

  const compound = segmentPage(
    [run("This is a simple and state-of-the-", 50, 300, 100), run("art method for documents.", 50, 200, 112)],
    FONTS,
    PAGE,
    1,
  );
  assert.equal(compound[0].text, "This is a simple and state-of-the- art method for documents.");
});

test("訳文を伸ばしてよい下端は、真下にある次のブロックの手前まで", () => {
  const runs = [
    run("A first paragraph that has two lines of text in", 50, 300, 100),
    run("the left column.", 50, 130, 112),
    run("A second paragraph follows after a clear gap", 50, 300, 160),
    run("below the first.", 50, 125, 172),
  ];
  const [first, second] = segmentPage(runs, FONTS, PAGE, 1);
  assert.ok(first.maxBottom > first.y1);
  assert.ok(first.maxBottom < second.y0);
});
