import { expect, test, type Page, type Route } from '@playwright/test';
import { installFirebaseStub, installPeakosStub } from './helpers';

function intakeRow() {
  return {
    id: 'commission-source-1', owner: 'e2e-test-user', ownerName: '영업테스트',
    date: '2026-08-17', client: '수당테스트업체', expectedPayer: '수당테스트업체',
    a: '매출', b: '플랫폼', c: '리뷰스페이스', unit: 140_000, qty: 1, sell: 200_000,
    expectedDepositAmount: 200_000, cost: null, memo: '', kind: 'normal', refOf: '',
    supplier: '리뷰스페이스', manager: '', finalOnly: false, paid: 'paid', paidAmount: 200_000,
    payer: '수당테스트업체', paidDate: '2026-08-17', paidMemo: '', paidAuto: false,
    vendorPaid: false, vendorPaidDate: '', vendorBank: '', vendorBy: '', vendorMemo: '',
  };
}

function estimate(overrides: Record<string, unknown> = {}) {
  return {
    ownerName: '영업테스트', businessDate: '2026-08-17', platform: 'reviewspace',
    product: { a: '매출', b: '플랫폼', c: '리뷰스페이스' }, status: 'CALCULATED',
    label: '예상 수당', estimatedCommissionAmount: 7_500, payoutEligible: false,
    payoutBlockers: ['SETTLEMENT_COMPLETION_UNCONFIRMED', 'SUPPLIER_RECONCILIATION_INCOMPLETE'], rateBasisPoints: 1250,
    sourceId: 'commission-source-1', sourceRowVersion: 1, salesAmount: 200_000,
    salespersonSupplyAmount: 140_000, commissionBaseAmount: 60_000,
    ...overrides,
  };
}

function send(route: Route, payload: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(payload) });
}

