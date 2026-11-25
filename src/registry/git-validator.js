import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { RegistryError } from './errors.js';

const execFileAsync = promisify(execFile);

/**
 * Validates that `dirPath` exists, is a directory, and is a top-level Git repository root.
 *
 * @param {string} dirPath
 * @returns {Promise<{ path: string }>} Normalized realpath of the repository root.
 */
export async function validateGitRepoRoot(dirPath) {
  if (typeof dirPath !== 'string' || dirPath.trim() === '') {
    throw new RegistryError('INVALID_PATH', 'Project path must be a non-empty string.');
  }

  const resolvedPath = path.resolve(dirPath.trim());

  let stats;
  try {
    stats = await fs.stat(resolvedPath);
  } catch {
    throw new RegistryError('INVALID_PATH', `Directory does not exist: ${resolvedPath}`);
  }

  if (!stats.isDirectory()) {
    throw new RegistryError('NOT_A_DIRECTORY', `Path is not a directory: ${resolvedPath}`);
  }

  const realPath = await fs.realpath(resolvedPath);

  let topLevelRaw;
  try {
    const { stdout } = await execFileAsync('git', [
      '-C',
      realPath,
      'rev-parse',
      '--show-toplevel',
    ]);
    topLevelRaw = stdout.trim();
  } catch {
    throw new RegistryError(
      'NOT_A_GIT_REPO',
      `Directory is not a Git repository: ${realPath}`
    );
  }

  const topLevelRealPath = await fs.realpath(topLevelRaw);
  if (topLevelRealPath !== realPath) {
    throw new RegistryError(
      'NOT_GIT_ROOT',
      `Path is inside a Git repository (${topLevelRealPath}) but is not its top-level root: ${realPath}`
    );
  }

  return { path: realPath };
}

/**
 * Dynamically resolves the current Git branch for a repository path.
 * Returns `null` on detached HEAD or if the branch cannot be determined.
 *
 * @param {string} repoPath
 * @returns {Promise<string | null>}
 */
export async function getCurrentBranch(repoPath) {
  try {
    const { stdout } = await execFileAsync('git', [
      '-C',
      repoPath,
      'branch',
      '--show-current',
    ]);
    const branch = stdout.trim();
    return branch.length > 0 ? branch : null;
  } catch {
    return null;
  }
}
