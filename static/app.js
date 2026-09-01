const $ = (id) => document.getElementById(id);
const galleryPage = location.pathname === '/gallery';
const streamPage = location.pathname === '/stream';
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
let cameraTorchOn = false;
let cameraGeneration = 0;
let selectionSource = null;
let currentTask = null;
let taskBusy = false;
// The stream keeps no server state: every screen derives what it shows from the
// clock, which is what keeps the television and the phones together.
const STREAM_SPACING = 340; // distance in depth between two photos
const STREAM_SPEED = 46; // pixels per second the camera glides forward
const STREAM_VISIBLE = 12; // photos in flight at any one moment
const STREAM_FRESH = 8; // newest photos that get the extra turn
const STREAM_PERSPECTIVE = 1200; // has to match the perspective on .stream-stage
const STREAM_SPREAD_X = 52; // widest scatter on screen, percent of the stage width
const STREAM_SPREAD_Y = 46; // widest scatter on screen, percent of the stage height
const STREAM_CONVERGE_MIN = 0.18; // scatter kept at the very front, so nothing snaps
const STREAM_FADE_OUT = 0.18; // fraction of one spacing a passing photo fades over
const STREAM_BLUR_MAX = 2.4; // strongest background blur, measured on screen
const STREAM_BLUR_RATE = 0.75; // screen blur gained per spacing of depth
const STREAM_GOLDEN_ANGLE = 2.399963229728653; // 137.5 degrees, in radians
let streamTimer = null;
let streamFrameHandle = null;
let streamPollTimer = null;
let streamPlaylist = [];
let streamSignature = null;
let streamClockOffset = 0;
const streamSlots = [];
const streamPhotoById = new Map();
const streamStageSize = { width: 0, height: 0 };
// The television at the party is an old one. Rather than guess its budget,
// the stream watches its own frame rate and drops effects until it keeps up.
let streamQuality = 0;
let streamFrames = 0;
let streamWindowStart = 0;
const streamReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

$('page-backdrop').hidden = false;
$(streamPage ? 'nav-stream' : galleryPage ? 'nav-gallery' : 'nav-upload').setAttribute('aria-current', 'page');
document.title = galleryPage ? 'Unsere Galerie · 180. Geburtstag' : streamPage ? 'Stream · 180. Geburtstag' : 'Foto teilen · 180. Geburtstag';

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
  stopStream();
  authenticated = false;
  showUser(null);
  closeProfileMenu();
  clearTimeout(timer);
  $('login').hidden = false;
  $('profile-setup').hidden = $('upload').hidden = $('gallery').hidden = $('stream').hidden = $('admin').hidden = $('logout').hidden = $('boot').hidden = true;
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
    $('upload').hidden = $('gallery').hidden = $('stream').hidden = $('logout').hidden = true;
    $('profile-setup').hidden = false;
    $('profile-input').focus();
    return false;
  }
  $('logout').hidden = false;
  $('admin').hidden = true;
  $('party-code').value = '';
  $(galleryPage ? 'gallery' : streamPage ? 'stream' : 'upload').hidden = false;
  if (!galleryPage && !streamPage && selected) showReviewShell();
  if (galleryPage) await loadGallery(false);
  if (streamPage) await loadStream();
  return true;
}

