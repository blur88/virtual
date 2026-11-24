import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createTmuxManager } from '../../src/bridge/tmux-manager.js';

const execFileAsync = promisify(execFile);

describe('tmux-manager', () => {
  let sessionName;
  let tmpDir;
  let manager;

  beforeEach(async () => {
    sessionName = `ai-office-test-${crypto.randomUUID().slice(0, 8)}`;
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-office-tmux-'));
  });

  afterEach(async () => {
    if (manager) {
      await manager.killSession();
      manager = null;
    }
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('creates a persistent tmux session once and reuses it across calls', async () => {
    manager = createTmuxManager({
      sessionName,
      cwd: tmpDir,
      agentCommand: `${process.execPath} -e "setInterval(() => {}, 1000)"`,
    });

    const first = await manager.ensureSession();
    assert.equal(first.sessionName, sessionName);
    assert.equal(first.created, true);

    const second = await manager.ensureSession();
    assert.equal(second.sessionName, sessionName);
    assert.equal(second.created, false);

    const status = await manager.getStatus();
    assert.equal(status.exists, true);
    assert.equal(status.running, true);
    assert.equal(status.inHostShell, false);
  });

  it('detects when the tmux pane is in a raw host shell', async () => {
    manager = createTmuxManager({
      sessionName,
      cwd: tmpDir,
      agentCommand: 'sh',
    });

    await manager.ensureSession();
    // Give tmux a moment to settle the pane command
    await new Promise((r) => setTimeout(r, 150));

    const status = await manager.getStatus();
    assert.equal(status.exists, true);
    assert.equal(status.inHostShell, true);
  });

  it('delivers literal keys via send-keys -l and supports resetSession', async () => {
    const outFile = path.join(tmpDir, 'received.txt');
    const scriptPath = path.join(tmpDir, 'reader.cjs');
    await fs.writeFile(
      scriptPath,
      `const fs = require('fs'); process.stdin.on('data', d => fs.appendFileSync(${JSON.stringify(outFile)}, d));`,
      'utf8'
    );
    manager = createTmuxManager({
      sessionName,
      cwd: tmpDir,
      agentCommand: `${process.execPath} ${scriptPath}`,
    });

    await manager.ensureSession();
    await new Promise((r) => setTimeout(r, 200));

    await manager.sendLiteralKeys('hello $world; Space');

    // Poll briefly for file write
    let content = '';
    for (let i = 0; i < 20; i += 1) {
      try {
        content = await fs.readFile(outFile, 'utf8');
        if (content.includes('hello $world; Space')) break;
      } catch {
        // not written yet
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.match(content, /hello \$world; Space/);

    // Reset session should kill and recreate with a new pane PID
    const { stdout: pidBefore } = await execFileAsync('tmux', [
      'list-panes',
      '-t',
      sessionName,
      '-F',
      '#{pane_pid}',
    ]);
    await manager.resetSession();
    const { stdout: pidAfter } = await execFileAsync('tmux', [
      'list-panes',
      '-t',
      sessionName,
      '-F',
      '#{pane_pid}',
    ]);
    assert.notEqual(pidBefore.trim(), pidAfter.trim());
  });
});
