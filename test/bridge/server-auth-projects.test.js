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

describe('host-bridge HTTP auth & project settings', () => {
  let tmpDir;
  let bridge;
  let baseUrl;
  let wsBaseUrl;
  const token = 'test-secret-bridge-token-123456';

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-office-bridge-'));
    const registry = createProjectRegistry({
      registryPath: path.join(tmpDir, '.office', 'projects.json'),
    });
    const fakeTmux = {
      sessionName: 'ai-office-test-noop',
      ensureSession: async () => ({ sessionName: 'ai-office-test-noop', created: false }),
      getStatus: async () => ({
        sessionName: 'ai-office-test-noop',
        exists: true,
        running: true,
        paneCommand: 'claude',
        paneDead: false,
        inHostShell: false,
      }),
      sendLiteralKeys: async () => {},
      resetSession: async () => ({ sessionName: 'ai-office-test-noop', created: true }),
    };

    bridge = createHostBridge({
      host: '127.0.0.1',
      port: 0,
      token,
      registry,
      tmuxManager: fakeTmux,
    });
    const addr = await bridge.start();
    assert.equal(addr.host, '127.0.0.1');
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

  it('fails fast with a clear diagnostic when the port is already occupied', async () => {
    const blocker = net.createServer();
    await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    const occupiedPort = blocker.address().port;

    const conflictingBridge = createHostBridge({
      host: '127.0.0.1',
      port: occupiedPort,
      token,
      registry: createProjectRegistry({ registryPath: path.join(tmpDir, 'conflict.json') }),
    });

    try {
      await assert.rejects(
        () => conflictingBridge.start(),
        (err) => err.code === 'EADDRINUSE' && err.message.includes(String(occupiedPort))
      );
    } finally {
      await new Promise((resolve) => blocker.close(resolve));
    }
  });

  it('enforces Bearer token auth on /api/* and /ws/* and returns 404 on non-whitelisted paths', async () => {
    // Missing token -> 401
    const noAuthRes = await fetch(`${baseUrl}/api/health`);
    assert.equal(noAuthRes.status, 401);

    // Invalid token -> 401
    const badAuthRes = await fetch(`${baseUrl}/api/projects`, {
      headers: { Authorization: 'Bearer wrong-token' },
    });
    assert.equal(badAuthRes.status, 401);

    // Valid token on /api/health -> 200
    const healthRes = await fetch(`${baseUrl}/api/health`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(healthRes.status, 200);
    const healthJson = await healthRes.json();
    assert.equal(healthJson.ok, true);

    // Non-whitelisted path -> 404
    const unknownRes = await fetch(`${baseUrl}/not-a-bridge-route`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(unknownRes.status, 404);

    const unknownApiRes = await fetch(`${baseUrl}/api/nonexistent`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(unknownApiRes.status, 404);

    // WebSocket without valid token -> rejected with 401
    await assert.rejects(
      () =>
        new Promise((resolve, reject) => {
          const ws = new WebSocket(`${wsBaseUrl}/ws/chat`);
          ws.on('open', () => {
            ws.close();
            resolve();
          });
          ws.on('error', reject);
        }),
      /401/
    );
  });

  it('supports full Project Settings CRUD and maps validation errors to HTTP status codes', async () => {
    const headers = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    };

    const repo1 = path.join(tmpDir, 'repo-one');
    const repo2 = path.join(tmpDir, 'repo-two');
    const nonGit = path.join(tmpDir, 'plain-dir');
    await initTempGitRepo(repo1);
    await initTempGitRepo(repo2);
    await fs.mkdir(nonGit, { recursive: true });

    // Reject non-git directory -> 400
    const badAdd = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'Bad', path: nonGit }),
    });
    assert.equal(badAdd.status, 400);

    // Add repo1 -> 201
    const add1 = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'Repo One', path: repo1 }),
    });
    assert.equal(add1.status, 201);
    const { project: p1 } = await add1.json();
    assert.equal(p1.name, 'Repo One');
    assert.ok(p1.branch);

    // Duplicate path -> 409
    const dupAdd = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'Dup', path: repo1 }),
    });
    assert.equal(dupAdd.status, 409);

    // Add repo2 -> 201
    const add2 = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'Repo Two', path: repo2 }),
    });
    assert.equal(add2.status, 201);
    const { project: p2 } = await add2.json();

    // Activate repo2
    const actRes = await fetch(`${baseUrl}/api/projects/${p2.id}/activate`, {
      method: 'POST',
      headers,
    });
    assert.equal(actRes.status, 200);
    const activeRes = await fetch(`${baseUrl}/api/projects/active`, { headers });
    assert.equal(activeRes.status, 200);
    const { project: active } = await activeRes.json();
    assert.equal(active.id, p2.id);

    // Edit repo1 name
    const editRes = await fetch(`${baseUrl}/api/projects/${p1.id}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ name: 'Repo One Renamed' }),
    });
    assert.equal(editRes.status, 200);
    const { project: edited } = await editRes.json();
    assert.equal(edited.name, 'Repo One Renamed');

    // Remove repo2 non-destructively
    const delRes = await fetch(`${baseUrl}/api/projects/${p2.id}`, {
      method: 'DELETE',
      headers,
    });
    assert.equal(delRes.status, 200);

    // Verify files on disk still exist
    const readmeStat = await fs.stat(path.join(repo2, 'README.md'));
    assert.equal(readmeStat.isFile(), true);

    // List projects -> only p1 remains
    const listRes = await fetch(`${baseUrl}/api/projects`, { headers });
    assert.equal(listRes.status, 200);
    const listJson = await listRes.json();
    assert.equal(listJson.projects.length, 1);
    assert.equal(listJson.activeProjectId, p1.id);
  });
});
