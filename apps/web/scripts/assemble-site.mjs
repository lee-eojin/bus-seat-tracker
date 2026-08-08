import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..', '..', '..');
const publicDirectory = path.join(projectRoot, 'apps', 'web', 'public');
const siteDirectory = path.join(projectRoot, 'site');
const webOutputDirectory = path.join(projectRoot, 'dist', 'apps', 'web', 'src');
const domainOutputDirectory = path.join(projectRoot, 'dist', 'packages', 'domain', 'src');

function requirePath(target, description) {
  if (!existsSync(target)) throw new Error(`${description}이 없습니다: ${target}`);
}

for (const fileName of ['index.html', 'legal.html']) {
  requirePath(path.join(publicDirectory, fileName), `웹 공개 파일 ${fileName}`);
}
for (const fileName of ['latest.js', 'daily.js', 'history.js', 'profile.js']) {
  requirePath(path.join(publicDirectory, 'data', fileName), `화면 데이터 ${fileName}`);
}
requirePath(path.join(webOutputDirectory, 'app.js'), '웹 실행 파일 app.js');
requirePath(domainOutputDirectory, '도메인 모듈 출력 디렉터리');

rmSync(siteDirectory, { recursive: true, force: true });
cpSync(publicDirectory, siteDirectory, { recursive: true });

const siteWebDirectory = path.join(siteDirectory, 'dist', 'apps', 'web', 'src');
mkdirSync(siteWebDirectory, { recursive: true });
cpSync(path.join(webOutputDirectory, 'app.js'), path.join(siteWebDirectory, 'app.js'));

const siteDomainDirectory = path.join(siteDirectory, 'dist', 'packages', 'domain', 'src');
mkdirSync(siteDomainDirectory, { recursive: true });
for (const fileName of readdirSync(domainOutputDirectory).filter((name) => name.endsWith('.js') && !name.endsWith('.test.js'))) {
  cpSync(path.join(domainOutputDirectory, fileName), path.join(siteDomainDirectory, fileName));
}

const legacyDirectory = path.join(siteDirectory, 'prototype-bus');
mkdirSync(legacyDirectory, { recursive: true });
writeFileSync(
  path.join(legacyDirectory, 'index.html'),
  '<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0; url=../"><title>이동 중</title>',
);
writeFileSync(
  path.join(legacyDirectory, 'legal.html'),
  '<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0; url=../legal.html"><title>이동 중</title>',
);

console.log(`완료: ${siteDirectory}`);
