import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const DEFAULT_SHELL_NAMES = new Set(['bash', 'sh', 'zsh', 'fish', 'dash', 'ksh', 'csh', 'tcsh']);

/**
 * Creates a persistent `tmux` session manager for the Office Manager agent.
 *
 * @param {{
 *   sessionName?: string,
 *   cwd?: string,
 *   agentCommand?: string,
 *   shellNames?: string[],
 * }} [options]
 */
export function createTmuxManager(options = {}) {
  const sessionName = options.sessionName || process.env.OFFICE_TMUX_SESSION || 'ai-office-riley';
  const cwd = options.cwd || process.cwd();
  const agentCommand = options.agentCommand || 'claude';
  const shellNames = options.shellNames ? new Set(options.shellNames) : DEFAULT_SHELL_NAMES;
  const target = `=${sessionName}`;
  const paneTarget = `=${sessionName}:`;

  async function hasSession() {
    try {
      await execFileAsync('tmux', ['has-session', '-t', target]);
      return true;
    } catch {
      return false;
    }
  }

  return {
    sessionName,

    /**
     * Ensures the persistent `tmux` session exists, reusing any existing session.
     * @returns {Promise<{ sessionName: string, created: boolean }>}
     */
    async ensureSession() {
      if (await hasSession()) {
        return { sessionName, created: false };
      }

      await execFileAsync('tmux', [
        'new-session',
        '-d',
        '-s',
        sessionName,
        '-c',
        cwd,
        agentCommand,
      ]);

      return { sessionName, created: true };
    },

    /**
     * Inspects the tmux session and active pane to detect whether the agent is running
     * or has exited to a raw host shell.
     * @returns {Promise<{
     *   sessionName: string,
     *   exists: boolean,
     *   running: boolean,
     *   paneCommand: string | null,
     *   paneDead: boolean,
     *   inHostShell: boolean,
     * }>}
     */
    async getStatus() {
      if (!(await hasSession())) {
        return {
          sessionName,
          exists: false,
          running: false,
          paneCommand: null,
          paneDead: false,
          inHostShell: true,
        };
      }

      try {
        const { stdout } = await execFileAsync('tmux', [
          'list-panes',
          '-t',
          target,
          '-F',
          '#{pane_current_command}|#{pane_dead}|#{pane_pid}',
        ]);
        const firstLine = stdout.trim().split('\n')[0] || '';
        const [rawCommand = '', rawDead = '0'] = firstLine.split('|');
        const paneCommand = rawCommand.trim() || null;
        const paneDead = rawDead.trim() === '1';
        const inHostShell =
          paneDead || !paneCommand || shellNames.has(paneCommand.toLowerCase());

        return {
          sessionName,
          exists: true,
          running: !paneDead,
          paneCommand,
          paneDead,
          inHostShell,
        };
      } catch {
        return {
          sessionName,
          exists: false,
          running: false,
          paneCommand: null,
          paneDead: false,
          inHostShell: true,
        };
      }
    },

    /**
     * Lists attached tmux clients with their last activity timestamps.
     * @returns {Promise<Array<{ name: string, activity: number }>>}
     */
    async listClients() {
      if (!(await hasSession())) {
        return [];
      }
      try {
        const { stdout } = await execFileAsync('tmux', [
          'list-clients',
          '-t',
          target,
          '-F',
          '#{client_name}|#{client_activity}',
        ]);
        return stdout
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => {
            const [name = '', rawActivity = '0'] = line.split('|');
            return {
              name: name.trim(),
              activity: Number(rawActivity.trim()) || 0,
            };
          })
          .filter((client) => client.name.length > 0);
      } catch {
        return [];
      }
    },

    /**
     * Sends literal text followed by Enter to the tmux session.
     * @param {string} text
     */
    async sendLiteralKeys(text) {
      if (typeof text !== 'string' || text.length === 0) {
        throw new Error('Cannot send empty prompt to tmux session.');
      }
      await execFileAsync('tmux', ['send-keys', '-t', paneTarget, '-l', '--', text]);
      await execFileAsync('tmux', ['send-keys', '-t', paneTarget, 'Enter']);
    },

    /**
     * Kills the existing tmux session (if any) and starts a fresh session.
     */
    async resetSession() {
      await this.killSession();
      return this.ensureSession();
    },

    /**
     * Kills the tmux session if it exists.
     */
    async killSession() {
      if (await hasSession()) {
        try {
          await execFileAsync('tmux', ['kill-session', '-t', target]);
        } catch {
          // Ignore if session exited concurrently
        }
      }
    },
  };
}
