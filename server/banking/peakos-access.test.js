'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { ACCESS_NAMES, createPeakosAccess } = require('./peakos-access');

function configuration() {
  return Object.fromEntries(ACCESS_NAMES.map((name, index) => [name, `immutable-uid-${index + 1}`]));
}

function request(uid, name = '표시이름', overrides = {}) {
  return {
    uid,
    userDoc: { name, approved: true, is_active: true, role: 'admin', ...overrides },
  };
}

test('재무운영·매입은 정확한 다섯 UID, 잔액·검토는 기존 네 UID로 분리한다', async () => {
  const configured = configuration();
  const pool = {
    query: async (_sql, values) => ({ rows: values[0].map(uid => ({ uid })) }),
  };
  const access = createPeakosAccess({
    userPool: pool,
    environment: { PEAKOS_ACCESS_UIDS_JSON: JSON.stringify(configured) },
    logger: null,
  });
  await access.load();

  // 공개 세 통장 읽기는 이름·직급과 무관하게 승인된 활성 직원 모두에게 열린다.
  assert.equal(access.canReadBank(request(configured['김진봉'], '다른 표시이름')), true);
  assert.equal(access.canReadBank(request('ordinary-member', '일반 직원', { role: 'member' })), true);
  assert.equal(access.canReadBank(request('ordinary-admin', '패션TV봉이')), true);

  // 잔액·금융 검토는 기존 네 UID로 유지한다.
  assert.equal(access.canViewBankBalances(request(configured['김진봉'])), false);
  for (const name of ['패션TV봉이', '박종원', '김대호', '손명아']) {
    assert.equal(access.canSeeFinanceOperations(request(configured[name], '바뀐 표시이름')), true);
    assert.equal(access.canSeeFinalSettlement(request(configured[name], '바뀐 표시이름')), true);
    assert.equal(access.canViewBankBalances(request(configured[name])), true);
    assert.equal(access.canReviewFinance(request(configured[name], '바뀐 표시이름')), true);
    assert.equal(access.canSeeTaxPurchase(request(configured[name], '바뀐 표시이름')), true);
  }
  // 전현우는 재무운영과 매입만 추가된다. 잔액·금융 검토·최종실행은 넓히지 않는다.
  assert.equal(access.canSeeFinanceOperations(request(configured['전현우'], '바뀐 표시이름')), true);
  assert.equal(access.canSeeFinalSettlement(request(configured['전현우'], '바뀐 표시이름')), true);
  assert.equal(access.canSeeTaxPurchase(request(configured['전현우'], '바뀐 표시이름')), true);
  assert.equal(access.canViewBankBalances(request(configured['전현우'])), false);
  assert.equal(access.canReviewFinance(request(configured['전현우'])), false);
  assert.equal(access.canSeeFinalExecution(request(configured['전현우'])), false);

  for (const name of ['김진봉', '김지홍', '박우진']) {
    assert.equal(access.canSeeFinanceOperations(request(configured[name])), false);
    assert.equal(access.canSeeFinalSettlement(request(configured[name])), false);
    assert.equal(access.canSeeTaxPurchase(request(configured[name])), false);
  }
  // 김진봉의 기존 회사자료 상위 권한은 유지하되 재무 원장은 열지 않는다.
  assert.equal(access.canSeeAll(request(configured['김진봉'])), true);
  assert.equal(access.canViewBankBalances(request('ordinary-admin', '손명아')), false);
  assert.equal(access.canReviewFinance(request('ordinary-admin', '박종원')), false);
  assert.equal(access.canSeeTaxPurchase(request('ordinary-admin', '김대호')), false);
  assert.equal(access.canSeeFinanceOperations(request('ordinary-admin', '전현우')), false);
  assert.equal(access.canSeeFinalSettlement(request('ordinary-admin', '전현우')), false);
  assert.equal(access.canReviewFinance(request(configured['김진봉'], '패션TV봉이')), false);
  assert.equal(access.canSeeTaxPurchase(request(configured['전현우'], '손명아')), true);
  assert.equal(access.canSeeAll(request(configured['김진봉'], '김진봉', { approved: false })), false);
  assert.equal(access.canReadBank(request('ordinary-member', '일반 직원', { approved: false })), false);
  assert.equal(access.canReadBank(request(configured['김진봉'], '김진봉', { is_active: false })), false);
  assert.equal(access.canReviewFinance(request(configured['손명아'], '손명아', { is_active: false })), false);
});

