import { access, mkdir, readdir, readlink, rm, lstat, symlink } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import process from 'node:process';

const root = process.cwd();
const canonicalSkillsDir = join(root, '.claude', 'skills');
const skillMirrors = [
  join(root, '.agent', 'skills'),
  join(root, '.agents', 'skills'),
  join(root, '.codex', 'skills'),
];

async function ensureSymlink(linkPath, targetPath) {
  await mkdir(dirname(linkPath), { recursive: true });

  try {
    const stats = await lstat(linkPath);
    if (!stats.isSymbolicLink()) {
      await rm(linkPath, { recursive: true, force: true });
    } else {
      const currentTarget = await readlink(linkPath);
      if (currentTarget === targetPath) {
        return;
      }
      await rm(linkPath, { recursive: true, force: true });
    }
  } catch (error) {
    if (error && error.code !== 'ENOENT') {
      throw error;
    }
  }

  await symlink(targetPath, linkPath);
}

async function main() {
  const relativeCanonicalDir = relative(root, canonicalSkillsDir);

  for (const mirrorPath of skillMirrors) {
    const mirrorDir = dirname(mirrorPath);
    const target = relative(mirrorDir, canonicalSkillsDir);
    await ensureSymlink(mirrorPath, target);
  }

  const entries = await readdir(canonicalSkillsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const skillDir = join(canonicalSkillsDir, entry.name);
    try {
      await access(join(skillDir, 'SKILL.md'));
    } catch {
      continue;
    }
    const agentLink = join(skillDir, 'AGENTS.md');
    await ensureSymlink(agentLink, 'SKILL.md');
  }

  process.stdout.write(`Bootstrapped skill symlinks from ${relativeCanonicalDir}\n`);
}

await main();
