# Claude Code Office Manager Agent (Riley)

## Status
accepted

## Context
The AI Office is maintained in a dedicated coordination repository (`/home/blur/virtual`) separate from the actual software repositories ("Target Projects") hosted on the same server. We need an interactive conversational front-door agent, named Riley, who acts as the Office Manager receiving human inquiries and strictly providing advisory routing using the `ask-matt` skill across both terminal and containerized Web UI interfaces.

## Decision
We implement Riley as a native Claude Code agent in `.claude/agents/riley.md` and configure her as the default agent in `/home/blur/virtual/.claude/settings.json`. Riley's prompt strictly enforces:
1. Dynamically consulting the live installed `ask-matt` skill file before every engineering recommendation.
2. Re-reading `.office/projects.json` before each workflow recommendation to guarantee up-to-date active project path context.
3. Matching the user's preferred conversational language while preserving original English skill names and terminal commands.
4. Restricting Riley's permissions strictly to read-only inspection tools (`Read`, `Glob`, `Grep`, non-modifying shell checks), ensuring write/edit restrictions cannot be bypassed through alternative tools or permission modes.
5. Structuring workflow recommendations in a 4-part non-coder-friendly template with copy-paste terminal commands.
6. Gracefully handling missing skill files, agent errors, and rate/usage limits with clear non-technical guidance.

## Consequences
- The AI Office configuration remains isolated in this repository while managing workflows across multiple project folders on the server without worktrees or duplicate repos.
- Every engineering inquiry to Riley outputs structured advisory guidance aligned with the canonical `ask-matt` routing tree.
- Riley maintains read-only validation of target directories and cannot perform autonomous code modifications or change project settings.
- Active project selection is managed exclusively by the user via Project Settings in the Web UI.
