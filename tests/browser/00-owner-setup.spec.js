import { test, expect } from '@playwright/test';

test('operator creates the initial owner through protected setup and the page then closes', async ({ page }) => {
  await page.goto('/#setup');
  await expect(page.getByRole('heading', { name: 'Create owner account' })).toBeVisible();
  await page.getByLabel('Setup key', { exact: true }).fill('wrong-browser-setup-key-'.repeat(2));
  await page.getByLabel('Full name').fill('Test Owner');
  await page.getByLabel('Owner email').fill('owner@example.test');
  await page.getByLabel('Workspace name', { exact: true }).fill('Team browser');
  await page.getByLabel('New password', { exact: true }).fill('browser-test-password-123');
  await page.getByLabel('Confirm password').fill('browser-test-password-123');
  await page.getByRole('button', { name: 'Create owner account', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Incorrect setup key');
  const key = 'browser-only-setup-token-not-for-deployment-123';
  await page.getByLabel('Setup key', { exact: true }).fill(key);
  const [created] = await Promise.all([
    page.waitForResponse(response => response.url().endsWith('/api/auth/setup') && response.request().method() === 'POST'),
    page.getByRole('button', { name: 'Create owner account', exact: true }).click(),
  ]);
  expect(created.status(), await created.text()).toBe(201);
  await expect(page.getByRole('heading', { name: 'Sign in to your workspace' })).toBeVisible();
  expect(page.url()).not.toContain(key);
  await page.goto('/#setup');
  await expect(page.getByRole('heading', { name: 'Owner setup unavailable' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create owner account', exact: true })).toHaveCount(0);
});
