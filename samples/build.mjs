// samples/sample.tex から samples/sample.pdf を作る（pdflatex が必要）。
import { execFileSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// 相互参照を解決するために 2 回かける。
for (let pass = 0; pass < 2; pass++) {
  execFileSync("pdflatex", ["-interaction=nonstopmode", "-halt-on-error", "sample.tex"], { cwd: here, stdio: "ignore" });
}
console.log("samples/sample.pdf を作りました。");
