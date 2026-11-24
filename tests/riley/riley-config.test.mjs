import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');
const SETTINGS_PATH = resolve(REPO_ROOT, '.claude', 'settings.json');

describe('Riley Workspace Settings (.claude/settings.json)', () => {
  it('configures riley as the default interactive agent', () => {
    assert.equal(existsSync(SETTINGS_PATH), true, '.claude/settings.json must exist');
    const settings = JSON.parse(readFileSync(SETTINGS_PATH, 'utf8'));
    assert.equal(settings.agent, 'riley');
  });

  it('enforces non-bypassable read-only tool permissions via permissions.deny', () => {
    const settings = JSON.parse(readFileSync(SETTINGS_PATH, 'utf8'));
    assert.ok(settings.permissions, 'permissions object must exist');
    assert.ok(Array.isArray(settings.permissions.deny), 'permissions.deny must be an array');

    const requiredDenies = [
      'Write',
      'Edit',
      'MultiEdit',
      'NotebookEdit',
      'Agent',
      'Task',
      'Bash(rm *)',
      'Bash(mv *)',
      'Bash(cp *)',
      'Bash(mkdir *)',
      'Bash(touch *)',
      'Bash(git add*)',
      'Bash(git commit*)',
      'Bash(git push*)',
      'Bash(git * branch -d*)',
      'Bash(git * branch -D*)',
      'Bash(git * stash*)',
      'Bash(python*)',
      'Bash(node*)',
      'Bash(bash*)',
      'Bash(sh*)',
      'Bash(curl*)',
      'Bash(wget*)',
      'Bash(* > *)',
      'Bash(* >> *)',
    ];

    for (const rule of requiredDenies) {
      assert.ok(
        settings.permissions.deny.includes(rule),
        `permissions.deny must include "${rule}"`
      );
    }

    const allowList = settings.permissions.allow ?? [];
    assert.equal(allowList.includes('Bash(git -C * branch*)'), false, 'permissions.allow must not include broad git branch*');
    assert.ok(allowList.includes('Bash(git -C * branch --show-current)'));
    assert.ok(allowList.includes('Bash(git -C * branch --list*)'));
    for (const forbidden of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Agent', 'Task']) {
      assert.equal(
        allowList.includes(forbidden),
        false,
        `permissions.allow must not include "${forbidden}"`
      );
    }
  });
});
