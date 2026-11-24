#!/usr/bin/env bash
set -euo pipefail

OFFICE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OFFICE_STATE_DIR="${OFFICE_STATE_DIR:-$OFFICE_ROOT/.office}"
OFFICE_BRIDGE_PORT="${OFFICE_BRIDGE_PORT:-4040}"
OFFICE_WEB_PORT="${OFFICE_WEB_PORT:-3000}"
OFFICE_TMUX_SESSION="${OFFICE_TMUX_SESSION:-ai-office-riley}"
OFFICE_AGENT_COMMAND="${OFFICE_AGENT_COMMAND:-claude}"
OFFICE_WEB_RUNNER="${OFFICE_WEB_RUNNER:-docker}"
OFFICE_PROJECTS_FILE="${OFFICE_PROJECTS_FILE:-$OFFICE_STATE_DIR/projects.json}"

BRIDGE_PID_FILE="$OFFICE_STATE_DIR/bridge.pid"
BRIDGE_LOG_FILE="$OFFICE_STATE_DIR/bridge.log"
BRIDGE_TOKEN_FILE="$OFFICE_STATE_DIR/bridge.token"
WEB_PID_FILE="$OFFICE_STATE_DIR/web.pid"
WEB_LOG_FILE="$OFFICE_STATE_DIR/web.log"

die() {
  echo "Error: $*" >&2
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "Required command '$1' not found in PATH."
}

is_pid_running() {
  local pid_file="$1"
  [[ -f "$pid_file" ]] || return 1
  local pid
  pid="$(tr -d '[:space:]' < "$pid_file" 2>/dev/null || true)"
  [[ -n "$pid" ]] || return 1
  kill -0 "$pid" 2>/dev/null
}

read_pid() {
  local pid_file="$1"
  tr -d '[:space:]' < "$pid_file" 2>/dev/null || true
}

check_port_available() {
  local port="$1"
  local host="$2"
  local label="$3"
  node -e "
    const net = require('node:net');
    const server = net.createServer();
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.error('${label} port ${port} (${host}) is already in use.');
        process.exit(1);
      }
      console.error('${label} port ${port} check failed: ' + err.message);
      process.exit(1);
    });
    server.listen(${port}, '${host}', () => {
      server.close(() => process.exit(0));
    });
  "
}

load_bridge_token() {
  if [[ -s "$BRIDGE_TOKEN_FILE" && -z "${OFFICE_BRIDGE_TOKEN:-}" ]]; then
    OFFICE_BRIDGE_TOKEN="$(tr -d '[:space:]' < "$BRIDGE_TOKEN_FILE")"
    export OFFICE_BRIDGE_TOKEN
  fi
}

ensure_token() {
  mkdir -p "$OFFICE_STATE_DIR"
  if [[ -n "${OFFICE_BRIDGE_TOKEN:-}" ]]; then
    printf '%s\n' "$OFFICE_BRIDGE_TOKEN" > "$BRIDGE_TOKEN_FILE"
    chmod 600 "$BRIDGE_TOKEN_FILE"
    export OFFICE_BRIDGE_TOKEN
    return
  fi
  load_bridge_token
  if [[ -z "${OFFICE_BRIDGE_TOKEN:-}" ]]; then
    OFFICE_BRIDGE_TOKEN="$(node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))")"
    printf '%s\n' "$OFFICE_BRIDGE_TOKEN" > "$BRIDGE_TOKEN_FILE"
    chmod 600 "$BRIDGE_TOKEN_FILE"
    export OFFICE_BRIDGE_TOKEN
  fi
}

ensure_tmux_session() {
  if ! tmux has-session -t "=$OFFICE_TMUX_SESSION" 2>/dev/null; then
    tmux new-session -d -s "$OFFICE_TMUX_SESSION" -c "$OFFICE_ROOT" "$OFFICE_AGENT_COMMAND"
  fi
}

