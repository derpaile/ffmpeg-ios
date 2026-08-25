/// <reference lib="webworker" />
import type { FFmpeg as FFmpegType } from '@ffmpeg/ffmpeg';
import coreURL from '@ffmpeg/core?url';
import {
  ALL_FORMATS,
  BlobSource,
  BufferTarget,
  canEncodeVideo,
  Conversion,
  Input,
  Mp4OutputFormat,
  Output,
  Quality,
  StreamTarget,
  type StreamTargetChunk
} from 'mediabunny';
import { targetDimensions, targetVideoBitrate } from './presets';
import type { MediaInfo, PresetId, WorkerRequest, WorkerResponse } from './types';

const wasmURL = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm/ffmpeg-core.wasm';
const SOFTWARE_LIMIT = 200 * 1024 * 1024;
const ctx: DedicatedWorkerGlobalScope = self as unknown as DedicatedWorkerGlobalScope;

let ffmpeg: FFmpegType | null = null;
let ffmpegInputName = '';
let inputFile: File | null = null;
let inputInfo: MediaInfo | null = null;
let mediaInput: Input | null = null;
let recentLogs: string[] = [];

const send = (message: WorkerResponse, transfer?: Transferable[]) => ctx.postMessage(message, transfer || []);
const asNumber = (value: unknown) => Number.isFinite(Number(value)) ? Number(value) : 0;

async function ensureFfmpegLoaded() {
  if (ffmpeg) return;
  send({ type: 'phase', phase: 'Kompatibilitätsmodus wird vorbereitet' });
  const { FFmpeg } = await import('@ffmpeg/ffmpeg');
  ffmpeg = new FFmpeg();
  ffmpeg.on('log', ({ message }) => {
    recentLogs.push(message);
    if (recentLogs.length > 20) recentLogs.shift();
  });
  ffmpeg.on('progress', ({ progress, time }) => send({
    type: 'progress',
    progress: Math.max(0, Math.min(1, progress)),
    time,
    hardware: false
  }));
  await ffmpeg.load({ coreURL, wasmURL });
}

async function ensureFfmpegInput() {
  if (!inputFile) throw new Error('Bitte zuerst ein Medium auswählen.');
  if (inputFile.size > SOFTWARE_LIMIT) {
    throw new Error('Diese große Datei benötigt den Hardwaremodus. Der Software-Fallback ist auf 200 MB begrenzt.');
  }
  await ensureFfmpegLoaded();
  if (!ffmpeg) throw new Error('FFmpeg konnte nicht geladen werden.');
  if (ffmpegInputName) return;
  ffmpegInputName = `input.${inputFile.name.split('.').pop()?.toLowerCase() || 'bin'}`;
  await ffmpeg.writeFile(ffmpegInputName, new Uint8Array(await inputFile.arrayBuffer()));
}

async function analyzeNative(file: File) {
  const input = new Input({
    formats: ALL_FORMATS,
    source: new BlobSource(file, { maxCacheSize: 16 * 1024 * 1024 })
  });
  if (!await input.canRead()) {
    input.dispose();
    throw new Error('Format wird vom schnellen Medienpfad nicht erkannt.');
  }

  const [format, video, audio, metadataDuration] = await Promise.all([
    input.getFormat(),
    input.getPrimaryVideoTrack(),
    input.getPrimaryAudioTrack(),
    input.getDurationFromMetadata()
  ]);
  if (!video && !audio) {
    input.dispose();
    throw new Error('Die Datei enthält keine unterstützte Audio- oder Videospur.');
  }

  const duration = metadataDuration || await input.computeDuration();
  const [width, height, codec, audioBitrate, hdr] = await Promise.all([
    video?.getDisplayWidth() ?? 0,
    video?.getDisplayHeight() ?? 0,
    (video || audio)?.getCodec() ?? null,
    audio?.getBitrate() ?? 0,
    video?.hasHighDynamicRange() ?? false
  ]);

  mediaInput?.dispose();
  mediaInput = input;
  inputInfo = {
    name: file.name,
    size: file.size,
    duration,
    width,
    height,
    format: format.name,
    codec: String(codec || 'Unbekannt').toUpperCase(),
    audioOnly: !video,
    hdr,
    audioBitrate: audioBitrate || 0
  };
  send({ type: 'analysis', info: inputInfo });
}

