import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const REPO_ROOT = process.cwd();
const OFFICE_SH = path.join(REPO_ROOT, 'office.sh');

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = addr.port;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
    server.on('error', reject);
  });
}

async function runOffice(args, env) {
  try {
    const { stdout, stderr } = await execFileAsync(OFFICE_SH, args, {
      cwd: REPO_ROOT,
      env: { ...process.env, ...env },
      timeout: 20000,
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    return {
      code: err.code ?? 1,
      stdout: err.stdout || '',
      stderr: err.stderr || '',
    };
  }
}

describe('office.sh CLI lifecycle', () => {
  const cleanups = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      const fn = cleanups.pop();
      await fn();
    }
  });

  it('fails fast with a clear diagnostic when OFFICE_BRIDGE_PORT or OFFICE_WEB_PORT is occupied', async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-office-cli-port-'));
    const sessionName = `ai-office-test-${process.pid}-${Date.now()}`;
    cleanups.push(async () => {
      await execFileAsync('tmux', ['kill-session', '-t', `=${sessionName}`]).catch(() => {});
      await fs.rm(stateDir, { recursive: true, force: true });
    });

    const occupiedServer = net.createServer();
    await new Promise((resolve) => occupiedServer.listen(0, '127.0.0.1', resolve));
    const occupiedPort = occupiedServer.address().port;
    cleanups.push(
      () => new Promise((resolve) => occupiedServer.close(() => resolve()))
    );

    const freeWebPort = await getFreePort();

    const bridgeConflict = await runOffice(['start'], {
      OFFICE_STATE_DIR: stateDir,
      OFFICE_BRIDGE_PORT: String(occupiedPort),
      OFFICE_WEB_PORT: String(freeWebPort),
      OFFICE_TMUX_SESSION: sessionName,
      OFFICE_WEB_RUNNER: 'node',
      OFFICE_AGENT_COMMAND: 'cat',
    });

    assert.notEqual(bridgeConflict.code, 0);
    assert.match(
      `${bridgeConflict.stdout}\n${bridgeConflict.stderr}`,
      new RegExp(`port.*${occupiedPort}|${occupiedPort}.*in use|occupied`, 'i')
    );

    const freeBridgePort = await getFreePort();
    const webConflict = await runOffice(['start'], {
      OFFICE_STATE_DIR: stateDir,
      OFFICE_BRIDGE_PORT: String(freeBridgePort),
      OFFICE_WEB_PORT: String(occupiedPort),
      OFFICE_TMUX_SESSION: sessionName,
      OFFICE_WEB_RUNNER: 'node',
      OFFICE_AGENT_COMMAND: 'cat',
    });

    assert.notEqual(webConflict.code, 0);
    assert.match(
      `${webConflict.stdout}\n${webConflict.stderr}`,
      new RegExp(`port.*${occupiedPort}|${occupiedPort}.*in use|occupied`, 'i')
    );
  });

  it('supports start, status, stop, restart (preserving tmux), and reset-agent', async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-office-cli-life-'));
    const transcriptDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-office-transcript-'));
    const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-office-repo-'));
    const sessionName = `ai-office-test-${process.pid}-${Date.now()}`;
    const bridgePort = await getFreePort();
    const webPort = await getFreePort();

    const env = {
      OFFICE_STATE_DIR: stateDir,
      OFFICE_TRANSCRIPT_DIR: transcriptDir,
      OFFICE_BRIDGE_PORT: String(bridgePort),
      OFFICE_WEB_PORT: String(webPort),
      OFFICE_TMUX_SESSION: sessionName,
      OFFICE_WEB_RUNNER: 'node',
      OFFICE_AGENT_COMMAND: 'cat',
    };

    cleanups.push(async () => {
      await runOffice(['stop'], env).catch(() => {});
      await execFileAsync('tmux', ['kill-session', '-t', `=${sessionName}`]).catch(() => {});
      await fs.rm(stateDir, { recursive: true, force: true });
      await fs.rm(transcriptDir, { recursive: true, force: true });
      await fs.rm(repoDir, { recursive: true, force: true });
    });

    await execFileAsync('git', ['init', '-b', 'main', repoDir]);
    await execFileAsync('git', ['-C', repoDir, 'config', 'user.email', 'test@example.com']);
    await execFileAsync('git', ['-C', repoDir, 'config', 'user.name', 'Test User']);
    await fs.writeFile(path.join(repoDir, 'README.md'), '# test\n', 'utf8');
    await execFileAsync('git', ['-C', repoDir, 'add', 'README.md']);
    await execFileAsync('git', ['-C', repoDir, 'commit', '-m', 'init']);

    const startRes = await runOffice(['start'], env);
    assert.equal(startRes.code, 0, `start failed: ${startRes.stderr}`);

    const tokenPath = path.join(stateDir, 'bridge.token');
    const tokenStat = await fs.stat(tokenPath);
    assert.equal(tokenStat.mode & 0o777, 0o600);
    const token = (await fs.readFile(tokenPath, 'utf8')).trim();
    assert.ok(token.length >= 32);

    // Register a project via Web UI proxy so status reports active project + branch
    const addRes = await fetch(`http://127.0.0.1:${webPort}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Demo Repo', path: repoDir }),
    });
    assert.equal(addRes.status, 201);

    const statusRes = await runOffice(['status'], env);
    assert.equal(statusRes.code, 0);
    assert.match(statusRes.stdout, /Host Bridge:.*running.*health=healthy/);
    assert.match(statusRes.stdout, new RegExp(`port=${bridgePort}`));
    assert.match(statusRes.stdout, /Web UI:.*running/);
    assert.match(statusRes.stdout, new RegExp(`port=${webPort}`));
    assert.match(statusRes.stdout, new RegExp(`tmux Session:\\s+${sessionName} \\(active`));
    assert.match(statusRes.stdout, /Active Project:\s+Demo Repo \(main\)/);

    const { stdout: panePidBeforeStop } = await execFileAsync('tmux', [
      'list-panes',
      '-t',
      `=${sessionName}`,
      '-F',
      '#{pane_pid}',
    ]);

    // Stop preserves tmux session while stopping Web UI and Host Bridge
    const stopRes = await runOffice(['stop'], env);
    assert.equal(stopRes.code, 0, `stop failed: ${stopRes.stderr}`);

    await assert.rejects(() => fetch(`http://127.0.0.1:${bridgePort}/api/health`));
    await assert.rejects(() => fetch(`http://127.0.0.1:${webPort}/`));

    const { stdout: panePidAfterStop } = await execFileAsync('tmux', [
      'list-panes',
      '-t',
      `=${sessionName}`,
      '-F',
      '#{pane_pid}',
    ]);
    assert.equal(panePidAfterStop.trim(), panePidBeforeStop.trim());

    // Restart brings services back up while preserving the same tmux session
    const restartRes = await runOffice(['restart'], env);
    assert.equal(restartRes.code, 0, `restart failed: ${restartRes.stderr}`);

    const webAfterRestart = await fetch(`http://127.0.0.1:${webPort}/`);
    assert.equal(webAfterRestart.status, 200);

    const { stdout: panePidAfterRestart } = await execFileAsync('tmux', [
      'list-panes',
      '-t',
      `=${sessionName}`,
      '-F',
      '#{pane_pid}',
    ]);
    assert.equal(panePidAfterRestart.trim(), panePidBeforeStop.trim());

    // reset-agent without --yes aborts on 'n'
    const abortReset = await execFileAsync(
      'bash',
      ['-lc', `printf 'n\\n' | "${OFFICE_SH}" reset-agent`],
      { cwd: REPO_ROOT, env: { ...process.env, ...env } }
    );
    assert.match(abortReset.stdout, /Aborted/i);

    // reset-agent --yes replaces the tmux session with a fresh pane process
    const resetRes = await runOffice(['reset-agent', '--yes'], env);
    assert.equal(resetRes.code, 0, `reset-agent failed: ${resetRes.stderr}`);

    const { stdout: panePidAfterReset } = await execFileAsync('tmux', [
      'list-panes',
      '-t',
      `=${sessionName}`,
      '-F',
      '#{pane_pid}',
    ]);
    assert.notEqual(panePidAfterReset.trim(), panePidBeforeStop.trim());
  });
});
