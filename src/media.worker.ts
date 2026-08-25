/// <reference lib="webworker" />
import {
  ALL_FORMATS,
  BlobSource,
  canEncodeAudio,
  canEncodeVideo,
  Conversion,
  FlacOutputFormat,
  Input,
  Mp3OutputFormat,
  Mp4OutputFormat,
  Output,
  Quality,
  StreamTarget,
  WavOutputFormat,
  type AudioCodec,
  type ConversionAudioOptions,
  type OutputFormat,
  type StreamTargetChunk
} from 'mediabunny';
import {
  AUDIO_BITRATES,
  estimatedAudioSize,
  estimatedVideoSize,
  targetDimensions,
  targetVideoBitrate
} from './presets';
import type { MediaInfo, OutputFormatId, PresetId, WorkerRequest, WorkerResponse } from './types';

const ctx: DedicatedWorkerGlobalScope = self as unknown as DedicatedWorkerGlobalScope;

let inputFile: File | null = null;
let inputInfo: MediaInfo | null = null;
let mediaInput: Input | null = null;

const send = (message: WorkerResponse) => ctx.postMessage(message);

async function analyze(file: File) {
  send({ type: 'phase', phase: 'Medium wird analysiert' });
  inputFile = null;
  inputInfo = null;
  mediaInput?.dispose();
  mediaInput = null;
  const input = new Input({
    formats: ALL_FORMATS,
    source: new BlobSource(file, { maxCacheSize: 16 * 1024 * 1024 })
  });

  if (!await input.canRead()) {
    input.dispose();
    throw new Error('Dieses Medienformat wird von Mediabunny nicht erkannt.');
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
  const [width, height, codec, audioBitrate, hdr, sampleRate, channels] = await Promise.all([
    video?.getDisplayWidth() ?? 0,
    video?.getDisplayHeight() ?? 0,
    (video || audio)?.getCodec() ?? null,
    audio?.getBitrate() ?? 0,
    video?.hasHighDynamicRange() ?? false,
    audio?.getSampleRate() ?? 0,
    audio?.getNumberOfChannels() ?? 0
  ]);

  mediaInput = input;
  inputFile = file;
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
    audioBitrate: audioBitrate || 0,
    sampleRate: sampleRate || 0,
    channels: channels || 0
  };
  send({ type: 'analysis', info: inputInfo });
}

async function registerAudioEncoder(codec: 'aac' | 'mp3' | 'flac', options: {
  numberOfChannels: number;
  sampleRate: number;
  quality?: Quality;
}) {
  if (await canEncodeAudio(codec, options)) return;

  if (codec === 'aac') {
    const { registerAacEncoder } = await import('@mediabunny/aac-encoder');
    registerAacEncoder();
  } else if (codec === 'mp3') {
    const { registerMp3Encoder } = await import('@mediabunny/mp3-encoder');
    registerMp3Encoder();
  } else {
    const { registerFlacEncoder } = await import('@mediabunny/flac-encoder');
    registerFlacEncoder();
  }

  if (!await canEncodeAudio(codec, options)) {
    throw new Error(`${codec.toUpperCase()} kann auf diesem Gerät nicht erzeugt werden.`);
  }
}

async function assertLocalStorage(expectedBytes: number) {
  if (!navigator.storage?.getDirectory) {
    throw new Error('Der lokale Dateispeicher ist in diesem Browser nicht verfügbar.');
  }
  const estimate: StorageEstimate = await navigator.storage.estimate().catch(() => ({}));
  if (estimate.quota && estimate.usage !== undefined) {
    const available = Math.max(0, estimate.quota - estimate.usage);
    const required = Math.max(16 * 1024 * 1024, expectedBytes * 1.15);
    if (available < required) {
      throw new Error('Nicht genug freier Gerätespeicher für die geschätzte Ausgabedatei.');
    }
  }
}

