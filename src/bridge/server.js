import http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { createProjectRegistry, RegistryError } from '../registry/index.js';
import { generateBridgeToken, verifyBearerToken } from './auth.js';
import { createTmuxManager } from './tmux-manager.js';
import { createInputLease } from './input-lease.js';
import { attachTmuxPty } from './terminal-pty.js';

const REGISTRY_ERROR_STATUS = {
  INVALID_NAME: 400,
  INVALID_PATH: 400,
  NOT_A_DIRECTORY: 400,
  NOT_A_GIT_REPO: 400,
  NOT_GIT_ROOT: 400,
  PROJECT_NOT_FOUND: 404,
  DUPLICATE_PROJECT_PATH: 409,
  INVALID_REGISTRY_FILE: 500,
};

const MAX_BODY_BYTES = 1024 * 1024;

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

async function readJsonBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) {
      const err = new Error('Request body too large');
      err.statusCode = 413;
      throw err;
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) {
    return {};
  }
  try {
    return JSON.parse(raw);
  } catch {
    const err = new Error('Invalid JSON request body');
    err.statusCode = 400;
    throw err;
  }
}

function sendWsJson(ws, payload) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

/**
 * Creates the Host Bridge HTTP + WebSocket server.
 *
 * @param {{
 *   host?: string,
 *   port?: number,
 *   token?: string,
 *   registry?: ReturnType<typeof createProjectRegistry>,
 *   tmuxManager?: ReturnType<typeof createTmuxManager>,
 *   transcriptWatcher?: object | null,
 *   inputLease?: ReturnType<typeof createInputLease>,
 *   ptyFactory?: typeof attachTmuxPty,
 *   terminalStatusPollMs?: number,
 * }} [options]
 */
