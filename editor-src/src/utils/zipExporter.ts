import JSZip from 'jszip';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';
import { Character, MediaSource, PackInfo, TimelineClip } from '../types';
import { audioBufferToWavBlob, sliceAudioBuffer } from './audio';
import { generateClipIni, generatePackInfoIni } from './ini';

export interface ZipExportProgress {
  status: string;
  percent: number;
}

let ffmpegInstance: FFmpeg | null = null;

async function getFFmpeg(onStatusUpdate?: (status: string) => void): Promise<FFmpeg> {
  if (ffmpegInstance && ffmpegInstance.loaded) {
    return ffmpegInstance;
  }
  const ffmpeg = new FFmpeg();
  
  // Try local assets first (using what the user uploaded on GitHub and downloaded locally)
  try {
    onStatusUpdate?.('Initializing local FFmpeg WebAssembly engine...');
    const baseURL = `${window.location.origin}/ffmpeg`;
    await ffmpeg.load({
      coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript'),
      wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm'),
      workerURL: await toBlobURL(`${baseURL}/ffmpeg-core.worker.js`, 'text/javascript'),
    });
    ffmpegInstance = ffmpeg;
    return ffmpeg;
  } catch (err) {
    console.warn('Local FFmpeg load failed, trying unpkg CDN as fallback:', err);
    try {
      onStatusUpdate?.('Initializing FFmpeg WebAssembly from CDN...');
      const cdnBase = 'https://unpkg.com/@ffmpeg/core@0.12.10/dist/esm';
      await ffmpeg.load({
        coreURL: await toBlobURL(`${cdnBase}/ffmpeg-core.js`, 'text/javascript'),
        wasmURL: await toBlobURL(`${cdnBase}/ffmpeg-core.wasm`, 'application/wasm'),
      });
      ffmpegInstance = ffmpeg;
      return ffmpeg;
    } catch (cdnErr) {
      console.error('All FFmpeg load attempts failed:', cdnErr);
      throw cdnErr;
    }
  }
}

export const captureFrameAtTime = (
  time: number,
  videoMediaUrl?: string
): Promise<string> => {
  return new Promise((resolve) => {
    const videoEl = document.getElementById('main-video-player') as HTMLVideoElement;
    const mediaUrl = videoMediaUrl || videoEl?.src || videoEl?.currentSrc;

    if (!mediaUrl) {
      resolve('');
      return;
    }

    const offscreenVid = document.createElement('video');
    offscreenVid.crossOrigin = 'anonymous';
    offscreenVid.muted = true;
    offscreenVid.playsInline = true;
    offscreenVid.preload = 'auto';

    let resolved = false;
    const cleanup = () => {
      if (resolved) return;
      resolved = true;
      offscreenVid.removeEventListener('seeked', handleSeeked);
      offscreenVid.removeEventListener('loadedmetadata', handleLoadedMetadata);
      offscreenVid.removeEventListener('error', handleError);
      clearTimeout(timeoutId);
      try {
        offscreenVid.pause();
        offscreenVid.removeAttribute('src');
        offscreenVid.load();
      } catch (e) {}
    };

    const doCapture = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = offscreenVid.videoWidth || videoEl?.videoWidth || 640;
        canvas.height = offscreenVid.videoHeight || videoEl?.videoHeight || 360;
        const ctx = canvas.getContext('2d');
        if (ctx && (offscreenVid.videoWidth > 0 || (videoEl && videoEl.videoWidth > 0))) {
          ctx.drawImage(offscreenVid, 0, 0);
          resolve(canvas.toDataURL('image/png'));
        } else {
          resolve('');
        }
      } catch (err) {
        console.error('Frame capture error:', err);
        resolve('');
      } finally {
        cleanup();
      }
    };

    const handleSeeked = () => {
      doCapture();
    };

    const handleLoadedMetadata = () => {
      const targetTime = Math.min(time, Math.max(0, (offscreenVid.duration || 100) - 0.05));
      offscreenVid.currentTime = targetTime;
    };

    const handleError = () => {
      resolve('');
      cleanup();
    };

    const timeoutId = setTimeout(() => {
      if (!resolved) {
        doCapture();
      }
    }, 1500);

    offscreenVid.addEventListener('seeked', handleSeeked);
    offscreenVid.addEventListener('loadedmetadata', handleLoadedMetadata);
    offscreenVid.addEventListener('error', handleError);

    offscreenVid.src = mediaUrl;
    if (offscreenVid.readyState >= 1) {
      const targetTime = Math.min(time, Math.max(0, (offscreenVid.duration || 100) - 0.05));
      offscreenVid.currentTime = targetTime;
    }
  });
};

