import EventEmitter from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Extracts plain text from a Claude Code message content field.
 * Returns null when the content only carries tool_result blocks.
 * @param {string | Array<object>} content
 * @returns {string | null}
 */
function extractMessageText(content) {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return null;
  }
  const textParts = content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text);
  return textParts.length > 0 ? textParts.join('\n') : null;
}

/**
 * Parses a single complete JSONL transcript event into a normalized turn and busy state delta.
 * @param {object} event
 * @returns {{ turn: object | null, nextBusy?: boolean }}
 */
function normalizeTranscriptEvent(event) {
  if (!event || typeof event !== 'object') {
    return { turn: null };
  }

  if (event.type === 'user' && event.message) {
    const text = extractMessageText(event.message.content);
    if (text === null) {
      return { turn: null };
    }
    return {
      turn: {
        id: event.uuid ?? null,
        type: 'user',
        timestamp: event.timestamp ?? null,
        text,
      },
      nextBusy: true,
    };
  }

  if (event.type === 'assistant' && event.message) {
    const text = extractMessageText(event.message.content);
    const stopReason = event.message.stop_reason ?? null;
    const nextBusy = stopReason && stopReason !== 'tool_use' ? false : undefined;
    if (text === null) {
      return { turn: null, nextBusy };
    }
    return {
      turn: {
        id: event.uuid ?? null,
        type: 'assistant',
        timestamp: event.timestamp ?? null,
        text,
        stopReason,
      },
      nextBusy,
    };
  }

  if (event.type === 'system' && event.subtype === 'compact_boundary') {
    return {
      turn: {
        id: event.uuid ?? null,
        type: 'system',
        subtype: 'compact',
        timestamp: event.timestamp ?? null,
        text: 'Context compacted',
      },
      nextBusy: false,
    };
  }

  return { turn: null };
}

/**
 * Finds the most recently modified `.jsonl` file in `transcriptDir`, or null if none exists.
 * @param {string} transcriptDir
 * @returns {Promise<string | null>}
 */
async function findLatestTranscriptFile(transcriptDir) {
  let entries;
  try {
    entries = await fs.readdir(transcriptDir, { withFileTypes: true });
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return null;
    }
    throw err;
  }

  const jsonlFiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
    .map((entry) => path.join(transcriptDir, entry.name));

  if (jsonlFiles.length === 0) {
    return null;
  }

  const stats = await Promise.all(
    jsonlFiles.map(async (filePath) => {
      try {
        const stat = await fs.stat(filePath);
        return { filePath, mtimeMs: stat.mtimeMs };
      } catch {
        return null;
      }
    })
  );

  const valid = stats.filter(Boolean);
  if (valid.length === 0) {
    return null;
  }

  valid.sort((a, b) => b.mtimeMs - a.mtimeMs || b.filePath.localeCompare(a.filePath));
  return valid[0].filePath;
}

/**
 * Creates a line-buffered JSONL Session Transcript watcher.
 *
 * @param {{ transcriptDir: string, pollIntervalMs?: number }} options
 */
export function createTranscriptWatcher({ transcriptDir, pollIntervalMs = 250 }) {
  const emitter = new EventEmitter();
  let timer = null;
  let polling = null;

  let activeFile = null;
  let offset = 0;
  let remainder = '';
  let turns = [];
  let seenIds = new Set();
  let isBusy = false;

  function resetState(nextFile) {
    const hadFile = activeFile !== null;
    activeFile = nextFile;
    offset = 0;
    remainder = '';
    turns = [];
    seenIds = new Set();
    if (isBusy) {
      isBusy = false;
      emitter.emit('status', { isBusy });
    }
    if (hadFile) {
      emitter.emit('reset', { activeFile });
    }
  }

  function processLine(line) {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }

    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      emitter.emit('error', new Error(`Malformed JSONL transcript line: ${err.message}`));
      return;
    }

    const { turn, nextBusy } = normalizeTranscriptEvent(parsed);
    if (turn) {
      if (turn.id && seenIds.has(turn.id)) {
        return;
      }
      if (turn.id) {
        seenIds.add(turn.id);
      }
      turns.push(turn);
      emitter.emit('turn', turn);
    }

    if (nextBusy !== undefined && nextBusy !== isBusy) {
      isBusy = nextBusy;
      emitter.emit('status', { isBusy });
    }
  }

  async function readNewBytes(filePath) {
    let stat;
    try {
      stat = await fs.stat(filePath);
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        return;
      }
      throw err;
    }

    if (stat.size < offset) {
      resetState(filePath);
    }

    if (stat.size === offset) {
      return;
    }

    const bytesToRead = stat.size - offset;
    const handle = await fs.open(filePath, 'r');
    try {
      const buffer = Buffer.allocUnsafe(bytesToRead);
      const { bytesRead } = await handle.read(buffer, 0, bytesToRead, offset);
      offset += bytesRead;
      const chunk = remainder + buffer.subarray(0, bytesRead).toString('utf8');
      const lines = chunk.split('\n');
      remainder = lines.pop() ?? '';
      for (const line of lines) {
        processLine(line);
      }
    } finally {
      await handle.close();
    }
  }

  async function pollOnce() {
    const latestFile = await findLatestTranscriptFile(transcriptDir);
    if (!latestFile) {
      return;
    }
    if (latestFile !== activeFile) {
      resetState(latestFile);
    }
    await readNewBytes(activeFile);
  }

  async function pollNow() {
    if (polling) {
      return polling;
    }
    polling = pollOnce().finally(() => {
      polling = null;
    });
    return polling;
  }

  return Object.assign(emitter, {
    async start() {
      await pollNow();
      if (!timer) {
        timer = setInterval(() => {
          pollNow().catch((err) => emitter.emit('error', err));
        }, pollIntervalMs);
        timer.unref();
      }
    },

    async stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      if (polling) {
        await polling;
      }
    },

    pollNow,

    getState() {
      return {
        activeFile,
        turns: [...turns],
        isBusy,
      };
    },
  });
}