async function analyzeWithFfmpeg(file: File) {
  if (file.size > SOFTWARE_LIMIT) {
    throw new Error('Dateien über 200 MB müssen als unterstütztes MOV- oder MP4-Video vorliegen.');
  }
  await ensureFfmpegInput();
  if (!ffmpeg) throw new Error('FFmpeg konnte nicht geladen werden.');
  const probeName = 'probe.json';
  recentLogs = [];
  await ffmpeg.ffprobe(['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', ffmpegInputName, '-o', probeName]);
  let probe: { format?: Record<string, unknown>; streams?: Array<Record<string, unknown>> };
  try {
    const raw = await ffmpeg.readFile(probeName, 'utf8');
    probe = JSON.parse(String(raw));
  } catch {
    throw new Error(`Dieses Medium konnte nicht analysiert werden. ${recentLogs.slice(-2).join(' ')}`.trim());
  }
  const streams = probe.streams || [];
  const video = streams.find(stream => stream.codec_type === 'video');
  const audio = streams.find(stream => stream.codec_type === 'audio');
  if (!video && !audio) throw new Error('Die Datei enthält keine unterstützte Audio- oder Videospur.');
  const colorTransfer = String(video?.color_transfer || '').toLowerCase();
  const colorPrimaries = String(video?.color_primaries || '').toLowerCase();
  inputInfo = {
    name: file.name,
    size: file.size,
    duration: asNumber(probe.format?.duration || video?.duration || audio?.duration),
    width: asNumber(video?.width),
    height: asNumber(video?.height),
    format: String(probe.format?.format_long_name || probe.format?.format_name || file.type || 'Unbekannt'),
    codec: String(video?.codec_name || audio?.codec_name || 'Unbekannt').toUpperCase(),
    audioOnly: !video,
    hdr: ['smpte2084', 'arib-std-b67'].includes(colorTransfer) || colorPrimaries.includes('bt2020'),
    audioBitrate: asNumber(audio?.bit_rate)
  };
  await ffmpeg.deleteFile(probeName);
  send({ type: 'analysis', info: inputInfo });
}

async function analyze(file: File) {
  inputFile = file;
  inputInfo = null;
  mediaInput?.dispose();
  mediaInput = null;
  if (ffmpeg && ffmpegInputName) await ffmpeg.deleteFile(ffmpegInputName).catch(() => {});
  ffmpegInputName = '';
  send({ type: 'phase', phase: 'Medium wird analysiert' });
  try {
    await analyzeNative(file);
  } catch {
    await analyzeWithFfmpeg(file);
  }
}

function softwareOutputSettings(preset: PresetId, audioOnly: boolean, format: string) {
  if (audioOnly) {
    if (format === 'wav') return ['-vn', '-c:a', 'pcm_s16le'];
    if (format === 'mp3') return ['-vn', '-c:a', 'libmp3lame', '-b:a', preset === 'small' ? '96k' : '160k'];
    return ['-vn', '-c:a', 'aac', '-b:a', preset === 'small' ? '96k' : '128k'];
  }
  const map = {
    small: ['-vf', "scale='min(1280,iw)':-2", '-crf', '28', '-b:a', '96k'],
    balanced: ['-vf', "scale='min(1920,iw)':-2", '-crf', '24', '-b:a', '128k'],
    quality: ['-crf', '20', '-b:a', '160k']
  } as const;
  return ['-map_metadata', '0', '-c:v', 'libx264', '-preset', 'veryfast', ...map[preset], '-c:a', 'aac', '-movflags', '+faststart', '-pix_fmt', 'yuv420p'];
}

async function softwareTranscode(preset: PresetId, outputFormat: 'mp4' | 'm4a' | 'mp3' | 'wav') {
  if (!inputFile || !inputInfo) throw new Error('Bitte zuerst ein Medium auswählen.');
  await ensureFfmpegInput();
  if (!ffmpeg) throw new Error('FFmpeg konnte nicht geladen werden.');
  send({ type: 'phase', phase: inputInfo.audioOnly ? 'Audio wird komprimiert' : 'Software-Fallback wird verwendet' });
  const ext = inputInfo.audioOnly ? outputFormat : 'mp4';
  const outputName = `${inputInfo.name.replace(/\.[^.]+$/, '')}-kompakt.${ext}`;
  const code = await ffmpeg.exec(['-i', ffmpegInputName, ...softwareOutputSettings(preset, inputInfo.audioOnly, ext), '-y', outputName]);
  if (code !== 0) throw new Error('Die Verarbeitung ist fehlgeschlagen.');
  const data = await ffmpeg.readFile(outputName) as Uint8Array;
  const mime = ext === 'mp4' ? 'video/mp4' : ext === 'm4a' ? 'audio/mp4' : ext === 'mp3' ? 'audio/mpeg' : 'audio/wav';
  send({ type: 'done', data, fileName: outputName, mime, stored: false, hardware: false }, [data.buffer]);
  await ffmpeg.deleteFile(outputName);
}

