import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { WebSocket } from 'ws';

const execFileAsync = promisify(execFile);
const REPO_ROOT = process.cwd();
const OFFICE_SH = path.join(REPO_ROOT, 'office.sh');

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
    server.on('error', reject);
  });
}

async function runOffice(args, env) {
  const { stdout, stderr } = await execFileAsync(OFFICE_SH, args, {
    cwd: REPO_ROOT,
    env: { ...process.env, ...env },
    timeout: 20000,
  });
  return { stdout, stderr };
}

function waitForWsMessage(ws, predicate, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('Timed out waiting for WebSocket message'));
    }, timeoutMs);

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString('utf8'));
        if (predicate(msg)) {
          clearTimeout(timer);
          resolve(msg);
        }
      } catch {
        // Ignore non-JSON frames
      }
    });

    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

describe('AI Office end-to-end integration & security', () => {
  const cleanups = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      const fn = cleanups.pop();
      await fn();
    }
  });

  it('validates security boundaries, project CRUD with dynamic branches, chat/transcript streaming, and terminal cutoff', async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-office-e2e-state-'));
    const transcriptDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-office-e2e-transcript-'));
    const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-office-e2e-repo-'));
    const nonGitDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-office-e2e-nongit-'));
    const sessionName = `ai-office-test-e2e-${process.pid}-${Date.now()}`;
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
      await fs.rm(nonGitDir, { recursive: true, force: true });
    });

    await execFileAsync('git', ['init', '-b', 'main', repoDir]);
    await execFileAsync('git', ['-C', repoDir, 'config', 'user.email', 'e2e@example.com']);
    await execFileAsync('git', ['-C', repoDir, 'config', 'user.name', 'E2E User']);
    await fs.writeFile(path.join(repoDir, 'README.md'), '# E2E Repo\n', 'utf8');
    await execFileAsync('git', ['-C', repoDir, 'add', 'README.md']);
    await execFileAsync('git', ['-C', repoDir, 'commit', '-m', 'init']);

    await runOffice(['start'], env);

    const token = (await fs.readFile(path.join(stateDir, 'bridge.token'), 'utf8')).trim();
    assert.ok(token.length >= 32);

    // 1. Security: Host Bridge rejects unauthenticated / invalid token / non-whitelisted paths
    const unauthApi = await fetch(`http://127.0.0.1:${bridgePort}/api/projects`);
    assert.equal(unauthApi.status, 401);

    const badAuthApi = await fetch(`http://127.0.0.1:${bridgePort}/api/projects`, {
      headers: { Authorization: 'Bearer wrong-token' },
    });
    assert.equal(badAuthApi.status, 401);

    const unknownPath = await fetch(`http://127.0.0.1:${bridgePort}/etc/passwd`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(unknownPath.status, 404);

    // WebSocket auth enforcement
    await new Promise((resolve) => {
      const termWs = new WebSocket(`ws://127.0.0.1:${bridgePort}/ws/chat`);
      termWs.on('error', () => {});
      termWs.on('unexpected-response', (_req, res) => {
        assert.equal(res.statusCode, 401);
        resolve();
      });
    });

    // Web UI never leaks OFFICE_BRIDGE_TOKEN
    for (const assetPath of ['/', '/js/app.js', '/styles.css']) {
      const res = await fetch(`http://127.0.0.1:${webPort}${assetPath}`);
      assert.equal(res.status, 200);
      const body = await res.text();
      assert.ok(!body.includes(token), `Token leaked in ${assetPath}`);
      for (const [k, v] of res.headers.entries()) {
        assert.ok(!v.includes(token), `Token leaked in header ${k}`);
      }
    }

    // 2. Project Registry CRUD & dynamic branch detection via Web UI proxy
    const invalidAdd = await fetch(`http://127.0.0.1:${webPort}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Not Git', path: nonGitDir }),
    });
    assert.equal(invalidAdd.status, 400);

    const validAdd = await fetch(`http://127.0.0.1:${webPort}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'E2E Repo', path: repoDir }),
    });
    assert.equal(validAdd.status, 201);
    const { project } = await validAdd.json();
    assert.equal(project.branch, 'main');

    // Switch Git branch on disk and verify dynamic resolution
    await execFileAsync('git', ['-C', repoDir, 'checkout', '-b', 'feat/e2e-branch']);
    const statusRes = await fetch(`http://127.0.0.1:${webPort}/api/status`);
    assert.equal(statusRes.status, 200);
    const statusData = await statusRes.json();
    assert.equal(statusData.activeProject.id, project.id);
    assert.equal(statusData.activeProject.branch, 'feat/e2e-branch');

    // 3. Chat prompt delivery + transcript streaming over /ws/chat
    const chatWs = new WebSocket(`ws://127.0.0.1:${webPort}/ws/chat`);
    cleanups.push(async () => chatWs.close());
    await waitForWsMessage(chatWs, (m) => m.type === 'history');

    const chatRes = await fetch(`http://127.0.0.1:${webPort}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'How should I plan a new feature?' }),
    });
    assert.equal(chatRes.status, 202);

    // Verify tmux received the prompt
    await new Promise((r) => setTimeout(r, 150));
    const { stdout: paneContent } = await execFileAsync('tmux', [
      'capture-pane',
      '-t',
      `=${sessionName}:`,
      '-p',
    ]);
    assert.match(paneContent, /How should I plan a new feature\?/);

    // Simulate Riley writing a 4-part response to the session transcript JSONL
    const transcriptFile = path.join(transcriptDir, 'riley-e2e-session.jsonl');
    const turnPromise = waitForWsMessage(
      chatWs,
      (m) => m.type === 'turn' && m.turn?.type === 'assistant'
    );

    const assistantEntry = {
      type: 'assistant',
      uuid: 'e2e-turn-1',
      timestamp: new Date().toISOString(),
      message: {
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: [
              '1. **Current Stage**: Planning & Design',
              '2. **Recommended Skill**: `/grill-with-docs` (Planning)',
              '3. **Copy-Paste Command**:',
              '```bash',
              `cd ${repoDir} && claude "/grill-with-docs"`,
              '```',
              '4. **Context Hygiene**: Start a fresh session before running `/to-tickets`.',
            ].join('\n'),
          },
        ],
      },
    };
    await fs.writeFile(transcriptFile, `${JSON.stringify(assistantEntry)}\n`, 'utf8');

    const streamed = await turnPromise;
    assert.match(streamed.turn.text, /\/grill-with-docs/);
    assert.ok(streamed.turn.text.includes(repoDir));

    // Remove project non-destructively (files on disk remain intact)
    const delRes = await fetch(`http://127.0.0.1:${webPort}/api/projects/${project.id}`, {
      method: 'DELETE',
    });
    assert.equal(delRes.status, 200);
    const readmeExists = await fs
      .stat(path.join(repoDir, 'README.md'))
      .then(() => true)
      .catch(() => false);
    assert.equal(readmeExists, true);

    // 4. Terminal cutoff when tmux pane is in a raw host shell
    await execFileAsync('tmux', ['kill-session', '-t', `=${sessionName}`]);
    await execFileAsync('tmux', ['new-session', '-d', '-s', sessionName, '-c', REPO_ROOT, 'sh']);

    await new Promise((resolve) => {
      const termWs = new WebSocket(`ws://127.0.0.1:${webPort}/ws/terminal`);
      const events = [];
      termWs.on('message', (raw) => {
        try {
          events.push(JSON.parse(raw.toString('utf8')));
        } catch {
          // ignore
        }
      });
      termWs.on('close', (code) => {
        assert.equal(code, 4003);
        assert.ok(events.some((e) => e.type === 'cutoff'));
        resolve();
      });
    });
  });
});
