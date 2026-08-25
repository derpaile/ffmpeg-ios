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
  registerVideoSampleTransformer,
  StreamTarget,
  VideoSample,
  WavOutputFormat,
  type AudioCodec,
  type ConversionAudioOptions,
  type ConversionVideoOptions,
  type OutputFormat,
  type StreamTargetChunk,
  type VideoCodec,
  type VideoSampleTransformationDescription
} from 'mediabunny';
import {
  AUDIO_BITRATES,
  estimatedAudioSize,
  estimatedManualVideoSize,
  estimatedVideoSize,
  targetDimensions,
  targetVideoBitrate
} from './presets';
import type {
  ManualVideoSettings,
  MediaInfo,
  OutputFormatId,
  PresetId,
  ProcessLogLevel,
  ScalerMode,
  WorkerRequest,
  WorkerResponse
} from './types';

const ctx: DedicatedWorkerGlobalScope = self as unknown as DedicatedWorkerGlobalScope;

let inputFile: File | null = null;
let inputInfo: MediaInfo | null = null;
let mediaInput: Input | null = null;
let activeScaler: ScalerMode | null = null;
let processStartedAt = 0;
let logId = 0;
let scalerFallbackReported = false;

const send = (message: WorkerResponse) => ctx.postMessage(message);

function formatBytes(bytes: number) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  return `${Math.round(bytes / 1024 ** 2)} MB`;
}

function formatRate(bitrate: number) {
  return bitrate >= 1_000_000 ? `${(bitrate / 1_000_000).toFixed(1)} Mbit/s` : `${Math.round(bitrate / 1000)} kbit/s`;
}

function log(title: string, detail: string, level: ProcessLogLevel = 'info') {
  send({
    type: 'log',
    entry: {
      id: ++logId,
      elapsed: processStartedAt ? (performance.now() - processStartedAt) / 1000 : 0,
      level,
      title,
      detail
    }
  });
}

function startLog() {
  processStartedAt = performance.now();
  logId = 0;
  scalerFallbackReported = false;
}

let scaleCanvas: OffscreenCanvas | null = null;
let scaleContext: OffscreenCanvasRenderingContext2D | null = null;
let scaleCanvasKey = '';

function fastScale(sample: VideoSample, description: VideoSampleTransformationDescription) {
  if (!activeScaler || activeScaler === 'quality') return null;
  try {
    const key = `${description.width}x${description.height}:${description.alpha}`;
    if (!scaleCanvas || !scaleContext || scaleCanvasKey !== key) {
      scaleCanvas = new OffscreenCanvas(description.width, description.height);
      scaleContext = scaleCanvas.getContext('2d', {
        alpha: description.alpha === 'keep',
        desynchronized: true
      });
      if (!scaleContext) return null;
      scaleCanvasKey = key;
    }

    scaleContext.imageSmoothingEnabled = true;
    scaleContext.imageSmoothingQuality = activeScaler === 'fast' ? 'low' : 'high';
    scaleContext.globalCompositeOperation = 'source-over';
    if (description.alpha === 'discard') {
      scaleContext.fillStyle = 'black';
      scaleContext.fillRect(0, 0, description.width, description.height);
    } else {
      scaleContext.clearRect(0, 0, description.width, description.height);
    }
    sample.drawWithFit(scaleContext, {
      fit: description.fit,
      rotation: description.rotation,
      crop: description.crop
    });
    return new VideoSample(scaleCanvas, {
      timestamp: sample.timestamp,
      duration: sample.duration,
      rotation: 0,
      encodeOptions: sample.encodeOptions
    });
  } catch {
    if (!scalerFallbackReported) {
      scalerFallbackReported = true;
      log('Kompatibilitätsmodus', 'Der Browser übernimmt die Skalierung dieses Pixelformats.', 'warning');
    }
    return null;
  }
}

