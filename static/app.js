const $ = (id) => document.getElementById(id);
const galleryPage = location.pathname === '/gallery';
const MAX_BYTES = 25 * 1024 * 1024;
let authenticated = false;
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

$(galleryPage ? 'nav-gallery' : 'nav-upload').setAttribute('aria-current', 'page');
document.title = galleryPage ? 'Unsere Galerie · 180. Geburtstag' : 'Foto teilen · 180. Geburtstag';

function showLogin(message = '') {
  stopCamera(false);
  authenticated = false;
  clearTimeout(timer);
  $('login').hidden = false;
  $('upload').hidden = $('gallery').hidden = $('logout').hidden = $('boot').hidden = true;
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

async function enter() {
  authenticated = true;
  $('boot').hidden = $('login').hidden = true;
  $('logout').hidden = false;
  $('party-code').value = '';
  $(galleryPage ? 'gallery' : 'upload').hidden = false;
  if (galleryPage) await loadGallery(false);
}

$('login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('login-error').textContent = '';
  $('login-submit').disabled = true;
  $('login-submit').textContent = 'Einen Moment …';
  try {
    await api('/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: $('party-code').value }) });
    await enter();
    $(galleryPage ? 'refresh' : 'camera').focus();
  } catch (error) { $('login-error').textContent = error.message; }
  finally { $('login-submit').disabled = false; $('login-submit').textContent = 'Dabei sein →'; }
});

$('logout').addEventListener('click', async () => {
  if (uploading) return;
  try { await api('/api/session', { method: 'DELETE' }); location.reload(); }
  catch (error) { window.alert(error.message); }
});

$('camera').addEventListener('click', () => openCamera(cameraFacing));
$('library').addEventListener('click', () => $('library-input').click());
$('camera-fallback').addEventListener('click', () => $('camera-input').click());
$('close-camera').addEventListener('click', () => { stopCamera(true); $('camera').focus(); });
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
      selectPhoto(file);
    }
  });
}

function stopCamera(showPicker) {
  cameraGeneration++;
  cameraStream?.getTracks().forEach((track) => track.stop());
  cameraStream = null;
  $('camera-video').srcObject = null;
  $('camera-view').hidden = true;
  $('shutter').disabled = true;
  $('switch-camera').hidden = true;
  $('camera-fallback').hidden = true;
  if (showPicker) $('pick-actions').hidden = false;
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
  $('pick-actions').hidden = true;
  $('camera-view').hidden = false;
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
  await selectPhoto(file);
}

function clearSelection() {
  previewGeneration++;
  selected = null;
  uploadId = null;
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = null;
  $('preview').removeAttribute('src');
  $('preview').hidden = $('review').hidden = $('success').hidden = $('progress-wrap').hidden = true;
  $('pick-actions').hidden = false;
  $('upload-error').textContent = '';
  $('send').disabled = true;
  $('send').textContent = 'Foto hochladen ↑';
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

async function selectPhoto(file) {
  clearSelection();
  const generation = previewGeneration;
  if (file.size > MAX_BYTES) { $('upload-error').textContent = 'Dieses Foto ist größer als 25 MiB. Bitte ein anderes wählen.'; return; }
  if (!file.size) { $('upload-error').textContent = 'Die Datei ist leer. Bitte ein anderes Foto wählen.'; return; }
  selected = file;
  uploadId = crypto.randomUUID();
  $('pick-actions').hidden = true;
  $('review').hidden = false;
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

$('discard').addEventListener('click', () => { clearSelection(); $('camera').focus(); });
$('another').addEventListener('click', () => { clearSelection(); $('camera').focus(); });

function sendPhoto(file, id) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/photos');
    xhr.timeout = 300000;
    const data = new FormData();
    data.append('upload_id', id);
    data.append('photo', file);
    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable) return;
      const value = Math.round(event.loaded / event.total * 100);
      $('progress').value = value;
      $('progress-text').textContent = value < 100 ? `Foto wird übertragen: ${value} %` : 'Foto ist übertragen. Es wird gespeichert und für die Galerie vorbereitet …';
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) { resolve(); return; }
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
    await sendPhoto(selected, uploadId);
    clearSelection();
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
  button.setAttribute('aria-label', `Foto vom ${date} öffnen`);
  const image = document.createElement('img');
  image.src = `/api/photos/${photo.id}/thumb`;
  image.alt = `Partyfoto vom ${date}`;
  image.loading = 'lazy';
  image.decoding = 'async';
  button.append(image);
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
    $('download').href = `/api/photos/${photo.id}/original`;
    window.scrollTo(0, 0);
    $('back-to-grid').focus();
  });
  return button;
}

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
  if (!document.hidden && galleryPage && authenticated) loadGallery(false);
});

try { await api('/api/session'); await enter(); }
catch (error) { showLogin(error.message === 'Bitte den Party-Code eingeben.' ? '' : error.message); }
