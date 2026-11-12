// Starts the end-to-end test in a real VS Code with a throwaway profile, so that your own settings
// and extensions are not touched. The translation backend is fixed to the dummy, so no model is called.
//
// VS Code comes from VSCODE_EXECUTABLE when it is set, else from the usual place of an installed
// one, and is otherwise downloaded into .vscode-test/ (as on CI).
//
// The extension under test is the repository, or the folder named by PDF_TRANSLATION_EXTENSION,
// such as the "extension" folder of an unpacked VSIX, to test what the package contains.
import { runTests } from "@vscode/test-electron";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const extension = process.env.PDF_TRANSLATION_EXTENSION ? resolve(process.env.PDF_TRANSLATION_EXTENSION) : root;

const candidates = [
  process.env.VSCODE_EXECUTABLE,
  "/Applications/Visual Studio Code.app/Contents/MacOS/Code",
  "/Applications/Visual Studio Code.app/Contents/MacOS/Electron",
].filter(Boolean);
const executable = candidates.find((candidate) => existsSync(candidate));
console.log(executable ? `Using ${executable}` : "Downloading VS Code into .vscode-test/");
if (extension !== root) console.log(`Testing the extension in ${extension}`);

// A short temporary directory, to stay under the length limit of socket paths.
const scratch = mkdtempSync(join(tmpdir(), "ptv-"));
const resultFile = join(scratch, "result.json");
let failed = false;
try {
  await runTests({
    ...(executable ? { vscodeExecutablePath: executable } : {}),
    extensionDevelopmentPath: extension,
    extensionTestsPath: join(root, "dist/test/e2eSuite.js"),
    extensionTestsEnv: { PDF_TRANSLATION_BACKEND: "mock", PDF_TRANSLATION_RESULT: resultFile },
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
  console.log("End-to-end test: passed");
  if (existsSync(resultFile)) console.log(readFileSync(resultFile, "utf8"));
} catch (err) {
  failed = true;
  console.error("End-to-end test: failed");
  console.error(err);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
