import { expect, test, type Page } from '@playwright/test';
import { installFirebaseStub, installPeakosStub } from './helpers';

function importedRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'imported-intake-1',
    owner: 'e2e-test-user',
    ownerName: '김대호',
    date: '2026-08-08',
    client: '이관업체',
    expectedPayer: '이관업체',
    a: '블로그',
    b: '원고',
    c: '프리미엄원고대필',
    unit: 40_000,
    qty: 1,
    sell: 100_000,
    expectedDepositAmount: 110_000,
    cost: 30_000,
    memo: '구글시트 이관 원본',
    kind: 'normal',
    refOf: '',
    supplier: '이관공급처',
    manager: '',
    finalOnly: false,
    paid: 'paid',
    paidAmount: 110_000,
    payer: '이관업체',
    paidDate: '2026-08-08',
    paidMemo: '매출통장 입금 확인 완료',
    paidAuto: false,
    vendorPaid: false,
    vendorPaidDate: '',
    vendorBank: '',
    vendorBy: '',
    vendorMemo: '',
    sourceGrossAmount: 110_000,
    sourceSalesAmount: 100_000,
    sourceLineage: { spreadsheetId: 'sheet-original', rowNumber: 27 },
    ...overrides,
  };
}

async function setup(page: Page, row = importedRow()) {
  await installFirebaseStub(page);
  const store = await installPeakosStub(page, {
    name: '김대호', uid: 'e2e-test-user', role: 'manager', group_name: '본사 경영지원팀',
  });
  store.intake = [row];
  await page.goto('/business-os-preview.html');
  await expect(page.locator('#authGate')).toBeHidden();
  return store;
}

async function openView(page: Page, view: string) {
  const tab = page.locator(`.nav-item[data-view="${view}"]`);
  const cluster = tab.locator('xpath=ancestor::section[contains(@class, "nav-cluster")]');
  if (await cluster.count() && (await cluster.getAttribute('class'))?.includes('closed')) {
    await cluster.locator(':scope > .nav-cluster-toggle').click();
  }
  const subcluster = tab.locator('xpath=ancestor::*[@data-nav-subcluster][1]');
  if (await subcluster.count() && (await subcluster.getAttribute('class'))?.includes('closed')) {
    await subcluster.locator(':scope > button').first().click();
  }
  await expect(tab).toBeVisible();
  await tab.click();
}

