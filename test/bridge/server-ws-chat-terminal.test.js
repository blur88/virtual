import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import WebSocket from 'ws';
import { createProjectRegistry } from '../../src/registry/index.js';
import { createTranscriptWatcher } from '../../src/bridge/transcript-watcher.js';
import { createInputLease } from '../../src/bridge/input-lease.js';
import { createHostBridge } from '../../src/bridge/server.js';

function createWsMessageQueue(ws) {
  const queue = [];
  const waiters = [];
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString('utf8'));
    if (waiters.length > 0) {
      waiters.shift()(msg);
    } else {
      queue.push(msg);
    }
  });
  return async function nextMessage(predicate = () => true, timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const idx = queue.findIndex(predicate);
      if (idx !== -1) {
        return queue.splice(idx, 1)[0];
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      const msg = await Promise.race([
        new Promise((resolve) => waiters.push(resolve)),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Timed out waiting for WS message')), remaining)
        ),
      ]);
      if (predicate(msg)) {
        return msg;
      }
      queue.push(msg);
    }
    throw new Error('Timed out waiting for matching WS message');
  };
}

describe('host-bridge chat, transcript WS, input lease, and terminal cutoff', () => {
  let tmpDir;
  let transcriptDir;
  let bridge;
  let baseUrl;
  let wsBaseUrl;
  let sentPrompts;
  let tmuxInHostShell;
  let resetCalls;
  let ptyWrites;
  const token = 'ws-test-token-abcdef';

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-office-ws-'));
    transcriptDir = path.join(tmpDir, 'transcripts');
    await fs.mkdir(transcriptDir, { recursive: true });

    sentPrompts = [];
    tmuxInHostShell = false;
    resetCalls = 0;
    ptyWrites = [];

    const registry = createProjectRegistry({
      registryPath: path.join(tmpDir, '.office', 'projects.json'),
    });
    const transcriptWatcher = createTranscriptWatcher({
      transcriptDir,
      pollIntervalMs: 40,
    });
    const inputLease = createInputLease();

    const fakeTmux = {
      sessionName: 'ai-office-test-ws',
      ensureSession: async () => ({ sessionName: 'ai-office-test-ws', created: false }),
      getStatus: async () => ({
        sessionName: 'ai-office-test-ws',
        exists: true,
        running: !tmuxInHostShell,
        paneCommand: tmuxInHostShell ? 'bash' : 'claude',
        paneDead: false,
        inHostShell: tmuxInHostShell,
      }),
      sendLiteralKeys: async (text) => {
        sentPrompts.push(text);
      },
      resetSession: async () => {
        resetCalls += 1;
        return { sessionName: 'ai-office-test-ws', created: true };
      },
    };

    const fakePtyFactory = () => {
      const dataHandlers = [];
      const exitHandlers = [];
      return {
        write(data) {
          ptyWrites.push(data);
          for (const cb of dataHandlers) cb(data);
        },
        resize() {},
        kill() {
          // no-op in fake
        },
        onData(cb) {
          dataHandlers.push(cb);
        },
        onExit(cb) {
          exitHandlers.push(cb);
        },
      };
    };

    bridge = createHostBridge({
      host: '127.0.0.1',
      port: 0,
      token,
      registry,
      tmuxManager: fakeTmux,
      transcriptWatcher,
      inputLease,
      ptyFactory: fakePtyFactory,
      terminalStatusPollMs: 50,
    });

    const addr = await bridge.start();
    baseUrl = `http://127.0.0.1:${addr.port}`;
    wsBaseUrl = `ws://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    if (bridge) {
      await bridge.stop();
      bridge = null;
    }
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('delivers chat prompts only when idle and streams transcript turns over /ws/chat', async () => {
    const transcriptFile = path.join(transcriptDir, 'session-1.jsonl');
    await fs.writeFile(transcriptFile, '', 'utf8');

    const ws = new WebSocket(`${wsBaseUrl}/ws/chat`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const nextMsg = createWsMessageQueue(ws);

    const history = await nextMsg((m) => m.type === 'history');
    assert.deepEqual(history.turns, []);
    assert.equal(history.isBusy, false);

    // Agent is idle -> POST /api/chat succeeds (202)
    const chatRes = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ message: 'How do I plan this feature?' }),
    });
    assert.equal(chatRes.status, 202);
    assert.deepEqual(sentPrompts, ['How do I plan this feature?']);

    // Simulate Claude Code appending user turn -> isBusy becomes true
    const userLine = JSON.stringify({
      type: 'user',
      uuid: 'u-1',
      timestamp: '2026-11-25T00:00:01Z',
      message: { role: 'user', content: 'How do I plan this feature?' },
    });
    await fs.appendFile(transcriptFile, `${userLine}\n`, 'utf8');

    const userTurnMsg = await nextMsg((m) => m.type === 'turn' && m.turn.type === 'user');
    assert.equal(userTurnMsg.turn.text, 'How do I plan this feature?');

    // While busy, POST /api/chat must be rejected with 409
    const busyRes = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ message: 'Interrupting message' }),
    });
    assert.equal(busyRes.status, 409);
    assert.equal(sentPrompts.length, 1);

    // Append assistant end_turn -> idle again
    const assistantLine = JSON.stringify({
      type: 'assistant',
      uuid: 'a-1',
      timestamp: '2026-11-25T00:00:02Z',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Run /write-a-prd next.' }],
        stop_reason: 'end_turn',
      },
    });
    await fs.appendFile(transcriptFile, `${assistantLine}\n`, 'utf8');

    const assistantTurnMsg = await nextMsg((m) => m.type === 'turn' && m.turn.type === 'assistant');
    assert.equal(assistantTurnMsg.turn.text, 'Run /write-a-prd next.');

    // Reset agent works cleanly
    const resetRes = await fetch(`${baseUrl}/api/agent/reset`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(resetRes.status, 200);
    assert.equal(resetCalls, 1);

    ws.close();
  });

  it('enforces Input Lease with instant override and cuts off /ws/terminal when agent exits to host shell', async () => {
    const ws = new WebSocket(`${wsBaseUrl}/ws/terminal`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const nextMsg = createWsMessageQueue(ws);

    const initialLease = await nextMsg((m) => m.type === 'lease');
    assert.equal(initialLease.inputLease.holder, 'none');

    // Simulate native tmux attach typing
    bridge.inputLease.recordNativeActivity();

    // Web input is blocked while native holds lease
    ws.send(JSON.stringify({ type: 'input', data: 'ls\n' }));
    const blocked = await nextMsg((m) => m.type === 'lease-blocked');
    assert.equal(blocked.inputLease.holder, 'native');
    assert.equal(ptyWrites.length, 0);

    // Instant UI override
    ws.send(JSON.stringify({ type: 'override-lease' }));
    const overridden = await nextMsg((m) => m.type === 'lease');
    assert.equal(overridden.inputLease.holder, 'web');

    // Web input now flows to PTY
    ws.send(JSON.stringify({ type: 'input', data: 'hello\n' }));
    const echoed = await nextMsg((m) => m.type === 'output');
    assert.equal(echoed.data, 'hello\n');
    assert.deepEqual(ptyWrites, ['hello\n']);

    // Simulate Claude Code exiting to raw host shell -> immediate cutoff + close
    const closedPromise = new Promise((resolve) => {
      ws.on('close', (code) => resolve(code));
    });
    tmuxInHostShell = true;

    const cutoff = await nextMsg((m) => m.type === 'cutoff');
    assert.match(cutoff.reason, /host shell/i);
    const closeCode = await closedPromise;
    assert.equal(closeCode, 4003);
  });
});
