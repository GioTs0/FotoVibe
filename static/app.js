const $ = (id) => document.getElementById(id);
const galleryPage = location.pathname === '/gallery';
const playPage = location.pathname === '/play';
const MAX_BYTES = 25 * 1024 * 1024;
const DEVICE_STORAGE_KEY = 'fotovibe_device_id';
let cachedDeviceId = null;
let authenticated = false;
let currentUser = null;
let selected = null;
let uploadId = null;
let previewUrl = null;
let previewGeneration = 0;
let uploading = false;
let timer = null;
let galleryBusy = false;
let adminData = null;
let adminTasks = null;
let adminTab = 'users';
let adminSearchTimer = null;
let adminQuery = '';
let nextCursor = null;
let galleryLoaded = false;
const photos = new Map();
let detailButton = null;
let scrollPosition = 0;
let activeDetailPhoto = null;
let galleryQuery = '';
let gallerySearchTimer = null;
let cameraStream = null;
let cameraFacing = 'environment';
let cameraGeneration = 0;
let selectionSource = null;
let currentTask = null;
let taskBusy = false;
let playTimer = null;
let playBusy = false;
let playPlaying = new URLSearchParams(location.search).get('autoplay') === '1';
let playPageNumber = 0;
const playRecent = [];

$(galleryPage || playPage ? 'nav-gallery' : 'nav-upload').setAttribute('aria-current', 'page');
document.title = galleryPage ? 'Unsere Galerie · 180. Geburtstag' : playPage ? 'Fotobuch · 180. Geburtstag' : 'Foto teilen · 180. Geburtstag';

function deviceId() {
  if (cachedDeviceId) return cachedDeviceId;
  try {
    let value = localStorage.getItem(DEVICE_STORAGE_KEY);
    if (!value) {
      value = crypto.randomUUID();
      localStorage.setItem(DEVICE_STORAGE_KEY, value);
    }
    cachedDeviceId = value;
  } catch { cachedDeviceId = crypto.randomUUID(); }
  return cachedDeviceId;
}

function closeProfileMenu() {
  $('profile-menu').hidden = true;
  $('profile-button').setAttribute('aria-expanded', 'false');
}

function showUser(user) {
  currentUser = user || null;
  $('profile-control').hidden = !currentUser;
  if (!currentUser) return;
  $('profile-name').textContent = currentUser.name;
  $('profile-initial').textContent = currentUser.name.trim().charAt(0).toLocaleUpperCase('de') || '?';
  $('profile-user-id').textContent = currentUser.id || '–';
  $('profile-device-id').textContent = currentUser.device_id || '–';
  const uploaded = currentUser.values?.photos_uploaded;
  $('profile-upload-count').textContent = Number.isInteger(uploaded) && uploaded >= 0 ? String(uploaded) : '–';
  $('profile-admin-badge').hidden = !currentUser.is_admin;
  $('admin-open').hidden = !currentUser.is_admin;
}

function showLogin(message = '') {
  stopCamera(false);
  document.body.classList.remove('review-open');
  $('review').hidden = true;
  clearTimeout(playTimer);
  playPlaying = false;
  authenticated = false;
  showUser(null);
  closeProfileMenu();
  clearTimeout(timer);
  $('login').hidden = false;
  $('profile-setup').hidden = $('upload').hidden = $('gallery').hidden = $('play').hidden = $('admin').hidden = $('logout').hidden = $('boot').hidden = true;
  $('login-error').textContent = message;
  $('party-code').focus();
}

async function api(path, options = {}) {
  let response;
  try { response = await fetch(path, { credentials: 'same-origin', ...options }); }
  catch { throw new Error('Keine Verbindung. Bitte dein Netz prüfen und erneut versuchen.'); }
  if (!response.ok) {
    let message = 'Das hat gerade nicht geklappt. Bitte erneut versuchen.';
    try { const result = await response.json(); if (typeof result.detail === 'string') message = result.detail; } catch {}
    if (response.status === 401 && authenticated) showLogin('Dein Zugang ist abgelaufen. Bitte den Party-Code erneut eingeben.');
    throw new Error(message);
  }
  return response.status === 204 ? null : response.json();
}

async function enter(user) {
  authenticated = true;
  $('boot').hidden = $('login').hidden = $('profile-setup').hidden = true;
  showUser(user);
  if (!currentUser) {
    $('upload').hidden = $('gallery').hidden = $('play').hidden = $('logout').hidden = true;
    $('profile-setup').hidden = false;
    $('profile-input').focus();
    return false;
  }
  $('logout').hidden = false;
  $('admin').hidden = true;
  $('party-code').value = '';
  $(galleryPage ? 'gallery' : playPage ? 'play' : 'upload').hidden = false;
  if (!galleryPage && !playPage && selected) showReviewShell();
  if (galleryPage) await loadGallery(false);
  if (playPage) await loadPlay();
  return true;
}

$('login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('login-error').textContent = '';
  $('login-submit').disabled = true;
  $('login-submit').textContent = 'Einen Moment …';
  try {
    const result = await api('/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: $('party-code').value, device_id: deviceId() }) });
    if (await enter(result.user)) $(galleryPage ? 'refresh' : playPage ? 'play-toggle' : 'camera').focus();
  } catch (error) { $('login-error').textContent = error.message; }
  finally { $('login-submit').disabled = false; $('login-submit').textContent = 'Dabei sein →'; }
});

$('logout').addEventListener('click', async () => {
  if (uploading) return;
  try { await api('/api/session', { method: 'DELETE' }); location.reload(); }
  catch (error) { window.alert(error.message); }
});

$('profile-logout').addEventListener('click', () => $('logout').click());
$('profile-button').addEventListener('click', () => {
  const opening = $('profile-menu').hidden;
  $('profile-menu').hidden = !opening;
  $('profile-button').setAttribute('aria-expanded', String(opening));
});
document.addEventListener('click', (event) => {
  if (!$('profile-control').hidden && !$('profile-control').contains(event.target)) closeProfileMenu();
});
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  closeProfileMenu();
  if (!$('camera-view').hidden) $('close-camera').click();
  else if (!$('review').hidden && !uploading) $('discard').click();
});