async function hardwareTranscode(preset: PresetId) {
  if (!inputFile || !inputInfo || !mediaInput || inputInfo.audioOnly) throw new Error('Hardwaremodus nicht verfügbar.');
  const videoTrack = await mediaInput.getPrimaryVideoTrack();
  if (!videoTrack || !await videoTrack.canDecode()) throw new Error('Der Videocodec kann auf diesem Gerät nicht hardwarebeschleunigt gelesen werden.');

  const dimensions = targetDimensions(inputInfo, preset);
  const quality = new Quality({ bitrate: targetVideoBitrate(inputInfo, preset) });
  const hardwareSupported = await canEncodeVideo('avc', {
    ...dimensions,
    quality,
    hardwareAcceleration: 'prefer-hardware'
  });
  if (!hardwareSupported) throw new Error('Der H.264-Hardwareencoder unterstützt diese Auflösung nicht.');

  const outputName = `${inputInfo.name.replace(/\.[^.]+$/, '')}-kompakt.mp4`;
  let root: FileSystemDirectoryHandle | null = null;
  let target: StreamTarget | BufferTarget;
  let stored = false;
  try {
    root = await navigator.storage.getDirectory();
    const handle = await root.getFileHandle(outputName, { create: true });
    const writable = await handle.createWritable();
    target = new StreamTarget(writable as unknown as WritableStream<StreamTargetChunk>, {
      chunked: true,
      chunkSize: 4 * 1024 * 1024
    });
    stored = true;
  } catch {
    if (inputFile.size > SOFTWARE_LIMIT) throw new Error('Für große Ausgaben ist auf diesem Gerät nicht genug lokaler App-Speicher verfügbar.');
    target = new BufferTarget();
  }

  let output: Output | null = null;
  let conversion: Conversion | null = null;
  try {
    output = new Output({ format: new Mp4OutputFormat({ fastStart: false }), target });
    conversion = await Conversion.init({
      input: mediaInput,
      output,
      tracks: 'primary',
      video: {
        width: dimensions.width,
        height: dimensions.height,
        fit: 'contain',
        codec: 'avc',
        quality,
        hardwareAcceleration: 'prefer-hardware',
        forceTranscode: true,
        keyFrameInterval: 5
      },
      showWarnings: false
    });
    if (!conversion.isValid || conversion.discardedTracks.some(({ track }) => track.type === 'audio')) {
      throw new Error('Mindestens eine Medien-Spur kann im Hardwaremodus nicht übernommen werden.');
    }
    conversion.onProgress = (progress, time) => send({ type: 'progress', progress, time, hardware: true });
    send({ type: 'phase', phase: 'Video wird hardwarebeschleunigt' });
    await conversion.execute();
  } catch (error) {
    if (conversion) await conversion.cancel().catch(() => {});
    else if (output) await output.cancel().catch(() => {});
    if (stored && root) await root.removeEntry(outputName).catch(() => {});
    throw error;
  }

  if (stored) {
    send({ type: 'done', fileName: outputName, mime: 'video/mp4', stored: true, hardware: true });
  } else {
    const data = new Uint8Array((target as BufferTarget).buffer!);
    send({ type: 'done', data, fileName: outputName, mime: 'video/mp4', stored: false, hardware: true }, [data.buffer]);
  }
}

async function transcode(preset: PresetId, outputFormat: 'mp4' | 'm4a' | 'mp3' | 'wav') {
  if (!inputInfo || !inputFile) throw new Error('Bitte zuerst ein Medium auswählen.');
  if (inputInfo.audioOnly || !mediaInput) {
    await softwareTranscode(preset, outputFormat);
    return;
  }
  try {
    await hardwareTranscode(preset);
  } catch (error) {
    if (inputFile.size > SOFTWARE_LIMIT) throw error;
    await softwareTranscode(preset, outputFormat);
  }
}

ctx.onmessage = async ({ data }: MessageEvent<WorkerRequest>) => {
  try {
    if (data.type === 'analyze') await analyze(data.file);
    if (data.type === 'transcode') await transcode(data.preset, data.outputFormat);
  } catch (error) {
    send({ type: 'error', message: error instanceof Error ? error.message : 'Unbekannter Fehler' });
  }
};