async function createOutputTarget(fileName: string, expectedBytes: number) {
  await assertLocalStorage(expectedBytes);
  const root = await navigator.storage.getDirectory();
  const handle = await root.getFileHandle(fileName, { create: true });
  const writable = await handle.createWritable();
  const target = new StreamTarget(writable as unknown as WritableStream<StreamTargetChunk>, {
    chunked: true,
    chunkSize: 4 * 1024 * 1024
  });
  return { root, target };
}

function outputName(extension: string) {
  if (!inputInfo) throw new Error('Bitte zuerst ein Medium auswählen.');
  return `${inputInfo.name.replace(/\.[^.]+$/, '')}-kompakt.${extension}`;
}

function lossyAudioConfig(preset: PresetId) {
  if (!inputInfo) throw new Error('Bitte zuerst ein Medium auswählen.');
  const quality = new Quality({ bitrate: AUDIO_BITRATES[preset] });
  return {
    numberOfChannels: Math.max(1, Math.min(2, inputInfo.channels || 2)),
    sampleRate: Math.max(8_000, Math.min(48_000, inputInfo.sampleRate || 48_000)),
    quality
  };
}

function audioOutputSettings(format: Exclude<OutputFormatId, 'mp4'>, expectedBytes: number) {
  if (format === 'm4a') return {
    format: new Mp4OutputFormat({ fastStart: false }) as OutputFormat,
    codec: 'aac' as AudioCodec,
    mime: 'audio/mp4'
  };
  if (format === 'mp3') return {
    format: new Mp3OutputFormat() as OutputFormat,
    codec: 'mp3' as AudioCodec,
    mime: 'audio/mpeg'
  };
  if (format === 'flac') return {
    format: new FlacOutputFormat() as OutputFormat,
    codec: 'flac' as AudioCodec,
    mime: 'audio/flac'
  };
  return {
    format: new WavOutputFormat({ large: expectedBytes >= 0xffff_ffff }) as OutputFormat,
    codec: 'pcm-s16' as AudioCodec,
    mime: 'audio/wav'
  };
}

async function audioTranscode(preset: PresetId, formatId: Exclude<OutputFormatId, 'mp4'>) {
  if (!inputInfo || !mediaInput || !inputInfo.audioOnly) throw new Error('Bitte zuerst eine Audiodatei auswählen.');
  const audioTrack = await mediaInput.getPrimaryAudioTrack();
  if (!audioTrack) throw new Error('Die Datei enthält keine Audiospur.');
  if (!await audioTrack.canDecode()) {
    throw new Error('Der Eingabe-Audiocodec kann in diesem Browser nicht gelesen werden. Auf dem iPhone ist für komprimiertes Audio iOS 26 oder neuer nötig.');
  }

  const expectedBytes = estimatedAudioSize(inputInfo, preset, formatId);
  const settings = audioOutputSettings(formatId, expectedBytes);
  const fileName = outputName(formatId);

  const lossless = formatId === 'wav' || formatId === 'flac';
  const encoding = lossyAudioConfig(preset);
  if (settings.codec === 'aac' || settings.codec === 'mp3') {
    await registerAudioEncoder(settings.codec, encoding);
  } else if (settings.codec === 'flac') {
    await registerAudioEncoder('flac', {
      numberOfChannels: Math.max(1, inputInfo.channels || 2),
      sampleRate: Math.max(8_000, inputInfo.sampleRate || 48_000)
    });
  }

  const storageBytes = formatId === 'flac'
    ? inputInfo.duration * (inputInfo.sampleRate || 48_000) * Math.max(1, inputInfo.channels || 2) * 2
    : expectedBytes;
  const { root, target } = await createOutputTarget(fileName, storageBytes);

  let output: Output | null = null;
  let conversion: Conversion | null = null;
  try {
    output = new Output({ format: settings.format, target });
    const audioOptions: ConversionAudioOptions = {
      codec: settings.codec,
      forceTranscode: true,
      ...(formatId === 'wav' ? { sampleFormat: 's16' as const } : lossless ? {} : { ...encoding })
    };
    conversion = await Conversion.init({
      input: mediaInput,
      output,
      tracks: 'primary',
      video: { discard: true },
      audio: audioOptions,
      showWarnings: false
    });
    if (!conversion.isValid || conversion.discardedTracks.some(({ track }) => track.type === 'audio')) {
      throw new Error('Die Audiospur kann nicht in das gewählte Format umgewandelt werden.');
    }
    conversion.onProgress = (progress, time) => send({ type: 'progress', progress, time, hardware: false });
    send({ type: 'phase', phase: formatId === 'flac' ? 'FLAC wird verlustfrei erzeugt' : 'Audio wird lokal verarbeitet' });
    await conversion.execute();
  } catch (error) {
    if (conversion) await conversion.cancel().catch(() => {});
    else if (output) await output.cancel().catch(() => {});
    await root.removeEntry(fileName).catch(() => {});
    throw error;
  }

  send({ type: 'done', fileName, mime: settings.mime, hardware: false });
}

