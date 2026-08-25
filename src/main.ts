import './style.css';
import {
  dimensionsForLongEdge,
  estimatedAudioSize,
  estimatedManualVideoSize,
  estimatedVideoSize,
  targetDimensions,
  targetVideoBitrate
} from './presets';
import type {
  CompressionMode,
  ManualVideoSettings,
  MediaInfo,
  OutputFormatId,
  PresetId,
  ProcessLogEntry,
  WorkerResponse
} from './types';

const app = document.querySelector<HTMLDivElement>('#app')!;

let worker = createWorker();
let selectedFile: File | null = null;
let info: MediaInfo | null = null;
let mode: CompressionMode = 'balanced';
let outputFormat: OutputFormatId = 'mp4';
let startedAt = 0;
let result: { file: File; url: string; hardwarePreferred: boolean } | null = null;
let manual: ManualVideoSettings | null = null;
let currentPhase = 'Verarbeitung wird gestartet';
let progressValue = 0;
let processedTime = 0;
let progressTimer = 0;
let progressLogs: ProcessLogEntry[] = [];
let speedSamples: { wall: number; media: number }[] = [];
let manualOpenSection = 'image';

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
  if (!bytes) return '0 KB';
  if (bytes < 1024 ** 2) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${(bytes / 1024 ** 2).toFixed(bytes < 10 * 1024 ** 2 ? 1 : 0)} MB`;
}

function formatTime(seconds: number) {
  if (!Number.isFinite(seconds)) return '–';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60).toString().padStart(2, '0');
  return `${mins}:${secs}`;
}

function formatDetailedTime(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) return '–';
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds % 3600 / 60);
  const secs = Math.floor(seconds % 60);
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}` : `${minutes}:${String(secs).padStart(2, '0')}`;
}

function defaultManualSettings(media: MediaInfo): ManualVideoSettings {
  const dimensions = targetDimensions(media, 'balanced');
  return {
    ...dimensions,
    fit: 'contain',
    rotation: 0,
    cropEnabled: false,
    cropLeft: 0,
    cropTop: 0,
    cropWidth: media.width,
    cropHeight: media.height,
    codec: 'avc',
    rateControl: 'bitrate',
    bitrate: targetVideoBitrate(media, 'balanced'),
    bitrateMode: 'variable',
    quantizer: 23,
    frameRate: 0,
    keyFrameInterval: 5,
    hardwareAcceleration: 'prefer-hardware',
    scaler: 'balanced',
    audioMode: 'copy',
    audioBitrate: 128_000,
    audioChannels: 0,
    audioSampleRate: 0,
    trimStart: 0,
    trimEnd: 0,
    preserveMetadata: true
  };
}

function estimatedSize() {
  if (!info) return 0;
  const preset = mode === 'manual' ? 'balanced' : mode;
  if (info.audioOnly) return estimatedAudioSize(info, preset, outputFormat === 'mp4' ? 'm4a' : outputFormat);
  if (mode === 'manual' && manual) return estimatedManualVideoSize(info, manual);
  return estimatedVideoSize(info, preset);
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
          <button class="secondary" id="files">${icon('folder')}<span><b>Audio oder Video aus Dateien</b><small>MOV, MP4, M4A, MP3, WAV, FLAC</small></span><i>›</i></button>
        </div>
        <input hidden id="photoInput" type="file" accept="video/*,.mov,.mp4,.m4v" />
        <input hidden id="fileInput" type="file" accept="video/*,audio/*,.mov,.mp4,.m4v,.m4a,.mp3,.aac,.wav,.flac" />
        <p class="limit">Keine feste Dateigrenze · abhängig vom freien Gerätespeicher</p>
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
  selectedFile = file;
  info = null;
  renderAnalysis('Kompressor wird vorbereitet');
  worker.postMessage({ type: 'analyze', file });
}

