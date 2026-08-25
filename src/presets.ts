import type { ManualVideoSettings, MediaInfo, OutputFormatId, PresetId } from './types';

export const AUDIO_BITRATES = {
  small: 96_000,
  balanced: 128_000,
  quality: 160_000
} as const;

export const VIDEO_PRESETS = {
  small: { maxLongEdge: 1280, nominalVideoBitrate: 2_500_000, audioBitrate: 96_000, ratio: 0.24 },
  balanced: { maxLongEdge: 1920, nominalVideoBitrate: 5_000_000, audioBitrate: 128_000, ratio: 0.44 },
  quality: { maxLongEdge: Infinity, nominalVideoBitrate: 18_000_000, audioBitrate: 160_000, ratio: 0.7 }
} as const;

export function targetDimensions(info: Pick<MediaInfo, 'width' | 'height'>, preset: PresetId) {
  const maxLongEdge = VIDEO_PRESETS[preset].maxLongEdge;
  const longEdge = Math.max(info.width, info.height);
  const scale = Number.isFinite(maxLongEdge) && longEdge > maxLongEdge ? maxLongEdge / longEdge : 1;
  const even = (value: number) => Math.max(2, Math.round(value * scale / 2) * 2);
  return { width: even(info.width), height: even(info.height) };
}

export function dimensionsForLongEdge(info: Pick<MediaInfo, 'width' | 'height'>, longEdge: number) {
  const scale = Math.min(1, longEdge / Math.max(info.width, info.height));
  const even = (value: number) => Math.max(2, Math.round(value * scale / 2) * 2);
  return { width: even(info.width), height: even(info.height) };
}

export function targetVideoBitrate(info: Pick<MediaInfo, 'size' | 'duration' | 'audioBitrate'>, preset: PresetId) {
  const settings = VIDEO_PRESETS[preset];
  if (!info.duration) return settings.nominalVideoBitrate;
  const inputBitrate = info.size * 8 / info.duration;
  const reservedAudio = Math.max(info.audioBitrate, settings.audioBitrate);
  const compressionBudget = Math.max(250_000, inputBitrate * settings.ratio - reservedAudio);
  return Math.round(Math.min(settings.nominalVideoBitrate, compressionBudget));
}

export function estimatedVideoSize(info: Pick<MediaInfo, 'size' | 'duration' | 'audioBitrate'>, preset: PresetId) {
  const settings = VIDEO_PRESETS[preset];
  const audioBitrate = Math.max(info.audioBitrate, settings.audioBitrate);
  const bytes = info.duration * (targetVideoBitrate(info, preset) + audioBitrate) / 8 * 1.01;
  return Math.min(bytes, info.size * 0.95);
}

export function estimatedManualVideoSize(
  info: Pick<MediaInfo, 'duration' | 'audioBitrate'>,
  settings: ManualVideoSettings
) {
  const duration = Math.max(0, (settings.trimEnd > settings.trimStart ? settings.trimEnd : info.duration) - settings.trimStart);
  const audioBitrate = settings.audioMode === 'discard'
    ? 0
    : settings.audioMode === 'aac' ? settings.audioBitrate : info.audioBitrate;
  return duration * (settings.bitrate + audioBitrate) / 8 * 1.02;
}

export function estimatedAudioSize(
  info: Pick<MediaInfo, 'duration' | 'sampleRate' | 'channels'>,
  preset: PresetId,
  format: Exclude<OutputFormatId, 'mp4'>
) {
  if (format === 'm4a' || format === 'mp3') return info.duration * AUDIO_BITRATES[preset] / 8 * 1.02;
  const pcmBytes = info.duration * (info.sampleRate || 48_000) * Math.max(1, info.channels || 2) * 2;
  return format === 'wav' ? pcmBytes + 4096 : pcmBytes * 0.65;
}
