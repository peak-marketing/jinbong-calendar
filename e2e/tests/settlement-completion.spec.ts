import { expect, test, type Page } from '@playwright/test';
import { installFirebaseStub, installPeakosStub } from './helpers';

function sale(id: string, view = 'direct-execution', category = '월보장') {
  return {
    id, view, kind: 'sale', parentId: '', date: '2026-08-01', client: `정산업체-${id}`,
    a: '플레이스', b: '상위노출', c: category, amount: 400_000, qty: 1, period: '', memo: '',
  };
}

async function openFinalExecution(page: Page) {
  const finance = page.locator('[data-nav-cluster="finance"]');
  if ((await finance.getAttribute('class'))?.split(/\s+/).includes('closed')) {
    await finance.locator(':scope > .nav-cluster-toggle').click();
  }
  const tab = finance.locator('[data-view="final-execution-settlement"]');
  await expect(tab).toBeVisible();
  await tab.click();
  await expect(page.locator('#moduleView')).toContainText('최종실행정산서');
}

async function openView(page: Page, view: string) {
  const tab = page.locator(`.app-sidebar .nav-item[data-view="${view}"]`).first();
  const cluster = tab.locator('xpath=ancestor::*[@data-nav-cluster][1]');
  if (await cluster.count() && (await cluster.getAttribute('class'))?.split(/\s+/).includes('closed')) {
    await cluster.locator(':scope > .nav-cluster-toggle').click();
  }
  await expect(tab).toBeVisible();
  await tab.click();
}

async function setup(page: Page, name: string, role: string) {
  await installFirebaseStub(page);
  const store = await installPeakosStub(page, {
    name, role, group_name: '본사 경영지원팀', group_type: 'support',
  });
  return store;
}

