/// <reference lib="webworker" />
import type { FFmpeg as FFmpegType } from '@ffmpeg/ffmpeg';
import coreURL from '@ffmpeg/core?url';
import type { MediaInfo, WorkerRequest, WorkerResponse } from './types';

const wasmURL = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm/ffmpeg-core.wasm';

const ctx: DedicatedWorkerGlobalScope = self as unknown as DedicatedWorkerGlobalScope;
let ffmpeg: FFmpegType | null = null;
let inputName = '';
let inputInfo: MediaInfo | null = null;
let recentLogs: string[] = [];

const send = (message: WorkerResponse, transfer?: Transferable[]) => ctx.postMessage(message, transfer || []);

async function ensureLoaded() {
  if (ffmpeg) return;
  send({ type: 'phase', phase: 'Kompressor wird vorbereitet' });
  const { FFmpeg } = await import('@ffmpeg/ffmpeg');
  ffmpeg = new FFmpeg();
  ffmpeg.on('log', ({ message }) => {
    recentLogs.push(message);
    if (recentLogs.length > 20) recentLogs.shift();
  });
  ffmpeg.on('progress', ({ progress, time }) => send({ type: 'progress', progress: Math.max(0, Math.min(1, progress)), time }));
  await ffmpeg.load({ coreURL, wasmURL });
}

function asNumber(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function analyze(file: File) {
  await ensureLoaded();
  if (!ffmpeg) throw new Error('FFmpeg konnte nicht geladen werden.');
  send({ type: 'phase', phase: 'Medium wird analysiert' });
  inputName = `input.${file.name.split('.').pop()?.toLowerCase() || 'bin'}`;
  await ffmpeg.writeFile(inputName, new Uint8Array(await file.arrayBuffer()));
  const probeName = 'probe.json';
  recentLogs = [];
  await ffmpeg.ffprobe(['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', inputName, '-o', probeName]);
  let probe: { format?: Record<string, unknown>; streams?: Array<Record<string, unknown>> };
  try {
    const raw = await ffmpeg.readFile(probeName, 'utf8');
    probe = JSON.parse(String(raw));
  } catch {
    throw new Error(`Dieses Medium konnte nicht analysiert werden. ${recentLogs.slice(-2).join(' ')}`.trim());
  }
  const streams = probe.streams || [];
  if (!streams.some(stream => stream.codec_type === 'video' || stream.codec_type === 'audio')) throw new Error('Die Datei enthält keine unterstützte Audio- oder Videospur.');
  const video = streams.find(stream => stream.codec_type === 'video');
  const audio = streams.find(stream => stream.codec_type === 'audio');
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
    hdr: ['smpte2084', 'arib-std-b67'].includes(colorTransfer) || colorPrimaries.includes('bt2020')
  };
  await ffmpeg.deleteFile(probeName);
  send({ type: 'analysis', info: inputInfo });
}

function outputSettings(preset: 'small' | 'balanced' | 'quality', audioOnly: boolean, format: string) {
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

async function transcode(preset: 'small' | 'balanced' | 'quality', outputFormat: 'mp4' | 'm4a' | 'mp3' | 'wav') {
  if (!ffmpeg || !inputInfo || !inputName) throw new Error('Bitte zuerst ein Medium auswählen.');
  send({ type: 'phase', phase: inputInfo.audioOnly ? 'Audio wird komprimiert' : 'Video wird komprimiert' });
  const ext = inputInfo.audioOnly ? outputFormat : 'mp4';
  const outputName = `${inputInfo.name.replace(/\.[^.]+$/, '')}-kompakt.${ext}`;
  const code = await ffmpeg.exec(['-i', inputName, ...outputSettings(preset, inputInfo.audioOnly, ext), '-y', outputName]);
  if (code !== 0) throw new Error('Die Verarbeitung ist fehlgeschlagen.');
  const data = await ffmpeg.readFile(outputName) as Uint8Array;
  const mime = ext === 'mp4' ? 'video/mp4' : ext === 'm4a' ? 'audio/mp4' : ext === 'mp3' ? 'audio/mpeg' : 'audio/wav';
  send({ type: 'done', data, fileName: outputName, mime }, [data.buffer]);
  await ffmpeg.deleteFile(outputName);
}

ctx.onmessage = async ({ data }: MessageEvent<WorkerRequest>) => {
  try {
    if (data.type === 'analyze') await analyze(data.file);
    if (data.type === 'transcode') await transcode(data.preset, data.outputFormat);
  } catch (error) {
    send({ type: 'error', message: error instanceof Error ? error.message : 'Unbekannter Fehler' });
  }
};
