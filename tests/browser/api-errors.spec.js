import { test, expect } from '@playwright/test';

test('plain-text platform 404 displays a readable error instead of a JSON parser exception', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/**', route => route.fulfill({ status: 404, contentType: 'text/plain', body: 'The page could not be found\nNOT_FOUND' }));
  await page.goto('/');
  await expect(page.getByRole('alert')).toContainText('Layanan akun belum tersedia');
  await page.getByLabel('Email', { exact: true }).fill('owner@example.test');
  await page.getByLabel('Password', { exact: true }).fill('browser-test-password-123');
  await page.getByRole('button', { name: 'Login', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Layanan akun belum tersedia');
  await expect(page.locator('body')).not.toContainText('Unexpected token');
  expect(errors).toEqual([]);
});

test('an API failure does not incorrectly claim that owner setup is closed', async ({ page }) => {
  await page.route('**/api/**', route => route.fulfill({ status: 404, contentType: 'text/plain', body: 'The page could not be found' }));
  await page.goto('/#setup');
  await expect(page.getByRole('alert')).toContainText('Layanan akun belum tersedia');
  await expect(page.getByRole('heading', { name: 'Setup belum dapat dimuat' })).toBeVisible();
  await expect(page.locator('body')).not.toContainText('akun pertama sudah dibuat');
});
