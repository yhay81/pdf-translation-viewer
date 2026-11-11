// Builds samples/sample.pdf from samples/sample.tex (pdflatex is required).
import { execFileSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// pdflatex runs twice, to resolve the cross-references.
for (let pass = 0; pass < 2; pass++) {
  execFileSync("pdflatex", ["-interaction=nonstopmode", "-halt-on-error", "sample.tex"], { cwd: here, stdio: "ignore" });
}
console.log("Built samples/sample.pdf.");