wait_for_http() {
  local url="$1"
  local auth_header="${2:-}"
  local pid_file="${3:-}"
  local log_file="${4:-}"
  local label="${5:-Service}"

  local attempt=0
  local max_attempts=50
  while (( attempt < max_attempts )); do
    if [[ -n "$pid_file" ]] && ! is_pid_running "$pid_file"; then
      echo "$label exited prematurely." >&2
      if [[ -n "$log_file" && -f "$log_file" ]]; then
        cat "$log_file" >&2
      fi
      return 1
    fi

    if AUTH_HEADER="$auth_header" node -e "
      const headers = process.env.AUTH_HEADER
        ? { Authorization: 'Bearer ' + process.env.OFFICE_BRIDGE_TOKEN }
        : {};
      fetch('${url}', { headers })
        .then((res) => process.exit(res.ok ? 0 : 1))
        .catch(() => process.exit(1));
    " 2>/dev/null; then
      return 0
    fi

    sleep 0.2
    attempt=$((attempt + 1))
  done

  echo "$label failed to become healthy at $url within timeout." >&2
  if [[ -n "$log_file" && -f "$log_file" ]]; then
    cat "$log_file" >&2
  fi
  return 1
}

start_bridge() {
  if is_pid_running "$BRIDGE_PID_FILE"; then
    echo "Host Bridge is already running (PID $(read_pid "$BRIDGE_PID_FILE"))."
    return 0
  fi

  rm -f "$BRIDGE_PID_FILE"

  ensure_tmux_session

  OFFICE_BRIDGE_PORT="$OFFICE_BRIDGE_PORT" \
  OFFICE_BRIDGE_TOKEN="$OFFICE_BRIDGE_TOKEN" \
  OFFICE_TMUX_SESSION="$OFFICE_TMUX_SESSION" \
  OFFICE_AGENT_COMMAND="$OFFICE_AGENT_COMMAND" \
  OFFICE_PROJECTS_FILE="$OFFICE_PROJECTS_FILE" \
  OFFICE_TRANSCRIPT_DIR="${OFFICE_TRANSCRIPT_DIR:-}" \
  nohup node "$OFFICE_ROOT/src/bridge/cli.js" < /dev/null > "$BRIDGE_LOG_FILE" 2>&1 &
  local pid=$!
  printf '%s\n' "$pid" > "$BRIDGE_PID_FILE"

  wait_for_http "http://127.0.0.1:${OFFICE_BRIDGE_PORT}/api/health" "1" "$BRIDGE_PID_FILE" "$BRIDGE_LOG_FILE" "Host Bridge"
}

start_web() {
  case "$OFFICE_WEB_RUNNER" in
    none)
      return 0
      ;;
    node)
      if is_pid_running "$WEB_PID_FILE"; then
        echo "Web UI (node) is already running (PID $(read_pid "$WEB_PID_FILE"))."
        return 0
      fi
      rm -f "$WEB_PID_FILE"

      OFFICE_WEB_HOST="127.0.0.1" \
      OFFICE_WEB_PORT="$OFFICE_WEB_PORT" \
      OFFICE_BRIDGE_URL="http://127.0.0.1:${OFFICE_BRIDGE_PORT}" \
      OFFICE_BRIDGE_TOKEN="$OFFICE_BRIDGE_TOKEN" \
      nohup node "$OFFICE_ROOT/web/cli.js" < /dev/null > "$WEB_LOG_FILE" 2>&1 &
      local pid=$!
      printf '%s\n' "$pid" > "$WEB_PID_FILE"

      wait_for_http "http://127.0.0.1:${OFFICE_WEB_PORT}/" "" "$WEB_PID_FILE" "$WEB_LOG_FILE" "Web UI"
      ;;
    docker)
      require_cmd docker
      OFFICE_WEB_PORT="$OFFICE_WEB_PORT" \
      OFFICE_BRIDGE_URL="http://host.docker.internal:${OFFICE_BRIDGE_PORT}" \
      OFFICE_BRIDGE_TOKEN="$OFFICE_BRIDGE_TOKEN" \
      docker compose -f "$OFFICE_ROOT/docker-compose.yml" up -d --build
      wait_for_http "http://127.0.0.1:${OFFICE_WEB_PORT}/" "" "" "" "Web UI"
      ;;
    *)
      die "Unsupported OFFICE_WEB_RUNNER: '$OFFICE_WEB_RUNNER' (expected docker, node, or none)."
      ;;
  esac
}

stop_pid_file() {
  local pid_file="$1"
  local label="$2"
  if ! is_pid_running "$pid_file"; then
    rm -f "$pid_file"
    return 0
  fi

  local pid
  pid="$(read_pid "$pid_file")"
  kill -TERM "$pid" 2>/dev/null || true

  local attempt=0
  while kill -0 "$pid" 2>/dev/null && (( attempt < 25 )); do
    sleep 0.2
    attempt=$((attempt + 1))
  done

  if kill -0 "$pid" 2>/dev/null; then
    kill -KILL "$pid" 2>/dev/null || true
  fi

  rm -f "$pid_file"
  echo "Stopped $label (PID $pid)."
}

