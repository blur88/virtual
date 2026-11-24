import path from 'node:path';
import os from 'node:os';
import { createProjectRegistry } from '../registry/index.js';
import {
  createHostBridge,
  createTmuxManager,
  createTranscriptWatcher,
  generateBridgeToken,
} from './index.js';

function resolveTranscriptDir() {
  if (process.env.OFFICE_TRANSCRIPT_DIR) {
    return process.env.OFFICE_TRANSCRIPT_DIR;
  }
  const encodedCwd = process.cwd().replace(/\//g, '-');
  return path.join(os.homedir(), '.claude', 'projects', encodedCwd);
}

async function main() {
  const host = '127.0.0.1';
  const port = Number(process.env.OFFICE_BRIDGE_PORT || 4040);
  const token = process.env.OFFICE_BRIDGE_TOKEN || generateBridgeToken();
  const sessionName = process.env.OFFICE_TMUX_SESSION || 'ai-office-riley';
  const transcriptDir = resolveTranscriptDir();

  const registry = createProjectRegistry();
  const tmuxManager = createTmuxManager({ sessionName, cwd: process.cwd() });
  const transcriptWatcher = createTranscriptWatcher({ transcriptDir });

  await tmuxManager.ensureSession();

  const bridge = createHostBridge({
    host,
    port,
    token,
    registry,
    tmuxManager,
    transcriptWatcher,
  });

  const addr = await bridge.start();
  console.log(`Host Bridge listening on http://${addr.host}:${addr.port}`);
  if (!process.env.OFFICE_BRIDGE_TOKEN) {
    console.log(`OFFICE_BRIDGE_TOKEN=${token}`);
  }

  const shutdown = async () => {
    await bridge.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
