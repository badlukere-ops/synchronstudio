import React, { useRef, useEffect, useState, useCallback } from 'react';
import {
  Scissors,
  Trash2,
  ZoomIn,
  ZoomOut,
  Plus,
  Wand2,
  Film,
  Music,
  Quote,
  Tag,
  Copy,
  Clock,
  Magnet,
} from 'lucide-react';
import { Character, TimelineClip } from '../types';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';

interface TimelineEditorProps {
  duration: number;
  currentTime: number;
  clips: TimelineClip[];
  selectedClipId?: string;
  selectedClipIds?: string[];
  characters: Character[];
  waveformPeaks?: number[];
  disableDubTimestamps?: boolean;
  onSeek: (time: number) => void;
  onSelectClip: (clipId?: string, isMultiSelect?: boolean, isShiftSelect?: boolean, batchClipIds?: string[]) => void;
  onUpdateClip: (clipId: string, updates: Partial<TimelineClip>) => void;
  onSplitAtPlayhead: () => void;
  onDeleteClip: (clipId: string) => void;
  onDuplicateClip?: (clipId: string) => void;
  onAddClipAtPlayhead: () => void;
  onAutoSplitSilence?: () => void;
  onClipDragEnd?: (clipId: string) => void;
  hasVideo: boolean;
  isPlaying: boolean;
}

