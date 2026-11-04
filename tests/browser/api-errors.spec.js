import { test, expect } from '@playwright/test';

test('plain-text platform 404 displays a readable error instead of a JSON parser exception', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/**', route => route.fulfill({ status: 404, contentType: 'text/plain', body: 'The page could not be found\nNOT_FOUND' }));
  await page.goto('/');
  await expect(page.getByRole('alert')).toContainText('account service is unavailable');
  await page.getByLabel('Email', { exact: true }).fill('owner@example.test');
  await page.getByLabel('Password', { exact: true }).fill('browser-test-password-123');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('account service is unavailable');
  await expect(page.locator('body')).not.toContainText('Unexpected token');
  expect(errors).toEqual([]);
});

test('an API failure does not incorrectly claim that owner setup is closed', async ({ page }) => {
  await page.route('**/api/**', route => route.fulfill({ status: 404, contentType: 'text/plain', body: 'The page could not be found' }));
  await page.goto('/#setup');
  await expect(page.getByRole('alert')).toContainText('account service is unavailable');
  await expect(page.getByRole('heading', { name: 'Could not load setup' })).toBeVisible();
  await expect(page.locator('body')).not.toContainText('the first account already exists');
});
