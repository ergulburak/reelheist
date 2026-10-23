# Contributing to ReelHeist

Thank you for your interest in contributing to ReelHeist!

---

## 1. Fixing or Improving Translations

ReelHeist supports 12 languages across both the browser extension and the local setup guide:
`tr`, `en`, `es`, `pt_BR`, `fr`, `de`, `ru`, `ar`, `zh_CN`, `id`, `ja`, `hi`.

- **Browser Extension UI:** Edit `extension/_locales/<lang>/messages.json`.
  - Keep all `{placeholder}` names identical to `extension/_locales/en/messages.json`.
  - Do not hard-code user-visible strings in `extension/popup.html`, `extension/popup.js`, or `extension/ui/*.js`.
- **Guided Setup Page:** Edit `helper/guide/i18n/<lang>.json`.
- **Verify your changes:**
  ```powershell
  node tools/check-i18n.js
  cd extension && node --test test/i18n.test.mjs
  ```

---

## 2. Writing Site Packs

The main ReelHeist repository is strictly site-neutral and does **not** contain site-specific rules or domain names.

To create or maintain declarative site packs in your own repository, see the full specification and signing guide in **[docs/site-packs.md](docs/site-packs.md)**.

---

## 3. Code Changes & Tests

- Zero external npm dependencies in `extension/` and `helper/`.
- Before submitting changes, run all test suites and checks:
  ```powershell
  node tools/check-neutral.js
  node tools/check-i18n.js
  node tools/check-release.js
  cd helper && node --test test/*.test.js
  cd ../extension && node --test test/*.test.mjs
  ```
