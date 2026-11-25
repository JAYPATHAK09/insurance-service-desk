import { expect, test } from '@playwright/test';

test('sign in as handler, see the queue with attention rows first, open a case', async ({ page }) => {
  await page.goto('/signin');
  await page.getByTestId('signin-handler').click();
  await expect(page.getByRole('heading', { name: 'Case queue' })).toBeVisible();
  const first = page.locator('[data-testid=case-queue] tbody tr').first();
  await expect(first).toHaveAttribute('data-attention', 'true');
  await first.getByRole('link').first().click();
  await expect(page.getByRole('navigation', { name: 'Case sections' })).toBeVisible();
  await expect(page.getByText('Independent proof-of-work demo')).toBeVisible();
});
