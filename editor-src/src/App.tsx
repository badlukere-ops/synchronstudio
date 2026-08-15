import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Header } from './components/Header';
import { UploadPanel } from './components/UploadPanel';
import { CharacterManager } from './components/CharacterManager';
import { VideoStage } from './components/VideoStage';
import { TimelineEditor } from './components/TimelineEditor';
import { ClipInspector } from './components/ClipInspector';
import { PackMetadataModal } from './components/PackMetadataModal';
import { GuidelinesModal } from './components/GuidelinesModal';
import { HomePage } from './components/HomePage';
import { Character, MediaSource, PackInfo, TimelineClip } from './types';
import {
  SAMPLE_CHARACTERS,
  SAMPLE_CLIPS,
  SAMPLE_PACK_INFO,
} from './utils/sampleData';
import {
  createSyntheticDemoAudioBuffer,
  decodeAudioFile,
  extractWaveformPeaks,
  playAudioSegment,
  sliceAudioBuffer,
} from './utils/audio';
import { getSmartFilenameForCharacter, reindexClipsByCharacter } from './utils/ini';
import { captureFrameAtTime, ZipExportProgress } from './utils/zipExporter';
import { exportSynchronstudioZip, slugifySceneId } from './utils/ssExport';
import { importDraftZip } from './utils/zipImporter';
import { 
  saveActiveProjectLocally, 
  getActiveProjectFromStorage, 
  deleteSavedProject,
  saveMediaFileToStorage,
  loadMediaFileFromStorage,
  SavedProject 
} from './utils/projectStorage';
import { X } from 'lucide-react';