$('profile-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('profile-error').textContent = '';
  $('profile-submit').disabled = true;
  $('profile-submit').textContent = 'Wird gespeichert …';
  try {
    const result = await api('/api/users/me', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: $('profile-input').value }) });
    await enter(result.user);
    $(galleryPage ? 'refresh' : playPage ? 'play-toggle' : 'camera').focus();
  } catch (error) { $('profile-error').textContent = error.message; }
  finally { $('profile-submit').disabled = false; $('profile-submit').innerHTML = 'Weiter zur Party <span aria-hidden="true">→</span>'; }
});

function closeTaskAdd() {
  $('task-add-form').hidden = true;
  $('task-add-open').hidden = false;
  $('task-add-error').textContent = '';
}

$('task-add-open').addEventListener('click', () => {
  $('task-add-open').hidden = true;
  $('task-add-form').hidden = false;
  $('task-add-status').textContent = '';
  $('task-add-input').focus();
});
$('task-add-cancel').addEventListener('click', closeTaskAdd);
$('task-add-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('task-add-error').textContent = '';
  $('task-add-status').textContent = '';
  $('task-add-submit').disabled = true;
  try {
    await api('/api/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: $('task-add-input').value }) });
    $('task-add-input').value = '';
    $('task-add-status').textContent = 'Die Aufgabe ist ab jetzt in der Auswahl.';
  } catch (error) { $('task-add-error').textContent = error.message; }
  finally { $('task-add-submit').disabled = false; }
});

function adminReturnPage() {
  return galleryPage ? 'gallery' : playPage ? 'play' : 'upload';
}

function adminMetric(label, value) {
  const item = document.createElement('div');
  const term = document.createElement('dt');
  const description = document.createElement('dd');
  term.textContent = label;
  description.textContent = String(value);
  item.append(term, description);
  return item;
}

async function hidePhotoFromGallery(photoId, button, messageTarget) {
  if (!currentUser?.is_admin) return;
  if (!window.confirm('Dieses Foto wird nur aus der Galerie ausgeblendet. Die Dateien bleiben im Cloud Bucket erhalten.')) return;
  button.disabled = true;
  try {
    await api(`/api/admin/photos/${photoId}/hide`, { method: 'POST' });
    photos.delete(photoId);
    document.querySelectorAll(`.photo-tile[data-photo-id="${photoId}"]`).forEach((tile) => tile.remove());
    messageTarget.textContent = 'Das Foto ist nicht mehr in der Galerie sichtbar.';
    $('detail-hide').hidden = true;
    if (!$('admin').hidden) await loadAdmin();
  } catch (error) {
    messageTarget.textContent = error.message;
    button.disabled = false;
  }
}

function normalizeAdminSearch(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('de');
}

function searchableAdminText(user) {
  const value = [user.name, user.id, user.device_id, ...(user.photos || []).map((photo) => photo.id)]
    .filter(Boolean)
    .join(' ');
  return normalizeAdminSearch(value);
}

function renderAdminUsers(result) {
  const users = $('admin-users');
  const summary = $('admin-summary');
  const query = normalizeAdminSearch(adminQuery);
  const visibleUsers = (result.users || []).filter((user) => searchableAdminText(user).includes(query));
  users.replaceChildren();
  summary.replaceChildren();
  summary.append(
    adminMetric('Gäste', visibleUsers.length),
    adminMetric('Fotos', visibleUsers.reduce((total, user) => total + (user.photos?.length || 0), 0)),
  );
  summary.hidden = false;
  $('admin-empty').hidden = visibleUsers.length > 0;

  for (const user of visibleUsers) {
    const group = document.createElement('details');
    group.className = 'admin-user';
    const summaryRow = document.createElement('summary');
    summaryRow.className = 'admin-user-summary';
    const identity = document.createElement('div');
    identity.className = 'admin-user-identity';
    const heading = document.createElement('div');
    heading.className = 'admin-user-heading';
    const name = document.createElement('h2');
    name.textContent = user.name;
    heading.append(name);
    if (user.is_admin) {
      const badge = document.createElement('span');
      badge.className = 'admin-badge';
      badge.textContent = 'Admin';
      heading.append(badge);
    }
    const identifiers = document.createElement('p');
    identifiers.className = 'admin-identifiers';
    identifiers.textContent = `${user.id} · ${user.device_id}`;
    identity.append(heading, identifiers);
    const metrics = document.createElement('dl');
    metrics.className = 'admin-user-metrics';
    metrics.append(
      adminMetric('Fotos', user.values?.photos_uploaded || 0),
      adminMetric('Sichtbar', user.values?.photos_visible || 0),
      adminMetric('Ausgeblendet', user.values?.photos_hidden || 0),
    );
    const disclosure = document.createElement('span');
    disclosure.className = 'admin-disclosure';
    disclosure.textContent = `${user.photos?.length || 0} ansehen`;
    summaryRow.append(identity, metrics, disclosure);
    group.append(summaryRow);

    const content = document.createElement('div');
    content.className = 'admin-user-photos';
    if (!user.photos?.length) {
      const empty = document.createElement('p');
      empty.className = 'admin-user-no-photos';
      empty.textContent = 'Noch keine Fotos hochgeladen.';
      content.append(empty);
    } else {
      const previews = document.createElement('div');
      previews.className = 'admin-photo-previews';
      for (const photo of user.photos) {
        const item = document.createElement('div');
        item.className = 'admin-photo-preview';
        const image = document.createElement('img');
        image.src = `/api/photos/${photo.id}/thumb`;
        image.alt = `Vorschau von ${user.name}`;
        image.loading = 'lazy';
        item.append(image);
        if (photo.hidden) {
          const hidden = document.createElement('span');
          hidden.textContent = 'Ausgeblendet';
          item.append(hidden);
        } else {
          const hide = document.createElement('button');
          hide.type = 'button';
          hide.className = 'secondary admin-preview-hide';
          hide.textContent = 'Entfernen';
          hide.setAttribute('aria-label', `Foto von ${user.name} aus der Galerie entfernen`);
          hide.addEventListener('click', () => hidePhotoFromGallery(photo.id, hide, $('admin-error')));
          item.append(hide);
        }
        previews.append(item);
      }
      content.append(previews);
    }
    group.append(content);
    users.append(group);
  }
}