function renderAnalysis(phase: string) {
  app.innerHTML = `<main class="shell process-shell"><header><a class="brand" href="#"><span class="mark">K</span><span>Kompakt</span></a><button class="icon-button" id="reset" aria-label="Schließen">${icon('close')}</button></header>
    <section class="center-state"><div class="loader"><span></span></div><div class="eyebrow">AUTOMATISCHE ANALYSE</div><h2>${phase}</h2><p>${selectedFile?.name || ''}</p><small>Hardwarebeschleunigung wird automatisch bevorzugt.</small></section></main>`;
  document.querySelector('#reset')?.addEventListener('click', reset);
}

function option(value: string | number, current: string | number, label: string) {
  return `<option value="${value}" ${value === current ? 'selected' : ''}>${label}</option>`;
}

function manualPanel() {
  if (!manual || !info) return '';
  const field = (label: string, key: keyof ManualVideoSettings, value: number, min: number, max: number, step = 1, scale = 1, suffix = '') => `
    <label class="manual-field"><span>${label}</span><div><input type="number" inputmode="decimal" min="${min}" max="${max}" step="${step}" value="${value / scale}" data-setting="${key}" data-scale="${scale}">${suffix ? `<small>${suffix}</small>` : ''}</div></label>`;
  return `<div class="manual-panel">
    <details data-group="image" ${manualOpenSection === 'image' ? 'open' : ''}><summary>Bild & Skalierung <span>${manual.width} × ${manual.height}</span></summary><div class="manual-body">
      <div class="quick-res"><button data-edge="original">Original</button><button data-edge="2160">4K</button><button data-edge="1440">1440p</button><button data-edge="1080">1080p</button><button data-edge="720">720p</button></div>
      <div class="manual-grid">${field('Breite', 'width', manual.width, 2, 8192)}${field('Höhe', 'height', manual.height, 2, 8192)}
        <label class="manual-field"><span>Anpassung</span><select data-setting="fit">${option('contain', manual.fit, 'Einpassen')}${option('cover', manual.fit, 'Ausfüllen / beschneiden')}${option('fill', manual.fit, 'Strecken')}</select></label>
        <label class="manual-field"><span>Drehung</span><select data-setting="rotation">${option(0, manual.rotation, 'Original')}${option(90, manual.rotation, '+90°')}${option(180, manual.rotation, '+180°')}${option(270, manual.rotation, '+270°')}</select></label>
        <label class="manual-field span-2"><span>Skalierungsqualität</span><select data-setting="scaler">${option('fast', manual.scaler, 'Sehr schnell · 1 Pass')}${option('balanced', manual.scaler, 'Ausgewogen · 1 Pass')}${option('quality', manual.scaler, 'Maximal · mehrstufig')}</select></label>
      </div>
      <label class="switch-row"><span><b>Ausschnitt festlegen</b><small>Nach der Drehung, vor der Skalierung</small></span><input type="checkbox" data-setting="cropEnabled" ${manual.cropEnabled ? 'checked' : ''}></label>
      ${manual.cropEnabled ? `<div class="manual-grid crop-grid">${field('Links', 'cropLeft', manual.cropLeft, 0, 8192)}${field('Oben', 'cropTop', manual.cropTop, 0, 8192)}${field('Breite', 'cropWidth', manual.cropWidth, 2, 8192)}${field('Höhe', 'cropHeight', manual.cropHeight, 2, 8192)}</div>` : ''}
    </div></details>
    <details data-group="video" ${manualOpenSection === 'video' ? 'open' : ''}><summary>Video-Encoder <span>${manual.codec.toUpperCase()}</span></summary><div class="manual-body manual-grid">
      <label class="manual-field"><span>Codec</span><select data-setting="codec">${option('avc', manual.codec, 'H.264 / AVC')}${option('hevc', manual.codec, 'H.265 / HEVC')}${option('vp9', manual.codec, 'VP9')}${option('av1', manual.codec, 'AV1')}</select></label>
      <label class="manual-field"><span>Qualitätssteuerung</span><select data-setting="rateControl">${option('bitrate', manual.rateControl, 'Bitrate')}${option('quantizer', manual.rateControl, 'Quantizer + Bitrate-Fallback')}</select></label>
      ${field('Video-Bitrate', 'bitrate', manual.bitrate, .1, 100, .1, 1_000_000, 'Mbit/s')}
      ${manual.rateControl === 'quantizer' ? field('Quantizer', 'quantizer', manual.quantizer, 0, 63) : `<label class="manual-field"><span>Bitratenmodus</span><select data-setting="bitrateMode">${option('variable', manual.bitrateMode, 'Variabel')}${option('constant', manual.bitrateMode, 'Konstant')}</select></label>`}
      ${field('Bildrate', 'frameRate', manual.frameRate, 0, 120, 1, 1, '0 = Original')}${field('Keyframe-Intervall', 'keyFrameInterval', manual.keyFrameInterval, .25, 30, .25, 1, 'Sekunden')}
      <label class="manual-field span-2"><span>Encoder-Wahl</span><select data-setting="hardwareAcceleration">${option('prefer-hardware', manual.hardwareAcceleration, 'Hardware bevorzugen')}${option('no-preference', manual.hardwareAcceleration, 'Automatisch')}${option('prefer-software', manual.hardwareAcceleration, 'Software bevorzugen')}</select></label>
    </div></details>
    <details data-group="audio" ${manualOpenSection === 'audio' ? 'open' : ''}><summary>Audio <span>${manual.audioMode === 'copy' ? 'Übernehmen' : manual.audioMode === 'aac' ? 'AAC' : 'Ohne Audio'}</span></summary><div class="manual-body manual-grid">
      <label class="manual-field span-2"><span>Audiospur</span><select data-setting="audioMode">${option('copy', manual.audioMode, 'Wenn möglich unverändert übernehmen')}${option('aac', manual.audioMode, 'Als AAC neu kodieren')}${option('discard', manual.audioMode, 'Entfernen')}</select></label>
      ${manual.audioMode === 'aac' ? `${field('Audio-Bitrate', 'audioBitrate', manual.audioBitrate, 32, 512, 8, 1000, 'kbit/s')}
        <label class="manual-field"><span>Kanäle</span><select data-setting="audioChannels">${option(0, manual.audioChannels, 'Original')}${option(1, manual.audioChannels, 'Mono')}${option(2, manual.audioChannels, 'Stereo')}</select></label>
        <label class="manual-field span-2"><span>Abtastrate</span><select data-setting="audioSampleRate">${option(0, manual.audioSampleRate, 'Original')}${option(44100, manual.audioSampleRate, '44,1 kHz')}${option(48000, manual.audioSampleRate, '48 kHz')}${option(96000, manual.audioSampleRate, '96 kHz')}</select></label>` : ''}
    </div></details>
    <details data-group="trim" ${manualOpenSection === 'trim' ? 'open' : ''}><summary>Ausschnitt & Metadaten <span>${manual.trimStart || manual.trimEnd ? 'Gekürzt' : 'Komplett'}</span></summary><div class="manual-body">
      <div class="manual-grid">${field('Start', 'trimStart', manual.trimStart, 0, info.duration, .1, 1, 'Sekunden')}${field('Ende', 'trimEnd', manual.trimEnd, 0, info.duration, .1, 1, '0 = Dateiende')}</div>
      <label class="switch-row"><span><b>Metadaten übernehmen</b><small>Titel und weitere beschreibende Daten</small></span><input type="checkbox" data-setting="preserveMetadata" ${manual.preserveMetadata ? 'checked' : ''}></label>
    </div></details>
  </div>`;
}