test.describe('정산 완료 근거와 동결', () => {
  test('관리자가 명시 근거를 저장한 뒤에만 완료·동결하고, 관리자 사유로 재개한다', async ({ page }) => {
    const store = await setup(page, '패션TV봉이', 'admin');
    store.monthly = { 'direct-execution': [sale('completion-lifecycle')] };

    await page.goto('/business-os-preview.html');
    await expect(page.locator('#authGate')).toBeHidden();
    await openFinalExecution(page);

    const panel = page.locator('[data-settlement-completion-source="completion-lifecycle"]');
    await expect(panel).toHaveAttribute('data-settlement-completion-status', 'OPEN');
    await expect(panel).toContainText('완료 회차 근거가 없습니다');
    await panel.locator('[data-settlement-completion-open]').click();
    let form = page.locator('[data-settlement-completion-modal="completion-lifecycle"]');
    await expect(form.locator('[data-settlement-completion-action="complete"]')).toBeDisabled();
    await form.locator('[name="completedIssueCount"]').fill('8');
    await form.locator('[name="eighthIssueCompletedAt"]').fill('2026-08-16T10:00');
    await form.locator('[name="reason"]').fill('8회차 발행 완료 자료를 직접 확인함');
    await form.locator('[data-settlement-completion-save]').click();

    form = page.locator('[data-settlement-completion-modal="completion-lifecycle"]');
    await expect(form).toContainText('완료 조건을 충족했습니다');
    expect(store.settlementCompletion['completion-lifecycle']).toMatchObject({
      tracked: true, status: 'OPEN', rowVersion: 1,
      evidence: { completedIssueCount: 8 },
    });
    await form.locator('[name="reason"]').fill('8회차 완료 증빙 검토 후 정산 확정');
    await form.locator('[data-settlement-completion-action="complete"]').click();
    await expect(panel).toHaveAttribute('data-settlement-completion-status', 'COMPLETED');

    form = page.locator('[data-settlement-completion-modal="completion-lifecycle"]');
    await form.locator('[name="reason"]').fill('급여 지급 자료 최종 검토 후 동결');
    await form.locator('[data-settlement-completion-action="freeze"]').click();
    await expect(panel).toHaveAttribute('data-settlement-completion-status', 'FROZEN');

    form = page.locator('[data-settlement-completion-modal="completion-lifecycle"]');
    await form.locator('[name="reason"]').fill('원본 정정 요청 확인을 위해 정산 재개');
    await form.locator('[data-settlement-completion-action="reopen"]').click();
    await expect(panel).toHaveAttribute('data-settlement-completion-status', 'OPEN');
    expect(store.settlementCompletion['completion-lifecycle']).toMatchObject({
      tracked: true, status: 'OPEN', rowVersion: 4,
      lifecycle: { reopenedByName: '패션TV봉이' },
    });
    expect(store.settlementCompletionAudit['completion-lifecycle'].map((row: any) => row.action)).toEqual([
      'REOPENED', 'FROZEN', 'COMPLETED', 'EVIDENCE_UPDATED',
    ]);
  });

  for (const account of [
    { name: '손명아', role: 'member' },
    { name: '박종원', role: 'oversight' },
  ]) {
    test(`${account.role} 계정은 상태만 읽고 변경 요청을 보내지 않으며 닫을 때 근거 DOM을 폐기한다`, async ({ page }) => {
      const store = await setup(page, account.name, account.role);
      store.monthly = { 'direct-execution': [sale(`readonly-${account.role}`)] };
      const mutationRequests: string[] = [];
      page.on('request', request => {
        if (request.url().includes('/api/peakos/settlement-completion/') && request.method() !== 'GET') {
          mutationRequests.push(request.method());
        }
      });

      await page.goto('/business-os-preview.html');
      await expect(page.locator('#authGate')).toBeHidden();
      await openFinalExecution(page);
      const panel = page.locator(`[data-settlement-completion-source="readonly-${account.role}"]`);
      await panel.locator('[data-settlement-completion-open]').click();
      const form = page.locator(`[data-settlement-completion-modal="readonly-${account.role}"]`);
      await expect(form).toContainText('기록된 완료 근거');
      await expect(form.locator('input, textarea, [data-settlement-completion-action], [data-settlement-completion-save]')).toHaveCount(0);
      await form.locator('[data-settlement-completion-cancel]').click();
      await expect(page.locator('[data-settlement-completion-modal]')).toHaveCount(0);
      expect(mutationRequests).toHaveLength(0);
    });
  }

  test('오래된 expectedVersion 저장은 최신 서버 상태를 다시 읽고 사용자 입력으로 덮어쓰지 않는다', async ({ page }) => {
    const store = await setup(page, '김대호', 'manager');
    store.monthly = { 'direct-execution': [sale('completion-conflict')] };

    await page.goto('/business-os-preview.html');
    await expect(page.locator('#authGate')).toBeHidden();
    await openFinalExecution(page);
    await page.locator('[data-settlement-completion-source="completion-conflict"] [data-settlement-completion-open]').click();
    store.settlementCompletion['completion-conflict'] = {
      tracked: true, status: 'OPEN', rowVersion: 1,
      evidence: { completedIssueCount: 7, eighthIssueCompletedAt: null },
      evidenceUpdatedByName: '다른 관리자',
    };
    const form = page.locator('[data-settlement-completion-modal="completion-conflict"]');
    await form.locator('[name="completedIssueCount"]').fill('8');
    await form.locator('[name="eighthIssueCompletedAt"]').fill('2026-08-16T10:00');
    await form.locator('[name="reason"]').fill('내 화면의 오래된 완료 근거 저장 시도');
    await form.locator('[data-settlement-completion-save]').click();

    const refreshed = page.locator('[data-settlement-completion-modal="completion-conflict"]');
    await expect(page.locator('.toast')).toContainText('최신 완료 상태를 다시 불러왔습니다');
    await expect(refreshed).toContainText('현재 버전 v1');
    await expect(refreshed.locator('[name="completedIssueCount"]')).toHaveValue('7');
    expect(store.settlementCompletion['completion-conflict'].rowVersion).toBe(1);
    expect(store.settlementCompletion['completion-conflict'].evidence.completedIssueCount).toBe(7);
  });

  test('완료된 원본 수정 409는 서버 원본을 다시 읽고 재개 안내를 표시한다', async ({ page }) => {
    const store = await setup(page, '김대호', 'manager');
    store.monthly = { 'direct-execution': [sale('completion-source-lock')] };
    store.settlementCompletion['completion-source-lock'] = {
      tracked: true, status: 'COMPLETED', rowVersion: 2,
      evidence: { completedIssueCount: 8, eighthIssueCompletedAt: '2026-08-16T01:00:00.000Z' },
    };

    await page.goto('/business-os-preview.html');
    await expect(page.locator('#authGate')).toBeHidden();
    await openView(page, 'direct-execution');
    await page.locator('[data-monthly-edit="completion-source-lock"]').click();
    await page.locator('[data-monthly="client"]').fill('잠금 원본 덮어쓰기 시도');
    await page.locator('[data-monthly-add]').click();

    await expect(page.locator('.toast')).toContainText('정산을 재개한 뒤 수정');
    await expect(page.locator('#moduleView')).toContainText('정산업체-completion-source-lock');
    await expect(page.locator('#moduleView')).not.toContainText('잠금 원본 덮어쓰기 시도');
    expect(store.monthly['direct-execution'][0].client).toBe('정산업체-completion-source-lock');
    expect(store.monthly['direct-execution'][0].rowVersion).toBe(1);
  });

  test('여러 원본 상태 조회는 동시에 최대 4개만 실행한다', async ({ page }) => {
    const store = await setup(page, '김대호', 'manager');
    store.monthly = {
      'direct-execution': Array.from({ length: 10 }, (_, index) => sale(`bounded-${index + 1}`)),
    };
    store.settlementCompletionDelayMs = 40;

    await page.goto('/business-os-preview.html');
    await expect(page.locator('#authGate')).toBeHidden();
    await openFinalExecution(page);
    await expect(page.locator('[data-settlement-completion-status="OPEN"]')).toHaveCount(10);
    expect(store.settlementCompletionMaxActive).toBeGreaterThan(1);
    expect(store.settlementCompletionMaxActive).toBeLessThanOrEqual(4);
  });
});