$('login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('login-error').textContent = '';
  $('login-submit').disabled = true;
  $('login-submit').textContent = 'Einen Moment …';
  try {
    const result = await api('/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: $('party-code').value, device_id: deviceId() }) });
    if (await enter(result.user)) $(galleryPage ? 'refresh' : streamPage ? 'stream-fullscreen' : 'camera').focus();
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
    $(galleryPage ? 'refresh' : streamPage ? 'stream-fullscreen' : 'camera').focus();
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
  return galleryPage ? 'gallery' : streamPage ? 'stream' : 'upload';
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
  $('upload').hidden = $('gallery').hidden = $('stream').hidden = true;
  stopStream();
  $('admin').hidden = false;
  await setAdminTab(adminTab);
  if (adminTab === 'users') await loadAdmin();
  $(adminTab === 'tasks' ? 'admin-tasks-tab' : 'admin-back').focus();
});
$('admin-back').addEventListener('click', async () => {
  $('admin').hidden = true;
  $(adminReturnPage()).hidden = false;
  if (galleryPage) await loadGallery(false);
  if (streamPage) await loadStream();
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
  cameraTorchOn = false;
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
    // Phones routinely report a single video input even when they have a front
    // and a rear lens, which hid this button on exactly the devices that need
    // it. A coarse pointer is taken as evidence of a handheld camera pair, and
    // switching is safe either way: facingMode is an ideal, so the worst case
    // is the same lens coming back.
    const track = stream.getVideoTracks()[0];
    // Only a rear lens usually has a lamp, and only some browsers expose it.
    const torchCapable = Boolean(track?.getCapabilities?.().torch);
    cameraTorchOn = false;
    $('camera-torch').hidden = !torchCapable;
    $('camera-torch').setAttribute('aria-pressed', 'false');
    const handheld = matchMedia('(pointer: coarse)').matches;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const cameras = devices.filter((device) => device.kind === 'videoinput').length;
      $('switch-camera').hidden = cameras < 2 && !handheld;
    } catch {
      $('switch-camera').hidden = !handheld;
    }
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

function streamPlaylistFrom(list) {
  if (!list.length) return [];
  // The server sends newest first. Alternating the freshest photos with a walk
  // through the whole list gives new uploads a visible head start while every
  // photo keeps coming back around.
  const fresh = list.slice(0, Math.min(STREAM_FRESH, list.length));
  const playlist = [];
  for (let i = 0; i < Math.max(list.length, fresh.length); i += 1) {
    playlist.push(fresh[i % fresh.length]);
    playlist.push(list[i % list.length]);
  }
  // The same picture twice in a row reads as a frozen screen.
  return playlist.filter((photo, index) => index === 0 || photo.id !== playlist[index - 1].id);
}

// Photos sit on a fixed grid in depth and the camera glides forward along it,
// so a photo's position is a plain function of the clock. That is what keeps
// the television and every phone showing the same thing.
function streamCameraZ() {
  return ((Date.now() + streamClockOffset) / 1000) * STREAM_SPEED;
}

function streamPlacement(index) {
  // A golden-angle spiral instead of a pseudo-random scatter: successive photos
  // land a third of a turn apart, so none of them ends up hidden straight
  // behind its neighbour. The angle is folded into one turn first, which keeps
  // the trigonometry well conditioned for the very large indices the clock
  // produces. Everything derives from the index alone, so every screen places
  // the photos identically.
  // The radius must not be driven by the golden ratio as well: it correlates
  // with the golden angle and leaves the corners of the stage empty, so it uses
  // a different irrational. Keeping it well away from zero turns the field into
  // a ring: the far photos sweep around the edges of the screen and leave the
  // middle to whichever photo is currently arriving.
  const angle = (index * STREAM_GOLDEN_ANGLE) % (Math.PI * 2);
  const radius = 0.6 + 0.4 * ((index * 0.4142135623730951) % 1);
  return {
    x: Math.cos(angle) * radius,
    y: Math.sin(angle) * radius,
    tilt: (((index * 0.7548776662466927) % 1) - 0.5) * 8,
  };
}

function buildStreamSlots() {
  const track = $('stream-track');
  track.replaceChildren();
  streamSlots.length = 0;
  for (let i = 0; i <= STREAM_VISIBLE; i += 1) {
    const figure = document.createElement('figure');
    const image = document.createElement('img');
    const caption = document.createElement('figcaption');
    figure.className = 'stream-photo';
    image.decoding = 'async';
    image.alt = '';
    caption.className = 'stream-caption';
    // A slot always keeps its place in the queue, so its stacking order is
    // fixed. Stating it explicitly matters because a filtered element drops out
    // of the 3D sorting and would otherwise paint in DOM order.
    figure.style.zIndex = String(STREAM_VISIBLE + 1 - i);
    figure.append(image, caption);
    track.append(figure);
    streamSlots.push({
      node: figure, image, caption, photoId: null, index: null, blur: null, place: null,
    });
  }
}

function measureStreamStage() {
  // Read once per resize rather than per frame: the scatter is expressed in
  // stage widths, and touching layout inside the animation loop would stall it.
  const stage = $('stream-stage');
  streamStageSize.width = stage.clientWidth;
  streamStageSize.height = stage.clientHeight;
}

function renderStreamCaption(slot, photo) {
  if (!photo) {
    slot.caption.replaceChildren();
    return;
  }
  const parts = [];
  if (photo.task) {
    const task = document.createElement('span');
    task.className = 'stream-task';
    task.textContent = photo.task;
    parts.push(task);
  }
  const meta = document.createElement('span');
  meta.className = 'stream-meta';
  if (photo.author) {
    const author = document.createElement('span');
    author.className = 'stream-author';
    author.textContent = photo.author;
    meta.append(author);
  }
  for (const reaction of photo.reactions || []) {
    const badge = document.createElement('span');
    badge.className = 'stream-reaction';
    badge.textContent = `${reaction.emoji} ${reaction.count}`;
    meta.append(badge);
  }
  if (meta.childElementCount) parts.push(meta);
  slot.caption.replaceChildren(...parts);
}

function paintStream() {
  if (!streamPlaylist.length || !streamSlots.length) return;
  if (!streamStageSize.width) measureStreamStage();
  const cameraZ = streamCameraZ();
  // Ceil, not floor: this has to be the first photo the camera has not passed yet.
  const front = Math.ceil(cameraZ / STREAM_SPACING);
  const furthest = STREAM_SPACING * STREAM_VISIBLE;
  for (let position = 0; position < streamSlots.length; position += 1) {
    const slot = streamSlots[position];
    // One slot trails the camera so a photo is still visible while it sweeps past.
    const index = front - 1 + position;
    const depth = index * STREAM_SPACING - cameraZ;
    if (slot.index !== index) {
      const photo = streamPlaylist[((index % streamPlaylist.length) + streamPlaylist.length) % streamPlaylist.length];
      if (slot.photoId !== photo.id) {
        slot.image.src = `/api/photos/${photo.id}/display`;
        slot.photoId = photo.id;
      }
      renderStreamCaption(slot, streamPhotoById.get(photo.id) || photo);
      slot.place = streamPlacement(index);
      slot.node.style.setProperty('--tilt', `${slot.place.tilt}deg`);
      slot.index = index;
    }
    // Fade in from the far end, fade out again while passing the camera, so
    // nothing pops into or out of existence.
    const arriving = Math.min(1, Math.max(0, (furthest - depth) / (STREAM_SPACING * 1.6)));
    const leaving = depth >= 0 ? 1 : Math.max(0, 1 + depth / (STREAM_SPACING * STREAM_FADE_OUT));
    const scale = STREAM_PERSPECTIVE / (STREAM_PERSPECTIVE + Math.max(0, depth));

    // Perspective alone would do the opposite of what is wanted here: it pulls
    // distant photos towards the vanishing point and throws near ones outwards.
    // So the scatter is aimed at the screen instead — widest at the back,
    // collapsing onto the centre as a photo arrives — and then divided by the
    // scale, which is exactly what the projection multiplies it by again.
    // Smoothstep, not a power curve: an exponent below one has infinite slope
    // at the near end, which is what made a photo appear to snap to the centre
    // at the last moment. This eases in and out, and it never collapses all the
    // way, so the last stretch of the journey stays gentle.
    const towards = Math.min(1, Math.max(0, depth) / furthest);
    const eased = towards * towards * (3 - 2 * towards);
    const reach = STREAM_CONVERGE_MIN + (1 - STREAM_CONVERGE_MIN) * eased;
    const shiftX = (slot.place.x * STREAM_SPREAD_X * streamStageSize.width * reach) / (100 * scale);
    const shiftY = (slot.place.y * STREAM_SPREAD_Y * streamStageSize.height * reach) / (100 * scale);
    slot.node.style.transform =
      `translate3d(calc(-50% + ${shiftX.toFixed(1)}px), calc(-50% + ${shiftY.toFixed(1)}px), ${-depth}px)`
      + ' rotate(var(--tilt, 0deg))';
    slot.node.style.opacity = String(Math.min(arriving, leaving));
    slot.node.classList.toggle('is-front', position === 1);

    // Softening whatever is further back leaves the eye on the nearest photo.
    // The blur is drawn before perspective shrinks the photo, so it is divided
    // by the scale to keep the amount even once it reaches the screen.
    const onScreen = Math.min(STREAM_BLUR_MAX, (Math.max(0, depth) / STREAM_SPACING) * STREAM_BLUR_RATE);
    // Quantised, so the filter string rarely changes and the browser can keep
    // its rasterised copy instead of re-blurring every frame.
    // On the whole card, not just the photo: the frame and its caption have to
    // recede with it, otherwise a distant photo sits in a razor-sharp frame.
    const blur = streamQuality ? 0 : Math.round((onScreen / scale) * 4) / 4;
    if (slot.blur !== blur) {
      slot.node.style.filter = blur ? `blur(${blur}px)` : '';
      slot.blur = blur;
    }
  }
}

function streamAdapt(now) {
  if (!streamWindowStart) {
    streamWindowStart = now;
    return;
  }
  streamFrames += 1;
  const elapsed = now - streamWindowStart;
  if (elapsed < 2500) return;
  const fps = (streamFrames * 1000) / elapsed;
  streamWindowStart = now;
  streamFrames = 0;
  if (fps >= 40 || streamQuality >= 2) return;
  // Softening goes first, because it costs the most and is the least missed;
  // only if that is not enough does the corridor get shorter.
  streamQuality += 1;
  $('stream-stage').classList.toggle('is-lean', streamQuality >= 1);
  $('stream-stage').classList.toggle('is-minimal', streamQuality >= 2);
  for (const slot of streamSlots) slot.blur = null;
}

function streamFrame(now) {
  streamAdapt(now);
  paintStream();
  streamFrameHandle = requestAnimationFrame(streamFrame);
}

function startStreamMotion() {
  stopStreamMotion();
  if (!authenticated || !streamPage || document.hidden || !streamPlaylist.length) return;
  if (streamReducedMotion.matches) {
    // One still picture at a time, refreshed as the camera passes each photo.
    paintStream();
    streamTimer = setTimeout(startStreamMotion, STREAM_SPACING / STREAM_SPEED * 1000);
    return;
  }
  streamFrameHandle = requestAnimationFrame(streamFrame);
}

function stopStreamMotion() {
  if (streamFrameHandle !== null) cancelAnimationFrame(streamFrameHandle);
  streamFrameHandle = null;
  clearTimeout(streamTimer);
  streamTimer = null;
}

function stopStream() {
  stopStreamMotion();
  clearTimeout(streamPollTimer);
  streamPollTimer = null;
}

async function loadStream() {
  if (!authenticated || !streamPage) return;
  clearTimeout(streamPollTimer);
  try {
    const result = await api('/api/photos/stream');
    const list = result.photos || [];
    const serverNow = Date.parse(result.now);
    // Correcting against the server clock is what keeps separate screens on the
    // same picture; without it they drift apart by whatever their clocks differ.
    if (Number.isFinite(serverNow)) streamClockOffset = serverNow - Date.now();
    $('stream-error').textContent = '';
    streamPhotoById.clear();
    for (const photo of list) streamPhotoById.set(photo.id, photo);
    const signature = list.map((photo) => photo.id).join(',');
    // Reactions change far more often than the photo list. Rebuilding the
    // rotation only when the list itself changes keeps the flow steady, while
    // captions still pick up new reaction counts on the next poll.
    if (signature !== streamSignature) {
      streamSignature = signature;
      streamPlaylist = streamPlaylistFrom(list);
      if (!streamSlots.length) buildStreamSlots();
    }
    for (const slot of streamSlots) {
      if (slot.photoId) renderStreamCaption(slot, streamPhotoById.get(slot.photoId));
    }
    $('stream-stage').hidden = !list.length;
    $('stream-empty').hidden = Boolean(list.length);
    // Measure only once the stage is on screen, otherwise it reports nothing.
    if (list.length) measureStreamStage();
    $('stream-status').textContent = list.length
      ? `${list.length} ${list.length === 1 ? 'Foto' : 'Fotos'} im Stream · Neue Fotos werden bevorzugt gezeigt.`
      : 'Noch keine Fotos in der Galerie.';
    startStreamMotion();
  } catch (error) {
    $('stream-error').textContent = error.message;
    $('stream-status').textContent = 'Der Stream konnte nicht aktualisiert werden.';
  } finally {
    if (authenticated && streamPage) streamPollTimer = setTimeout(loadStream, 10000);
  }
}

$('stream-fullscreen').addEventListener('click', async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await $('stream-stage').requestFullscreen();
  } catch { $('stream-error').textContent = 'Dieser Browser hat den Vollbildmodus abgelehnt.'; }
});

