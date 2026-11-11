// 結合テストの起動役。手元にインストールしてある VS Code を、使い捨てのプロファイルで立ち上げる
// （ふだんの設定や拡張には触れない。翻訳はダミーに固定するので、モデルも呼ばない）。
import { runTests } from "@vscode/test-electron";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const candidates = [
  process.env.VSCODE_EXECUTABLE,
  "/Applications/Visual Studio Code.app/Contents/MacOS/Code",
  "/Applications/Visual Studio Code.app/Contents/MacOS/Electron",
  "/usr/share/code/code",
].filter(Boolean);
const executable = candidates.find((candidate) => existsSync(candidate));
if (!executable) {
  console.error("VS Code の実行ファイルが見つかりません。環境変数 VSCODE_EXECUTABLE に場所を指定してください。");
  process.exit(2);
}

// ソケットのパス長の制限にかからないよう、短い一時ディレクトリを使う。
const scratch = mkdtempSync(join(tmpdir(), "bpv-"));
const resultFile = join(scratch, "result.json");
let failed = false;
try {
  await runTests({
    vscodeExecutablePath: executable,
    extensionDevelopmentPath: root,
    extensionTestsPath: join(root, "dist/test/vscodeSuite.js"),
    extensionTestsEnv: { BILINGUAL_PDF_BACKEND: "mock", BILINGUAL_PDF_RESULT: resultFile },
    launchArgs: [
      join(root, "samples"),
      "--disable-extensions",
      "--disable-workspace-trust",
      "--skip-welcome",
      "--skip-release-notes",
      `--user-data-dir=${join(scratch, "user")}`,
      `--extensions-dir=${join(scratch, "ext")}`,
    ],
  });
  console.log("結合テスト: 成功");
  if (existsSync(resultFile)) console.log(readFileSync(resultFile, "utf8"));
} catch (err) {
  failed = true;
  console.error("結合テスト: 失敗");
  console.error(err);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