function renderPreset() {
  if (!info) return;
  if (!manual && !info.audioOnly) manual = defaultManualSettings(info);
  if (info.audioOnly) outputFormat = outputFormat === 'mp4' ? 'm4a' : outputFormat;
  const losslessAudio = info.audioOnly && (outputFormat === 'wav' || outputFormat === 'flac');
  app.innerHTML = `<main class="shell process-shell"><header><a class="brand" href="#"><span class="mark">K</span><span>Kompakt</span></a><button class="text-button" id="reset">Neu wählen</button></header>
    <section class="work">
      <div class="step"><span>2 von 5</span><i><b style="width:40%"></b></i></div>
      <div class="file-card"><div class="file-icon">${info.audioOnly ? '♪' : '▶'}</div><div><b>${info.name}</b><span>${formatTime(info.duration)} · ${info.audioOnly ? info.codec : `${info.width} × ${info.height}`} · ${formatBytes(info.size)}</span></div>${icon('check')}</div>
      ${info.hdr ? '<div class="warning"><b>HDR-Video erkannt</b><span>Beim Skalieren überführt der Browser HDR nach SDR. Je nach Ausgangsmaterial können Farben leicht abweichen.</span></div>' : ''}
      <div class="section-title"><div class="eyebrow">KOMPRESSION</div><h2>Wie klein soll es werden?</h2><p>Drei schnelle Presets oder vollständige manuelle Kontrolle.</p></div>
      ${info.audioOnly ? `<div class="format-row"><label>Ausgabeformat</label><select id="format"><option value="m4a" ${outputFormat === 'm4a' ? 'selected' : ''}>M4A / AAC</option><option value="mp3" ${outputFormat === 'mp3' ? 'selected' : ''}>MP3</option><option value="flac" ${outputFormat === 'flac' ? 'selected' : ''}>FLAC (verlustfrei)</option><option value="wav" ${outputFormat === 'wav' ? 'selected' : ''}>WAV (verlustfrei)</option></select></div>` : ''}
      ${losslessAudio ? `<div class="lossless-note"><b>Verlustfreie Ausgabe</b><span>${outputFormat.toUpperCase()} erhält die Audiodaten ohne verlustbehaftete Kompression; eine Qualitätsstufe ist nicht nötig.</span></div>` : `<div class="presets">
        ${presetCard('small', 'Klein', info.audioOnly ? '96 kbit/s' : 'Bis 720p · schneller Scaler', 'Für Nachrichten und schnellen Versand')}
        ${presetCard('balanced', 'Ausgewogen', info.audioOnly ? '128 kbit/s' : 'Bis 1080p · schneller Scaler', 'Gute Qualität bei deutlich weniger Größe', true)}
        ${presetCard('quality', 'Hohe Qualität', info.audioOnly ? '160 kbit/s' : 'Originalauflösung · direkter Bildpfad', 'Mehr Details, größere Datei')}
        ${info.audioOnly ? '' : presetCard('manual', 'Manuell', 'Codec, Auflösung, Bitrate und mehr', 'Alle wichtigen Parameter selbst festlegen')}
      </div>`}
      ${mode === 'manual' && !info.audioOnly ? manualPanel() : ''}
      <div class="estimate"><span>Geschätzte Zielgröße</span><b id="estimateValue">≈ ${formatBytes(estimatedSize())}</b><small>Die tatsächliche Größe hängt vom Inhalt und gewählten Codec ab.</small></div>
      <button class="cta" id="start">Verarbeitung starten <i>→</i></button>
    </section></main>`;
  document.querySelector('#reset')?.addEventListener('click', reset);
  document.querySelectorAll<HTMLButtonElement>('.preset').forEach(button => button.addEventListener('click', () => { mode = button.dataset.mode as CompressionMode; renderPreset(); }));
  document.querySelector<HTMLSelectElement>('#format')?.addEventListener('change', event => { outputFormat = (event.target as HTMLSelectElement).value as typeof outputFormat; renderPreset(); });
  document.querySelectorAll<HTMLElement>('[data-setting]').forEach(control => {
    control.addEventListener('change', () => updateManualSetting(control, true));
    if (control instanceof HTMLInputElement && control.type === 'number') {
      control.addEventListener('input', () => updateManualSetting(control, false));
    }
  });
  document.querySelectorAll<HTMLButtonElement>('[data-edge]').forEach(button => button.addEventListener('click', () => applyResolution(button.dataset.edge || 'original')));
  document.querySelector('#start')?.addEventListener('click', startTranscode);
}