function renderAdminTasks(tasks) {
  const container = $('admin-tasks');
  container.replaceChildren();
  $('admin-tasks-empty').hidden = tasks.length > 0;
  for (const task of tasks) {
    const item = document.createElement('article');
    item.className = 'admin-task';
    const text = document.createElement('textarea');
    text.value = task.text;
    text.maxLength = 500;
    text.rows = 3;
    text.setAttribute('aria-label', 'Foto-Aufgabe bearbeiten');
    const meta = document.createElement('code');
    meta.textContent = task.id;
    const actions = document.createElement('div');
    actions.className = 'admin-task-actions';
    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'secondary';
    save.textContent = 'Speichern';
    save.addEventListener('click', async () => {
      save.disabled = true;
      $('admin-error').textContent = '';
      try {
        await api(`/api/admin/tasks/${task.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: text.value }) });
        await loadAdminTasks();
      } catch (error) { $('admin-error').textContent = error.message; save.disabled = false; }
    });
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'text-button';
    remove.textContent = 'Löschen';
    remove.addEventListener('click', async () => {
      if (!window.confirm('Diese Aufgabe wird aus der Auswahl entfernt. Bereits gemachte Fotos behalten ihre gespeicherte Aufgabe.')) return;
      remove.disabled = true;
      $('admin-error').textContent = '';
      try {
        await api(`/api/admin/tasks/${task.id}`, { method: 'DELETE' });
        await loadAdminTasks();
      } catch (error) { $('admin-error').textContent = error.message; remove.disabled = false; }
    });
    actions.append(save, remove);
    item.append(text, meta, actions);
    container.append(item);
  }
}

async function loadAdminTasks() {
  if (!currentUser?.is_admin) return;
  $('admin-error').textContent = '';
  $('admin-tasks-status').textContent = 'Aufgaben werden geladen …';
  try {
    const result = await api('/api/admin/tasks');
    adminTasks = result.tasks || [];
    renderAdminTasks(adminTasks);
    $('admin-tasks-status').textContent = `${adminTasks.length} ${adminTasks.length === 1 ? 'Aufgabe' : 'Aufgaben'} verfügbar`;
  } catch (error) {
    $('admin-error').textContent = error.message;
    $('admin-tasks-status').textContent = 'Die Aufgaben konnten nicht geladen werden.';
  }
}

async function setAdminTab(tab) {
  adminTab = tab;
  const tasks = tab === 'tasks';
  $('admin-users-tab').setAttribute('aria-selected', String(!tasks));
  $('admin-tasks-tab').setAttribute('aria-selected', String(tasks));
  $('admin-users-pane').hidden = tasks;
  $('admin-tasks-pane').hidden = !tasks;
  if (tasks) await loadAdminTasks();
}

async function loadAdmin() {
  if (!currentUser?.is_admin) return;
  $('admin-error').textContent = '';
  $('admin-status').textContent = 'Daten werden geladen …';
  try {
    const result = await api('/api/admin/overview');
    adminData = result;
    renderAdminUsers(result);
    $('admin-status').textContent = `${result.values?.users || 0} ${result.values?.users === 1 ? 'Person' : 'Personen'} · ${result.values?.photos || 0} Fotos`;
  } catch (error) {
    $('admin-error').textContent = error.message;
    $('admin-status').textContent = 'Die Verwaltung konnte nicht geladen werden.';
  }
}

$('admin-search').addEventListener('input', () => {
  clearTimeout(adminSearchTimer);
  adminSearchTimer = setTimeout(() => {
    adminQuery = $('admin-search').value.trim();
    if (adminData) renderAdminUsers(adminData);
  }, 180);
});

$('admin-users-tab').addEventListener('click', () => setAdminTab('users'));
$('admin-tasks-tab').addEventListener('click', () => setAdminTab('tasks'));
$('admin-task-create-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('admin-error').textContent = '';
  $('admin-task-create-submit').disabled = true;
  try {
    await api('/api/admin/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: $('admin-task-create-input').value }) });
    $('admin-task-create-input').value = '';
    await loadAdminTasks();
  } catch (error) { $('admin-error').textContent = error.message; }
  finally { $('admin-task-create-submit').disabled = false; }
});

$('admin-open').addEventListener('click', async () => {
  closeProfileMenu();
  $('upload').hidden = $('gallery').hidden = $('play').hidden = true;
  $('admin').hidden = false;
  await setAdminTab(adminTab);
  if (adminTab === 'users') await loadAdmin();
  $(adminTab === 'tasks' ? 'admin-tasks-tab' : 'admin-back').focus();
});
$('admin-back').addEventListener('click', async () => {
  $('admin').hidden = true;
  $(adminReturnPage()).hidden = false;
  if (galleryPage) await loadGallery(false);
  if (playPage) await loadPlay();
  $('profile-button').focus();
});

$('camera').addEventListener('click', () => { clearChallenge(false); openCamera(cameraFacing); });
$('library').addEventListener('click', () => { clearChallenge(false); $('library-input').click(); });
$('challenge-draw').addEventListener('click', drawChallenge);
$('challenge-again').addEventListener('click', drawChallenge);
$('challenge-camera').addEventListener('click', () => openCamera(cameraFacing));
$('challenge-library').addEventListener('click', () => $('library-input').click());
$('challenge-cancel').addEventListener('click', () => { clearChallenge(true); $('camera').focus(); });
$('camera-fallback').addEventListener('click', () => $('camera-input').click());
$('close-camera').addEventListener('click', () => {
  stopCamera(true);
  $(currentTask ? 'challenge-camera' : 'camera').focus();
});
$('switch-camera').addEventListener('click', () => {
  cameraFacing = cameraFacing === 'environment' ? 'user' : 'environment';
  openCamera(cameraFacing);
});
$('shutter').addEventListener('click', captureCameraPhoto);
for (const id of ['camera-input', 'library-input']) {
  $(id).addEventListener('change', (event) => {
    const file = event.target.files[0];
    event.target.value = '';
    if (file) {
      if (id === 'camera-input') stopCamera(false);
      selectPhoto(file, id === 'camera-input' ? 'fallback' : 'library');
    }
  });
}

function resetMovableTask(card, restore) {
  card.style.removeProperty('left');
  card.style.removeProperty('top');
  card.style.removeProperty('transform');
  card.hidden = !currentTask;
  restore.hidden = true;
}

function syncTaskOverlay(cardId, textId, restoreId) {
  const card = $(cardId);
  $(textId).textContent = currentTask?.text || '';
  resetMovableTask(card, $(restoreId));
}

function setupMovableTask(cardId, restoreId, hideId) {
  const card = $(cardId);
  const restore = $(restoreId);
  const hide = () => {
    card.hidden = true;
    restore.hidden = !currentTask;
    restore.focus();
  };
  $(hideId).addEventListener('click', hide);
  restore.addEventListener('click', () => {
    resetMovableTask(card, restore);
    card.focus({ preventScroll: true });
  });
  card.tabIndex = 0;
  card.addEventListener('pointerdown', (event) => {
    if (event.target.closest('button') || event.button !== 0) return;
    const rect = card.getBoundingClientRect();
    const offsetX = event.clientX - rect.left;
    const offsetY = event.clientY - rect.top;
    card.setPointerCapture(event.pointerId);
    card.classList.add('is-dragging');
    card.style.transform = 'none';
    const move = (moveEvent) => {
      card.style.left = `${moveEvent.clientX - offsetX}px`;
      card.style.top = `${moveEvent.clientY - offsetY}px`;
    };
    const finish = () => {
      card.classList.remove('is-dragging');
      card.removeEventListener('pointermove', move);
      card.removeEventListener('pointerup', finish);
      card.removeEventListener('pointercancel', finish);
      const after = card.getBoundingClientRect();
      const almostOutside = after.right < 48 || after.left > innerWidth - 48 || after.bottom < 48 || after.top > innerHeight - 48;
      if (almostOutside) hide();
    };
    card.addEventListener('pointermove', move);
    card.addEventListener('pointerup', finish);
    card.addEventListener('pointercancel', finish);
  });
}

setupMovableTask('camera-task', 'camera-task-restore', 'camera-task-hide');
setupMovableTask('active-task', 'preview-task-restore', 'preview-task-hide');

function setCaptureAccessibility(activeId = null) {
  const active = Boolean(activeId);
  document.querySelector('.topbar').inert = active;
  document.querySelector('footer').inert = active;
  for (const child of $('upload').children) child.inert = active && child.id !== activeId;
}

function stopCamera(showPicker) {
  cameraGeneration++;
  cameraStream?.getTracks().forEach((track) => track.stop());
  cameraStream = null;
  $('camera-video').srcObject = null;
  $('camera-view').hidden = true;
  document.body.classList.remove('camera-open');
  setCaptureAccessibility();
  $('shutter').disabled = true;
  $('switch-camera').hidden = true;
  $('camera-fallback').hidden = true;
  if (showPicker) {
    $('challenge').hidden = false;
    $('pick-actions').hidden = Boolean(currentTask);
    $('free-divider').hidden = Boolean(currentTask);
  }
}

function clearChallenge(showPicker) {
  currentTask = null;
  $('challenge-text').textContent = '';
  $('challenge-error').textContent = '';
  $('challenge-panel').hidden = true;
  $('challenge-draw').hidden = false;
  $('active-task').hidden = true;
  if (showPicker) {
    $('pick-actions').hidden = false;
    $('free-divider').hidden = false;
  }
}

async function drawChallenge() {
  if (taskBusy) return;
  taskBusy = true;
  const previous = currentTask?.id;
  $('challenge-error').textContent = '';
  $('challenge-draw').disabled = $('challenge-again').disabled = true;
  $('challenge-draw').querySelector('strong').textContent = 'Aufgabe wird gezogen …';
  $('challenge-again').textContent = 'Einen Moment …';
  try {
    const query = previous ? `?exclude=${encodeURIComponent(previous)}` : '';
    currentTask = await api('/api/tasks/random' + query);
    $('challenge-text').textContent = currentTask.text;
    $('challenge-draw').hidden = true;
    $('challenge-panel').hidden = false;
    $('pick-actions').hidden = true;
    $('free-divider').hidden = true;
    $('challenge-camera').focus();
  } catch (error) {
    $('challenge-error').textContent = error.message;
  } finally {
    taskBusy = false;
    $('challenge-draw').disabled = $('challenge-again').disabled = false;
    $('challenge-draw').querySelector('strong').textContent = 'Aufgabe ziehen';
    $('challenge-again').textContent = 'Andere Aufgabe';
  }
}

function cameraErrorMessage(error) {
  if (!isSecureContext) return 'Die Live-Kamera benötigt eine sichere HTTPS-Verbindung.';
  if (error?.name === 'NotAllowedError' || error?.name === 'SecurityError') return 'Der Kamerazugriff wurde nicht erlaubt. Erlaube ihn in den Browser-Einstellungen oder nutze die Gerätekamera unten.';
  if (error?.name === 'NotFoundError' || error?.name === 'OverconstrainedError') return 'Auf diesem Gerät wurde keine passende Kamera gefunden.';
  if (error?.name === 'NotReadableError' || error?.name === 'AbortError') return 'Die Kamera wird gerade von einer anderen App verwendet oder konnte nicht gestartet werden.';
  return 'Die Live-Kamera ist in diesem Browser nicht verfügbar. Du kannst stattdessen die Gerätekamera oder eine Datei öffnen.';
}

async function openCamera(facing) {
  stopCamera(false);
  const generation = cameraGeneration;
  document.body.classList.remove('review-open');
  document.body.classList.add('camera-open');
  setCaptureAccessibility('camera-view');
  $('review').hidden = true;
  $('pick-actions').hidden = true;
  $('free-divider').hidden = true;
  $('challenge').hidden = !currentTask;
  $('camera-view').hidden = false;
  syncTaskOverlay('camera-task', 'camera-task-text', 'camera-task-restore');
  $('camera-video').hidden = true;
  $('camera-status').textContent = 'Kamera wird geöffnet …';
  $('camera-fallback').hidden = true;
  $('shutter').disabled = true;
  try {
    if (!navigator.mediaDevices?.getUserMedia) throw new DOMException('getUserMedia unavailable', 'NotSupportedError');
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: facing }, width: { ideal: 1920 }, height: { ideal: 1080 } },
    });
    if (generation !== cameraGeneration) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    cameraStream = stream;
    $('camera-video').srcObject = stream;
    $('camera-video').hidden = false;
    await $('camera-video').play();
    $('camera-status').textContent = 'Richte die Kamera aus und löse das Foto aus.';
    $('shutter').disabled = false;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      $('switch-camera').hidden = devices.filter((device) => device.kind === 'videoinput').length < 2;
    } catch {}
    $('shutter').focus();
  } catch (error) {
    if (generation !== cameraGeneration) return;
    cameraStream?.getTracks().forEach((track) => track.stop());
    cameraStream = null;
    $('camera-video').srcObject = null;
    $('camera-video').hidden = true;
    $('camera-status').textContent = cameraErrorMessage(error);
    $('camera-fallback').hidden = false;
    $('camera-fallback').focus();
  }
}

async function captureCameraPhoto() {
  const video = $('camera-video');
  const width = video.videoWidth;
  const height = video.videoHeight;
  if (!cameraStream || !width || !height) {
    $('camera-status').textContent = 'Die Kamera ist noch nicht bereit. Bitte einen Moment warten.';
    return;
  }
  if (width * height > 64_000_000) {
    $('camera-status').textContent = 'Die Kameraaufnahme hat mehr als 64 Megapixel und kann nicht gespeichert werden.';
    return;
  }
  $('shutter').disabled = true;
  $('camera-status').textContent = 'Aufnahme wird vorbereitet …';
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (cameraFacing === 'user') {
    // Match the iPhone Camera default: saved front-camera photos are not mirrored.
    context.translate(width, 0);
    context.scale(-1, 1);
  }
  context.drawImage(video, 0, 0, width, height);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.94));
  if (!blob) {
    $('camera-status').textContent = 'Das Foto konnte nicht erstellt werden. Bitte erneut versuchen.';
    $('shutter').disabled = false;
    return;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = new File([blob], `aufnahme-${stamp}.jpg`, { type: 'image/jpeg', lastModified: Date.now() });
  stopCamera(false);
  await selectPhoto(file, 'camera');
}

function clearSelection() {
  previewGeneration++;
  selected = null;
  uploadId = null;
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = null;
  selectionSource = null;
  document.body.classList.remove('review-open');
  setCaptureAccessibility();
  $('preview').removeAttribute('src');
  $('preview').hidden = $('review').hidden = $('success').hidden = $('progress-wrap').hidden = true;
  $('challenge').hidden = false;
  $('challenge-draw').hidden = Boolean(currentTask);
  $('challenge-panel').hidden = !currentTask;
  $('active-task').hidden = true;
  $('preview-task-restore').hidden = true;
  $('pick-actions').hidden = Boolean(currentTask);
  $('free-divider').hidden = Boolean(currentTask);
  $('upload-error').textContent = '';
  $('send').disabled = true;
  $('send').textContent = 'Foto hochladen ↑';
}

function showReviewShell() {
  document.body.classList.remove('camera-open');
  document.body.classList.add('review-open');
  setCaptureAccessibility('review');
  $('challenge').hidden = true;
  $('pick-actions').hidden = true;
  $('free-divider').hidden = true;
  $('review').hidden = false;
  syncTaskOverlay('active-task', 'active-task-text', 'preview-task-restore');
  const returnsToCamera = selectionSource === 'camera';
  $('discard').setAttribute('aria-label', returnsToCamera ? 'Zurück zur Kamera' : 'Vorschau schließen');
  $('discard-label').textContent = returnsToCamera ? 'Zur Kamera' : 'Schließen';
}

function decodeImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Bildvorschau nicht verfügbar.'));
    image.src = url;
  });
}

let heicModule;
async function convertHeic(file) {
  heicModule ||= import('/static/vendor/heic-to.js');
  const module = await heicModule;
  return module.heicTo({ blob: file, type: 'image/jpeg', quality: 0.75 });
}

async function selectPhoto(file, source = 'library') {
  clearSelection();
  selectionSource = source;
  showReviewShell();
  const generation = previewGeneration;
  if (file.size > MAX_BYTES) { $('upload-error').textContent = 'Dieses Foto ist größer als 25 MiB. Bitte ein anderes wählen.'; return; }
  if (!file.size) { $('upload-error').textContent = 'Die Datei ist leer. Bitte ein anderes Foto wählen.'; return; }
  selected = file;
  uploadId = crypto.randomUUID();
  $('file-info').textContent = `${(file.size / 1024 / 1024).toLocaleString('de', { maximumFractionDigits: 1 })} MiB · Original bleibt erhalten`;
  $('preview-status').textContent = 'Vorschau wird auf deinem Gerät erstellt …';
  let url = URL.createObjectURL(file);
  try {
    let image;
    try { image = await decodeImage(url); }
    catch {
      if (!/heic|heif/i.test(file.type + file.name)) throw new Error('Dieses Bild lässt sich nicht anzeigen. Bitte ein JPEG-, PNG-, WebP- oder HEIC-Foto wählen.');
      URL.revokeObjectURL(url);
      const converted = await convertHeic(file);
      url = URL.createObjectURL(converted);
      image = await decodeImage(url);
    }
    if (generation !== previewGeneration) { URL.revokeObjectURL(url); return; }
    if (image.naturalWidth * image.naturalHeight > 64_000_000) throw new Error('Dieses Foto hat mehr als 64 Megapixel. Bitte ein anderes wählen.');
    previewUrl = url;
    $('preview').src = url;
    $('preview').hidden = false;
    $('preview-status').textContent = 'Sieht gut aus? Erst beim Hochladen wird dein Foto geteilt.';
    $('send').disabled = false;
    $('send').focus();
  } catch (error) {
    URL.revokeObjectURL(url);
    if (generation !== previewGeneration) return;
    $('preview-status').textContent = '';
    $('upload-error').textContent = error.message || 'Die Vorschau konnte nicht erstellt werden. Bitte ein anderes Foto wählen.';
  }
}

$('discard').addEventListener('click', () => {
  const reopenCamera = selectionSource === 'camera';
  const focusTarget = currentTask ? 'challenge-camera' : 'camera';
  clearSelection();
  if (reopenCamera) openCamera(cameraFacing);
  else $(focusTarget).focus();
});
$('another').addEventListener('click', () => { clearSelection(); $('camera').focus(); });

function sendPhoto(file, id, task) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/photos');
    xhr.timeout = 300000;
    const data = new FormData();
    data.append('upload_id', id);
    if (task?.id) data.append('task_id', task.id);
    data.append('photo', file);
    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable) return;
      const value = Math.round(event.loaded / event.total * 100);
      $('progress').value = value;
      $('progress-text').textContent = value < 100 ? `Foto wird übertragen: ${value} %` : 'Foto ist übertragen. Es wird gespeichert und für die Galerie vorbereitet …';
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) { resolve({ created: xhr.status === 201 }); return; }
      let message = 'Upload fehlgeschlagen. Du kannst es mit demselben Foto erneut versuchen.';
      try { const result = JSON.parse(xhr.responseText); if (typeof result.detail === 'string') message = result.detail; } catch {}
      if (xhr.status === 401) showLogin('Bitte den Party-Code erneut eingeben. Dein ausgewähltes Foto bleibt hier erhalten.');
      reject(new Error(message));
    };
    xhr.onerror = () => reject(new Error('Die Verbindung wurde unterbrochen. Bitte erneut versuchen; dein Foto wird nicht doppelt gespeichert.'));
    xhr.ontimeout = () => reject(new Error('Die Übertragung dauert zu lange. Bitte die Verbindung prüfen und erneut versuchen.'));
    xhr.send(data);
  });
}

$('send').addEventListener('click', async () => {
  if (!selected || uploading) return;
  uploading = true;
  $('send').disabled = $('discard').disabled = $('logout').disabled = true;
  $('send').textContent = 'Wird hochgeladen …';
  $('upload-error').textContent = '';
  $('progress-wrap').hidden = false;
  $('progress').value = 0;
  $('progress-text').textContent = 'Die Übertragung startet …';
  try {
    const result = await sendPhoto(selected, uploadId, currentTask);
    if (result.created && currentUser?.values) {
      showUser({
        ...currentUser,
        values: {
          ...currentUser.values,
          photos_uploaded: (currentUser.values.photos_uploaded || 0) + 1,
        },
      });
    }
    api('/api/session').then((profile) => showUser(profile.user)).catch(() => {});
    clearSelection();
    clearChallenge(false);
    $('challenge').hidden = true;
    $('free-divider').hidden = true;
    $('pick-actions').hidden = true;
    $('success').hidden = false;
    $('another').focus();
  } catch (error) {
    $('upload-error').textContent = error.message;
    $('progress-wrap').hidden = true;
    $('send').disabled = false;
    $('send').textContent = 'Erneut hochladen ↑';
  } finally {
    uploading = false;
    $('discard').disabled = $('logout').disabled = false;
  }
});

window.addEventListener('beforeunload', (event) => {
  if (uploading) { event.preventDefault(); event.returnValue = ''; }
});
window.addEventListener('pagehide', () => stopCamera(false));

const REACTION_EMOJIS = ['❤️', '😂', '😍', '👏', '🔥'];
const pendingReactions = new Set();

function reactionSummaryText(interactions) {
  const reactions = Array.isArray(interactions?.reactions) ? interactions.reactions : [];
  const reactionText = reactions
    .filter((reaction) => reaction?.emoji && Number(reaction.count) > 0)
    .map((reaction) => `${reaction.emoji} ${reaction.count}`)
    .join(' ');
  const comments = Number(interactions?.comments_count) || 0;
  return [reactionText, comments ? `💬 ${comments}` : ''].filter(Boolean).join(' · ');
}

function renderTileInteractions(tile, interactions) {
  const text = reactionSummaryText(interactions);
  const current = tile.querySelector('.photo-interaction-summary');
  if (!text) {
    current?.remove();
    return;
  }
  const summary = current || document.createElement('span');
  summary.className = 'photo-interaction-summary';
  summary.textContent = text;
  if (!current) {
    const meta = tile.querySelector('.photo-tile-meta');
    (meta || tile).append(summary);
  }
}

function updatePhotoInteractions(photoId, interactions) {
  const photo = photos.get(photoId);
  if (photo) {
    photo.interactions = {
      reactions: interactions.reactions || [],
      comments_count: interactions.comments_count || 0,
    };
  }
  document.querySelectorAll(`.photo-tile[data-photo-id="${photoId}"]`).forEach((tile) => {
    renderTileInteractions(tile, interactions);
  });
}

function commentDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? '' : date.toLocaleString('de', {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  });
}

function renderDetailInteractions(interactions) {
  const mine = new Set(interactions.mine || []);
  const options = $('detail-reaction-options');
  const counts = $('detail-reaction-counts');
  const comments = $('detail-comments');
  options.replaceChildren();
  for (const emoji of REACTION_EMOJIS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'reaction-button';
    button.textContent = emoji;
    button.title = `Mit ${emoji} reagieren`;
    button.setAttribute('aria-label', mine.has(emoji) ? `Reaktion ${emoji} entfernen` : `Mit ${emoji} reagieren`);
    button.setAttribute('aria-pressed', String(mine.has(emoji)));
    if (mine.has(emoji)) button.title = `Du hast mit ${emoji} reagiert`;
    button.addEventListener('click', async () => {
      if (!activeDetailPhoto) return;
      const photoId = activeDetailPhoto.id;
      const reactionKey = `${photoId}:${emoji}`;
      if (pendingReactions.has(reactionKey)) return;
      const active = !mine.has(emoji);
      pendingReactions.add(reactionKey);
      button.setAttribute('aria-pressed', String(active));
      button.title = active ? `Du hast mit ${emoji} reagiert` : `Mit ${emoji} reagieren`;
      button.setAttribute('aria-label', active ? `Reaktion ${emoji} entfernen` : `Mit ${emoji} reagieren`);
      try {
        const result = await api(`/api/photos/${photoId}/reactions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ emoji, active }),
        });
        if (activeDetailPhoto?.id === photoId) {
          updatePhotoInteractions(photoId, result);
          renderDetailInteractions(result);
        }
      } catch (error) {
        $('detail-comment-error').textContent = error.message;
        button.setAttribute('aria-pressed', String(!active));
        button.title = !active ? `Du hast mit ${emoji} reagiert` : `Mit ${emoji} reagieren`;
        button.setAttribute('aria-label', !active ? `Reaktion ${emoji} entfernen` : `Mit ${emoji} reagieren`);
      } finally {
        pendingReactions.delete(reactionKey);
      }
    });
    options.append(button);
  }
  const reactionText = reactionSummaryText(interactions);
  counts.textContent = reactionText || 'Noch keine Reaktionen.';
  comments.replaceChildren();
  const entries = Array.isArray(interactions.comments) ? interactions.comments : [];
  if (!entries.length) {
    const empty = document.createElement('p');
    empty.className = 'comment-empty';
    empty.textContent = 'Noch keine Kommentare.';
    comments.append(empty);
    return;
  }
  for (const comment of entries) {
    const item = document.createElement('article');
    item.className = 'comment';
    const metadata = document.createElement('p');
    metadata.className = 'comment-meta';
    metadata.textContent = `${comment.author?.name || 'Gast'}${commentDate(comment.created_at) ? ` · ${commentDate(comment.created_at)}` : ''}`;
    const text = document.createElement('p');
    text.textContent = comment.text || '';
    item.append(metadata, text);
    comments.append(item);
  }
}

