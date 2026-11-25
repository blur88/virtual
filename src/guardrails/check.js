import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, relative } from 'node:path';

const IGNORED_DIRS = new Set([
  'node_modules',
  'vendor',
  '.git',
  '.office',
  '.scratch',
  'dist',
  'build',
  'coverage',
]);

const GLOSSARY_SCAN_ROOTS = ['src', 'web'];
const GLOSSARY_EXTENSIONS = new Set(['.js', '.mjs', '.html', '.css']);
const JS_SYNTAX_ROOTS = ['src', 'web', 'test', 'scripts'];

export const REQUIRED_RILEY_DENY_RULES = [
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

export const FORBIDDEN_RILEY_ALLOW_RULES = [
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'Agent',
  'Task',
  'Bash(git -C * branch*)',
];

function defaultRunCommand(cmd, args, cwd) {
  return spawnSync(cmd, args, { cwd, encoding: 'utf8' });
}

function defaultCommandExists(cmd) {
  const res = spawnSync('which', [cmd], { encoding: 'utf8' });
  return res.status === 0;
}

function walkFiles(baseDir, roots, extensions) {
  const results = [];
  for (const root of roots) {
    const start = join(baseDir, root);
    if (!existsSync(start)) continue;
    const stack = [start];
    while (stack.length > 0) {
      const current = stack.pop();
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        const fullPath = join(current, entry.name);
        if (entry.isDirectory()) {
          stack.push(fullPath);
        } else if (entry.isFile()) {
          const dotIdx = entry.name.lastIndexOf('.');
          const ext = dotIdx === -1 ? '' : entry.name.slice(dotIdx);
          if (extensions.has(ext)) {
            results.push(fullPath);
          }
        }
      }
    }
  }
  return results.sort();
}

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Extracts avoided terms from `_Avoid_: ...` lines in GLOSSARY.md.
 */
export function parseGlossaryAvoidedTerms(glossaryContent) {
  const terms = [];
  for (const line of glossaryContent.split('\n')) {
    const match = line.match(/^_Avoid_:\s*(.+)$/);
    if (!match) continue;
    for (const raw of match[1].split(',')) {
      const term = raw.trim();
      if (term) terms.push(term);
    }
  }
  return terms;
}

/**
 * Scans src/ and web/ files for avoided terms from GLOSSARY.md using word boundaries.
 */
export function checkGlossary(rootDir) {
  const glossaryPath = join(rootDir, 'GLOSSARY.md');
  if (!existsSync(glossaryPath)) {
    return { ok: false, violations: [{ file: 'GLOSSARY.md', line: 0, term: 'missing GLOSSARY.md' }] };
  }

  const terms = parseGlossaryAvoidedTerms(readFileSync(glossaryPath, 'utf8'));
  const matchers = terms.map((term) => ({
    term,
    regex: new RegExp(`\\b${escapeRegExp(term)}\\b`, 'i'),
  }));

  const violations = [];
  const files = walkFiles(rootDir, GLOSSARY_SCAN_ROOTS, GLOSSARY_EXTENSIONS);
  for (const filePath of files) {
    const relPath = relative(rootDir, filePath).replace(/\\/g, '/');
    const lines = readFileSync(filePath, 'utf8').split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      for (const { term, regex } of matchers) {
        if (regex.test(lines[i])) {
          violations.push({ file: relPath, line: i + 1, term });
        }
      }
    }
  }

  return { ok: violations.length === 0, violations };
}

/**
 * Validates Riley's read-only configuration in .claude/settings.json.
 */
