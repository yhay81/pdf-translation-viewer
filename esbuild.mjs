// Bundles the extension host (Node) and the webview (browser) separately, and copies the files
// that PDF.js loads at run time into dist/.
import * as esbuild from "esbuild";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const watch = process.argv.includes("--watch");
const withTests = process.argv.includes("--tests");
const production = process.argv.includes("--production");
const pdfjs = path.join(root, "node_modules/pdfjs-dist");

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
  // PDF.js uses top-level await, so the webview bundle is an ES module.
  { ...common, entryPoints: ["src/webview/main.ts"], outfile: "dist/webview/main.js", platform: "browser", format: "esm", target: "es2022" },
  { ...common, entryPoints: ["src/webview/style.css"], outfile: "dist/webview/style.css" },
];
if (withTests) {
  builds.push(
    { ...node, entryPoints: ["test/unit/index.ts"], outfile: "dist/test/unit.test.cjs" },
    { ...node, entryPoints: ["test/e2e/suite.ts"], outfile: "dist/test/e2eSuite.js", external: ["vscode"] },
  );
}

/** The worker, the character maps, the standard fonts and the image decoders, which PDF.js fetches when a PDF needs them. */
async function copyPdfjsAssets() {
  const out = path.join(root, "dist/webview");
  await mkdir(out, { recursive: true });
  await cp(path.join(pdfjs, "build/pdf.worker.min.mjs"), path.join(out, "pdf.worker.min.mjs"));
  for (const dir of ["cmaps", "standard_fonts", "wasm"]) {
    await cp(path.join(pdfjs, dir), path.join(out, dir), { recursive: true });
  }
}

/**
 * The production bundles drop license comments, so the licenses of PDF.js and of the files copied
 * from it are collected into one file that ships with the extension.
 */
async function writeThirdPartyNotices(outfile) {
  const manifest = JSON.parse(await readFile(path.join(pdfjs, "package.json"), "utf8"));
  const sections = [{ title: `${manifest.name}@${manifest.version} (${manifest.license})`, file: path.join(pdfjs, "LICENSE") }];
  for (const dir of ["cmaps", "standard_fonts", "wasm"]) {
    const names = (await readdir(path.join(pdfjs, dir))).filter((name) => /^licen[cs]e/i.test(name)).sort();
    for (const name of names) sections.push({ title: `${manifest.name}/${dir}: ${name}`, file: path.join(pdfjs, dir, name) });
  }
  const rule = "=".repeat(78);
  const parts = ["This extension bundles PDF.js and the following files that are distributed with it.\n"];
  for (const { title, file } of sections) parts.push(`${rule}\n${title}\n${rule}\n\n${(await readFile(file, "utf8")).trim()}\n`);
  await writeFile(path.join(root, outfile), parts.join("\n"));
  console.log(`${outfile}: ${sections.length} licenses`);
}

// A production build starts from an empty dist/, so that nothing from a development build is packaged.
if (production) await rm(path.join(root, "dist"), { recursive: true, force: true });
await copyPdfjsAssets();
await writeThirdPartyNotices("dist/ThirdPartyNotices.txt");
if (watch) {
  const contexts = await Promise.all(builds.map((b) => esbuild.context(b)));
  await Promise.all(contexts.map((c) => c.watch()));
} else {
  await Promise.all(builds.map((b) => esbuild.build(b)));
}
