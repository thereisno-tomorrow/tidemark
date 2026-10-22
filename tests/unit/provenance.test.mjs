import assert from 'node:assert/strict';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { runGit } from '../../lib/git.mjs';
import { checkProvenance } from '../../lib/provenance.mjs';
import { validateRepository } from '../../lib/validators.mjs';
import { addSkill, makeFixture } from '../helpers.mjs';

// Every line here is real damage from the 2026-08-01 import, recovered from the
// preserved pre-import bytes. If the detector stops catching one of them, an import
// defect of exactly that shape ships again.
const IMPORT_DAMAGE = [
  'for candidate in opsexampleguide skill.md exampleguide.md notesexampleguide skill.md; do',
  '"$vaultguide skill.md"',
  'no opsguide skill.md',
  '.claude/commandsexampleguide skill.md',
  'savecapture skill/file research',
  'remind the user to run capture skill-learnings',
  '~/.claude/skillssample skill/SKILL.md',
  'https://example.invalidsample skill.html',
];

// Prose that legitimately contains the word. A gate that fires on these is a gate
// that gets disabled.
const LEGITIMATE_PROSE = [
  'https://example.invalid/sample.html',
  'Pair it with a writing skill such as example-writing-skill.',
  'Do not use this skill.',
  'Reversible any time this session with the `sample` skill.',
  'remind the user to ask the example-tutor skill to capture learnings',
  'Treat it as a personal skill.',
  'a skill-based approach',
];

test('the glued-skill detector catches import damage and leaves prose alone', async () => {
  const fixture = await makeFixture();
  try {
    await addSkill(fixture.repo, 'probe');
    const skillFile = path.join(fixture.repo, 'skills', 'probe', 'SKILL.md');
    const header = '---\nname: probe\ndescription: Fixture skill for detector tests.\n---\n\n';

    for (const line of IMPORT_DAMAGE) {
      await writeFile(skillFile, `${header}${line}\n`, 'utf8');
      const result = await validateRepository(fixture.repo);
      assert.ok(
        result.findings.some((finding) => finding.rule === 'glued-skill-reference'),
        `import damage not detected: ${line}`,
      );
    }

    for (const line of LEGITIMATE_PROSE) {
      await writeFile(skillFile, `${header}${line}\n`, 'utf8');
      const result = await validateRepository(fixture.repo);
      assert.ok(
        !result.findings.some((finding) => finding.rule === 'glued-skill-reference'),
        `false positive on legitimate prose: ${line}`,
      );
    }
  } finally { await fixture.cleanup(); }
});

test('a placeholder description fails validation', async () => {
  const fixture = await makeFixture();
  try {
    await addSkill(fixture.repo, 'probe');
    const skillFile = path.join(fixture.repo, 'skills', 'probe', 'SKILL.md');
    const manifestPath = path.join(fixture.repo, 'manifest.json');
    const manifest = JSON.parse(await import('node:fs/promises').then((fs) => fs.readFile(manifestPath, 'utf8')));
    manifest.artifacts.push({
      id: 'skills.probe', kind: 'skill', ownership: 'shared-link', risk: 'content-auto',
      source: ['skills/probe'], providers: ['claude'], platforms: ['windows', 'macos'],
      targets: { claude: '${USER_HOME}/.claude/skills/probe' }, validators: ['skill'],
    });
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

    // The exact stub the import left on `example-explainer`, which no validator caught.
    await writeFile(skillFile, '---\nname: probe\ndescription: Run the former example-explainer command as a portable skill.\n---\n\nBody.\n', 'utf8');
    const bad = await validateRepository(fixture.repo);
    assert.ok(bad.issues.some((issue) => issue.includes('placeholder description')), 'placeholder description was accepted');

    await writeFile(skillFile, '---\nname: probe\ndescription: Use when the caller needs a fixture skill for validation tests.\n---\n\nBody.\n', 'utf8');
    const good = await validateRepository(fixture.repo);
    assert.ok(!good.issues.some((issue) => issue.includes('placeholder description')), `real description rejected: ${good.issues.join('; ')}`);
  } finally { await fixture.cleanup(); }
});

