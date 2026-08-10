import { expect, test, type Page } from '@playwright/test';
import { installFirebaseStub, installPeakosStub } from './helpers';

const allowedViewers = ['패션TV봉이', '박종원', '김대호', '손명아'];

function sale(id: string, date: string, client: string, amount: number) {
  return {
    id, kind: 'sale', parentId: '', date, client,
    a: '플레이스', b: '상위노출', c: '월보장', amount, qty: 1, period: '', memo: '',
  };
}

function run(id: string, parentId: string, date: string, amount: number, qty: number) {
  return {
    id, kind: 'run', parentId, date, client: '',
    a: '블로그', b: '원고', c: '프리미엄원고대필', amount, qty, period: '', memo: '실행비',
  };
}

function guaranteeWithPriorSaleRuns() {
  return [
    sale('guarantee-current-sale', '2026-08-01', '월보장현재매출', 4_330_000),
    run('guarantee-linked-run', 'guarantee-current-sale', '2026-08-02', 40_000, 1),
    ...Array.from({ length: 9 }, (_, index) => ({
      ...run(
        `guarantee-orphan-${index + 1}`,
        `prior-sale-${index + 1}`,
        `2026-${String(6 + Math.floor(index / 3)).padStart(2, '0')}-${String(10 + index).padStart(2, '0')}`,
        index === 8 ? 80_000 : 40_000,
        1,
      ),
      client: `이전매출업체${index + 1}`,
    })),
  ];
}

async function openFinalExecution(page: Page) {
  const finance = page.locator('[data-nav-cluster="finance"]');
  if ((await finance.getAttribute('class'))?.includes('closed')) {
    await finance.locator('.nav-cluster-toggle').click();
  }
  const tab = page.locator('.nav-item[data-view="final-execution-settlement"]');
  await expect(tab).toBeVisible();
  await tab.click();
  await expect(page.locator('#moduleView')).toContainText('최종실행정산서');
}

async function openNavView(page: Page, view: string) {
  const tab = page.locator(`.app-sidebar .nav-item[data-view="${view}"]`).first();
  const cluster = tab.locator('xpath=ancestor::*[@data-nav-cluster][1]');
  if (await cluster.count() && (await cluster.getAttribute('class'))?.split(/\s+/).includes('closed')) {
    await cluster.locator(':scope > .nav-cluster-toggle').click();
  }
  const subcluster = tab.locator('xpath=ancestor::*[@data-nav-subcluster][1]');
  if (await subcluster.count() && (await subcluster.getAttribute('class'))?.split(/\s+/).includes('closed')) {
    await subcluster.locator(':scope > .nav-subcluster-toggle').click();
  }
  await expect(tab).toBeVisible();
  await tab.click();
}

