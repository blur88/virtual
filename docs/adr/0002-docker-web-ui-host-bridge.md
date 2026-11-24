# Docker Web UI & Host Bridge Architecture

## Status
accepted

## Context
The user requires a browser-based Web UI to interact with Riley, manage project settings, and view terminal activity, while keeping Claude Code, skills, tmux, and target repositories running natively on the host server. We need a secure, lightweight architecture that connects the containerized Web UI to the host without exposing full host privileges, leaking tokens, or mounting the Docker socket.

## Decision
We deploy the Web UI in a lightweight Docker container and run a minimal, authenticated Host Bridge service on the native host.
1. **Network & Port Allocation**:
   - Web UI runs on Port `3000` (`http://localhost:3000`).
   - Host Bridge API runs on Port `4040` (`http://127.0.0.1:4040`), bound strictly to localhost.
   - Configurable via environment variables (`OFFICE_WEB_PORT`, `OFFICE_BRIDGE_PORT`).
   - Startup checks verify port availability and fail fast with clear diagnostics if either port is occupied.
2. **Reverse Proxy & Server-Side Token Security**:
   - The Web UI container acts as a reverse proxy forwarding `/api` and `/ws` requests to `http://host.docker.internal:4040`.
   - The `OFFICE_BRIDGE_TOKEN` is injected server-side by the container proxy, completely preventing client-side token exposure and eliminating CORS issues.
   - WebSockets authenticate via server-side token injection during the initial upgrade handshake.
3. **Agent Session & tmux Bridging**:
   - Claude Code runs inside a dedicated persistent `tmux` session (`ai-office-riley`) on the host.
   - Stopping or restarting the Web UI or Host Bridge leaves active agent sessions running inside `tmux` without loss of conversation context.
4. **Chat View & Transcript Synchronization**:
   - The Host Bridge monitors the active session's transcript JSONL (`~/.claude/projects/-home-blur-virtual/`) using line-buffered streaming to prevent partial JSON read errors.
   - Automatically handles `/clear`, `/compact`, session reconnections, and agent crashes gracefully without mixing transcripts or duplicating messages.
   - Prompts from Chat View are submitted to tmux via literal keys (`tmux send-keys -l`) only when the agent is idle.
5. **Terminal View & Cutoff Safety**:
   - An embedded xterm.js terminal connects to the Host Bridge via an authenticated WebSocket proxying the raw tmux PTY.
   - Terminal input is automatically blocked if Claude Code exits to a raw host shell to prevent unauthorized command execution.
6. **Input Lease Enforcement**:
   - A soft lock mechanism arbitrates typing between the Web UI and native terminal, alerting users to active external typing while providing an instant UI override.
7. **Agent Lifecycle Management**:
   - CLI command `./office.sh reset-agent` provides clean context resets on demand.
   - Web UI provides a "Reset Agent" action backed by an interactive confirmation modal, warning if a task is actively processing.
8. **Testing Strategy**:
   - Primary seam: Host Bridge API & WebSocket with deterministic transcript fixtures for routine automated tests to minimize token consumption.
   - Supplementary seams: Web UI component integration and CLI end-to-end tests using isolated test repos, test registries, and dedicated test tmux sessions.

## Consequences
- The Docker container remains unprivileged with no access to the Docker socket or arbitrary host execution.
- Bearer tokens are kept strictly server-side.
- Web UI and native terminal (`tmux attach`) can access the same live Claude Code session concurrently without input collisions.
- Agent sessions survive web container restarts and context resets.
