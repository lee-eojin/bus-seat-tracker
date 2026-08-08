// 일별 수집 브랜치를 main으로 옮길 때와 그날 브랜치를 준비할 때의 판단 규칙.
// .github/workflows/collect-bus-seats.yml의 인라인 스크립트가 이 모듈을 부른다.
//
// 판단을 워크플로 밖에 두는 이유는 2026-08-07 사고 때문이다. 아카이브가 main을 갱신한
// 직후 브랜치 준비 스텝이 main을 다시 읽었는데 복제 지연으로 갱신 전 sha를 받았고,
// 그 위에 만들어진 collect/2026-08-07이 하루 종일 92커밋을 쌓은 뒤 자정에 갈라짐으로
// 판정돼 수집이 19시간 멈췄다. 규칙이 YAML 안에 있으면 이런 경계는 시험할 수 없다.

/** compareCommits(base=main, head=브랜치)가 돌려주는 네 가지 상태 */
export type ComparisonStatus = 'ahead' | 'behind' | 'identical' | 'diverged';

export interface ArchivePlan {
  /**
   * main에 올릴 트리를 어떻게 만들지.
   * branch는 브랜치 트리를 그대로, union은 main 트리 위에 브랜치 파일을 덮어서,
   * none은 올릴 것이 없다는 뜻이다.
   */
  tree: 'branch' | 'union' | 'none';
  deleteBranch: boolean;
  warning: string | null;
}

export interface CollectionBranchPlan {
  deleteFirst: boolean;
  create: boolean;
  warning: string | null;
}

const branchPrefix = 'collect/';
const dailyBranchPattern = /^collect\/\d{4}-\d{2}-\d{2}$/;

/** 오늘보다 이전 날짜의 수집 브랜치를 날짜 오름차순으로 고른다. */
export function finishedCollectionBranches(branches: readonly string[], today: string): string[] {
  return branches
    .filter((branch) => dailyBranchPattern.test(branch) && branch.slice(branchPrefix.length) < today)
    .sort();
}

/**
 * 끝난 날의 브랜치를 어떻게 아카이브할지 정한다.
 *
 * 갈라진 브랜치를 예전에는 오류로 던졌는데, 그러면 아카이브가 수집보다 앞에 있는 탓에
 * 그날부터 수집이 통째로 멈춘다. 대신 합집합으로 합친다. 이 저장소의 데이터 파일은
 * 날짜별로 추가만 되고 지워지지 않으므로, main에만 있는 파일과 브랜치에만 있는 파일을
 * 모두 남기는 것이 언제나 정답이다.
 */
export function planArchive(branch: string, status: ComparisonStatus): ArchivePlan {
  switch (status) {
    case 'ahead':
      return { tree: 'branch', deleteBranch: true, warning: null };
    case 'identical':
      return { tree: 'none', deleteBranch: true, warning: null };
    case 'behind':
      // 브랜치 커밋이 전부 main 조상이다. 새 데이터가 없으니 지우기만 한다.
      return {
        tree: 'none',
        deleteBranch: true,
        warning: `${branch}에 새 데이터가 없습니다. 브랜치만 정리합니다.`,
      };
    case 'diverged':
      return {
        tree: 'union',
        deleteBranch: true,
        warning: `${branch}가 main에서 갈라졌습니다. 양쪽 파일을 합쳐 아카이브합니다.`,
      };
  }
}

/**
 * 오늘 브랜치를 어떤 상태로 만들지 정한다. status가 null이면 브랜치가 아직 없다는 뜻이다.
 *
 * behind는 커밋이 쌓이기 전의 갈라짐이다. 브랜치가 낡은 main 위에 만들어졌지만 아직
 * 고유 커밋이 없는 상태라, 지우고 다시 만들면 잃는 것 없이 제자리로 돌아온다.
 * 이 자리에서 잡지 못하면 하루치가 쌓인 뒤 diverged가 되고, 그때는 아카이브의 합집합에
 * 기대야 한다.
 */
export function planCollectionBranch(status: ComparisonStatus | null): CollectionBranchPlan {
  if (status === null) return { deleteFirst: false, create: true, warning: null };
  switch (status) {
    case 'ahead':
    case 'identical':
      return { deleteFirst: false, create: false, warning: null };
    case 'behind':
      return {
        deleteFirst: true,
        create: true,
        warning: '오늘 브랜치가 낡은 main 위에 있어 다시 만듭니다. 쌓인 데이터는 없습니다.',
      };
    case 'diverged':
      // 이미 커밋이 쌓였다. 지우면 그 데이터를 잃으므로 수집을 계속하고, 아카이브가 합친다.
      return {
        deleteFirst: false,
        create: false,
        warning: '오늘 브랜치가 main에서 갈라졌습니다. 수집은 계속하고 아카이브에서 합칩니다.',
      };
  }
}
