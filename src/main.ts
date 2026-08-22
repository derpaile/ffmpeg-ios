import './style.css';
import type { MediaInfo, PresetId, WorkerResponse } from './types';

const MAX_FILE_SIZE = 200 * 1024 * 1024;
const app = document.querySelector<HTMLDivElement>('#app')!;

let worker = createWorker();
let selectedFile: File | null = null;
let info: MediaInfo | null = null;
let preset: PresetId = 'balanced';
let outputFormat: 'mp4' | 'm4a' | 'mp3' | 'wav' = 'mp4';
let startedAt = 0;
let result: { file: File; url: string } | null = null;

function createWorker() {
  const instance = new Worker(new URL('./media.worker.ts', import.meta.url), { type: 'module' });
  instance.onmessage = ({ data }: MessageEvent<WorkerResponse>) => handleWorkerMessage(data);
  return instance;
}

const icon = (name: 'photos' | 'folder' | 'check' | 'shield' | 'spark' | 'share' | 'close') => {
  const paths = {
    photos: '<rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="8.5" cy="9" r="1.5"/><path d="m4 17 5-5 4 4 2-2 5 4"/>',
    folder: '<path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    shield: '<path d="M12 3 4.5 6v5.5c0 4.8 3.2 7.8 7.5 9.5 4.3-1.7 7.5-4.7 7.5-9.5V6L12 3Z"/><path d="m8.5 12 2.2 2.2 4.8-5"/>',
    spark: '<path d="m12 3 1.2 4.3L17 9l-3.8 1.7L12 15l-1.2-4.3L7 9l3.8-1.7L12 3Z"/><path d="m5 14 .7 2.3L8 17l-2.3.7L5 20l-.7-2.3L2 17l2.3-.7L5 14Z"/>',
    share: '<path d="M12 16V3m0 0L7 8m5-5 5 5"/><path d="M5 12v7h14v-7"/>',
    close: '<path d="m6 6 12 12M18 6 6 18"/>'
  };
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${paths[name]}</svg>`;
};

function formatBytes(bytes: number) {
  if (!bytes) return '0 MB';
  return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${(bytes / 1024 ** 2).toFixed(bytes < 10 * 1024 ** 2 ? 1 : 0)} MB`;
}

function formatTime(seconds: number) {
  if (!Number.isFinite(seconds)) return '–';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60).toString().padStart(2, '0');
  return `${mins}:${secs}`;
}

function estimatedSize() {
  if (!info) return 0;
  if (info.audioOnly) {
    const kbps = outputFormat === 'wav' ? 1411 : preset === 'small' ? 96 : preset === 'quality' ? 160 : 128;
    return info.duration * kbps * 125;
  }
  const ratio = preset === 'small' ? .24 : preset === 'balanced' ? .44 : .7;
  return Math.min(info.size * ratio, info.size * .95);
}

function renderHome() {
  app.innerHTML = `
    <main class="shell home">
      <header><a class="brand" href="#" aria-label="Startseite"><span class="mark">K</span><span>Kompakt</span></a><span class="local-pill">${icon('shield')} Bleibt auf deinem Gerät</span></header>
      <section class="hero">
        <div class="eyebrow">PRIVATE MEDIENKOMPRIMIERUNG</div>
        <h1>Große Medien.<br><em>Kleiner gemacht.</em></h1>
        <p>Komprimiere Videos und Audio direkt auf deinem iPhone – ohne Upload, ohne Konto.</p>
        <div class="actions">
          <button class="primary" id="photos">${icon('photos')}<span><b>Video aus Fotos</b><small>Aus deiner Mediathek wählen</small></span><i>›</i></button>
          <button class="secondary" id="files">${icon('folder')}<span><b>Audio oder Video aus Dateien</b><small>MOV, MP4, M4A, MP3, WAV</small></span><i>›</i></button>
        </div>
        <input hidden id="photoInput" type="file" accept="video/*,.mov,.mp4,.m4v" />
        <input hidden id="fileInput" type="file" accept="video/*,audio/*,.mov,.mp4,.m4v,.m4a,.mp3,.aac,.wav" />
        <p class="limit">Bis ${formatBytes(MAX_FILE_SIZE)} · lokal verarbeitet</p>
      </section>
      <section class="trust">
        <article>${icon('shield')}<div><b>Privat per Prinzip</b><span>Deine Dateien verlassen dieses Gerät nicht.</span></div></article>
        <article>${icon('spark')}<div><b>Funktioniert offline</b><span>Nach dem ersten Laden auch ohne Internet.</span></div></article>
        <article>${icon('check')}<div><b>Keine Installation nötig</b><span>Oder zum Home-Bildschirm hinzufügen.</span></div></article>
      </section>
      <footer>Deine Medien. Dein Gerät. <span>Keine Cloud.</span></footer>
    </main>`;
  document.querySelector('#photos')?.addEventListener('click', () => document.querySelector<HTMLInputElement>('#photoInput')?.click());
  document.querySelector('#files')?.addEventListener('click', () => document.querySelector<HTMLInputElement>('#fileInput')?.click());
  document.querySelectorAll<HTMLInputElement>('input[type=file]').forEach(input => input.addEventListener('change', () => input.files?.[0] && selectFile(input.files[0])));
}