stop_web() {
  case "$OFFICE_WEB_RUNNER" in
    none)
      return 0
      ;;
    node)
      stop_pid_file "$WEB_PID_FILE" "Web UI"
      ;;
    docker)
      if command -v docker >/dev/null 2>&1; then
        OFFICE_WEB_PORT="$OFFICE_WEB_PORT" \
        OFFICE_BRIDGE_URL="http://host.docker.internal:${OFFICE_BRIDGE_PORT}" \
        OFFICE_BRIDGE_TOKEN="${OFFICE_BRIDGE_TOKEN:-}" \
        docker compose -f "$OFFICE_ROOT/docker-compose.yml" down || true
      fi
      ;;
  esac
}

cmd_start() {
  require_cmd node
  require_cmd tmux
  require_cmd git

  ensure_token

  if ! is_pid_running "$BRIDGE_PID_FILE"; then
    check_port_available "$OFFICE_BRIDGE_PORT" "127.0.0.1" "Host Bridge"
  fi
  if [[ "$OFFICE_WEB_RUNNER" != "none" ]]; then
    if [[ "$OFFICE_WEB_RUNNER" != "node" ]] || ! is_pid_running "$WEB_PID_FILE"; then
      check_port_available "$OFFICE_WEB_PORT" "0.0.0.0" "Web UI"
    fi
  fi

  start_bridge
  start_web

  echo "AI Office started."
  echo "  Web UI:      http://localhost:${OFFICE_WEB_PORT}"
  echo "  Host Bridge: http://127.0.0.1:${OFFICE_BRIDGE_PORT}"
  echo "  tmux:        ${OFFICE_TMUX_SESSION}"
}

cmd_stop() {
  stop_web
  stop_pid_file "$BRIDGE_PID_FILE" "Host Bridge"
  echo "AI Office stopped (tmux session '${OFFICE_TMUX_SESSION}' preserved)."
}

cmd_restart() {
  cmd_stop
  cmd_start
}

cmd_terminal() {
  require_cmd tmux
  if ! tmux has-session -t "=$OFFICE_TMUX_SESSION" 2>/dev/null; then
    die "tmux session '$OFFICE_TMUX_SESSION' is not running. Run ./office.sh start first."
  fi
  exec tmux attach -t "=$OFFICE_TMUX_SESSION"
}

cmd_status() {
  local bridge_running="stopped"
  local bridge_health="unreachable"
  local web_running="stopped"
  local tmux_state="missing"
  local active_project_line="(none)"

  load_bridge_token

  if is_pid_running "$BRIDGE_PID_FILE"; then
    bridge_running="running (PID $(read_pid "$BRIDGE_PID_FILE"))"
  fi

  local status_json=""
  if status_json="$(node -e "
    const headers = process.env.OFFICE_BRIDGE_TOKEN
      ? { Authorization: 'Bearer ' + process.env.OFFICE_BRIDGE_TOKEN }
      : {};
    fetch('http://127.0.0.1:${OFFICE_BRIDGE_PORT}/api/status', { headers })
      .then(async (res) => {
        if (!res.ok) process.exit(1);
        const data = await res.json();
        console.log(JSON.stringify(data));
      })
      .catch(() => process.exit(1));
  " 2>/dev/null)"; then
    bridge_health="healthy"
  fi

  if node -e "
    fetch('http://127.0.0.1:${OFFICE_WEB_PORT}/')
      .then((res) => process.exit(res.ok ? 0 : 1))
      .catch(() => process.exit(1));
  " 2>/dev/null; then
    web_running="running"
  elif [[ "$OFFICE_WEB_RUNNER" == "node" ]] && is_pid_running "$WEB_PID_FILE"; then
    web_running="running (PID $(read_pid "$WEB_PID_FILE"))"
  fi

  if tmux has-session -t "=$OFFICE_TMUX_SESSION" 2>/dev/null; then
    local pane_cmd
    pane_cmd="$(tmux list-panes -t "=$OFFICE_TMUX_SESSION" -F '#{pane_current_command}' 2>/dev/null | head -n 1 || true)"
    tmux_state="active (pane=${pane_cmd:-unknown})"
  fi

  if [[ -n "$status_json" ]]; then
    active_project_line="$(STATUS_JSON="$status_json" node -e "
      const data = JSON.parse(process.env.STATUS_JSON || '{}');
      const p = data.activeProject;
      if (!p) {
        console.log('(none)');
      } else {
        console.log(p.name + ' (' + (p.branch || 'detached') + ') [' + p.path + ']');
      }
    ")"
  elif [[ -f "$OFFICE_PROJECTS_FILE" ]]; then
    active_project_line="$(OFFICE_PROJECTS_FILE="$OFFICE_PROJECTS_FILE" node -e "
      const fs = require('node:fs');
      const { execFileSync } = require('node:child_process');
      try {
        const reg = JSON.parse(fs.readFileSync(process.env.OFFICE_PROJECTS_FILE, 'utf8'));
        const p = (reg.projects || []).find((x) => x.id === reg.activeProjectId);
        if (!p) {
          console.log('(none)');
        } else {
          let branch = 'unknown';
          try {
            branch = execFileSync('git', ['-C', p.path, 'branch', '--show-current'], { encoding: 'utf8' }).trim() || 'detached';
          } catch {}
          console.log(p.name + ' (' + branch + ') [' + p.path + ']');
        }
      } catch {
        console.log('(none)');
      }
    ")"
  fi

  echo "AI Office Status"
  echo "  Host Bridge:    $bridge_running | health=$bridge_health | port=$OFFICE_BRIDGE_PORT (127.0.0.1:$OFFICE_BRIDGE_PORT)"
  echo "  Web UI:         $web_running | port=$OFFICE_WEB_PORT (http://localhost:$OFFICE_WEB_PORT)"
  echo "  tmux Session:   $OFFICE_TMUX_SESSION ($tmux_state)"
  echo "  Active Project: $active_project_line"
}

