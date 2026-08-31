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
let nextCursor = null;
let galleryLoaded = false;
const photos = new Map();
let detailButton = null;
let scrollPosition = 0;
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
  $('profile-setup').hidden = $('upload').hidden = $('gallery').hidden = $('play').hidden = $('logout').hidden = $('boot').hidden = true;
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
  canvas.getContext('2d').drawImage(video, 0, 0, width, height);
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

function photoButton(photo) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'photo-tile';
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
  button.append(image);
  if (author?.name) {
    const credit = document.createElement('span');
    credit.className = 'photo-author-label';
    credit.textContent = author.name;
    button.append(credit);
  }
  if (task?.text) {
    const label = document.createElement('span');
    label.className = 'photo-task-label';
    label.textContent = task.text;
    button.append(label);
  }
  button.addEventListener('click', () => {
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
  window.scrollTo(0, scrollPosition);
  detailButton?.focus({ preventScroll: true });
});

function scheduleRefresh() {
  clearTimeout(timer);
  if (authenticated && galleryPage && !document.hidden) timer = setTimeout(() => loadGallery(false), 15000);
}

async function loadGallery(more) {
  if (galleryBusy || !authenticated) return;
  galleryBusy = true;
  $('refresh').disabled = $('load-more').disabled = true;
  $('gallery-error').textContent = '';
  try {
    const query = more && nextCursor ? `?cursor=${encodeURIComponent(nextCursor)}` : '';
    let result = await api('/api/photos' + query);
    let batch = [...result.photos];
    if (more || !galleryLoaded) nextCursor = result.next_cursor;
    // Catch up even if over 30 photos arrive between polls, without resetting older pages.
    if (!more && galleryLoaded && photos.size) {
      while (result.next_cursor && !result.photos.some((photo) => photos.has(photo.id))) {
        result = await api('/api/photos?cursor=' + encodeURIComponent(result.next_cursor));
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
    $('load-more').hidden = !nextCursor;
    $('gallery-status').textContent = photos.size ? `${photos.size} ${photos.size === 1 ? 'Foto' : 'Fotos'} geladen${added && !more ? ' · Gerade aktualisiert' : ''}. Neue Fotos erscheinen automatisch.` : 'Neue Fotos erscheinen hier automatisch.';
  } catch (error) { $('gallery-error').textContent = error.message; $('gallery-status').textContent = 'Die Galerie konnte nicht aktualisiert werden.'; }
  finally { galleryBusy = false; $('refresh').disabled = $('load-more').disabled = false; scheduleRefresh(); }
}

$('refresh').addEventListener('click', () => loadGallery(false));
$('load-more').addEventListener('click', () => loadGallery(true));
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
