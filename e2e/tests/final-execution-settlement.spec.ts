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

test.describe('최종실행정산서', () => {
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
