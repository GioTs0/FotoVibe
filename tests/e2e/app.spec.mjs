import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';

test('login surface fits the selected device viewport', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle(/180\. Geburtstag/);
  await expect(page.getByRole('heading', { name: 'Schön, dass du da bist.' })).toBeVisible();
  await expect(page.getByLabel('Party-Code')).toBeVisible();

  const viewportFits = await page.evaluate(
    () => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
  );
  expect(viewportFits).toBe(true);
});

test('a local developer can reach the camera entry point', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Party-Code').fill('1234');
  await page.getByRole('button', { name: /Dabei sein/ }).click();
  await expect(page.getByRole('heading', { name: 'Wie dürfen wir dich nennen?' })).toBeVisible();
  await page.getByLabel('Dein Name').fill('Playwright Test');
  await page.getByRole('button', { name: /Weiter zur Party/ }).click();
  await expect(page.getByRole('heading', { name: 'Halte den Abend fest.' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Foto aufnehmen/ }).first()).toBeVisible();
});

test('Chromium opens the camera shell with the fake webcam', async ({ page, browserName }, testInfo) => {
  test.skip(browserName !== 'chromium', 'The deterministic fake-camera flags are Chromium-specific.');
  await page.goto('/');
  await page.getByLabel('Party-Code').fill('1234');
  await page.getByRole('button', { name: /Dabei sein/ }).click();
  await page.getByLabel('Dein Name').fill('Playwright Kamera');
  await page.getByRole('button', { name: /Weiter zur Party/ }).click();
  await page.getByRole('button', { name: /Foto aufnehmen/ }).first().click();

  await expect(page.locator('#camera-view')).toBeVisible();
  await expect(page.locator('#camera-video')).toBeVisible();
  await expect(page.locator('#shutter')).toBeEnabled();
  if (testInfo.project.name === 'desktop-chromium') {
    await expect(page.getByRole('button', { name: 'Display-Blitz einschalten' })).toBeVisible();
  }
});

test('an offline photo survives reload and uploads when the connection returns', async ({ page, context }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium', 'Exercises the Service Worker and IndexedDB once in Chromium.');
  await page.goto('/');
  await page.getByLabel('Party-Code').fill('1234');
  await page.getByRole('button', { name: /Dabei sein/ }).click();
  await page.getByLabel('Dein Name').fill('Playwright Offline Queue');
  await page.getByRole('button', { name: /Weiter zur Party/ }).click();
  await expect(page.getByRole('heading', { name: 'Halte den Abend fest.' })).toBeVisible();
  await page.waitForFunction(() => navigator.serviceWorker?.controller);
  await page.waitForTimeout(250);

  await context.setOffline(true);
  const photo = await readFile(new URL('../../static/party.jpg', import.meta.url));
  await page.locator('#library-input').setInputFiles({
    name: 'offline.jpg', mimeType: 'image/jpeg', buffer: photo,
  });
  await expect(page.locator('#review')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Später hochladen' })).toBeVisible();
  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(page.getByRole('button', { name: 'Foto hochladen' })).toBeVisible();
  await context.setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  await expect(page.getByRole('button', { name: 'Später hochladen' })).toBeVisible();
  await page.getByRole('button', { name: 'Später hochladen' }).click();
  await expect(page.locator('#queue-notice')).toHaveText('Eingereiht · 1 / 25');
  await expect(page.locator('#local-cache')).toContainText('1 / 25 vorgemerkt');
  await page.locator('#local-cache').click();
  await expect(page.locator('#queue-menu')).toBeVisible();
  await expect(page.locator('#queue-control')).toBeVisible();

  await page.reload();
  await expect(page.getByRole('heading', { name: 'Halte den Abend fest.' })).toBeVisible();
  await page.getByRole('button', { name: 'Aufgabe ziehen' }).click();
  await expect(page.getByRole('button', { name: 'Foto aufnehmen' }).first()).toBeVisible();

  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(page.locator('#queue-control')).toBeHidden({ timeout: 15_000 });
  await expect(page.locator('#local-cache')).toContainText('0 / 25 vorgemerkt');
});

test('the front-camera preview mirrors only the preview and keeps the action focused', async ({ page, browserName }, testInfo) => {
  test.skip(browserName !== 'chromium' || testInfo.project.name !== 'desktop-chromium', 'Uses the deterministic front camera once in Chromium.');
  await page.goto('/');
  await page.getByLabel('Party-Code').fill('1234');
  await page.getByRole('button', { name: /Dabei sein/ }).click();
  await page.getByLabel('Dein Name').fill('Playwright Spiegelung');
  await page.getByRole('button', { name: /Weiter zur Party/ }).click();
  await page.getByRole('button', { name: /Foto aufnehmen/ }).first().click();
  await expect(page.locator('#shutter')).toBeEnabled();
  await page.locator('#shutter').click();
  await expect(page.locator('#preview')).toHaveClass(/is-mirrored/);
  await expect(page.locator('#discard')).toHaveText('');
  await expect(page.locator('#discard')).toHaveAttribute('aria-label', 'Zurück zur Kamera');
  await expect(page.locator('#file-info')).toHaveCount(0);
  await expect(page.locator('#preview-status')).toHaveCount(0);
  const centered = await page.locator('#send').evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return Math.abs((rect.left + rect.right) / 2 - window.innerWidth / 2) < 1;
  });
  expect(centered).toBe(true);
});
