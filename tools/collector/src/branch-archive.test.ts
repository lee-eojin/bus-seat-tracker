import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  finishedCollectionBranches,
  planArchive,
  planCollectionBranch,
} from './branch-archive.js';

describe('끝난 수집 브랜치 고르기', () => {
  it('오늘보다 이전 날짜만 고른다', () => {
    const branches = ['collect/2026-08-06', 'collect/2026-08-07', 'collect/2026-08-08'];
    assert.deepEqual(finishedCollectionBranches(branches, '2026-08-08'), [
      'collect/2026-08-06',
      'collect/2026-08-07',
    ]);
  });

  it('날짜 오름차순으로 돌려준다', () => {
    const branches = ['collect/2026-08-07', 'collect/2026-08-05', 'collect/2026-08-06'];
    assert.deepEqual(finishedCollectionBranches(branches, '2026-08-08'), [
      'collect/2026-08-05',
      'collect/2026-08-06',
      'collect/2026-08-07',
    ]);
  });

  it('오늘 브랜치는 고르지 않는다', () => {
    assert.deepEqual(finishedCollectionBranches(['collect/2026-08-08'], '2026-08-08'), []);
  });

  it('날짜 형식이 아닌 브랜치는 무시한다', () => {
    const branches = ['collect/backup', 'collect/2026-08-07-retry', 'archive/2026-08-07'];
    assert.deepEqual(finishedCollectionBranches(branches, '2026-08-08'), []);
  });
});

describe('아카이브 판단', () => {
  it('브랜치가 앞서면 브랜치 트리를 그대로 올린다', () => {
    const plan = planArchive('collect/2026-08-07', 'ahead');
    assert.equal(plan.tree, 'branch');
    assert.equal(plan.deleteBranch, true);
    assert.equal(plan.warning, null);
  });

  it('내용이 같으면 아무것도 올리지 않고 브랜치만 지운다', () => {
    const plan = planArchive('collect/2026-08-07', 'identical');
    assert.equal(plan.tree, 'none');
    assert.equal(plan.deleteBranch, true);
  });

  it('브랜치가 뒤처졌으면 새 데이터가 없으므로 지우기만 한다', () => {
    const plan = planArchive('collect/2026-08-07', 'behind');
    assert.equal(plan.tree, 'none');
    assert.equal(plan.deleteBranch, true);
    assert.match(plan.warning ?? '', /새 데이터가 없/);
  });

  it('갈라졌으면 던지지 않고 합집합으로 합친다', () => {
    const plan = planArchive('collect/2026-08-07', 'diverged');
    assert.equal(plan.tree, 'union');
    assert.equal(plan.deleteBranch, true);
    assert.match(plan.warning ?? '', /갈라졌/);
  });

  it('어떤 상태에서도 브랜치를 남겨 두지 않는다', () => {
    for (const status of ['ahead', 'behind', 'identical', 'diverged'] as const) {
      assert.equal(planArchive('collect/2026-08-07', status).deleteBranch, true, status);
    }
  });
});

describe('오늘 브랜치 준비 판단', () => {
  it('브랜치가 없으면 만든다', () => {
    assert.deepEqual(planCollectionBranch(null), { deleteFirst: false, create: true, warning: null });
  });

  it('이미 앞서 있으면 건드리지 않는다', () => {
    assert.deepEqual(planCollectionBranch('ahead'), { deleteFirst: false, create: false, warning: null });
  });

  it('main과 같으면 건드리지 않는다', () => {
    assert.deepEqual(planCollectionBranch('identical'), { deleteFirst: false, create: false, warning: null });
  });

  it('낡은 main 위에 있고 쌓인 커밋이 없으면 다시 만든다', () => {
    const plan = planCollectionBranch('behind');
    assert.equal(plan.deleteFirst, true);
    assert.equal(plan.create, true);
  });

  it('이미 갈라졌으면 지우지 않는다. 지우면 쌓인 데이터를 잃는다', () => {
    const plan = planCollectionBranch('diverged');
    assert.equal(plan.deleteFirst, false);
    assert.equal(plan.create, false);
    assert.match(plan.warning ?? '', /갈라졌/);
  });
});
