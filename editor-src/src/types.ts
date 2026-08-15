export interface Character {
  id: string;
  name: string;
  avatarUrl: string; // Data URL or Object URL
  avatarFilename: string; // e.g. "buzz.png"
  originalFilename?: string; // Original uploaded filename
  avatarFile?: File; // Store the file reference
  color: string; // Hex color for timeline display badge
  autoScreenshot?: boolean; // If true, auto-capture video frame for clips
}

export interface TimelineClip {
  id: string; // e.g., "01_buzz"
  filename: string; // e.g., "01_buzz"
  startTime: number; // in seconds on timeline
  endTime: number; // in seconds on timeline
  dubTimestamps: number[]; // e.g., [5.865] (offset relative to full video or clip)
  dubCharacters: string[]; // e.g., ["Buzz"]
  caption: string; // English line text (Synchronstudio `text`)
  captionDe?: string; // German line text (Synchronstudio `de`)
  imageFilename?: string; // e.g. "buzz.png"
  originalImageFilename?: string;
  imageUrl?: string; // Custom clip image blob URL if provided
  audioBlob?: Blob; // Sliced WAV/MP3 blob
  originalAudioFilename?: string;
  volume?: number;
  isMuted?: boolean;
  captionOffset?: { x: number; y: number };
  captionAlign?: 'left' | 'center' | 'right';
  capturedAtTime?: number;
}

export interface PackInfo {
  title: string; // e.g. "Woody and Buzz Argue"
  sceneId?: string; // Synchronstudio scenes.json id (slug)
  iconFilename: string; // e.g. "ts.png"
  iconUrl?: string; // Data URL or Object URL
  iconBlob?: Blob;
  authors: string[]; // e.g. ["Sticks456546"]
  readme: string; // e.g. "The woody and buzz argue from toy story"
  preselectedDubCharacters: string[]; // e.g. ["Woody", "Buzz"]
  fillerImageFilename?: string; // e.g. "_pack_filler_image.png"
  fillerImageUrl?: string;
  fillerImageBlob?: Blob;
  disableDubTimestamps?: boolean; // Option to turn off dub timestamps project-wide
  excludeDraftJson?: boolean; // Option to exclude _draft_project.json from ZIP export
  excludeVideo?: boolean; // Option to exclude video from ZIP export
  exportChoicerPack?: boolean; // Also include Choicer Voicer files (default false)
  captionOffset?: { x: number; y: number }; // Global caption offset for video preview
  captionAlign?: 'left' | 'center' | 'right'; // Global caption alignment
  hasCustomIcon?: boolean;
  hasCustomFiller?: boolean;
}

export interface MediaSource {
  type: 'video' | 'audio';
  file?: File;
  url?: string;
  name: string;
  duration: number; // total duration in seconds
  audioBuffer?: AudioBuffer;
  waveformPeaks?: number[]; // pre-calculated peaks for visualizer
}