registerVideoSampleTransformer(fastScale);

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
  startLog();
  log('Quelle geprüft', `${inputInfo.format} · ${inputInfo.codec} · ${formatBytes(inputInfo.size)}`, 'success');
  log('Ausgabe geplant', `${formatId.toUpperCase()} · ungefähr ${formatBytes(expectedBytes)}`);

  const lossless = formatId === 'wav' || formatId === 'flac';
  const encoding = lossyAudioConfig(preset);
  if (settings.codec === 'aac' || settings.codec === 'mp3') {
    log('Audio-Encoder', `${settings.codec.toUpperCase()} mit ${formatRate(AUDIO_BITRATES[preset])}`);
    await registerAudioEncoder(settings.codec, encoding);
  } else if (settings.codec === 'flac') {
    log('Audio-Encoder', 'FLAC · verlustfrei');
    await registerAudioEncoder('flac', {
      numberOfChannels: Math.max(1, inputInfo.channels || 2),
      sampleRate: Math.max(8_000, inputInfo.sampleRate || 48_000)
    });
  }

  const storageBytes = formatId === 'flac'
    ? inputInfo.duration * (inputInfo.sampleRate || 48_000) * Math.max(1, inputInfo.channels || 2) * 2
    : expectedBytes;
  const { root, target } = await createOutputTarget(fileName, storageBytes);
  log('Lokaler Speicher bereit', 'Ausgabe wird ohne Arbeitsspeicher-Limit gestreamt.', 'success');

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
    conversion.onProgress = (progress, time) => send({ type: 'progress', progress, time, hardwarePreferred: false });
    send({ type: 'phase', phase: formatId === 'flac' ? 'FLAC wird verlustfrei erzeugt' : 'Audio wird lokal verarbeitet' });
    log('Verarbeitung läuft', 'Dekodieren, umwandeln und schreiben erfolgen lokal.');
    await conversion.execute();
  } catch (error) {
    if (conversion) await conversion.cancel().catch(() => {});
    else if (output) await output.cancel().catch(() => {});
    await root.removeEntry(fileName).catch(() => {});
    throw error;
  }

  log('Ausgabe abgeschlossen', fileName, 'success');
  send({ type: 'done', fileName, mime: settings.mime, hardwarePreferred: false });
}

type ResolvedVideoSettings = {
  width: number;
  height: number;
  fit: 'contain' | 'cover' | 'fill';
  rotation: 0 | 90 | 180 | 270;
  crop?: { left: number; top: number; width: number; height: number };
  codec: VideoCodec;
  quality: Quality;
  bitrate: number;
  frameRate?: number;
  keyFrameInterval: number;
  hardwareAcceleration: 'prefer-hardware' | 'no-preference' | 'prefer-software';
  scaler: ScalerMode;
  audioMode: 'auto' | 'copy' | 'aac' | 'discard';
  audioBitrate: number;
  audioChannels: number;
  audioSampleRate: number;
  trim?: { start?: number; end?: number };
  preserveMetadata: boolean;
  manual: boolean;
};

function finiteInt(value: number, fallback: number, min: number, max: number) {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback;
}

function resolveVideoSettings(preset: PresetId, manual?: ManualVideoSettings): ResolvedVideoSettings {
  if (!inputInfo) throw new Error('Bitte zuerst ein Video auswählen.');
  if (!manual) {
    const dimensions = targetDimensions(inputInfo, preset);
    const bitrate = targetVideoBitrate(inputInfo, preset);
    return {
      ...dimensions,
      fit: 'contain',
      rotation: 0,
      codec: 'avc',
      quality: new Quality({ bitrate, bitrateMode: 'variable' }),
      bitrate,
      keyFrameInterval: 5,
      hardwareAcceleration: 'prefer-hardware',
      scaler: preset === 'small' ? 'fast' : 'balanced',
      audioMode: 'auto',
      audioBitrate: AUDIO_BITRATES[preset],
      audioChannels: Math.max(1, Math.min(2, inputInfo.channels || 2)),
      audioSampleRate: Math.max(8_000, Math.min(48_000, inputInfo.sampleRate || 48_000)),
      preserveMetadata: true,
      manual: false
    };
  }

  const width = Math.ceil(finiteInt(manual.width, inputInfo.width, 2, 8192) / 2) * 2;
  const height = Math.ceil(finiteInt(manual.height, inputInfo.height, 2, 8192) / 2) * 2;
  const bitrate = finiteInt(manual.bitrate, 5_000_000, 100_000, 100_000_000);
  const trimStart = Math.min(inputInfo.duration, Math.max(0, Number(manual.trimStart) || 0));
  const trimEnd = Math.min(inputInfo.duration, Math.max(0, Number(manual.trimEnd) || 0));
  if (trimEnd > 0 && trimEnd <= trimStart) throw new Error('Das Ende des Ausschnitts muss hinter dem Start liegen.');
  const crop = manual.cropEnabled ? {
    left: Math.max(0, finiteInt(manual.cropLeft, 0, 0, 8192)),
    top: Math.max(0, finiteInt(manual.cropTop, 0, 0, 8192)),
    width: finiteInt(manual.cropWidth, width, 2, 8192),
    height: finiteInt(manual.cropHeight, height, 2, 8192)
  } : undefined;

  return {
    width,
    height,
    fit: manual.fit,
    rotation: manual.rotation,
    crop,
    codec: manual.codec,
    quality: manual.rateControl === 'quantizer'
      ? new Quality({ quantizer: finiteInt(manual.quantizer, 23, 0, 63), bitrate })
      : new Quality({ bitrate, bitrateMode: manual.bitrateMode }),
    bitrate,
    frameRate: manual.frameRate > 0 ? Math.min(120, manual.frameRate) : undefined,
    keyFrameInterval: Math.min(30, Math.max(0.25, manual.keyFrameInterval || 5)),
    hardwareAcceleration: manual.hardwareAcceleration,
    scaler: manual.scaler,
    audioMode: manual.audioMode,
    audioBitrate: finiteInt(manual.audioBitrate, 128_000, 32_000, 512_000),
    audioChannels: manual.audioChannels > 0 ? finiteInt(manual.audioChannels, 2, 1, 8) : Math.max(1, inputInfo.channels || 2),
    audioSampleRate: manual.audioSampleRate > 0 ? finiteInt(manual.audioSampleRate, 48_000, 8_000, 192_000) : Math.max(8_000, inputInfo.sampleRate || 48_000),
    trim: trimStart > 0 || trimEnd > 0 ? { start: trimStart || undefined, end: trimEnd || undefined } : undefined,
    preserveMetadata: manual.preserveMetadata,
    manual: true
  };
}