async function selectFile(file: File) {
  if (file.size > MAX_FILE_SIZE) {
    showToast(`Diese Datei ist ${formatBytes(file.size)} groß. Das lokale Limit liegt bei ${formatBytes(MAX_FILE_SIZE)}.`);
    return;
  }
  selectedFile = file;
  info = null;
  renderAnalysis('Kompressor wird vorbereitet');
  worker.postMessage({ type: 'analyze', file });
}

function renderAnalysis(phase: string) {
  app.innerHTML = `<main class="shell process-shell"><header><a class="brand" href="#"><span class="mark">K</span><span>Kompakt</span></a><button class="icon-button" id="reset" aria-label="Schließen">${icon('close')}</button></header>
    <section class="center-state"><div class="loader"><span></span></div><div class="eyebrow">AUTOMATISCHE ANALYSE</div><h2>${phase}</h2><p>${selectedFile?.name || ''}</p><small>FFmpeg wird nur bei Bedarf geladen.</small></section></main>`;
  document.querySelector('#reset')?.addEventListener('click', reset);
}

function renderPreset() {
  if (!info) return;
  if (info.audioOnly) outputFormat = outputFormat === 'mp4' ? 'm4a' : outputFormat;
  app.innerHTML = `<main class="shell process-shell"><header><a class="brand" href="#"><span class="mark">K</span><span>Kompakt</span></a><button class="text-button" id="reset">Neu wählen</button></header>
    <section class="work">
      <div class="step"><span>2 von 5</span><i><b style="width:40%"></b></i></div>
      <div class="file-card"><div class="file-icon">${info.audioOnly ? '♪' : '▶'}</div><div><b>${info.name}</b><span>${formatTime(info.duration)} · ${info.audioOnly ? info.codec : `${info.width} × ${info.height}`} · ${formatBytes(info.size)}</span></div>${icon('check')}</div>
      ${info.hdr ? '<div class="warning"><b>HDR-Video erkannt</b><span>Das MVP konvertiert HDR noch nicht zuverlässig. Für korrekte Farben bitte eine SDR-Version verwenden.</span></div>' : ''}
      <div class="section-title"><div class="eyebrow">KOMPRESSION</div><h2>Wie klein soll es werden?</h2><p>Du kannst die Auswahl vor dem Start noch ändern.</p></div>
      <div class="presets">
        ${presetCard('small', 'Klein', info.audioOnly ? '96 kbit/s' : 'Bis 720p · CRF 28', 'Für Nachrichten und schnellen Versand')}
        ${presetCard('balanced', 'Ausgewogen', info.audioOnly ? '128 kbit/s' : 'Bis 1080p · CRF 24', 'Gute Qualität bei deutlich weniger Größe', true)}
        ${presetCard('quality', 'Hohe Qualität', info.audioOnly ? '160 kbit/s' : 'Originalauflösung · CRF 20', 'Mehr Details, größere Datei')}
      </div>
      ${info.audioOnly ? `<div class="format-row"><label>Ausgabeformat</label><select id="format"><option value="m4a" ${outputFormat === 'm4a' ? 'selected' : ''}>M4A / AAC</option><option value="mp3" ${outputFormat === 'mp3' ? 'selected' : ''}>MP3</option><option value="wav" ${outputFormat === 'wav' ? 'selected' : ''}>WAV</option></select></div>` : ''}
      <div class="estimate"><span>Geschätzte Zielgröße</span><b>≈ ${formatBytes(estimatedSize())}</b><small>Die tatsächliche Größe hängt vom Inhalt ab.</small></div>
      <button class="cta" id="start" ${info.hdr ? 'disabled' : ''}>Verarbeitung starten <i>→</i></button>
    </section></main>`;
  document.querySelector('#reset')?.addEventListener('click', reset);
  document.querySelectorAll<HTMLButtonElement>('.preset').forEach(button => button.addEventListener('click', () => { preset = button.dataset.preset as PresetId; renderPreset(); }));
  document.querySelector<HTMLSelectElement>('#format')?.addEventListener('change', event => { outputFormat = (event.target as HTMLSelectElement).value as typeof outputFormat; renderPreset(); });
  document.querySelector('#start')?.addEventListener('click', startTranscode);
}

function presetCard(id: PresetId, title: string, detail: string, description: string, recommended = false) {
  return `<button class="preset ${preset === id ? 'selected' : ''}" data-preset="${id}"><span class="radio"></span><div><b>${title}${recommended ? '<em>EMPFOHLEN</em>' : ''}</b><span>${detail}</span><small>${description}</small></div></button>`;
}

function startTranscode() {
  startedAt = Date.now();
  sessionStorage.setItem('kompakt-active', JSON.stringify({ fileName: info?.name, startedAt }));
  renderProgress('Verarbeitung wird gestartet', 0, 0);
  worker.postMessage({ type: 'transcode', preset, outputFormat });
}