test.describe('개인정산서 서버 편집', () => {
  test('연결키 없는 과거 실행 6건의 미수 539,000원을 저장된 입금 상태대로 표시한다', async ({ page }) => {
    await installFirebaseStub(page);
    const store = await installPeakosStub(page, {
      name: '김대호', uid: 'e2e-test-user', role: 'manager', group_name: '본사 경영지원팀',
    });
    const amounts = [66_000, 88_000, 88_000, 99_000, 99_000, 99_000];
    store.intake = amounts.map((amount, index) => importedRow({
      id: `orphan-use-${index + 1}`,
      client: '과거실행미수업체',
      kind: 'use',
      refOf: '',
      sell: amount,
      expectedDepositAmount: amount,
      paid: 'none',
      paidAmount: 0,
    }));

    await page.goto('/business-os-preview.html');
    await expect(page.locator('#authGate')).toBeHidden();
    await openView(page, 'settlement');
    const total = page.locator('#moduleView .ledger-total');
    await expect(total).toContainText('입금예정 539,000');
    await expect(total).toContainText('입금 0');
    await expect(total).toContainText('미입금 539,000');

    await openView(page, 'deposit-check');
    const clientRow = page.locator('#moduleView tbody tr').filter({ hasText: '과거실행미수업체' }).first();
    await expect(clientRow).toContainText('539,000');
    await expect(clientRow).toContainText('6건');
    await expect(page.locator('#moduleView .module-statusbar')).toContainText('미수 539,000원');
  });

  test('연결키 없는 음수 환불은 합계 부호가 아니라 저장된 입금 상태로 미확인을 표시한다', async ({ page }) => {
    await installFirebaseStub(page);
    const store = await installPeakosStub(page, {
      name: '김대호', uid: 'e2e-test-user', role: 'manager', group_name: '본사 경영지원팀',
    });
    const paidAmounts = [199_900, 299_900, 299_900];
    store.intake = paidAmounts.map((amount, index) => importedRow({
      id: `legacy-refund-paid-${index + 1}`,
      client: '과거환불업체', kind: 'refund', refOf: '', sell: amount,
      expectedDepositAmount: -amount, paid: 'paid', paidAmount: -amount,
    }));
    store.intake.push(importedRow({
      id: 'legacy-refund-unpaid', client: '과거환불업체', kind: 'refund', refOf: '', sell: 440_000,
      expectedDepositAmount: -440_000, paid: 'none', paidAmount: 0,
    }));

    await page.goto('/business-os-preview.html');
    await expect(page.locator('#authGate')).toBeHidden();
    await openView(page, 'invoice');
    const invoiceRow = page.locator('#moduleView tbody tr').filter({ hasText: '과거환불업체' }).first();
    await expect(invoiceRow).toContainText('미확인 1건');
    await expect(invoiceRow).not.toContainText('입금', { useInnerText: true });
  });

  test('세금계산서 매출은 이관 원본 VAT 총액 예외를 보존하고 10% 추정치로 덮지 않는다', async ({ page }) => {
    const store = await setup(page, importedRow({
      id: 'gross-exception',
      client: '원본총액예외업체',
      qty: 1,
      sell: 341_409_682,
      expectedDepositAmount: 375_503_141,
      paid: 'none',
      paidAmount: 0,
      sourceGrossAmount: 375_503_141,
    }));
    expect(store.intake).toHaveLength(1);
    await openView(page, 'invoice');

    const row = page.locator('#moduleView tbody tr').filter({ hasText: '원본총액예외업체' });
    await expect(row).toContainText('341,409,682');
    await expect(row).toContainText('34,093,459');
    await expect(row).toContainText('375,503,141');
    await expect(row).toContainText('원본 총액 예외 1건');
    await expect(page.locator('#moduleView')).not.toContainText('34,140,968');
    await expect(page.locator('#moduleView')).toContainText('발행 완료 세금계산서가 아니라 내부 접수 기준');
  });

  test('VAT 포함 예약금은 사용 수량에 비례해 저장하고 10% 유령 잔액을 남기지 않는다', async ({ page }) => {
    const store = await setup(page, importedRow({
      id: 'vat-reserve',
      client: 'VAT예약업체',
      kind: 'reserve',
      qty: 10,
      sell: 100_000,
      expectedDepositAmount: 1_100_000,
      paid: 'paid',
      paidAmount: 1_100_000,
    }));
    await openView(page, 'settlement');
    await page.locator('[data-intake-toggle]').click();
    await page.locator('[data-intake-kind="use"]').click();
    await page.locator('[data-intake="refOf"]').selectOption('vat-reserve');
    await page.locator('[data-intake="qty"]').fill('4');
    await expect(page.locator('[data-intake="expectedDepositAmount"]')).toHaveValue('440000');
    await expect(page.locator('[data-intake="expectedDepositAmount"]')).toHaveAttribute('readonly', '');
    await page.locator('[data-intake-add]').click();

    await expect(page.locator('.toast')).toContainText('접수를 운영 서버에 등록했습니다.');
    const use = store.intake.find((row: any) => row.kind === 'use');
    expect(use).toMatchObject({ refOf: 'vat-reserve', qty: 4, expectedDepositAmount: 440_000 });
    const total = page.locator('#moduleView .ledger-total');
    await expect(total).toContainText('입금예정 440,000');
    await expect(total).toContainText('입금 440,000');
    await expect(total).toContainText('미입금 0');
    await expect(total).toContainText('예약금 잔여 660,000');
  });

  test('양수와 음수 조정이 섞여도 음수 행은 묶음 입금에 포함하지 않고 다른 영업자 양수 행만 처리한다', async ({ page }) => {
    await installFirebaseStub(page);
    const store = await installPeakosStub(page, {
      name: '김대호', uid: 'e2e-test-user', role: 'manager', group_name: '본사 경영지원팀',
    });
    store.intake = [
      importedRow({
        id: 'own-negative', owner: 'e2e-test-user', ownerName: '김대호', client: '음수조정',
        qty: -1, sell: 100_000, expectedDepositAmount: -110_000, paid: 'none', paidAmount: 0,
      }),
      importedRow({
        id: 'other-positive', owner: 'other-owner', ownerName: '김용일', client: '타영업자입금',
        qty: 1, sell: 100_000, expectedDepositAmount: 110_000, paid: 'none', paidAmount: 0,
      }),
      importedRow({
        id: 'other-reserve', owner: 'other-owner', ownerName: '김용일', client: '타영업자예약금',
        kind: 'reserve', qty: 1, sell: 200_000, expectedDepositAmount: 220_000, paid: 'none', paidAmount: 0,
      }),
    ];
    const patchBodies: any[] = [];
    page.on('request', request => {
      if (request.method() === 'PATCH' && request.url().includes('/api/peakos/intake')) {
        patchBodies.push(request.postDataJSON());
      }
    });
    await page.goto('/business-os-preview.html');
    await expect(page.locator('#authGate')).toBeHidden();
    await openView(page, 'deposit-check');

    const negativeRow = page.locator('#moduleView tbody tr').filter({ hasText: '음수조정' }).last();
    const positiveRow = page.locator('#moduleView tbody tr').filter({ hasText: '타영업자입금' }).last();
    const reserveRow = page.locator('#moduleView tbody tr').filter({ hasText: '타영업자예약금' }).last();
    await expect(reserveRow.locator('[data-paid-open="other-reserve"]')).toHaveCount(1);
    await negativeRow.locator('[data-intake-pick]').check();
    await positiveRow.locator('[data-intake-pick]').check();
    await expect(page.locator('[data-paid-bulk]')).toBeDisabled();
    await expect(negativeRow.locator('[data-paid-open]')).toHaveCount(0);

    await negativeRow.locator('[data-intake-pick]').uncheck();
    await positiveRow.locator('[data-paid-open="other-positive"]').click();
    await page.locator('#paidMemo').fill('타 영업자 매출통장 입금 확인');
    await page.locator('[data-paid-save]').click();
    await expect(page.locator('.toast')).toContainText('입금 110,000원을 1건에 서버 저장했습니다.');
    expect(store.intake.find((row: any) => row.id === 'other-positive')).toMatchObject({ paid: 'paid', paidAmount: 110_000 });
    expect(patchBodies.at(-1)).toMatchObject({ action: 'payment' });

    await openView(page, 'settlement');
    await expect(page.locator('#moduleView')).toContainText('음수조정');
    await expect(page.locator('#moduleView')).not.toContainText('타영업자입금');
  });

  test('행 버전 충돌 시 PATCH만 실패하고 삭제된/변경된 행을 POST로 되살리지 않는다', async ({ page }) => {
    const store = await setup(page);
    const methods: string[] = [];
    page.on('request', request => {
      if (request.url().includes('/api/peakos/intake')) methods.push(request.method());
    });
    await openView(page, 'settlement');
    await page.locator('[data-intake-edit="imported-intake-1"]').click();
    store.intake[0] = { ...store.intake[0], client: '외부에서 먼저 수정', rowVersion: 2 };
    await page.locator('[data-intake="client"]').fill('내 오래된 수정');
    await page.locator('[data-intake-add]').click();

    await expect(page.locator('.toast')).toContainText('다른 작업자가 먼저 수정했습니다.');
    await expect(page.locator('#moduleView .ledger-table')).toContainText('외부에서 먼저 수정');
    await expect(page.locator('#moduleView .ledger-table')).not.toContainText('내 오래된 수정');
    expect(methods).toContain('PATCH');
    expect(methods).not.toContain('POST');
  });

  test('최종정산 열람자는 개인 원장은 본인만, 최종정산은 두 영업자 전체를 취합하고 manager 액션으로 배정한다', async ({ page }) => {
    await installFirebaseStub(page);
    const store = await installPeakosStub(page, {
      name: '전현우', uid: 'e2e-test-user', role: 'manager', group_name: '본사 경영지원팀',
    });
    store.intake = [
      importedRow({ id: 'hyunwoo-row', owner: 'e2e-test-user', ownerName: '전현우', client: '전현우업체', manager: '' }),
      importedRow({ id: 'other-row', owner: 'other-owner', ownerName: '김용일', client: '김용일업체', manager: '' }),
    ];
    const patchBodies: any[] = [];
    page.on('request', request => {
      if (request.method() === 'PATCH' && request.url().includes('/api/peakos/intake')) patchBodies.push(request.postDataJSON());
    });
    await page.goto('/business-os-preview.html');
    await expect(page.locator('#authGate')).toBeHidden();

    await openView(page, 'settlement');
    await expect(page.locator('#moduleView')).toContainText('전현우업체');
    await expect(page.locator('#moduleView')).not.toContainText('김용일업체');

    await openView(page, 'final-settlement');
    await expect(page.locator('#moduleView')).toContainText('전현우업체');
    await expect(page.locator('#moduleView')).toContainText('김용일업체');
    await expect(page.locator('#moduleView .final-total')).toContainText('판매가액 200,000');
    await expect(page.locator('[data-vendor-settle]')).toHaveCount(0);
    await expect(page.locator('.vendor-table')).toContainText('읽기 전용');

    await page.locator('[data-final-assign]').click();
    await page.locator('#assignManager').selectOption('김대호');
    await page.locator('[data-assign-save]').click();
    await expect(page.locator('.toast')).toContainText('2건을 김대호(으)로 서버 저장했습니다.');
    expect(store.intake.map((row: any) => row.manager)).toEqual(['김대호', '김대호']);
    expect(patchBodies.at(-1)).toMatchObject({ action: 'manager' });
    expect(patchBodies.at(-1).rows).toHaveLength(2);
  });

  test('공급사 정산은 양수·확정원가 행만 서버 계산액으로 처리하고 음수·환불·원가미정 행을 제외한다', async ({ page }) => {
    await installFirebaseStub(page);
    const store = await installPeakosStub(page, {
      name: '김대호', uid: 'e2e-test-user', role: 'manager', group_name: '본사 경영지원팀',
    });
    store.intake = [
      importedRow({ id: 'vendor-positive', client: '양수공급', supplier: '정확공급사', qty: 2, cost: 30_000 }),
      importedRow({ id: 'vendor-negative', client: '음수조정', supplier: '정확공급사', qty: -1, cost: 30_000, expectedDepositAmount: -110_000 }),
      importedRow({ id: 'vendor-refund', client: '환불조정', supplier: '정확공급사', kind: 'refund', qty: 1, cost: 30_000, expectedDepositAmount: 110_000 }),
      importedRow({ id: 'vendor-unknown', client: '원가미정', supplier: '미정공급사', qty: 1, cost: null }),
    ];
    const patchBodies: any[] = [];
    page.on('request', request => {
      if (request.method() === 'PATCH' && request.url().includes('/api/peakos/intake')) patchBodies.push(request.postDataJSON());
    });
    await page.goto('/business-os-preview.html');
    await expect(page.locator('#authGate')).toBeHidden();
    await openView(page, 'final-settlement');

    const exact = page.locator('.vendor-table tbody tr').filter({ hasText: '정확공급사' });
    await expect(exact).toContainText('60,000');
    await expect(exact).toContainText('송금 제외 2건');
    await expect(exact.locator('[data-vendor-settle]')).toBeEnabled();
    const unknown = page.locator('.vendor-table tbody tr').filter({ hasText: '미정공급사' });
    await expect(unknown).toContainText('원가 미확정 1건');
    await expect(unknown.locator('[data-vendor-settle]')).toBeDisabled();

    await exact.locator('[data-vendor-settle]').click();
    await expect(page.locator('#vendorAmount')).toHaveCount(0);
    await expect(page.locator('#readonlyModalBody')).toContainText('서버 확정 예정 지급액');
    await expect(page.locator('#readonlyModalBody')).toContainText('60,000원');
    await page.locator('#vendorQty').fill('2');
    await page.locator('#vendorMemo').fill('공급처 통장에서 정확 송금 완료');
    await page.locator('[data-vendor-save]').click();
    await expect(page.locator('.toast')).toContainText('60,000원을 지불한 정산을 서버 저장했습니다.');

    expect(store.intake.find((row: any) => row.id === 'vendor-positive')).toMatchObject({
      vendorPaid: true,
      vendorPaidAmount: 60_000,
    });
    expect(store.intake.find((row: any) => row.id === 'vendor-negative')?.vendorPaid).toBe(false);
    expect(store.intake.find((row: any) => row.id === 'vendor-refund')?.vendorPaid).toBe(false);
    const vendorPatch = patchBodies.at(-1);
    expect(vendorPatch).toMatchObject({ action: 'vendor' });
    expect(vendorPatch.rows).toHaveLength(1);
    expect(vendorPatch.rows[0].changes).not.toHaveProperty('vendorPaidAmount');
    await expect(page.locator('.final-day-table .vendor-chip.done')).toContainText('60,000원');
  });

  test('음수 일반조정과 canonical 환불을 한 번만 차감하고 legacy 0값·빈 분류·연결 없는 행을 수정한다', async ({ page }) => {
    await installFirebaseStub(page);
    const store = await installPeakosStub(page, {
      name: '김대호', uid: 'e2e-test-user', role: 'manager', group_name: '본사 경영지원팀',
    });
    store.intake = [
      importedRow({
        id: 'negative-adjustment', client: '음수조정업체', a: '', b: '레거시분류', c: '차감조정',
        unit: 0, qty: -1, sell: 55_000, expectedDepositAmount: -60_500,
        paid: 'none', paidAmount: 0, sourceGrossAmount: -60_500,
      }),
      importedRow({
        id: 'canonical-refund', client: '환불업체', kind: 'refund', refOf: '',
        unit: 10_000, qty: 1, sell: 20_000, expectedDepositAmount: 22_000,
        paid: 'none', paidAmount: 0, sourceGrossAmount: -22_000,
      }),
      importedRow({
        id: 'legacy-use', client: '연결없는실행', kind: 'use', refOf: '', a: '', b: '', c: '',
        unit: 0, qty: 0, sell: 0, expectedDepositAmount: 0, paid: 'none', paidAmount: 0,
      }),
    ];
    await page.goto('/business-os-preview.html');
    await expect(page.locator('#authGate')).toBeHidden();
    await openView(page, 'settlement');

    const total = page.locator('#moduleView .ledger-total');
    await expect(total).toContainText('매출 -75,000');
    await expect(total).toContainText('입금예정 -82,500');
    await expect(total).toContainText('미입금 0');

    await page.locator('[data-intake-edit="negative-adjustment"]').click();
    await expect(page.locator('[data-intake="a"]')).toHaveValue('');
    await expect(page.locator('[data-intake="a"] option:checked')).toHaveText('미분류 · 원본값');
    await expect(page.locator('[data-intake="unit"]')).toHaveValue('0');
    await expect(page.locator('[data-intake="qty"]')).toHaveValue('-1');
    await page.locator('[data-intake="expectedDepositAmount"]').fill('-66000');
    await page.locator('[data-intake="memo"]').fill('음수 조정 메모만 수정');
    await page.locator('[data-intake-add]').click();
    await expect(page.locator('.toast')).toContainText('개인정산서 변경사항을 서버에 저장했습니다.');
    expect(store.intake.find((row: any) => row.id === 'negative-adjustment')).toMatchObject({
      a: '', b: '레거시분류', c: '차감조정', unit: 0, qty: -1,
      expectedDepositAmount: -66_000, sourceGrossAmount: -60_500,
    });

    await page.locator('[data-intake-edit="legacy-use"]').click();
    await page.locator('[data-intake="memo"]').fill('연결키 없이 이관된 실행 메모 수정');
    await page.locator('[data-intake-add]').click();
    await expect(page.locator('.toast')).toContainText('개인정산서 변경사항을 서버에 저장했습니다.');
    expect(store.intake.find((row: any) => row.id === 'legacy-use')).toMatchObject({
      kind: 'use', refOf: '', a: '', b: '', c: '', unit: 0, qty: 0,
    });
  });

  test('VAT 포함 입금예정액으로 미수를 계산하고 기존 행 수정 시 이관 원본 필드를 보존한다', async ({ page }) => {
    const store = await setup(page);
    await openView(page, 'settlement');

    const total = page.locator('#moduleView .ledger-total');
    await expect(total).toHaveCount(1);
    const summaryOrder = await page.locator('#moduleView .module-section').filter({ hasText: '내 개인정산서' }).evaluate(section => {
      const filter = section.querySelector('.ledger-filter');
      const summary = section.querySelector('.ledger-total');
      const firstDay = section.querySelector('.ledger-day');
      return Boolean(filter && summary && firstDay
        && (filter.compareDocumentPosition(summary) & Node.DOCUMENT_POSITION_FOLLOWING)
        && (summary.compareDocumentPosition(firstDay) & Node.DOCUMENT_POSITION_FOLLOWING));
    });
    expect(summaryOrder).toBe(true);
    await expect(total).toContainText('매출 100,000');
    await expect(total).toContainText('입금예정 110,000');
    await expect(total).toContainText('입금 110,000');
    await expect(total).toContainText('미입금 0');

    await openView(page, 'deposit-check');
    const clientRow = page.locator('#moduleView .module-section').filter({ hasText: '업체별 미수금' }).locator('tbody tr');
    await expect(clientRow).toContainText('100,000');
    await expect(clientRow).toContainText('110,000');
    await expect(clientRow).not.toContainText('-10,000');
    await expect(page.locator('#moduleView .module-statusbar')).toContainText('미수 0원');

    await openView(page, 'settlement');
    await page.locator('[data-intake-edit="imported-intake-1"]').click();
    await expect(page.locator('[data-monthly-form], .intake-section')).toContainText('개인정산서 수정');
    await expect(page.locator('[data-intake="unit"]')).toHaveValue('40000');
    await expect(page.locator('[data-intake="expectedDepositAmount"]')).toHaveValue('110000');
    await page.locator('[data-intake="client"]').fill('수정된 이관업체');
    await page.locator('[data-intake="sell"]').fill('120000');
    await page.locator('[data-intake="expectedDepositAmount"]').fill('132000');
    await page.locator('[data-intake="memo"]').fill('운영 OS에서 수정한 메모');
    await page.locator('[data-intake-add]').click();

    await expect(page.locator('.toast')).toContainText('개인정산서 변경사항을 서버에 저장했습니다.');
    await expect(page.locator('#moduleView .ledger-table')).toContainText('수정된 이관업체');
    await expect(page.locator('[data-paid-open="imported-intake-1"]')).toContainText('부분입금');
    await expect(page.locator('#moduleView .ledger-total')).toContainText('미입금 22,000');
    expect(store.intake[0]).toMatchObject({
      id: 'imported-intake-1',
      client: '수정된 이관업체',
      sell: 120_000,
      expectedDepositAmount: 132_000,
      sourceGrossAmount: 110_000,
      sourceSalesAmount: 100_000,
      sourceLineage: { spreadsheetId: 'sheet-original', rowNumber: 27 },
      paid: 'partial',
    });
  });

  test('수정 저장이 실패하면 성공 표시 없이 서버 원본으로 되돌린다', async ({ page }) => {
    const store = await setup(page);
    let failNextWrite = true;
    await page.route('**/api/peakos/intake', async route => {
      if (route.request().method() === 'PATCH' && failNextWrite) {
        failNextWrite = false;
        await new Promise(resolve => setTimeout(resolve, 500));
        await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: '테스트 저장 실패' }) });
        return;
      }
      await route.fallback();
    });

    await openView(page, 'settlement');
    await page.locator('[data-intake-edit="imported-intake-1"]').click();
    await page.locator('[data-intake="client"]').fill('저장되면 안 되는 이름');
    await page.locator('[data-intake-add]').click();
    await expect(page.locator('[data-intake-add]')).toBeDisabled();
    await expect(page.locator('[data-intake-add]')).toHaveText('서버 저장 중…');

    await expect(page.locator('.toast')).toContainText('저장하지 못했습니다. 테스트 저장 실패');
    await expect(page.locator('#moduleView .ledger-table')).toContainText('이관업체');
    await expect(page.locator('#moduleView .ledger-table')).not.toContainText('저장되면 안 되는 이름');
    expect(store.intake[0].client).toBe('이관업체');
  });

  test('행 버전 없는 canonical 응답은 성공으로 표시하지 않고 서버 원본을 다시 읽는다', async ({ page }) => {
    const store = await setup(page);
    await page.route('**/api/peakos/intake', async route => {
      if (route.request().method() === 'PATCH') {
        const { rowVersion: _omitted, ...withoutVersion } = store.intake[0];
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ rows: [{ ...withoutVersion, client: '확정되지 않은 응답' }] }),
        });
        return;
      }
      await route.fallback();
    });

    await openView(page, 'settlement');
    await page.locator('[data-intake-edit="imported-intake-1"]').click();
    await page.locator('[data-intake="client"]').fill('버전 없는 수정');
    await page.locator('[data-intake-add]').click();

    await expect(page.locator('.toast')).toContainText('행 버전을 확정하지 못했습니다.');
    await expect(page.locator('.toast')).not.toContainText('변경사항을 서버에 저장했습니다.');
    await expect(page.locator('#moduleView .ledger-table')).toContainText('이관업체');
    await expect(page.locator('#moduleView .ledger-table')).not.toContainText('버전 없는 수정');
  });

  test('정책 409는 동시수정으로 오분류하지 않고 서버 사유를 그대로 안내한다', async ({ page }) => {
    await setup(page);
    await page.route('**/api/peakos/intake', async route => {
      if (route.request().method() === 'PATCH') {
        await route.fulfill({
          status: 409,
          contentType: 'application/json',
          body: JSON.stringify({ code: 'INTAKE_CATALOG_CHANGED', error: '단가표 기준이 변경되어 저장할 수 없습니다.' }),
        });
        return;
      }
      await route.fallback();
    });

    await openView(page, 'settlement');
    await page.locator('[data-intake-edit="imported-intake-1"]').click();
    await page.locator('[data-intake="memo"]').fill('정책 충돌 수정');
    await page.locator('[data-intake-add]').click();

    await expect(page.locator('.toast')).toContainText('단가표 기준이 변경되어 저장할 수 없습니다. 최신 서버 데이터로 다시 불러왔습니다.');
    await expect(page.locator('.toast')).not.toContainText('다른 작업자가 먼저 수정했습니다.');
  });

  test('재무 확정 행 삭제는 역분개 안내와 함께 거부하고 원본을 유지한다', async ({ page }) => {
    const store = await setup(page);
    await openView(page, 'settlement');
    await page.locator('[data-intake-remove="imported-intake-1"]').click();

    await expect(page.locator('.toast')).toContainText('입금·공급처 지급이 확정된 행은 삭제할 수 없습니다. 재무 역분개 후 처리하세요.');
    await expect(page.locator('#moduleView .ledger-table')).toContainText('이관업체');
    expect(store.intake).toHaveLength(1);
  });

  test('연결 자식이 있는 원본 행 삭제는 연결행 우선 정리로 안내한다', async ({ page }) => {
    const store = await setup(page, importedRow({
      id: 'reserve-parent', kind: 'reserve', paid: 'none', paidAmount: 0, vendorPaid: false,
    }));
    store.intake.push(importedRow({
      id: 'reserve-child', kind: 'use', refOf: 'reserve-parent', paid: 'none', paidAmount: 0,
    }));
    await page.reload();
    await expect(page.locator('#authGate')).toBeHidden();
    await openView(page, 'settlement');
    await page.locator('[data-intake-remove="reserve-parent"]').click();

    await expect(page.locator('.toast')).toContainText('연결된 행을 먼저 정리한 뒤 원본 행을 삭제해 주세요.');
    await expect(page.locator('#moduleView .ledger-table tbody tr')).toHaveCount(2);
    expect(store.intake).toHaveLength(2);
  });

  test('입금 저장 실패 시 입금 완료로 보이지 않고 서버 원본을 유지한다', async ({ page }) => {
    const store = await setup(page, importedRow({ paid: 'none', paidAmount: 0, payer: '', paidDate: '', paidMemo: '' }));
    let failNextWrite = true;
    await page.route('**/api/peakos/intake', async route => {
      if (route.request().method() === 'PATCH' && failNextWrite) {
        failNextWrite = false;
        await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: '입금 저장 실패' }) });
        return;
      }
      await route.fallback();
    });

    await openView(page, 'settlement');
    await page.locator('[data-paid-open="imported-intake-1"]').click();
    await page.locator('#paidMemo').fill('매출통장 입금 확인 메모');
    await page.locator('#paidPayer').fill('');
    await page.locator('[data-paid-save]').click();
    await expect(page.locator('.toast')).toContainText('실제 입금자명');
    await expect(page.locator('#readonlyDetailModal')).toBeVisible();
    await page.locator('#paidPayer').fill('이관업체');
    await page.locator('#paidDate').fill('');
    await page.locator('[data-paid-save]').click();
    await expect(page.locator('.toast')).toContainText('실제 입금일');
    await page.locator('#paidDate').fill('2026-08-08');
    await page.locator('[data-paid-save]').click();

    await expect(page.locator('.toast')).toContainText('저장하지 못했습니다. 입금 저장 실패');
    await expect(page.locator('#readonlyDetailModal')).toBeHidden();
    await expect(page.locator('[data-paid-open="imported-intake-1"]')).toContainText('미입금');
    expect(store.intake[0]).toMatchObject({ paid: 'none', paidAmount: 0 });

    await page.locator('[data-paid-open="imported-intake-1"]').click();
    await page.locator('#paidMemo').fill('매출통장 입금 재확인 메모');
    await page.locator('[data-paid-save]').click();
    await expect(page.locator('.toast')).toContainText('입금 110,000원을 1건에 서버 저장했습니다.');
    await expect(page.locator('[data-paid-open="imported-intake-1"]')).toContainText('입금');
    expect(store.intake[0]).toMatchObject({ paid: 'paid', paidAmount: 110_000 });
  });

  test('직접실행 정산서의 기존 등록·삭제 편집 흐름을 유지한다', async ({ page }) => {
    const store = await setup(page);
    await openView(page, 'direct-execution');

    await page.locator('[data-monthly="client"]').fill('직접실행 회귀업체');
    await page.locator('[data-monthly="a"]').selectOption('블로그');
    await page.locator('[data-monthly="b"]').selectOption('원고');
    await page.locator('[data-monthly="c"]').selectOption('프리미엄원고대필');
    await page.locator('[data-monthly="amount"]').fill('400000');
    await page.locator('[data-monthly="qty"]').fill('1');
    await page.locator('[data-monthly-add]').click();

    await expect(page.locator('.toast')).toContainText('직접실행 매출을 등록했습니다.');
    await expect(page.locator('#moduleView')).toContainText('직접실행 회귀업체');
    expect(store.monthly['direct-execution']).toHaveLength(1);

    await page.locator('[data-monthly-remove]').click();
    await expect(page.locator('#moduleView')).not.toContainText('직접실행 회귀업체');
    expect(store.monthly['direct-execution']).toHaveLength(0);
  });
});
