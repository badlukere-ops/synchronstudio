import React, { useRef, useEffect } from 'react';
import { Play, Pause, SkipBack, SkipForward, Volume2, VolumeX, Film, Music, ArrowUpDown } from 'lucide-react';
import { Character, TimelineClip } from '../types';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';

interface VideoStageProps {
  videoUrl?: string;
  backingTrackUrl?: string;
  currentTime: number;
  duration: number;
  isPlaying: boolean;
  activeClip?: TimelineClip;
  characters: Character[];
  onPlayPause: () => void;
  onSeek: (time: number) => void;
  isMuted: boolean;
  onToggleMute: () => void;
  isBackingTrackOnly?: boolean;
  onToggleBackingTrackOnly?: () => void;
  captionOffset?: { x: number; y: number };
  captionAlign?: 'left' | 'center' | 'right';
  onCaptionOffsetChange?: (offset: { x: number; y: number }, align?: 'left' | 'center' | 'right') => void;
}

export const VideoStage: React.FC<VideoStageProps> = ({
  videoUrl,
  backingTrackUrl,
  currentTime,
  duration,
  isPlaying,
  activeClip,
  characters,
  onPlayPause,
  onSeek,
  isMuted,
  onToggleMute,
  isBackingTrackOnly = false,
  onToggleBackingTrackOnly,
  captionOffset,
  captionAlign,
  onCaptionOffsetChange,
}) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const backingAudioRef = useRef<HTMLAudioElement>(null);
  const lastUpdateTimeRef = useRef<number>(0);
  const [isScrubbing, setIsScrubbing] = React.useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const captionRef = useRef<HTMLSpanElement>(null);
  const [localCaptionOffset, setLocalCaptionOffset] = React.useState({ x: 0, y: 0 });
  const [localCaptionAlign, setLocalCaptionAlign] = React.useState<'left' | 'center' | 'right'>('center');
  const [isHoveringCaption, setIsHoveringCaption] = React.useState(false);
  const isDraggingCaption = useRef(false);
  const dragStart = useRef({ x: 0, y: 0 });
  const offsetStart = useRef({ x: 0, y: 0 });
  const latestOffsetRef = useRef({ x: 0, y: 0 });

  const [rects, setRects] = React.useState({ containerHeight: 360, captionHeight: 36 });

  // Update rects when activeClip caption changes or on resize
  useEffect(() => {
    if (!containerRef.current || !captionRef.current) return;
    const updateRects = () => {
      if (containerRef.current && captionRef.current) {
        setRects({
          containerHeight: containerRef.current.getBoundingClientRect().height,
          captionHeight: captionRef.current.getBoundingClientRect().height,
        });
      }
    };
    updateRects();
    const resizeObserver = new ResizeObserver(updateRects);
    resizeObserver.observe(containerRef.current);
    if (captionRef.current) {
      resizeObserver.observe(captionRef.current);
    }
    return () => resizeObserver.disconnect();
  }, [activeClip?.caption, localCaptionOffset]);

  const initialMeasure = useRef({
    containerWidth: 0,
    containerHeight: 0,
    captionWidth: 0,
    captionHeight: 0,
    startLeft: 0,
    startRight: 0,
    startCenter: 0,
    startOffsetY: 0,
    startTop: 0,
  });

  const hasVideo = Boolean(videoUrl);

  // Sync offset & alignment with global props
  useEffect(() => {
    let offset = { x: 0, y: 0 };
    if (captionOffset) {
      offset = captionOffset;
    }
    setLocalCaptionOffset(offset);
    latestOffsetRef.current = offset;

    if (captionAlign) {
      setLocalCaptionAlign(captionAlign);
    } else {
      setLocalCaptionAlign('center');
    }
  }, [captionOffset, captionAlign]);

  const handlePointerDown = (e: React.PointerEvent) => {
    if (!captionRef.current || !containerRef.current || !hasVideo) return;
    if (e.button !== 0) return;
    
    e.stopPropagation();
    e.preventDefault();
    
    isDraggingCaption.current = true;
    dragStart.current = { x: e.clientX, y: e.clientY };
    offsetStart.current = { ...localCaptionOffset };

    const container = containerRef.current;
    const caption = captionRef.current;
    const containerRect = container.getBoundingClientRect();
    const captionRect = caption.getBoundingClientRect();

    const startTop = captionRect.top - containerRect.top;

    initialMeasure.current = {
      containerWidth: containerRect.width,
      containerHeight: containerRect.height,
      captionWidth: captionRect.width,
      captionHeight: captionRect.height,
      startLeft: captionRect.left - (containerRect.left + 16),
      startRight: (containerRect.right - 16) - captionRect.right,
      startCenter: (captionRect.left + captionRect.width / 2) - (containerRect.left + containerRect.width / 2),
      startOffsetY: localCaptionOffset.y,
      startTop: startTop,
    };
    
    captionRef.current.setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!isDraggingCaption.current || !captionRef.current || !containerRef.current) return;
    
    const deltaY = e.clientY - dragStart.current.y;

    const {
      containerHeight,
      captionHeight,
      startTop,
    } = initialMeasure.current;

    let newTop = startTop + deltaY;
    
    // Clamp so that physical top stays within [12, containerHeight - captionHeight - 12]
    newTop = Math.max(12, Math.min(containerHeight - captionHeight - 12, newTop));

    // Determine if the center of the caption is in the upper half of the stage
    const captionCenter = newTop + captionHeight / 2;
    const isUpper = captionCenter < containerHeight / 2;

    let newY = 0;
    if (isUpper) {
      // Top-anchored: positive offset from top edge (12px)
      newY = Math.max(0.001, newTop - 12);
    } else {
      // Bottom-anchored: negative or zero offset from bottom edge (containerHeight - 12)
      newY = (newTop + captionHeight) - (containerHeight - 12);
      newY = Math.min(0, newY);
    }

    const align = 'center';

    setLocalCaptionOffset({ x: 0, y: newY });
    latestOffsetRef.current = { x: 0, y: newY };
    setLocalCaptionAlign(align);
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    if (!isDraggingCaption.current || !captionRef.current) return;
    
    isDraggingCaption.current = false;
    captionRef.current.releasePointerCapture(e.pointerId);
    
    if (onCaptionOffsetChange) {
      onCaptionOffsetChange(latestOffsetRef.current, localCaptionAlign);
    }
  };

  // Sync video element with playhead currentTime
  useEffect(() => {
    if (!videoRef.current || isScrubbing) return;

    const drift = Math.abs(videoRef.current.currentTime - currentTime);
    const threshold = isPlaying ? 0.2 : 0.001;
    if (drift > threshold) {
      videoRef.current.currentTime = currentTime;
    }
  }, [currentTime, isScrubbing, isPlaying]);

  useEffect(() => {
    if (!backingAudioRef.current || isScrubbing) return;
    const drift = Math.abs(backingAudioRef.current.currentTime - currentTime);
    const threshold = isPlaying ? 0.2 : 0.001;
    if (drift > threshold) {
      backingAudioRef.current.currentTime = currentTime;
    }
  }, [currentTime, isScrubbing, isPlaying]);

  // Sync play/pause state
  useEffect(() => {
    if (videoRef.current) {
      if (isPlaying && !isScrubbing) {
        videoRef.current.play().catch(() => {});
      } else {
        videoRef.current.pause();
      }
    }
    if (backingAudioRef.current) {
      if (isPlaying && !isScrubbing && isBackingTrackOnly) {
        backingAudioRef.current.play().catch(() => {});
      } else {
        backingAudioRef.current.pause();
      }
    }
  }, [isPlaying, isScrubbing, isBackingTrackOnly]);

  // Smooth playhead tracking via requestAnimationFrame
  useEffect(() => {
    if (!isPlaying || isScrubbing) return;
    let animationFrameId: number;

    const updateTime = () => {
      if (videoRef.current) {
        const cur = videoRef.current.currentTime;
        if (Math.abs(cur - lastUpdateTimeRef.current) >= 0.01) {
          lastUpdateTimeRef.current = cur;
          onSeek(cur);
        }
      }
      animationFrameId = requestAnimationFrame(updateTime);
    };

    animationFrameId = requestAnimationFrame(updateTime);
    return () => cancelAnimationFrame(animationFrameId);
  }, [isPlaying, isScrubbing, onSeek]);

  const activeChar = characters.find((c) => activeClip?.dubCharacters.includes(c.name));

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    const ms = Math.floor((seconds % 1) * 1000);
    return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
  };

  const handleScrub = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!hasVideo) return;
    const time = parseFloat(e.target.value);
    onSeek(time);
    if (videoRef.current) {
      videoRef.current.currentTime = time;
    }
    if (backingAudioRef.current) {
      backingAudioRef.current.currentTime = time;
    }
  };

  const isUpperHalf = localCaptionOffset.y > 0;

  return (
    <div className="flex flex-col bg-[#0a0a0b] border border-zinc-800/80 rounded-xl overflow-hidden select-none">
      {/* Optional Hidden Backing Track Audio Element */}
      {backingTrackUrl && (
        <audio
          ref={backingAudioRef}
          src={backingTrackUrl}
          muted={isMuted}
          playsInline
        />
      )}

      {/* Top Bar / Stage Header */}
      <div className="bg-[#121214] px-4 py-2 border-b border-zinc-800/80 flex items-center justify-between text-xs">
        <div className={`flex items-center gap-2 font-sans ${hasVideo ? 'text-zinc-300' : 'text-zinc-600'}`}>
          <span className={`${hasVideo ? 'text-amber-400 font-bold' : 'text-zinc-600'} tracking-wider`}>
            {formatTime(currentTime)}
          </span>
          <span className="text-zinc-600">/</span>
          <span className="text-zinc-500 tracking-wider">{formatTime(duration || 20)}</span>
        </div>

        {/* Backing Track Only Badge / Toggle Indicator */}
        <div className="flex items-center gap-2">
          {onToggleBackingTrackOnly && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  disabled={!hasVideo || !backingTrackUrl}
                  onClick={() => hasVideo && backingTrackUrl && onToggleBackingTrackOnly?.()}
                  className={`px-2.5 py-1 rounded-md text-[10px] font-bold flex items-center gap-1.5 transition-all border ${
                    !hasVideo || !backingTrackUrl
                      ? 'bg-zinc-900/40 text-zinc-600 border-zinc-800/40 opacity-40 cursor-not-allowed'
                      : isBackingTrackOnly
                      ? 'bg-amber-500/20 text-amber-300 border-zinc-800 cursor-pointer'
                      : 'bg-zinc-900 text-zinc-400 border-zinc-800 hover:text-zinc-200 cursor-pointer'
                  }`}
                >
                  <Music className={`w-3 h-3 ${isBackingTrackOnly && hasVideo && backingTrackUrl ? 'text-amber-400' : 'text-zinc-500'}`} />
                  <span>{isBackingTrackOnly && backingTrackUrl ? 'Backing Track Solo' : 'Play Backing Track Only'}</span>
                </button>
              </TooltipTrigger>
              <TooltipContent>
                {!backingTrackUrl
                  ? 'No backing track uploaded yet.'
                  : isBackingTrackOnly
                  ? 'Currently playing backing track audio solo (voices muted)'
                  : 'Click to play only the backing track audio over video'}
              </TooltipContent>
            </Tooltip>
          )}

          {/* Active Clip ID Indicator */}
          {activeClip ? (
            <div className="flex items-center gap-2 bg-zinc-900/50 border border-amber-500/20 px-2.5 py-1 rounded-md text-[11px]">
              <span className="text-zinc-400">Clip:</span>
              <span className="text-amber-400 font-bold font-sans tracking-wide">{activeClip.filename}</span>
            </div>
          ) : (
            <div className="flex items-center gap-2 bg-zinc-900/20 border border-transparent px-2.5 py-1 rounded-md text-[11px]">
              <span className="text-zinc-500 italic">No active clip slice</span>
            </div>
          )}
        </div>
      </div>

      {/* Video Viewport Area */}
      <div 
        ref={containerRef}
        className="relative aspect-video bg-[#0a0a0b] flex items-center justify-center overflow-hidden border-b border-zinc-800/80 group"
      >
        {videoUrl ? (
          <video
            ref={videoRef}
            id="main-video-player"
            src={videoUrl}
            muted={isMuted || isBackingTrackOnly}
            playsInline
            className="absolute inset-0 w-full h-full object-contain"
            onEnded={() => {
              if (!isScrubbing) onSeek(duration);
            }}
          />
        ) : (
          /* Placeholder animated stage preview when no raw video is loaded */
          <div className="absolute inset-0 w-full h-full bg-[#121214] flex flex-col items-center justify-center p-6 text-center">
            <div className="w-16 h-16 rounded-2xl bg-[#1f1f22] border border-zinc-800/50 flex items-center justify-center mb-4 text-amber-500">
              <Film className="w-7 h-7 opacity-80" />
            </div>
            <p className="text-sm font-bold text-zinc-200">Stage Preview</p>
            <p className="text-xs text-zinc-400 max-w-xs mt-2 leading-relaxed">
              Upload a main video file (.mp4 format) or edit timeline clips.
            </p>
          </div>
        )}

        {/* Active Character Badge Overlay (Top Left) */}
        {!isBackingTrackOnly && activeClip && activeClip.dubCharacters.length > 0 && (
          <div className="absolute top-4 left-4 flex items-center gap-2.5 bg-[#0a0a0b]/80 border border-zinc-800/50 px-3 py-1.5 rounded-full text-xs font-bold text-white backdrop-blur-md pointer-events-none transition-opacity z-10">
            {activeChar?.avatarUrl && (
              <img
                src={activeChar.avatarUrl}
                alt={activeChar.name}
                draggable={false}
                className="w-6 h-6 rounded-md object-cover pointer-events-auto"
              />
            )}
            <span style={{ color: activeChar?.color || '#f59e0b' }} className="tracking-wide">
              {activeClip.dubCharacters.join(', ')}
            </span>
          </div>
        )}

        {/* Subtitle / Caption Overlay (Bottom Center with Edge Snapping & Alignment) */}
        {activeClip && activeClip.caption && (
          <div 
            className={`absolute inset-0 pointer-events-none flex px-4 overflow-hidden z-10 justify-center ${
              isUpperHalf ? 'items-start pt-[12px]' : 'items-end pb-[12px]'
            }`}
          >
            <div
              className="pointer-events-none flex max-w-[90%] max-h-[85%]"
              style={{
                transform: `translate(0px, ${localCaptionOffset.y}px)`,
                transition: isDraggingCaption.current ? 'none' : 'transform 0.1s ease-out',
              }}
            >
              <div className="pointer-events-auto flex flex-col items-center gap-1.5 select-none">
                {/* Badge on top if bottom-anchored */}
                {!isUpperHalf && isHoveringCaption && hasVideo && (
                  <div className="bg-black/90 text-white text-[10px] px-2.5 py-1 rounded border border-amber-500/40 whitespace-nowrap opacity-100 transition-opacity pointer-events-none flex items-center justify-center z-20 shadow-lg">
                    <ArrowUpDown className="w-3.5 h-3.5 mr-1 text-amber-400 shrink-0" />
                    <span>Up / Down</span>
                  </div>
                )}

                <span 
                  ref={captionRef}
                  onPointerDown={hasVideo ? handlePointerDown : undefined}
                  onPointerMove={hasVideo ? handlePointerMove : undefined}
                  onPointerUp={hasVideo ? handlePointerUp : undefined}
                  onPointerCancel={hasVideo ? handlePointerUp : undefined}
                  onMouseEnter={() => setIsHoveringCaption(true)}
                  onMouseLeave={() => setIsHoveringCaption(false)}
                  className={`inline-block bg-[#0a0a0b]/85 text-amber-100 font-medium text-sm px-4 py-2 rounded-lg border border-amber-500/30 max-w-full backdrop-blur-md tracking-wide select-none transition-colors break-words text-center whitespace-pre-wrap ${
                    hasVideo ? 'cursor-ns-resize hover:border-amber-500/60 hover:bg-[#121214]/95' : 'cursor-default'
                  }`}
                >
                  {activeClip.caption}
                </span>

                {/* Badge on bottom if top-anchored */}
                {isUpperHalf && isHoveringCaption && hasVideo && (
                  <div className="bg-black/90 text-white text-[10px] px-2.5 py-1 rounded border border-amber-500/40 whitespace-nowrap opacity-100 transition-opacity pointer-events-none flex items-center justify-center z-20 shadow-lg">
                    <ArrowUpDown className="w-3.5 h-3.5 mr-1 text-amber-400 shrink-0" />
                    <span>Up / Down</span>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Control Bar */}
      <div className="p-3 bg-[#121214] flex items-center justify-between gap-3 text-xs">
        {/* Playback buttons */}
        <div className="flex items-center gap-1.5">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                disabled={!hasVideo}
                onClick={() => hasVideo && onSeek(0)}
                className={`p-2 text-zinc-400 bg-zinc-900/50 border border-zinc-800/80 rounded-lg transition-colors ${
                  hasVideo
                    ? 'hover:text-zinc-100 hover:bg-zinc-800 cursor-pointer'
                    : 'opacity-40 cursor-not-allowed'
                }`}
              >
                <SkipBack className="w-4 h-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent>{hasVideo ? 'Jump to Start' : 'No Video Loaded'}</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                disabled={!hasVideo}
                onClick={() => hasVideo && onPlayPause()}
                className={`p-2.5 rounded-lg font-bold flex items-center justify-center transition-colors border-none ${
                  hasVideo
                    ? 'bg-[#d97706] hover:bg-[#f59e0b] text-white cursor-pointer'
                    : 'bg-zinc-800 text-zinc-600 opacity-40 cursor-not-allowed'
                }`}
              >
                {isPlaying ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4 text-white" />}
              </button>
            </TooltipTrigger>
            <TooltipContent>{hasVideo ? (isPlaying ? 'Pause (Space)' : 'Play (Space)') : 'No Video Loaded'}</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                disabled={!hasVideo}
                onClick={() => hasVideo && onSeek(duration)}
                className={`p-2 text-zinc-400 bg-zinc-900/50 border border-zinc-800/80 rounded-lg transition-colors ${
                  hasVideo
                    ? 'hover:text-zinc-100 hover:bg-zinc-800 cursor-pointer'
                    : 'opacity-40 cursor-not-allowed'
                }`}
              >
                <SkipForward className="w-4 h-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent>{hasVideo ? 'Jump to End' : 'No Video Loaded'}</TooltipContent>
          </Tooltip>
        </div>

        {/* Scrub progress slider */}
        <div className="flex-1 mx-3 flex items-center gap-2">
          <input
            type="range"
            disabled={!hasVideo}
            min={0}
            max={duration || 20}
            step={0.01}
            value={currentTime}
            onMouseDown={() => hasVideo && setIsScrubbing(true)}
            onMouseUp={() => setIsScrubbing(false)}
            onTouchStart={() => hasVideo && setIsScrubbing(true)}
            onTouchEnd={() => setIsScrubbing(false)}
            onChange={handleScrub}
            className={`w-full h-1.5 rounded-full ${
              hasVideo ? 'cursor-pointer' : 'opacity-40 cursor-not-allowed'
            }`}
          />
        </div>

        {/* Mute button */}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              disabled={!hasVideo}
              onClick={() => hasVideo && onToggleMute()}
              className={`p-2 text-zinc-400 bg-zinc-900/50 border border-zinc-800/80 rounded-lg transition-colors ${
                hasVideo
                  ? 'hover:text-zinc-100 hover:bg-zinc-800 cursor-pointer'
                  : 'opacity-40 cursor-not-allowed'
              }`}
            >
              {isMuted ? <VolumeX className="w-4 h-4 text-red-400" /> : <Volume2 className="w-4 h-4" />}
            </button>
          </TooltipTrigger>
          <TooltipContent>{hasVideo ? (isMuted ? 'Unmute Audio' : 'Mute Audio') : 'No Video Loaded'}</TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
};