export default function App() {
  // Navigation View State
  const [view, setView] = useState<'editor' | 'home'>('home');

  // Pack & Project State
  const [packInfo, setPackInfo] = useState<PackInfo>({
    title: 'New Scene',
    sceneId: 'newscene',
    iconFilename: '_icon.png',
    authors: ['Synchronstudio'],
    readme: 'Synchronstudio scene',
    preselectedDubCharacters: [],
  });
  const [characters, setCharacters] = useState<Character[]>([]);
  const [clips, setClips] = useState<TimelineClip[]>([]);
  const [selectedClipId, setSelectedClipId] = useState<string | undefined>();
  const [selectedClipIds, setSelectedClipIds] = useState<string[]>([]);

  const handleSelectClip = (
    clipId?: string,
    isMultiSelect = false,
    isShiftSelect = false,
    batchClipIds?: string[]
  ) => {
    if (batchClipIds !== undefined) {
      setSelectedClipIds(batchClipIds);
      setSelectedClipId(batchClipIds[0]);
      return;
    }
    if (!clipId) {
      setSelectedClipIds([]);
      setSelectedClipId(undefined);
      return;
    }

    if (isShiftSelect) {
      let currentSelected = [...selectedClipIds];
      if (selectedClipId && !currentSelected.includes(selectedClipId)) {
        currentSelected.push(selectedClipId);
      }
      if (currentSelected.includes(clipId)) {
        const updated = currentSelected.filter((id) => id !== clipId);
        setSelectedClipIds(updated);
        setSelectedClipId(updated[updated.length - 1]);
      } else {
        const updated = [...currentSelected, clipId];
        setSelectedClipIds(updated);
        setSelectedClipId(clipId);
      }
    } else {
      setSelectedClipIds([clipId]);
      setSelectedClipId(clipId);
    }
  };

  // Media Sources
  const [videoMedia, setVideoMedia] = useState<MediaSource | undefined>();
  const [backingTrackMedia, setBackingTrackMedia] = useState<MediaSource | undefined>();

  // Timeline / Playback State
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isMuted, setIsMuted] = useState(false);

  // Backing Track Solo preview toggle state
  const [isBackingTrackOnly, setIsBackingTrackOnly] = useState(false);

  const [projectId, setProjectId] = useState<string>(`project_${Date.now()}`);
  const [hasActiveProject, setHasActiveProject] = useState<boolean>(() => {
    return Boolean(getActiveProjectFromStorage());
  });

  // Auto-save project state locally whenever project details change
  useEffect(() => {
    if (view === 'home') return;
    saveActiveProjectLocally(
      projectId,
      packInfo,
      characters,
      clips,
      videoMedia?.name,
      backingTrackMedia?.name,
      videoMedia?.url,
      backingTrackMedia?.url
    );
    setHasActiveProject(true);
  }, [projectId, packInfo, characters, clips, videoMedia, backingTrackMedia, view]);

  const handleDeleteProject = (deletedId: string) => {
    deleteSavedProject(deletedId);
    if (deletedId === projectId || !getActiveProjectFromStorage()) {
      setProjectId(`project_${Date.now()}`);
      setPackInfo({
        title: 'New Scene',
        sceneId: 'newscene',
        iconFilename: '_icon.png',
        authors: ['Synchronstudio'],
        readme: 'Synchronstudio scene',
        preselectedDubCharacters: [],
      });
      setCharacters([]);
      setClips([]);
      setVideoMedia(undefined);
      setBackingTrackMedia(undefined);
      setCurrentTime(0);
      setDuration(0);
      setSelectedClipId(undefined);
      setHasActiveProject(false);
    }
  };

  const handleSelectRecentProject = async (project: SavedProject) => {
    if (project.id === projectId) {
      setView('editor');
      return;
    }

    setProjectId(project.id);
    setPackInfo(project.packInfo);
    setCharacters(project.characters || []);
    setClips(project.clips || []);
    setDuration(project.duration || 0);
    setHasActiveProject(true);
    
    // Check IndexedDB for persisted media
    const persistedVideo = await loadMediaFileFromStorage(project.id, 'video');
    const persistedBackingTrack = await loadMediaFileFromStorage(project.id, 'backingTrack');

    const missingFiles: string[] = [];
    
    if (project.videoMediaName && !persistedVideo) missingFiles.push(project.videoMediaName);
    if (project.backingTrackName && !persistedBackingTrack) missingFiles.push(project.backingTrackName);
    
    project.characters?.forEach(c => {
      const charName = c.originalFilename || c.avatarFilename;
      if (charName && !c.avatarUrl) {
        if (!missingFiles.includes(charName)) missingFiles.push(charName);
      }
    });
    
    if (project.packInfo) {
      const icon = project.packInfo.iconFilename || (project.packInfo as any).iconPath;
      if (icon && !project.packInfo.iconUrl && !project.packInfo.iconBlob && project.packInfo.hasCustomIcon) {
        const iconName = icon.split(/[/\\]/).pop();
        if (iconName && !missingFiles.includes(iconName)) missingFiles.push(iconName);
      }
      const filler = project.packInfo.fillerImageFilename || (project.packInfo as any).fillerImagePath;
      if (filler && !project.packInfo.fillerImageUrl && !project.packInfo.fillerImageBlob && project.packInfo.hasCustomFiller) {
        const fillerName = filler.split(/[/\\]/).pop();
        if (fillerName && !missingFiles.includes(fillerName)) missingFiles.push(fillerName);
      }
    }

    if (project.clips) {
      project.clips.forEach(clip => {
        const clipImg = clip.originalImageFilename || clip.imageFilename;
        if (
          clipImg &&
          clipImg !== 'default.png' &&
          !clipImg.endsWith('_avatar.png') &&
          !clip.imageUrl
        ) {
          if (!missingFiles.includes(clipImg)) {
            missingFiles.push(clipImg);
          }
        }
      });
    }
    
    if (missingFiles.length > 0) {
      setMissingFilesPrompt(missingFiles);
    }

    // Attempt to load from persisted IndexedDB blobs if they exist
    if (persistedVideo && (persistedVideo instanceof File || persistedVideo instanceof Blob)) {
      // If it lost its File type during IndexedDB serialization, wrap it
      const vFile = persistedVideo instanceof File 
        ? persistedVideo 
        : new File([persistedVideo], project.videoMediaName || 'dub_video.mp4', { type: persistedVideo.type || 'video/mp4' });
      // Re-trigger the processing to restore perfectly
      handleUploadVideo(vFile);
    } else if (project.videoMediaUrl || project.videoMediaName) {
      setVideoMedia({
        name: project.videoMediaName || 'dub_video.mp4',
        url: project.videoMediaUrl || '',
        duration: project.duration || 0,
      });
    } else {
      setVideoMedia(undefined);
    }

    if (persistedBackingTrack && (persistedBackingTrack instanceof File || persistedBackingTrack instanceof Blob)) {
      const bFile = persistedBackingTrack instanceof File 
        ? persistedBackingTrack 
        : new File([persistedBackingTrack], project.backingTrackName || '_backing_track.wav', { type: persistedBackingTrack.type || 'audio/wav' });
      handleUploadBackingTrack(bFile);
    } else if (project.backingTrackUrl || project.backingTrackName) {
      setBackingTrackMedia({
        name: project.backingTrackName || '_backing_track.wav',
        url: project.backingTrackUrl || '',
        duration: project.duration || 0,
      });
    } else {
      setBackingTrackMedia(undefined);
    }

    setCurrentTime(0);
    setSelectedClipId(project.clips?.[0]?.id);
    setView('editor');
  };

  const handleCreateNewProject = () => {
    handleResetBlank(false);
  };

  // Modals & Export Progress
  const [isMetadataOpen, setIsMetadataOpen] = useState(false);
  const [isGuidelinesOpen, setIsGuidelinesOpen] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState<ZipExportProgress | null>(null);
  const [missingFilesPrompt, setMissingFilesPrompt] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [loadingMessage, setLoadingMessage] = useState('Loading...');

  const [customModal, setCustomModal] = useState<{
    isOpen: boolean;
    title: string;
    message: React.ReactNode;
    type: 'alert' | 'confirm';
    onConfirm?: () => void;
  }>({
    isOpen: false,
    title: '',
    message: '',
    type: 'alert',
  });

  const showAlert = (message: React.ReactNode, title = 'Notice') => {
    setCustomModal({
      isOpen: true,
      title,
      message,
      type: 'alert',
    });
  };

  const showConfirm = (message: React.ReactNode, onConfirm: () => void, title = 'Confirm Action') => {
    setCustomModal({
      isOpen: true,
      title,
      message,
      type: 'confirm',
      onConfirm,
    });
  };

  // Audio Playback Ref for clip solo preview
  const activeAudioPlaybackRef = useRef<{ stop: () => void } | null>(null);
  const [isPlayingClipAudio, setIsPlayingClipAudio] = useState(false);

  // Set favicon dynamically
  useEffect(() => {
    const faviconUrl = "https://i.ibb.co/qMLtgW2g/faviconcv.png";
    let link = document.querySelector("link[rel~='icon']") as HTMLLinkElement;
    if (!link) {
      link = document.createElement("link");
      link.rel = "icon";
      document.head.appendChild(link);
    }
    link.type = "image/png";
    link.href = faviconUrl;

    let appleLink = document.querySelector("link[rel='apple-touch-icon']") as HTMLLinkElement;
    if (appleLink) {
      appleLink.href = faviconUrl;
    }
  }, []);

  // Playhead Clock tick during playback (Only if NO video is driving the time)
  useEffect(() => {
    if (!isPlaying || videoMedia?.url) return;

    let animationFrameId: number;
    let lastTime = performance.now();

    const updateClock = (now: number) => {
      const delta = (now - lastTime) / 1000;
      setCurrentTime((prev) => {
        const next = prev + delta;
        if (next >= duration) {
          setIsPlaying(false);
          return duration;
        }
        return next;
      });
      lastTime = now;
      animationFrameId = requestAnimationFrame(updateClock);
    };

    lastTime = performance.now();
    animationFrameId = requestAnimationFrame(updateClock);

    return () => {
      if (animationFrameId) cancelAnimationFrame(animationFrameId);
    };
  }, [isPlaying, duration, videoMedia?.url]);

  const handlePlayPause = () => {
    if (!isPlaying && duration > 0 && currentTime >= duration - 0.1) {
      setCurrentTime(0);
    }
    setIsPlaying((prev) => !prev);
  };

  // Keyboard Shortcuts (Space bar for play/pause, S for split)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target.isContentEditable
      ) {
        return; // Don't trigger shortcuts when typing in inputs
      }

      if (e.code === 'Space') {
        e.preventDefault();
        if (videoMedia) {
          handlePlayPause();
        }
      } else if (e.key === 's' || e.key === 'S') {
        e.preventDefault();
        if (videoMedia) {
          // Since handleSplitAtPlayhead is not memoized and depends on many things,
          // we'll trigger a custom event or just use a ref. 
          // Actually, we can dispatch a custom event.
          document.dispatchEvent(new CustomEvent('split-clip-shortcut'));
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isPlaying, duration, currentTime, videoMedia]);

  useEffect(() => {
    const handleKeyUp = (e: KeyboardEvent) => {
      // Removed aggressive Shift-release deselection that was causing issues while typing
    };
    window.addEventListener('keyup', handleKeyUp);
    return () => window.removeEventListener('keyup', handleKeyUp);
  }, []);

  useEffect(() => {
    const handleSplit = () => handleSplitAtPlayhead();
    document.addEventListener('split-clip-shortcut', handleSplit);
    return () => document.removeEventListener('split-clip-shortcut', handleSplit);
  }, [clips, currentTime]);

  useEffect(() => {
    const handleContext = (e: MouseEvent) => {
      // Allow context menu in inputs
      if (['INPUT', 'TEXTAREA'].includes((e.target as HTMLElement).tagName)) {
        return;
      }
      e.preventDefault();
    };
    document.addEventListener('contextmenu', handleContext);
    return () => document.removeEventListener('contextmenu', handleContext);
  }, []);

  // Find active clip at current playhead time
  const activeClip = clips.find(
    (c) => currentTime >= c.startTime && currentTime <= c.endTime
  );

  // Selected clip object
  const selectedClip = clips.find((c) => c.id === selectedClipId);

  // Upload Video File Handler
  const handleUploadVideo = async (file: File) => {
    setIsLoading(true);
    setLoadingMessage('Processing and decoding video file...');
    try {
      const ext = file.name.split('.').pop() || 'mp4';
      const renamedFile = new File([file], `dub_video.${ext}`, { type: file.type });
      const dataUrl = URL.createObjectURL(renamedFile);
      
      // Save media to IndexedDB for offline persistence across sessions
      saveMediaFileToStorage(projectId, 'video', renamedFile);

      try {
        const audioBuffer = await decodeAudioFile(renamedFile);
        const peaks = extractWaveformPeaks(audioBuffer, 1200);
        const fileDuration = audioBuffer.duration;

        setVideoMedia({
          type: 'video',
          file: renamedFile,
          url: dataUrl,
          name: renamedFile.name,
          duration: fileDuration,
          audioBuffer,
          waveformPeaks: peaks,
        });

        setDuration(Number(fileDuration.toFixed(3)));
      } catch {
        await new Promise<void>((resolve) => {
          const videoEl = document.createElement('video');
          videoEl.src = dataUrl;
          videoEl.onloadedmetadata = () => {
            const vidDur = videoEl.duration || 20;
            setVideoMedia({
              type: 'video',
              file: renamedFile,
              url: dataUrl,
              name: renamedFile.name,
              duration: vidDur,
            });
            setDuration(Number(vidDur.toFixed(3)));
            resolve();
          };
          videoEl.onerror = () => {
            setVideoMedia({
              type: 'video',
              file: renamedFile,
              url: dataUrl,
              name: renamedFile.name,
              duration: 20,
            });
            resolve();
          };
        });
      }
    } catch (err) {
      console.error(err);
    } finally {
      setIsLoading(false);
    }
  };

  // Upload Backing Track Handler
  const handleUploadBackingTrack = async (file: File) => {
    setIsLoading(true);
    setLoadingMessage('Processing and decoding backing track...');
    try {
      const dataUrl = URL.createObjectURL(file);
      
      // Save media to IndexedDB for offline persistence across sessions
      saveMediaFileToStorage(projectId, 'backingTrack', file);
      
      try {
        const audioBuffer = await decodeAudioFile(file);
        const fileDuration = audioBuffer.duration;

        setBackingTrackMedia({
          type: 'audio',
          file,
          url: dataUrl,
          name: file.name,
          duration: fileDuration,
          audioBuffer,
        });
      } catch {
        setBackingTrackMedia({
          type: 'audio',
          file,
          url: dataUrl,
          name: file.name,
          duration: 20,
        });
      }
    } catch (err) {
      console.error(err);
    } finally {
      setIsLoading(false);
    }
  };

  // Pack Icon & Filler Uploads
  const handleUploadPackIcon = async (file: File) => {
    setIsLoading(true);
    setLoadingMessage('Uploading modpack icon...');
    await new Promise((resolve) => setTimeout(resolve, 400));
    const ext = file.name.split('.').pop() || 'png';
    const cleanExt = ext.toLowerCase() === 'jpeg' ? 'jpg' : ext.toLowerCase();
    const standardName = `_icon.${cleanExt}`;
    setPackInfo((prev) => ({
      ...prev,
      iconFilename: standardName,
      iconUrl: URL.createObjectURL(file),
      iconBlob: file,
      hasCustomIcon: true,
    }));
    setIsLoading(false);
  };

  const handleUploadFillerImage = async (file: File) => {
    setIsLoading(true);
    setLoadingMessage('Uploading modpack filler image...');
    await new Promise((resolve) => setTimeout(resolve, 400));
    const ext = file.name.split('.').pop() || 'png';
    const cleanExt = ext.toLowerCase() === 'jpeg' ? 'jpg' : ext.toLowerCase();
    const standardName = `_pack_filler_image.${cleanExt}`;
    setPackInfo((prev) => ({
      ...prev,
      fillerImageFilename: standardName,
      fillerImageUrl: URL.createObjectURL(file),
      fillerImageBlob: file,
      hasCustomFiller: true,
    }));
    setIsLoading(false);
  };

  // Character Management
  const handleAddCharacter = (char: Character) => {
    setCharacters((prev) => [...prev, char]);
    if (packInfo.preselectedDubCharacters.length === 0) {
      setPackInfo((prev) => ({
        ...prev,
        preselectedDubCharacters: [char.name],
      }));
    }
  };

  const handleUpdateCharacter = (charId: string, updatedChar: Character, oldCharName: string) => {
    setCharacters((prev) =>
      prev.map((c) => (c.id === charId ? updatedChar : c))
    );

    const oldNameTrim = oldCharName.trim();
    const newNameTrim = updatedChar.name.trim();

    if (oldNameTrim !== newNameTrim) {
      setPackInfo((prev) => ({
        ...prev,
        preselectedDubCharacters: prev.preselectedDubCharacters.map((n) =>
          n === oldNameTrim ? newNameTrim : n
        ),
      }));

      const oldClean = oldNameTrim.toLowerCase().replace(/[^a-z0-9]+/g, '_');
      const newClean = newNameTrim.toLowerCase().replace(/[^a-z0-9]+/g, '_');

      setClips((prevClips) =>
        prevClips.map((c) => {
          if (!c.dubCharacters.includes(oldNameTrim)) return c;

          const updatedDubChars = c.dubCharacters.map((n) =>
            n === oldNameTrim ? newNameTrim : n
          );

          const primaryChar = updatedDubChars[0];
          const newFilename = primaryChar
            ? getSmartFilenameForCharacter(primaryChar, prevClips, c.id)
            : c.filename;

          let newImgFilename = c.imageFilename;
          if (c.imageFilename) {
            if (
              c.imageFilename === `${oldClean}.png` ||
              c.imageFilename === `${oldClean}_avatar.png` ||
              c.imageFilename.includes(oldClean)
            ) {
              const oldExt = c.imageFilename.split('.').pop() || 'png';
              newImgFilename = `${newClean}.${oldExt}`;
            }
          } else {
            newImgFilename = `${newClean}.png`;
          }

          return {
            ...c,
            dubCharacters: updatedDubChars,
            filename: newFilename,
            imageFilename: newImgFilename,
          };
        })
      );
    } else {
      const cleanName = newNameTrim.toLowerCase().replace(/[^a-z0-9]+/g, '_');
      setClips((prevClips) =>
        prevClips.map((c) => {
          if (c.dubCharacters.includes(newNameTrim)) {
            let newImgFilename = c.imageFilename || `${cleanName}.png`;
            if (updatedChar.avatarFilename) {
              newImgFilename = updatedChar.avatarFilename;
            }
            return { ...c, imageFilename: newImgFilename };
          }
          return c;
        })
      );
    }
  };

  const handleRemoveCharacter = (id: string) => {
    const char = characters.find((c) => c.id === id);
    if (!char) return;
    setCharacters((prev) => prev.filter((c) => c.id !== id));
    setPackInfo((prev) => ({
      ...prev,
      preselectedDubCharacters: prev.preselectedDubCharacters.filter((n) => n !== char.name),
    }));
  };

  const handleTogglePreselected = (charName: string) => {
    setPackInfo((prev) => {
      const isSelected = prev.preselectedDubCharacters.includes(charName);
      return {
        ...prev,
        preselectedDubCharacters: isSelected
          ? prev.preselectedDubCharacters.filter((c) => c !== charName)
          : [...prev.preselectedDubCharacters, charName],
      };
    });
  };

  const handleAssignToActiveClip = (charName: string) => {
    if (!selectedClipId) return;
    setClips((prev) =>
      prev.map((c) => {
        if (c.id === selectedClipId) {
          const isAssigned = c.dubCharacters.includes(charName);
          const updatedChars = isAssigned
            ? c.dubCharacters.filter((n) => n !== charName)
            : [...c.dubCharacters, charName];
            
          let updatedFilename = c.filename;
          const primaryChar = updatedChars[0];
          if (primaryChar) {
            updatedFilename = getSmartFilenameForCharacter(primaryChar, prev, c.id);
          }
          
          return {
            ...c,
            dubCharacters: updatedChars,
            filename: updatedFilename,
          };
        }
        return c;
      })
    );
  };

  // Clip Operations
  const handleUpdateClip = useCallback(
    (clipId: string, updates: Partial<TimelineClip>) => {
      setClips((prev) =>
        prev.map((clip) => (clip.id === clipId ? { ...clip, ...updates } : clip))
      );
    },
    []
  );

  const captureFrameAtTimeLocal = (time: number): Promise<string> => {
    return captureFrameAtTime(time, videoMedia?.url);
  };

  // Effect to automatically sync auto-screenshot filenames and capture frames
  useEffect(() => {
    const autoScreenshotChars = new Set(
      characters.filter((c) => c.autoScreenshot).map((c) => c.name)
    );

    // 1. Synchronously check and align the filenames
    let needsFilenameUpdate = false;
    const alignedClips = clips.map((clip) => {
      const primaryChar = clip.dubCharacters[0];
      if (primaryChar && autoScreenshotChars.has(primaryChar)) {
        const charClips = clips
          .filter((c) => c.dubCharacters[0] === primaryChar)
          .sort((a, b) => a.startTime - b.startTime);
        const index = charClips.findIndex((c) => c.id === clip.id);
        const count = index >= 0 ? index + 1 : 1;
        const cleanChar = primaryChar
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '_')
          .replace(/^_+|_+$/g, '');
        const expectedFilename = `${cleanChar}_frame_${count}.png`;

        if (clip.imageFilename !== expectedFilename) {
          needsFilenameUpdate = true;
          return { ...clip, imageFilename: expectedFilename };
        }
      }
      return clip;
    });

    if (needsFilenameUpdate) {
      setClips(alignedClips);
      return;
    }

    // 2. Asynchronously check if any clip needs a frame capture
    const clipsToCapture = clips.filter((clip) => {
      const primaryChar = clip.dubCharacters[0];
      const charObj = characters.find((c) => c.name === primaryChar);
      if (!charObj?.autoScreenshot) return false;

      const needsCapture =
        !clip.imageUrl ||
        !clip.imageUrl.startsWith('data:image/') ||
        clip.capturedAtTime === undefined ||
        Math.abs(clip.capturedAtTime - clip.startTime) > 0.05;

      return needsCapture;
    });

    if (clipsToCapture.length > 0) {
      const runCaptures = async () => {
        const clipToCapture = clipsToCapture[0];
        try {
          const imgUrl = await captureFrameAtTimeLocal(clipToCapture.startTime);
          if (imgUrl) {
            setClips((prev) =>
              prev.map((c) =>
                c.id === clipToCapture.id
                  ? { ...c, imageUrl: imgUrl, capturedAtTime: clipToCapture.startTime }
                  : c
              )
            );
          }
        } catch (e) {
          console.error('Auto-capture error:', e);
        }
      };
      runCaptures();
    }
  }, [clips, characters]);

  const handleClipDragEnd = (clipId: string) => {
    // Handled automatically by the sync effect!
  };

  const handleDeleteClip = (clipId: string) => {
    handleDeleteClips([clipId]);
  };

  const handleDeleteClips = (clipIds: string[]) => {
    setClips((prev) => reindexClipsByCharacter(prev.filter((c) => !clipIds.includes(c.id)), characters));
    if (selectedClipId && clipIds.includes(selectedClipId)) {
      setSelectedClipId(undefined);
    }
    setSelectedClipIds((prev) => prev.filter((id) => !clipIds.includes(id)));
  };

  const handleAddClipAtPlayhead = () => {
    if (!videoMedia) return;
    const defaultChar = packInfo.preselectedDubCharacters[0] || characters[0]?.name || 'person1';
    const newFilename = getSmartFilenameForCharacter(defaultChar, clips);
    const charObj = characters.find((c) => c.name === defaultChar);
    const autoImage = charObj
      ? (charObj.avatarFilename || `${charObj.name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}_avatar.png`)
      : 'default.png';

    let targetStart = Number(currentTime.toFixed(3));
    let targetEnd = Number(Math.min(duration, targetStart + 3.0).toFixed(3));

    // Ensure target clip cannot extend past timeline and has minimum 0.5s duration
    if (targetEnd - targetStart < 0.5) {
      targetEnd = duration;
      targetStart = Math.max(0, Number((duration - 0.5).toFixed(3)));
    }

    
    let splitImageUrl = undefined;
    if (charObj?.autoScreenshot) {
      const videoEl = document.getElementById('main-video-player') as HTMLVideoElement;
      if (videoEl) {
        try {
          const canvas = document.createElement('canvas');
          canvas.width = videoEl.videoWidth;
          canvas.height = videoEl.videoHeight;
          const ctx = canvas.getContext('2d');
          if (ctx) {
            ctx.drawImage(videoEl, 0, 0);
            splitImageUrl = canvas.toDataURL('image/jpeg', 0.8);
          }
        } catch (e) {
          console.warn('Could not capture frame', e);
        }
      }
    }

    const newClip: TimelineClip = {
      id: `clip_${Date.now()}`,
      filename: newFilename,
      startTime: targetStart,
      endTime: targetEnd,
      dubTimestamps: [targetStart],
      dubCharacters: [defaultChar],
      caption: '“New voice line clip caption”',
      imageFilename: autoImage,
      ...(splitImageUrl ? { imageUrl: splitImageUrl } : {}),
      volume: 1,
    };

    setClips((prev) => reindexClipsByCharacter([...prev, newClip], characters));
    setSelectedClipId(newClip.id);
  };

  const handleExportDraft = () => {
    const cleanTitle = packInfo.title ? packInfo.title.toLowerCase().replace(/[^a-z0-9]+/g, '_') : 'modpack_draft';
    const draftData = {
      format: 'Synchronstudio Scene Editor Draft',
      version: '1.0',
      app: 'Synchronstudio Scene Editor',
      packInfo: {
        title: packInfo.title || 'Untitled Dub Modpack',
        iconFilename: packInfo.iconFilename || '_icon.png',
        iconPath: packInfo.iconFile?.name || packInfo.iconFilename || '_icon.png',
        authors: packInfo.authors,
        readme: packInfo.readme,
        preselectedDubCharacters: packInfo.preselectedDubCharacters,
        fillerImageFilename: packInfo.fillerImageFilename || '_pack_filler_image.png',
        fillerImagePath: packInfo.fillerImageFile?.name || packInfo.fillerImageFilename || '_pack_filler_image.png',
        disableDubTimestamps: packInfo.disableDubTimestamps,
        captionOffset: packInfo.captionOffset,
      },
      videoPath: videoMedia?.file?.name || videoMedia?.name || 'dub_video.mp4',
      videoMediaName: videoMedia?.name || 'dub_video.mp4',
      backingTrackPath: backingTrackMedia?.file?.name || backingTrackMedia?.name || '_backing_track.wav',
      backingTrackName: backingTrackMedia?.name || '_backing_track.wav',
      characters: characters.map(({ avatarUrl, ...c }) => {
        // Strip out any avatarPath from old drafts to prevent C:/ paths
        const { avatarPath: _oldAvatarPath, ...charData } = c as any;
        return {
          ...charData,
          avatarPath: c.avatarFile?.name || c.originalFilename || c.avatarFilename || `${c.name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}_avatar.png`,
        };
      }),
      clips: clips.map(({ imageUrl, audioBlob, ...c }) => {
        const { audioPath: _ap, imagePath: _ip, ...clipData } = c as any;
        return clipData;
      }),
      duration,
      updatedAt: Date.now(),
    };

    const jsonStr = JSON.stringify(draftData, null, 2);
    const blob = new Blob([jsonStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${cleanTitle}.cvmmd`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleDuplicateClip = (clipId: string) => {
    if (!videoMedia) return;
    const sourceClip = clips.find((c) => c.id === clipId);
    if (!sourceClip) return;

    const clipDuration = sourceClip.endTime - sourceClip.startTime;
    let newStart = Number(sourceClip.endTime.toFixed(3));
    if (newStart >= duration) {
      newStart = Math.max(0, Number((duration - clipDuration).toFixed(3)));
    }
    const newEnd = Number(Math.min(duration, newStart + clipDuration).toFixed(3));
    const firstChar = sourceClip.dubCharacters[0] || characters[0]?.name || 'person1';
    const newFilename = getSmartFilenameForCharacter(firstChar, clips);

    const dupClip: TimelineClip = {
      ...sourceClip,
      id: `clip_${Date.now()}`,
      filename: newFilename,
      startTime: newStart,
      endTime: newEnd,
      dubTimestamps: [Number((newStart + 0.1).toFixed(3))],
    };

    setClips((prev) => reindexClipsByCharacter([...prev, dupClip], characters));
    setSelectedClipId(dupClip.id);
  };

  const handleSplitAtPlayhead = () => {
    if (!videoMedia) return;
    const clipToSplit = clips.find(
      (c) => currentTime > c.startTime + 0.5 && currentTime < c.endTime - 0.5
    );

    if (!clipToSplit) {
      return;
    }

    const splitPoint = Number(currentTime.toFixed(3));
    const firstChar = clipToSplit.dubCharacters[0] || characters[0]?.name || 'person1';
    const rightFilename = getSmartFilenameForCharacter(firstChar, clips, clipToSplit.id);
    const charObj = characters.find((c) => c.name === firstChar);

    let splitImageFilename = clipToSplit.imageFilename;
    let splitImageUrl = clipToSplit.imageUrl;

    if (charObj?.autoScreenshot) {
      const videoEl = document.getElementById('main-video-player') as HTMLVideoElement;
      if (videoEl) {
        try {
          const canvas = document.createElement('canvas');
          canvas.width = videoEl.videoWidth;
          canvas.height = videoEl.videoHeight;
          const ctx = canvas.getContext('2d');
          if (ctx) {
            ctx.drawImage(videoEl, 0, 0);
            splitImageUrl = canvas.toDataURL('image/jpeg', 0.8);
            // The imageFilename will be automatically updated by reindexClipsByCharacter
          }
        } catch (e) {
          console.warn('Could not capture frame', e);
        }
      }
    }

    // Left clip segment
    const leftClip: TimelineClip = {
      ...clipToSplit,
      endTime: splitPoint,
    };

    // Right clip segment
    const rightClip: TimelineClip = {
      ...clipToSplit,
      id: `clip_${Date.now()}`,
      filename: rightFilename,
      startTime: splitPoint,
      dubTimestamps: [Number((splitPoint + 0.1).toFixed(3))],
      imageFilename: splitImageFilename,
      imageUrl: splitImageUrl,
    };

    setClips((prev) =>
      reindexClipsByCharacter(
        prev.map((c) => (c.id === clipToSplit.id ? leftClip : c)).concat(rightClip),
        characters
      )
    );
    setSelectedClipId(rightClip.id);
  };

  // Auto Split Silence / Audio Diff algorithm
  const handleAutoSplitSilence = () => {
    const videoBuffer = videoMedia?.audioBuffer;
    const backingBuffer = backingTrackMedia?.audioBuffer;

    if (!videoBuffer) {
      showAlert('Please upload a Main Video first to detect voice clips.', 'Missing Video');
      return;
    }

    const videoData = videoBuffer.getChannelData(0);
    const backingData = backingBuffer ? backingBuffer.getChannelData(0) : null;
    const sampleRate = videoBuffer.sampleRate;
    const minSilenceDuration = 0.4;

    const newClips: TimelineClip[] = [];
    let isSpeaking = false;
    let speakStart = 0;
    let clipCounter = clips.length + 1;

    for (let i = 0; i < videoData.length; i += 2048) {
      const vSample = Math.abs(videoData[i]);
      const bSample = backingData && i < backingData.length ? Math.abs(backingData[i]) : 0;
      const timeSec = i / sampleRate;
      
      // Calculate diff if backing track exists, otherwise just use video amplitude threshold
      const diffAmplitude = backingData ? Math.max(0, vSample - bSample * 1.5) : vSample;
      const threshold = backingData ? 0.08 : 0.05;

      if (diffAmplitude > threshold && !isSpeaking) {
        isSpeaking = true;
        speakStart = timeSec;
      } else if (diffAmplitude <= threshold && isSpeaking) {
        const speechDuration = timeSec - speakStart;
        if (speechDuration >= minSilenceDuration) {
          const charName = characters.length > 0 ? characters[(clipCounter - 1) % characters.length]?.name : 'Voice';
          const currentAllClips = [...clips, ...newClips];
          const autoFilename = getSmartFilenameForCharacter(charName, currentAllClips);
          const cleanChar = charName.toLowerCase().replace(/[^a-z0-9]+/g, '_');
          newClips.push({
            id: `clip_auto_${clipCounter}_${Date.now()}`,
            filename: autoFilename,
            startTime: Number(speakStart.toFixed(3)),
            endTime: Number(timeSec.toFixed(3)),
            dubTimestamps: [Number((speakStart + 0.1).toFixed(3))],
            dubCharacters: [charName],
            caption: `“Auto-detected voice segment #${clipCounter}”`,
            imageFilename: `${cleanChar}.png`,
            volume: 1,
          });
          clipCounter++;
        }
        isSpeaking = false;
      }
    }

    if (newClips.length > 0) {
      setClips((prev) => [...prev, ...newClips]);
      setSelectedClipId(newClips[0].id);
      showAlert(`Auto-detected ${newClips.length} new voice clips!`, 'Auto-Split Success');
    } else {
      showAlert('No significant voice gaps detected. Try adjusting audio levels or upload a cleaner backing track.', 'Auto-Split Notice');
    }
  };

  // Preview Sliced Clip Audio
  const handlePlayClipAudio = (clip: TimelineClip) => {
    if (activeAudioPlaybackRef.current) {
      activeAudioPlaybackRef.current.stop();
    }

    const audioBuffer = videoMedia?.audioBuffer || backingTrackMedia?.audioBuffer;
    if (!audioBuffer) return;

    try {
      const durationSec = clip.endTime - clip.startTime;
      const sliced = sliceAudioBuffer(audioBuffer, clip.startTime, clip.endTime);
      setIsPlayingClipAudio(true);

      const playback = playAudioSegment(sliced, 0, durationSec, () => {
        setIsPlayingClipAudio(false);
      });

      activeAudioPlaybackRef.current = playback;
    } catch (e) {
      console.error('Error playing clip audio segment:', e);
      setIsPlayingClipAudio(false);
    }
  };

  const handleStopClipAudio = () => {
    if (activeAudioPlaybackRef.current) {
      activeAudioPlaybackRef.current.stop();
      activeAudioPlaybackRef.current = null;
    }
    setIsPlayingClipAudio(false);
  };

  // Blank Project Reset
  const handleResetBlank = (confirm = true) => {
    const executeReset = () => {
      setProjectId(`project_${Date.now()}`);
      setPackInfo({
        title: 'New Scene',
        sceneId: 'newscene',
        iconFilename: '_icon.png',
        iconUrl: undefined,
        iconBlob: undefined,
        fillerImageFilename: '_pack_filler_image.png',
        fillerImageUrl: undefined,
        fillerImageBlob: undefined,
        authors: ['Synchronstudio'],
        readme: 'Synchronstudio scene',
        preselectedDubCharacters: [],
      });
      setCharacters([]);
      setClips([]);
      setSelectedClipId(undefined);
      setVideoMedia(undefined);
      setBackingTrackMedia(undefined);
      setCurrentTime(0);
      setDuration(0);
      setHasActiveProject(true);
      setView('editor');
    };

    if (!confirm) {
      executeReset();
    } else {
      showConfirm('Start a new blank project? Unsaved changes will be cleared.', executeReset, 'New Project');
    }
  };

  // Import Draft Project
  const handleImportDraft = async (file: File) => {
    setIsLoading(true);
    setLoadingMessage('Importing project draft...');
    try {
      const draft = await importDraftZip(file);
      setProjectId(`project_${Date.now()}`);
      setPackInfo(draft.packInfo);
      setCharacters(draft.characters);
      setClips(draft.clips);
      
      // Load video if exists
      if (draft.videoMedia?.file) {
        handleUploadVideo(draft.videoMedia.file);
      } else if (draft.videoMedia) {
        setVideoMedia(draft.videoMedia);
        setDuration(draft.videoMedia.duration || 0);
      } else {
        setVideoMedia(undefined);
        setDuration(0);
      }

      // Load backing track if exists
      if (draft.backingTrackMedia?.file) {
        handleUploadBackingTrack(draft.backingTrackMedia.file);
      } else if (draft.backingTrackMedia) {
        setBackingTrackMedia(draft.backingTrackMedia);
      } else {
        setBackingTrackMedia(undefined);
      }

      setSelectedClipId(undefined);
      setCurrentTime(0);

      if (draft.missingFiles && draft.missingFiles.length > 0) {
        setMissingFilesPrompt(draft.missingFiles);
      }
      setView('editor');
    } catch (err: any) {
      console.error(err);
      showAlert(err.message || 'Failed to import draft.', 'Import Error');
    } finally {
      setIsLoading(false);
    }
  };

  const exportAbortControllerRef = useRef<AbortController | null>(null);

  const handleCancelExport = () => {
    if (exportAbortControllerRef.current) {
      exportAbortControllerRef.current.abort();
    }
    setIsExporting(false);
    setExportProgress(null);
  };

  // Export Modpack ZIP Archive
  const handleExportZip = async () => {
    setIsExporting(true);
    setExportProgress({ status: 'Starting export...', percent: 0 });
    const controller = new AbortController();
    exportAbortControllerRef.current = controller;

    try {
      const { archive: zippedBlob, videoFailed } = await exportSynchronstudioZip(
        packInfo,
        characters,
        clips,
        videoMedia,
        backingTrackMedia,
        (progress) => setExportProgress(progress),
        controller.signal
      );

      // Trigger file download
      const cleanTitle = slugifySceneId(packInfo.sceneId || packInfo.title || 'scene');
      const downloadFilename = `${cleanTitle}_synchronstudio.zip`;

      const downloadUrl = URL.createObjectURL(zippedBlob);
      const a = document.createElement('a');
      a.href = downloadUrl;
      a.download = downloadFilename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(downloadUrl);

      if (videoFailed) {
        showAlert(
          <div>
            Video could not be fully muxed in the browser. The ZIP still has your source video / backing track — merge them with ffmpeg or ask for help before adding to the game.
          </div>,
          'Video note'
        );
      }
    } catch (err: any) {
      if (err?.message === 'EXPORT_CANCELLED' || controller.signal.aborted) {
        console.log('Modpack export cancelled by user.');
      } else {
        console.error('Failed to export ZIP archive:', err);
        showAlert('Failed to generate ZIP archive. Please check console for details.', 'Export Error');
      }
    } finally {
      setIsExporting(false);
      setExportProgress(null);
      exportAbortControllerRef.current = null;
    }
  };

  return (
    <div className="flex flex-col h-screen bg-zinc-950 text-zinc-100 font-sans overflow-hidden selection:bg-amber-500/30 selection:text-amber-100">
      {/* Mobile/Tablet Warning Overlay */}
      <div className="lg:hidden fixed inset-0 z-[9999] bg-zinc-950/95 backdrop-blur-sm flex items-center justify-center p-6 text-center">
        <div className="max-w-sm p-6 bg-zinc-900 border border-zinc-800 rounded-xl shadow-2xl">
          <div className="w-12 h-12 bg-amber-500/10 rounded-full flex items-center justify-center mx-auto mb-4">
            <X className="w-6 h-6 text-amber-500" />
          </div>
          <h2 className="text-xl font-bold text-zinc-100 mb-2">Screen Too Small</h2>
          <p className="text-zinc-400 text-sm">
            You need a larger device or compatible screen size for the Synchronstudio scene editor. Use a desktop display.
          </p>
        </div>
      </div>

      {/* Header Bar */}
      <Header
        packInfo={packInfo}
        view={view}
        onGoHome={() => setView(view === 'home' ? 'editor' : 'home')}
        onUpdatePackInfo={(info) => setPackInfo((prev) => ({ ...prev, ...info }))}
        onOpenMetadata={() => setIsMetadataOpen(true)}
        onOpenGuidelines={() => setIsGuidelinesOpen(true)}
        onExportZip={handleExportZip}
        onExportDraft={handleExportDraft}
        onImportDraft={handleImportDraft}
        onReset={() => handleResetBlank(true)}
        isExporting={isExporting}
        hasVideo={!!videoMedia}
      />

      {view === 'home' ? (
        <div className="flex-1 overflow-y-auto">
          <HomePage
            currentActiveProject={
              hasActiveProject
                ? {
                    id: projectId,
                    title: packInfo.title,
                    updatedAt: Date.now(),
                    packInfo,
                    characters,
                    clips,
                  }
                : null
            }
            onOpenProject={handleSelectRecentProject}
            onCreateNewProject={handleCreateNewProject}
            onDeleteProject={handleDeleteProject}
            onImportZip={(file) => {
              handleImportDraft(file);
              setView('editor');
            }}
          />
        </div>
      ) : (
        /* Main Workspace Layout (3-Column Grid) */
        <div className="flex-1 grid grid-cols-1 lg:grid-cols-12 gap-3 p-3 min-h-0">
          {/* Left Panel: Media Assets & Character Manager (3 cols) */}
          <div className="lg:col-span-3 flex flex-col gap-3 h-full overflow-hidden min-h-0 pr-1">
            <UploadPanel
              videoMedia={videoMedia}
              backingTrackMedia={backingTrackMedia}
              packInfo={packInfo}
              onUploadVideo={handleUploadVideo}
              onUploadBackingTrack={handleUploadBackingTrack}
              onUploadPackIcon={handleUploadPackIcon}
              onUploadFillerImage={handleUploadFillerImage}
              onRemoveVideo={() => {
                setVideoMedia(undefined);
                setSelectedClipId(undefined);
                setSelectedClipIds([]);
                setDuration(0);
                setCurrentTime(0);
              }}
              onRemoveBackingTrack={() => setBackingTrackMedia(undefined)}
              onRemovePackIcon={() =>
                setPackInfo((prev) => ({
                  ...prev,
                  iconUrl: undefined,
                  iconBlob: undefined,
                }))
              }
              onRemoveFillerImage={() =>
                setPackInfo((prev) => ({
                  ...prev,
                  fillerImageUrl: undefined,
                  fillerImageBlob: undefined,
                }))
              }
            />

            <CharacterManager
              characters={characters}
              preselectedCharacters={packInfo.preselectedDubCharacters}
              activeClipCharacters={selectedClip?.dubCharacters}
              onAddCharacter={handleAddCharacter}
              onUpdateCharacter={handleUpdateCharacter}
              onRemoveCharacter={handleRemoveCharacter}
              onTogglePreselected={handleTogglePreselected}
              onAssignToActiveClip={selectedClipIds.length === 1 ? handleAssignToActiveClip : undefined}
              setIsLoading={setIsLoading}
              setLoadingMessage={setLoadingMessage}
            />
          </div>

          {/* Center Panel: Video Stage Preview & Timeline (6 cols) */}
          <div className="lg:col-span-6 flex flex-col gap-3 h-full overflow-hidden">
            <div className="flex-none bg-[#0a0a0b] border border-zinc-800 rounded-xl overflow-hidden shadow-sm flex flex-col">
              <VideoStage
                videoUrl={videoMedia?.url}
                backingTrackUrl={backingTrackMedia?.url}
                currentTime={currentTime}
                duration={duration}
                isPlaying={isPlaying}
                activeClip={activeClip}
                characters={characters}
                onPlayPause={handlePlayPause}
                onSeek={setCurrentTime}
                isMuted={isMuted}
                onToggleMute={() => setIsMuted((prev) => !prev)}
                isBackingTrackOnly={isBackingTrackOnly}
                onToggleBackingTrackOnly={() => setIsBackingTrackOnly((prev) => !prev)}
                captionOffset={packInfo.captionOffset}
                captionAlign={packInfo.captionAlign}
                onCaptionOffsetChange={(offset, align) => {
                  setPackInfo(prev => ({ ...prev, captionOffset: offset, captionAlign: align }));
                }}
              />
            </div>

            <div className="flex-1 min-h-0 flex flex-col">
              <TimelineEditor
                duration={duration}
                currentTime={currentTime}
                clips={clips}
                selectedClipId={selectedClipId}
                selectedClipIds={selectedClipIds}
                characters={characters}
                waveformPeaks={videoMedia?.waveformPeaks}
                disableDubTimestamps={packInfo.disableDubTimestamps || false}
                onSeek={setCurrentTime}
                onSelectClip={handleSelectClip}
                onUpdateClip={handleUpdateClip}
                onSplitAtPlayhead={handleSplitAtPlayhead}
                onDeleteClip={handleDeleteClip}
                onDuplicateClip={handleDuplicateClip}
                onAddClipAtPlayhead={handleAddClipAtPlayhead}
                onAutoSplitSilence={handleAutoSplitSilence}
                onClipDragEnd={handleClipDragEnd}
                hasVideo={!!videoMedia}
                isPlaying={isPlaying}
              />
            </div>
          </div>

          {/* Right Panel: Selected Clip Inspector (3 cols) */}
          <div className="lg:col-span-3 flex flex-col h-full overflow-hidden min-h-0">
            <ClipInspector
              selectedClip={selectedClip}
              selectedClipIds={selectedClipIds}
              characters={characters}
              allClips={clips}
              currentTime={currentTime}
              hasVideo={!!videoMedia}
              disableDubTimestamps={packInfo.disableDubTimestamps || false}
              onToggleDisableDubTimestamps={() =>
                setPackInfo((prev) => ({
                  ...prev,
                  disableDubTimestamps: !prev.disableDubTimestamps,
                }))
              }
              onUpdateClip={handleUpdateClip}
              onDeleteClip={handleDeleteClip}
              onDeleteClips={handleDeleteClips}
              onPlayClipAudio={handlePlayClipAudio}
              isPlayingClipAudio={isPlayingClipAudio}
              onStopClipAudio={handleStopClipAudio}
              onSplitAtPlayhead={handleSplitAtPlayhead}
              onAddClipAtPlayhead={handleAddClipAtPlayhead}
            />
          </div>
        </div>
      )}

      {/* Modals */}
      <PackMetadataModal
        isOpen={isMetadataOpen}
        packInfo={packInfo}
        characters={characters}
        onClose={() => setIsMetadataOpen(false)}
        onSave={(updated) => setPackInfo(updated)}
      />

      <GuidelinesModal
        isOpen={isGuidelinesOpen}
        onClose={() => setIsGuidelinesOpen(false)}
      />

      {missingFilesPrompt.length > 0 && (
        <div className="fixed inset-0 z-[60] bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-zinc-900 border border-amber-900/50 rounded-xl p-6 max-w-md w-full shadow-2xl space-y-4 relative overflow-hidden">
            <h3 className="text-lg font-bold text-amber-400">Upload Project Files</h3>
            <p className="text-sm text-zinc-300">
              Please upload the media files used in this project to continue. Web browsers cannot read files from your computer automatically for security reasons.
            </p>
            <p className="text-sm text-zinc-300 font-bold">
              Please upload these files here:
            </p>
            <div className="bg-zinc-950 border border-zinc-800 rounded-lg p-3 max-h-[250px] overflow-y-auto">
              <ul className="space-y-2">
                {missingFilesPrompt.map((f, i) => {
                  const isVideo = f.endsWith('.mp4') || f.endsWith('.ogv') || f.endsWith('.webm') || f.endsWith('.mov') || f.toLowerCase().includes('video');
                  const isAudio = f.endsWith('.wav') || f.endsWith('.mp3') || f.endsWith('.ogg') || f.toLowerCase().includes('track') || f.toLowerCase().includes('bgm');
                  
                  // Display names mapped cleanly
                  let displayName = f;
                  if (f === 'dub_video.ogv' || (isVideo && f.startsWith('dub_video'))) {
                    displayName = 'dub_video.mp4 (Main Video)';
                  } else if (f === '_backing_track.wav' || (isAudio && f.startsWith('_backing_track'))) {
                    displayName = '_backing_track.wav (Backing Track)';
                  }

                  // Strict, workable accept criteria
                  let acceptTypes = '';
                  let requiredLabel = '';
                  if (isVideo) {
                    acceptTypes = 'video/mp4';
                    requiredLabel = 'video/mp4 file only';
                  } else if (isAudio) {
                    acceptTypes = '.wav,.mp3,.ogg,audio/wav,audio/mpeg,audio/ogg';
                    requiredLabel = '.wav, .mp3, or .ogg audio';
                  } else {
                    acceptTypes = '.png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp';
                    requiredLabel = '.png, .jpg, or .webp image';
                  }

                  return (
                    <li key={i} className="flex items-center justify-between gap-3 text-xs font-mono text-zinc-400 bg-zinc-900/50 p-2.5 rounded border border-zinc-800">
                      <div className="flex flex-col min-w-0 flex-1">
                        <span className="truncate text-zinc-200 font-semibold">{displayName}</span>
                        <span className="text-[10px] text-zinc-500 font-sans mt-0.5">
                          Allowed: {requiredLabel}
                        </span>
                      </div>
                      <label className="shrink-0 px-2.5 py-1.5 bg-amber-600 hover:bg-amber-500 text-amber-950 font-bold rounded cursor-pointer transition-colors text-[10px] select-none">
                        Upload
                        <input
                          type="file"
                          className="hidden"
                          accept={acceptTypes}
                          onChange={(e) => {
                            const file = e.target.files?.[0];
                            if (!file) return;

                            if (isVideo) {
                              handleUploadVideo(file);
                            } else if (isAudio) {
                              handleUploadBackingTrack(file);
                            } else {
                              // It could be a pack image
                              if (f === packInfo.iconFilename || f === packInfo.iconPath || f === '_icon.png' || f === 'icon.png') {
                                const ext = file.name.split('.').pop() || 'png';
                                const cleanExt = ext.toLowerCase() === 'jpeg' ? 'jpg' : ext.toLowerCase();
                                const standardName = `_icon.${cleanExt}`;
                                setPackInfo(prev => ({
                                  ...prev,
                                  iconFile: file,
                                  iconFilename: standardName,
                                  iconUrl: URL.createObjectURL(file),
                                  hasCustomIcon: true
                                }));
                              } else if (f === packInfo.fillerImageFilename || f === packInfo.fillerImagePath || f === '_pack_filler_image.png') {
                                const ext = file.name.split('.').pop() || 'png';
                                const cleanExt = ext.toLowerCase() === 'jpeg' ? 'jpg' : ext.toLowerCase();
                                const standardName = `_pack_filler_image.${cleanExt}`;
                                setPackInfo(prev => ({
                                  ...prev,
                                  fillerImageFile: file,
                                  fillerImageFilename: standardName,
                                  fillerImageUrl: URL.createObjectURL(file),
                                  hasCustomFiller: true
                                }));
                              } else {
                                const char = characters.find(c => 
                                  (c.avatarFile?.name || c.originalFilename || c.avatarFilename) === f ||
                                  c.avatarFilename?.split(/[/\\]/).pop() === f ||
                                  c.originalFilename === f
                                );
                                if (char) {
                                  const safeName = char.name.toLowerCase().replace(/[^a-z0-9]+/g, '_');
                                  const ext = file.name.split('.').pop() || 'png';
                                  const updatedChar = { 
                                    ...char, 
                                    avatarFile: file, 
                                    originalFilename: file.name, 
                                    avatarFilename: `${safeName}_avatar.${ext}`,
                                    avatarUrl: URL.createObjectURL(file) 
                                  };
                                  handleUpdateCharacter(char.id, updatedChar, char.name);
                                }

                                const matchingClips = clips.filter(c => 
                                  (c.originalImageFilename || c.imageFilename) === f ||
                                  c.imageFilename?.split(/[/\\]/).pop() === f
                                );
                                if (matchingClips.length > 0) {
                                  const objUrl = URL.createObjectURL(file);
                                  matchingClips.forEach(c => {
                                    handleUpdateClip(c.id, {
                                      imageUrl: objUrl,
                                      imageFilename: file.name,
                                      originalImageFilename: file.name,
                                    });
                                  });
                                }
                              }
                            }

                            setMissingFilesPrompt(prev => prev.filter(fileItem => fileItem !== f));
                          }}
                        />
                      </label>
                    </li>
                  );
                })}
              </ul>
            </div>
            <div className="pt-2 flex justify-end items-center">
              <button
                onClick={() => {
                  setMissingFilesPrompt([]);
                  if (videoMedia && !videoMedia.url) setVideoMedia(undefined);
                  if (backingTrackMedia && !backingTrackMedia.url) setBackingTrackMedia(undefined);
                }}
                className="px-4 py-2 bg-amber-500 hover:bg-amber-400 text-amber-950 font-bold rounded-lg transition-colors cursor-pointer text-sm"
              >
                Dismiss
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Export Progress Overlay */}
      {isExporting && exportProgress && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6 max-w-sm w-full text-center space-y-4 shadow-2xl">
            <div className="w-12 h-12 border-4 border-amber-400 border-t-transparent rounded-full animate-spin mx-auto" />
            <div>
              <h3 className="font-bold text-zinc-100 text-sm">Packing Modpack (.zip)</h3>
              <p className="text-xs text-amber-300 font-mono mt-1 min-h-[1.25rem] truncate px-2">{exportProgress.status}</p>
            </div>
            <div className="space-y-1.5">
              <div className="w-full bg-zinc-800 h-2.5 rounded-full overflow-hidden border border-zinc-700/50 relative">
                <div
                  className="bg-gradient-to-r from-amber-600 via-amber-500 to-amber-600 bg-[length:200%_100%] animate-shimmer h-full transition-all duration-300 rounded-full"
                  style={{ width: `${Math.min(100, Math.max(0, exportProgress.percent))}%` }}
                />
              </div>
              <div className="flex items-center justify-between text-[11px] font-mono text-zinc-400 px-0.5">
                <span>Progress</span>
                <span className="text-amber-400 font-bold">{Math.min(100, Math.max(0, exportProgress.percent))}%</span>
              </div>
            </div>
            <button
              type="button"
              onClick={handleCancelExport}
              className="w-full py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 hover:text-white rounded-lg text-xs font-semibold border border-zinc-700/60 transition-colors cursor-pointer flex items-center justify-center gap-1.5 mt-2"
            >
              <X className="w-3.5 h-3.5" />
              <span>Cancel Export</span>
            </button>
          </div>
        </div>
      )}

      {/* Custom Message Modal */}
      {customModal.isOpen && (
        <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl w-full max-w-md overflow-hidden shadow-2xl">
            <div className="bg-zinc-950 px-4 py-3 border-b border-zinc-800 flex items-center justify-between">
              <h3 className="text-xs font-bold text-amber-400 uppercase tracking-wide">{customModal.title}</h3>
              <button
                onClick={() => setCustomModal(prev => ({ ...prev, isOpen: false }))}
                className="text-zinc-400 hover:text-zinc-200 p-1 transition-colors cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-4 space-y-4">
              <div className="text-zinc-200 text-xs leading-relaxed">{customModal.message}</div>
              <div className="flex justify-end gap-2 pt-2 border-t border-zinc-800/80">
                {customModal.type === 'confirm' && (
                  <button
                    onClick={() => setCustomModal(prev => ({ ...prev, isOpen: false }))}
                    className="px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 font-medium transition-colors text-xs cursor-pointer"
                  >
                    Cancel
                  </button>
                )}
                <button
                  onClick={() => {
                    if (customModal.type === 'confirm' && customModal.onConfirm) {
                      customModal.onConfirm();
                    }
                    setCustomModal(prev => ({ ...prev, isOpen: false }));
                  }}
                  className="px-4 py-1.5 rounded-lg bg-amber-500 hover:bg-amber-400 text-zinc-950 font-bold transition-colors text-xs cursor-pointer"
                >
                  OK
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Loading Spinner Overlay */}
      {isLoading && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-xs flex flex-col items-center justify-center gap-3">
          <div className="w-8 h-8 border-2 border-amber-500 border-t-transparent rounded-full animate-spin" />
          <p className="text-xs font-medium text-amber-200">{loadingMessage}</p>
        </div>
      )}
    </div>
  );
}
