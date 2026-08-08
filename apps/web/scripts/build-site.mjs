import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 배포용 정적 번들을 만든다. 사이트 조립은 assemble-site.mjs 한 곳에서만 맡아
// Vercel과 GitHub Pages가 같은 파일 구성을 사용하게 한다.
//
// 데이터 출처는 둘 중 하나다.
//   BUS_DATA_DIR         이미 받아 둔 수집 데이터 경로 (로컬 확인용)
//   BUS_DATA_REPO_TOKEN  비공개 저장소를 클론한다 (Vercel 빌드)
//
// 라이브 예측 로그(`--predictions`)는 여기서 만들지 않는다. 비공개 저장소에 커밋을 남기는
// 작업이라 빌드의 부수 효과가 되면 안 된다. GitHub Actions가 계속 담당한다.

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..', '..', '..');
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
  // 토큰이 URL에도 argv에도 남지 않게 git 설정을 환경변수로 넘긴다. URL에 넣으면
  // 에러 메시지와 원격 설정에, -c 인자로 넣으면 프로세스 목록과 실패 로그에 남는다.
  const gitAuthEnvironment = {
    ...process.env,
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.extraheader',
    GIT_CONFIG_VALUE_0: `Authorization: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
  };
  run('git', ['clone', '--quiet', '--depth', '1', `https://${dataRepository}`, checkout], { env: gitAuthEnvironment });

  // 당일 수집 브랜치가 있으면 그쪽이 최신이다. 없으면 main(아카이브)만으로도 빌드된다.
  // 브랜치 부재(정상 폴백)와 네트워크나 권한 장애는 구분한다. 장애까지 폴백으로 삼키면
  // 낡은 데이터로 배포가 조용히 성공한다.
  const todayBranch = `collect/${seoulDate()}`;
  const probe = spawnSync(
    'git',
    ['ls-remote', '--exit-code', '--heads', 'origin', todayBranch],
    { cwd: checkout, env: gitAuthEnvironment, stdio: ['ignore', 'ignore', 'inherit'] },
  );
  if (probe.status === 0) {
    run('git', ['fetch', '--quiet', '--depth', '1', 'origin', todayBranch], { cwd: checkout, env: gitAuthEnvironment });
    run('git', ['checkout', '--quiet', 'FETCH_HEAD'], { cwd: checkout });
    console.log(`데이터: ${todayBranch}`);
  } else if (probe.status === 2) {
    console.log('데이터: main (당일 수집 브랜치 없음)');
  } else {
    throw new Error(`데이터 저장소 조회 실패 (ls-remote 종료 ${probe.status ?? '신호 종료'}). 낡은 데이터로 배포하지 않는다.`);
  }
  return path.join(checkout, 'data');
}

const dataDirectory = resolveDataDirectory();

console.log('\n[1/3] 타입스크립트 빌드');
run('npm', ['run', 'build']);

console.log('\n[2/3] 데이터 번들 생성');
run('node', ['dist/apps/web/scripts/build-data.js', `--data-dir=${dataDirectory}`]);

console.log('\n[3/3] 정적 번들 조립');
run('node', ['apps/web/scripts/assemble-site.mjs']);