function updateManualSetting(control: HTMLElement, rerender: boolean) {
  if (!manual) return;
  manualOpenSection = control.closest<HTMLDetailsElement>('details')?.dataset.group || manualOpenSection;
  const key = control.dataset.setting as keyof ManualVideoSettings;
  let value: string | number | boolean;
  if (control instanceof HTMLInputElement && control.type === 'checkbox') value = control.checked;
  else if (control instanceof HTMLInputElement && control.type === 'number') value = Number(control.value) * Number(control.dataset.scale || 1);
  else value = (control as HTMLSelectElement).value;
  if (['rotation', 'audioChannels', 'audioSampleRate'].includes(key)) value = Number(value);
  (manual as unknown as Record<string, string | number | boolean>)[key] = value;
  if (rerender) renderPreset();
  else {
    const estimate = document.querySelector('#estimateValue');
    if (estimate) estimate.textContent = `≈ ${formatBytes(estimatedSize())}`;
  }
}

function applyResolution(edge: string) {
  if (!manual || !info) return;
  manualOpenSection = 'image';
  const dimensions = edge === 'original' ? { width: info.width, height: info.height } : dimensionsForLongEdge(info, Number(edge));
  manual.width = dimensions.width;
  manual.height = dimensions.height;
  renderPreset();
}

