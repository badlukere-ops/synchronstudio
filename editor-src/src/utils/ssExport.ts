/**
 * Synchronstudio scene ZIP export
 * Produces: scene.json + <id>.mp4 (video+backing) + <id>/*.png + <id>/lines/NN.mp3
 */
import JSZip from 'jszip';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { toBlobURL } from '@ffmpeg/util';
import { Character, MediaSource, PackInfo, TimelineClip } from '../types';
import { audioBufferToWavBlob, sliceAudioBuffer } from './audio';
import { ZipExportProgress } from './zipExporter';

let ffmpegInstance: FFmpeg | null = null;

async function getFFmpeg(onStatus?: (s: string) => void): Promise<FFmpeg> {
  if (ffmpegInstance?.loaded) return ffmpegInstance;
  const ffmpeg = new FFmpeg();
  try {
    onStatus?.('Loading FFmpeg (local)…');
    const base = `${window.location.origin}${window.location.pathname.replace(/\/[^/]*$/, '/') || '/'}ffmpeg`;
    // built editor serves public/ffmpeg next to index
    const localBase = new URL('ffmpeg/', window.location.href).href.replace(/\/$/, '');
    await ffmpeg.load({
      coreURL: await toBlobURL(`${localBase}/ffmpeg-core.js`, 'text/javascript'),
      wasmURL: await toBlobURL(`${localBase}/ffmpeg-core.wasm`, 'application/wasm'),
      workerURL: await toBlobURL(`${localBase}/ffmpeg-core.worker.js`, 'text/javascript'),
    });
  } catch {
    onStatus?.('Loading FFmpeg (CDN)…');
    const cdn = 'https://unpkg.com/@ffmpeg/core@0.12.10/dist/esm';
    await ffmpeg.load({
      coreURL: await toBlobURL(`${cdn}/ffmpeg-core.js`, 'text/javascript'),
      wasmURL: await toBlobURL(`${cdn}/ffmpeg-core.wasm`, 'application/wasm'),
    });
  }
  ffmpegInstance = ffmpeg;
  return ffmpeg;
}

export function slugifySceneId(title: string, fallback = 'newscene'): string {
  const s = (title || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_-]+/g, '')
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 40);
  return s || fallback;
}

function panForIndex(i: number, n: number): number {
  if (n <= 1) return 0;
  return -0.35 + (0.7 * i) / (n - 1);
}

async function blobFromMedia(media?: MediaSource): Promise<Blob | null> {
  if (!media) return null;
  if (media.file) return media.file;
  if (media.url) {
    try {
      return await (await fetch(media.url)).blob();
    } catch {
      return null;
    }
  }
  return null;
}

