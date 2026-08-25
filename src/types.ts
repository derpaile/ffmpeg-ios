export type PresetId = 'small' | 'balanced' | 'quality';
export type CompressionMode = PresetId | 'manual';
export type OutputFormatId = 'mp4' | 'm4a' | 'mp3' | 'wav' | 'flac';
export type VideoCodecId = 'avc' | 'hevc' | 'vp9' | 'av1';
export type ScalerMode = 'fast' | 'balanced' | 'quality';
export type HardwarePreference = 'prefer-hardware' | 'no-preference' | 'prefer-software';
export type ProcessLogLevel = 'info' | 'success' | 'warning';

export interface ManualVideoSettings {
  width: number;
  height: number;
  fit: 'contain' | 'cover' | 'fill';
  rotation: 0 | 90 | 180 | 270;
  cropEnabled: boolean;
  cropLeft: number;
  cropTop: number;
  cropWidth: number;
  cropHeight: number;
  codec: VideoCodecId;
  rateControl: 'bitrate' | 'quantizer';
  bitrate: number;
  bitrateMode: 'variable' | 'constant';
  quantizer: number;
  frameRate: number;
  keyFrameInterval: number;
  hardwareAcceleration: HardwarePreference;
  scaler: ScalerMode;
  audioMode: 'copy' | 'aac' | 'discard';
  audioBitrate: number;
  audioChannels: number;
  audioSampleRate: number;
  trimStart: number;
  trimEnd: number;
  preserveMetadata: boolean;
}

export interface ProcessLogEntry {
  id: number;
  elapsed: number;
  level: ProcessLogLevel;
  title: string;
  detail: string;
}

export interface MediaInfo {
  name: string;
  size: number;
  duration: number;
  width: number;
  height: number;
  format: string;
  codec: string;
  audioOnly: boolean;
  hdr: boolean;
  audioBitrate: number;
  sampleRate: number;
  channels: number;
}

export type WorkerRequest =
  | { type: 'analyze'; file: File }
  | { type: 'transcode'; preset: PresetId; outputFormat: OutputFormatId; manual?: ManualVideoSettings };

export type WorkerResponse =
  | { type: 'phase'; phase: string }
  | { type: 'analysis'; info: MediaInfo }
  | { type: 'log'; entry: ProcessLogEntry }
  | { type: 'progress'; progress: number; time: number; hardwarePreferred: boolean }
  | { type: 'done'; fileName: string; mime: string; hardwarePreferred: boolean }
  | { type: 'error'; message: string };
