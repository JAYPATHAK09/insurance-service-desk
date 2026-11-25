import { expect, test, type Page } from '@playwright/test';

// Runs against a freshly seeded synthetic database (see README). Cases are looked up by reference.

async function signIn(page: Page, role: 'handler' | 'supervisor' | 'analyst') {
  await page.context().clearCookies();
  await page.goto('/signin');
  await page.getByTestId(`signin-${role}`).click();
  await expect(page.getByRole('heading', { name: 'Case queue' })).toBeVisible();
}

async function caseHref(page: Page, ref: string) {
  await page.goto('/');
  const href = await page.getByRole('link', { name: ref, exact: true }).first().getAttribute('href');
  expect(href).toMatch(/^\/cases\//);
  return href!;
}

/** Click the first matching button and wait for the server action to settle. */
async function act(page: Page, name: string | RegExp) {
  await page.getByRole('button', { name }).first().click();
  await page.waitForLoadState('networkidle');
}

test.describe.serial('module smoke', () => {
  test('claim: review, decide every finding, handler approval, supervisor approval', async ({ page }) => {
    await signIn(page, 'handler');
    const href = await caseHref(page, 'FX-CLM-200');
    await page.goto(`${href}/claim-reconciler`);
    await act(page, 'Re-run review');
    const accept = page.getByRole('button', { name: /Verified: accept/i });
    let left = await accept.count();
    expect(left).toBeGreaterThan(0);
    while (left > 0) {
      await accept.first().click();
      left--;
      await expect(accept).toHaveCount(left);
    }
    await act(page, /approve as handler/);
    await expect(page.getByText(/READY \(approved by handler/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Supervisor approval' })).toHaveCount(0);

    await signIn(page, 'supervisor');
    await page.goto(`${href}/claim-reconciler`);
    await act(page, 'Supervisor approval');
    await expect(page.getByText(/Supervisor approval: /)).toBeVisible();
  });

  test('disclosure: run comparison, resolve a finding, export CSV', async ({ page }) => {
    await signIn(page, 'handler');
    const href = await caseHref(page, 'DSC-F-004');
    await page.goto(`${href}/disclosure-checker`);
    await act(page, 'Run comparison');
    const summary = page.getByText(/\d+ finding\(s\), (\d+) open/);
    const open = Number((await summary.innerText()).match(/, (\d+) open/)![1]);
    expect(open).toBeGreaterThan(0);
    await page.getByText('Mark resolved without a change').first().click();
    await page.getByLabel('Note (required)').first().fill('Checked against the customer confirmation');
    await act(page, 'Resolve');
    await expect(page.getByText(new RegExp(`\\d+ finding\\(s\\), ${open - 1} open`))).toBeVisible();
    const res = await page.request.get(`${href}/disclosure-checker/export?format=csv`);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('csv');
    expect((await res.text()).split('\n').length).toBeGreaterThan(1);
  });

  test('renewal: run review, decide a term', async ({ page }) => {
    await signIn(page, 'handler');
    const href = await caseHref(page, 'REN-FX-101');
    await page.goto(`${href}/renewal-agent`);
    await act(page, 'Run review');
    const decide = page.getByText('Decide', { exact: true });
    const before = await decide.count();
    expect(before).toBeGreaterThan(0);
    await decide.first().click();
    await page.getByRole('button', { name: /^Confirm/i }).first().click();
    await expect(decide).toHaveCount(before - 1);
    await expect(page.getByText('Change decision').first()).toBeVisible();
  });

  test('dashboard: supervisor and analyst yes, handler refused', async ({ page }) => {
    await signIn(page, 'supervisor');
    await expect(page.getByRole('link', { name: 'Dashboard' })).toBeVisible();
    expect((await page.goto('/dashboard'))!.status()).toBe(200);
    await expect(page.getByTestId('banner-fixture')).toBeVisible();
    const csv = await page.request.get('/api/kpi/export');
    expect(csv.status()).toBe(200);
    await signIn(page, 'analyst');
    await expect(page.getByRole('link', { name: 'Dashboard' })).toBeVisible();
    await signIn(page, 'handler');
    await expect(page.getByRole('link', { name: 'Dashboard' })).toHaveCount(0);
    await page.goto('/dashboard');
    await expect(page.getByText('Your role does not have access')).toBeVisible();
    await expect(page.getByTestId('banner-fixture')).toHaveCount(0);
    expect((await page.request.get('/api/kpi/export')).status()).toBe(403);
  });

  test('handler cannot open or export a case owned by someone else', async ({ page }) => {
    await signIn(page, 'supervisor');
    const href = await caseHref(page, 'CLM-1003');
    await signIn(page, 'handler');
    for (const p of [href, `${href}/claim-reconciler`, `${href}/claim-reconciler/chronology?format=csv`, `${href}/claim-reconciler/draft`]) {
      const r = await page.request.get(p, { maxRedirects: 0 });
      expect([403, 404]).toContain(r.status());
    }
    await page.context().clearCookies();
    const anon = await page.request.get(href, { maxRedirects: 0 });
    expect([302, 307, 401, 403]).toContain(anon.status());
  });
});
