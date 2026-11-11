// 拡張ホスト用（Node）と Webview 用（ブラウザ）を別々にバンドルし、PDF.js の付属ファイルを dist へ写す。
import * as esbuild from "esbuild";
import { cp, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const watch = process.argv.includes("--watch");
const withTests = process.argv.includes("--tests");
const production = process.argv.includes("--production");

const common = {
  absWorkingDir: root,
  bundle: true,
  sourcemap: !production,
  minify: production,
  logLevel: "info",
};
const node = { ...common, platform: "node", format: "cjs", target: "node20" };

const builds = [
  { ...node, entryPoints: ["src/extension.ts"], outfile: "dist/extension.js", external: ["vscode"] },
  // pdf.js はトップレベル await を使うので、Webview 側は ES モジュールとして出力する。
  { ...common, entryPoints: ["src/webview/main.ts"], outfile: "dist/webview/main.js", platform: "browser", format: "esm", target: "es2022" },
  { ...common, entryPoints: ["src/webview/style.css"], outfile: "dist/webview/style.css" },
];
if (withTests) {
  builds.push(
    { ...node, entryPoints: ["test/unit/index.ts"], outfile: "dist/test/unit.test.cjs" },
    { ...node, entryPoints: ["test/vscode/suite.ts"], outfile: "dist/test/vscodeSuite.js", external: ["vscode"] },
  );
}

async function copyPdfjsAssets() {
  const pdfjs = path.join(root, "node_modules/pdfjs-dist");
  const out = path.join(root, "dist/webview");
  await mkdir(out, { recursive: true });
  await cp(path.join(pdfjs, "build/pdf.worker.min.mjs"), path.join(out, "pdf.worker.min.mjs"));
  for (const dir of ["cmaps", "standard_fonts", "wasm"]) {
    await cp(path.join(pdfjs, dir), path.join(out, dir), { recursive: true });
  }
}

await copyPdfjsAssets();
if (watch) {
  const contexts = await Promise.all(builds.map((b) => esbuild.context(b)));
  await Promise.all(contexts.map((c) => c.watch()));
} else {
  await Promise.all(builds.map((b) => esbuild.build(b)));
}
