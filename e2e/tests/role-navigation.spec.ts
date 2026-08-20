import { expect, test, type Page } from '@playwright/test';
import { installFirebaseStub, installPeakosStub } from './helpers';

async function openBusinessOs(
  page: Page,
  user: { name: string; role: string; group_name: string; group_type: string },
) {
  await installFirebaseStub(page);
  const store = await installPeakosStub(page, user);
  await page.goto('/business-os-preview.html');
  await expect(page.locator('#authGate')).toBeHidden();
  return store;
}

async function expandCluster(page: Page, name: string) {
  const cluster = page.locator(`[data-nav-cluster="${name}"]`);
  if ((await cluster.getAttribute('class'))?.split(/\s+/).includes('closed')) {
    await cluster.locator(':scope > .nav-cluster-toggle').click();
  }
  return cluster;
}

test.describe('직무별 하위 메뉴', () => {
  test('처음과 계정 전환 뒤에는 모든 대분류를 접는다', async ({ page }) => {
    await openBusinessOs(page, {
      name: '김대호',
      role: 'manager',
      group_name: '본사 경영지원팀',
      group_type: 'support',
    });

    const clusterNames = ['main', 'sales-operations', 'company', 'finance', 'tax-banking', 'tools'];
    for (const name of clusterNames) {
      const cluster = page.locator(`[data-nav-cluster="${name}"]`);
      await expect(cluster).toBeVisible();
      await expect(cluster).toHaveClass(/\bclosed\b/);
      await expect(cluster.locator(':scope > .nav-cluster-toggle')).toHaveAttribute('aria-expanded', 'false');
      await expect(cluster.locator(':scope > .nav-cluster-items')).toBeHidden();
    }
    for (const subcluster of await page.locator('[data-nav-subcluster]').all()) {
      await expect(subcluster).toHaveClass(/\bclosed\b/);
      await expect(subcluster.locator(':scope > .nav-subcluster-toggle')).toHaveAttribute('aria-expanded', 'false');
    }

    const company = page.locator('[data-nav-cluster="company"]');
    const companyToggle = company.locator(':scope > .nav-cluster-toggle');
    await companyToggle.focus();
    await companyToggle.press('Enter');
    await expect(company).not.toHaveClass(/\bclosed\b/);
    await expect(companyToggle).toHaveAttribute('aria-expanded', 'true');
    await expect(company.locator(':scope > .nav-cluster-items')).toBeVisible();
    await companyToggle.press('Space');
    await expect(company).toHaveClass(/\bclosed\b/);
    await expect(companyToggle).toHaveAttribute('aria-expanded', 'false');
    await companyToggle.press('Enter');

    await page.locator('#personaSelect').selectOption('손명아');
    for (const name of clusterNames) {
      const cluster = page.locator(`[data-nav-cluster="${name}"]`);
      if (await cluster.isVisible()) {
        await expect(cluster).toHaveClass(/\bclosed\b/);
        await expect(cluster.locator(':scope > .nav-cluster-toggle')).toHaveAttribute('aria-expanded', 'false');
      }
    }
  });

  test('검색은 필요한 묶음만 임시로 펼치고 계정 전환 때 완전히 초기화한다', async ({ page }) => {
    await openBusinessOs(page, {
      name: '김대호',
      role: 'manager',
      group_name: '본사 경영지원팀',
      group_type: 'support',
    });

    const search = page.locator('#sidebarTabSearch');
    const tax = page.locator('[data-nav-cluster="tax-banking"]');
    const invoice = page.locator('[data-nav-subcluster="tax-invoice"]');
    await search.fill('세금계산서 매출');
    await expect(tax).toHaveClass(/\bsearch-open\b/);
    await expect(tax.locator(':scope > .nav-cluster-toggle')).toHaveAttribute('aria-expanded', 'true');
    await expect(invoice).toHaveClass(/\bsearch-open\b/);
    await expect(invoice.locator(':scope > .nav-subcluster-toggle')).toHaveAttribute('aria-expanded', 'true');
    await expect(invoice.locator('[data-view="invoice"]')).toBeVisible();

    await tax.locator(':scope > .nav-cluster-toggle').click();
    await expect(search).toHaveValue('');
    await expect(page.locator('.search-open')).toHaveCount(0);
    await expect(tax).not.toHaveClass(/\bclosed\b/);
    await expect(tax.locator(':scope > .nav-cluster-toggle')).toHaveAttribute('aria-expanded', 'true');
    await expect(invoice).toHaveClass(/\bclosed\b/);
    await expect(invoice.locator(':scope > .nav-subcluster-toggle')).toHaveAttribute('aria-expanded', 'false');

    await search.fill('없는 메뉴 이름');
    await expect(page.locator('#tabSearchEmpty')).toBeVisible();
    await page.locator('#personaSelect').selectOption('손명아');
    await expect(search).toHaveValue('');
    await expect(page.locator('.search-open')).toHaveCount(0);
    await expect(page.locator('#tabSearchEmpty')).toBeHidden();
    for (const cluster of await page.locator('[data-nav-cluster]').all()) {
      if (await cluster.isVisible()) {
        await expect(cluster).toHaveClass(/\bclosed\b/);
        await expect(cluster.locator(':scope > .nav-cluster-toggle')).toHaveAttribute('aria-expanded', 'false');
      }
    }
  });

  test('영업자는 주요 메뉴를 그대로 보고 영업 운영의 개인 정산서와 입금체크를 본다', async ({ page }) => {
    const monthlyRequests: string[] = [];
    page.on('request', request => {
      if (request.url().includes('/api/peakos/monthly/')) monthlyRequests.push(request.url());
    });
    await openBusinessOs(page, {
      name: '영업 테스트',
      role: 'member',
      group_name: '본사 영업팀',
      group_type: 'sales',
    });

    await expect(page.locator('[data-nav-cluster="main"]')).toBeVisible();
    const sales = await expandCluster(page, 'sales-operations');
    await expect(sales).toBeVisible();
    await expect(sales.locator('[data-view="settlement"]')).toHaveText(/개인 정산서/);
    await expect(sales.locator('[data-view="deposit-check"]')).toHaveText(/입금체크/);
    await expect(sales.locator('[data-view="monthly-guarantee"]')).toBeHidden();
    await expect(sales.locator('[data-view="monthly-manage"]')).toBeHidden();
    await expect(sales.locator('[data-view="direct-execution"]')).toBeHidden();
    const taxBanking = page.locator('[data-nav-cluster="tax-banking"]');
    await expect(taxBanking).toBeVisible();
    await taxBanking.locator(':scope > .nav-cluster-toggle').click();
    await expect(taxBanking.locator('[data-view="bank"]')).toBeVisible();
    await expect(page.locator('#accountPreviewSlot')).toBeHidden();
    expect(monthlyRequests).toHaveLength(0);

    await sales.locator('[data-view="settlement"]').click();
    await expect(page.locator('.module-statusbar strong', { hasText: '개인 정산서' })).toBeVisible();
  });

  for (const owner of [
    { name: '김지홍', view: 'monthly-guarantee', label: '월보장 정산서' },
    { name: '박우진', view: 'monthly-manage', label: '월관리 정산서' },
  ]) {
    test(`${owner.name}은 영업 운영에서 본인 전용 ${owner.label}만 편집한다`, async ({ page }) => {
      await openBusinessOs(page, {
        name: owner.name,
        role: 'member',
        group_name: '본사 영업팀',
        group_type: 'sales',
      });

      const sales = await expandCluster(page, 'sales-operations');
      const ownTab = sales.locator(`[data-view="${owner.view}"]`);
      await expect(ownTab).toHaveText(new RegExp(owner.label));
      await expect(ownTab).toBeVisible();
      for (const otherView of ['monthly-guarantee', 'monthly-manage', 'direct-execution'].filter(view => view !== owner.view)) {
        await expect(sales.locator(`[data-view="${otherView}"]`)).toBeHidden();
      }
      await ownTab.click();
      await expect(page.locator('.module-statusbar strong', { hasText: owner.label })).toBeVisible();
      await expect(page.getByText('어디에 붙일까요', { exact: true })).toHaveCount(0);
      await expect(page.locator('[data-monthly="parentId"]')).toHaveCount(0);
      await expect(page.locator('[data-monthly-add]')).toBeVisible();
      await expect(page.getByText(`${owner.name} 본인만 볼 수 있고 수정할 수 있습니다`, { exact: true })).toBeVisible();
    });
  }

  test('김대호는 직접실행 정산서만 보고 월보장·월관리 정산서는 보지 않는다', async ({ page }) => {
    await openBusinessOs(page, {
      name: '김대호',
      role: 'manager',
      group_name: '본사 경영지원팀',
      group_type: 'support',
    });

    const persona = page.locator('#personaSelect');
    await expect(persona).toBeVisible();
    await expect(persona.locator('option[value=""]')).toHaveText('내 계정 (김대호 · 부장 · 본사)');
    await expect(persona.locator('option[value="김대호"]')).toHaveCount(0);
    await expect(page.locator('.app-sidebar > .member .member-copy strong')).toHaveText('김대호');
    await expect(page.locator('.app-sidebar > .member .member-copy small')).toHaveText('부장 · 본사');
    await expect(page.locator('.prototype-bar')).toHaveCount(0);
    await expect(page.locator('.topbar #accountPreviewSlot')).toBeVisible();
    await expect(page.locator('.topbar .top-actions > button:not(#themeToggle)')).toHaveCount(0);
    await expect(page.locator('#themeToggle')).toBeVisible();
    await expect(page.locator('#accountPreviewSlot')).not.toContainText('운영 데이터');
    await expect(page.locator('#accountPreviewSlot')).not.toContainText('계정 권한으로 조회 중');
    await expect(page.locator('.persona-preview-warning')).toHaveCount(0);

    const sales = await expandCluster(page, 'sales-operations');
    await expect(sales.locator('[data-view="direct-execution"]')).toBeVisible();
    await expect(sales.locator('[data-view="monthly-guarantee"]')).toBeHidden();
    await expect(sales.locator('[data-view="monthly-manage"]')).toBeHidden();
    await sales.locator('[data-view="direct-execution"]').click();
    await expect(page.locator('.module-statusbar strong', { hasText: '직접실행 정산서' })).toHaveCount(0);
    await expect(page.getByText('직접실행 정산서 등록', { exact: true })).toBeVisible();
    await expect(page.getByText('어디에 붙일까요', { exact: true })).toHaveCount(0);
    await expect(page.locator('[data-monthly="parentId"]')).toHaveCount(0);
    await expect(page.locator('[data-monthly-add]')).toBeVisible();

    // 오래된 화면이나 강제 DOM 조작으로 자기 이름이 들어와도 실제 내 계정으로 정규화한다.
    await page.evaluate(() => {
      const select = document.querySelector<HTMLSelectElement>('#personaSelect');
      if (!select) return;
      select.add(new Option('김대호 · 부장 · 본사', '김대호'));
      select.value = '김대호';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await expect(page.locator('.prototype-bar')).toHaveCount(0);
    await expandCluster(page, 'sales-operations');
    await expect(page.locator('[data-view="direct-execution"]')).toBeVisible();
    await expect(page.locator('#personaSelect')).toHaveValue('');

    await page.locator('#personaSelect').selectOption('김용일');
    await expect(page.locator('.persona-preview-warning')).toHaveText('미리보기 중 · 저장 안 됨');
    await page.locator('#personaSelect').selectOption('');
    await expect(page.locator('.persona-preview-warning')).toHaveCount(0);
  });

  test('계정 미리보기에서 김지홍 월보장·박우진 월관리를 서버 자료로 읽기만 한다', async ({ page }) => {
    const monthlyRequests: Array<{ method: string; url: string }> = [];
    page.on('request', request => {
      if (request.url().includes('/api/peakos/monthly/')) {
        monthlyRequests.push({ method: request.method(), url: request.url() });
      }
    });
    const store = await openBusinessOs(page, {
      name: '김대호',
      role: 'manager',
      group_name: '본사 경영지원팀',
      group_type: 'support',
    });
    store.monthly['monthly-guarantee'] = [{
      id: 'preview-guarantee-sale', rowVersion: 1, kind: 'sale', parentId: '',
      date: '2026-08-01', client: '김지홍 월보장 미리보기',
      a: '플레이스', b: '상위노출', c: '월보장', amount: 330000, qty: 1, period: '', memo: '',
    }];
    store.monthly['monthly-manage'] = [{
      id: 'preview-manage-sale', rowVersion: 1, kind: 'sale', parentId: '',
      date: '2026-08-02', client: '박우진 월관리 미리보기',
      a: '플레이스', b: '관리', c: '월관리', amount: 440000, qty: 1, period: '8월', memo: '',
    }];

    let sales = await expandCluster(page, 'sales-operations');
    await page.locator('#personaSelect').selectOption('김지홍');
    sales = await expandCluster(page, 'sales-operations');
    await expect(sales.locator('[data-view="monthly-guarantee"]')).toBeVisible();
    await expect(sales.locator('[data-view="monthly-manage"]')).toBeHidden();
    await expect(sales.locator('[data-view="direct-execution"]')).toBeHidden();
    await sales.locator('[data-view="monthly-guarantee"]').click();
    await expect(page.getByText('김지홍 월보장 미리보기', { exact: true })).toBeVisible();
    await expect(page.locator('[data-monthly-form]')).toHaveCount(0);
    await expect(page.locator('[data-monthly-add], [data-monthly-edit], [data-monthly-remove]')).toHaveCount(0);
    await expect(page.getByText('김지홍 계정의 정산서를 읽기 전용으로 보는 중입니다', { exact: true })).toBeVisible();

    await page.locator('#personaSelect').selectOption('박우진');
    sales = await expandCluster(page, 'sales-operations');
    await expect(sales.locator('[data-view="monthly-guarantee"]')).toBeHidden();
    await expect(sales.locator('[data-view="monthly-manage"]')).toBeVisible();
    await sales.locator('[data-view="monthly-manage"]').click();
    await expect(page.getByText('박우진 월관리 미리보기', { exact: true })).toBeVisible();
    await expect(page.locator('[data-monthly-form]')).toHaveCount(0);
    await expect(page.locator('[data-monthly-add], [data-monthly-edit], [data-monthly-remove]')).toHaveCount(0);
    await expect(page.getByText('박우진 계정의 정산서를 읽기 전용으로 보는 중입니다', { exact: true })).toBeVisible();

    expect(monthlyRequests.some(request => request.method === 'GET'
      && request.url.includes('/monthly/monthly-guarantee?owner=%EA%B9%80%EC%A7%80%ED%99%8D'))).toBe(true);
    expect(monthlyRequests.some(request => request.method === 'GET'
      && request.url.includes('/monthly/monthly-manage?owner=%EB%B0%95%EC%9A%B0%EC%A7%84'))).toBe(true);
    expect(monthlyRequests.every(request => request.method === 'GET')).toBe(true);
  });

  for (const account of [
    { name: '패션TV봉이', role: 'admin', visible: true },
    { name: '박종원', role: 'manager', visible: true },
    { name: '김진봉', role: 'admin', visible: false },
    { name: '대표 테스트', role: 'admin', visible: false },
  ]) {
    test(`계정 미리보기는 지정 계정만 사용한다 — ${account.name}`, async ({ page }) => {
      await openBusinessOs(page, {
        name: account.name,
        role: account.role,
        group_name: '본사 경영지원팀',
        group_type: 'support',
      });

      const slot = page.locator('#accountPreviewSlot');
      if (account.visible) {
        await expect(slot).toBeVisible();
        await expect(page.locator('#personaSelect')).toBeVisible();
      } else {
        await expect(slot).toBeHidden();
        await expect(page.locator('#personaSelect')).toHaveCount(0);
      }
      await expect(page.locator('.topbar .top-actions > button:not(#themeToggle)')).toHaveCount(0);
      await expect(page.locator('#themeToggle')).toBeVisible();
    });
  }

  test('모바일 헤더에서도 계정 미리보기가 화면 밖으로 밀리지 않는다', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 780 });
    await openBusinessOs(page, {
      name: '김대호',
      role: 'manager',
      group_name: '본사 경영지원팀',
      group_type: 'support',
    });

    for (const cluster of await page.locator('[data-nav-cluster]').all()) {
      if (await cluster.evaluate(element => !(element as HTMLElement).hidden)) {
        await expect(cluster).toHaveClass(/\bclosed\b/);
        await expect(cluster.locator(':scope > .nav-cluster-toggle')).toHaveAttribute('aria-expanded', 'false');
      }
    }

    await page.locator('#personaSelect').selectOption('김용일');
    await expect(page.locator('.persona-preview-warning')).toHaveText('미리보기 중 · 저장 안 됨');
    const layout = await page.evaluate(() => {
      const topbar = document.querySelector('.topbar')?.getBoundingClientRect();
      const slot = document.querySelector('#accountPreviewSlot')?.getBoundingClientRect();
      return {
        viewport: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
        topbar: topbar ? { left: topbar.left, right: topbar.right } : null,
        slot: slot ? { left: slot.left, right: slot.right } : null,
      };
    });
    expect(layout.scrollWidth).toBe(layout.viewport);
    expect(layout.topbar).not.toBeNull();
    expect(layout.slot).not.toBeNull();
    expect(layout.slot!.left).toBeGreaterThanOrEqual(layout.topbar!.left);
    expect(layout.slot!.right).toBeLessThanOrEqual(layout.topbar!.right);
  });

  test('개발자는 영업 운영을 보지 않고 개발수정요청의 실제 서버 응답과 상태를 본다', async ({ page }) => {
    const store = await openBusinessOs(page, {
      name: '개발 테스트',
      role: 'member',
      group_name: '본사 개발팀',
      group_type: 'support',
    });
    store.serviceRequests.push({
      id: 'dev-request-1',
      status: 'working',
      priority: 'high',
      product_name: '테스트 서비스',
      title: '개발 요청 표시 확인',
      requester_name: '요청자',
      assignee_name: '개발담당자',
      created_at: '2026-08-08T00:00:00.000Z',
      deleted: false,
    });
    await page.reload();
    await expect(page.locator('#authGate')).toBeHidden();

    await expect(page.locator('[data-nav-cluster="sales-operations"]')).toBeHidden();
    await page.locator('#sidebarTabSearch').fill('정산');
    await page.locator('#sidebarTabSearch').fill('');
    await expect(page.locator('[data-nav-cluster="sales-operations"]')).toBeHidden();
    const main = page.locator('[data-nav-cluster="main"]');
    await main.locator(':scope > .nav-cluster-toggle').click();
    const requestTab = page.locator('[data-view="requests"]');
    await expect(requestTab).toHaveText(/개발 ?수정요청/);
    await requestTab.click();
    await expect(page.locator('.module-statusbar strong', { hasText: '개발수정요청' })).toBeVisible();
    await expect(page.getByText('개발 요청 표시 확인', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '진행 중 1' })).toBeVisible();
  });

  test('대표도 영업 운영의 개인 전용 정산서 3종은 보지 않는다', async ({ page }) => {
    await openBusinessOs(page, {
      name: '대표 테스트',
      role: 'admin',
      group_name: '',
      group_type: 'support',
    });

    const sales = await expandCluster(page, 'sales-operations');
    await expect(sales).toBeVisible();
    await expect(sales.locator('[data-view="settlement"]')).toBeVisible();
    await expect(sales.locator('[data-view="deposit-check"]')).toBeVisible();
    await expect(sales.locator('[data-view="monthly-guarantee"]')).toBeHidden();
    await expect(sales.locator('[data-view="monthly-manage"]')).toBeHidden();
    await expect(sales.locator('[data-view="direct-execution"]')).toBeHidden();
    await expect(page.locator('[data-nav-cluster="finance"] [data-view="monthly-guarantee"]')).toHaveCount(0);
    await expect(page.locator('[data-nav-cluster="finance"] [data-view="monthly-manage"]')).toHaveCount(0);
  });
});