async function ensurePngBlob(blob: Blob): Promise<Blob> {
  if (blob.type === 'image/png') return blob;
  try {
    const bmp = await createImageBitmap(blob);
    const canvas = document.createElement('canvas');
    const max = 512;
    const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
    canvas.width = Math.max(1, Math.round(bmp.width * scale));
    canvas.height = Math.max(1, Math.round(bmp.height * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) return blob;
    ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    return await new Promise((resolve) =>
      canvas.toBlob((b) => resolve(b || blob), 'image/png')
    );
  } catch {
    return blob;
  }
}

async function muxVideoWithBacking(
  videoBlob: Blob,
  backingBlob: Blob | null,
  onProgress?: (p: number, msg: string) => void,
  abortSignal?: AbortSignal
): Promise<Blob> {
  const ffmpeg = await getFFmpeg((m) => onProgress?.(5, m));
  if (abortSignal?.aborted) throw new Error('EXPORT_CANCELLED');

  const progressHandler = ({ progress }: { progress: number }) => {
    const pct = Math.min(95, Math.max(10, Math.round(10 + progress * 80)));
    onProgress?.(pct, `Encoding scene video… ${Math.round(progress * 100)}%`);
  };
  ffmpeg.on('progress', progressHandler);

  try {
    const vExt = videoBlob.type.includes('ogg') ? 'ogv' : 'mp4';
    await ffmpeg.writeFile(`in.${vExt}`, new Uint8Array(await videoBlob.arrayBuffer()));
    if (backingBlob) {
      const aExt = backingBlob.type.includes('wav')
        ? 'wav'
        : backingBlob.type.includes('ogg')
          ? 'ogg'
          : 'mp3';
      await ffmpeg.writeFile(`backing.${aExt}`, new Uint8Array(await backingBlob.arrayBuffer()));
      // Prefer copy video + replace audio; fallback mpeg4 if needed
      let code = await ffmpeg.exec([
        '-i', `in.${vExt}`,
        '-i', `backing.${aExt}`,
        '-map', '0:v:0',
        '-map', '1:a:0',
        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        '-crf', '28',
        '-vf', "scale='min(1280,iw)':-2",
        '-c:a', 'aac',
        '-b:a', '96k',
        '-shortest',
        '-movflags', '+faststart',
        'out.mp4',
      ]);
      if (code !== 0) {
        code = await ffmpeg.exec([
          '-i', `in.${vExt}`,
          '-i', `backing.${aExt}`,
          '-map', '0:v:0',
          '-map', '1:a:0',
          '-c:v', 'mpeg4',
          '-q:v', '6',
          '-vf', "scale='min(1280,iw)':-2",
          '-c:a', 'aac',
          '-b:a', '96k',
          '-shortest',
          'out.mp4',
        ]);
      }
      if (code !== 0) throw new Error('VIDEO_MUX_FAILED');
    } else {
      const code = await ffmpeg.exec([
        '-i', `in.${vExt}`,
        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        '-crf', '28',
        '-vf', "scale='min(1280,iw)':-2",
        '-an',
        '-movflags', '+faststart',
        'out.mp4',
      ]);
      if (code !== 0) {
        // last resort: pass through original bytes as mp4/ogv renamed — caller still gets a file
        return videoBlob;
      }
    }
    const data = await ffmpeg.readFile('out.mp4');
    return new Blob([data as Uint8Array], { type: 'video/mp4' });
  } finally {
    try {
      ffmpeg.off('progress', progressHandler);
    } catch {}
  }
}

async function wavToMonoMp3(wavBlob: Blob, ffmpeg: FFmpeg): Promise<Blob> {
  await ffmpeg.writeFile('clip.wav', new Uint8Array(await wavBlob.arrayBuffer()));
  const code = await ffmpeg.exec(['-y', '-i', 'clip.wav', '-ac', '1', '-b:a', '64k', 'clip.mp3']);
  if (code !== 0) return wavBlob;
  const data = await ffmpeg.readFile('clip.mp3');
  try {
    await ffmpeg.deleteFile('clip.wav');
    await ffmpeg.deleteFile('clip.mp3');
  } catch {}
  return new Blob([data as Uint8Array], { type: 'audio/mpeg' });
}

export async function exportSynchronstudioZip(
  packInfo: PackInfo,
  characters: Character[],
  clips: TimelineClip[],
  videoMedia?: MediaSource,
  backingTrackMedia?: MediaSource,
  onProgress?: (progress: ZipExportProgress) => void,
  abortSignal?: AbortSignal
): Promise<{ archive: Blob; videoFailed: boolean }> {
  const check = () => {
    if (abortSignal?.aborted) throw new Error('EXPORT_CANCELLED');
  };
  let maxP = 0;
  const upd = (status: string, percent: number) => {
    maxP = Math.max(maxP, Math.round(percent));
    onProgress?.({ status, percent: maxP });
  };

  const sceneId = slugifySceneId(packInfo.sceneId || packInfo.title);
  const title = packInfo.title || sceneId;
  const sorted = [...clips].sort((a, b) => a.startTime - b.startTime);
  const zip = new JSZip();
  let videoFailed = false;

  upd('Preparing…', 2);
  check();

  // Roles from characters that appear in clips (or all characters)
  const usedNames = new Set<string>();
  sorted.forEach((c) => c.dubCharacters.forEach((n) => usedNames.add(n)));
  const roleChars = characters.filter((c) => usedNames.has(c.name));
  const rolesSource = roleChars.length ? roleChars : characters;
  const roleIndex = new Map<string, number>();
  rolesSource.forEach((c, i) => roleIndex.set(c.name, i));

  const ffmpeg = await getFFmpeg((s) => upd(s, 4));

  // Avatars as real PNG
  upd('Adding avatars…', 8);
  const avatarPaths: Record<string, string> = {};
  for (let i = 0; i < rolesSource.length; i++) {
    check();
    const char = rolesSource[i];
    const safe = char.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || `role${i}`;
    let blob: Blob | null = char.avatarFile || null;
    if (!blob && char.avatarUrl) {
      try {
        blob = await (await fetch(char.avatarUrl)).blob();
      } catch {}
    }
    if (blob) {
      blob = await ensurePngBlob(blob);
      const rel = `${sceneId}/${safe}.png`;
      zip.file(rel, blob);
      avatarPaths[String(i)] = `scenes/${rel}`;
    }
  }

  // Lines audio
  upd('Slicing voicelines…', 15);
  const lines: any[] = [];
  for (let i = 0; i < sorted.length; i++) {
    check();
    const clip = sorted[i];
    const n = String(i + 1).padStart(2, '0');
    const who = clip.dubCharacters[0] || rolesSource[0]?.name || 'Role';
    const rid = roleIndex.has(who) ? roleIndex.get(who)! : 0;
    const t = +(clip.dubTimestamps?.[0] ?? clip.startTime).toFixed(3);
    const end = +Math.max(t + 0.2, clip.endTime).toFixed(3);
    const text = (clip.caption || '').replace(/[“”]/g, '"').trim() || `(line ${n})`;
    const de = (clip.captionDe || text).replace(/[“”]/g, '"').trim();

    let wavBlob: Blob | undefined = clip.audioBlob;
    if (!wavBlob && videoMedia?.audioBuffer) {
      try {
        wavBlob = audioBufferToWavBlob(
          sliceAudioBuffer(videoMedia.audioBuffer, clip.startTime, clip.endTime)
        );
      } catch {}
    }
    // Prefer vocals-style: if separate buffer not available, still try video buffer
    if (wavBlob) {
      try {
        const mp3 = await wavToMonoMp3(wavBlob, ffmpeg);
        zip.file(`${sceneId}/lines/${n}.mp3`, mp3);
      } catch {
        zip.file(`${sceneId}/lines/${n}.wav`, wavBlob);
      }
    }

    lines.push({
      t,
      end,
      chars: [rid],
      who,
      text,
      de,
      orig: `scenes/${sceneId}/lines/${n}.mp3`,
    });
    upd(`Line ${i + 1}/${sorted.length}…`, 15 + (i / Math.max(1, sorted.length)) * 35);
  }

  // Video + backing
  check();
  upd('Muxing video + backing track…', 55);
  const videoBlob = await blobFromMedia(videoMedia);
  const backingBlob = await blobFromMedia(backingTrackMedia);
  if (videoBlob) {
    try {
      const mp4 = await muxVideoWithBacking(
        videoBlob,
        backingBlob,
        (p, msg) => upd(msg, 55 + (p / 100) * 30),
        abortSignal
      );
      zip.file(`${sceneId}.mp4`, mp4);
    } catch (e: any) {
      if (e?.message === 'EXPORT_CANCELLED') throw e;
      console.warn('Video mux failed', e);
      videoFailed = true;
      zip.file(`${sceneId}_SOURCE` + (videoBlob.type.includes('ogg') ? '.ogv' : '.mp4'), videoBlob);
      if (backingBlob) zip.file(`${sceneId}/_backing_track.mp3`, backingBlob);
    }
  } else {
    videoFailed = true;
  }

  const roles = rolesSource.map((c, i) => ({
    id: i,
    name: c.name,
    pan: +panForIndex(i, rolesSource.length).toFixed(2),
    effect: 'none',
    gain: 1,
  }));

  const scene = {
    id: sceneId,
    title: `${title} (${roles.length} Rollen)`,
    videoUrl: `scenes/${sceneId}.mp4`,
    avatars: avatarPaths,
    roles,
    lines,
    difficultyOverride: 'medium',
  };

  zip.file('scene.json', JSON.stringify(scene, null, 2));
  zip.file(
    'README.txt',
    [
      'Synchronstudio scene export',
      '',
      `1. Copy ${sceneId}.mp4 into the scenes/ folder of the repo`,
      `2. Copy the folder ${sceneId}/ (avatars + lines) into scenes/`,
      '3. Paste the object from scene.json into scenes.json (add a comma between scenes)',
      '4. Commit & push',
      '',
      `Scene id: ${sceneId}`,
      `Title: ${scene.title}`,
      `Lines: ${lines.length}`,
    ].join('\n')
  );

  // Keep draft for re-import
  if (!packInfo.excludeDraftJson) {
    zip.file(
      '_draft_project.json',
      JSON.stringify(
        {
          packInfo: { ...packInfo, sceneId, iconBlob: undefined, fillerImageBlob: undefined },
          characters: characters.map((c) => ({
            ...c,
            avatarFile: undefined,
            avatarUrl: c.avatarUrl?.startsWith('blob:') ? undefined : c.avatarUrl,
          })),
          clips: sorted.map((c) => ({ ...c, audioBlob: undefined })),
        },
        null,
        2
      )
    );
  }

  upd('Compressing ZIP…', 92);
  const archive = await zip.generateAsync({ type: 'blob' }, (meta) => {
    check();
    upd('Compressing ZIP…', 92 + meta.percent * 0.08);
  });
  upd('Done!', 100);
  return { archive, videoFailed };
}