async function loadDetailInteractions(photoId) {
  $('detail-reaction-counts').textContent = 'Reaktionen werden geladen …';
  $('detail-comments').replaceChildren();
  try {
    const interactions = await api(`/api/photos/${photoId}/interactions`);
    if (activeDetailPhoto?.id !== photoId) return;
    updatePhotoInteractions(photoId, interactions);
    renderDetailInteractions(interactions);
  } catch (error) {
    if (activeDetailPhoto?.id === photoId) {
      $('detail-reaction-counts').textContent = 'Reaktionen konnten nicht geladen werden.';
      $('detail-comment-error').textContent = error.message;
    }
  }
}

function photoButton(photo) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'photo-tile';
  button.dataset.photoId = photo.id;
  const width = Number(photo.width);
  const height = Number(photo.height);
  if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
    button.style.setProperty('--gallery-photo-ratio', `${width} / ${height}`);
    button.classList.add(width > height ? 'is-landscape' : width < height ? 'is-portrait' : 'is-square');
  } else {
    button.classList.add('is-portrait');
  }
  const date = new Date(photo.created_at).toLocaleString('de', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const task = photo.task || photo.metadata?.task;
  const author = photo.author || photo.metadata?.author;
  const authorText = author?.name ? ` Hochgeladen von ${author.name}.` : '';
  button.setAttribute('aria-label', task ? `Foto vom ${date} öffnen.${authorText} Aufgabe: ${task.text}` : `Foto vom ${date} öffnen.${authorText}`);
  const image = document.createElement('img');
  image.src = `/api/photos/${photo.id}/thumb`;
  image.alt = `Partyfoto vom ${date}`;
  image.loading = 'lazy';
  image.decoding = 'async';
  if (task?.text) {
    const label = document.createElement('span');
    label.className = 'photo-task-label';
    label.textContent = task.text;
    button.append(label);
  }
  button.append(image);
  const meta = document.createElement('div');
  meta.className = 'photo-tile-meta';
  if (author?.name) {
    const credit = document.createElement('span');
    credit.className = 'photo-author-label';
    credit.textContent = author.name;
    meta.append(credit);
  }
  button.append(meta);
  renderTileInteractions(button, photo.interactions);
  button.addEventListener('click', () => {
    activeDetailPhoto = photo;
    detailButton = button;
    scrollPosition = window.scrollY;
    $('gallery-overview').hidden = true;
    $('photo-detail').hidden = false;
    $('detail-status').textContent = 'Foto wird geladen …';
    $('detail-image').onload = () => { $('detail-status').textContent = ''; };
    $('detail-image').onerror = () => { $('detail-status').textContent = 'Foto nicht erreichbar. Bitte die Galerie aktualisieren oder neu anmelden.'; };
    $('detail-image').src = `/api/photos/${photo.id}/display`;
    $('detail-image').alt = `Partyfoto vom ${date}`;
    $('detail-author').hidden = !author?.name;
    $('detail-author').textContent = author?.name ? `Hochgeladen von ${author.name}` : '';
    $('detail-task').hidden = !task?.text;
    $('detail-task-text').textContent = task?.text || '';
    $('download').href = `/api/photos/${photo.id}/original`;
    $('detail-hide').hidden = !currentUser?.is_admin;
    $('detail-hide').onclick = () => hidePhotoFromGallery(photo.id, $('detail-hide'), $('detail-status'));
    $('detail-comment-input').value = '';
    $('detail-comment-error').textContent = '';
    void loadDetailInteractions(photo.id);
    window.scrollTo(0, 0);
    $('back-to-grid').focus();
  });
  return button;
}

