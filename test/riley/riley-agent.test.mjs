import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');
const RILEY_AGENT_PATH = resolve(REPO_ROOT, '.claude', 'agents', 'riley.md');

function parseAgentMarkdown(raw) {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  assert.ok(match, '.claude/agents/riley.md must contain YAML frontmatter delimited by ---');
  const [, frontmatterRaw, body] = match;
  const frontmatter = {};
  for (const line of frontmatterRaw.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const val = line.slice(colonIdx + 1).trim();
    frontmatter[key] = val;
  }
  return { frontmatter, body };
}

describe('Riley Agent Definition (.claude/agents/riley.md)', () => {
  it('defines valid frontmatter with read-only tools and disallowed write/edit tools', () => {
    assert.equal(existsSync(RILEY_AGENT_PATH), true, '.claude/agents/riley.md must exist');
    const { frontmatter, body } = parseAgentMarkdown(readFileSync(RILEY_AGENT_PATH, 'utf8'));

    assert.equal(frontmatter.name, 'riley');
    assert.ok(frontmatter.description && frontmatter.description.length > 10, 'description must be non-empty');

    const tools = frontmatter.tools.split(',').map((t) => t.trim());
    assert.deepEqual(tools.sort(), ['Bash', 'Glob', 'Grep', 'Read']);

    const disallowed = frontmatter.disallowedTools.split(',').map((t) => t.trim());
    for (const forbidden of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Agent', 'Task']) {
      assert.ok(disallowed.includes(forbidden), `disallowedTools must include ${forbidden}`);
    }

    assert.match(body, /Riley/);
    assert.match(body, /Office Manager/);
    assert.match(body, /\/home\/blur\/virtual/);
    assert.match(body, /never.*cd|working directory fixed/i);
  });

  it('requires dynamic ask-matt consultation, active project lookup, and missing-skill recovery', () => {
    const { body } = parseAgentMarkdown(readFileSync(RILEY_AGENT_PATH, 'utf8'));

    assert.match(body, /\.agents\/skills\/ask-matt\/SKILL\.md/);
    assert.match(body, /\.office\/projects\.json/);
    assert.match(body, /before every/i);
    assert.match(body, /missing|inaccessible|not found/i);
    assert.match(body, /do not guess|never guess|do not invent/i);
  });

  it('enforces the 4-part template, context hygiene, language matching, and casual conversation handling', () => {
    const { body } = parseAgentMarkdown(readFileSync(RILEY_AGENT_PATH, 'utf8'));

    assert.match(body, /Current Stage/);
    assert.match(body, /Recommended Skill & Category/);
    assert.match(body, /Copy-Paste Command/);
    assert.match(body, /Context Hygiene Guidance/);

    assert.match(body, /smart zone/i);
    assert.match(body, /\/clear/);
    assert.match(body, /\/compact/);

    assert.match(body, /language/i);
    assert.match(body, /English/i);

    assert.match(body, /casual|greeting|meta-question/i);
    assert.match(body, /without forcing|without using the 4-part template/i);
  });
});
