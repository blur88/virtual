import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { createProjectRegistry } from '../../src/registry/project-registry.js';

const execFileAsync = promisify(execFile);

async function initTempGitRepo(dir, branch = 'main') {
  await fs.mkdir(dir, { recursive: true });
  await execFileAsync('git', ['init', '-b', branch, dir]);
  await execFileAsync('git', ['-C', dir, 'config', 'user.email', 'test@example.com']);
  await execFileAsync('git', ['-C', dir, 'config', 'user.name', 'Test User']);
  await fs.writeFile(path.join(dir, 'README.md'), '# test\n');
  await execFileAsync('git', ['-C', dir, 'add', 'README.md']);
  await execFileAsync('git', ['-C', dir, 'commit', '-m', 'init']);
  return fs.realpath(dir);
}

describe('project-registry', () => {
  let tmpDir;
  let registryPath;
  let registry;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-office-reg-test-'));
    registryPath = path.join(tmpDir, '.office', 'projects.json');
    registry = createProjectRegistry({ registryPath });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns an empty registry when projects.json does not exist yet', async () => {
    const state = await registry.listProjects();
    assert.deepEqual(state, { activeProjectId: null, projects: [] });
    assert.equal(await registry.getActiveProject(), null);
  });

  it('adds a valid target project, persists ADR-0003 schema without branch, and sets it active if first', async () => {
    const repoA = await initTempGitRepo(path.join(tmpDir, 'repos', 'alpha'), 'main');

    const added = await registry.addProject({ name: 'Alpha', path: repoA });
    assert.ok(added.id);
    assert.equal(added.name, 'Alpha');
    assert.equal(added.path, repoA);
    assert.equal(added.branch, 'main');
    assert.ok(added.addedAt);
    assert.ok(added.updatedAt);

    // Verify persisted JSON matches ADR-0003 schema and does NOT store branch
    const raw = JSON.parse(await fs.readFile(registryPath, 'utf8'));
    assert.equal(raw.activeProjectId, added.id);
    assert.equal(raw.projects.length, 1);
    assert.equal('branch' in raw.projects[0], false);
    assert.equal(raw.projects[0].name, 'Alpha');
    assert.equal(raw.projects[0].path, repoA);

    const active = await registry.getActiveProject();
    assert.equal(active.id, added.id);
    assert.equal(active.branch, 'main');
  });

  it('rejects duplicate project paths including symlinks and trailing slashes', async () => {
    const repoA = await initTempGitRepo(path.join(tmpDir, 'repos', 'alpha'));
    await registry.addProject({ name: 'Alpha', path: repoA });

    await assert.rejects(
      () => registry.addProject({ name: 'Alpha Dup', path: `${repoA}/` }),
      { code: 'DUPLICATE_PROJECT_PATH' }
    );

    const symlinkPath = path.join(tmpDir, 'alpha-link');
    await fs.symlink(repoA, symlinkPath);
    await assert.rejects(
      () => registry.addProject({ name: 'Alpha Link', path: symlinkPath }),
      { code: 'DUPLICATE_PROJECT_PATH' }
    );
  });

  it('switches the active project and rejects unknown project IDs', async () => {
    const repoA = await initTempGitRepo(path.join(tmpDir, 'repos', 'alpha'), 'main');
    const repoB = await initTempGitRepo(path.join(tmpDir, 'repos', 'beta'), 'develop');

    const projA = await registry.addProject({ name: 'Alpha', path: repoA });
    const projB = await registry.addProject({ name: 'Beta', path: repoB });

    // First project remains active after adding second
    assert.equal((await registry.getActiveProject()).id, projA.id);

    const selected = await registry.selectActiveProject(projB.id);
    assert.equal(selected.activeProjectId, projB.id);
    assert.equal(selected.project.id, projB.id);
    assert.equal(selected.project.branch, 'develop');

    const active = await registry.getActiveProject();
    assert.equal(active.id, projB.id);
    assert.equal(active.branch, 'develop');

    await assert.rejects(
      () => registry.selectActiveProject('proj-missing'),
      { code: 'PROJECT_NOT_FOUND' }
    );
  });

  it('edits project name and path while re-validating git root and path uniqueness', async () => {
    const repoA = await initTempGitRepo(path.join(tmpDir, 'repos', 'alpha'), 'main');
    const repoB = await initTempGitRepo(path.join(tmpDir, 'repos', 'beta'), 'main');
    const repoC = await initTempGitRepo(path.join(tmpDir, 'repos', 'gamma'), 'feature/c');

    const projA = await registry.addProject({ name: 'Alpha', path: repoA });
    await registry.addProject({ name: 'Beta', path: repoB });

    // Edit name only (and keep same path)
    const renamed = await registry.editProject(projA.id, { name: 'Alpha Renamed', path: repoA });
    assert.equal(renamed.name, 'Alpha Renamed');
    assert.equal(renamed.path, repoA);
    assert.equal(renamed.addedAt, projA.addedAt);

    // Edit path to another valid git repo
    const moved = await registry.editProject(projA.id, { path: repoC });
    assert.equal(moved.name, 'Alpha Renamed');
    assert.equal(moved.path, repoC);
    assert.equal(moved.branch, 'feature/c');

    // Reject duplicate path belonging to another project
    await assert.rejects(
      () => registry.editProject(projA.id, { path: repoB }),
      { code: 'DUPLICATE_PROJECT_PATH' }
    );

    // Reject unknown project id
    await assert.rejects(
      () => registry.editProject('proj-missing', { name: 'Nope' }),
      { code: 'PROJECT_NOT_FOUND' }
    );
  });

  it('removes a project non-destructively and updates activeProjectId cleanly', async () => {
    const repoA = await initTempGitRepo(path.join(tmpDir, 'repos', 'alpha'));
    const repoB = await initTempGitRepo(path.join(tmpDir, 'repos', 'beta'));

    const projA = await registry.addProject({ name: 'Alpha', path: repoA });
    const projB = await registry.addProject({ name: 'Beta', path: repoB });
    assert.equal((await registry.getActiveProject()).id, projA.id);

    // Removing active project A selects remaining project B
    const res1 = await registry.removeProject(projA.id);
    assert.equal(res1.removedId, projA.id);
    assert.equal(res1.activeProjectId, projB.id);
    assert.equal((await registry.getActiveProject()).id, projB.id);

    // Underlying repository on disk is completely untouched
    const readme = await fs.readFile(path.join(repoA, 'README.md'), 'utf8');
    assert.equal(readme, '# test\n');

    // Removing last project sets activeProjectId to null
    const res2 = await registry.removeProject(projB.id);
    assert.equal(res2.activeProjectId, null);
    assert.deepEqual(await registry.listProjects(), { activeProjectId: null, projects: [] });

    await assert.rejects(
      () => registry.removeProject('proj-missing'),
      { code: 'PROJECT_NOT_FOUND' }
    );
  });

  it('reflects branch changes dynamically on subsequent reads and rejects corrupt registry JSON', async () => {
    const repoA = await initTempGitRepo(path.join(tmpDir, 'repos', 'alpha'), 'main');
    await registry.addProject({ name: 'Alpha', path: repoA });

    await execFileAsync('git', ['-C', repoA, 'checkout', '-b', 'feat/live-branch']);
    const active = await registry.getActiveProject();
    assert.equal(active.branch, 'feat/live-branch');

    await fs.writeFile(registryPath, '{ not valid json', 'utf8');
    await assert.rejects(() => registry.listProjects(), { code: 'INVALID_REGISTRY_FILE' });
  });
});
