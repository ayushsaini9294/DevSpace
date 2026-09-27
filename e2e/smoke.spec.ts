import { expect, test } from '@playwright/test';

test('home page shows the app name and a healthy API', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByRole('heading', { level: 1, name: 'DevSpace' })).toBeVisible();
  await expect(page.getByTestId('api-status')).toHaveText('API: ok');
});
