import { test, expect } from '@playwright/test';
import { createPool } from '../../server/db.js';
import { testConfig } from '../database.js';
import { readFile } from 'node:fs/promises';

test.describe.configure({ mode: 'serial' });
async function drag(page, source, target) {
  await source.scrollIntoViewIfNeeded();
  await target.scrollIntoViewIfNeeded();
  const from = await source.boundingBox(),
    to = await target.boundingBox();
  const x = from.x + 5,
    y = from.y + 5;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 10, y, { steps: 5 });
  const viewport = page.viewportSize();
  await page.mouse.move(
    (Math.max(0, to.x) + Math.min(viewport.width, to.x + to.width)) / 2,
    (Math.max(0, to.y) + Math.min(viewport.height, to.y + to.height)) / 2,
    { steps: 10 },
  );
  await page.mouse.up();
}

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
  await expect(page.getByRole('navigation', { name: 'Main', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Kelola workspace', exact: true }).click();
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
    await expect(memberPage.getByRole('navigation', { name: 'Main', exact: true })).toBeVisible();
    await memberPage.getByRole('button', { name: 'Kelola workspace', exact: true }).click();
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
  const [login] = await Promise.all([
    page.waitForResponse(response => response.url().endsWith('/api/auth/login') && response.request().method() === 'POST'),
    page.getByRole('button', { name: 'Login', exact: true }).click(),
  ]);
  expect(login.status(), await login.text()).toBe(200);
  await expect(page.getByRole('navigation', { name: 'Main', exact: true })).toBeVisible();
});

test('all workspace views use shared database content across accounts after clearing browser storage', async ({ page }) => {
  test.setTimeout(60000);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await page.getByLabel('Email', { exact: true }).fill('owner@example.test');
  await page.getByLabel('Password', { exact: true }).fill('updated-browser-password-123');
  await page.getByRole('button', { name: 'Login', exact: true }).click();
  const nav = page.getByRole('navigation', { name: 'Main', exact: true });
  await expect(nav).toBeVisible();
  await expect(page.locator('.native-sync-status')).toHaveText('Tersimpan di database');
  await expect(page.getByText('Website Redesign')).toHaveCount(0);
  for (const route of [
    'overview',
    'projects',
    'tasks',
    'calendar',
    'timeline',
    'members',
    'activity',
    'inbox',
    'mytasks',
    'favorites',
    'notifications',
    'settings',
  ]) {
    await nav.locator(`[data-a="go"][data-r="${route}"]`).first().click();
    await expect(page.locator('.content')).not.toContainText('Something went wrong.');
    await expect(page.locator('.content')).not.toContainText('Page not found');
  }
  await nav.locator('[data-r="home"]').first().click();
  await page.locator('button[data-a="newTask"]').first().click();
  await expect(page.getByRole('heading', { name: 'New project', exact: true })).toBeVisible();
  await page.getByLabel('Project name', { exact: true }).fill('Restored local project');
  await page.getByRole('button', { name: 'Create project', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Restored local project', exact: true })).toBeVisible();
  await page.locator('.content [data-a="go"][data-tab="board"]').click();
  await page.locator('button[data-a="newTask"]').first().click();
  await page.getByLabel('Task name', { exact: true }).fill('Restored local task');
  const today = await page.evaluate(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  });
  await page.locator('[data-id="__form"][data-field="due"]').click();
  await page.locator(`[data-a="popPick"][data-v="${today}"]`).first().click();
  await page.getByRole('button', { name: 'Create task', exact: true }).click();
  await expect(page.locator('.native-sync-status')).toHaveText('Tersimpan di database');
  await drag(page, page.locator('[data-drag-card]').first(), page.locator('[data-drop-col="progress"]'));
  await expect(page.locator('[data-drop-col="progress"] [data-drag-card]')).toHaveCount(1);
  await expect(page.locator('.native-sync-status')).toHaveText('Tersimpan di database');
  let aborted = false;
  await page.route('**/content', route => {
    if (route.request().method() === 'POST' && !aborted) {
      aborted = true;
      return route.abort();
    }
    return route.continue();
  });
  await drag(page, page.locator('[data-drag-card]').first(), page.locator('[data-drop-col="review"]'));
  await expect(page.locator('[data-drop-col="review"] [data-drag-card]')).toHaveCount(1);
  await expect(page.locator('.native-sync-status')).toContainText('Perubahan belum tersimpan');
  await page.getByRole('button', { name: 'Coba simpan lagi', exact: true }).click();
  await expect(page.locator('.native-sync-status')).toHaveText('Tersimpan di database');
  await page.unroute('**/content');
  await page.locator('.content [data-tab="calendar"]').click();
  await expect(page.locator('.native-sync-status')).toHaveText('Tersimpan di database');
  const target = await page
    .locator('.cday:not(.out)[data-drop-day]')
    .evaluateAll((elements, today) => elements.map(el => el.dataset.dropDay).find(day => day !== today), today);
  await drag(page, page.locator('[data-drag-cal]').first(), page.locator(`[data-drop-day="${target}"]`));
  await expect(page.locator(`[data-drop-day="${target}"] [data-drag-cal]`)).toHaveCount(1);
  await expect(page.locator('.native-sync-status')).toHaveText('Tersimpan di database');
  await page.screenshot({ path: 'test-results/restored-workspace.png' });
  for (const tab of ['board', 'list', 'table', 'calendar', 'timeline', 'files', 'overview', 'activity']) {
    await page.locator(`.content [data-a="go"][data-tab="${tab}"]`).first().click();
    await expect(page.locator('.content')).not.toContainText('Something went wrong.');
  }
  await page.locator('.content [data-tab="table"]').click();
  await page.locator('th [data-f="title"]').click();
  await page.locator('td[data-f="estimate"]').click();
  await page.getByLabel('Estimate', { exact: true }).fill('5d');
  await expect(page.locator('.native-sync-status')).toHaveText('Tersimpan di database');
  await expect(page.getByLabel('Estimate', { exact: true })).toHaveValue('5d');
  await page.getByLabel('Estimate', { exact: true }).press('Enter');
  await expect(page.locator('.native-sync-status')).toHaveText('Tersimpan di database');
  await page.locator('td[data-f="title"]').click();
  await page.getByLabel('Title', { exact: true }).fill('Restored local task edited');
  await page.getByLabel('Title', { exact: true }).press('Enter');
  await expect(page.locator('.native-sync-status')).toHaveText('Tersimpan di database');
  await page.locator('.content [data-tab="timeline"]').click();
  const bar = page.locator('[data-bar]').first();
  await bar.scrollIntoViewIfNeeded();
  const barBox = await bar.boundingBox(),
    dayWidth = Number(await bar.getAttribute('data-dw'));
  await page.mouse.move(barBox.x + barBox.width / 2, barBox.y + barBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(barBox.x + barBox.width / 2 + dayWidth * 2, barBox.y + barBox.height / 2, { steps: 10 });
  await page.mouse.up();
  await expect(page.locator('.native-sync-status')).toHaveText('Tersimpan di database');
  const persisted = await page.evaluate(async () => {
    const identity = await (await fetch('/api/auth/me')).json();
    return (await (await fetch(`/api/workspaces/${identity.workspaces[0].id}/content`)).json()).tasks[0];
  });
  expect(persisted.estimate).toBe('5d');
  expect(persisted.title).toBe('Restored local task edited');
  const shifted = new Date(target + 'T00:00:00Z');
  shifted.setUTCDate(shifted.getUTCDate() + 2);
  expect(persisted.due).toBe(shifted.toISOString().slice(0, 10));
  await expect(page.locator('.native-sync-status')).toHaveText('Tersimpan di database');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await expect(nav.getByText('Restored local project', { exact: true })).toBeVisible();
  await expect(page.getByText('Restored local task edited', { exact: true }).first()).toBeVisible();
  await nav.locator('[data-r="project"]').first().click();
  await expect(page.locator('[data-drop-col="review"] [data-drag-card]')).toHaveCount(1);
  await page.locator('[data-pop="filter"]').click();
  await page.locator('[data-a="addFilter"][data-f="status"]').click();
  await page.locator('[data-a="fToggleVal"][data-v="review"]').click();
  await page.getByRole('heading', { name: 'Restored local project', exact: true }).click();
  await page.locator('.content [data-pop="sort"]').click();
  await page.locator('[data-a="setSort"][data-v="title"]').click();
  await page.locator('.content input[data-in="viewQ"]').fill('not-matching');
  await expect(page.locator('[data-drag-card]')).toHaveCount(0);
  await page.locator('.content input[data-in="viewQ"]').fill('Restored');
  await expect(page.locator('[data-drag-card]')).toHaveCount(1);
  await page.locator('[data-a="saveView"]').click();
  await page.getByLabel('View name', { exact: true }).fill('Shared review view');
  await page.getByRole('button', { name: 'Layout', exact: true }).click();
  await page.getByRole('option', { name: 'Table', exact: true }).click();
  await page.locator('[data-a="saveViewSubmit"]').click();
  await expect(page.locator('.native-sync-status')).toHaveText('Tersimpan di database');
  await page.locator('.content').getByRole('button', { name: 'Members', exact: true }).click();
  await page.getByLabel('Proyek privat', { exact: true }).check();
  await page.locator('[data-in="nativeProjectMember"]:not(:disabled)').check();
  await page.getByRole('button', { name: 'Selesai', exact: true }).click();
  await expect(page.locator('.native-sync-status')).toHaveText('Tersimpan di database');
  await page.locator('[data-a="nativeSignOut"]').click();
  await expect(page.getByRole('heading', { name: 'Masuk ke workspace' })).toBeVisible();
  await page.getByLabel('Email', { exact: true }).fill('member@example.test');
  await page.getByLabel('Password', { exact: true }).fill('member-browser-password-123');
  await page.getByRole('button', { name: 'Login', exact: true }).click();
  await expect(nav).toBeVisible();
  await expect(nav.getByText('Restored local project', { exact: true })).toBeVisible();
  await expect(page.getByText('Restored local task edited', { exact: true }).first()).toBeVisible();
  await nav.locator('[data-r="project"]').first().click();
  await page.locator('.content .tab').filter({ hasText: 'Shared review view' }).click();
  await expect(page.locator('.content').getByText('Restored local task edited', { exact: true }).first()).toBeVisible();
  await expect(page.locator('.content input[data-in="viewQ"]')).toHaveValue('Restored');
  await page.locator('.content').getByRole('button', { name: 'Members', exact: true }).click();
  await expect(page.getByLabel('Proyek privat', { exact: true })).toBeChecked();
  await expect(page.getByLabel('Proyek privat', { exact: true })).toBeDisabled();
  expect(errors).toEqual([]);
});
