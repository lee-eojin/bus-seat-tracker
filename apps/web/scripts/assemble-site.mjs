import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..', '..', '..');
const publicDirectory = path.join(projectRoot, 'apps', 'web', 'public');
const siteDirectory = path.join(projectRoot, 'site');
const webOutputDirectory = path.join(projectRoot, 'dist', 'apps', 'web', 'src');
const webApiOutputDirectory = path.join(webOutputDirectory, 'api');
const domainOutputDirectory = path.join(projectRoot, 'dist', 'packages', 'domain', 'src');

function requirePath(target, description) {
  if (!existsSync(target)) throw new Error(`${description}이 없습니다: ${target}`);
}

// 브라우저 코드는 번들링하지 않는다. import가 가리키는 모듈을 같은 상대 경로에 그대로
// 둬야 화면이 뜬다. 시험 파일은 브라우저가 안 부르므로 뺀다.
function copyModules(from, to) {
  mkdirSync(to, { recursive: true });
  const isRunnable = (name) => name.endsWith('.js') && !name.endsWith('.test.js') && !name.endsWith('.typeTest.js');
  for (const fileName of readdirSync(from).filter(isRunnable)) {
    cpSync(path.join(from, fileName), path.join(to, fileName));
  }
}

for (const fileName of ['index.html', 'legal.html']) {
  requirePath(path.join(publicDirectory, fileName), `웹 공개 파일 ${fileName}`);
}
for (const fileName of ['latest.js', 'daily.js', 'history.js', 'profile.js']) {
  requirePath(path.join(publicDirectory, 'data', fileName), `화면 데이터 ${fileName}`);
}
requirePath(path.join(webOutputDirectory, 'app.js'), '웹 실행 파일 app.js');
requirePath(webApiOutputDirectory, '웹 요청 계층 출력 디렉터리');
requirePath(domainOutputDirectory, '도메인 모듈 출력 디렉터리');

rmSync(siteDirectory, { recursive: true, force: true });
cpSync(publicDirectory, siteDirectory, { recursive: true });

const siteWebDirectory = path.join(siteDirectory, 'dist', 'apps', 'web', 'src');
mkdirSync(siteWebDirectory, { recursive: true });
cpSync(path.join(webOutputDirectory, 'app.js'), path.join(siteWebDirectory, 'app.js'));

copyModules(webApiOutputDirectory, path.join(siteWebDirectory, 'api'));
copyModules(domainOutputDirectory, path.join(siteDirectory, 'dist', 'packages', 'domain', 'src'));

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
