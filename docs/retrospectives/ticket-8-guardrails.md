# Retrospective: Ticket #8 (Automated Guardrails, Pre-Commit & CI)

- **Date**: 2026-11-25
- **PR**: `blur88/virtual#13`

## Recorded Environment Improvements

1. **Test-Title Glossary Guardrail (`src/guardrails/check.js`)**
   - Extended `checkGlossary()` to scan `describe()`, `it()`, and `test()` string literal titles under `test/` for `GLOSSARY.md` avoided terms while ignoring fixture strings and substrings.
2. **Local ShellCheck Parity**
   - Local `npm run check` falls back to `bash -n` when `shellcheck` is not installed (`sudo` password required on host). Install `shellcheck` locally (`sudo apt-get install -y shellcheck`) to match CI enforcement (`--require-shellcheck`).
3. **Deferred to Existing Coding Standards Ticket**
   - `CODING_STANDARDS.md` creation and consolidating shared Riley rule constants between `src/guardrails/check.js` and `test/riley/riley-config.test.mjs` remain scoped to the dedicated Coding Standards ticket.
   - `AGENTS.md` left unchanged.
