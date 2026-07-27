import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 배포용 정적 번들을 만든다. `publish-pages.yml`의 조립 절차를 그대로 옮긴 것이며,
// 산출물이 달라지면 배포본과 기존 Pages 발행본이 갈리므로 순서·경로를 임의로 바꾸지 않는다.
//
// 데이터 출처는 둘 중 하나다.
//   BUS_DATA_DIR         이미 받아 둔 수집 데이터 경로 (로컬 확인용)
//   BUS_DATA_REPO_TOKEN  비공개 저장소를 클론한다 (Vercel 빌드)
//
// 라이브 예측 로그(`--predictions`)는 여기서 만들지 않는다. 그것은 비공개 저장소에 커밋을
// 남기는 작업이라 빌드의 부수 효과가 되면 안 된다 — GitHub Actions가 계속 담당한다.

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..');
const siteDirectory = path.join(projectRoot, 'site');
const dataRepository = 'github.com/lee-eojin/bus-seat-tracker-data.git';

function run(command, args, options = {}) {
  execFileSync(command, args, { cwd: projectRoot, stdio: 'inherit', ...options });
}

function seoulDate() {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

function resolveDataDirectory() {
  const local = process.env.BUS_DATA_DIR;
  if (local) {
    const resolved = path.resolve(local);
    if (!existsSync(path.join(resolved, 'snapshots'))) {
      throw new Error(`BUS_DATA_DIR에 snapshots/가 없습니다: ${resolved}`);
    }
    console.log(`데이터: 로컬 경로 ${resolved}`);
    return resolved;
  }

  const token = process.env.BUS_DATA_REPO_TOKEN;
  if (!token) {
    throw new Error('BUS_DATA_DIR 또는 BUS_DATA_REPO_TOKEN 중 하나가 필요합니다.');
  }

  // 임시 디렉터리에 받는다. 프로젝트 상위(`../bus-data`)는 빌드 컨테이너에서 쓰기 가능하다는
  // 보장이 없고, 로컬에서는 같은 이름의 다른 디렉터리를 지울 위험이 있다.
  const checkout = path.join(mkdtempSync(path.join(os.tmpdir(), 'bus-data-')), 'repo');
  // 토큰이 프로세스 목록·로그에 남지 않도록 URL이 아닌 헤더로 넘긴다.
  const authorization = `Authorization: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
  run('git', ['-c', `http.extraheader=${authorization}`, 'clone', '--quiet', '--depth', '1', `https://${dataRepository}`, checkout]);

  // 당일 수집 브랜치가 있으면 그쪽이 최신이다. 없으면 main(아카이브)만으로도 빌드된다.
  const todayBranch = `collect/${seoulDate()}`;
  try {
    run('git', ['-c', `http.extraheader=${authorization}`, 'fetch', '--quiet', '--depth', '1', 'origin', todayBranch], { cwd: checkout });
    run('git', ['checkout', '--quiet', 'FETCH_HEAD'], { cwd: checkout });
    console.log(`데이터: ${todayBranch}`);
  } catch {
    console.log('데이터: main (당일 수집 브랜치 없음)');
  }
  return path.join(checkout, 'data');
}

const dataDirectory = resolveDataDirectory();

console.log('\n[1/3] 타입스크립트 빌드');
run('npm', ['run', 'build']);

console.log('\n[2/3] 데이터 번들 생성');
run('node', ['dist/prototype-bus/build-data.js', `--data-dir=${dataDirectory}`]);

console.log('\n[3/3] 정적 번들 조립');
rmSync(siteDirectory, { recursive: true, force: true });
mkdirSync(path.join(siteDirectory, 'prototype-bus'), { recursive: true });
mkdirSync(path.join(siteDirectory, 'dist'), { recursive: true });
for (const page of ['index.html', 'legal.html']) {
  cpSync(path.join(projectRoot, 'prototype-bus', page), path.join(siteDirectory, 'prototype-bus', page));
}
cpSync(path.join(projectRoot, 'prototype-bus', 'data'), path.join(siteDirectory, 'prototype-bus', 'data'), { recursive: true });
cpSync(path.join(projectRoot, 'dist', 'prototype-bus'), path.join(siteDirectory, 'dist', 'prototype-bus'), { recursive: true });
cpSync(path.join(projectRoot, 'dist', 'shared'), path.join(siteDirectory, 'dist', 'shared'), { recursive: true });
writeFileSync(path.join(siteDirectory, 'index.html'), '<!doctype html><meta http-equiv="refresh" content="0; url=prototype-bus/" />');

console.log(`\n완료: ${siteDirectory}`);