async function videoTranscode(preset: PresetId) {
  if (!inputFile || !inputInfo || !mediaInput || inputInfo.audioOnly) throw new Error('Bitte zuerst ein Video auswählen.');
  const videoTrack = await mediaInput.getPrimaryVideoTrack();
  if (!videoTrack || !await videoTrack.canDecode()) {
    throw new Error('Der Videocodec kann auf diesem Gerät nicht über WebCodecs gelesen werden.');
  }

  const dimensions = targetDimensions(inputInfo, preset);
  const quality = new Quality({ bitrate: targetVideoBitrate(inputInfo, preset) });
  const hardwareSupported = await canEncodeVideo('avc', {
    ...dimensions,
    quality,
    hardwareAcceleration: 'prefer-hardware'
  });
  if (!hardwareSupported) throw new Error('Der H.264-Hardwareencoder unterstützt diese Auflösung nicht.');

  const format = new Mp4OutputFormat({ fastStart: false });
  let audioOptions: ConversionAudioOptions | undefined;
  const audioTrack = await mediaInput.getPrimaryAudioTrack();
  if (audioTrack) {
    const codec = await audioTrack.getCodec();
    if (!codec || !format.getSupportedAudioCodecs().includes(codec)) {
      if (!await audioTrack.canDecode()) throw new Error('Die Audiospur kann nicht in MP4 übernommen werden.');
      const encoding = lossyAudioConfig(preset);
      await registerAudioEncoder('aac', encoding);
      audioOptions = { codec: 'aac', forceTranscode: true, ...encoding };
    }
  }

  const fileName = outputName('mp4');
  const expectedBytes = estimatedVideoSize(inputInfo, preset);
  const { root, target } = await createOutputTarget(fileName, expectedBytes);
  let output: Output | null = null;
  let conversion: Conversion | null = null;
  try {
    output = new Output({ format, target });
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
      audio: audioOptions,
      showWarnings: false
    });
    if (!conversion.isValid || conversion.discardedTracks.some(({ track }) => track.type === 'video' || track.type === 'audio')) {
      throw new Error('Mindestens eine Medien-Spur kann nicht in MP4 übernommen werden.');
    }
    conversion.onProgress = (progress, time) => send({ type: 'progress', progress, time, hardware: true });
    send({ type: 'phase', phase: 'Video wird hardwarebeschleunigt' });
    await conversion.execute();
  } catch (error) {
    if (conversion) await conversion.cancel().catch(() => {});
    else if (output) await output.cancel().catch(() => {});
    await root.removeEntry(fileName).catch(() => {});
    throw error;
  }

  send({ type: 'done', fileName, mime: 'video/mp4', hardware: true });
}

async function transcode(preset: PresetId, outputFormat: OutputFormatId) {
  if (!inputInfo || !inputFile || !mediaInput) throw new Error('Bitte zuerst ein Medium auswählen.');
  if (inputInfo.audioOnly) {
    await audioTranscode(preset, outputFormat === 'mp4' ? 'm4a' : outputFormat);
  } else {
    await videoTranscode(preset);
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