test('개인 전용 정산서는 대표와 상위 권한자를 포함해 소유자 한 명만 보고 수정한다', async () => {
  const configured = configuration();
  const pool = {
    query: async (_sql, values) => ({ rows: values[0].map(uid => ({ uid })) }),
  };
  const access = createPeakosAccess({
    userPool: pool,
    environment: { PEAKOS_ACCESS_UIDS_JSON: JSON.stringify(configured) },
    logger: null,
  });
  await access.load();

  const cases = [
    ['monthly-guarantee', '김지홍'],
    ['monthly-manage', '박우진'],
    ['direct-execution', '김대호'],
  ];
  for (const [view, owner] of cases) {
    const ownerRequest = request(configured[owner], '바뀐 표시이름');
    assert.equal(access.canSeeMonthly(ownerRequest, view), true);
    assert.equal(access.canManageMonthly(ownerRequest, view), true);
    for (const [, otherOwner] of cases.filter(([otherView]) => otherView !== view)) {
      assert.equal(access.canSeeMonthly(request(configured[otherOwner]), view), false);
      assert.equal(access.canManageMonthly(request(configured[otherOwner]), view), false);
    }
  }

  for (const privilegedName of ['김진봉', '패션TV봉이', '손명아', '박종원', '전현우']) {
    for (const [view] of cases) {
      const privileged = request(configured[privilegedName]);
      assert.equal(access.canSeeMonthly(privileged, view), false);
      assert.equal(access.canManageMonthly(privileged, view), false);
    }
  }
  assert.equal(access.canSeeMonthly(request('ordinary-admin', '김대호'), 'direct-execution'), false);
  assert.equal(access.canManageMonthly(request('ordinary-admin', '김대호'), 'direct-execution'), false);
  assert.equal(access.canSeeMonthly(request(configured['김대호'], '김대호', { approved: false }), 'direct-execution'), false);
  assert.equal(access.canManageMonthly(request(configured['김대호']), 'unknown-view'), false);
});

test('최종실행정산서는 지정된 네 UID만 읽고 개인 정산서 수정 권한은 넓히지 않는다', async () => {
  const configured = configuration();
  const pool = {
    query: async (_sql, values) => ({ rows: values[0].map(uid => ({ uid })) }),
  };
  const access = createPeakosAccess({
    userPool: pool,
    environment: { PEAKOS_ACCESS_UIDS_JSON: JSON.stringify(configured) },
    logger: null,
  });
  await access.load();

  for (const name of ['패션TV봉이', '박종원', '김대호', '손명아']) {
    assert.equal(access.canSeeFinalExecution(request(configured[name], '바뀐 표시이름')), true);
  }
  for (const name of ['김진봉', '전현우', '김지홍', '박우진']) {
    assert.equal(access.canSeeFinalExecution(request(configured[name])), false);
  }
  assert.equal(access.canSeeFinalExecution(request('ordinary-admin', '패션TV봉이')), false);
  assert.equal(access.canSeeFinalExecution(request(configured['박종원'], '박종원', { approved: false })), false);
  assert.equal(access.canManageMonthly(request(configured['박종원']), 'monthly-manage'), false);
  assert.equal(access.canManageMonthly(request(configured['손명아']), 'direct-execution'), false);
});

test('계정 미리보기 owner 조회는 패션TV봉이·박종원·김대호 UID만 허용한다', async () => {
  const configured = configuration();
  const pool = {
    query: async (_sql, values) => ({ rows: values[0].map(uid => ({ uid })) }),
  };
  const access = createPeakosAccess({
    userPool: pool,
    environment: { PEAKOS_ACCESS_UIDS_JSON: JSON.stringify(configured) },
    logger: null,
  });
  await access.load();

  assert.equal(access.canPreviewAccounts(request(configured['패션TV봉이'], '바뀐 표시이름')), true);
  assert.equal(access.canReadOwnerUid(request(configured['패션TV봉이']), configured['손명아']), true);
  for (const name of ['박종원', '김대호']) {
    assert.equal(access.canPreviewAccounts(request(configured[name], '바뀐 표시이름')), true);
    assert.equal(access.canReadOwnerUid(request(configured[name]), 'target-kimyongil-uid'), true);
    assert.equal(access.canReadOwnerUid(request(configured[name]), configured['손명아']), false);
  }
  for (const name of ['손명아', '전현우', '김진봉']) {
    assert.equal(access.canPreviewAccounts(request(configured[name], '패션TV봉이')), false);
  }
  assert.equal(access.canReadOwnerUid(request(configured['김진봉']), 'target-kimyongil-uid'), false);
  assert.equal(access.canReadOwnerUid(request('ordinary-admin', '패션TV봉이'), 'target-kimyongil-uid'), false);
  assert.equal(access.canPreviewAccounts(request('ordinary-admin', '김대호')), false);
  assert.equal(access.canReadOwnerUid(request(configured['박종원'], '박종원', { is_active: false }), 'target-kimyongil-uid'), false);
  assert.equal(access.canPreviewAccounts(request(configured['박종원'], '박종원', { approved: false })), false);
});

test('누락·추가·중복 UID 설정과 비활성 대상은 시작 전에 fail closed한다', async () => {
  const configured = configuration();
  const pool = { query: async (_sql, values) => ({ rows: values[0].map(uid => ({ uid })) }) };
  for (const invalid of [
    Object.fromEntries(Object.entries(configured).slice(1)),
    { ...configured, 알수없는사람: 'immutable-extra-uid' },
    { ...configured, 손명아: configured['김대호'] },
  ]) {
    const access = createPeakosAccess({
      userPool: pool,
      environment: { PEAKOS_ACCESS_UIDS_JSON: JSON.stringify(invalid) },
      logger: null,
    });
    await assert.rejects(access.load());
  }

  const incompletePool = { query: async () => ({ rows: [{ uid: configured['김진봉'] }] }) };
  const access = createPeakosAccess({
    userPool: incompletePool,
    environment: { PEAKOS_ACCESS_UIDS_JSON: JSON.stringify(configured) },
    logger: null,
  });
  await assert.rejects(access.load(), /미승인·비활성·삭제/);
});