export function checkRileyPolicy(settingsPath) {
  if (!existsSync(settingsPath)) {
    return { ok: false, errors: ['.claude/settings.json does not exist'] };
  }

  let settings;
  try {
    settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
  } catch (err) {
    return { ok: false, errors: [`Invalid JSON in settings: ${err.message}`] };
  }

  const errors = [];
  if (settings.agent !== 'riley') {
    errors.push(`Expected settings.agent to be "riley", got ${JSON.stringify(settings.agent)}`);
  }

  const deny = settings.permissions?.deny;
  if (!Array.isArray(deny)) {
    errors.push('permissions.deny must be an array');
  } else {
    for (const rule of REQUIRED_RILEY_DENY_RULES) {
      if (!deny.includes(rule)) {
        errors.push(`permissions.deny missing required rule: "${rule}"`);
      }
    }
  }

  const allow = settings.permissions?.allow ?? [];
  if (Array.isArray(allow)) {
    for (const forbidden of FORBIDDEN_RILEY_ALLOW_RULES) {
      if (allow.includes(forbidden)) {
        errors.push(`permissions.allow must not include forbidden rule: "${forbidden}"`);
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Runs `node --check` on all JS/MJS files under src/, web/, test/, and scripts/.
 */
export function checkJsSyntax(rootDir, { runCommand = defaultRunCommand } = {}) {
  const files = walkFiles(rootDir, JS_SYNTAX_ROOTS, new Set(['.js', '.mjs']));
  const failures = [];
  for (const filePath of files) {
    const res = runCommand(process.execPath, ['--check', filePath], rootDir);
    if (res.status !== 0) {
      failures.push({
        file: relative(rootDir, filePath).replace(/\\/g, '/'),
        stderr: (res.stderr || res.stdout || '').trim(),
      });
    }
  }
  return { ok: failures.length === 0, checkedCount: files.length, failures };
}

/**
 * Checks a shell script using shellcheck when available, or bash -n as a local fallback.
 */
export function checkShellScript(
  scriptPath,
  {
    commandExists = defaultCommandExists,
    runCommand = defaultRunCommand,
    requireShellcheck = false,
    cwd = process.cwd(),
  } = {}
) {
  if (commandExists('shellcheck')) {
    const res = runCommand('shellcheck', [scriptPath], cwd);
    return {
      ok: res.status === 0,
      mode: 'shellcheck',
      note: res.status === 0 ? 'shellcheck passed' : (res.stderr || res.stdout || 'shellcheck failed').trim(),
    };
  }

  if (requireShellcheck) {
    return {
      ok: false,
      mode: 'missing-shellcheck',
      note: 'shellcheck is required in CI but was not found on PATH',
    };
  }

  const res = runCommand('bash', ['-n', scriptPath], cwd);
  return {
    ok: res.status === 0,
    mode: 'bash-n-fallback',
    note:
      res.status === 0
        ? 'local fallback: bash -n passed (shellcheck not installed)'
        : `local fallback: bash -n failed: ${(res.stderr || res.stdout || '').trim()}`,
  };
}

export function isCiEnv(env = process.env) {
  return env.CI === 'true' || env.CI === '1';
}

/**
 * Runs all automated guardrails in sequence without masking any failure.
 */
export function runChecks({
  rootDir = process.cwd(),
  requireShellcheck = isCiEnv(),
  runCommand = defaultRunCommand,
  commandExists = defaultCommandExists,
  log = console.log,
} = {}) {
  const steps = [];

  const testRes = runCommand('npm', ['test'], rootDir);
  steps.push({
    name: 'tests',
    ok: testRes.status === 0,
    detail: testRes.status === 0 ? 'npm test passed' : (testRes.stderr || testRes.stdout || 'npm test failed').trim(),
  });

  const syntaxRes = checkJsSyntax(rootDir, { runCommand });
  steps.push({
    name: 'js-syntax',
    ok: syntaxRes.ok,
    detail: syntaxRes.ok
      ? `node --check passed (${syntaxRes.checkedCount} files)`
      : syntaxRes.failures.map((f) => `${f.file}: ${f.stderr}`).join('; '),
  });

  const shellRes = checkShellScript(join(rootDir, 'office.sh'), {
    commandExists,
    runCommand,
    requireShellcheck,
    cwd: rootDir,
  });
  steps.push({
    name: 'shell',
    ok: shellRes.ok,
    detail: shellRes.note,
  });

  const glossaryRes = checkGlossary(rootDir);
  steps.push({
    name: 'glossary',
    ok: glossaryRes.ok,
    detail: glossaryRes.ok
      ? 'GLOSSARY.md avoided-term check passed'
      : glossaryRes.violations.map((v) => `${v.file}:${v.line} avoided term "${v.term}"`).join('; '),
  });

  const policyRes = checkRileyPolicy(join(rootDir, '.claude', 'settings.json'));
  steps.push({
    name: 'riley-policy',
    ok: policyRes.ok,
    detail: policyRes.ok ? 'Riley read-only policy check passed' : policyRes.errors.join('; '),
  });

  for (const step of steps) {
    const marker = step.ok ? 'PASS' : 'FAIL';
    log(`[${marker}] ${step.name}: ${step.detail}`);
  }

  return {
    ok: steps.every((s) => s.ok),
    steps,
  };
}