function presetCard(id: CompressionMode, title: string, detail: string, description: string, recommended = false) {
  return `<button class="preset ${mode === id ? 'selected' : ''}" data-mode="${id}"><span class="radio"></span><div><b>${title}${recommended ? '<em>EMPFOHLEN</em>' : ''}</b><span>${detail}</span><small>${description}</small></div></button>`;
}

function startTranscode() {
  const preset: PresetId = mode === 'manual' ? 'balanced' : mode;
  startedAt = Date.now();
  currentPhase = 'Verarbeitung wird gestartet';
  progressValue = 0;
  processedTime = 0;
  progressLogs = [];
  speedSamples = [];
  sessionStorage.setItem('kompakt-active', JSON.stringify({ fileName: info?.name, startedAt }));
  renderProgressShell();
  progressTimer = window.setInterval(updateProgressView, 1000);
  worker.postMessage({ type: 'transcode', preset, outputFormat, ...(mode === 'manual' && manual ? { manual } : {}) });
}

function renderProgressShell() {
  app.innerHTML = `<main class="shell process-shell"><header><a class="brand"><span class="mark">K</span><span>Kompakt</span></a></header>
    <section class="progress-state"><div class="eyebrow">4 VON 5 · VERARBEITUNG</div><h2 id="progressPhase">${currentPhase}</h2><p>Bitte lass Kompakt im Vordergrund geöffnet.</p>
      <div class="progress-ring" id="progressRing"><div><b><span id="progressPercent">0</span><small>%</small></b><span>verarbeitet</span></div></div>
      <div class="progress-line"><i id="progressBar"></i></div><div class="progress-meta"><span>Verstrichen <b id="elapsed">0:00</b></span><span>${info?.name || ''}</span></div>
      <div class="progress-stats"><div><span>Tempo</span><b id="speed">Wird ermittelt</b></div><div><span>Restzeit</span><b id="eta">–</b></div><div><span>Videoposition</span><b id="mediaTime">0:00</b></div><div><span>Zielgröße</span><b>≈ ${formatBytes(estimatedSize())}</b></div></div>
      <div class="process-log"><div class="log-heading"><b>Live-Details</b><span id="logCount">0 Einträge</span></div><div id="logEntries" class="log-entries"><div class="log-empty">Pipeline wird vorbereitet …</div></div></div>
      <div class="background-note">iOS kann die Verarbeitung im Hintergrund pausieren oder beenden.</div>
      <button class="cancel" id="cancel">Abbrechen</button>
    </section></main>`;
  document.querySelector('#cancel')?.addEventListener('click', cancel);
  updateProgressView();
}

