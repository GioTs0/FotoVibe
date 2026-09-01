import { expect, test } from '@playwright/test';

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
