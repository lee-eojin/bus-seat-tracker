import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..');
const skippedDirectories = new Set(['.git', 'dist', 'node_modules', 'site', '_workspace']);

function markdownFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && skippedDirectories.has(entry.name)) continue;
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...markdownFiles(entryPath));
    if (entry.isFile() && entry.name.endsWith('.md')) files.push(entryPath);
  }
  return files;
}

function localTarget(rawTarget) {
  const withoutTitle = rawTarget.trim().replace(/^<|>$/g, '').split(/\s+["']/)[0];
  if (!withoutTitle || withoutTitle.startsWith('#')) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(withoutTitle)) return null;
  return decodeURIComponent(withoutTitle.split('#')[0]);
}

const brokenLinks = [];
const linkPattern = /\[[^\]]*\]\(([^)]+)\)/g;

for (const filePath of markdownFiles(projectRoot)) {
  const text = readFileSync(filePath, 'utf8');
  for (const match of text.matchAll(linkPattern)) {
    const target = localTarget(match[1]);
    if (!target) continue;
    const resolved = path.resolve(path.dirname(filePath), target);
    if (!existsSync(resolved)) {
      const line = text.slice(0, match.index).split('\n').length;
      brokenLinks.push(`${path.relative(projectRoot, filePath)}:${line} → ${target}`);
      continue;
    }
    if (target.endsWith('/') && !statSync(resolved).isDirectory()) {
      const line = text.slice(0, match.index).split('\n').length;
      brokenLinks.push(`${path.relative(projectRoot, filePath)}:${line} → ${target} (디렉터리가 아님)`);
    }
  }
}

if (brokenLinks.length > 0) {
  console.error('깨진 로컬 문서 링크:');
  for (const link of brokenLinks) console.error(`- ${link}`);
  process.exitCode = 1;
} else {
  console.log('로컬 문서 링크 확인 완료');
}
