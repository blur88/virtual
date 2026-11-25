import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createTranscriptWatcher } from '../../src/bridge/transcript-watcher.js';

describe('transcript-watcher', () => {
  let tmpDir;
  let watcher;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-office-transcript-'));
  });

  afterEach(async () => {
    if (watcher) {
      await watcher.stop();
      watcher = null;
    }
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('buffers partial JSONL writes without syntax errors and emits complete turns', async () => {
    const filePath = path.join(tmpDir, 'session-1.jsonl');
    await fs.writeFile(filePath, '', 'utf8');

    watcher = createTranscriptWatcher({ transcriptDir: tmpDir, pollIntervalMs: 50 });
    const events = [];
    watcher.on('turn', (turn) => events.push(turn));
    watcher.on('error', (err) => assert.fail(`Unexpected watcher error: ${err.message}`));

    await watcher.start();

    const userLine = JSON.stringify({
      type: 'user',
      uuid: 'u-1',
      timestamp: '2026-11-25T00:00:01Z',
      message: { role: 'user', content: 'Where should I start?' },
    });
    const assistantLine = JSON.stringify({
      type: 'assistant',
      uuid: 'a-1',
      timestamp: '2026-11-25T00:00:02Z',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Use /grill-me first.' }],
        stop_reason: 'end_turn',
      },
    });

    // Write partial user line (no trailing newline yet)
    const half = Math.floor(userLine.length / 2);
    await fs.appendFile(filePath, userLine.slice(0, half), 'utf8');
    await watcher.pollNow();

    assert.equal(events.length, 0);
    assert.equal(watcher.getState().isBusy, false);

    // Complete user line + newline
    await fs.appendFile(filePath, `${userLine.slice(half)}\n`, 'utf8');
    await watcher.pollNow();

    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'user');
    assert.equal(events[0].text, 'Where should I start?');
    assert.equal(watcher.getState().isBusy, true);

    // Write assistant line with end_turn
    await fs.appendFile(filePath, `${assistantLine}\n`, 'utf8');
    await watcher.pollNow();

    assert.equal(events.length, 2);
    assert.equal(events[1].type, 'assistant');
    assert.equal(events[1].text, 'Use /grill-me first.');
    assert.equal(watcher.getState().isBusy, false);
  });

  it('switches cleanly to a newer session JSONL file on /clear without mixing or duplicating turns', async () => {
    const file1 = path.join(tmpDir, 'session-old.jsonl');
    const line1 = JSON.stringify({
      type: 'user',
      uuid: 'u-old',
      timestamp: '2026-11-25T00:00:01Z',
      message: { role: 'user', content: 'Old question' },
    });
    await fs.writeFile(file1, `${line1}\n`, 'utf8');

    watcher = createTranscriptWatcher({ transcriptDir: tmpDir, pollIntervalMs: 50 });
    const resets = [];
    watcher.on('reset', (info) => resets.push(info));
    await watcher.start();

    assert.equal(watcher.getState().turns.length, 1);
    assert.equal(watcher.getState().turns[0].text, 'Old question');

    // Ensure newer mtime for the new session file
    await new Promise((r) => setTimeout(r, 20));
    const file2 = path.join(tmpDir, 'session-new.jsonl');
    const line2 = JSON.stringify({
      type: 'user',
      uuid: 'u-new',
      timestamp: '2026-11-25T00:01:00Z',
      message: { role: 'user', content: 'Fresh question' },
    });
    await fs.writeFile(file2, `${line2}\n`, 'utf8');
    await watcher.pollNow();

    assert.equal(resets.length, 1);
    assert.equal(watcher.getState().turns.length, 1);
    assert.equal(watcher.getState().turns[0].text, 'Fresh question');
  });

  it('handles /compact system boundary events cleanly', async () => {
    const filePath = path.join(tmpDir, 'session-compact.jsonl');
    const compactLine = JSON.stringify({
      type: 'system',
      subtype: 'compact_boundary',
      uuid: 'sys-1',
      timestamp: '2026-11-25T00:02:00Z',
    });
    await fs.writeFile(filePath, `${compactLine}\n`, 'utf8');

    watcher = createTranscriptWatcher({ transcriptDir: tmpDir, pollIntervalMs: 50 });
    await watcher.start();

    const state = watcher.getState();
    assert.equal(state.turns.length, 1);
    assert.equal(state.turns[0].type, 'system');
    assert.equal(state.turns[0].subtype, 'compact');
  });
});
