import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FORBIDDEN_RILEY_ALLOW_RULES,
  REQUIRED_RILEY_DENY_RULES,
  checkGlossary,
  checkRileyPolicy,
  checkShellScript,
  runChecks,
} from '../../src/guardrails/check.js';

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'guardrails-test-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('guardrails: glossary avoided-term check', () => {
  it('flags avoided terms from GLOSSARY.md in src/ and web/ while avoiding substring false positives and excluding dependencies/generated dirs', () => {
    withTempDir((dir) => {
      writeFileSync(
        join(dir, 'GLOSSARY.md'),
        '# Glossary\n\n**Office Manager**:\nRiley\n_Avoid_: bot, workspace\n'
      );
      mkdirSync(join(dir, 'src'), { recursive: true });
      mkdirSync(join(dir, 'web', 'public', 'vendor'), { recursive: true });
      mkdirSync(join(dir, 'node_modules', 'pkg'), { recursive: true });
      mkdirSync(join(dir, 'dist'), { recursive: true });

      // Substring false-positive checks: "robotics" and "workspaces" should NOT trigger "bot" or "workspace"
      writeFileSync(
        join(dir, 'src', 'clean.js'),
        'export const robotics = true;\nexport const workspaces = [];\n'
      );
      // Ignored directories should not be scanned even if they contain avoided terms
      writeFileSync(join(dir, 'node_modules', 'pkg', 'index.js'), 'const bot = 1;\n');
      writeFileSync(join(dir, 'web', 'public', 'vendor', 'lib.js'), 'const workspace = 1;\n');
      writeFileSync(join(dir, 'dist', 'bundle.js'), 'const bot = 1;\n');

      let result = checkGlossary(dir);
      assert.equal(result.ok, true);
      assert.deepEqual(result.violations, []);

      // Real violation in src/
      writeFileSync(join(dir, 'src', 'bad.js'), 'const bot = "riley";\n');
      result = checkGlossary(dir);
      assert.equal(result.ok, false);
      assert.equal(result.violations.length, 1);
      assert.equal(result.violations[0].file, 'src/bad.js');
      assert.equal(result.violations[0].term, 'bot');
    });
  });
});

describe('guardrails: Riley policy check', () => {
  it('passes for valid read-only settings and fails when agent or deny/allow rules are weakened', () => {
    withTempDir((dir) => {
      const settingsPath = join(dir, 'settings.json');
      const valid = {
        agent: 'riley',
        permissions: {
          allow: ['Read', 'Glob', 'Grep', 'Bash(git -C * branch --show-current)'],
          deny: [...REQUIRED_RILEY_DENY_RULES],
        },
      };
      writeFileSync(settingsPath, JSON.stringify(valid));
      assert.equal(checkRileyPolicy(settingsPath).ok, true);

      // Weaken config: remove Write from deny and add a forbidden allow rule
      const weakened = structuredClone(valid);
      weakened.permissions.deny = weakened.permissions.deny.filter((r) => r !== 'Write');
      weakened.permissions.allow.push(FORBIDDEN_RILEY_ALLOW_RULES.at(-1));
      writeFileSync(settingsPath, JSON.stringify(weakened));

      const res = checkRileyPolicy(settingsPath);
      assert.equal(res.ok, false);
      assert.ok(res.errors.some((e) => e.includes('Write')));
      assert.ok(res.errors.some((e) => e.includes('branch*')));
    });
  });
});

describe('guardrails: shell check seam', () => {
  it('uses shellcheck when available, reports bash -n fallback locally, and fails in CI when shellcheck is missing', () => {
    const calls = [];
    const okRunner = (cmd, args) => {
      calls.push([cmd, ...args]);
      return { status: 0, stdout: '', stderr: '' };
    };

    const withShellcheck = checkShellScript('office.sh', {
      commandExists: () => true,
      runCommand: okRunner,
      requireShellcheck: true,
    });
    assert.equal(withShellcheck.ok, true);
    assert.equal(withShellcheck.mode, 'shellcheck');
    assert.deepEqual(calls[0], ['shellcheck', 'office.sh']);

    const localFallback = checkShellScript('office.sh', {
      commandExists: () => false,
      runCommand: okRunner,
      requireShellcheck: false,
    });
    assert.equal(localFallback.ok, true);
    assert.equal(localFallback.mode, 'bash-n-fallback');
    assert.match(localFallback.note, /fallback/i);

    const ciMissing = checkShellScript('office.sh', {
      commandExists: () => false,
      runCommand: okRunner,
      requireShellcheck: true,
    });
    assert.equal(ciMissing.ok, false);
    assert.match(ciMissing.note, /shellcheck.*required/i);
  });
});

describe('guardrails: runner failure propagation', () => {
  it('runs all checks and propagates failures without masking subsequent or earlier failures', () => {
    withTempDir((dir) => {
      writeFileSync(join(dir, 'GLOSSARY.md'), '# Glossary\n');
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(join(dir, 'src', 'ok.js'), 'export const x = 1;\n');
      mkdirSync(join(dir, '.claude'), { recursive: true });
      writeFileSync(join(dir, '.claude', 'settings.json'), JSON.stringify({ agent: 'wrong', permissions: { deny: [] } }));
      writeFileSync(join(dir, 'office.sh'), '#!/usr/bin/env bash\necho ok\n');

      const executed = [];
      const result = runChecks({
        rootDir: dir,
        requireShellcheck: false,
        commandExists: () => false,
        runCommand: (cmd, args) => {
          executed.push(`${cmd} ${args.join(' ')}`);
          if (cmd === 'npm' && args[0] === 'test') {
            return { status: 1, stdout: '', stderr: 'test failed' };
          }
          return { status: 0, stdout: '', stderr: '' };
        },
        log: () => {},
      });

      assert.equal(result.ok, false);
      const testStep = result.steps.find((s) => s.name === 'tests');
      const policyStep = result.steps.find((s) => s.name === 'riley-policy');
      assert.equal(testStep.ok, false);
      assert.equal(policyStep.ok, false);
      assert.ok(executed.some((c) => c.startsWith('npm test')));
    });
  });
});
