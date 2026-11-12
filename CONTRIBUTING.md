# Contributing

Thank you for helping with PDF Translation Viewer. Report bugs and suggest features in [GitHub Issues](https://github.com/yhay81/pdf-translation-viewer/issues). Before you start on a large change, open an issue so that we can agree on the approach.

## Set up

You need Node.js 22 or later and VS Code 1.104 or later.

```bash
git clone https://github.com/yhay81/pdf-translation-viewer.git
cd pdf-translation-viewer
npm install
```

## Build and test

- `npm run build` bundles the extension and the webview into `dist/`, and copies the files that PDF.js loads at run time.
- `npm run watch` bundles them again on every change.
- `npm run check` runs the type check and the unit tests. Run it before you open a pull request. CI runs it too.
- `npm run test:e2e` runs the end-to-end test in a real VS Code with a throwaway profile. It uses the VS Code installed on your computer, or downloads one into `.vscode-test/`. The test opens `samples/sample.pdf` in the viewer and translates a page with a dummy backend. CI runs it under `xvfb-run` on Linux, once on the repository and once on the files of the VSIX.
- Press F5 in VS Code to build the extension and open it in an Extension Development Host.

The tests never call a model. To see real translations in the Extension Development Host, choose a GitHub Copilot model. The model list there also offers **Dummy translation (for development)**, which lays out placeholder text without calling a model.

### The browser harness

`npm run harness` serves the webview in a plain browser at <http://localhost:5179/harness/index.html>, with a stand-in for the extension host that answers with the translations in `harness/fixtures/ja.js`. It is the quickest way to work on the layout analysis and the typesetting. Add `?mode=dummy` for placeholder text, `?auto=1` to translate the first page at once, or `?pdf=/path/to/file.pdf` for another PDF under the repository folder.

### The sample PDF

`samples/sample.pdf` is built from `samples/sample.tex` with `npm run sample`, which needs a LaTeX installation with `latexmk`. The PDF is committed, so you only need this after you change the source.

## Where things are

- `src/extension.ts`: activation and the commands.
- `src/pdfEditorProvider.ts`: the custom editor. It hands the PDF to the webview and passes translation requests on.
- `src/translation/`: the prompt and the format of the exchange with the model (`blockProtocol.ts`), the backends (`backends.ts`), the choice of the model (`models.ts`), the cache, and the service that ties them together.
- `src/webview/main.ts`: the viewer: rendering with PDF.js, the two panes, and the translation of a page.
- `src/webview/layout.ts`: grouping the text of a page into lines and blocks. It uses neither the DOM nor VS Code, so the unit tests cover it.
- `src/webview/typeset.ts`: fitting a translation into the box of its block.
- `src/shared/`: the messages between the extension host and the webview, the text of the webview, and what the viewer knows about target languages.
- `l10n/` and `package.nls*.json`: the strings in English and Japanese. A new string needs an entry in both; a unit test checks it.
- `test/unit/`: the unit tests, run with the Node.js test runner. `test/e2e/`: the end-to-end test.

## Try the package

Build a VSIX and install it in VS Code. Run both commands in the repository folder, where `npm run package` writes the VSIX.

```bash
npm run package
```

```bash
code --install-extension pdf-translation-viewer-0.1.0.vsix
```

To run the end-to-end test on the files of the VSIX instead of the repository, unpack it and name its `extension` folder in `PDF_TRANSLATION_EXTENSION`:

```bash
unzip -q pdf-translation-viewer-0.1.0.vsix -d /tmp/vsix
```

```bash
PDF_TRANSLATION_EXTENSION=/tmp/vsix/extension npm run test:e2e
```

## Release

Pushing a version tag runs the [Release workflow](.github/workflows/release.yml), which publishes the extension to the Visual Studio Marketplace, and to Open VSX once that is set up, and creates a GitHub release.

1. Change `version` in `package.json`, and add a section for that version to `CHANGELOG.md`, such as `## 0.2.0`.
2. Run `npm run check` and `npm run package`, and try the VSIX in VS Code.
3. Commit the changes and push them to `main`. The Marketplace page shows the images in `README.md` from GitHub, so push them before you release.
4. Tag the commit with `v` and the version, and push the tag:

   ```bash
   git tag -m v0.2.0 v0.2.0
   ```

   ```bash
   git push origin v0.2.0
   ```

The workflow stops if the tag does not match the version in `package.json`, or if `CHANGELOG.md` has no section for the version. Otherwise it runs the checks, packages the extension, publishes the VSIX to the Marketplace, and creates a GitHub release with the VSIX and that section of the changelog. The run also keeps the VSIX as a build artifact.

### Trusted Publishing

The workflow signs in to the Marketplace with [Trusted Publishing](https://code.visualstudio.com/api/working-with-extensions/publishing-extension), so no token is stored anywhere. The owner of the `yhay81` publisher sets it up once: on the [publisher management page](https://marketplace.visualstudio.com/manage), open the publisher, select **Trusted Publishing**, and create a policy with these values.

| Field | Value |
| --- | --- |
| Policy name | Any name, such as `pdf-translation-viewer release` |
| Repository owner | `yhay81` |
| Repository | `pdf-translation-viewer` |
| Workflow | `release.yml` |
| Environment | Leave it empty |

If the workflow file is renamed, the policy must be changed to match.

### Open VSX

[Open VSX](https://open-vsx.org) is the registry that VS Code forks such as VSCodium, Cursor and Windsurf install extensions from. The Release workflow publishes there too once these are set up. The `yhay81` namespace must exist on open-vsx.org; then, in the repository settings on GitHub, under **Secrets and variables** → **Actions**, add an access token as the secret `OVSX_PAT`, and add the variable `OPEN_VSX` with the value `true`.

Until `OPEN_VSX` is `true`, the workflow skips Open VSX.
