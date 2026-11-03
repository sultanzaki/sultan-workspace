import { test, expect } from '@playwright/test';

test('operator creates the initial owner through protected setup and the page then closes', async ({ page }) => {
  await page.goto('/#setup');
  await expect(page.getByRole('heading', { name: 'Buat akun owner' })).toBeVisible();
  await page.getByLabel('Kunci setup', { exact: true }).fill('wrong-browser-setup-key-'.repeat(2));
  await page.getByLabel('Nama lengkap').fill('Test Owner');
  await page.getByLabel('Email owner').fill('owner@example.test');
  await page.getByLabel('Nama workspace', { exact: true }).fill('Tim browser');
  await page.getByLabel('Password baru', { exact: true }).fill('browser-test-password-123');
  await page.getByLabel('Ulangi password').fill('browser-test-password-123');
  await page.getByRole('button', { name: 'Buat akun owner', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Kunci setup tidak sesuai');
  const key = 'browser-only-setup-token-not-for-deployment-123';
  await page.getByLabel('Kunci setup', { exact: true }).fill(key);
  const [created] = await Promise.all([
    page.waitForResponse(response => response.url().endsWith('/api/auth/setup') && response.request().method() === 'POST'),
    page.getByRole('button', { name: 'Buat akun owner', exact: true }).click(),
  ]);
  expect(created.status(), await created.text()).toBe(201);
  await expect(page.getByRole('heading', { name: 'Masuk ke workspace' })).toBeVisible();
  expect(page.url()).not.toContain(key);
  await page.goto('/#setup');
  await expect(page.getByRole('heading', { name: 'Setup owner tidak tersedia' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Buat akun owner', exact: true })).toHaveCount(0);
});
