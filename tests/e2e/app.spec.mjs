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
  await expect(page.locator('#local-cache')).toBeHidden();
});

test('the gallery keeps search collapsed and offers a personal quick filter', async ({ page }) => {
  await page.goto('/gallery');
  await page.getByLabel('Party-Code').fill('1234');
  await page.getByRole('button', { name: /Dabei sein/ }).click();
  await page.getByLabel('Dein Name').fill('Playwright Galerie');
  await page.getByRole('button', { name: /Weiter zur Party/ }).click();
  await expect(page.getByRole('heading', { name: 'Unser Abend in Bildern.' })).toBeVisible();
  await expect(page.locator('#stream-link')).toHaveCount(0);
  await expect(page.locator('#gallery-toolbar')).toBeHidden();

  await page.getByRole('button', { name: 'Suche öffnen' }).click();
  await expect(page.locator('#gallery-toolbar')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Von mir' })).toHaveAttribute('aria-pressed', 'false');
  const mineRequest = page.waitForRequest((request) => request.url().includes('/api/photos?mine=1'));
  await page.getByRole('button', { name: 'Von mir' }).click();
  await expect(page.getByRole('button', { name: 'Von mir' })).toHaveAttribute('aria-pressed', 'true');
  await mineRequest;
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
  await page.getByRole('button', { name: 'Aufgabe ziehen' }).click();
  await expect(page.getByRole('button', { name: /Foto aufnehmen/ }).first()).toBeVisible();
  await page.waitForFunction(() => navigator.serviceWorker?.controller);
  await page.waitForTimeout(250);

  await context.setOffline(true);
  await expect(page.locator('#queue-control')).toBeVisible();
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
  await page.locator('#queue-menu .queue-delete-action').click();
  await expect(page.locator('#queue-menu')).toBeVisible();
  await expect(page.locator('#queue-menu')).toContainText('Behalten');
  await page.locator('#queue-menu').getByRole('button', { name: 'Behalten' }).click();
  await page.locator('#queue-menu .queue-detail-trigger').click();
  await expect(page.locator('#queue-detail')).toBeVisible();
  await expect(page.locator('#queue-detail-image')).toBeVisible();
  await expect(page.locator('#queue-detail-task')).toBeVisible();
  await expect(page.locator('#queue-detail-task-text')).not.toHaveText('');
  await page.keyboard.press('Escape');
  await expect(page.locator('#queue-detail')).toBeHidden();

  await page.reload();
  await expect(page.getByRole('heading', { name: 'Halte den Abend fest.' })).toBeVisible();
  await page.getByRole('button', { name: 'Aufgabe ziehen' }).click();
  await expect(page.getByRole('button', { name: 'Foto aufnehmen' }).first()).toBeVisible();

  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(page.locator('#queue-control')).toBeHidden({ timeout: 15_000 });
  await expect(page.locator('#local-cache')).toBeHidden();
});

test('an offline guest can inspect and remove a queued photo', async ({ page, context }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium', 'Exercises the local queue once in Chromium.');
  await page.goto('/');
  await page.getByLabel('Party-Code').fill('1234');
  await page.getByRole('button', { name: /Dabei sein/ }).click();
  await page.getByLabel('Dein Name').fill('Playwright Queue Detail');
  await page.getByRole('button', { name: /Weiter zur Party/ }).click();
  await page.waitForFunction(() => navigator.serviceWorker?.controller);
  await context.setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  const photo = await readFile(new URL('../../static/party.jpg', import.meta.url));
  await page.locator('#library-input').setInputFiles({
    name: 'remove-me.jpg', mimeType: 'image/jpeg', buffer: photo,
  });
  await page.getByRole('button', { name: 'Später hochladen' }).click();
  await page.locator('#local-cache').click();
  await page.getByRole('button', { name: 'Vorgemerktes Foto groß anzeigen' }).first().click();
  await page.getByRole('button', { name: 'Foto aus der Queue löschen' }).click();
  await expect(page.getByText('Wirklich löschen?')).toBeVisible();
  await page.getByRole('button', { name: 'Löschen', exact: true }).click();
  await expect(page.locator('#queue-detail')).toBeHidden();
  await expect(page.locator('#local-cache')).toBeHidden();
  await expect(page.locator('#queue-control')).toBeVisible();
});

test('an old failed queue entry gets a fresh server photo ID before upload', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium', 'Exercises the IndexedDB migration once in Chromium.');
  await page.goto('/');
  await page.getByLabel('Party-Code').fill('1234');
  await page.getByRole('button', { name: /Dabei sein/ }).click();
  await page.getByLabel('Dein Name').fill('Playwright Legacy Queue');
  await page.getByRole('button', { name: /Weiter zur Party/ }).click();
  await page.waitForFunction(() => navigator.serviceWorker?.controller);
  await page.evaluate(async () => {
    const blob = await fetch('/static/party.jpg').then((response) => response.blob());
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open('fotovibe-offline', 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const transaction = database.transaction('outbox', 'readwrite');
      transaction.objectStore('outbox').put({
        id: 'old-local-photo-key', blob, name: 'legacy.jpg', type: 'image/jpeg', size: blob.size,
        createdAt: Date.now(), updatedAt: Date.now(), status: 'error', attempts: 1,
        uploadId: 'old-local-photo-key', nextAttemptAt: 0,
        lastError: 'Bitte genau ein Foto hochladen.', progress: 0,
      });
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    database.close();
    window.dispatchEvent(new Event('online'));
  });
  await expect(page.locator('#queue-control')).toBeHidden({ timeout: 15_000 });
  await expect(page.locator('#local-cache')).toBeHidden();
});

test('a full offline queue of 25 task photos drains with its metadata intact', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium', 'Exercises the maximum outbox size once in Chromium.');
  await page.goto('/');
  await page.getByLabel('Party-Code').fill('1234');
  await page.getByRole('button', { name: /Dabei sein/ }).click();
  await page.getByLabel('Dein Name').fill('Playwright Volle Queue');
  await page.getByRole('button', { name: /Weiter zur Party/ }).click();
  await page.waitForFunction(() => navigator.serviceWorker?.controller);
  const marker = await page.evaluate(async () => {
    const task = (await fetch('/api/tasks').then((response) => response.json())).tasks[0];
    const blob = await fetch('/static/party.jpg').then((response) => response.blob());
    const marker = Date.now();
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open('fotovibe-offline', 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const transaction = database.transaction('outbox', 'readwrite');
      const outbox = transaction.objectStore('outbox');
      for (let index = 0; index < 25; index++) {
        outbox.put({
          id: `batch-${index}`,
          blob,
          name: `offline-${index}.jpg`,
          type: 'image/jpeg',
          size: blob.size,
          task,
          clientMetadata: {
            source: 'camera',
            captured_at: marker + index,
            queued_at: marker + index,
            task_id: task.id,
          },
          createdAt: marker + index,
          updatedAt: marker + index,
          status: 'queued',
          attempts: 0,
          nextAttemptAt: 0,
          lastError: '',
          progress: 0,
        });
      }
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    database.close();
    window.dispatchEvent(new Event('online'));
    return marker;
  });

  await expect(page.locator('#queue-control')).toBeHidden({ timeout: 30_000 });
  const uploaded = await page.evaluate(async (queuedAt) => {
    const result = await fetch('/api/photos').then((response) => response.json());
    return result.photos.filter((photo) => photo.metadata?.capture?.queued_at >= queuedAt);
  }, marker);
  expect(uploaded).toHaveLength(25);
  expect(new Set(uploaded.map((photo) => photo.id)).size).toBe(25);
  expect(uploaded.every((photo) => photo.metadata.task?.id && photo.metadata.capture?.source === 'camera')).toBe(true);
});

test('a broken local preview shows a calm placeholder and can still be removed', async ({ page, context }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium', 'Exercises an unreadable local Blob once in Chromium.');
  await page.goto('/');
  await page.getByLabel('Party-Code').fill('1234');
  await page.getByRole('button', { name: /Dabei sein/ }).click();
  await page.getByLabel('Dein Name').fill('Playwright Vorschau');
  await page.getByRole('button', { name: /Weiter zur Party/ }).click();
  await page.waitForFunction(() => navigator.serviceWorker?.controller);
  await context.setOffline(true);
  await page.evaluate(async () => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open('fotovibe-offline', 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const transaction = database.transaction('outbox', 'readwrite');
      transaction.objectStore('outbox').put({
        id: crypto.randomUUID(),
        blob: new Blob(['kein-bild'], { type: 'image/jpeg' }),
        name: 'nicht-lesbar.jpg', type: 'image/jpeg', size: 9,
        createdAt: Date.now(), updatedAt: Date.now(), status: 'queued', attempts: 0,
        nextAttemptAt: 0, lastError: '', progress: 0,
      });
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    database.close();
    window.dispatchEvent(new Event('offline'));
  });

  await page.locator('#local-cache').click();
  await expect(page.locator('.queue-thumbnail-placeholder')).toBeVisible();
  await page.getByRole('button', { name: /Vorschau nicht verfügbar/ }).click();
  await expect(page.locator('#queue-detail-image-unavailable')).toBeVisible();
  await page.getByRole('button', { name: 'Foto aus der Queue löschen' }).click();
  await page.getByRole('button', { name: 'Löschen', exact: true }).click();
  await expect(page.locator('#queue-detail')).toBeHidden();
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