test('source validation scans what Git would commit, not nested session worktrees', async () => {
  const fixture = await makeFixture();
  try {
    const machinePath = 'C:\\Users\\fixture\\Projects\\notes.md';
    const reported = (result) => result.findings.some((finding) => finding.path === 'notes.md' && finding.rule === 'absolute-machine-path');

    // Claude Code desktop adds one linked worktree per session here and hides the
    // directory through .git/info/exclude, so Git reports the checkout clean.
    await mkdir(path.join(fixture.repo, '.git', 'info'), { recursive: true });
    await appendFile(path.join(fixture.repo, '.git', 'info', 'exclude'), '.claude/worktrees/\n', 'utf8');
    const sessionWorktree = path.join(fixture.repo, '.claude', 'worktrees', 'brave-turing-a1b2c3');
    runGit(fixture.repo, ['worktree', 'add', '--detach', sessionWorktree, 'HEAD']);
    await writeFile(path.join(sessionWorktree, 'notes.md'), `${machinePath}\n`, 'utf8');
    // A nested checkout that nobody excluded is still another repository's files.
    const nestedCheckout = path.join(fixture.repo, 'nested-checkout');
    runGit(fixture.repo, ['worktree', 'add', '--detach', nestedCheckout, 'HEAD']);
    await writeFile(path.join(nestedCheckout, 'notes.md'), `${machinePath}\n`, 'utf8');
    assert.deepEqual((await validateRepository(fixture.repo)).issues, []);

    // The same bytes in the checkout itself still fail, whether new or committed.
    await writeFile(path.join(fixture.repo, 'notes.md'), `${machinePath}\n`, 'utf8');
    assert.ok(reported(await validateRepository(fixture.repo)), 'untracked machine path was not reported');
    runGit(fixture.repo, ['add', 'notes.md']);
    runGit(fixture.repo, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@local.invalid', 'commit', '-m', 'machine path']);
    assert.ok(reported(await validateRepository(fixture.repo)), 'tracked machine path was not reported');
  } finally { await fixture.cleanup(); }
});

test('provenance reports a missing baseline instead of passing quietly', async () => {
  const fixture = await makeFixture();
  try {
    await mkdir(path.join(fixture.repo, 'automation'), { recursive: true });
    await writeFile(path.join(fixture.repo, 'automation', 'provenance-baseline.json'), `${JSON.stringify({
      schemaVersion: 1,
      baselines: [{ id: 'absent', root: '${AGENT_CONFIG_STATE_ROOT}/external-backups/does-not-exist', retention: 'permanent' }],
      mappings: [],
    }, null, 2)}\n`, 'utf8');
    const result = await checkProvenance({ root: fixture.repo, stateRoot: fixture.state, roots: fixture.roots });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'baseline-missing');
  } finally { await fixture.cleanup(); }
});

test('provenance flags a content change and ignores line endings', async () => {
  const fixture = await makeFixture();
  try {
    const baseline = path.join(fixture.state, 'external-backups', 'probe');
    await mkdir(path.join(baseline, 'data', '0007', 'kept'), { recursive: true });
    await mkdir(path.join(baseline, 'data', '0007', 'changed'), { recursive: true });
    // Baseline holds CRLF; the repo normalises to LF. That difference must not report.
    await writeFile(path.join(baseline, 'data', '0007', 'kept', 'SKILL.md'), '---\r\nname: kept\r\n---\r\n\r\nSame body.\r\n', 'utf8');
    await writeFile(path.join(baseline, 'data', '0007', 'changed', 'SKILL.md'), '---\nname: changed\n---\n\nOriginal body.\n', 'utf8');

    await addSkill(fixture.repo, 'kept');
    await addSkill(fixture.repo, 'changed');
    await writeFile(path.join(fixture.repo, 'skills', 'kept', 'SKILL.md'), '---\nname: kept\n---\n\nSame body.\n', 'utf8');
    await writeFile(path.join(fixture.repo, 'skills', 'changed', 'SKILL.md'), '---\nname: changed\n---\n\nRewritten body.\n', 'utf8');

    await writeFile(path.join(fixture.repo, 'automation', 'provenance-baseline.json'), `${JSON.stringify({
      schemaVersion: 1,
      baselines: [{ id: 'probe', root: '${AGENT_CONFIG_STATE_ROOT}/external-backups/probe', retention: 'permanent' }],
      mappings: [{ dataPath: 'data/0007', origin: '~/.claude/skills', canonical: 'skills', shape: 'skill-tree' }],
    }, null, 2)}\n`, 'utf8');

    const result = await checkProvenance({ root: fixture.repo, stateRoot: fixture.state, roots: fixture.roots });
    assert.equal(result.compared, 2);
    assert.equal(result.differences.length, 1);
    assert.equal(result.differences[0].canonical, 'skills/changed/SKILL.md');
    // The CRLF-only file is counted separately, never as a content difference.
    assert.equal(result.lineEndingOnly, 1);
    assert.ok(!result.differences.some((entry) => entry.canonical.includes('kept')), 'CRLF-only difference was reported as a content change');
    assert.equal(result.identical, 0, 'byte-identical count excludes the CRLF-only file');
  } finally { await fixture.cleanup(); }
});
