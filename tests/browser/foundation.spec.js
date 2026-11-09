import { test, expect } from '@playwright/test';
import { createPool } from '../../server/db.js';
import { testConfig } from '../database.js';
import { readFile } from 'node:fs/promises';

test.describe.configure({ mode: 'serial' });
async function openSettings(page, section = 'members') {
  await page.getByRole('navigation', { name: 'Main', exact: true }).locator('[data-r="settings"]').first().click();
  await page.locator(`.set-nav [data-sec="${section}"]`).click();
}
async function signOut(page) {
  const closeDrawer = page.locator('.drawer [data-a="closeDrawer"]');
  if (await closeDrawer.count()) await closeDrawer.first().click();
  await page.getByRole('button', { name: 'Account menu', exact: true }).click();
  await page.locator('.pop [data-a="signOut"]').click();
}

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
  await expect(page.getByRole('heading', { name: 'Sign in to your workspace' })).toBeVisible();
  await expect(page).toHaveTitle('Team account · Sultan Workspace');
  await expect(page.getByRole('link', { name: 'Sultan Workspace home' })).toBeVisible();
  await page.screenshot({ path: 'test-results/sultan-login-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/sultan-login-mobile.png', fullPage: true });
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.getByLabel('Email', { exact: true }).fill('owner@example.test');
  await page.getByLabel('Password', { exact: true }).fill('incorrect');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Incorrect email or password');
  await page.getByLabel('Password', { exact: true }).fill('browser-test-password-123');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('navigation', { name: 'Main', exact: true })).toBeVisible();
  await page.goto('/?manage=1');
  await expect(page.getByRole('heading', { name: 'Team browser', exact: true })).toBeVisible();
  await expect(page.getByText('Website Redesign')).toHaveCount(0);
  const ids = await page.locator('[id]').evaluateAll(elements => elements.map(element => element.id));
  expect(new Set(ids).size).toBe(ids.length);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Team browser', exact: true })).toBeVisible();
  await page.getByLabel('Team name', { exact: true }).fill('Engineering');
  await page.getByRole('button', { name: 'Create team', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Engineering', exact: true })).toBeVisible();
  await page.getByLabel('Recipient email', { exact: true }).fill('member@example.test');
  await page.getByRole('button', { name: 'Send invitation', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Invitation queued');
  const invite = await mailToken('member@example.test', 'invite');
  const memberContext = await browser.newContext({ baseURL: 'http://localhost:5173' });
  const memberPage = await memberContext.newPage();
  try {
    await memberPage.goto(`/#invite=${invite}`);
    await expect(memberPage.getByRole('heading', { name: 'Join Team browser' })).toBeVisible();
    expect(memberPage.url()).not.toContain(invite);
    await memberPage.getByLabel('Full name').fill('<img src=x onerror=alert(1)>');
    await memberPage.getByLabel('New password', { exact: true }).fill('member-browser-password-123');
    const [accepted] = await Promise.all([
      memberPage.waitForResponse(response => response.url().endsWith('/api/auth/invitations/accept')),
      memberPage.getByRole('button', { name: 'Accept invitation' }).click(),
    ]);
    expect(accepted.status(), await accepted.text()).toBe(201);
    await expect(memberPage.getByRole('navigation', { name: 'Main', exact: true })).toBeVisible();
    await memberPage.goto('/?manage=1');
    await expect(memberPage.getByRole('heading', { name: 'Team browser', exact: true })).toBeVisible();
    await expect(memberPage.locator('.foundation-main img')).toHaveCount(0);
    await expect(memberPage.getByRole('heading', { name: 'Invite member' })).toHaveCount(0);
    await expect(memberPage.getByRole('button', { name: 'Create team', exact: true })).toHaveCount(0);
    await expect(memberPage.getByText('Your role:')).toContainText('member');
    await memberPage.reload();
    await expect(memberPage.getByRole('heading', { name: 'Team browser', exact: true })).toBeVisible();
    await memberPage.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(memberPage.getByRole('heading', { name: 'Sign in to your workspace' })).toBeVisible();
    await memberPage.reload();
    await expect(memberPage.getByRole('heading', { name: 'Sign in to your workspace' })).toBeVisible();
  } finally {
    await memberContext.close();
  }
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByRole('cell', { name: 'member@example.test', exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.mouse.wheel(0, 800);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});

test('password recovery changes credentials and the old password stops working', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Forgot password?' }).click();
  await page.getByLabel('Email', { exact: true }).fill('owner@example.test');
  await page.getByRole('button', { name: 'Send reset instructions' }).click();
  await expect(page.getByRole('status')).toContainText('If the account exists');
  const reset = await mailToken('owner@example.test', 'reset');
  await page.goto(`/#reset=${reset}`);
  await expect(page.getByRole('heading', { name: 'New password' })).toBeVisible();
  await page.getByLabel('New password', { exact: true }).fill('updated-browser-password-123');
  await page.getByLabel('Confirm password').fill('updated-browser-password-123');
  await page.getByRole('button', { name: 'Save password' }).click();
  await expect(page.getByRole('heading', { name: 'Sign in to your workspace' })).toBeVisible();
  await page.getByLabel('Email', { exact: true }).fill('owner@example.test');
  await page.getByLabel('Password', { exact: true }).fill('browser-test-password-123');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Incorrect email or password');
  await page.getByLabel('Password', { exact: true }).fill('updated-browser-password-123');
  const [login] = await Promise.all([
    page.waitForResponse(response => response.url().endsWith('/api/auth/login') && response.request().method() === 'POST'),
    page.getByRole('button', { name: 'Sign in', exact: true }).click(),
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
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  const nav = page.getByRole('navigation', { name: 'Main', exact: true });
  await expect(nav).toBeVisible();
  await expect(page.locator('.native-sync-status')).toHaveAttribute('data-state', 'saved');
  await expect(page.locator('.native-sync-status')).toBeHidden();
  await expect(page.locator('.native-workspace-notice')).toBeHidden();
  await expect(
    page.locator(
      '.native-workspace-notice [data-a="nativeRefresh"], .native-workspace-notice [data-a="nativeManage"], .native-workspace-notice [data-a="nativeSignOut"]',
    ),
  ).toHaveCount(0);
  await expect(page.getByText('Tersimpan di database')).toHaveCount(0);
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
  await page.getByLabel('Project name', { exact: true }).fill('Proyek tim pengguna');
  await page.getByRole('button', { name: 'Create project', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Proyek tim pengguna', exact: true })).toBeVisible();
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
  await expect(page.locator('.native-sync-status')).toHaveAttribute('data-state', 'saved');
  await drag(page, page.locator('[data-drag-card]').first(), page.locator('[data-drop-col="progress"]'));
  await expect(page.locator('[data-drop-col="progress"] [data-drag-card]')).toHaveCount(1);
  await expect(page.locator('.native-sync-status')).toHaveAttribute('data-state', 'saved');
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
  await expect(page.locator('.native-sync-status')).toContainText('Your changes have not been saved');
  await page.getByRole('button', { name: 'Try saving again', exact: true }).click();
  await expect(page.locator('.native-sync-status')).toHaveAttribute('data-state', 'saved');
  await expect(page.locator('.native-workspace-notice')).toBeHidden();
  await page.unroute('**/content');
  await page.locator('.content [data-tab="calendar"]').click();
  await expect(page.locator('.native-sync-status')).toHaveAttribute('data-state', 'saved');
  const target = await page
    .locator('.cday:not(.out)[data-drop-day]')
    .evaluateAll((elements, today) => elements.map(el => el.dataset.dropDay).find(day => day !== today), today);
  await drag(page, page.locator('[data-drag-cal]').first(), page.locator(`[data-drop-day="${target}"]`));
  await expect(page.locator(`[data-drop-day="${target}"] [data-drag-cal]`)).toHaveCount(1);
  await expect(page.locator('.native-sync-status')).toHaveAttribute('data-state', 'saved');
  await page.screenshot({ path: 'test-results/restored-workspace.png' });
  for (const tab of ['board', 'list', 'table', 'calendar', 'timeline', 'files', 'overview', 'activity']) {
    await page.locator(`.content [data-a="go"][data-tab="${tab}"]`).first().click();
    await expect(page.locator('.content')).not.toContainText('Something went wrong.');
  }
  await page.locator('.content [data-tab="table"]').click();
  await page.locator('th [data-f="title"]').click();
  await page.locator('td[data-f="estimate"]').click();
  await page.getByLabel('Estimate', { exact: true }).fill('5d');
  await expect(page.locator('.native-sync-status')).toHaveAttribute('data-state', 'saved');
  await expect(page.getByLabel('Estimate', { exact: true })).toHaveValue('5d');
  await page.getByLabel('Estimate', { exact: true }).press('Enter');
  await expect(page.locator('.native-sync-status')).toHaveAttribute('data-state', 'saved');
  await page.locator('td[data-f="title"]').click();
  await page.getByLabel('Title', { exact: true }).fill('Restored local task edited');
  await page.getByLabel('Title', { exact: true }).press('Enter');
  await expect(page.locator('.native-sync-status')).toHaveAttribute('data-state', 'saved');
  await page.locator('.content [data-tab="timeline"]').click();
  const bar = page.locator('[data-bar]').first();
  await bar.scrollIntoViewIfNeeded();
  const barBox = await bar.boundingBox(),
    dayWidth = Number(await bar.getAttribute('data-dw'));
  await page.mouse.move(barBox.x + barBox.width / 2, barBox.y + barBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(barBox.x + barBox.width / 2 + dayWidth * 2, barBox.y + barBox.height / 2, { steps: 10 });
  await page.mouse.up();
  await expect(page.locator('.native-sync-status')).toHaveAttribute('data-state', 'saved');
  const persisted = await page.evaluate(async () => {
    const identity = await (await fetch('/api/auth/me')).json();
    return (await (await fetch(`/api/workspaces/${identity.workspaces[0].id}/content`)).json()).tasks[0];
  });
  expect(persisted.estimate).toBe('5d');
  expect(persisted.title).toBe('Restored local task edited');
  const shifted = new Date(target + 'T00:00:00Z');
  shifted.setUTCDate(shifted.getUTCDate() + 2);
  expect(persisted.due).toBe(shifted.toISOString().slice(0, 10));
  await expect(page.locator('.native-sync-status')).toHaveAttribute('data-state', 'saved');
  await openSettings(page, 'preferences');
  await expect(page.getByRole('button', { name: 'Download draft', exact: true })).toBeVisible();
  await page.reload();
  await openSettings(page, 'preferences');
  await expect(page.getByRole('button', { name: 'Download draft', exact: true })).toBeVisible();
  await expect(page.locator('.native-workspace-notice')).toBeHidden();
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await expect(nav.getByText('Proyek tim pengguna', { exact: true })).toBeVisible();
  await expect(page.locator('.native-workspace-notice')).toBeHidden();
  await expect(page.getByText('Restored local task edited', { exact: true }).first()).toBeVisible();
  await nav.locator('[data-r="project"]').first().click();
  await expect(page.locator('[data-drop-col="review"] [data-drag-card]')).toHaveCount(1);
  await page.locator('[data-pop="filter"]').click();
  await page.locator('[data-a="addFilter"][data-f="status"]').click();
  await page.locator('[data-a="fToggleVal"][data-v="review"]').click();
  await page.getByRole('heading', { name: 'Proyek tim pengguna', exact: true }).click();
  await page.locator('.content [data-pop="sort"]').click();
  await page.locator('[data-a="setSort"][data-v="title"]').click();
  await expect(page.locator('.native-sync-status')).toHaveAttribute('data-state', 'saved');
  let releaseSave,
    saveReady,
    heldSave = false;
  const heldResponse = new Promise(resolve => (releaseSave = resolve));
  const saving = new Promise(resolve => (saveReady = resolve));
  page.once('close', releaseSave);
  await page.route('**/content', async route => {
    if (route.request().method() !== 'POST' || heldSave) return route.continue();
    heldSave = true;
    const response = await route.fetch();
    saveReady();
    await heldResponse;
    await route.fulfill({ response });
  });
  await page.locator('.content input[data-in="viewQ"]').fill('not-matching');
  await expect(page.locator('[data-drag-card]')).toHaveCount(0);
  await page.locator('.content input[data-in="viewQ"]').fill('Restored');
  await expect(page.locator('[data-drag-card]')).toHaveCount(1);
  await saving;
  await page.locator('[data-a="saveView"]').click();
  await page.getByLabel('View name', { exact: true }).fill('Shared review view');
  await page.getByRole('button', { name: 'Layout', exact: true }).click();
  releaseSave();
  await expect(page.locator('.native-sync-status')).toHaveAttribute('data-state', 'saved');
  await expect(page.getByRole('option', { name: 'Table', exact: true })).toBeVisible();
  await page.unroute('**/content');
  await page.getByRole('option', { name: 'Table', exact: true }).click();
  await expect(page.getByLabel('View name', { exact: true })).toHaveValue('Shared review view');
  await expect(page.getByRole('button', { name: 'Layout', exact: true })).toHaveText('Table');
  await page.locator('[data-a="saveViewSubmit"]').click();
  await expect(page.locator('.native-sync-status')).toHaveAttribute('data-state', 'saved');
  await expect(page.locator('.content .tab').filter({ hasText: 'Shared review view' })).toBeVisible();
  await page.locator('.content').getByRole('button', { name: 'Members', exact: true }).click();
  await page.getByLabel('Private project', { exact: true }).check();
  await page.locator('[data-in="nativeProjectMember"]:not(:disabled)').check();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page.locator('.native-sync-status')).toHaveAttribute('data-state', 'saved');
  await signOut(page);
  await expect(page.getByRole('heading', { name: 'Sign in to your workspace' })).toBeVisible();
  await page.getByLabel('Email', { exact: true }).fill('member@example.test');
  await page.getByLabel('Password', { exact: true }).fill('member-browser-password-123');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(nav).toBeVisible();
  await expect(nav.getByText('Proyek tim pengguna', { exact: true })).toBeVisible();
  await expect(page.getByText('Restored local task edited', { exact: true }).first()).toBeVisible();
  await nav.locator('[data-r="project"]').first().click();
  await page.locator('.content .tab').filter({ hasText: 'Shared review view' }).click();
  await expect(page.locator('.content').getByText('Restored local task edited', { exact: true }).first()).toBeVisible();
  await expect(page.locator('.content input[data-in="viewQ"]')).toHaveValue('Restored');
  await page.locator('.content').getByRole('button', { name: 'Members', exact: true }).click();
  await expect(page.getByLabel('Private project', { exact: true })).toBeChecked();
  await expect(page.getByLabel('Private project', { exact: true })).toBeDisabled();
  expect(errors).toEqual([]);
});

test('comments, original files, notifications and recurring tasks work across two accounts', async ({ page, browser }) => {
  test.setTimeout(90000);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await page.getByLabel('Email', { exact: true }).fill('owner@example.test');
  await page.getByLabel('Password', { exact: true }).fill('updated-browser-password-123');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.locator('.native-sync-status')).toHaveAttribute('data-state', 'saved');
  const fixture = await page.evaluate(async () => {
    const identity = await (await fetch('/api/auth/me')).json(),
      ws = identity.workspaces[0].id;
    const [workspace, state] = await Promise.all([
      fetch(`/api/workspaces/${ws}`).then(r => r.json()),
      fetch(`/api/workspaces/${ws}/content`).then(r => r.json()),
    ]);
    const member = workspace.members.find(m => m.email === 'member@example.test');
    const project = {
      ...state.projects[0],
      id: 'browser-collab',
      key: 'COL',
      name: 'Collaboration workspace project',
      private: false,
      members: [identity.user.id],
      seq: 401,
    };
    const task = {
      ...state.tasks[0],
      id: 'browser-collab-task',
      project: project.id,
      key: 'COL-401',
      title: 'Collaborative task',
      status: 'todo',
      due: '2037-01-31',
      start: '2037-01-29',
      subtasks: [],
      attachments: [],
      deps: [],
      recur: null,
      assignee: member.id,
      archived: false,
      completedAt: null,
    };
    const response = await fetch(`/api/workspaces/${ws}/content`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-csrf-token': identity.csrfToken },
      body: JSON.stringify({
        revision: state.revision,
        mutationId: crypto.randomUUID(),
        operations: [
          { entity: 'project', id: project.id, value: project },
          { entity: 'task', id: task.id, value: task },
        ],
      }),
    });
    if (!response.ok) throw new Error('Fixture setup failed: ' + response.status);
    return { ws, member: member.id, memberName: member.name };
  });
  const url = `/?workspace=${fixture.ws}#task=browser-collab-task`;
  await page.goto(url);
  let drawer = page.locator('.drawer');
  await expect(drawer.getByLabel('Task title', { exact: true })).toHaveValue('Collaborative task');
  await drawer.getByLabel('Comment', { exact: true }).fill('@');
  await drawer.locator(`[data-a="pickMention"][data-mid="${fixture.member}"]`).click();
  const original = `Please review @${fixture.memberName}`;
  await drawer.getByLabel('Comment', { exact: true }).fill(original);
  await expect(page.locator('.native-sync-status')).toHaveAttribute('data-state', 'saved');
  await drawer.getByRole('button', { name: 'Comment', exact: true }).click();
  await expect(drawer.locator('.cmt .txt')).toHaveText(original);
  await drawer.getByRole('button', { name: 'Edit comment', exact: true }).click();
  const updated = `Updated review @${fixture.memberName}`;
  await page.getByRole('dialog', { name: 'Edit comment', exact: true }).getByLabel('Comment', { exact: true }).fill(updated);
  await page.getByRole('button', { name: 'Save comment', exact: true }).click();
  await expect(drawer.locator('.cmt .txt')).toHaveText(updated);
  await drawer.getByRole('button', { name: 'Add reaction', exact: true }).click();
  await page.getByRole('button', { name: 'React 👍', exact: true }).click();
  await expect(drawer.getByRole('button', { name: '👍 1', exact: true })).toBeVisible();
  const bytes = 'Original shared file contents\nNot a generated preview.\n';
  let uploadAcknowledgementLost = false;
  await page.route('**/files', async route => {
    if (route.request().method() === 'POST' && !uploadAcknowledgementLost) {
      uploadAcknowledgementLost = true;
      await route.fetch();
      return route.abort();
    }
    return route.continue();
  });
  await drawer
    .locator('input[data-in="uploadFiles"]')
    .first()
    .setInputFiles({ name: 'shared-notes.txt', mimeType: 'text/plain', buffer: Buffer.from(bytes) });
  await drawer.getByRole('button', { name: 'Retry upload', exact: true }).click();
  await expect(drawer.locator('.attc').filter({ hasText: 'shared-notes.txt' })).toBeVisible();
  await page.unroute('**/files');
  const uploadCount = await page.evaluate(
    async ws => (await (await fetch(`/api/workspaces/${ws}/content`)).json()).files.filter(file => file.name === 'shared-notes.txt').length,
    fixture.ws,
  );
  expect(uploadCount).toBe(1);
  await drawer.locator('.attc').filter({ hasText: 'shared-notes.txt' }).click();
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download file', exact: true }).click();
  const download = await downloading;
  expect(await readFile(await download.path(), 'utf8')).toBe(bytes);
  await page
    .getByRole('dialog')
    .filter({ has: page.getByRole('button', { name: 'Download file', exact: true }) })
    .getByRole('button', { name: 'Close', exact: true })
    .last()
    .click();
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jX1sAAAAASUVORK5CYII=', 'base64');
  await drawer.locator('input[data-in="uploadFiles"]').first().setInputFiles({ name: 'pixel.png', mimeType: 'image/png', buffer: png });
  await expect(drawer.locator('.attc img')).toBeVisible();
  await expect.poll(() => drawer.locator('.attc img').evaluate(img => img.naturalWidth)).toBe(1);
  const memberContext = await browser.newContext({ baseURL: 'http://localhost:5173', reducedMotion: 'reduce' }),
    memberPage = await memberContext.newPage();
  memberPage.on('pageerror', error => errors.push(error.message));
  try {
    await memberPage.goto('/');
    await memberPage.getByLabel('Email', { exact: true }).fill('member@example.test');
    await memberPage.getByLabel('Password', { exact: true }).fill('member-browser-password-123');
    await memberPage.getByRole('button', { name: 'Sign in', exact: true }).click();
    await memberPage.getByRole('navigation', { name: 'Main', exact: true }).locator('[data-r="inbox"]').click();
    let notification = memberPage.locator('.inbox-list [data-a="selNotif"]').filter({ hasText: updated });
    await expect(notification).toBeVisible();
    await notification.click();
    await expect(notification.locator('[aria-label="Unread"]')).toHaveCount(0);
    await memberPage.getByLabel('Reply', { exact: true }).fill('Member reply saved to the database');
    await memberPage.getByRole('button', { name: 'Reply', exact: true }).click();
    await expect(memberPage.locator('.inbox-prev .cmt .txt').filter({ hasText: 'Member reply saved to the database' })).toBeVisible();
    await memberPage.reload();
    await memberPage.getByRole('navigation', { name: 'Main', exact: true }).locator('[data-r="inbox"]').click();
    notification = memberPage.locator('.inbox-list [data-a="selNotif"]').filter({ hasText: updated });
    await expect(notification.locator('[aria-label="Unread"]')).toHaveCount(0);
    await memberPage.goto(url);
    await expect(memberPage.locator('.drawer .attc').filter({ hasText: 'shared-notes.txt' })).toBeVisible();
    await expect(memberPage.locator('.drawer .cmt .txt').filter({ hasText: updated })).toBeVisible();
    await expect(memberPage.getByRole('button', { name: '👍 1', exact: true })).toBeVisible();
    await memberPage.locator('.drawer .cmt').filter({ hasText: updated }).getByRole('button', { name: 'Add reaction', exact: true }).click();
    await memberPage.getByRole('button', { name: 'React 🎉', exact: true }).click();
    await expect(memberPage.getByRole('button', { name: '🎉 1', exact: true })).toBeVisible();
    await page.locator('.drawer').getByRole('button', { name: 'Refresh data', exact: true }).click();
    await expect(drawer.locator('.cmt .txt').filter({ hasText: 'Member reply saved to the database' })).toBeVisible();
    await expect(drawer.getByRole('button', { name: '🎉 1', exact: true })).toBeVisible();
    await drawer.locator('[data-pop="recur"]').click();
    await page.locator('[data-a="popPick"][data-v="Monthly"]').click();
    await expect(page.locator('.native-sync-status')).toHaveAttribute('data-state', 'saved');
    await drawer.locator('[data-a="toggleDone"]').first().click();
    await expect(page.locator('.native-sync-status')).toHaveAttribute('data-state', 'saved');
    const tasks = await page.evaluate(
      async ws => (await (await fetch(`/api/workspaces/${ws}/content`)).json()).tasks.filter(t => t.project === 'browser-collab'),
      fixture.ws,
    );
    expect(tasks).toHaveLength(2);
    expect(tasks.find(t => t.status === 'todo').due).toBe('2037-02-28');
    expect(tasks.find(t => t.status === 'todo').attachments).toEqual([]);
    await drawer.locator('[data-a="toggleDone"]').first().click();
    await expect(page.locator('.native-sync-status')).toHaveAttribute('data-state', 'saved');
    await drawer.locator('[data-a="toggleDone"]').first().click();
    await expect(page.locator('.native-sync-status')).toHaveAttribute('data-state', 'saved');
    const count = await page.evaluate(
      async ws => (await (await fetch(`/api/workspaces/${ws}/content`)).json()).tasks.filter(t => t.project === 'browser-collab').length,
      fixture.ws,
    );
    expect(count).toBe(2);
    await drawer.locator('.cmt').filter({ hasText: updated }).getByRole('button', { name: 'Delete comment', exact: true }).click();
    await page.getByRole('dialog', { name: 'Delete comment?', exact: true }).getByRole('button', { name: 'Delete comment', exact: true }).click();
    await expect(drawer.locator('.cmt .txt').filter({ hasText: updated })).toHaveCount(0);
    await memberPage.locator('.drawer').getByRole('button', { name: 'Refresh data', exact: true }).click();
    await expect(memberPage.locator('.drawer .cmt .txt').filter({ hasText: updated })).toHaveCount(0);
    await expect(memberPage.locator('.drawer .cmt .txt').filter({ hasText: 'Member reply saved to the database' })).toBeVisible();
  } finally {
    await memberContext.close();
  }
  expect(errors).toEqual([]);
});

test('native settings save accounts, teams, manual guest invitations, milestones, events and personal preferences', async ({ page, browser }) => {
  test.setTimeout(120000);
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('/');
  await page.getByLabel('Email', { exact: true }).fill('owner@example.test');
  await page.getByLabel('Password', { exact: true }).fill('updated-browser-password-123');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('navigation', { name: 'Main', exact: true })).toBeVisible();
  await openSettings(page);
  await expect(page.getByRole('heading', { name: 'Workspace members', exact: true })).toBeVisible();
  const settings = async sec => {
    await page.locator(`.set-nav [data-sec="${sec}"]`).click();
  };
  await settings('profile');
  await page.getByLabel('Full name', { exact: true }).fill('Browser Owner');
  await page.getByLabel('Job title', { exact: true }).fill('Engineering Lead');
  await page.getByRole('button', { name: 'Save profile', exact: true }).click();
  await expect.poll(async () => page.evaluate(async () => (await (await fetch('/api/account')).json()).user.name)).toBe('Browser Owner');
  await settings('teams');
  await page.getByRole('button', { name: 'Create team', exact: true }).click();
  await page.getByLabel('Team name', { exact: true }).fill('Native team');
  await page.locator('[data-team-member]').first().check();
  await page.getByRole('button', { name: 'Save team', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Native team', exact: true })).toBeVisible();
  const fixture = await page.evaluate(async () => {
    const identity = await (await fetch('/api/auth/me')).json(),
      ws = identity.workspaces[0].id;
    return { ws, user: identity.user.id };
  });
  await page.locator('[data-a="go"][data-r="project"][data-id="browser-collab"]').first().click();
  await page.locator('[data-a="go"][data-r="project"][data-tab="overview"]').first().click();
  await page.getByRole('button', { name: 'Add milestone', exact: true }).click();
  await page.getByLabel('Milestone name', { exact: true }).fill('Real browser milestone');
  await page.getByLabel('Target date', { exact: true }).fill('2037-01-31');
  await page.locator('.modal').getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Real browser milestone', { exact: true })).toBeVisible();
  await page.locator('[data-a="go"][data-r="project"][data-tab="calendar"]').first().click();
  await page.getByRole('button', { name: 'Create event', exact: true }).click();
  await page.getByLabel('Event title', { exact: true }).fill('Database planning meeting');
  const day = await page.getByLabel('Date', { exact: true }).inputValue();
  await page.getByLabel('Start time', { exact: true }).fill('10:30');
  await page.getByLabel('Time zone (IANA)', { exact: true }).fill('Asia/Jakarta');
  await page.getByLabel('Meeting link', { exact: true }).fill('https://meet.example.test/planning');
  await page.locator('.modal').getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.native-sync-status')).toHaveAttribute('data-state', 'saved');
  await expect(page.locator('.cal [data-pop="event"]').filter({ hasText: 'Database planning meeting' }).first()).toBeVisible();
  const saved = await page.evaluate(async ws => (await (await fetch(`/api/workspaces/${ws}/content`)).json()).events, fixture.ws);
  expect(saved.find(e => e.title === 'Database planning meeting').startsAt).toBe(day + 'T03:30:00.000Z');
  await openSettings(page);
  await page.getByRole('button', { name: 'Invite member', exact: true }).click();
  await page.getByLabel('Recipient email', { exact: true }).fill('native-guest@example.test');
  await page.locator('#native-invite-role').selectOption('guest');
  await page.locator('#native-invite-project').selectOption('browser-collab');
  await page.locator('#native-invite-permission').selectOption('viewer');
  await page.getByRole('button', { name: 'Create invitation', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Invitation link ready', exact: true })).toBeVisible();
  const invitation = await page.locator('#native-invitation-link').inputValue();
  await page.locator('.modal [data-a="closeModal"]').first().click();
  const context = await browser.newContext({ baseURL: 'http://localhost:5173' }),
    guestPage = await context.newPage();
  try {
    await guestPage.goto(invitation);
    await guestPage.getByLabel('Full name', { exact: true }).fill('Native Guest');
    await guestPage.getByLabel('New password', { exact: true }).fill('native-guest-password-123');
    await guestPage.getByRole('button', { name: 'Accept invitation', exact: true }).click();
    await expect(guestPage.getByRole('navigation', { name: 'Main', exact: true })).toBeVisible();
    await guestPage.locator('[data-a="go"][data-r="project"][data-id="browser-collab"]').first().click();
    await guestPage.locator('.kcard').first().click();
    await expect(guestPage.locator('.drawer [data-a="toggleDone"]').first()).toBeDisabled();
    await expect(guestPage.locator('.drawer [data-a="postComment"]')).toBeDisabled();
    await guestPage.locator('.drawer [data-a="closeDrawer"]').click();
    await openSettings(guestPage);
    await guestPage.locator('.set-nav [data-sec="2fa"]').click();
    await guestPage.getByLabel('Current password', { exact: true }).fill('native-guest-password-123');
    await guestPage.getByRole('button', { name: 'Set up two-factor authentication', exact: true }).click();
    await expect(guestPage.getByAltText('Authenticator setup QR code')).toBeVisible();
    const secret = await guestPage.locator('.set-body code').textContent();
    const { totp } = await import('../../server/mfa.js');
    await guestPage.getByLabel('Authenticator code', { exact: true }).fill(totp(secret, Math.floor(Date.now() / 30000)));
    await guestPage.getByRole('button', { name: 'Enable two-factor authentication', exact: true }).click();
    await expect(guestPage.getByRole('heading', { name: 'Two-factor recovery codes', exact: true })).toBeVisible();
    const codes = (await guestPage.locator('.set-body pre').textContent()).trim().split('\n');
    expect(codes).toHaveLength(10);
    await guestPage.getByRole('button', { name: 'I have saved these codes', exact: true }).click();
    await expect(guestPage.getByRole('heading', { name: 'Two-factor authentication enabled', exact: true })).toBeVisible();
    await signOut(guestPage);
    await expect(guestPage.getByRole('heading', { name: 'Sign in to your workspace' })).toBeVisible();
    await guestPage.getByLabel('Email', { exact: true }).fill('native-guest@example.test');
    await guestPage.getByLabel('Password', { exact: true }).fill('native-guest-password-123');
    await guestPage.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(guestPage.getByRole('heading', { name: 'Two-factor verification', exact: true })).toBeVisible();
    await guestPage.getByLabel('Two-factor or recovery code', { exact: true }).fill(codes[0]);
    await guestPage.getByRole('button', { name: 'Verify and sign in', exact: true }).click();
    await expect(guestPage.getByRole('navigation', { name: 'Main', exact: true })).toBeVisible();
    await openSettings(guestPage);
    await guestPage.locator('.set-nav [data-sec="profile"]').click();
    await guestPage.getByLabel('Full name', { exact: true }).fill('Updated Native Guest');
    await guestPage.getByRole('button', { name: 'Save profile', exact: true }).click();
    await expect.poll(async () => guestPage.evaluate(async () => (await (await fetch('/api/account')).json()).user.name)).toBe('Updated Native Guest');
  } finally {
    await context.close();
  }
  await settings('datetime');
  await page.locator('#native-timezone').selectOption('Asia/Jakarta');
  await page.locator('#native-timeformat').selectOption('24');
  await page.locator('#native-dateformat').selectOption('d/M');
  await expect(page.locator('.native-sync-status')).toHaveAttribute('data-state', 'saved');
  await settings('language');
  await page.locator('#native-language').selectOption('id-ID');
  await expect(page.locator('html')).toHaveAttribute('lang', 'id');
  await expect(page.getByRole('navigation', { name: 'Main', exact: true }).getByText('Beranda', { exact: true })).toBeVisible();
  await expect(page.locator('.native-sync-status')).toHaveAttribute('data-state', 'saved');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('lang', 'id');
  await expect(page.getByRole('navigation', { name: 'Main', exact: true }).getByText('Proyek tim pengguna', { exact: true })).toBeVisible();
  await openSettings(page, 'language');
  await page.locator('#native-language').selectOption('en-US');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.getByRole('heading', { name: 'Language', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Interface language', exact: true })).toBeVisible();
  await expect(page.locator('.native-sync-status')).toHaveAttribute('data-state', 'saved');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  for (const [section, heading] of [
    ['profile', 'Profile'],
    ['password', 'Change password'],
    ['sessions', 'Sign-in sessions'],
    ['2fa', 'Two-factor authentication'],
    ['workspace', 'Workspace'],
    ['members', 'Workspace members'],
    ['teams', 'Team'],
    ['permissions', 'Permissions and access requests'],
    ['notif-email', 'Email'],
    ['notif-push', 'In-app notifications'],
    ['datetime', 'Date and time'],
  ]) {
    await openSettings(page, section);
    await expect(page.locator('.set-body').getByRole('heading', { name: heading, exact: true })).toBeVisible();
  }
  await openSettings(page, 'members');
  await expect(page.locator('.set-nav [data-sec="plan"], .set-nav [data-sec="payment"], .set-nav [data-sec="invoices"]')).toHaveCount(0);
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await expect(page.locator('.native-member-row').first()).toBeVisible();
    const overlaps = await page.locator('.native-member-row').evaluateAll(rows =>
      rows.some(row => {
        const boxes = [...row.children].map(el => el.getBoundingClientRect()).filter(b => b.width && b.height);
        return boxes.some((a, i) =>
          boxes.slice(i + 1).some(b => Math.min(a.right, b.right) > Math.max(a.left, b.left) + 1 && Math.min(a.bottom, b.bottom) > Math.max(a.top, b.top) + 1),
        );
      }),
    );
    expect(overlaps).toBe(false);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `test-results/members-${width}.png`, fullPage: true, animations: 'disabled' });
  }
  await page.setViewportSize({ width: 1280, height: 720 });
  const reloaded = await page.evaluate(async ws => await (await fetch(`/api/workspaces/${ws}/content`)).json(), fixture.ws);
  expect(reloaded.preferences.prefs.tz).toBe('Asia/Jakarta');
  expect(reloaded.projects.find(p => p.id === 'browser-collab').milestones.some(m => m.name === 'Real browser milestone')).toBe(true);
  expect(reloaded.directory.teams.some(t => t.name === 'Native team')).toBe(true);
  expect(errors).toEqual([]);
});

test('email preferences generate an actual queued email and unsubscribe confirms without disabling account security', async ({ page, browser }) => {
  test.setTimeout(90000);
  await page.goto('/');
  await page.getByLabel('Email', { exact: true }).fill('owner@example.test');
  await page.getByLabel('Password', { exact: true }).fill('updated-browser-password-123');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('navigation', { name: 'Main', exact: true })).toBeVisible();
  const fixture = await page.evaluate(async () => {
    const identity = await (await fetch('/api/auth/me')).json(),
      ws = identity.workspaces[0].id,
      content = await (await fetch(`/api/workspaces/${ws}/content`)).json();
    return {
      ws,
      member: content.directory.members.find(m => m.email === 'member@example.test').id,
      memberName: content.directory.members.find(m => m.email === 'member@example.test').name,
      task: content.tasks.find(t => t.project === 'browser-collab').id,
    };
  });
  const context = await browser.newContext({ baseURL: 'http://localhost:5173' }),
    memberPage = await context.newPage(),
    pool = createPool(testConfig());
  try {
    await memberPage.goto('/');
    await memberPage.getByLabel('Email', { exact: true }).fill('member@example.test');
    await memberPage.getByLabel('Password', { exact: true }).fill('member-browser-password-123');
    await memberPage.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(memberPage.getByRole('navigation', { name: 'Main', exact: true })).toBeVisible();
    await memberPage.goto(`/?workspace=${fixture.ws}#email-settings`);
    await expect(memberPage.getByRole('heading', { name: 'Email', exact: true })).toBeVisible();
    const mention = memberPage.getByRole('checkbox', { name: 'email_mention', exact: true });
    await mention.uncheck();
    await expect(memberPage.locator('.native-sync-status')).toHaveAttribute('data-state', 'saved');
    await mention.check();
    await expect(memberPage.locator('.native-sync-status')).toHaveAttribute('data-state', 'saved');
    await memberPage.getByRole('checkbox', { name: 'email_comment', exact: true }).uncheck();
    await memberPage.locator('.set-nav [data-sec="notif-mentions"]').click();
    await memberPage.getByRole('checkbox', { name: 'push_mention', exact: true }).uncheck();
    await expect(memberPage.locator('.native-sync-status')).toHaveAttribute('data-state', 'saved');
    const commentId = await page.evaluate(async fixture => {
      const me = await (await fetch('/api/auth/me')).json(),
        id = crypto.randomUUID();
      const r = await fetch(`/api/workspaces/${fixture.ws}/tasks/${fixture.task}/comments`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-csrf-token': me.csrfToken },
        body: JSON.stringify({ id, text: 'Email workflow proof <b>escaped text</b> @' + fixture.memberName, mentions: [fixture.member] }),
      });
      if (r.status !== 201) throw new Error('Comment failed');
      return id;
    }, fixture);
    let mail;
    await expect
      .poll(
        async () => {
          mail = (
            await pool.query(
              "SELECT o.id,o.delivery_status FROM mail_outbox o JOIN email_events e ON o.dedupe_key='notification:'||e.id WHERE e.comment_id=$1 AND e.recipient_id=$2",
              [commentId, fixture.member],
            )
          ).rows[0];
          return mail?.delivery_status;
        },
        { timeout: 20000 },
      )
      .toBe('accepted');
    const delivered = JSON.parse(await readFile(`.local/e2e-mail/${mail.id}.json`, 'utf8'));
    expect(delivered.to).toBe('member@example.test');
    expect(delivered.text).toContain('Email workflow proof');
    expect(delivered.html).toContain('&lt;b&gt;escaped text&lt;/b&gt;');
    expect((await pool.query('SELECT 1 FROM user_notifications WHERE comment_id=$1 AND recipient_id=$2', [commentId, fixture.member])).rowCount).toBe(0);
    const token = delivered.text.match(/#unsubscribe=([a-f0-9]{64})/)[1],
      unsubscribePage = await context.newPage();
    await unsubscribePage.goto('/#unsubscribe=' + token);
    await expect(unsubscribePage.getByRole('heading', { name: 'Activity email settings', exact: true })).toBeVisible();
    expect(unsubscribePage.url()).not.toContain(token);
    let prefs = (await pool.query('SELECT data FROM workspace_preferences WHERE workspace_id=$1 AND user_id=$2', [fixture.ws, fixture.member])).rows[0].data;
    expect(prefs.notifPrefs.email_mention).toBe(true);
    await unsubscribePage.getByRole('button', { name: 'Disable activity emails', exact: true }).click();
    await expect(unsubscribePage.getByRole('heading', { name: 'Activity emails disabled', exact: true })).toBeVisible();
    prefs = (await pool.query('SELECT data FROM workspace_preferences WHERE workspace_id=$1 AND user_id=$2', [fixture.ws, fixture.member])).rows[0].data;
    expect(prefs.notifPrefs.email_mention).toBe(false);
    expect(prefs.notifPrefs.email_digest).toBe(false);
    expect(prefs.notifPrefs.push_mention).toBe(false);
    await page.goto(`/?workspace=${fixture.ws}#email-settings`);
    await page.getByRole('button', { name: 'Load email status', exact: true }).click();
    await expect(page.locator('.set-body')).toContainText('member@example.test');
    expect(await page.locator('.set-body').textContent()).not.toContain(token);
  } finally {
    await pool.end();
    await context.close();
  }
});
