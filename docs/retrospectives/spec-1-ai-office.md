# Retrospective: Spec #1 (AI Office)

- **Branch**: `feat/spec-1-ai-office` (`662f403`)
- **Date**: 2026-11-25

## Agreed Process & Environment Improvements

1. **Automated Guardrails (Deterministic Checks First)**
   - Add a `check` script in `package.json` running all tests, syntax/lint checks (`node --check`, `shellcheck office.sh`), a glossary check (blocking avoided terms from `GLOSSARY.md` in UI/code identifiers), and a Riley read-only policy check on `.claude/settings.json`.
   - Add Husky pre-commit hooks and a GitHub Actions CI workflow running `npm run check` and `docker build -f web/Dockerfile`.
2. **Contract & Spec Fidelity**
   - Include explicit API route tables, technology stack requirements, and contract assertions in ticket acceptance criteria.
   - Agents must not alter approved architecture, technology stacks, or API contracts without explicit user approval.
3. **Single Standardized Test Directory**
   - Consolidate `tests/riley/` into `test/riley/` so all tests live under `test/` and run via a single `npm test` glob.
4. **Concise `CODING_STANDARDS.md`**
   - Document judgement-call standards only: deep modules, separation of concerns, and avoiding duplication (no arbitrary file-length limits; mechanical rules belong in automated checks).
5. **Tool Economy & Pre-Merge Verification**
   - Use filtered `--jq` queries for task-graph surveys; leave full-body reads to ticket implementers.
   - Verify implementation and full checks are complete before merging.
6. **Workflow & Lean `AGENTS.md`**
   - Keep `AGENTS.md` lean and preserve TDD and external exploration-notes practices.
   - Prefer working in the same repository without `git worktree`s unless explicitly approved.

---

## Remaining Differences: Spec #1 vs. Current Implementation

1. **Frontend Stack (`web/package.json`)**
   - **Spec #1**: React/Vite web application with Tailwind CSS inside Docker.
   - **Actual**: Vanilla ES modules (`web/public/js/`) and raw CSS (`web/public/styles.css`) served by `web/server.js`, with `@xterm/xterm` bundled locally.
2. **Host Bridge Endpoint Surface (`src/bridge/server.js`)**
   - **Spec #1**: Strictly whitelisted endpoints (8 REST + 2 WS, using `PUT /api/projects/:id` and `POST /api/chat/send`).
   - **Actual**: Canonical endpoints are implemented, plus compatibility/convenience aliases (`PATCH /api/projects/:id`, `POST /api/chat`, `GET /api/health`, `GET /api/projects/active`, `POST /api/projects/:id/activate`, `GET /api/transcript`, `POST /api/terminal/override-lease`, `WS /ws/transcript`).
3. **Non-Docker Web Runner Option (`office.sh`)**
   - **Spec #1**: Docker Web UI container orchestrated by `office.sh`.
   - **Actual**: Defaults to Docker (`OFFICE_WEB_RUNNER=docker`), with an added `OFFICE_WEB_RUNNER=node|none` option used for isolated host testing.
4. **Riley `Bash` Scoping (`.claude/settings.json`)**
   - **Spec #1**: Strictly read-only inspection (`Read`, `Glob`, `Grep`, non-modifying shell existence checks) non-bypassable across permission modes.
   - **Actual**: `.claude/agents/riley.md` restricts tools to `Read, Glob, Grep, Bash` with `permissions.deny` blocking mutating commands and interpreters (`Write`, `Edit`, `MultiEdit`, `NotebookEdit`, `Agent`, `Task`, `python*`, `node*`, `bash*`, `sh*`, `curl*`, `wget*`, `git * branch -d/-D`, `git * stash*`), though `Bash` itself remains an allowlist/denylist pattern rather than disabled entirely.

---

## Proposed Follow-Up Tickets

1. **Ticket A: Automated Guardrails, Unified `test/` Layout, Pre-Commit & CI**
   - Move `tests/riley/` to `test/riley/` and simplify `package.json` `test` script.
   - Add `npm run check` (tests, `node --check`, `shellcheck`, glossary check, Riley settings check).
   - Set up Husky pre-commit hooks and `.github/workflows/ci.yml` (running `npm run check` and `docker build -f web/Dockerfile`).
2. **Ticket B: Concise `CODING_STANDARDS.md` & Module Cleanup**
   - Add `CODING_STANDARDS.md` focused on deep modules, separation of concerns, and avoiding duplication (and reference it in `AGENTS.md` for reviews).
   - Refactor `src/bridge/server.js` and `web/public/js/app.js` into focused modules/helpers where concerns are currently combined.
3. **Ticket C: Spec Alignment Decision — Frontend Stack (React/Vite + Tailwind vs. Current Vanilla UI)**
   - Either migrate `web/public/` to React + Vite + Tailwind CSS per Spec #1, or formally record an ADR accepting the zero-build ES module UI.
4. **Ticket D: Spec Alignment — Strict Bridge Endpoint Whitelist**
   - Remove unrequested alias endpoints in `src/bridge/server.js` (or document any retained endpoints in ADR-0002) and update tests to assert the exact whitelisted surface.