cmd_reset_agent() {
  local confirmed=0
  for arg in "$@"; do
    case "$arg" in
      -y|--yes)
        confirmed=1
        ;;
      *)
        die "Unknown option for reset-agent: $arg"
        ;;
    esac
  done

  if (( confirmed == 0 )); then
    printf "Reset Riley's agent session '%s'? This will clear current context. [y/N] " "$OFFICE_TMUX_SESSION"
    local reply=""
    read -r reply || true
    case "$reply" in
      y|Y|yes|YES)
        confirmed=1
        ;;
      *)
        echo "Aborted."
        return 0
        ;;
    esac
  fi

  load_bridge_token

  if [[ -n "${OFFICE_BRIDGE_TOKEN:-}" ]] && node -e "
    fetch('http://127.0.0.1:${OFFICE_BRIDGE_PORT}/api/agent/reset', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + process.env.OFFICE_BRIDGE_TOKEN },
    })
      .then((res) => process.exit(res.ok ? 0 : 1))
      .catch(() => process.exit(1));
  " 2>/dev/null; then
    echo "Reset agent session '${OFFICE_TMUX_SESSION}' via Host Bridge."
    return 0
  fi

  require_cmd tmux
  if tmux has-session -t "=$OFFICE_TMUX_SESSION" 2>/dev/null; then
    tmux kill-session -t "=$OFFICE_TMUX_SESSION"
  fi
  tmux new-session -d -s "$OFFICE_TMUX_SESSION" -c "$OFFICE_ROOT" "$OFFICE_AGENT_COMMAND"
  echo "Reset agent session '${OFFICE_TMUX_SESSION}'."
}

print_usage() {
  cat <<'EOF'
Usage: ./office.sh <command> [options]

Commands:
  start                Validate ports, generate token, start Host Bridge, tmux session, and Web UI
  stop                 Stop Web UI and Host Bridge while preserving the tmux agent session
  restart              Restart Web UI and Host Bridge without dropping the tmux agent session
  terminal             Attach current terminal to Riley's live tmux session
  status               Report service health, port bindings, active project & branch, and tmux state
  reset-agent [-y]     Confirm and restart Riley's Claude Code session in tmux
EOF
}

main() {
  local cmd="${1:-}"
  shift || true

  case "$cmd" in
    start)
      cmd_start "$@"
      ;;
    stop)
      cmd_stop "$@"
      ;;
    restart)
      cmd_restart "$@"
      ;;
    terminal)
      cmd_terminal "$@"
      ;;
    status)
      cmd_status "$@"
      ;;
    reset-agent)
      cmd_reset_agent "$@"
      ;;
    -h|--help|help|"")
      print_usage
      ;;
    *)
      echo "Unknown command: $cmd" >&2
      print_usage >&2
      exit 1
      ;;
  esac
}

main "$@"
