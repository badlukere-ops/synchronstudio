import { Character, PackInfo, TimelineClip } from '../types';
import localforage from 'localforage';

export interface SavedProject {
  id: string;
  title: string;
  updatedAt: number;
  packInfo: PackInfo;
  characters: Character[];
  clips: TimelineClip[];
  duration?: number;
  videoMediaName?: string;
  videoMediaUrl?: string;
  backingTrackName?: string;
  backingTrackUrl?: string;
}

const STORAGE_KEY_CURRENT = 'cvmodmaker_current_project';
const STORAGE_KEY_PROJECTS = 'cvmodmaker_saved_projects';

// Initialize a specific localforage instance for media files to keep them separate from other DBs
export const mediaStorage = localforage.createInstance({
  name: 'cvmodmaker_media_storage'
});

export async function saveMediaFileToStorage(projectId: string, type: 'video' | 'backingTrack', file: File | Blob) {
  try {
    await mediaStorage.setItem(`${projectId}_${type}`, file);
  } catch (err) {
    console.error(`Failed to save ${type} to IndexedDB:`, err);
  }
}

export async function loadMediaFileFromStorage(projectId: string, type: 'video' | 'backingTrack'): Promise<File | Blob | null> {
  try {
    const file = await mediaStorage.getItem<File | Blob>(`${projectId}_${type}`);
    return file || null;
  } catch (err) {
    console.error(`Failed to load ${type} from IndexedDB:`, err);
    return null;
  }
}

export async function deleteMediaFilesFromStorage(projectId: string) {
  try {
    await mediaStorage.removeItem(`${projectId}_video`);
    await mediaStorage.removeItem(`${projectId}_backingTrack`);
  } catch (err) {
    console.error(`Failed to delete media for ${projectId} from IndexedDB:`, err);
  }
}

export function saveActiveProjectLocally(
  projectId: string,
  packInfo: PackInfo,
  characters: Character[],
  clips: TimelineClip[],
  videoMediaName?: string,
  backingTrackName?: string,
  videoMediaUrl?: string,
  backingTrackUrl?: string
): SavedProject {
  // Clean temporary blob object URLs while keeping persistent data/http URLs
  const sanitizeUrl = (url?: string, defaultFallback?: string) => {
    if (!url) return defaultFallback;
    if (url.startsWith('blob:')) return defaultFallback;
    return url;
  };

  const cleanPackInfo: PackInfo = {
    ...packInfo,
    iconBlob: undefined,
    fillerImageBlob: undefined,
    iconUrl: sanitizeUrl(packInfo.iconUrl),
    fillerImageUrl: sanitizeUrl(packInfo.fillerImageUrl),
  };

  const cleanCharacters = characters.map((c) => ({
    ...c,
  }));

  const cleanClips = clips.map((c) => ({
    ...c,
    audioBlob: undefined,
    imageUrl: sanitizeUrl(c.imageUrl),
  }));

  const project: SavedProject = {
    id: projectId,
    title: cleanPackInfo.title || 'Untitled Dub Modpack',
    updatedAt: Date.now(),
    packInfo: cleanPackInfo,
    characters: cleanCharacters,
    clips: cleanClips,
    videoMediaName,
    videoMediaUrl: sanitizeUrl(videoMediaUrl),
    backingTrackName,
    backingTrackUrl: sanitizeUrl(backingTrackUrl),
  };

  try {
    localStorage.setItem(STORAGE_KEY_CURRENT, JSON.stringify(project));

    // Update project list
    const existingList = getSavedProjectsList();
    const filtered = existingList.filter((p) => p.id !== project.id);
    const updatedList = [project, ...filtered].slice(0, 10); // Keep top 10 recent
    localStorage.setItem(STORAGE_KEY_PROJECTS, JSON.stringify(updatedList));
  } catch (err) {
    console.warn('Could not save project to localStorage:', err);
  }

  return project;
}

export function getActiveProjectFromStorage(): SavedProject | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_CURRENT);
    if (!raw) return null;
    return JSON.parse(raw) as SavedProject;
  } catch {
    return null;
  }
}

export function getSavedProjectsList(): SavedProject[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_PROJECTS);
    if (!raw) return [];
    return JSON.parse(raw) as SavedProject[];
  } catch {
    return [];
  }
}

export function deleteSavedProject(id: string): void {
  try {
    const list = getSavedProjectsList();
    const updated = list.filter((p) => p.id !== id);
    localStorage.setItem(STORAGE_KEY_PROJECTS, JSON.stringify(updated));

    const current = getActiveProjectFromStorage();
    if (current && current.id === id) {
      localStorage.removeItem(STORAGE_KEY_CURRENT);
    }
    
    // Also cleanup media files from IndexedDB
    deleteMediaFilesFromStorage(id).catch(console.error);
  } catch (err) {
    console.warn('Error deleting project from storage:', err);
  }
}
