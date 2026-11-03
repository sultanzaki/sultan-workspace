import { test, expect } from '@playwright/test';
import { createPool } from '../../server/db.js';
import { testConfig } from '../database.js';
import { readFile } from 'node:fs/promises';

test.describe.configure({ mode: 'serial' });

async function mailToken(recipient, kind) {
  const pool = createPool(testConfig());
  try {
    const result = await pool.query('SELECT id,body FROM mail_outbox WHERE recipient=$1 ORDER BY created_at DESC LIMIT 1', [recipient]);
    const mail = result.rows[0];
    let text = mail.body;
    if (!text) text = JSON.parse(await readFile(`.local/e2e-mail/${mail.id}.json`, 'utf8')).text;
    return text.match(new RegExp(`#${kind}=([a-f0-9]{64})`))[1];
  } finally {
    await pool.end();
  }
}

test('owner invites a member; member joins, reloads and logs out with no demo data', async ({ page, browser }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Masuk ke workspace' })).toBeVisible();
  await page.getByLabel('Email', { exact: true }).fill('owner@example.test');
  await page.getByLabel('Password', { exact: true }).fill('incorrect');
  await page.getByRole('button', { name: 'Login', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Email atau password tidak sesuai');
  await page.getByLabel('Password', { exact: true }).fill('browser-test-password-123');
  await page.getByRole('button', { name: 'Login', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Tim browser', exact: true })).toBeVisible();
  await expect(page.getByText('Website Redesign')).toHaveCount(0);
  const ids = await page.locator('[id]').evaluateAll(elements => elements.map(element => element.id));
  expect(new Set(ids).size).toBe(ids.length);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Tim browser', exact: true })).toBeVisible();
  await page.getByLabel('Nama tim', { exact: true }).fill('Engineering');
  await page.getByRole('button', { name: 'Buat tim', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Engineering', exact: true })).toBeVisible();
  await page.getByLabel('Email penerima', { exact: true }).fill('member@example.test');
  await page.getByRole('button', { name: 'Kirim undangan', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Undangan masuk antrean');
  const invite = await mailToken('member@example.test', 'invite');
  const memberContext = await browser.newContext({ baseURL: 'http://localhost:5173' });
  const memberPage = await memberContext.newPage();
  try {
    await memberPage.goto(`/#invite=${invite}`);
    await expect(memberPage.getByRole('heading', { name: 'Bergabung ke Tim browser' })).toBeVisible();
    expect(memberPage.url()).not.toContain(invite);
    await memberPage.getByLabel('Nama lengkap').fill('<img src=x onerror=alert(1)>');
    await memberPage.getByLabel('Password baru', { exact: true }).fill('member-browser-password-123');
    const [accepted] = await Promise.all([
      memberPage.waitForResponse(response => response.url().endsWith('/api/auth/invitations/accept')),
      memberPage.getByRole('button', { name: 'Terima undangan' }).click(),
    ]);
    expect(accepted.status(), await accepted.text()).toBe(201);
    await expect(memberPage.getByRole('heading', { name: 'Tim browser', exact: true })).toBeVisible();
    await expect(memberPage.locator('img')).toHaveCount(0);
    await expect(memberPage.getByRole('heading', { name: 'Undang anggota' })).toHaveCount(0);
    await expect(memberPage.getByRole('button', { name: 'Buat tim', exact: true })).toHaveCount(0);
    await expect(memberPage.getByText('Peran Anda:')).toContainText('member');
    await memberPage.reload();
    await expect(memberPage.getByRole('heading', { name: 'Tim browser', exact: true })).toBeVisible();
    await memberPage.getByRole('button', { name: 'Logout', exact: true }).click();
    await expect(memberPage.getByRole('heading', { name: 'Masuk ke workspace' })).toBeVisible();
    await memberPage.reload();
    await expect(memberPage.getByRole('heading', { name: 'Masuk ke workspace' })).toBeVisible();
  } finally {
    await memberContext.close();
  }
  await page.getByRole('button', { name: 'Muat ulang', exact: true }).click();
  await expect(page.getByRole('cell', { name: 'member@example.test', exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.mouse.wheel(0, 800);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});

test('password recovery changes credentials and the old password stops working', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Lupa password?' }).click();
  await page.getByLabel('Email', { exact: true }).fill('owner@example.test');
  await page.getByRole('button', { name: 'Kirim instruksi reset' }).click();
  await expect(page.getByRole('status')).toContainText('Jika akun terdaftar');
  const reset = await mailToken('owner@example.test', 'reset');
  await page.goto(`/#reset=${reset}`);
  await expect(page.getByRole('heading', { name: 'Password baru' })).toBeVisible();
  await page.getByLabel('Password baru', { exact: true }).fill('updated-browser-password-123');
  await page.getByLabel('Ulangi password').fill('updated-browser-password-123');
  await page.getByRole('button', { name: 'Simpan password' }).click();
  await expect(page.getByRole('heading', { name: 'Masuk ke workspace' })).toBeVisible();
  await page.getByLabel('Email', { exact: true }).fill('owner@example.test');
  await page.getByLabel('Password', { exact: true }).fill('browser-test-password-123');
  await page.getByRole('button', { name: 'Login', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Email atau password tidak sesuai');
  await page.getByLabel('Password', { exact: true }).fill('updated-browser-password-123');
  await page.getByRole('button', { name: 'Login', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Tim browser', exact: true })).toBeVisible();
});
