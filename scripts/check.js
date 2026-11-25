import { isCiEnv, runChecks } from '../src/guardrails/check.js';

const requireShellcheck = process.argv.includes('--require-shellcheck') || isCiEnv();

const result = runChecks({
  rootDir: process.cwd(),
  requireShellcheck,
});

if (!result.ok) {
  process.exit(1);
}