async function convertMp4ToOgv(
  videoBlob: Blob,
  onProgress?: (progressPercent: number, statusMsg?: string) => void,
  abortSignal?: AbortSignal
): Promise<Blob> {
  if (videoBlob.type === 'video/ogg' || videoBlob.type === 'video/ogv') {
    return videoBlob;
  }

  if (abortSignal?.aborted) {
    throw new Error('EXPORT_CANCELLED');
  }

  let ffmpeg: FFmpeg | null = null;
  let progressHandler: ((event: any) => void) | null = null;
  let abortListener: (() => void) | null = null;

  try {
    onProgress?.(2, 'Initializing video engine...');
    ffmpeg = await getFFmpeg((msg) => onProgress?.(5, 'Loading video engine...'));

    if (abortSignal?.aborted) throw new Error('EXPORT_CANCELLED');

    // If export is cancelled during ffmpeg operations, terminate worker immediately so it doesn't hang
    abortListener = () => {
      try {
        ffmpeg?.terminate();
      } catch {
        // ignore termination error
      }
      ffmpegInstance = null;
    };
    abortSignal?.addEventListener('abort', abortListener, { once: true });

    progressHandler = ({ progress }: { progress: number }) => {
      if (abortSignal?.aborted) return; // Do not throw inside event listener to prevent uncaught worker exceptions
      const safeProgress = Number.isFinite(progress) ? progress : 0;
      const progressPercent = Math.min(100, Math.max(0, Math.round(safeProgress * 100)));
      const p = 10 + Math.min(89, Math.max(0, Math.round(safeProgress * 89)));
      onProgress?.(p, `Converting MP4 to OGV... ${progressPercent}%`);
    };

    ffmpeg.on('progress', progressHandler);

    onProgress?.(8, 'Reading video...');
    
    // Read input video data directly into Uint8Array with cancellation check
    const arrayBuffer = await videoBlob.arrayBuffer();
    if (abortSignal?.aborted) throw new Error('EXPORT_CANCELLED');
    const inputData = new Uint8Array(arrayBuffer);

    if (abortSignal?.aborted) throw new Error('EXPORT_CANCELLED');

    await ffmpeg.writeFile('input.mp4', inputData);

    if (abortSignal?.aborted) throw new Error('EXPORT_CANCELLED');

    onProgress?.(10, 'Converting MP4 to OGV... 0%');

    // Convert MP4 to true OGV format (Theora video + Vorbis audio)
    const execResult = await ffmpeg.exec([
      '-i', 'input.mp4',
      '-c:v', 'libtheora',
      '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
      '-pix_fmt', 'yuv420p',
      '-q:v', '6',
      '-c:a', 'libvorbis',
      '-ar', '44100',
      '-q:a', '4',
      'dub_video.ogv'
    ]);
    
    if (abortSignal?.aborted) throw new Error('EXPORT_CANCELLED');

    if (execResult !== 0 && (execResult as any).code !== 0) {
      throw new Error('OGV_CONVERSION_FAILED');
    }

    const data = await ffmpeg.readFile('dub_video.ogv');
    
    try {
      await ffmpeg.deleteFile('input.mp4');
      await ffmpeg.deleteFile('dub_video.ogv');
    } catch {
      // Ignore file cleanup errors
    }

    onProgress?.(100, 'Video conversion complete!');
    return new Blob([data as Uint8Array], { type: 'video/ogg' });
  } catch (err: any) {
    // If cancelled or failed, terminate FFmpeg instance and reset to null
    try {
      ffmpeg?.terminate();
    } catch {
      // ignore
    }
    ffmpegInstance = null;

    if (err.message === 'EXPORT_CANCELLED' || abortSignal?.aborted) {
      throw new Error('EXPORT_CANCELLED');
    }
    console.error('FFmpeg transcoding to .ogv failed:', err);
    throw new Error('OGV_CONVERSION_FAILED');
  } finally {
    if (abortListener && abortSignal) {
      abortSignal.removeEventListener('abort', abortListener);
    }
    if (ffmpeg && progressHandler) {
      try {
        ffmpeg.off('progress', progressHandler);
      } catch {
        // ignore
      }
    }
  }
}

