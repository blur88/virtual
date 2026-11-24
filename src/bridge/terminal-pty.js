import pty from 'node-pty';

/**
 * Spawns a PTY attached to an existing `tmux` session.
 *
 * @param {{ sessionName: string, cols?: number, rows?: number }} options
 */
export function attachTmuxPty({ sessionName, cols = 120, rows = 36 }) {
  const proc = pty.spawn('tmux', ['attach-session', '-t', `=${sessionName}`], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: process.cwd(),
    env: process.env,
  });

  return {
    ptyName: proc.pty || null,
    write(data) {
      proc.write(data);
    },
    resize(nextCols, nextRows) {
      if (Number.isInteger(nextCols) && Number.isInteger(nextRows) && nextCols > 0 && nextRows > 0) {
        proc.resize(nextCols, nextRows);
      }
    },
    kill() {
      try {
        proc.kill();
      } catch {
        // Ignore already exited PTY
      }
    },
    onData(cb) {
      return proc.onData(cb);
    },
    onExit(cb) {
      return proc.onExit(cb);
    },
  };
}