async function openView(page: Page, view: string) {
  const tab = page.locator(`.nav-item[data-view="${view}"]`).first();
  const cluster = tab.locator('xpath=ancestor::*[@data-nav-cluster][1]');
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

async function setup(
  page: Page,
  user: { name: string; role: string; group_name: string; group_type: string; peakos_can_preview_accounts?: boolean },
  commissionHandler: (route: Route) => Promise<void> | void,
) {
  await installFirebaseStub(page);
  const store = await installPeakosStub(page, { uid: 'e2e-test-user', ...user });
  store.intake = [intakeRow()];
  // Playwright evaluates the most recently registered matching route first,
  // so this narrow handler precedes the generic PeakOS fixture.
  await page.route('**/api/peakos/commission-**', commissionHandler);
  await page.goto('/business-os-preview.html');
  await expect(page.locator('#authGate')).toBeHidden();
  return store;
}

test('개인정산서는 영업이익을 유지하고 예상 수당·미설정·충돌을 별도 표시한다', async ({ page }) => {
  const calls: URL[] = [];
  await setup(page, {
    name: '영업테스트', role: 'member', group_name: '본사 영업팀', group_type: 'sales',
  }, async route => {
    const url = new URL(route.request().url());
    calls.push(url);
    if (url.pathname.endsWith('/commission-estimates')) {
      return send(route, {
        range: { from: '2026-08-01', to: '2026-08-31' }, truncated: false,
        estimates: [
          estimate(),
          estimate({ status: 'UNCONFIGURED', label: '규칙 미설정', estimatedCommissionAmount: null, rateBasisPoints: null, sourceId: 'source-2' }),
          estimate({ status: 'RULE_OVERLAP', label: '규칙 충돌', estimatedCommissionAmount: null, rateBasisPoints: null, sourceId: 'source-3' }),
        ],
      });
    }
    return send(route, { rules: [] });
  });

  await openView(page, 'settlement');
  const panel = page.locator('[data-commission-estimates]');
  await expect(panel).toHaveAttribute('data-state', 'ready');
  await expect(panel.locator('[data-estimated-commission-total]')).toHaveText('₩7,500');
  await expect(panel).toContainText('예상 · 지급확정 아님');
  await expect(panel.locator('.commission-payable')).toHaveCount(0);
  await expect(panel.locator('[data-commission-status="CALCULATED"]')).toContainText('예상 · 지급확정 아님');
  await expect(panel.locator('[data-commission-status="UNCONFIGURED"]')).toContainText('규칙 미설정');
  await expect(panel.locator('[data-commission-status="UNCONFIGURED"] td').nth(4)).toHaveText('—');
  await expect(panel.locator('[data-commission-status="RULE_OVERLAP"]')).toContainText('규칙 충돌');
  await expect(panel.locator('[data-commission-status="RULE_OVERLAP"] td').nth(4)).toHaveText('—');
  await expect(page.locator('#moduleView')).toContainText('영업이익');

  expect(calls).toHaveLength(1);
  expect(calls[0].pathname).toBe('/api/peakos/commission-estimates');
  expect(calls[0].searchParams.get('ownerUid')).toBe('e2e-test-user');
});

test('탭을 떠난 뒤 늦게 도착한 예상 수당 응답은 되돌아온 화면을 덮지 않는다', async ({ page }) => {
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
  let estimateCalls = 0;
  await setup(page, {
    name: '영업테스트', role: 'member', group_name: '본사 영업팀', group_type: 'sales',
  }, async route => {
    const url = new URL(route.request().url());
    if (!url.pathname.endsWith('/commission-estimates')) return send(route, { rules: [] });
    estimateCalls += 1;
    const call = estimateCalls;
    if (call === 1) await firstGate;
    return send(route, {
      range: { from: '2026-08-01', to: '2026-08-31' }, truncated: false,
      estimates: [estimate({ estimatedCommissionAmount: call === 1 ? 1_111 : 2_222 })],
    });
  });

  await openView(page, 'settlement');
  await expect.poll(() => estimateCalls).toBe(1);
  await openView(page, 'calendar');
  await openView(page, 'settlement');
  await expect(page.locator('[data-estimated-commission-total]')).toHaveText('₩2,222');
  releaseFirst();
  await page.waitForTimeout(100);
  await expect(page.locator('[data-estimated-commission-total]')).toHaveText('₩2,222');
  expect(estimateCalls).toBe(2);
});

test('계정 미리보기에서는 수당 API 요청이 0건이다', async ({ page }) => {
  let commissionCalls = 0;
  await setup(page, {
    name: '패션TV봉이', role: 'admin', group_name: '본사 경영지원팀', group_type: 'support',
    peakos_can_preview_accounts: true,
  }, route => {
    commissionCalls += 1;
    return send(route, { range: { from: '2026-08-01', to: '2026-08-31' }, estimates: [], rules: [] });
  });

  await page.locator('#personaSelect').selectOption('김대호');
  await openView(page, 'settlement');
  await page.waitForTimeout(150);
  expect(commissionCalls).toBe(0);
  await expect(page.locator('#moduleView')).toContainText('읽기 전용');
});

test('관리자는 명시 수당률 규칙을 초안으로 만들고 별도 승인한다', async ({ page }) => {
  const rules: any[] = [];
  const writes: Array<{ path: string; body: any }> = [];
  await setup(page, {
    name: '김대호', role: 'manager', group_name: '본사 경영지원팀', group_type: 'support',
  }, route => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const body = request.postData() ? request.postDataJSON() : {};
    if (request.method() === 'GET' && path.endsWith('/commission-estimates')) {
      return send(route, { range: { from: '2026-08-01', to: '2026-08-31' }, estimates: [], truncated: false });
    }
    if (request.method() === 'GET' && path.endsWith('/commission-rules')) return send(route, { rules });
    if (request.method() === 'POST' && path.endsWith('/commission-rules')) {
      writes.push({ path, body });
      const rule = {
        seriesId: '11111111-1111-4111-8111-111111111111', version: 1, status: 'DRAFT',
        scope: {
          ownerUid: body.scopeOwnerUid, platform: body.scopePlatform,
          productA: body.scopeProductA, productB: body.scopeProductB, productC: body.scopeProductC,
        },
        rateBasisPoints: body.rateBasisPoints, ratePercent: body.rateBasisPoints / 100,
        effectiveFrom: body.effectiveFrom, effectiveTo: body.effectiveTo,
        reason: body.reason, actorName: '김대호', createdAt: '2026-08-17T12:00:00.000Z',
      };
      rules.splice(0, rules.length, rule);
      return send(route, { rule }, 201);
    }
    if (request.method() === 'POST' && path.endsWith('/approve')) {
      writes.push({ path, body });
      rules[0] = { ...rules[0], status: 'APPROVED', version: 2, reason: body.reason };
      return send(route, { rule: rules[0] });
    }
    return send(route, { error: 'unexpected commission request' }, 500);
  });

  await openView(page, 'settlement');
  const manager = page.locator('[data-commission-rule-manager]');
  await expect(manager).toHaveAttribute('data-state', 'ready');
  await manager.locator('[name="scopePlatform"]').selectOption('reviewspace');
  await manager.locator('[name="scopeProductA"]').fill('매출');
  await manager.locator('[name="scopeProductB"]').fill('플랫폼');
  await manager.locator('[name="scopeProductC"]').fill('리뷰스페이스');
  await manager.locator('[name="ratePercent"]').fill('12.50');
  await manager.locator('[name="reason"]').fill('리뷰스페이스 계약 수당률 확인 완료');
  await manager.locator('[data-commission-rule-form] button[type="submit"]').click();
  const row = manager.locator('[data-commission-rule]');
  await expect(row).toHaveAttribute('data-rule-status', 'DRAFT');
  expect(writes[0].body.rateBasisPoints).toBe(1250);
  expect(writes[0].body.scopeProductA).toBe('매출');

  page.once('dialog', dialog => dialog.accept('계약서와 플랫폼 적용 범위를 최종 확인함'));
  await row.locator('[data-commission-rule-action="approve"]').click();
  await expect(manager.locator('[data-commission-rule]')).toHaveAttribute('data-rule-status', 'APPROVED');
  await expect(manager.locator('[data-commission-rule]')).toContainText('적용 중');
  expect(writes[1].body).toEqual({ expectedVersion: 1, reason: '계약서와 플랫폼 적용 범위를 최종 확인함' });
});