function renderProgress(phase: string, progress: number, elapsed: number) {
  const percent = Math.round(progress * 100);
  app.innerHTML = `<main class="shell process-shell"><header><a class="brand"><span class="mark">K</span><span>Kompakt</span></a></header>
    <section class="progress-state"><div class="eyebrow">4 VON 5 · VERARBEITUNG</div><h2>${phase}</h2><p>Bitte lass Kompakt im Vordergrund geöffnet.</p>
      <div class="progress-ring" style="--progress:${percent * 3.6}deg"><div><b>${percent}<small>%</small></b><span>komprimiert</span></div></div>
      <div class="progress-line"><i style="width:${percent}%"></i></div><div class="progress-meta"><span>Verstrichen <b>${formatTime(elapsed)}</b></span><span>${info?.name || ''}</span></div>
      <div class="background-note">iOS kann die Verarbeitung im Hintergrund pausieren oder beenden.</div>
      <button class="cancel" id="cancel">Abbrechen</button>
    </section></main>`;
  document.querySelector('#cancel')?.addEventListener('click', cancel);
}

async function storeInOpfs(file: File) {
  try {
    const root = await navigator.storage.getDirectory();
    const handle = await root.getFileHandle(file.name, { create: true });
    const writable = await handle.createWritable();
    await writable.write(file);
    await writable.close();
  } catch { /* Teilen und Download funktionieren auch ohne OPFS. */ }
}

async function handleDone(data: Uint8Array, fileName: string, mime: string) {
  sessionStorage.removeItem('kompakt-active');
  const file = new File([new Uint8Array(data).buffer], fileName, { type: mime });
  await storeInOpfs(file);
  result = { file, url: URL.createObjectURL(file) };
  renderDone();
}

function renderDone() {
  if (!result) return;
  const saved = selectedFile ? Math.max(0, 1 - result.file.size / selectedFile.size) : 0;
  app.innerHTML = `<main class="shell process-shell"><header><a class="brand"><span class="mark">K</span><span>Kompakt</span></a></header>
    <section class="done-state"><div class="success">${icon('check')}</div><div class="eyebrow">FERTIG</div><h2>Dein Medium ist kompakt.</h2><p>${Math.round(saved * 100)} % kleiner · ${formatBytes(result.file.size)}</p>
      <div class="size-compare"><div><span>Vorher</span><b>${formatBytes(selectedFile?.size || 0)}</b></div><i>→</i><div><span>Nachher</span><b>${formatBytes(result.file.size)}</b></div></div>
      <button class="cta" id="share">${icon('share')} In Fotos / Dateien sichern</button>
      <a class="download" href="${result.url}" download="${result.file.name}">Stattdessen herunterladen</a>
      <button class="text-button another" id="again">Weiteres Medium verkleinern</button>
      <small class="save-help">Im Teilen-Menü „Video sichern“ oder „In Dateien sichern“ wählen.</small>
    </section></main>`;
  document.querySelector('#share')?.addEventListener('click', shareResult);
  document.querySelector('#again')?.addEventListener('click', reset);
}

async function shareResult() {
  if (!result) return;
  try {
    if (navigator.canShare?.({ files: [result.file] })) await navigator.share({ files: [result.file], title: result.file.name });
    else (document.querySelector<HTMLAnchorElement>('.download'))?.click();
  } catch (error) {
    if ((error as DOMException).name !== 'AbortError') showToast('Teilen ist hier nicht verfügbar. Nutze bitte „Herunterladen“.');
  }
}

function handleWorkerMessage(message: WorkerResponse) {
  if (message.type === 'phase') {
    if (!info) renderAnalysis(message.phase);
    else if (startedAt) renderProgress(message.phase, 0, (Date.now() - startedAt) / 1000);
  }
  if (message.type === 'analysis') { info = message.info; renderPreset(); }
  if (message.type === 'progress') renderProgress(info?.audioOnly ? 'Audio wird komprimiert' : 'Video wird komprimiert', message.progress, (Date.now() - startedAt) / 1000);
  if (message.type === 'done') handleDone(message.data, message.fileName, message.mime);
  if (message.type === 'error') { sessionStorage.removeItem('kompakt-active'); showToast(message.message); info ? renderPreset() : renderHome(); }
}

function cancel() {
  worker.terminate();
  worker = createWorker();
  sessionStorage.removeItem('kompakt-active');
  info = null;
  selectedFile = null;
  renderHome();
}

function reset(event?: Event) {
  event?.preventDefault();
  if (result) URL.revokeObjectURL(result.url);
  result = null; info = null; selectedFile = null; startedAt = 0;
  renderHome();
}

function showToast(message: string) {
  document.querySelector('.toast')?.remove();
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  document.body.append(toast);
  window.setTimeout(() => toast.remove(), 5000);
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden && startedAt && !result) sessionStorage.setItem('kompakt-active', JSON.stringify({ fileName: info?.name, startedAt }));
});

if ('serviceWorker' in navigator) {
  if (import.meta.env.PROD) window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js'));
  else navigator.serviceWorker.getRegistrations().then(registrations => registrations.forEach(registration => registration.unregister()));
}
renderHome();
