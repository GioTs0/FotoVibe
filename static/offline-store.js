const DATABASE = 'fotovibe-offline';
const VERSION = 1;

let databasePromise;

function requestValue(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Lokaler Speicher ist nicht verfügbar.'));
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error || new Error('Lokaler Speicher ist nicht verfügbar.'));
    transaction.onerror = () => reject(transaction.error || new Error('Lokaler Speicher ist nicht verfügbar.'));
  });
}

export function openOfflineStore() {
  if (databasePromise) return databasePromise;
  databasePromise = new Promise((resolve, reject) => {
    if (!('indexedDB' in globalThis)) {
      reject(new Error('Dieser Browser kann Fotos nicht lokal speichern.'));
      return;
    }
    const request = indexedDB.open(DATABASE, VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains('outbox')) {
        database.createObjectStore('outbox', { keyPath: 'id' });
      }
      if (!database.objectStoreNames.contains('state')) {
        database.createObjectStore('state', { keyPath: 'key' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Lokaler Speicher ist nicht verfügbar.'));
    request.onblocked = () => reject(new Error('Bitte schließe andere geöffnete FotoVibe-Tabs.'));
  });
  return databasePromise;
}

export async function getOfflineState(key) {
  const database = await openOfflineStore();
  const transaction = database.transaction('state', 'readonly');
  const value = await requestValue(transaction.objectStore('state').get(key));
  await transactionDone(transaction);
  return value?.value ?? null;
}

export async function setOfflineState(key, value) {
  const database = await openOfflineStore();
  const transaction = database.transaction('state', 'readwrite');
  transaction.objectStore('state').put({ key, value });
  await transactionDone(transaction);
}

export async function deleteOfflineState(key) {
  const database = await openOfflineStore();
  const transaction = database.transaction('state', 'readwrite');
  transaction.objectStore('state').delete(key);
  await transactionDone(transaction);
}

export async function listOutbox() {
  const database = await openOfflineStore();
  const transaction = database.transaction('outbox', 'readonly');
  const entries = await requestValue(transaction.objectStore('outbox').getAll());
  await transactionDone(transaction);
  return entries.sort((left, right) => left.createdAt - right.createdAt);
}

export async function getOutboxEntry(id) {
  const database = await openOfflineStore();
  const transaction = database.transaction('outbox', 'readonly');
  const entry = await requestValue(transaction.objectStore('outbox').get(id));
  await transactionDone(transaction);
  return entry || null;
}

export async function addOutboxEntry(entry) {
  const database = await openOfflineStore();
  const transaction = database.transaction('outbox', 'readwrite');
  transaction.objectStore('outbox').add(entry);
  await transactionDone(transaction);
}

export async function updateOutboxEntry(id, update) {
  const database = await openOfflineStore();
  const transaction = database.transaction('outbox', 'readwrite');
  const store = transaction.objectStore('outbox');
  const current = await requestValue(store.get(id));
  if (current) store.put({ ...current, ...update });
  await transactionDone(transaction);
  return current ? { ...current, ...update } : null;
}

export async function deleteOutboxEntry(id) {
  const database = await openOfflineStore();
  const transaction = database.transaction('outbox', 'readwrite');
  transaction.objectStore('outbox').delete(id);
  await transactionDone(transaction);
}

export async function clearOutbox() {
  const database = await openOfflineStore();
  const transaction = database.transaction('outbox', 'readwrite');
  transaction.objectStore('outbox').clear();
  await transactionDone(transaction);
}

export async function resetInterruptedUploads() {
  const database = await openOfflineStore();
  const transaction = database.transaction('outbox', 'readwrite');
  const store = transaction.objectStore('outbox');
  const entries = await requestValue(store.getAll());
  entries.filter((entry) => entry.status === 'uploading').forEach((entry) => {
    store.put({ ...entry, status: 'queued', progress: 0, updatedAt: Date.now() });
  });
  await transactionDone(transaction);
}

export async function outboxSummary() {
  const entries = await listOutbox();
  return {
    entries,
    count: entries.length,
    bytes: entries.reduce((total, entry) => total + (entry.size || 0), 0),
  };
}

export async function acquireUploadLease(owner, duration = 30_000) {
  const database = await openOfflineStore();
  const transaction = database.transaction('state', 'readwrite');
  const store = transaction.objectStore('state');
  const record = await requestValue(store.get('upload-lease'));
  const now = Date.now();
  const lease = record?.value;
  const available = !lease || lease.expiresAt <= now || lease.owner === owner;
  if (available) {
    store.put({ key: 'upload-lease', value: { owner, expiresAt: now + duration } });
  }
  await transactionDone(transaction);
  return available;
}

export async function releaseUploadLease(owner) {
  const database = await openOfflineStore();
  const transaction = database.transaction('state', 'readwrite');
  const store = transaction.objectStore('state');
  const record = await requestValue(store.get('upload-lease'));
  if (record?.value?.owner === owner) store.delete('upload-lease');
  await transactionDone(transaction);
}
