export type PresetId = 'small' | 'balanced' | 'quality';

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
}

export type WorkerRequest =
  | { type: 'analyze'; file: File }
  | { type: 'transcode'; preset: PresetId; outputFormat: 'mp4' | 'm4a' | 'mp3' | 'wav' };

export type WorkerResponse =
  | { type: 'phase'; phase: string }
  | { type: 'analysis'; info: MediaInfo }
  | { type: 'progress'; progress: number; time: number; hardware: boolean }
  | { type: 'done'; data?: Uint8Array; fileName: string; mime: string; stored: boolean; hardware: boolean }
  | { type: 'error'; message: string };
