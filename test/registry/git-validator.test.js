import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { validateGitRepoRoot, getCurrentBranch } from '../../src/registry/git-validator.js';

const execFileAsync = promisify(execFile);

async function initTempGitRepo(dir, branch = 'main') {
  await execFileAsync('git', ['init', '-b', branch, dir]);
  await execFileAsync('git', ['-C', dir, 'config', 'user.email', 'test@example.com']);
  await execFileAsync('git', ['-C', dir, 'config', 'user.name', 'Test User']);
  await fs.writeFile(path.join(dir, 'README.md'), '# test\n');
  await execFileAsync('git', ['-C', dir, 'add', 'README.md']);
  await execFileAsync('git', ['-C', dir, 'commit', '-m', 'init']);
}

describe('git-validator', () => {
  let tmpDir;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-office-git-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('validates a top-level git repository root and returns its realpath', async () => {
    const repoDir = path.join(tmpDir, 'repo');
    await fs.mkdir(repoDir);
    await initTempGitRepo(repoDir);

    const result = await validateGitRepoRoot(repoDir);
    assert.equal(result.path, await fs.realpath(repoDir));
  });

  it('rejects a non-existent directory', async () => {
    await assert.rejects(
      () => validateGitRepoRoot(path.join(tmpDir, 'missing')),
      { code: 'INVALID_PATH' }
    );
  });

  it('rejects a regular file', async () => {
    const filePath = path.join(tmpDir, 'file.txt');
    await fs.writeFile(filePath, 'hello');

    await assert.rejects(
      () => validateGitRepoRoot(filePath),
      { code: 'NOT_A_DIRECTORY' }
    );
  });

  it('rejects a directory that is not a git repository', async () => {
    const plainDir = path.join(tmpDir, 'plain');
    await fs.mkdir(plainDir);

    await assert.rejects(
      () => validateGitRepoRoot(plainDir),
      { code: 'NOT_A_GIT_REPO' }
    );
  });

  it('rejects a subdirectory inside a git repository (must be top-level root)', async () => {
    const repoDir = path.join(tmpDir, 'repo');
    const subDir = path.join(repoDir, 'packages', 'app');
    await fs.mkdir(subDir, { recursive: true });
    await initTempGitRepo(repoDir);

    await assert.rejects(
      () => validateGitRepoRoot(subDir),
      { code: 'NOT_GIT_ROOT' }
    );
  });

  it('resolves the current branch dynamically and returns null on detached HEAD', async () => {
    const repoDir = path.join(tmpDir, 'repo');
    await fs.mkdir(repoDir);
    await initTempGitRepo(repoDir, 'main');

    assert.equal(await getCurrentBranch(repoDir), 'main');

    await execFileAsync('git', ['-C', repoDir, 'checkout', '-b', 'feat/awesome']);
    assert.equal(await getCurrentBranch(repoDir), 'feat/awesome');

    const { stdout: sha } = await execFileAsync('git', ['-C', repoDir, 'rev-parse', 'HEAD']);
    await execFileAsync('git', ['-C', repoDir, 'checkout', '--detach', sha.trim()]);
    assert.equal(await getCurrentBranch(repoDir), null);
  });
});