async function videoTranscode(preset: PresetId, manual?: ManualVideoSettings) {
  if (!inputFile || !inputInfo || !mediaInput || inputInfo.audioOnly) throw new Error('Bitte zuerst ein Video auswählen.');
  startLog();
  const plan = resolveVideoSettings(preset, manual);
  const videoTrack = await mediaInput.getPrimaryVideoTrack();
  if (!videoTrack || !await videoTrack.canDecode()) {
    throw new Error('Der Videocodec kann auf diesem Gerät nicht über WebCodecs gelesen werden.');
  }
  log('Quelle geprüft', `${inputInfo.format} · ${inputInfo.codec} · ${inputInfo.width} × ${inputInfo.height} · ${formatBytes(inputInfo.size)}`, 'success');
  if (inputInfo.hdr) log('HDR erkannt', 'Der schnelle Canvas-Pfad überführt das Bild browserabhängig nach SDR.', 'warning');

  const dimensions = { width: plan.width, height: plan.height };
  let hardwareAcceleration = plan.hardwareAcceleration;
  let encoderSupported = await canEncodeVideo(plan.codec, {
    ...dimensions,
    quality: plan.quality,
    hardwareAcceleration
  });
  if (!encoderSupported && hardwareAcceleration === 'prefer-hardware') {
    encoderSupported = await canEncodeVideo(plan.codec, {
      ...dimensions,
      quality: plan.quality,
      hardwareAcceleration: 'no-preference'
    });
    if (encoderSupported) {
      hardwareAcceleration = 'no-preference';
      log('Encoder-Fallback', 'Die Hardware-Vorgabe ist nicht verfügbar; der Browser wählt automatisch.', 'warning');
    }
  }
  if (!encoderSupported) throw new Error(`${plan.codec.toUpperCase()} unterstützt ${plan.width} × ${plan.height} mit diesen Einstellungen nicht.`);

  const scaleNeeded = plan.width !== inputInfo.width
    || plan.height !== inputInfo.height
    || !!plan.crop
    || plan.rotation !== 0;
  activeScaler = scaleNeeded ? plan.scaler : null;
  log('Video-Ausgabe', `${plan.codec.toUpperCase()} · ${plan.width} × ${plan.height} · ${formatRate(plan.bitrate)}`);
  log(
    scaleNeeded ? 'Skalierung' : 'Direkter Bildpfad',
    scaleNeeded
      ? `${plan.scaler === 'quality' ? 'Mehrstufig, höchste Qualität' : 'Schneller Ein-Pass-Pfad'} · ${plan.fit}`
      : 'Keine Canvas-Skalierung nötig.',
    'success'
  );
  log('Encoder', hardwareAcceleration === 'prefer-hardware' ? 'Hardware-Encoder wird bevorzugt.' : hardwareAcceleration === 'prefer-software' ? 'Software-Encoder wird bevorzugt.' : 'Browser wählt den besten Encoder.');

  const format = new Mp4OutputFormat({ fastStart: false });
  let audioOptions: ConversionAudioOptions | undefined;
  const audioTrack = await mediaInput.getPrimaryAudioTrack();
  if (plan.audioMode === 'discard') {
    audioOptions = { discard: true };
    log('Audio', 'Audiospur wird entfernt.');
  } else if (audioTrack) {
    const codec = await audioTrack.getCodec();
    const forceAac = plan.audioMode === 'aac';
    if (forceAac || !codec || !format.getSupportedAudioCodecs().includes(codec)) {
      if (!await audioTrack.canDecode()) throw new Error('Die Audiospur kann nicht in MP4 übernommen werden.');
      const encoding = {
        numberOfChannels: plan.audioChannels,
        sampleRate: plan.audioSampleRate,
        quality: new Quality({ bitrate: plan.audioBitrate })
      };
      await registerAudioEncoder('aac', encoding);
      audioOptions = { codec: 'aac', forceTranscode: true, ...encoding };
      log('Audio', `AAC · ${formatRate(plan.audioBitrate)} · ${plan.audioChannels} Kanal/Kanäle`);
    } else {
      log('Audio', `${String(codec).toUpperCase()} wird ohne erneute Kodierung übernommen.`, 'success');
    }
  } else {
    log('Audio', 'Keine Audiospur vorhanden.');
  }

  const fileName = outputName('mp4');
  const expectedBytes = manual ? estimatedManualVideoSize(inputInfo, manual) : estimatedVideoSize(inputInfo, preset);
  const { root, target } = await createOutputTarget(fileName, expectedBytes);
  log('Lokaler Speicher bereit', `Geschätzte Ausgabe ${formatBytes(expectedBytes)} · direktes Streaming`, 'success');
  let output: Output | null = null;
  let conversion: Conversion | null = null;
  try {
    output = new Output({ format, target });
    const videoOptions: ConversionVideoOptions = {
      codec: plan.codec,
      quality: plan.quality,
      hardwareAcceleration,
      forceTranscode: true,
      keyFrameInterval: plan.keyFrameInterval,
      ...(plan.frameRate ? { frameRate: plan.frameRate } : {}),
      ...(plan.rotation ? { rotate: plan.rotation } : {}),
      ...(plan.crop ? { crop: plan.crop } : {}),
      ...(scaleNeeded ? {
        width: plan.width,
        height: plan.height,
        fit: plan.fit
      } : {})
    };
    conversion = await Conversion.init({
      input: mediaInput,
      output,
      tracks: 'primary',
      video: videoOptions,
      audio: audioOptions,
      ...(plan.trim ? { trim: plan.trim } : {}),
      ...(!plan.preserveMetadata ? { tags: {} } : {}),
      showWarnings: false
    });
    const unexpectedDiscard = conversion.discardedTracks.some(({ track }) =>
      track.type === 'video' || (track.type === 'audio' && plan.audioMode !== 'discard'));
    if (!conversion.isValid || unexpectedDiscard) {
      throw new Error('Mindestens eine Medien-Spur kann nicht in MP4 übernommen werden.');
    }
    let milestone = 0;
    conversion.onProgress = (progress, time) => {
      send({ type: 'progress', progress, time, hardwarePreferred: hardwareAcceleration === 'prefer-hardware' });
      const nextMilestone = Math.floor(progress * 10) * 10;
      if (nextMilestone >= milestone + 10 && nextMilestone < 100) {
        milestone = nextMilestone;
        log(`${milestone} % verarbeitet`, `${Math.round(time)} Sekunden Videomaterial abgeschlossen.`, 'success');
      }
    };
    send({ type: 'phase', phase: 'Video wird verarbeitet' });
    log('Pipeline gestartet', 'Dekodieren, skalieren, kodieren und schreiben laufen parallel.');
    await conversion.execute();
  } catch (error) {
    if (conversion) await conversion.cancel().catch(() => {});
    else if (output) await output.cancel().catch(() => {});
    await root.removeEntry(fileName).catch(() => {});
    throw error;
  } finally {
    activeScaler = null;
  }

  log('Ausgabe abgeschlossen', fileName, 'success');
  send({ type: 'done', fileName, mime: 'video/mp4', hardwarePreferred: hardwareAcceleration === 'prefer-hardware' });
}

async function transcode(preset: PresetId, outputFormat: OutputFormatId, manual?: ManualVideoSettings) {
  if (!inputInfo || !inputFile || !mediaInput) throw new Error('Bitte zuerst ein Medium auswählen.');
  if (inputInfo.audioOnly) {
    await audioTranscode(preset, outputFormat === 'mp4' ? 'm4a' : outputFormat);
  } else {
    await videoTranscode(preset, manual);
  }
}

ctx.onmessage = async ({ data }: MessageEvent<WorkerRequest>) => {
  try {
    if (data.type === 'analyze') await analyze(data.file);
    if (data.type === 'transcode') await transcode(data.preset, data.outputFormat, data.manual);
  } catch (error) {
    send({ type: 'error', message: error instanceof Error ? error.message : 'Unbekannter Fehler' });
  }
};