const DEFAULT_AVATAR_IMAGE_URL = 'https://i.ibb.co/qMLtgW2g/faviconcv.png';
let cachedDefaultAvatarBlob: Blob | null = null;

async function getDefaultAvatarBlob(): Promise<Blob | null> {
  if (cachedDefaultAvatarBlob) return cachedDefaultAvatarBlob;
  try {
    const resp = await fetch(DEFAULT_AVATAR_IMAGE_URL);
    if (resp.ok) {
      cachedDefaultAvatarBlob = await resp.blob();
      return cachedDefaultAvatarBlob;
    }
  } catch (err) {
    console.warn('Failed to fetch default avatar blob from URL:', err);
  }
  return null;
}

// Helper to fetch blob or data URL into a Blob
async function getBlobFromUrlOrData(url?: string, existingBlob?: Blob): Promise<Blob | null> {
  if (existingBlob) return existingBlob;
  if (!url) return null;
  if (url.startsWith('data:image')) {
    try {
      const resp = await fetch(url);
      return await resp.blob();
    } catch {
      return null;
    }
  }
  if (url.startsWith('blob:') || url.startsWith('http')) {
    try {
      const resp = await fetch(url);
      return await resp.blob();
    } catch {
      return null;
    }
  }
  return null;
}

export async function exportModpackZip(
  packInfo: PackInfo,
  characters: Character[],
  clips: TimelineClip[],
  videoMedia?: MediaSource,
  backingTrackMedia?: MediaSource,
  onProgress?: (progress: ZipExportProgress) => void,
  abortSignal?: AbortSignal
): Promise<{ archive: Blob; ogvFailed: boolean }> {
  const checkAbort = () => {
    if (abortSignal?.aborted) {
      throw new Error('EXPORT_CANCELLED');
    }
  };

  const zip = new JSZip();
  let ogvFailed = false;

  // Ensure all current character names are included in preselectedDubCharacters
  const allCharacterNames = Array.from(
    new Set([
      ...(packInfo.preselectedDubCharacters || []),
      ...characters.map((c) => c.name).filter(Boolean),
    ])
  );

  const fullPackInfo: PackInfo = {
    ...packInfo,
    preselectedDubCharacters: allCharacterNames,
  };

  let maxOverallPercent = 0;
  const updateProgress = (status: string, percent: number) => {
    maxOverallPercent = Math.max(maxOverallPercent, Math.round(percent));
    onProgress?.({ status, percent: maxOverallPercent });
  };

  // 1. Add _pack_info.ini
  checkAbort();
  updateProgress('Generating pack info...', 5);
  const packIniContent = generatePackInfoIni(fullPackInfo);
  zip.file('_pack_info.ini', packIniContent);

  // 2. Add Main Video file (transcode MP4 to true OGV unless excluded)
  checkAbort();
  if (fullPackInfo.excludeVideo) {
    updateProgress('Skipping video file...', 80);
  } else {
    let rawVideoBlob: Blob | null = null;
    if (videoMedia?.file) {
      rawVideoBlob = videoMedia.file;
    } else if (videoMedia?.url) {
      try {
        const resp = await fetch(videoMedia.url);
        rawVideoBlob = await resp.blob();
      } catch {
        console.warn('Could not fetch video blob');
      }
    }

    if (rawVideoBlob) {
      updateProgress('Preparing video engine...', 10);
      try {
        const ogvBlob = await convertMp4ToOgv(
          rawVideoBlob,
          (p, statusMsg) => {
            checkAbort();
            const targetOverallPercent = 10 + ((p / 100) * 70);
            updateProgress(statusMsg || 'Converting MP4 to OGV...', targetOverallPercent);
          },
          abortSignal
        );
        checkAbort();
        const ext = ogvBlob.type === 'video/mp4' || ogvBlob.type.includes('mp4') ? 'mp4' : 'ogv';
        zip.file(`dub_video.${ext}`, ogvBlob);
      } catch (err: any) {
        if (err.message === 'EXPORT_CANCELLED' || abortSignal?.aborted) {
          throw new Error('EXPORT_CANCELLED');
        }
        console.warn('OGV conversion failed, skipping video export.');
        ogvFailed = true;
      }
    }
  }

  // 3. Add Backing Track if present
  checkAbort();
  if (backingTrackMedia?.file) {
    updateProgress('Adding backing track...', 82);
    const ext = backingTrackMedia.file.name.split('.').pop() || 'wav';
    zip.file(`_backing_track.${ext}`, backingTrackMedia.file);
  } else if (backingTrackMedia?.url) {
    updateProgress('Adding backing track...', 82);
    try {
      const resp = await fetch(backingTrackMedia.url);
      const blob = await resp.blob();
      zip.file('_backing_track.wav', blob);
    } catch {
      console.warn('Could not fetch backing track blob');
    }
  }

  // 4. Add Pack Icon & Filler images
  checkAbort();
  updateProgress('Adding pack images...', 84);
  const iconFilename = fullPackInfo.iconFilename || '_icon.png';
  const iconBlob = await getBlobFromUrlOrData(fullPackInfo.iconUrl, fullPackInfo.iconBlob);
  if (iconBlob) zip.file(iconFilename, iconBlob);

  const fillerFilename = fullPackInfo.fillerImageFilename || '_pack_filler_image.png';
  const fillerBlob = await getBlobFromUrlOrData(fullPackInfo.fillerImageUrl, fullPackInfo.fillerImageBlob);
  if (fillerBlob) zip.file(fillerFilename, fillerBlob);

  // 5. Add Character Avatars (ALL characters included, preserving original format for uploaded files, and providing valid PNG for default/dicebear)
  checkAbort();
  updateProgress('Adding character avatars...', 86);
  for (const char of characters) {
    checkAbort();
    if (char.autoScreenshot) {
      continue;
    }
    const safeName = char.name.toLowerCase().replace(/[^a-z0-9]+/g, '_');
    const isDicebearOrDefault = !char.avatarFile && (!char.avatarUrl || char.avatarUrl.includes('dicebear') || char.avatarUrl.includes('dicebear.com'));

    let charBlob: Blob | null = null;
    let ext = 'png';

    if (isDicebearOrDefault) {
      charBlob = await getDefaultAvatarBlob();
      ext = 'png';
    } else {
      charBlob = char.avatarFile ? char.avatarFile : await getBlobFromUrlOrData(char.avatarUrl);
      if (!charBlob) {
        charBlob = await getDefaultAvatarBlob();
        ext = 'png';
      } else {
        const filenameSource = char.originalFilename || char.avatarFilename || char.avatarFile?.name;
        if (filenameSource) {
          const parsedExt = filenameSource.split('.').pop()?.toLowerCase();
          if (parsedExt && parsedExt !== 'data') {
            ext = parsedExt === 'jpeg' ? 'jpg' : parsedExt;
          }
        } else if (charBlob?.type) {
          if (charBlob.type.includes('jpeg') || charBlob.type.includes('jpg')) ext = 'jpg';
          else if (charBlob.type.includes('webp')) ext = 'webp';
          else if (charBlob.type.includes('gif')) ext = 'gif';
          else if (charBlob.type.includes('png')) ext = 'png';
        }
      }
    }

    const filename = `${safeName}_avatar.${ext}`;
    if (charBlob) {
      zip.file(filename, charBlob);
    }
  }

  // 6. Add Voice Clips and metadata
  const totalClips = clips.length;
  const exportedClips: TimelineClip[] = [];
  for (let i = 0; i < totalClips; i++) {
    checkAbort();
    const clip = { ...clips[i] };
    const stepPercent = 88 + Math.floor((i / Math.max(1, totalClips)) * 5);

    // Dynamically auto-screenshot if the character's autoScreenshot is enabled
    const primaryChar = clip.dubCharacters[0];
    const charObj = characters.find((c) => c.name === primaryChar);
    if (charObj?.autoScreenshot) {
      try {
        const charClips = clips
          .filter(c => c.dubCharacters[0] === primaryChar)
          .sort((a, b) => a.startTime - b.startTime);
        const index = charClips.findIndex(c => c.id === clip.id);
        const count = index >= 0 ? index + 1 : 1;
        const cleanChar = primaryChar
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '_')
          .replace(/^_+|_+$/g, '');
        const finalImageFilename = `${cleanChar}_frame_${count}.png`;
        clip.imageFilename = finalImageFilename;

        updateProgress(`Capturing frame ${i + 1}/${totalClips}...`, stepPercent);

        const capturedUrl = await captureFrameAtTime(clip.startTime, videoMedia?.url);
        if (capturedUrl) {
          clip.imageUrl = capturedUrl;
        }
      } catch (err) {
        console.error('On-the-fly export capture failed:', err);
      }
    }

    const clipIndexStr = String(i + 1).padStart(2, '0');
    const firstCharName = clip.dubCharacters[0]?.toLowerCase().replace(/[^a-z0-9]+/g, '_') || 'clip';
    const clipBaseName = clip.filename || `${clipIndexStr}_${firstCharName}`;

    updateProgress(`Processing clip ${i + 1}/${totalClips}...`, stepPercent);

    // Generate clip INI
    const clipIni = generateClipIni({
      ...clip,
      filename: clipBaseName,
    }, fullPackInfo.disableDubTimestamps);
    zip.file(`${clipBaseName}.ini`, clipIni);

    // Generate sliced WAV audio file if video/audio buffer exists
    let clipAudioBlob: Blob | undefined = clip.audioBlob;

    if (!clipAudioBlob && videoMedia?.audioBuffer) {
      try {
        const slicedBuffer = sliceAudioBuffer(
          videoMedia.audioBuffer,
          clip.startTime,
          clip.endTime
        );
        clipAudioBlob = audioBufferToWavBlob(slicedBuffer);
      } catch (e) {
        console.error(`Error slicing audio for clip ${clipBaseName}:`, e);
      }
    } else if (!clipAudioBlob && backingTrackMedia?.audioBuffer) {
      try {
        const slicedBuffer = sliceAudioBuffer(
          backingTrackMedia.audioBuffer,
          clip.startTime,
          clip.endTime
        );
        clipAudioBlob = audioBufferToWavBlob(slicedBuffer);
      } catch (e) {
        console.error(`Error slicing backing track audio for clip ${clipBaseName}:`, e);
      }
    }

    if (clipAudioBlob) {
      zip.file(`${clipBaseName}.wav`, clipAudioBlob);
    }

    // Add clip image if custom
    if (clip.imageUrl && clip.imageFilename) {
      const clipImgBlob = await getBlobFromUrlOrData(clip.imageUrl);
      if (clipImgBlob) {
        zip.file(clip.imageFilename, clipImgBlob);
      }
    }

    exportedClips.push(clip);
  }

  // 7. Add Draft Project JSON (includes all characters and packInfo)
  checkAbort();
  if (!fullPackInfo.excludeDraftJson) {
    updateProgress('Adding project data...', 93);
    const cleanPackInfo = { ...fullPackInfo, iconBlob: undefined, fillerImageBlob: undefined };
    if (cleanPackInfo.iconUrl?.startsWith('blob:')) cleanPackInfo.iconUrl = undefined;
    if (cleanPackInfo.fillerImageUrl?.startsWith('blob:')) cleanPackInfo.fillerImageUrl = undefined;

    const cleanCharacters = characters.map((c) => {
      const safeName = c.name.toLowerCase().replace(/[^a-z0-9]+/g, '_');
      const isDicebearOrDefault = !c.avatarFile && (!c.avatarUrl || c.avatarUrl.includes('dicebear') || c.avatarUrl.includes('dicebear.com'));
      let ext = 'png';
      if (!isDicebearOrDefault) {
        const filenameSource = c.originalFilename || c.avatarFilename || c.avatarFile?.name;
        if (filenameSource) {
          const parsedExt = filenameSource.split('.').pop()?.toLowerCase();
          if (parsedExt && parsedExt !== 'data') {
            ext = parsedExt === 'jpeg' ? 'jpg' : parsedExt;
          }
        }
      }
      return {
        ...c,
        avatarFilename: `${safeName}_avatar.${ext}`,
        avatarUrl: c.avatarUrl?.startsWith('blob:') ? undefined : c.avatarUrl,
      };
    });

    const cleanClips = exportedClips.map((c) => ({
      ...c,
      audioBlob: undefined,
      imageUrl: c.imageUrl?.startsWith('blob:') ? undefined : c.imageUrl,
    }));

    const draftState = {
      packInfo: cleanPackInfo,
      characters: cleanCharacters,
      clips: cleanClips,
    };
    zip.file('_draft_project.json', JSON.stringify(draftState, null, 2));
  }

  // 8. ZIP compression
  checkAbort();
  updateProgress('Compressing archive...', 95);

  const zippedBlob = await zip.generateAsync({ type: 'blob' }, (metadata) => {
    checkAbort();
    updateProgress(`Compressing archive...`, 95 + ((metadata.percent / 100) * 5));
  });

  checkAbort();
  updateProgress('Export complete!', 100);
  return { archive: zippedBlob, ogvFailed };
}