export function createHostBridge(options = {}) {
  const host = options.host || '127.0.0.1';
  const port =
    options.port !== undefined
      ? Number(options.port)
      : Number(process.env.OFFICE_BRIDGE_PORT || 4040);
  const token = options.token || process.env.OFFICE_BRIDGE_TOKEN || generateBridgeToken();
  const registry = options.registry || createProjectRegistry();
  const tmuxManager = options.tmuxManager || createTmuxManager();
  const transcriptWatcher = options.transcriptWatcher || null;
  const inputLease = options.inputLease || createInputLease();
  const ptyFactory = options.ptyFactory || attachTmuxPty;
  const terminalStatusPollMs = options.terminalStatusPollMs || 500;

  const chatClients = new Set();
  const terminalCleanups = new Set();
  const wss = new WebSocketServer({ noServer: true });

  function broadcastChat(payload) {
    for (const client of chatClients) {
      sendWsJson(client, payload);
    }
  }

  let watcherBound = false;
  function bindTranscriptWatcher() {
    if (!transcriptWatcher || watcherBound) {
      return;
    }
    watcherBound = true;
    transcriptWatcher.on('turn', (turn) => broadcastChat({ type: 'turn', turn }));
    transcriptWatcher.on('status', ({ isBusy }) => broadcastChat({ type: 'status', isBusy }));
    transcriptWatcher.on('reset', (info) => broadcastChat({ type: 'reset', ...info }));
  }

  async function handleApiRequest(req, res, pathname) {
    if (req.method === 'GET' && pathname === '/api/health') {
      return sendJson(res, 200, {
        ok: true,
        status: 'ok',
        timestamp: new Date().toISOString(),
      });
    }

    if (req.method === 'GET' && pathname === '/api/status') {
      const [tmux, activeProject] = await Promise.all([
        tmuxManager.getStatus(),
        registry.getActiveProject(),
      ]);
      const transcriptState = transcriptWatcher
        ? transcriptWatcher.getState()
        : { activeFile: null, turns: [], isBusy: false };
      return sendJson(res, 200, {
        ok: true,
        tmux,
        agent: {
          idle: !transcriptState.isBusy,
          isBusy: transcriptState.isBusy,
        },
        inputLease: inputLease.getState(),
        activeProject,
      });
    }

    if (req.method === 'GET' && pathname === '/api/projects') {
      return sendJson(res, 200, await registry.listProjects());
    }

    if (req.method === 'GET' && pathname === '/api/projects/active') {
      return sendJson(res, 200, { project: await registry.getActiveProject() });
    }

    if (req.method === 'POST' && pathname === '/api/projects') {
      const body = await readJsonBody(req);
      const project = await registry.addProject({ name: body.name, path: body.path });
      return sendJson(res, 201, { project });
    }

    if (req.method === 'PUT' && pathname === '/api/projects/active') {
      const body = await readJsonBody(req);
      const result = await registry.selectActiveProject(body.id);
      return sendJson(res, 200, result);
    }

    const activateMatch = /^\/api\/projects\/([^/]+)\/activate$/.exec(pathname);
    if (req.method === 'POST' && activateMatch) {
      const result = await registry.selectActiveProject(decodeURIComponent(activateMatch[1]));
      return sendJson(res, 200, result);
    }

    const projectIdMatch = /^\/api\/projects\/([^/]+)$/.exec(pathname);
    if (projectIdMatch) {
      const id = decodeURIComponent(projectIdMatch[1]);
      if (req.method === 'PATCH') {
        const body = await readJsonBody(req);
        const project = await registry.editProject(id, { name: body.name, path: body.path });
        return sendJson(res, 200, { project });
      }
      if (req.method === 'DELETE') {
        const result = await registry.removeProject(id);
        return sendJson(res, 200, result);
      }
    }

    if (req.method === 'GET' && pathname === '/api/transcript') {
      const state = transcriptWatcher
        ? transcriptWatcher.getState()
        : { activeFile: null, turns: [], isBusy: false };
      return sendJson(res, 200, state);
    }

    if (req.method === 'POST' && pathname === '/api/chat') {
      const body = await readJsonBody(req);
      if (typeof body.message !== 'string' || body.message.trim() === '') {
        return sendJson(res, 400, { error: 'Message must be a non-empty string.' });
      }
      const transcriptState = transcriptWatcher ? transcriptWatcher.getState() : { isBusy: false };
      if (transcriptState.isBusy) {
        return sendJson(res, 409, {
          error: 'Agent is currently processing a turn. Wait until idle.',
          code: 'AGENT_BUSY',
        });
      }
      await tmuxManager.ensureSession();
      await tmuxManager.sendLiteralKeys(body.message);
      return sendJson(res, 202, { ok: true, delivered: true });
    }

    if (req.method === 'POST' && pathname === '/api/agent/reset') {
      const session = await tmuxManager.resetSession();
      const lease = inputLease.release();
      return sendJson(res, 200, { ok: true, session, inputLease: lease });
    }

    if (req.method === 'POST' && pathname === '/api/terminal/override-lease') {
      const lease = inputLease.overrideToWeb();
      return sendJson(res, 200, { ok: true, inputLease: lease });
    }

    return sendJson(res, 404, { error: 'Not Found' });
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${host}`);
    const pathname = url.pathname;

    if (!pathname.startsWith('/api/')) {
      return sendJson(res, 404, { error: 'Not Found' });
    }

    if (!verifyBearerToken(req.headers.authorization, token)) {
      return sendJson(res, 401, { error: 'Unauthorized' });
    }

    try {
      await handleApiRequest(req, res, pathname);
    } catch (err) {
      if (err instanceof RegistryError) {
        const status = REGISTRY_ERROR_STATUS[err.code] || 400;
        return sendJson(res, status, { error: err.message, code: err.code });
      }
      if (err && err.statusCode) {
        return sendJson(res, err.statusCode, { error: err.message });
      }
      return sendJson(res, 500, { error: err?.message || 'Internal Server Error' });
    }
  });

  function handleChatWs(ws) {
    chatClients.add(ws);
    const state = transcriptWatcher
      ? transcriptWatcher.getState()
      : { activeFile: null, turns: [], isBusy: false };
    sendWsJson(ws, {
      type: 'history',
      activeFile: state.activeFile,
      turns: state.turns,
      isBusy: state.isBusy,
    });
    ws.on('close', () => {
      chatClients.delete(ws);
    });
  }

  async function handleTerminalWs(ws) {
    let cutoffActive = false;
    let ptyProc = null;
    let pollTimer = null;
    let cleanedUp = false;

    function cleanup() {
      if (cleanedUp) {
        return;
      }
      cleanedUp = true;
      terminalCleanups.delete(cleanup);
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      if (ptyProc) {
        ptyProc.kill();
        ptyProc = null;
      }
    }

    terminalCleanups.add(cleanup);

    function triggerCutoff(reason) {
      if (cutoffActive) {
        return;
      }
      cutoffActive = true;
      sendWsJson(ws, { type: 'cutoff', reason });
      cleanup();
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close(4003, reason);
      }
    }

    const initialStatus = await tmuxManager.getStatus();
    if (!initialStatus.exists || !initialStatus.running || initialStatus.inHostShell) {
      return triggerCutoff('Claude Code is not running or exited to host shell');
    }

    ptyProc = ptyFactory({ sessionName: tmuxManager.sessionName });
    ptyProc.onData((data) => {
      sendWsJson(ws, { type: 'output', data });
    });
    ptyProc.onExit(() => {
      triggerCutoff('Terminal PTY detached');
    });

    sendWsJson(ws, { type: 'lease', inputLease: inputLease.getState() });

    pollTimer = setInterval(async () => {
      try {
        const status = await tmuxManager.getStatus();
        if (!status.exists || !status.running || status.inHostShell) {
          triggerCutoff('Agent exited to raw host shell');
        }
      } catch {
        triggerCutoff('Failed to verify agent session status');
      }
    }, terminalStatusPollMs);
    pollTimer.unref();

    ws.on('message', (raw) => {
      if (cutoffActive) {
        return;
      }
      const text = raw.toString('utf8');
      let msg = null;
      try {
        msg = JSON.parse(text);
      } catch {
        // Treat non-JSON frames as raw terminal input
      }

      if (msg && typeof msg === 'object' && msg.type) {
        if (msg.type === 'override-lease') {
          const state = inputLease.overrideToWeb();
          sendWsJson(ws, { type: 'lease', inputLease: state });
          return;
        }
        if (msg.type === 'resize') {
          ptyProc?.resize(msg.cols, msg.rows);
          return;
        }
        if (msg.type === 'input' && typeof msg.data === 'string') {
          const check = inputLease.recordWebInput();
          if (!check.allowed) {
            sendWsJson(ws, { type: 'lease-blocked', inputLease: check.state });
            return;
          }
          ptyProc?.write(msg.data);
          return;
        }
        return;
      }

      const check = inputLease.recordWebInput();
      if (!check.allowed) {
        sendWsJson(ws, { type: 'lease-blocked', inputLease: check.state });
        return;
      }
      ptyProc?.write(text);
    });

    ws.on('close', cleanup);
  }

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url || '/', `http://${host}`);
    const pathname = url.pathname;

    if (!pathname.startsWith('/ws/')) {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    if (!verifyBearerToken(req.headers.authorization, token)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    if (
      pathname !== '/ws/chat' &&
      pathname !== '/ws/transcript' &&
      pathname !== '/ws/terminal'
    ) {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      if (pathname === '/ws/terminal') {
        handleTerminalWs(ws);
      } else {
        handleChatWs(ws);
      }
    });
  });

  return {
    host,
    token,
    registry,
    tmuxManager,
    inputLease,

    async start() {
      bindTranscriptWatcher();
      if (transcriptWatcher && typeof transcriptWatcher.start === 'function') {
        await transcriptWatcher.start();
      }

      await new Promise((resolve, reject) => {
        const onError = (err) => {
          server.off('listening', onListening);
          if (err && err.code === 'EADDRINUSE') {
            const wrapped = new Error(
              `Host Bridge failed to start: port ${port} on ${host} is already in use.`
            );
            wrapped.code = 'EADDRINUSE';
            reject(wrapped);
            return;
          }
          reject(err);
        };
        const onListening = () => {
          server.off('error', onError);
          resolve();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, host);
      });

      const address = server.address();
      return {
        host: address.address,
        port: address.port,
      };
    },

    async stop() {
      for (const cleanup of [...terminalCleanups]) {
        cleanup();
      }
      for (const client of wss.clients) {
        client.terminate();
      }
      if (transcriptWatcher && typeof transcriptWatcher.stop === 'function') {
        await transcriptWatcher.stop();
      }
      if (server.listening) {
        await new Promise((resolve) => server.close(resolve));
      }
    },
  };
}
