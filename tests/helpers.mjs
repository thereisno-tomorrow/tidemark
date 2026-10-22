import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGit } from '../lib/git.mjs';
import { currentPlatform } from '../lib/paths.mjs';
import { validateRepository } from '../lib/validators.mjs';

export const templateRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function makeFixture({ setup, template = templateRoot } = {}) {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'agent-config-test-'));
  const repo = path.join(tempRoot, 'repo');
  const state = path.join(tempRoot, 'state');
  const userHome = path.join(tempRoot, 'home');
  const projectsRoot = path.join(tempRoot, 'projects');
  await cp(template, repo, {
    recursive: true,
    // .claude/ holds local session state, including one full worktree per session,
    // and a nested checkout belongs to another repository; neither is fixture content.
    filter: (source) => {
      const relative = path.relative(template, source).replaceAll('\\', '/');
      return !relative.startsWith('.git')
        && !relative.startsWith('.claude')
        && !relative.startsWith('dist')
        && !relative.startsWith('tests')
        && !relative.startsWith('skills')
        && !relative.startsWith('agents')
        && !relative.startsWith('migration')
        && !relative.startsWith('hooks/scripts')
        && (relative === '' || !existsSync(path.join(source, '.git')));
    },
  });
  const manifestPath = path.join(repo, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.artifacts = manifest.artifacts.filter((artifact) => ['bootstrap.agent-config-maintainer', 'instructions.global'].includes(artifact.id));
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  await mkdir(state, { recursive: true });
  await mkdir(userHome, { recursive: true });
  await mkdir(projectsRoot, { recursive: true });
  // Neutral provider-control fixtures used by adapter tests.
  await mkdir(path.join(repo, 'hooks'), { recursive: true });
  await writeFile(path.join(repo, 'hooks', 'mappings.json'), JSON.stringify({ providers: { claude: {} } }) + '\n');
  await writeFile(path.join(repo, 'providers', 'claude', 'provider-only-skills.json'), JSON.stringify({ skills: [] }) + '\n');
  await writeFile(path.join(repo, 'README.md'), '# agent-config fixture\n');
  if (setup) await setup({ tempRoot, repo, state, userHome, projectsRoot });
  const validation = await validateRepository(repo, { writeLock: true });
  if (!validation.ok) throw new Error(`fixture validation failed: ${validation.issues.join('; ')}`);
  runGit(repo, ['init', '--initial-branch=main']);
  runGit(repo, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@local.invalid', 'add', '--all']);
  runGit(repo, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@local.invalid', 'commit', '-m', 'fixture']);
  const roots = {
    USER_HOME: userHome,
    PROJECTS_ROOT: projectsRoot,
    AGENT_CONFIG_ROOT: repo,
    AGENT_CONFIG_STATE_ROOT: state,
    PLATFORM: currentPlatform(),
  };
  return {
    tempRoot, repo, state, userHome, projectsRoot, roots,
    async cleanup() { await rm(tempRoot, { recursive: true, force: true, maxRetries: 3 }); },
  };
}

export async function addSkill(repo, name, { scripts = false } = {}) {
  const root = path.join(repo, 'skills', name);
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, 'SKILL.md'), `---\nname: ${name}\ndescription: Fixture skill for release-engine tests.\n---\n\n# ${name}\n\nOriginal body.\n`, 'utf8');
  if (scripts) {
    await mkdir(path.join(root, 'scripts'));
    await writeFile(path.join(root, 'scripts', 'run.mjs'), 'console.log("fixture");\n', 'utf8');
  }
}
