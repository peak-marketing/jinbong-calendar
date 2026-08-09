import { test, expect } from '@playwright/test';
import { installFirebaseStub, installPeakosStub } from './helpers';

test('회사 자료에서 회사·지사와 거래처 사업자등록증을 분리한다', async ({ page }) => {
  await installFirebaseStub(page);
  await installPeakosStub(page, {
    name: '김대호',
    uid: 'e2e-test-user',
    role: 'manager',
    group_name: '본사 경영지원팀',
  });

  await page.goto('/business-os-preview.html');
  await expect(page.locator('#authGate')).toBeHidden();
  await page.locator('.nav-item[data-view="company"]').click();

  await expect(page.locator('[data-company-certificate-folders] [data-company-folder]')).toHaveCount(2);
  await expect(page.locator('[data-company-folder="branches"]')).toContainText('본사 및 지사 사업자등록증');
  await expect(page.locator('[data-company-folder="clients"]')).toContainText('거래처 사업자등록증');

  const certificates = page.locator('[data-company-folder-content="branches"] [data-company-certificate]');
  await expect(certificates).toHaveCount(3);
  await expect(certificates.nth(0)).toContainText('본사 사업자등록증');
  await expect(certificates.nth(1)).toContainText('전주 지사 사업자등록증');
  await expect(certificates.nth(2)).toContainText('대구 지사 사업자등록증');
  await expect(certificates).toContainText(['보호 저장소 연결 대기', '보호 저장소 연결 대기', '보호 저장소 연결 대기']);

  await expect(page.locator('[data-company-folder-content="clients"]')).toContainText('등록된 거래처 사업자등록증이 없습니다');
  await expect(page.locator('[data-company-folder-content] img')).toHaveCount(0);

  await page.setViewportSize({ width: 390, height: 844 });
  const widths = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    document: document.documentElement.scrollWidth,
  }));
  expect(widths.document).toBeLessThanOrEqual(widths.viewport + 1);
});