function currentSpeed() {
  const elapsed = (Date.now() - startedAt) / 1000;
  const recent = speedSamples.filter(sample => elapsed - sample.wall <= 30);
  if (recent.length >= 2) {
    const first = recent[0]!;
    const last = recent[recent.length - 1]!;
    if (last.wall > first.wall) return Math.max(0, (last.media - first.media) / (last.wall - first.wall));
  }
  return elapsed > 3 ? processedTime / elapsed : 0;
}

function processingDuration() {
  if (!info) return 0;
  if (mode !== 'manual' || !manual) return info.duration;
  const end = manual.trimEnd > manual.trimStart ? manual.trimEnd : info.duration;
  return Math.max(0, end - manual.trimStart);
}

function updateProgressView() {
  if (!startedAt) return;
  const percent = Math.max(0, Math.min(100, Math.round(progressValue * 100)));
  const elapsed = (Date.now() - startedAt) / 1000;
  const speed = currentSpeed();
  const duration = processingDuration();
  const remainingMedia = Math.max(0, duration - processedTime);
  const eta = speed > .01 && progressValue > .01 ? remainingMedia / speed : Infinity;
  const setText = (selector: string, text: string) => { const node = document.querySelector(selector); if (node) node.textContent = text; };
  setText('#progressPhase', currentPhase);
  setText('#progressPercent', String(percent));
  setText('#elapsed', formatDetailedTime(elapsed));
  setText('#speed', speed > .01 ? `${speed.toFixed(speed < 1 ? 2 : 1)}× Echtzeit` : 'Wird ermittelt');
  setText('#eta', Number.isFinite(eta) ? formatDetailedTime(eta) : '–');
  setText('#mediaTime', `${formatDetailedTime(processedTime)} / ${formatDetailedTime(duration)}`);
  const ring = document.querySelector<HTMLElement>('#progressRing');
  const bar = document.querySelector<HTMLElement>('#progressBar');
  if (ring) ring.style.setProperty('--progress', `${percent * 3.6}deg`);
  if (bar) bar.style.width = `${percent}%`;
}

function appendProgressLog(entry: ProcessLogEntry) {
  progressLogs.push(entry);
  const list = document.querySelector('#logEntries');
  if (!list) return;
  list.querySelector('.log-empty')?.remove();
  const row = document.createElement('div');
  row.className = `log-entry ${entry.level}`;
  const dot = document.createElement('i');
  const body = document.createElement('div');
  const title = document.createElement('b');
  const detail = document.createElement('span');
  const time = document.createElement('time');
  title.textContent = entry.title;
  detail.textContent = entry.detail;
  time.textContent = `+${formatDetailedTime(entry.elapsed)}`;
  body.append(title, detail);
  row.append(dot, body, time);
  list.append(row);
  list.scrollTop = list.scrollHeight;
  const count = document.querySelector('#logCount');
  if (count) count.textContent = `${progressLogs.length} ${progressLogs.length === 1 ? 'Eintrag' : 'Einträge'}`;
}

async function handleDone(fileName: string, mime: string, hardwarePreferred: boolean) {
  sessionStorage.removeItem('kompakt-active');
  window.clearInterval(progressTimer);
  progressTimer = 0;
  const root = await navigator.storage.getDirectory();
  const storedFile = await (await root.getFileHandle(fileName)).getFile();
  const file = storedFile.type === mime ? storedFile : new File([storedFile], fileName, { type: mime });
  result = { file, url: URL.createObjectURL(file), hardwarePreferred };
  renderDone();
}

