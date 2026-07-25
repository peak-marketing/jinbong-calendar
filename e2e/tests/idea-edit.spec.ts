import { test, expect } from '@playwright/test';
import { defaultApiState, setupStubs } from './helpers';

test.describe('idea editing', () => {
  test.beforeEach(async ({ page }) => {
    await setupStubs(page, {
      ...defaultApiState(),
      ideas: [{
        id: 'idea-1',
        title: '초기 아이디어',
        category: '서비스',
        source: '@old',
        url: 'https://old.example',
        summary: '기존 요약',
        detail: '기존 상세',
        scope: 'personal',
        owner_id: 'e2e-test-user',
        owner_name: 'E2E',
        created_at: '2026-04-27T00:00:00.000Z',
      }],
    });
    await page.goto('/');
    await page.waitForSelector('.cal-grid.month-grid', { timeout: 15_000 });
    await page.addStyleTag({ content: '#swUpdateBanner{display:none!important}' });
  });

  test('owner can update an existing idea from the detail modal', async ({ page }) => {
    await page.evaluate(() => (window as any).navTo('idea'));
    await expect(page.getByText('초기 아이디어')).toBeVisible();

    await page.getByText('초기 아이디어').click();
    await expect(page.locator('#modalContent').getByText('기존 요약')).toBeVisible();
    await page.getByRole('button', { name: '수정' }).click();

    await page.locator('#ideaEditTitle').fill('수정된 아이디어');
    await page.locator('#ideaEditSource').fill('@new');
    await page.locator('#ideaEditUrl').fill('https://new.example');
    await page.locator('#ideaEditSummary').fill('수정된 요약');
    await page.locator('#ideaEditDetail').fill('수정된 상세');
    await page.getByRole('button', { name: '저장' }).click();

    await expect(page.locator('#modalContent').getByText('수정된 아이디어')).toBeVisible();
    await expect(page.locator('#modalContent').getByText('수정된 요약')).toBeVisible();

    const saved = await page.evaluate(() => (window as any).__e2e_api_state.ideas[0]);
    expect(saved.title).toBe('수정된 아이디어');
    expect(saved.source).toBe('@new');
    expect(saved.url).toBe('https://new.example');
    expect(saved.summary).toBe('수정된 요약');
    expect(saved.detail).toBe('수정된 상세');
    expect(saved.category).toBe('서비스');
  });
});
