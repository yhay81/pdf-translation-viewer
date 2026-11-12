# Changelog

## 0.1.0

The first release, as a preview.

- A viewer for PDF files with two panes. The left pane shows the page as it is. The right pane shows the same page with its text replaced by the translation, so backgrounds, rules, figures and equations stay where they are.
- Translation with GitHub Copilot or another language model in VS Code, one page at a time. Each block appears as soon as its translation arrives.
- Each translation is fitted into the box of its source block, in a font of the same kind (serif, sans-serif or monospace), weight, size and color.
- `pdfTranslation.targetLanguage` sets the language to translate into. The default is Japanese.
- A cache of translations on your computer, so that a page you translated before is shown again without a request.
- An interface in English and Japanese.