$('camera-torch').addEventListener('click', async () => {
  const track = cameraStream?.getVideoTracks()[0];
  if (!track) return;
  const wanted = !cameraTorchOn;
  try {
    await track.applyConstraints({ advanced: [{ torch: wanted }] });
    cameraTorchOn = wanted;
  } catch {
    cameraTorchOn = false;
    $('camera-status').textContent = 'Das Licht lässt sich auf diesem Gerät nicht schalten.';
  }
  $('camera-torch').setAttribute('aria-pressed', String(cameraTorchOn));
  $('camera-torch').setAttribute('aria-label', cameraTorchOn ? 'Blitz ausschalten' : 'Blitz einschalten');
});

// In fullscreen there is no browser chrome and no Escape key on a phone, so a
// tap brings back a way out for a few seconds.
let streamControlsTimer = null;

function revealStreamControls() {
  if (!document.fullscreenElement) return;
  clearTimeout(streamControlsTimer);
  $('stream-stage').classList.add('controls-visible');
  streamControlsTimer = setTimeout(
    () => $('stream-stage').classList.remove('controls-visible'), 3500);
}

$('stream-stage').addEventListener('pointerdown', revealStreamControls);
$('stream-exit').addEventListener('click', (event) => {
  event.stopPropagation();
  if (document.fullscreenElement) document.exitFullscreen();
});

document.addEventListener('fullscreenchange', () => {
  $('stream-fullscreen').textContent = document.fullscreenElement ? 'Vollbild beenden' : 'Vollbild';
  // Fullscreen covers the backdrop completely, so stop paying for its filter
  // while the stream needs every frame it can get.
  $('page-backdrop').hidden = Boolean(document.fullscreenElement);
  if (document.fullscreenElement) revealStreamControls();
  else $('stream-stage').classList.remove('controls-visible');
  if (streamPage) measureStreamStage();
});
window.addEventListener('resize', () => {
  if (streamPage) measureStreamStage();
});

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
  if (!document.hidden && galleryPage && authenticated) loadGallery(false);
  // Position comes from the clock, so a tab that was away simply rejoins the
  // stream exactly where every other screen already is.
  if (streamPage && authenticated) {
    if (document.hidden) stopStreamMotion();
    else startStreamMotion();
  }
});

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