function playTask(photo) {
  const task = photo?.task || photo?.metadata?.task;
  return task && typeof task.text === 'string' ? task.text : '';
}

function renderBookPhoto(figure, photo) {
  const image = figure.querySelector('img');
  const caption = figure.querySelector('figcaption');
  if (!photo) {
    figure.hidden = true;
    figure.classList.remove('has-task');
    image.removeAttribute('src');
    image.alt = '';
    caption.textContent = '';
    return;
  }
  figure.hidden = false;
  const date = new Date(photo.created_at).toLocaleString('de', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  image.src = `/api/photos/${photo.id}/display`;
  image.alt = `Partyfoto vom ${date}`;
  const task = playTask(photo);
  figure.classList.toggle('has-task', Boolean(task));
  caption.textContent = task;
}

function updatePlayButton() {
  $('play-toggle').innerHTML = playPlaying ? '<span aria-hidden="true">Ⅱ</span> Pausieren' : '<span aria-hidden="true">▶</span> Abspielen';
  $('play-toggle').setAttribute('aria-pressed', String(playPlaying));
}

function schedulePlay() {
  clearTimeout(playTimer);
  if (authenticated && playPage && playPlaying && !document.hidden) {
    playTimer = setTimeout(loadPlay, 9000);
  }
}

async function loadPlay() {
  if (playBusy || !authenticated || !playPage) return;
  playBusy = true;
  clearTimeout(playTimer);
  $('play-next').disabled = $('play-toggle').disabled = true;
  $('play-error').textContent = '';
  $('play-status').textContent = 'Eine neue Seite wird aufgeschlagen …';
  try {
    const query = new URLSearchParams({ count: '4' });
    if (playRecent.length) query.set('exclude', playRecent.slice(-12).join(','));
    let result = await api('/api/photos/play?' + query);
    // A small party may contain fewer photos than the recent-repeat window.
    if (!result.photos.length && playRecent.length) {
      playRecent.length = 0;
      result = await api('/api/photos/play?count=4');
    }
    const batch = result.photos || [];
    if (!batch.length) {
      $('book-spread').hidden = true;
      $('play-empty').hidden = false;
      $('play-status').textContent = 'Noch keine Fotos in der Galerie.';
      return;
    }
    $('book-spread').hidden = false;
    $('play-empty').hidden = true;
    const figures = [...document.querySelectorAll('.book-photo[data-slot]')];
    for (const figure of figures) renderBookPhoto(figure, batch[Number(figure.dataset.slot)]);
    playRecent.push(...batch.map((photo) => photo.id));
    while (playRecent.length > 20) playRecent.shift();
    playPageNumber = (playPageNumber % 99) + 1;
    $('book-page-number').textContent = String(playPageNumber).padStart(2, '0');
    $('play-status').textContent = `${batch.length} ${batch.length === 1 ? 'Moment' : 'Momente'} auf dieser Seite · Neuere Fotos werden bevorzugt.`;
    $('book-stage').classList.remove('is-turning');
    void $('book-stage').offsetWidth;
    $('book-stage').classList.add('is-turning');
  } catch (error) {
    $('play-error').textContent = error.message;
    $('play-status').textContent = 'Das Fotobuch konnte nicht aktualisiert werden.';
  } finally {
    playBusy = false;
    $('play-next').disabled = $('play-toggle').disabled = false;
    schedulePlay();
  }
}

$('play-toggle').addEventListener('click', () => {
  playPlaying = !playPlaying;
  updatePlayButton();
  if (playPlaying) {
    loadPlay();
  } else {
    clearTimeout(playTimer);
  }
});
$('play-next').addEventListener('click', loadPlay);

$('back-to-grid').addEventListener('click', () => {
  $('photo-detail').hidden = true;
  $('gallery-overview').hidden = false;
  activeDetailPhoto = null;
  $('detail-comment-error').textContent = '';
  window.scrollTo(0, scrollPosition);
  detailButton?.focus({ preventScroll: true });
});

$('detail-comment-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!activeDetailPhoto) return;
  const photoId = activeDetailPhoto.id;
  const submit = $('detail-comment-submit');
  $('detail-comment-error').textContent = '';
  submit.disabled = true;
  try {
    const result = await api(`/api/photos/${photoId}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: $('detail-comment-input').value }),
    });
    if (activeDetailPhoto?.id === photoId && !$('photo-detail').hidden) {
      updatePhotoInteractions(photoId, result);
      renderDetailInteractions(result);
      $('detail-comment-input').value = '';
    }
  } catch (error) {
    $('detail-comment-error').textContent = error.message;
  } finally {
    submit.disabled = false;
  }
});

function scheduleRefresh() {
  clearTimeout(timer);
  if (authenticated && galleryPage && !document.hidden) timer = setTimeout(() => loadGallery(false), 15000);
}

async function loadGallery(more) {
  if (galleryBusy || !authenticated) return;
  const requestedQuery = galleryQuery;
  galleryBusy = true;
  $('refresh').disabled = $('load-more').disabled = true;
  $('gallery-error').textContent = '';
  try {
    const parameters = new URLSearchParams();
    if (more && nextCursor) parameters.set('cursor', nextCursor);
    if (requestedQuery) parameters.set('q', requestedQuery);
    const query = parameters.size ? `?${parameters}` : '';
    let result = await api('/api/photos' + query);
    if (requestedQuery !== galleryQuery) return;
    let batch = [...result.photos];
    if (more || !galleryLoaded) nextCursor = result.next_cursor;
    // Catch up even if over 30 photos arrive between polls, without resetting older pages.
    if (!more && galleryLoaded && photos.size) {
      while (result.next_cursor && !result.photos.some((photo) => photos.has(photo.id))) {
        const catchup = new URLSearchParams({ cursor: result.next_cursor });
        if (requestedQuery) catchup.set('q', requestedQuery);
        result = await api('/api/photos?' + catchup);
        if (requestedQuery !== galleryQuery) return;
        batch.push(...result.photos);
      }
    } else if (!more && galleryLoaded && !photos.size) nextCursor = result.next_cursor;
    const fragment = document.createDocumentFragment();
    let added = 0;
    for (const photo of batch) {
      if (photos.has(photo.id)) continue;
      photos.set(photo.id, photo);
      fragment.append(photoButton(photo));
      added++;
    }
    if (more) $('photo-grid').append(fragment); else $('photo-grid').prepend(fragment);
    galleryLoaded = true;
    $('gallery-empty').hidden = photos.size > 0;
    if (!photos.size && requestedQuery) {
      $('gallery-empty').querySelector('h2').textContent = 'Keine passenden Fotos gefunden.';
      $('gallery-empty').querySelector('p').textContent = `Für „${requestedQuery}“ gibt es noch keinen Treffer.`;
    } else {
      $('gallery-empty').querySelector('h2').textContent = 'Der erste Moment fehlt noch.';
      $('gallery-empty').querySelector('p').textContent = 'Mach den Anfang und teile ein Foto von der Party.';
    }
    $('load-more').hidden = !nextCursor;
    $('gallery-status').textContent = photos.size ? `${photos.size} ${photos.size === 1 ? 'Foto' : 'Fotos'} geladen${added && !more ? ' · Gerade aktualisiert' : ''}. Neue Fotos erscheinen automatisch.` : 'Neue Fotos erscheinen hier automatisch.';
  } catch (error) { $('gallery-error').textContent = error.message; $('gallery-status').textContent = 'Die Galerie konnte nicht aktualisiert werden.'; }
  finally {
    galleryBusy = false;
    $('refresh').disabled = $('load-more').disabled = false;
    if (requestedQuery !== galleryQuery) void loadGallery(false);
    else scheduleRefresh();
  }
}

$('refresh').addEventListener('click', () => loadGallery(false));
$('load-more').addEventListener('click', () => loadGallery(true));
$('gallery-search').addEventListener('input', () => {
  clearTimeout(gallerySearchTimer);
  gallerySearchTimer = setTimeout(() => {
    const query = $('gallery-search').value.trim();
    if (query === galleryQuery) return;
    galleryQuery = query;
    nextCursor = null;
    galleryLoaded = false;
    photos.clear();
    $('photo-grid').replaceChildren();
    $('load-more').hidden = true;
    void loadGallery(false);
  }, 180);
});
document.addEventListener('visibilitychange', () => {
  clearTimeout(timer);
  clearTimeout(playTimer);
  if (!document.hidden && galleryPage && authenticated) loadGallery(false);
  if (!document.hidden && playPage && authenticated && playPlaying) loadPlay();
});

updatePlayButton();
try {
  const activeSession = await api('/api/session');
  await enter(activeSession.user);
} catch (error) {
  try {
    const restored = await api('/api/session/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_id: deviceId() }),
    });
    await enter(restored.user);
  } catch (restoreError) {
    showLogin(error.message === 'Bitte den Party-Code eingeben.' ? '' : error.message);
  }
}