export const TimelineEditor: React.FC<TimelineEditorProps> = ({
  duration,
  currentTime,
  clips,
  selectedClipId,
  selectedClipIds = [],
  characters,
  waveformPeaks,
  disableDubTimestamps = false,
  onSeek,
  onSelectClip,
  onUpdateClip,
  onSplitAtPlayhead,
  onDeleteClip,
  onDuplicateClip,
  onAddClipAtPlayhead,
  onAutoSplitSilence,
  onClipDragEnd,
  hasVideo,
  isPlaying,
}) => {
  const [zoom, setZoom] = useState(1); // 1x to 10x
  const [isSnapEnabled, setIsSnapEnabled] = useState(true);
  const timelineRef = useRef<HTMLDivElement>(null);
  const waveformCanvasRef = useRef<HTMLCanvasElement>(null);

  const dragRef = useRef<{
    draggingClipId: string;
    dragType: 'move' | 'trim-start' | 'trim-end';
    dragStartX: number;
    initialClipStart: number;
    initialClipEnd: number;
    initialDubTimestamps: number[];
    hasMoved: boolean;
    animationFrame?: number;
  } | null>(null);

  const clipClickPendingRef = useRef<{
    clipId: string;
    isCtrl: boolean;
    isShift: boolean;
    startX: number;
    startY: number;
    isAlreadySelected: boolean;
  } | null>(null);

  const playheadRef = useRef<HTMLDivElement>(null);

  const [draggingClipId, setDraggingClipId] = useState<string | null>(null);
  const [dragType, setDragType] = useState<'move' | 'trim-start' | 'trim-end' | null>(null);

  const [selectionBox, setSelectionBox] = useState<{ startX: number; startY: number; currentX: number; currentY: number } | null>(null);
  const isSelectingRef = useRef(false);

  const pixelsPerSecond = 50 * zoom;

  // Sync playhead position and auto-scroll during playback
  useEffect(() => {
    if (!playheadRef.current || !timelineRef.current) return;

    const left = currentTime * pixelsPerSecond;
    playheadRef.current.style.transform = `translateX(${left}px)`;

    // Auto-scroll logic
    if (isPlaying) {
      const container = timelineRef.current;
      const scrollLeft = container.scrollLeft;
      const width = container.clientWidth;
      const buffer = 100; // 100px from edge triggers scroll

      if (left > scrollLeft + width - buffer) {
        container.scrollLeft = left - width + buffer + 200; // Scroll ahead a bit
      } else if (left < scrollLeft + buffer && left > buffer) {
        container.scrollLeft = Math.max(0, left - buffer);
      }
    }
  }, [currentTime, pixelsPerSecond, isPlaying]);
  const contentWidth = duration * pixelsPerSecond;
  const totalWidth = hasVideo ? Math.max(1, contentWidth) : 800;

  // Helper to compute snapped timestamps for clips with high precision and details
  const getSnappedTimeDetails = (
    targetTime: number,
    isModifierPressed: boolean,
    ignoreClipId?: string
  ): { time: number; snapped: boolean; delta: number } => {
    // If snapping is enabled and modifier is pressed -> override (disable snapping)
    // If snapping is disabled and modifier is pressed -> force enable snapping
    const shouldSnap = isSnapEnabled ? !isModifierPressed : isModifierPressed;
    if (!shouldSnap) {
      return { time: targetTime, snapped: false, delta: Infinity };
    }

    // Excellent magnetic snapping zone (18 pixels on screen)
    const snapThreshold = 18 / pixelsPerSecond;
    let bestTime = targetTime;
    let minDelta = snapThreshold;
    let snapped = false;

    // 1. Whole second marks (0, 1, 2...)
    const secondFloor = Math.floor(targetTime);
    const secondCeil = Math.ceil(targetTime);
    [secondFloor, secondCeil].forEach((s) => {
      const delta = Math.abs(targetTime - s);
      if (delta < minDelta) {
        minDelta = delta;
        bestTime = s;
        snapped = true;
      }
    });

    // 2. Playhead position
    const playheadDelta = Math.abs(targetTime - currentTime);
    if (playheadDelta < minDelta) {
      minDelta = playheadDelta;
      bestTime = currentTime;
      snapped = true;
    }

    // 3. Other clip start and end boundaries
    clips.forEach((c) => {
      if (c.id === ignoreClipId) return;
      [c.startTime, c.endTime].forEach((edge) => {
        const delta = Math.abs(targetTime - edge);
        if (delta < minDelta) {
          minDelta = delta;
          bestTime = edge;
          snapped = true;
        }
      });
    });

    return {
      time: bestTime,
      snapped,
      delta: snapped ? minDelta : Infinity,
    };
  };

  // Handle right-click context menu with smart positioning
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; clipId: string } | null>(null);

  const handleContextMenu = (e: React.MouseEvent, clipId: string) => {
    if (!hasVideo) return;
    e.preventDefault();
    e.stopPropagation();

    // Menu dimensions estimate
    const menuWidth = 220;
    const menuHeight = 220;

    let x = e.clientX;
    let y = e.clientY;

    if (x + menuWidth > window.innerWidth) {
      x = Math.max(10, e.clientX - menuWidth);
    }
    if (y + menuHeight > window.innerHeight) {
      y = Math.max(10, e.clientY - menuHeight);
    }

    setContextMenu({ x, y, clipId });
    onSelectClip(clipId);
  };

  useEffect(() => {
    const closeMenu = () => setContextMenu(null);
    window.addEventListener('click', closeMenu);
    return () => window.removeEventListener('click', closeMenu);
  }, []);

  // Render Waveform on Canvas
  useEffect(() => {
    const canvas = waveformCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const width = canvas.width;
    const height = canvas.height;
    ctx.clearRect(0, 0, width, height);

    ctx.fillStyle = '#18181b'; // zinc-900 background
    ctx.fillRect(0, 0, width, height);

    // Ensure we only draw grid lines up to the actual duration width
    const contentWidth = duration * pixelsPerSecond;

    // Draw grid lines every second
    const step = pixelsPerSecond;
    ctx.strokeStyle = '#27272a'; // zinc-800
    ctx.lineWidth = 1;
    // Draw grid lines ONLY up to duration-based contentWidth
    for (let x = 0; x <= contentWidth; x += step) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
    }
    
    // Fill the remaining area after duration with the background color if totalWidth > contentWidth
    if (totalWidth > contentWidth) {
        ctx.fillStyle = '#18181b';
        ctx.fillRect(contentWidth, 0, totalWidth - contentWidth, height);
    }

    // Draw waveform bars
    const peaks = waveformPeaks || [];
    if (peaks.length > 0) {
      const numPeaks = peaks.length;
      const barWidth = Math.max(1.5, contentWidth / numPeaks);

      ctx.fillStyle = '#f59e0b'; // amber-500 waveform
      for (let i = 0; i < numPeaks; i++) {
        const x = (i / numPeaks) * contentWidth;
        const peak = peaks[i];
        const barHeight = Math.max(2, peak * (height - 8));
        const y = (height - barHeight) / 2;

        ctx.fillRect(x, y, barWidth, barHeight);
      }
    } else {
      // Default synthetic waveform graphic if no audio loaded
      ctx.fillStyle = '#eab308';
      for (let x = 0; x <= contentWidth; x += 6) {
        const h = (Math.sin(x * 0.05) * 0.5 + 0.5) * (height - 12);
        ctx.fillRect(x, (height - h) / 2, 3, h);
      }
    }
  }, [duration, pixelsPerSecond, waveformPeaks, totalWidth]);

  // Handle timeline clicking to seek playhead
  useEffect(() => {
    const handleWheel = (e: WheelEvent) => {
      if (timelineRef.current && e.shiftKey) {
        e.preventDefault();
        timelineRef.current.scrollLeft += e.deltaY;
      }
    };
    const el = timelineRef.current;
    if (el) {
      el.addEventListener('wheel', handleWheel, { passive: false });
    }
    return () => {
      if (el) {
        el.removeEventListener('wheel', handleWheel);
      }
    };
  }, []);

  const handleTrackMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!hasVideo || dragRef.current) return;
    if (e.button !== 0) return;
    const rect = timelineRef.current?.getBoundingClientRect();
    if (!rect) return;

    isSelectingRef.current = true;
    const scrollLeft = timelineRef.current?.scrollLeft || 0;
    const scrollTop = timelineRef.current?.scrollTop || 0;
    const xInTimeline = e.clientX - rect.left + scrollLeft;
    const yInTimeline = e.clientY - rect.top + scrollTop;

    setSelectionBox({
      startX: xInTimeline,
      startY: yInTimeline,
      currentX: xInTimeline,
      currentY: yInTimeline,
    });
  };

  // Dragging logic for Clips (Move / Trim)
  const handleMouseDownClip = (
    e: React.MouseEvent,
    clip: TimelineClip,
    type: 'move' | 'trim-start' | 'trim-end'
  ) => {
    if (!hasVideo) return;
    e.stopPropagation();
    const isCtrl = e.ctrlKey || e.metaKey;
    const isShift = e.shiftKey;
    
    const isAlreadySelected = selectedClipIds.includes(clip.id) || clip.id === selectedClipId;

    if (!isAlreadySelected || type !== 'move') {
      onSelectClip(clip.id, isCtrl, isShift);
    } else {
      clipClickPendingRef.current = {
        clipId: clip.id,
        isCtrl,
        isShift,
        startX: e.clientX,
        startY: e.clientY,
        isAlreadySelected: true,
      };
    }

    dragRef.current = {
      draggingClipId: clip.id,
      dragType: type,
      dragStartX: e.clientX,
      initialClipStart: clip.startTime,
      initialClipEnd: clip.endTime,
      initialDubTimestamps: [...clip.dubTimestamps],
      hasMoved: false,
    };
    setDraggingClipId(clip.id);
    setDragType(type);
  };

  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      if (isSelectingRef.current && timelineRef.current) {
        const rect = timelineRef.current.getBoundingClientRect();
        const xInTimeline = e.clientX - rect.left + timelineRef.current.scrollLeft;
        const yInTimeline = e.clientY - rect.top + timelineRef.current.scrollTop;
        setSelectionBox((prev) =>
          prev ? { ...prev, currentX: xInTimeline, currentY: yInTimeline } : null
        );
      }

      if (!dragRef.current) return;
      
      const {
        draggingClipId,
        dragType,
        dragStartX,
        initialClipStart,
        initialClipEnd,
        initialDubTimestamps,
      } = dragRef.current;

      const currentDeltaX = e.clientX - dragStartX;
      if (Math.abs(currentDeltaX) > 3) {
        dragRef.current.hasMoved = true;
        clipClickPendingRef.current = null;
      }

      if (dragRef.current.animationFrame) {
        cancelAnimationFrame(dragRef.current.animationFrame);
      }
      
      dragRef.current.animationFrame = requestAnimationFrame(() => {
        if (!dragRef.current) return;
        
        const deltaX = e.clientX - dragStartX;
      const deltaTime = deltaX / pixelsPerSecond;
      const isModifierPressed = e.ctrlKey || e.metaKey || e.shiftKey;

      if (dragType === 'move') {
        const clipDuration = initialClipEnd - initialClipStart;
        const rawStart = Math.max(0, initialClipStart + deltaTime);
        const rawEnd = rawStart + clipDuration;

        const startSnap = getSnappedTimeDetails(rawStart, isModifierPressed, draggingClipId);
        const endSnap = getSnappedTimeDetails(rawEnd, isModifierPressed, draggingClipId);

        let newStart = rawStart;
        if (startSnap.snapped && endSnap.snapped) {
          if (startSnap.delta <= endSnap.delta) {
            newStart = startSnap.time;
          } else {
            newStart = Math.max(0, endSnap.time - clipDuration);
          }
        } else if (startSnap.snapped) {
          newStart = startSnap.time;
        } else if (endSnap.snapped) {
          newStart = Math.max(0, endSnap.time - clipDuration);
        }

        let newEnd = newStart + clipDuration;
        if (newEnd > duration) {
          newEnd = duration;
          newStart = Math.max(0, newEnd - clipDuration);
        }

        const timeDelta = newStart - initialClipStart;
        const updatedDubTimestamps = disableDubTimestamps
          ? [Number(newStart.toFixed(3))]
          : initialDubTimestamps.map((ts) => Number((ts + timeDelta).toFixed(3)));
        onUpdateClip(draggingClipId, {
          startTime: Number(newStart.toFixed(3)),
          endTime: Number(newEnd.toFixed(3)),
          dubTimestamps: updatedDubTimestamps,
        });
      } else if (dragType === 'trim-start') {
        const rawStart = Math.max(0, Math.min(initialClipEnd - 0.5, initialClipStart + deltaTime));
        const startSnap = getSnappedTimeDetails(rawStart, isModifierPressed, draggingClipId);
        const newStart = Number(Math.max(0, Math.min(initialClipEnd - 0.5, startSnap.time)).toFixed(3));
        const updatedDubTimestamps = disableDubTimestamps
          ? [newStart]
          : initialDubTimestamps.map((ts) => Math.max(newStart, ts));
        onUpdateClip(draggingClipId, {
          startTime: newStart,
          dubTimestamps: updatedDubTimestamps,
        });
      } else if (dragType === 'trim-end') {
        const rawEnd = Math.max(initialClipStart + 0.5, Math.min(duration, initialClipEnd + deltaTime));
        const endSnap = getSnappedTimeDetails(rawEnd, isModifierPressed, draggingClipId);
        const newEnd = Number(Math.max(initialClipStart + 0.5, Math.min(duration, endSnap.time)).toFixed(3));
        const updatedDubTimestamps = disableDubTimestamps
          ? [initialClipStart]
          : initialDubTimestamps.map((ts) => Math.min(newEnd, ts));
        onUpdateClip(draggingClipId, {
          endTime: newEnd,
          dubTimestamps: updatedDubTimestamps,
        });
      }
      });
    },
    [pixelsPerSecond, duration, onUpdateClip, getSnappedTimeDetails, disableDubTimestamps]
  );

  const handleMouseUp = useCallback(() => {
    const wasDraggingId = dragRef.current?.draggingClipId;

    if (isSelectingRef.current && selectionBox) {
      const minX = Math.min(selectionBox.startX, selectionBox.currentX);
      const maxX = Math.max(selectionBox.startX, selectionBox.currentX);
      const dragDist = Math.abs(selectionBox.currentX - selectionBox.startX);

      if (dragDist > 6) {
        const selectStart = minX / pixelsPerSecond;
        const selectEnd = maxX / pixelsPerSecond;
        const matchedClipIds = clips
          .filter((c) => c.startTime < selectEnd && c.endTime > selectStart)
          .map((c) => c.id);

        if (matchedClipIds.length > 0) {
          onSelectClip(undefined, false, false, matchedClipIds);
        } else {
          onSelectClip(undefined);
        }
      } else {
        const clickedTime = Math.max(0, Math.min(duration, minX / pixelsPerSecond));
        onSeek(clickedTime);
        onSelectClip(undefined);
      }
    }

    if (clipClickPendingRef.current) {
      const { clipId, isCtrl, isShift } = clipClickPendingRef.current;
      onSelectClip(clipId, isCtrl, isShift);
      clipClickPendingRef.current = null;
    }

    isSelectingRef.current = false;
    setSelectionBox(null);
    dragRef.current = null;
    setDraggingClipId(null);
    setDragType(null);

    if (wasDraggingId && onClipDragEnd) {
      onClipDragEnd(wasDraggingId);
    }
  }, [selectionBox, pixelsPerSecond, clips, duration, onSeek, onSelectClip, onClipDragEnd]);

  const handleMouseMoveRef = useRef<typeof handleMouseMove>(handleMouseMove);
  useEffect(() => {
    handleMouseMoveRef.current = handleMouseMove;
  }, [handleMouseMove]);

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (handleMouseMoveRef.current) {
        handleMouseMoveRef.current(e);
      }
    };
    if (draggingClipId || selectionBox) {
      window.addEventListener('mousemove', onMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
      return () => {
        window.removeEventListener('mousemove', onMouseMove);
        window.removeEventListener('mouseup', handleMouseUp);
      };
    }
  }, [draggingClipId, selectionBox, handleMouseUp]);

  // Memoize Timeline Ruler Tick Marks
  const rulerTicks = React.useMemo(() => {
    const ticks = [];
    const totalSeconds = Math.ceil(duration || 20);

    for (let sec = 0; sec <= totalSeconds; sec++) {
      const leftPx = sec * pixelsPerSecond;
      const isMajor = sec % 5 === 0;

      ticks.push(
        <div
          key={sec}
          className="absolute top-0 bottom-0 border-l border-zinc-800 pointer-events-none"
          style={{ left: `${leftPx}px` }}
        >
          <span className="text-[9px] font-sans text-zinc-400 pl-1 select-none font-medium">
            {isMajor ? `${sec}s` : ''}
          </span>
        </div>
      );
    }
    return ticks;
  }, [duration, pixelsPerSecond]);

  // Compute lane stacking and dynamic heights for tracks (Greedy Interval Packing)
  const clipLaneIndices = new Map<string, number>();
  const sortedClips = [...clips].sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime);
  const laneEndTimes: number[] = [];

  sortedClips.forEach((clip) => {
    let assignedLane = -1;
    for (let lane = 0; lane < laneEndTimes.length; lane++) {
      if (laneEndTimes[lane] <= clip.startTime) {
        assignedLane = lane;
        laneEndTimes[lane] = clip.endTime;
        break;
      }
    }
    if (assignedLane === -1) {
      assignedLane = laneEndTimes.length;
      laneEndTimes.push(clip.endTime);
    }
    clipLaneIndices.set(clip.id, assignedLane);
  });

  const maxClipLane = clips.length > 0 ? Math.max(0, ...Array.from(clipLaneIndices.values())) : 0;
  const clipsTrackHeight = Math.max(90, (maxClipLane + 1) * 46 + 16);
  const captionTrackHeight = Math.max(44, (maxClipLane + 1) * 26 + 12);

  const canSplit = hasVideo && clips.some((c) => currentTime > c.startTime + 0.5 && currentTime < c.endTime - 0.5);

  return (
    <div className="flex flex-col h-full bg-[#0a0a0b] border border-zinc-800/80 rounded-xl overflow-hidden text-xs select-none">
      {/* Toolbar */}
      <div className="bg-[#121214] px-4 py-2 border-b border-zinc-800/80 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={onSplitAtPlayhead}
                disabled={!canSplit}
                className={`px-3 py-1.5 rounded-lg bg-amber-500/10 text-amber-400 font-bold border border-zinc-800 flex items-center gap-1.5 transition-all ${!canSplit ? 'opacity-50 cursor-not-allowed' : 'hover:bg-amber-500/20 cursor-pointer'}`}
              >
                <Scissors className="w-3.5 h-3.5" />
                <span>Split</span>
              </button>
            </TooltipTrigger>
            <TooltipContent>
              {!hasVideo 
                ? 'Disabled until video is uploaded' 
                : !canSplit 
                  ? 'Disabled: No clip under playhead to split' 
                  : 'Split clip at playhead'
              }
            </TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={onAddClipAtPlayhead}
                disabled={!hasVideo || characters.length === 0}
                className={`px-3 py-1.5 rounded-lg bg-zinc-900/80 text-zinc-300 font-medium border border-zinc-800/80 flex items-center gap-1.5 transition-all ${!hasVideo || characters.length === 0 ? 'opacity-50 cursor-not-allowed' : 'hover:bg-zinc-800 cursor-pointer'}`}
              >
                <Plus className="w-3.5 h-3.5 text-amber-400" />
                <span>Add Clip</span>
              </button>
            </TooltipTrigger>
            <TooltipContent>
              {!hasVideo 
                ? 'Disabled until video is uploaded' 
                : characters.length === 0 
                  ? 'Disabled: Create a character first' 
                  : 'Add clip marker at current position'
              }
            </TooltipContent>
          </Tooltip>

          {onAutoSplitSilence && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={onAutoSplitSilence}
                  disabled={!hasVideo || characters.length === 0}
                  className={`px-3 py-1.5 rounded-lg bg-zinc-900/80 text-zinc-300 font-medium border border-zinc-800/80 flex items-center gap-1.5 transition-all ${!hasVideo || characters.length === 0 ? 'opacity-50 cursor-not-allowed' : 'hover:bg-zinc-800 cursor-pointer'}`}
                >
                  <Wand2 className="w-3.5 h-3.5 text-amber-400" />
                  <span className="hidden sm:inline">Auto-Split</span>
                </button>
              </TooltipTrigger>
              <TooltipContent>
                {!hasVideo 
                  ? 'Disabled until video is uploaded' 
                  : characters.length === 0 
                    ? 'Disabled: Create a character first' 
                    : 'Auto detect audio pauses and split clips'
                }
              </TooltipContent>
            </Tooltip>
          )}

          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={() => setIsSnapEnabled((prev) => !prev)}
                disabled={!hasVideo}
                className={`px-3 py-1.5 rounded-lg font-medium border flex items-center gap-1.5 transition-all ${
                  !hasVideo
                    ? 'bg-zinc-900/50 text-zinc-600 border-zinc-800/50 opacity-50 cursor-not-allowed'
                    : 'cursor-pointer ' + (isSnapEnabled ? 'bg-amber-500/20 text-amber-300 border-zinc-800 hover:bg-amber-500/30' : 'bg-zinc-900/80 hover:bg-zinc-800 text-zinc-400 border-zinc-800/80')
                }`}
              >
                <Magnet className={`w-3.5 h-3.5 ${isSnapEnabled && hasVideo ? 'text-amber-400' : 'text-zinc-500'}`} />
                <span>Snap {isSnapEnabled && hasVideo ? 'ON' : 'OFF'}</span>
              </button>
            </TooltipTrigger>
            <TooltipContent>
              {!hasVideo
                ? 'Disabled until video is uploaded'
                : isSnapEnabled
                ? 'Snapping enabled (Snap to seconds, playhead & clips). Hold Ctrl to force/override.'
                : 'Snapping disabled. Hold Ctrl while dragging to snap.'}
            </TooltipContent>
          </Tooltip>

          {selectedClipId && (
            <div className="flex items-center ml-2 pl-2 border-l border-zinc-800/80">
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={() => onDeleteClip(selectedClipId)}
                    disabled={!hasVideo}
                    className={`p-1.5 rounded-lg text-zinc-400 hover:text-red-400 hover:bg-red-400/10 transition-colors ${!hasVideo ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </TooltipTrigger>
                <TooltipContent>{hasVideo ? 'Delete selected clip' : 'Disabled until video is uploaded'}</TooltipContent>
              </Tooltip>
            </div>
          )}
        </div>

        {/* Zoom Controls */}
        <div className="flex items-center gap-2 bg-zinc-900/50 px-2 py-1 rounded-lg border border-zinc-800/50">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                disabled={!hasVideo}
                onClick={() => setZoom(Math.max(0.5, zoom - 0.25))}
                className={`p-1 rounded bg-zinc-800 text-zinc-300 transition-colors ${!hasVideo ? 'opacity-50 cursor-not-allowed' : 'hover:bg-zinc-700 cursor-pointer'}`}
              >
                <ZoomOut className="w-3.5 h-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent>{hasVideo ? 'Zoom Out' : 'Disabled until video is uploaded'}</TooltipContent>
          </Tooltip>

          <span className={`font-sans font-bold w-10 text-center ${!hasVideo ? 'text-zinc-600' : 'text-amber-400'}`}>{zoom.toFixed(1)}x</span>

          <Tooltip>
            <TooltipTrigger asChild>
              <button
                disabled={!hasVideo}
                onClick={() => setZoom(Math.min(5, zoom + 0.25))}
                className={`p-1 rounded bg-zinc-800 text-zinc-300 transition-colors ${!hasVideo ? 'opacity-50 cursor-not-allowed' : 'hover:bg-zinc-700 cursor-pointer'}`}
              >
                <ZoomIn className="w-3.5 h-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent>{hasVideo ? 'Zoom In' : 'Disabled until video is uploaded'}</TooltipContent>
          </Tooltip>
        </div>
      </div>

      {/* Timeline Viewport & Tracks */}
      <div
        ref={timelineRef}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        className={`relative overflow-auto bg-[#0a0a0b] flex-1 min-h-0 border-b border-zinc-800/80 custom-scrollbar ${
          !hasVideo ? 'opacity-30 pointer-events-none select-none cursor-not-allowed' : 'cursor-crosshair'
        }`}
      >
        <div
          onMouseDown={handleTrackMouseDown}
          className="relative flex flex-col min-h-full"
          style={{ width: `${totalWidth}px` }}
        >
          {selectionBox && Math.abs(selectionBox.currentX - selectionBox.startX) > 4 && (
            <div
              style={{
                left: `${Math.min(selectionBox.startX, selectionBox.currentX)}px`,
                top: `${Math.min(selectionBox.startY, selectionBox.currentY)}px`,
                width: `${Math.abs(selectionBox.currentX - selectionBox.startX)}px`,
                height: `${Math.abs(selectionBox.currentY - selectionBox.startY)}px`,
                willChange: 'left, top, width, height',
                transform: 'translate3d(0,0,0)',
              }}
              className="absolute bg-amber-500/15 border border-amber-400 rounded z-40 pointer-events-none"
            />
          )}
          {/* 1. Ruler Header */}
          <div className="h-7 bg-[#121214] border-b border-zinc-800/80 relative select-none">
            {rulerTicks}
          </div>

          {/* 2. Audio Waveform Track */}
          <div className="relative h-14 border-b border-zinc-800/80 bg-zinc-900/30">
            <canvas
              ref={waveformCanvasRef}
              width={totalWidth}
              height={56}
              className="w-full h-full block"
            />
          </div>

          {/* 3. Voice Clips Track */}
          <div
            style={{ height: `${clipsTrackHeight}px` }}
            className="relative bg-[#0a0a0b] py-2 border-b border-zinc-800/80 transition-all duration-200 overflow-hidden"
          >
            {/* Clips Blocks */}
            <div className="relative h-full">
              {clips.map((clip) => {
                const leftPx = Math.round(clip.startTime * pixelsPerSecond);
                const widthPx = Math.round(Math.max(20, (clip.endTime - clip.startTime) * pixelsPerSecond));
                const isSelected = selectedClipIds.includes(clip.id) || clip.id === selectedClipId;
                const primaryChar = characters.find((c) => clip.dubCharacters.includes(c.name));
                const clipColor = primaryChar?.color || '#3b82f6';

                // Collision detection for lane stacking
                const trackIndex = clipLaneIndices.get(clip.id) || 0;
                const topPx = trackIndex * 46 + 4;

                return (
                  <div
                    key={clip.id}
                    onContextMenu={(e) => handleContextMenu(e, clip.id)}
                    onMouseDown={(e) => handleMouseDownClip(e, clip, 'move')}
                    style={{
                      left: `${leftPx}px`,
                      width: `${widthPx}px`,
                      top: `${topPx}px`,
                      backgroundColor: `${clipColor}15`,
                      borderColor: isSelected ? '#f59e0b' : `${clipColor}40`,
                      willChange: 'left, width',
                      transform: 'translate3d(0,0,0)',
                    }}
                    className={`absolute h-10 rounded-lg border-2 cursor-ew-resize flex items-center justify-between px-2 overflow-visible group ${
                      isSelected ? 'z-20 border-amber-500' : 'z-10 hover:border-opacity-100 hover:bg-opacity-30'
                    }`}
                  >
                    {/* Trim Handle Left */}
                    <Tooltip open={draggingClipId ? false : undefined}>
                      <TooltipTrigger asChild>
                        <div
                          onMouseDown={(e) => handleMouseDownClip(e, clip, 'trim-start')}
                          className={`absolute -top-[2px] -bottom-[2px] -left-[2px] w-2.5 rounded-l-lg bg-amber-500 hover:bg-amber-400 cursor-ew-resize z-30 transition-opacity ${
                            isSelected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
                          }`}
                        />
                      </TooltipTrigger>
                      <TooltipContent>Trim Start</TooltipContent>
                    </Tooltip>

                    {/* Content */}
                    <div
                      className="flex-1 truncate flex items-center gap-2 text-[11px] font-bold text-white px-2 select-none h-full cursor-ew-resize"
                    >
                      <Film className="w-3.5 h-3.5 shrink-0" style={{ color: clipColor }} />
                      <span className="font-sans font-bold tracking-wide truncate">{clip.filename}</span>
                      <span className="text-[10px] text-zinc-400 font-normal truncate">
                        {clip.caption}
                      </span>
                    </div>

                    {/* Dub Cue Timestamp Markers */}
                    {!disableDubTimestamps && (
                      <div className="absolute inset-0 rounded-[6px] overflow-hidden pointer-events-none z-10">
                        {clip.dubTimestamps.map((ts, idx) => {
                          let tsOffset = Math.round((ts - clip.startTime) * pixelsPerSecond);
                          tsOffset = Math.max(3, Math.min(widthPx - 6, tsOffset));
                          return (
                            <Tooltip key={`cue_${clip.id}_${idx}`}>
                              <TooltipTrigger asChild>
                                <div
                                  style={{ left: `${tsOffset}px` }}
                                  className="absolute top-0 bottom-0 w-[2px] bg-amber-400 pointer-events-none flex items-center justify-center -translate-x-1/2"
                                >
                                  {/* Stretched rounded diamond in middle of bar */}
                                  <div className="w-2.5 h-4 -ml-[0.25px] rounded-full bg-amber-400" />
                                </div>
                              </TooltipTrigger>
                              <TooltipContent>Cue: {ts.toFixed(3)}s</TooltipContent>
                            </Tooltip>
                          );
                        })}
                      </div>
                    )}

                    {/* Trim Handle Right */}
                    <Tooltip open={draggingClipId ? false : undefined}>
                      <TooltipTrigger asChild>
                        <div
                          onMouseDown={(e) => handleMouseDownClip(e, clip, 'trim-end')}
                          className={`absolute -top-[2px] -bottom-[2px] -right-[2px] w-2.5 rounded-r-lg bg-amber-500 hover:bg-amber-400 cursor-ew-resize z-30 transition-opacity ${
                            isSelected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
                          }`}
                        />
                      </TooltipTrigger>
                      <TooltipContent>Trim End</TooltipContent>
                    </Tooltip>
                  </div>
                );
              })}
            </div>
          </div>

          {/* 4. Subtitles Track Preview */}
          <div
            style={{ minHeight: `${captionTrackHeight}px` }}
            className="relative bg-[#121214] py-2 px-3 border-b border-zinc-800/50 transition-all duration-200 overflow-hidden flex-1"
          >
            {clips.map((clip) => {
              const leftPx = Math.round(clip.startTime * pixelsPerSecond);
              const widthPx = Math.round(Math.max(20, (clip.endTime - clip.startTime) * pixelsPerSecond));
              const trackIndex = clipLaneIndices.get(clip.id) || 0;
              const topPx = trackIndex * 26 + 6;

              return (
                <div
                  key={`sub_${clip.id}`}
                  style={{ left: `${leftPx}px`, width: `${widthPx}px`, top: `${topPx}px` }}
                  className="absolute h-6 bg-amber-500/10 border border-amber-500/20 rounded text-[10px] text-amber-100 truncate px-2 flex items-center font-medium font-sans"
                >
                  {clip.caption}
                </div>
              );
            })}
          </div>

          {/* Scrubbable Playhead Needle Line */}
          <div
            ref={playheadRef}
            className="absolute top-0 bottom-0 w-[2px] bg-amber-500 z-30 pointer-events-none will-change-transform"
            style={{ left: 0 }}
          />
        </div>
      </div>
      
      {/* Custom Context Menu */}
      {contextMenu && (
        <div
          className="fixed z-50 bg-[#121214] border border-zinc-800 rounded-xl w-52 text-xs font-medium backdrop-blur-md overflow-hidden flex flex-col divide-y divide-zinc-800/80 select-none"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="px-3.5 py-2 text-[10px] font-bold text-amber-500 uppercase tracking-widest bg-zinc-900/90 flex items-center justify-between">
            <span>Clip Options</span>
            <span className="text-[9px] text-zinc-500 font-normal">#{contextMenu.clipId.slice(-4)}</span>
          </div>

          <div className="flex flex-col">
            <button
              type="button"
              disabled={!canSplit}
              className={`w-full text-left px-3.5 py-2.5 transition-colors flex items-center gap-2.5 font-medium ${!canSplit ? 'opacity-50 cursor-not-allowed text-zinc-500 hover:bg-transparent hover:text-zinc-500' : 'hover:bg-amber-500/15 text-zinc-200 hover:text-amber-400 cursor-pointer'}`}
              onClick={() => {
                if (!canSplit) return;
                onSplitAtPlayhead();
                setContextMenu(null);
              }}
            >
              <Scissors className={`w-3.5 h-3.5 shrink-0 ${!canSplit ? 'text-zinc-500' : 'text-amber-500'}`} />
              <span>Split at Playhead</span>
            </button>

            {onDuplicateClip && (
              <button
                type="button"
                className="w-full text-left px-3.5 py-2.5 hover:bg-amber-500/15 text-zinc-200 hover:text-amber-400 transition-colors flex items-center gap-2.5 font-medium cursor-pointer"
                onClick={() => {
                  onDuplicateClip(contextMenu.clipId);
                  setContextMenu(null);
                }}
              >
                <Copy className="w-3.5 h-3.5 text-amber-500 shrink-0" />
                <span>Duplicate Clip</span>
              </button>
            )}

            <button
              type="button"
              className="w-full text-left px-3.5 py-2.5 hover:bg-amber-500/15 text-zinc-200 hover:text-amber-400 transition-colors flex items-center gap-2.5 font-medium cursor-pointer"
              onClick={() => {
                const targetClip = clips.find((c) => c.id === contextMenu.clipId);
                if (targetClip) onSeek(targetClip.startTime);
                setContextMenu(null);
              }}
            >
              <Clock className="w-3.5 h-3.5 text-amber-500 shrink-0" />
              <span>Jump Playhead Here</span>
            </button>

            <button
              type="button"
              className="w-full text-left px-3.5 py-2.5 hover:bg-amber-500/15 text-zinc-200 hover:text-amber-400 transition-colors flex items-center gap-2.5 font-medium cursor-pointer"
              onClick={() => {
                const targetClip = clips.find((c) => c.id === contextMenu.clipId);
                if (targetClip && currentTime >= targetClip.startTime && currentTime <= targetClip.endTime) {
                  onUpdateClip(targetClip.id, {
                    dubTimestamps: [Number(currentTime.toFixed(3))],
                  });
                }
                setContextMenu(null);
              }}
            >
              <Tag className="w-3.5 h-3.5 text-amber-500 shrink-0" />
              <span>Set Cue at Playhead</span>
            </button>
          </div>

          <div>
            <button
              type="button"
              className="w-full text-left px-3.5 py-2.5 hover:bg-red-500/20 text-red-400 transition-colors flex items-center gap-2.5 font-medium cursor-pointer"
              onClick={() => {
                onDeleteClip(contextMenu.clipId);
                setContextMenu(null);
              }}
            >
              <Trash2 className="w-3.5 h-3.5 text-red-400 shrink-0" />
              <span>Delete Clip</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