test.describe('최종실행정산서', () => {
  test('기존 매출·실행·이관 이전 연결 실행을 versioned PATCH로 수정하고 원본 lineage를 보존한다', async ({ page }) => {
    await installFirebaseStub(page);
    const store = await installPeakosStub(page, {
      name: '김대호', role: 'manager', group_name: '본사 경영지원팀', group_type: 'support',
    });
    store.monthly = {
      'direct-execution': [
        { ...sale('edit-sale', '2026-08-01', '수정전매출', 400_000), sourceLineage: { row: 10 } },
        { ...run('edit-run', 'edit-sale', '2026-08-02', 40_000, 1), client: '수정전매출', sourceLineage: { row: 11 } },
        { ...run('edit-orphan', 'prior-sale', '2026-08-03', 30_000, 1), client: '이관이전업체', sourceLineage: { row: 12 } },
      ],
    };
    const patchBodies: any[] = [];
    page.on('request', request => {
      if (request.method() === 'PATCH' && request.url().includes('/api/peakos/monthly/direct-execution')) {
        patchBodies.push(request.postDataJSON());
      }
    });
    await page.goto('/business-os-preview.html');
    await expect(page.locator('#authGate')).toBeHidden();
    await openNavView(page, 'direct-execution');

    await page.locator('[data-monthly-edit="edit-sale"]').click();
    await expect(page.locator('[data-monthly-form]')).toContainText('매출 수정');
    await page.locator('[data-monthly="client"]').fill('수정후매출');
    await page.locator('[data-monthly="amount"]').fill('450000');
    await page.locator('[data-monthly="memo"]').fill('OS에서 매출 수정');
    await page.locator('[data-monthly-add]').click();
    await expect(page.locator('.toast')).toContainText('변경사항을 서버에 저장했습니다.');
    expect(store.monthly['direct-execution'].find((row: any) => row.id === 'edit-sale')).toMatchObject({
      client: '수정후매출', amount: 450_000, kind: 'sale', parentId: '', sourceLineage: { row: 10 }, rowVersion: 2,
    });
    expect(patchBodies.at(-1).rows[0]).toMatchObject({ id: 'edit-sale', expectedRowVersion: 1 });
    expect(patchBodies.at(-1).rows[0].changes).not.toHaveProperty('kind');
    expect(patchBodies.at(-1).rows[0].changes).not.toHaveProperty('parentId');
    expect(patchBodies.at(-1).rows[0].changes).not.toHaveProperty('sourceLineage');

    await page.locator('[data-monthly-edit="edit-run"]').click();
    await expect(page.locator('[data-monthly-form]')).toContainText('실행비 수정');
    await page.locator('[data-monthly="amount"]').fill('50000');
    await page.locator('[data-monthly="qty"]').fill('2');
    await page.locator('[data-monthly-add]').click();
    expect(store.monthly['direct-execution'].find((row: any) => row.id === 'edit-run')).toMatchObject({
      amount: 50_000, qty: 2, kind: 'run', parentId: 'edit-sale', sourceLineage: { row: 11 }, rowVersion: 2,
    });

    await page.locator('[data-monthly-edit="edit-orphan"]').click();
    await page.locator('[data-monthly="memo"]').fill('고아 실행행도 OS에서 수정');
    await page.locator('[data-monthly-add]').click();
    expect(store.monthly['direct-execution'].find((row: any) => row.id === 'edit-orphan')).toMatchObject({
      memo: '고아 실행행도 OS에서 수정', kind: 'run', parentId: 'prior-sale', sourceLineage: { row: 12 }, rowVersion: 2,
    });
    await expect(page.locator('[data-monthly-orphans]')).toContainText('고아 실행행도 OS에서 수정');
  });

  test('월별 정산 행 버전 충돌은 PATCH 실패 후 서버 원본을 다시 읽고 POST로 되살리지 않는다', async ({ page }) => {
    await installFirebaseStub(page);
    const store = await installPeakosStub(page, {
      name: '김대호', role: 'manager', group_name: '본사 경영지원팀', group_type: 'support',
    });
    store.monthly = { 'direct-execution': [sale('conflict-sale', '2026-08-01', '충돌전', 400_000)] };
    const methods: string[] = [];
    page.on('request', request => {
      if (request.url().includes('/api/peakos/monthly/direct-execution')) methods.push(request.method());
    });
    await page.goto('/business-os-preview.html');
    await expect(page.locator('#authGate')).toBeHidden();
    await openNavView(page, 'direct-execution');
    await page.locator('[data-monthly-edit="conflict-sale"]').click();
    store.monthly['direct-execution'][0] = {
      ...store.monthly['direct-execution'][0], client: '외부 최신 수정', rowVersion: 2,
    };
    await page.locator('[data-monthly="client"]').fill('내 오래된 수정');
    await page.locator('[data-monthly-add]').click();
    await expect(page.locator('.toast')).toContainText('다른 작업자가 먼저 수정했습니다.');
    await expect(page.locator('#moduleView')).toContainText('외부 최신 수정');
    await expect(page.locator('#moduleView')).not.toContainText('내 오래된 수정');
    expect(methods).toContain('PATCH');
    expect(methods).not.toContain('POST');
  });

  test('김지홍 월보장 원장에 이관 이전 매출 연결 실행 9건을 표시하고 손익에 포함한다', async ({ page }) => {
    await installFirebaseStub(page);
    const store = await installPeakosStub(page, {
      name: '김지홍', role: 'manager', group_name: '본사 영업팀', group_type: 'sales',
    });
    store.monthly = { 'monthly-guarantee': guaranteeWithPriorSaleRuns() };

    await page.goto('/business-os-preview.html');
    await expect(page.locator('#authGate')).toBeHidden();
    await openNavView(page, 'monthly-guarantee');

    const orphanGroup = page.locator('[data-monthly-orphans]');
    await expect(orphanGroup).toContainText('이관 이전 매출 연결 실행건');
    await expect(orphanGroup.locator('tbody tr')).toHaveCount(9);
    await expect(orphanGroup).toContainText('400,000');
    const total = page.locator('#moduleView .ledger-total');
    await expect(total).toContainText('판매 4,330,000');
    await expect(total).toContainText('실행 440,000');
    await expect(total).toContainText('영업이익 3,890,000');
  });

  test('최종실행정산서도 orphan 실행비를 조회 기간 합계와 이익에 포함한다', async ({ page }) => {
    await installFirebaseStub(page);
    const store = await installPeakosStub(page, {
      name: '김대호', role: 'manager', group_name: '본사 경영지원팀', group_type: 'support',
    });
    store.monthly = { 'monthly-guarantee': guaranteeWithPriorSaleRuns() };

    await page.goto('/business-os-preview.html');
    await expect(page.locator('#authGate')).toBeHidden();
    await openFinalExecution(page);
    await page.locator('[data-final-execution-filter="from"]').fill('2026-06-01');
    await page.locator('[data-final-execution-filter="to"]').fill('2026-08-31');

    const orphanGroup = page.locator('[data-final-execution-orphans="monthly-guarantee"]');
    await expect(orphanGroup.locator('tbody tr')).toHaveCount(9);
    await expect(orphanGroup).toContainText('400,000');
    const kpis = page.locator('.final-execution-kpis');
    await expect(kpis).toContainText('4,330,000원');
    await expect(kpis).toContainText('440,000원');
    await expect(kpis).toContainText('3,890,000원');
    await expect(page.locator('#moduleView')).toContainText('실행비 합계와 최종 영업이익에는 포함했습니다');
  });

  test('월보장·월관리·직접실행 원본과 기존 실행비를 읽기 전용으로 취합한다', async ({ page }) => {
    await installFirebaseStub(page);
    const store = await installPeakosStub(page, {
      name: '김대호', role: 'manager', group_name: '본사 경영지원팀', group_type: 'support',
    });
    store.monthly = {
      'monthly-guarantee': [
        sale('guarantee-sale', '2026-08-01', '월보장업체', 320_000),
        run('guarantee-run', 'guarantee-sale', '2026-08-02', 11_000, 1),
      ],
      'monthly-manage': [
        sale('manage-sale', '2026-08-03', '월관리업체', 500_000),
        run('manage-run', 'manage-sale', '2026-08-04', 2_000, 10),
      ],
      'direct-execution': [
        sale('direct-sale', '2026-08-05', '직접실행업체', 400_000),
        run('direct-run', 'direct-sale', '2026-08-06', 5_000, 10),
      ],
    };

    await page.goto('/business-os-preview.html');
    await expect(page.locator('#authGate')).toBeHidden();
    await openFinalExecution(page);

    const module = page.locator('#moduleView');
    await expect(module.locator('[data-final-execution-source]')).toHaveCount(3);
    await expect(module).toContainText('월보장 정산서');
    await expect(module).toContainText('김지홍');
    await expect(module).toContainText('월관리 정산서');
    await expect(module).toContainText('박우진');
    await expect(module).toContainText('직접실행 정산서');
    await expect(module).toContainText('김대호');
    await expect(module.locator('.final-execution-kpis')).toContainText('1,220,000원');
    await expect(module.locator('.final-execution-kpis')).toContainText('81,000원');
    await expect(module.locator('.final-execution-kpis')).toContainText('1,139,000원');
    await expect(module.locator('.monthly-table tbody tr')).toHaveCount(3);
    await expect(module).toContainText('-50,000');
    await expect(module.locator('[data-monthly-add]')).toHaveCount(0);
    await expect(module.locator('[data-monthly-remove]')).toHaveCount(0);

    await module.locator('[data-final-execution-filter="view"]').selectOption('monthly-manage');
    await expect(module.locator('[data-final-execution-source]')).toHaveCount(1);
    await expect(module.locator('.final-execution-kpis')).toContainText('500,000원');
    await expect(module.locator('.final-execution-kpis')).toContainText('20,000원');
    await expect(module.locator('.final-execution-kpis')).toContainText('480,000원');
  });

  for (const name of allowedViewers) {
    test(`${name} 계정은 최종실행정산서를 볼 수 있다`, async ({ page }) => {
      await installFirebaseStub(page);
      await installPeakosStub(page, {
        name, role: name === '패션TV봉이' ? 'admin' : 'manager', group_name: '본사 경영지원팀', group_type: 'support',
      });
      await page.goto('/business-os-preview.html');
      await expect(page.locator('#authGate')).toBeHidden();
      await openFinalExecution(page);
      await expect(page.locator('#moduleView')).toContainText('읽기 전용');
    });
  }

  for (const account of [
    { name: '김진봉', role: 'admin' },
    { name: '전현우', role: 'manager' },
    { name: '김지홍', role: 'manager' },
    { name: '박우진', role: 'manager' },
    { name: '임의관리자', role: 'admin' },
  ]) {
    test(`${account.name} 계정은 최종실행정산서를 열 수 없다`, async ({ page }) => {
      await installFirebaseStub(page);
      const requests: string[] = [];
      page.on('request', request => {
        if (request.url().includes('/api/peakos/final-execution')) requests.push(request.url());
      });
      await installPeakosStub(page, {
        name: account.name, role: account.role, group_name: '본사 경영지원팀', group_type: 'support',
      });
      await page.goto('/business-os-preview.html');
      await expect(page.locator('#authGate')).toBeHidden();
      const tab = page.locator('.nav-item[data-view="final-execution-settlement"]');
      await expect(tab).toBeHidden();
      await page.evaluate(() => {
        (document.querySelector('.nav-item[data-view="final-execution-settlement"]') as HTMLElement | null)?.click();
      });
      await expect(page.locator('#pageCrumb')).not.toHaveText('최종실행정산서');
      expect(requests).toHaveLength(0);
    });
  }
});
