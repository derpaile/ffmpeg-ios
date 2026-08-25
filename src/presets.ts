import type { MediaInfo, PresetId } from './types';

export const VIDEO_PRESETS = {
  small: { maxWidth: 1280, nominalVideoBitrate: 2_500_000, audioBitrate: 96_000, ratio: 0.24 },
  balanced: { maxWidth: 1920, nominalVideoBitrate: 5_000_000, audioBitrate: 128_000, ratio: 0.44 },
  quality: { maxWidth: Infinity, nominalVideoBitrate: 18_000_000, audioBitrate: 160_000, ratio: 0.7 }
} as const;

export function targetDimensions(info: Pick<MediaInfo, 'width' | 'height'>, preset: PresetId) {
  const maxWidth = VIDEO_PRESETS[preset].maxWidth;
  const scale = Number.isFinite(maxWidth) && info.width > maxWidth ? maxWidth / info.width : 1;
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
