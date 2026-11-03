/**
 * FE-06 — persona, tenant, portal and keyboard flows
 *
 * The smoke test signs in as the seeded admin, who is also the install
 * operator, so every permission check was skipped. These flows use the
 * personas src/scripts/seed-e2e.js adds: a billing and a read-only user of the
 * demo org, a second organization, a portal client with an issued invoice, and
 * 120 more clients. API-level isolation and the permission matrix run in the
 * db-integration job (tests/integration/db).
 */

import { test, expect, type Page } from '@playwright/test';

const PERSONA_PASSWORD = process.env.E2E_PERSONA_PASSWORD ?? '';
const PORTAL_PASSWORD = process.env.E2E_PORTAL_PASSWORD ?? '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? '';

test.beforeEach(async ({ page }) => {
  // The DR drill alert blocks the page on a database with no drill history
  // (see smoke.spec.ts).
  await page.addInitScript(() => {
    try { sessionStorage.setItem('drDrillBannerDismissed', '1'); } catch { /* ignore */ }
  });
});

async function signIn(page: Page, email: string, password: string) {
  await page.goto('/login');
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', password);
  await page.click('button[type="submit"]');
  await expect(page).toHaveURL(/\/$/, { timeout: 15_000 });
}

test('a read-only user sees a client but none of its edit or create actions', async ({ page }) => {
  await signIn(page, 'readonly@demo-isp.com', PERSONA_PASSWORD);
  await page.goto('/clients/1');
  await expect(page.getByText('John Doe').first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('button', { name: '✏️ Edit' })).toHaveCount(0);

  await page.goto('/tickets');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('button', { name: /new ticket/i })).toHaveCount(0);

  await page.goto('/invoices');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('button', { name: /generate invoice/i })).toHaveCount(0);
});

test('a billing user finds a client past the first hundred when generating an invoice', async ({ page }) => {
  await signIn(page, 'billing@demo-isp.com', PERSONA_PASSWORD);
  await page.goto('/invoices');
  await page.getByRole('button', { name: /generate invoice/i }).click();
  const dialog = page.getByRole('dialog');
  const input = dialog.getByRole('textbox', { name: 'Client' });
  await expect(input).toBeVisible({ timeout: 10_000 });
  await input.fill('Bulk Client 120');
  await expect(dialog.getByRole('option', { name: /Bulk Client 120/ })).toBeVisible({ timeout: 10_000 });
});

test('the demo organization never sees the other organization\'s client', async ({ page }) => {
  await signIn(page, 'admin@demo-isp.com', ADMIN_PASSWORD);
  await page.goto('/clients');
  await page.getByPlaceholder(/search/i).first().fill('Other Org Client');
  await page.keyboard.press('Enter');
  await expect(page.getByText('No clients found.')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('Other Org Client')).toHaveCount(0);
});

test('a subscriber signs in to the portal and opens an invoice to pay', async ({ page }) => {
  await page.goto('/portal/login');
  await page.fill('input[type="email"]', 'john@example.com');
  await page.fill('input[type="password"]', PORTAL_PASSWORD);
  await page.click('button[type="submit"]');
  await expect(page).toHaveURL(/\/portal/, { timeout: 15_000 });

  await page.goto('/portal/invoices');
  await page.getByRole('link', { name: 'INV-E2E-0001' }).click();
  await expect(page).toHaveURL(/\/portal\/invoices\/\d+/);
  await expect(page.getByText('INV-E2E-0001').first()).toBeVisible();
  await expect(page.getByRole('button', { name: /pay now/i })).toBeVisible();
});

test('keyboard focus stays inside a modal and returns to the opener (FE-22)', async ({ page }) => {
  await signIn(page, 'admin@demo-isp.com', ADMIN_PASSWORD);
  await page.goto('/clients/1');
  const opener = page.getByRole('button', { name: '✏️ Edit' });
  await opener.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();

  const inside = () => page.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"]')));
  await expect.poll(inside).toBe(true);
  for (let i = 0; i < 40; i++) {
    await page.keyboard.press(i % 7 === 6 ? 'Shift+Tab' : 'Tab');
    expect(await inside()).toBe(true);
  }

  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();
});
