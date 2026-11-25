import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import WebSocket from 'ws';
import { createProjectRegistry } from '../../src/registry/index.js';
import { createHostBridge } from '../../src/bridge/server.js';
import { createWebServer } from '../../web/server.js';

const execFileAsync = promisify(execFile);

async function initTempGitRepo(dir) {
  await fs.mkdir(dir, { recursive: true });
  await execFileAsync('git', ['init'], { cwd: dir });
  await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  await fs.writeFile(path.join(dir, 'README.md'), '# Test\n', 'utf8');
  await execFileAsync('git', ['add', 'README.md'], { cwd: dir });
  await execFileAsync('git', ['commit', '-m', 'init'], { cwd: dir });
}

describe('web reverse proxy & static server', () => {
  let tmpDir;
  let bridge;
  let webServer;
  let webBaseUrl;
  let webWsBaseUrl;
  const bridgeToken = 'super-secret-office-bridge-token-999';

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-office-web-proxy-'));
    const registry = createProjectRegistry({
      registryPath: path.join(tmpDir, '.office', 'projects.json'),
    });
    const fakeTmux = {
      sessionName: 'ai-office-test-proxy',
      ensureSession: async () => ({ sessionName: 'ai-office-test-proxy', created: false }),
      getStatus: async () => ({
        sessionName: 'ai-office-test-proxy',
        exists: true,
        running: true,
        paneCommand: 'claude',
        paneDead: false,
        inHostShell: false,
      }),
      sendLiteralKeys: async () => {},
      resetSession: async () => ({ sessionName: 'ai-office-test-proxy', created: true }),
    };

    bridge = createHostBridge({
      host: '127.0.0.1',
      port: 0,
      token: bridgeToken,
      registry,
      tmuxManager: fakeTmux,
    });
    const bridgeAddr = await bridge.start();

    webServer = createWebServer({
      host: '127.0.0.1',
      port: 0,
      bridgeUrl: `http://127.0.0.1:${bridgeAddr.port}`,
      bridgeToken,
    });
    const webAddr = await webServer.start();
    webBaseUrl = `http://127.0.0.1:${webAddr.port}`;
    webWsBaseUrl = `ws://127.0.0.1:${webAddr.port}`;
  });

  afterEach(async () => {
    if (webServer) {
      await webServer.stop();
      webServer = null;
    }
    if (bridge) {
      await bridge.stop();
      bridge = null;
    }
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('proxies /api/* requests to Host Bridge with server-side Bearer token injection', async () => {
    const repoDir = path.join(tmpDir, 'repo-alpha');
    await initTempGitRepo(repoDir);

    // Client sends NO Authorization header — proxy must inject it server-side
    const healthRes = await fetch(`${webBaseUrl}/api/health`);
    assert.equal(healthRes.status, 200);
    const healthBody = await healthRes.json();
    assert.equal(healthBody.ok, true);

    // Even if client sends a bogus Authorization header, proxy overrides it with bridgeToken
    const createRes = await fetch(`${webBaseUrl}/api/projects`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer bogus-client-token',
      },
      body: JSON.stringify({ name: 'Alpha', path: repoDir }),
    });
    assert.equal(createRes.status, 201);
    const created = await createRes.json();
    assert.equal(created.project.name, 'Alpha');

    // Verify PATCH and GET work through the proxy
    const patchRes = await fetch(`${webBaseUrl}/api/projects/${created.project.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Alpha Renamed' }),
    });
    assert.equal(patchRes.status, 200);
    const patched = await patchRes.json();
    assert.equal(patched.project.name, 'Alpha Renamed');

    const listRes = await fetch(`${webBaseUrl}/api/projects`);
    assert.equal(listRes.status, 200);
    const listBody = await listRes.json();
    assert.equal(listBody.projects.length, 1);
    assert.equal(listBody.projects[0].name, 'Alpha Renamed');
  });

  it('proxies /ws/* WebSocket upgrade handshakes with server-side Bearer token injection', async () => {
    const ws = new WebSocket(`${webWsBaseUrl}/ws/chat`);
    const firstMsg = await new Promise((resolve, reject) => {
      ws.once('error', reject);
      ws.once('message', (data) => resolve(JSON.parse(data.toString('utf8'))));
    });
    assert.equal(firstMsg.type, 'history');
    assert.deepEqual(firstMsg.turns, []);
    ws.close();
  });

  it('never exposes OFFICE_BRIDGE_TOKEN in static assets, headers, or 502 error responses', async () => {
    const indexRes = await fetch(`${webBaseUrl}/`);
    assert.equal(indexRes.status, 200);
    const indexHtml = await indexRes.text();
    assert.ok(!indexHtml.includes(bridgeToken));
    assert.ok(!JSON.stringify(Object.fromEntries(indexRes.headers.entries())).includes(bridgeToken));

    // Stop bridge to verify 502 error response also does not leak token
    await bridge.stop();
    bridge = null;

    const errRes = await fetch(`${webBaseUrl}/api/health`);
    assert.equal(errRes.status, 502);
    const errText = await errRes.text();
    assert.ok(!errText.includes(bridgeToken));
  });

  it('fails fast with EADDRINUSE diagnostic when OFFICE_WEB_PORT is occupied', async () => {
    const blocker = net.createServer();
    await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    const occupiedPort = blocker.address().port;

    const conflictingWeb = createWebServer({
      host: '127.0.0.1',
      port: occupiedPort,
      bridgeUrl: 'http://127.0.0.1:4040',
      bridgeToken,
    });

    try {
      await assert.rejects(
        () => conflictingWeb.start(),
        (err) => err.code === 'EADDRINUSE' && err.message.includes(String(occupiedPort))
      );
    } finally {
      await new Promise((resolve) => blocker.close(resolve));
    }
  });

  it('serves local @xterm/xterm assets at /vendor/xterm/* without external CDN', async () => {
    const jsRes = await fetch(`${webBaseUrl}/vendor/xterm/xterm.js`);
    assert.equal(jsRes.status, 200);
    assert.ok((jsRes.headers.get('content-type') || '').includes('application/javascript'));
    const jsText = await jsRes.text();
    assert.ok(jsText.length > 1000);

    const cssRes = await fetch(`${webBaseUrl}/vendor/xterm/xterm.css`);
    assert.equal(cssRes.status, 200);
    assert.ok((cssRes.headers.get('content-type') || '').includes('text/css'));
    const cssText = await cssRes.text();
    assert.ok(cssText.includes('.xterm'));
  });
});
