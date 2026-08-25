export type PresetId = 'small' | 'balanced' | 'quality';
export type OutputFormatId = 'mp4' | 'm4a' | 'mp3' | 'wav' | 'flac';

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
  | { type: 'transcode'; preset: PresetId; outputFormat: OutputFormatId };

export type WorkerResponse =
  | { type: 'phase'; phase: string }
  | { type: 'analysis'; info: MediaInfo }
  | { type: 'progress'; progress: number; time: number; hardware: boolean }
  | { type: 'done'; fileName: string; mime: string; hardware: boolean }
  | { type: 'error'; message: string };