function renderDone() {
  if (!result) return;
  const inputSize = selectedFile?.size || 0;
  const delta = inputSize ? Math.abs(1 - result.file.size / inputSize) : 0;
  const sizeSummary = !inputSize || result.file.size === inputSize
    ? 'Gleiche Größe'
    : `${Math.round(delta * 100)} % ${result.file.size < inputSize ? 'kleiner' : 'größer'}`;
  app.innerHTML = `<main class="shell process-shell"><header><a class="brand"><span class="mark">K</span><span>Kompakt</span></a></header>
    <section class="done-state"><div class="success">${icon('check')}</div><div class="eyebrow">FERTIG</div><h2>Dein Medium ist fertig.</h2><p>${result.hardwarePreferred ? 'Hardware-Encoder bevorzugt · ' : ''}${sizeSummary} · ${formatBytes(result.file.size)}</p>
      <div class="size-compare"><div><span>Vorher</span><b>${formatBytes(selectedFile?.size || 0)}</b></div><i>→</i><div><span>Nachher</span><b>${formatBytes(result.file.size)}</b></div></div>
      <button class="cta" id="share">${icon('share')} ${info?.audioOnly ? 'In Dateien sichern' : 'In Fotos / Dateien sichern'}</button>
      <a class="download" href="${result.url}" download="${result.file.name}">Stattdessen herunterladen</a>
      <button class="text-button another" id="again">Weiteres Medium verkleinern</button>
      <small class="save-help">Im Teilen-Menü ${info?.audioOnly ? '„In Dateien sichern“' : '„Video sichern“ oder „In Dateien sichern“'} wählen.</small>
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
    else if (startedAt) { currentPhase = message.phase; updateProgressView(); }
  }
  if (message.type === 'analysis') { info = message.info; manual = info.audioOnly ? null : defaultManualSettings(info); renderPreset(); }
  if (message.type === 'log') appendProgressLog(message.entry);
  if (message.type === 'progress') {
    progressValue = message.progress;
    processedTime = message.time;
    const wall = (Date.now() - startedAt) / 1000;
    if (!speedSamples.length || wall - speedSamples[speedSamples.length - 1]!.wall >= 1) {
      speedSamples.push({ wall, media: message.time });
      speedSamples = speedSamples.filter(sample => wall - sample.wall <= 35);
    }
    updateProgressView();
  }
  if (message.type === 'done') handleDone(message.fileName, message.mime, message.hardwarePreferred).catch(() => {
    showToast('Die fertige Datei konnte nicht aus dem lokalen Speicher gelesen werden.');
    renderPreset();
  });
  if (message.type === 'error') {
    window.clearInterval(progressTimer);
    progressTimer = 0;
    startedAt = 0;
    sessionStorage.removeItem('kompakt-active');
    showToast(message.message);
    info ? renderPreset() : renderHome();
  }
}

function currentOutputName() {
  if (!info) return null;
  const extension = info.audioOnly ? (outputFormat === 'mp4' ? 'm4a' : outputFormat) : 'mp4';
  return `${info.name.replace(/\.[^.]+$/, '')}-kompakt.${extension}`;
}

async function removeLocalOutput(fileName: string) {
  try {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry(fileName);
  } catch { /* Die Datei wurde noch nicht angelegt oder bereits entfernt. */ }
}

function cancel() {
  const partialOutput = currentOutputName();
  worker.terminate();
  worker = createWorker();
  if (partialOutput) void removeLocalOutput(partialOutput);
  sessionStorage.removeItem('kompakt-active');
  window.clearInterval(progressTimer);
  progressTimer = 0;
  startedAt = 0;
  info = null;
  selectedFile = null;
  manual = null;
  renderHome();
}

function reset(event?: Event) {
  event?.preventDefault();
  const storedOutput = result?.file.name;
  if (result) URL.revokeObjectURL(result.url);
  if (storedOutput) void removeLocalOutput(storedOutput);
  window.clearInterval(progressTimer);
  progressTimer = 0;
  result = null; info = null; selectedFile = null; manual = null; startedAt = 0;
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
