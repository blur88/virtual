import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { RegistryError } from './errors.js';
import { validateGitRepoRoot, getCurrentBranch } from './git-validator.js';

const DEFAULT_REGISTRY_PATH = path.resolve(process.cwd(), '.office', 'projects.json');

/**
 * Validates and normalizes a project display name.
 * @param {unknown} name
 * @returns {string}
 */
function validateProjectName(name) {
  if (typeof name !== 'string' || name.trim() === '') {
    throw new RegistryError('INVALID_NAME', 'Project name must be a non-empty string.');
  }
  return name.trim();
}

/**
 * Atomically writes JSON data to `filePath` via a sibling temp file + rename.
 * @param {string} filePath
 * @param {object} data
 */
async function writeJsonAtomic(filePath, data) {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tempPath = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID().slice(0, 8)}.tmp`
  );
  await fs.writeFile(tempPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  await fs.rename(tempPath, filePath);
}

/**
 * Attaches dynamic Git branch state to a persisted project entry.
 * @param {object} project
 */
async function enrichWithBranch(project) {
  const branch = await getCurrentBranch(project.path);
  return { ...project, branch };
}

/**
 * Creates a Project Settings Registry instance backed by a local JSON file.
 *
 * @param {{ registryPath?: string }} [options]
 */
export function createProjectRegistry(options = {}) {
  const registryPath = path.resolve(options.registryPath || DEFAULT_REGISTRY_PATH);
  let writeQueue = Promise.resolve();

  function enqueueWrite(task) {
    const next = writeQueue.then(task, task);
    writeQueue = next.catch(() => {});
    return next;
  }

  async function readState() {
    let raw;
    try {
      raw = await fs.readFile(registryPath, 'utf8');
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        return { activeProjectId: null, projects: [] };
      }
      throw err;
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new RegistryError(
        'INVALID_REGISTRY_FILE',
        `Project registry file contains invalid JSON: ${registryPath}`
      );
    }

    if (!parsed || !Array.isArray(parsed.projects)) {
      throw new RegistryError(
        'INVALID_REGISTRY_FILE',
        `Project registry file has invalid schema: ${registryPath}`
      );
    }

    return {
      activeProjectId: parsed.activeProjectId ?? null,
      projects: parsed.projects,
    };
  }

  return {
    registryPath,

    /**
     * Lists all registered Target Projects with dynamically resolved Git branches.
     */
    async listProjects() {
      const state = await readState();
      const projects = await Promise.all(state.projects.map(enrichWithBranch));
      return {
        activeProjectId: state.activeProjectId,
        projects,
      };
    },

    /**
     * Returns the currently Active Project with its dynamically resolved Git branch, or null.
     */
    async getActiveProject() {
      const state = await readState();
      if (!state.activeProjectId) {
        return null;
      }
      const active = state.projects.find((p) => p.id === state.activeProjectId);
      return active ? enrichWithBranch(active) : null;
    },

    /**
     * Registers a new Target Project after validating its Git root and path uniqueness.
     * @param {{ name: string, path: string }} input
     */
    async addProject({ name, path: inputPath }) {
      const cleanName = validateProjectName(name);
      const { path: validPath } = await validateGitRepoRoot(inputPath);

      return enqueueWrite(async () => {
        const state = await readState();

        const duplicate = state.projects.find((p) => p.path === validPath);
        if (duplicate) {
          throw new RegistryError(
            'DUPLICATE_PROJECT_PATH',
            `Project path is already registered under "${duplicate.name}": ${validPath}`
          );
        }

        const now = new Date().toISOString();
        const project = {
          id: `proj-${crypto.randomUUID().slice(0, 8)}`,
          name: cleanName,
          path: validPath,
          addedAt: now,
          updatedAt: now,
        };

        const nextState = {
          activeProjectId: state.activeProjectId ?? project.id,
          projects: [...state.projects, project],
        };

        await writeJsonAtomic(registryPath, nextState);
        return enrichWithBranch(project);
      });
    },

    /**
     * Designates a single registered project as the Active Project.
     * @param {string} id
     */
    async selectActiveProject(id) {
      return enqueueWrite(async () => {
        const state = await readState();
        const target = state.projects.find((p) => p.id === id);
        if (!target) {
          throw new RegistryError(
            'PROJECT_NOT_FOUND',
            `Cannot select active project; unknown project id: ${id}`
          );
        }

        const nextState = {
          ...state,
          activeProjectId: id,
        };
        await writeJsonAtomic(registryPath, nextState);
        return {
          activeProjectId: id,
          project: await enrichWithBranch(target),
        };
      });
    },

    /**
     * Edits a registered project's display name and/or path, re-validating Git root and uniqueness.
     * @param {string} id
     * @param {{ name?: string, path?: string }} updates
     */
    async editProject(id, updates = {}) {
      const nextName =
        updates.name !== undefined ? validateProjectName(updates.name) : undefined;
      const nextPathResult =
        updates.path !== undefined ? await validateGitRepoRoot(updates.path) : undefined;

      return enqueueWrite(async () => {
        const state = await readState();
        const index = state.projects.findIndex((p) => p.id === id);
        if (index === -1) {
          throw new RegistryError(
            'PROJECT_NOT_FOUND',
            `Cannot edit project; unknown project id: ${id}`
          );
        }

        const existing = state.projects[index];
        const nextPath = nextPathResult ? nextPathResult.path : existing.path;

        if (nextPath !== existing.path) {
          const duplicate = state.projects.find((p) => p.id !== id && p.path === nextPath);
          if (duplicate) {
            throw new RegistryError(
              'DUPLICATE_PROJECT_PATH',
              `Project path is already registered under "${duplicate.name}": ${nextPath}`
            );
          }
        }

        const updated = {
          ...existing,
          name: nextName ?? existing.name,
          path: nextPath,
          updatedAt: new Date().toISOString(),
        };

        const nextProjects = [...state.projects];
        nextProjects[index] = updated;

        await writeJsonAtomic(registryPath, {
          ...state,
          projects: nextProjects,
        });

        return enrichWithBranch(updated);
      });
    },

    /**
     * Non-destructively removes a project entry from the registry without modifying disk files.
     * @param {string} id
     */
    async removeProject(id) {
      return enqueueWrite(async () => {
        const state = await readState();
        const exists = state.projects.some((p) => p.id === id);
        if (!exists) {
          throw new RegistryError(
            'PROJECT_NOT_FOUND',
            `Cannot remove project; unknown project id: ${id}`
          );
        }

        const remaining = state.projects.filter((p) => p.id !== id);
        const nextActiveId =
          state.activeProjectId === id
            ? (remaining[0]?.id ?? null)
            : state.activeProjectId;

        await writeJsonAtomic(registryPath, {
          activeProjectId: nextActiveId,
          projects: remaining,
        });

        return {
          removedId: id,
          activeProjectId: nextActiveId,
        };
      });
    },
  };
}
