import { test, expect } from '@playwright/test';
import { installFirebaseStub, installPeakosStub } from './helpers';

const OPEN = ['김진봉', '손명아', '김대호', '박종원', '전현우'];
const CLOSED = ['김지홍', '박우진', '김주현', '김용일', '은시후', '이종혁', '김동우'];

for (const name of [...OPEN, ...CLOSED]) {
  const open = OPEN.includes(name);
  test(`탭 공개 - ${name}`, async ({ page }) => {
    await installFirebaseStub(page);
    await installPeakosStub(page, { name, group_name: '본사 영업팀' });
    await page.setViewportSize({ width: 1400, height: 1000 });
    await page.goto('/business-os-preview.html');
    await expect(page.locator('#authGate')).toBeHidden();
    // 클러스터를 다 펼쳐서 실제 노출을 본다
    for (const c of await page.locator('[data-nav-cluster] .nav-cluster-toggle').all()) {
      if (await c.isVisible()) await c.click();
    }
    const visible = await page.locator('.app-sidebar .nav-item[data-view]:not([hidden])')
      .evaluateAll(els => els.map(e => (e as HTMLElement).dataset.view));
    console.log(`${name.padEnd(4)} ${open ? '전체' : '기본'} · ${visible.length}개: ${visible.join(' ')}`);

    if (open) {
      for (const v of ['settlement', 'final-settlement', 'credit', 'closing', 'organization', 'namecard']) {
        expect(visible, `${name} 은 ${v} 가 보여야`).toContain(v);
      }
      // 미수금 현황은 그 안에서도 대표·김대호·박종원만
      const ar = ['김진봉', '김대호', '박종원'].includes(name);
      expect(visible.includes('receivable'), `${name} 미수금 현황`).toBe(ar);
    } else {
      expect(visible.sort()).toEqual(['calendar', 'chat', 'dashboard', 'review', 'todo']);
      // 감춰도 눌러서 들어갈 수는 없어야 한다
      await page.evaluate(() => (document.querySelector('.nav-item[data-view="settlement"]') as HTMLElement)?.click());
      await expect(page.locator('#moduleView')).toBeHidden();
      await expect(page.locator('#dashboardView')).toBeVisible();
    }
  });
}
