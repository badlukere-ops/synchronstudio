import React, { useState } from 'react';
import {
  Sliders,
  Play,
  Square,
  Trash2,
  Clock,
  Quote,
  Tag,
  Image as ImageIcon,
  Sparkles,
  ChevronLeft,
  ChevronRight,
  UserPlus,
  Users,
  Check,
  Film,
} from 'lucide-react';
import { Character, TimelineClip } from '../types';
import { applySmartQuotes, getSmartFilenameForCharacter } from '../utils/ini';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';

interface ClipInspectorProps {
  selectedClip?: TimelineClip;
  selectedClipIds?: string[];
  characters: Character[];
  allClips?: TimelineClip[];
  currentTime: number;
  disableDubTimestamps?: boolean;
  onToggleDisableDubTimestamps?: () => void;
  onUpdateClip: (clipId: string, updates: Partial<TimelineClip>) => void;
  onDeleteClip: (clipId: string) => void;
  onDeleteClips?: (clipIds: string[]) => void;
  onPlayClipAudio: (clip: TimelineClip) => void;
  isPlayingClipAudio: boolean;
  onStopClipAudio: () => void;
  onSplitAtPlayhead: () => void;
  onAddClipAtPlayhead?: () => void;
  onOpenAddCharacter?: () => void;
  hasVideo: boolean;
}

export const ClipInspector: React.FC<ClipInspectorProps> = ({
  selectedClip,
  selectedClipIds = [],
  characters,
  allClips = [],
  currentTime,
  disableDubTimestamps = false,
  onToggleDisableDubTimestamps,
  onUpdateClip,
  onDeleteClip,
  onDeleteClips,
  onPlayClipAudio,
  isPlayingClipAudio,
  onStopClipAudio,
  onSplitAtPlayhead,
  onAddClipAtPlayhead,
  onOpenAddCharacter,
  hasVideo,
}) => {
  const [smartQuotesEnabled, setSmartQuotesEnabled] = useState(true);

  if (selectedClipIds && selectedClipIds.length > 1) {
    return (
      <div className="flex flex-col p-5 bg-[#121214] border border-zinc-800/80 rounded-xl text-xs h-full min-h-[300px] gap-4 overflow-y-auto">
        <div className="flex items-center gap-2 pb-3 border-b border-zinc-800">
          <Users className="w-5 h-5 text-amber-500" />
          <h3 className="font-bold text-sm text-zinc-100">{selectedClipIds.length} Clips Selected</h3>
        </div>
        <div className="py-6 flex-1 flex flex-col justify-center items-center text-center">
          <p className="text-zinc-400 leading-relaxed mb-6">
            Multiple clips are currently selected. Multi-selection allows you to delete multiple clips in batch below.
          </p>
          <button
            onClick={() => {
              if (onDeleteClips) {
                onDeleteClips(selectedClipIds);
              } else {
                selectedClipIds.forEach((id) => onDeleteClip(id));
              }
            }}
            className="px-4 py-2.5 rounded-lg bg-red-500/15 text-red-400 border border-red-500/30 hover:bg-red-500/25 font-bold transition-all flex items-center gap-2 cursor-pointer"
          >
            <Trash2 className="w-4 h-4" />
            <span>Delete Selected ({selectedClipIds.length}) Clips</span>
          </button>
        </div>
      </div>
    );
  }

  if (!selectedClip || !hasVideo) {
    return (
      <div className="flex flex-col p-5 bg-[#121214] border border-zinc-800/80 rounded-xl text-xs h-full min-h-[300px] gap-4 overflow-y-auto">
        {!hasVideo ? (
          <div className="flex flex-col items-center justify-center my-auto py-8 text-center text-zinc-500">
            <Film className="w-10 h-10 mb-3 text-zinc-700" />
            <p className="text-zinc-300 font-bold">No Video Uploaded</p>
            <p className="text-xs mt-1">Please add a video file to begin editing.</p>
          </div>
        ) : (
          <>
            <div className="flex-1 flex flex-col items-center justify-center text-center p-4">
              <Sliders className="w-8 h-8 text-zinc-700 mb-3" />
              <p className="font-bold text-zinc-300 tracking-wide text-sm">No Clip Selected</p>
              <p className="text-zinc-500 max-w-xs mt-2 leading-relaxed">
                Click on any clip slice in the timeline below to inspect and edit its caption, character tags, and dub timestamp.
              </p>
              <button
                onClick={onAddClipAtPlayhead}
                disabled={characters.length === 0}
                className={`mt-5 px-4 py-2 rounded-lg border font-bold transition-all ${
                  characters.length === 0 
                    ? 'bg-zinc-800/50 text-zinc-500 border-zinc-800 cursor-not-allowed'
                    : 'bg-amber-500/10 text-amber-400 border-zinc-800 hover:bg-amber-500/20 cursor-pointer'
                }`}
              >
                Add Clip ({currentTime.toFixed(3)}s)
              </button>
            </div>
          </>
        )}
      </div>
    );
  }

  const currentDubTimestamp = selectedClip.dubTimestamps[0] ?? selectedClip.startTime;

  const handleAdjustTimestamp = (delta: number) => {
    const rawTs = currentDubTimestamp + delta;
    const newTs = Math.max(selectedClip.startTime, Math.min(selectedClip.endTime, Number(rawTs.toFixed(3))));
    onUpdateClip(selectedClip.id, { dubTimestamps: [newTs] });
  };

  const handleSetTimestampToPlayhead = () => {
    const newTs = Math.max(selectedClip.startTime, Math.min(selectedClip.endTime, Number(currentTime.toFixed(3))));
    onUpdateClip(selectedClip.id, { dubTimestamps: [newTs] });
  };

  const handleCaptionChange = (val: string) => {
    let newCaption = val;
    if (smartQuotesEnabled) {
      newCaption = applySmartQuotes(val);
    }
    onUpdateClip(selectedClip.id, { caption: newCaption });
  };

  const handleToggleCharacter = (charName: string) => {
    const current = selectedClip.dubCharacters;
    let updated: string[];
    if (current.includes(charName)) {
      updated = current.filter((c) => c !== charName);
    } else {
      updated = [...current, charName];
    }
    
    const primaryCharName = updated[0];
    const primaryChar = characters.find((c) => c.name === primaryCharName);
    const autoImage = primaryChar
      ? (primaryChar.avatarFilename || `${primaryChar.name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}_avatar.png`)
      : 'default.png';
    
    let updatedFilename = selectedClip.filename;
    if (primaryCharName) {
      updatedFilename = getSmartFilenameForCharacter(primaryCharName, allClips, selectedClip.id);
    }

    onUpdateClip(selectedClip.id, {
      dubCharacters: updated,
      imageFilename: autoImage,
      filename: updatedFilename,
    });
  };

  return (
    <div className="flex flex-col gap-4 p-4 bg-[#121214] border border-zinc-800/80 rounded-xl text-xs select-none h-full overflow-y-auto">
      <div className="w-full max-w-sm mx-auto flex flex-col gap-4">
        <div className="flex items-center justify-between pb-3 border-b border-zinc-800/80 shrink-0">
          <div className="flex items-center gap-2">
            <Sliders className="w-4 h-4 text-amber-500" />
            <h2 className="font-bold text-zinc-100 uppercase tracking-wider text-[11px]">
              Clip Inspector
            </h2>
          </div>

          <div className="flex items-center gap-2">
            {isPlayingClipAudio ? (
              <button
                onClick={onStopClipAudio}
                className="px-3 py-1.5 rounded-lg bg-[#d97706] hover:bg-[#f59e0b] text-white font-bold flex items-center gap-1.5 transition-colors border-none cursor-pointer"
              >
                <Square className="w-3 h-3 text-white fill-current" />
                <span>Stop</span>
              </button>
            ) : (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={() => onPlayClipAudio(selectedClip)}
                    className="px-3 py-1.5 rounded-lg bg-[#d97706] hover:bg-[#f59e0b] text-white font-bold flex items-center gap-1.5 transition-colors border-none cursor-pointer"
                  >
                    <Play className="w-3 h-3 text-white fill-current" />
                    <span>Preview</span>
                  </button>
                </TooltipTrigger>
                <TooltipContent>Preview sliced clip audio</TooltipContent>
              </Tooltip>
            )}

            <div className="w-px h-4 bg-zinc-800/80 mx-1" />

            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={() => onDeleteClip(selectedClip.id)}
                  className="p-1.5 rounded-md text-zinc-500 hover:text-red-400 hover:bg-red-400/10 transition-colors cursor-pointer"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent>Delete Clip</TooltipContent>
            </Tooltip>
          </div>
        </div>

        {/* 1. Filename & ID */}
        <div className="space-y-1 shrink-0">
          <label className="text-[10px] text-zinc-400 font-semibold flex items-center gap-1.5">
            <Film className="w-3.5 h-3.5 text-amber-400 shrink-0" />
            Clip ID / Filename <span className="text-amber-400 font-sans text-[11px]">(.ini & .wav)</span>
          </label>
          <input
            type="text"
            value={selectedClip.filename}
            onChange={(e) => onUpdateClip(selectedClip.id, { filename: e.target.value })}
            className="w-full bg-zinc-950 border border-zinc-800/80 rounded-lg px-2.5 py-1.5 text-amber-300 font-sans text-xs focus:outline-none focus:border-amber-500"
          />
        </div>

        {/* 2. Character Assignment */}
        <div className="space-y-1 shrink-0">
          <label className="text-[10px] text-zinc-400 font-semibold flex items-center gap-1">
            <Tag className="w-3 h-3 text-amber-400" />
            Assigned Character(s) <span className="text-amber-400 font-sans text-[11px]">(dub_characters)</span>
          </label>

          {characters.length === 0 ? (
            <div className="bg-zinc-950 p-3 rounded-lg border border-dashed border-zinc-800 text-center flex flex-col items-center justify-center space-y-2">
              <Users className="w-5 h-5 text-amber-500/80" />
              <p className="text-[11px] text-zinc-300 font-bold">No characters in roster yet</p>
              <p className="text-[10px] text-zinc-500 max-w-[200px]">
                Add characters to your roster first to tag this clip with voice actors.
              </p>
              {onOpenAddCharacter && (
                <button
                  type="button"
                  onClick={onOpenAddCharacter}
                  className="mt-1 px-3 py-1 rounded bg-amber-500/15 hover:bg-amber-500/25 text-amber-400 border border-amber-500/30 text-[10px] font-bold flex items-center gap-1 transition-colors cursor-pointer"
                >
                  <UserPlus className="w-3 h-3" />
                  <span>Add New Character Profile</span>
                </button>
              )}
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-1.5 bg-zinc-950 p-2 rounded-lg border border-zinc-800 max-h-36 overflow-y-auto">
              {characters.map((c) => {
                const isAssigned = selectedClip.dubCharacters.includes(c.name);
                return (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => handleToggleCharacter(c.name)}
                    className={`px-2 py-1 rounded-md text-[10px] font-bold flex items-center justify-between gap-1 border transition-all truncate cursor-pointer ${
                      isAssigned
                        ? 'text-white border-transparent'
                        : 'bg-zinc-900 text-zinc-400 border-zinc-800 hover:text-zinc-200 hover:border-zinc-800'
                    }`}
                    style={isAssigned ? { backgroundColor: c.color } : {}}
                  >
                    <span className="truncate">{c.name}</span>
                    <span
                      className="w-2 h-2 rounded-full shrink-0"
                      style={{ backgroundColor: c.color }}
                    />
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* 3. Timestamp Precision Fine-Tuner & Project Options */}
        <div className="space-y-2 bg-zinc-950 p-2.5 rounded-lg border border-zinc-800">
          <div
            onClick={() => onToggleDisableDubTimestamps?.()}
            className="flex items-center gap-2 cursor-pointer group select-none py-1.5 px-2 bg-zinc-900 rounded border border-zinc-800 hover:border-zinc-800 transition-colors"
          >
            <div
              className={`w-4 h-4 rounded flex items-center justify-center transition-colors shrink-0 ${
                disableDubTimestamps
                  ? 'bg-amber-500 text-zinc-950 font-bold'
                  : 'bg-zinc-800 border border-zinc-800 group-hover:border-zinc-500 text-transparent'
              }`}
            >
              <Check className="w-3 h-3 stroke-[3]" />
            </div>
            <span className="text-zinc-300 font-semibold text-xs">
              Turn off Dub Timestamps for project
            </span>
          </div>

          <div className={`space-y-2 pt-2 border-t border-zinc-800/80 transition-opacity ${disableDubTimestamps ? 'opacity-50 pointer-events-none' : ''}`}>
            <div className="flex items-center justify-between">
              <label className="text-[10px] text-zinc-300 font-bold flex items-center gap-1">
                <Clock className="w-3 h-3 text-amber-400" />
                Dub Timestamp <span className="text-amber-400 font-sans text-[11px]">(dub_timestamps)</span>
              </label>
              <span className="font-sans text-amber-300 font-extrabold text-xs">
                {currentDubTimestamp.toFixed(3)}s
              </span>
            </div>

            <div className="space-y-2">
              <div className="grid grid-cols-6 gap-1 text-[10px] font-sans">
                <button
                  disabled={disableDubTimestamps}
                  onClick={() => handleAdjustTimestamp(-0.1)}
                  className="bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-zinc-300 py-1 rounded text-center font-medium cursor-pointer"
                >
                  -0.1s
                </button>
                <button
                  disabled={disableDubTimestamps}
                  onClick={() => handleAdjustTimestamp(-0.01)}
                  className="bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-zinc-300 py-1 rounded text-center font-medium cursor-pointer"
                >
                  -0.01s
                </button>
                <button
                  disabled={disableDubTimestamps}
                  onClick={() => handleAdjustTimestamp(-0.001)}
                  className="bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-amber-400 font-bold py-1 rounded text-center cursor-pointer"
                >
                  -0.001s
                </button>
                <button
                  disabled={disableDubTimestamps}
                  onClick={() => handleAdjustTimestamp(0.001)}
                  className="bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-amber-400 font-bold py-1 rounded text-center cursor-pointer"
                >
                  +0.001s
                </button>
                <button
                  disabled={disableDubTimestamps}
                  onClick={() => handleAdjustTimestamp(0.01)}
                  className="bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-zinc-300 py-1 rounded text-center font-medium cursor-pointer"
                >
                  +0.01s
                </button>
                <button
                  disabled={disableDubTimestamps}
                  onClick={() => handleAdjustTimestamp(0.1)}
                  className="bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-zinc-300 py-1 rounded text-center font-medium cursor-pointer"
                >
                  +0.1s
                </button>
              </div>

              <button
                disabled={disableDubTimestamps}
                onClick={handleSetTimestampToPlayhead}
                className="w-full bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-zinc-200 hover:text-amber-300 py-1.5 rounded-md text-[10px] font-bold flex items-center justify-center gap-1 transition-colors cursor-pointer"
              >
                <Clock className="w-3 h-3 text-amber-400" />
                <span>Sync Timestamp to Playhead ({currentTime.toFixed(3)}s)</span>
              </button>

              <div className="grid grid-cols-2 gap-1.5 pt-1">
                <button
                  disabled={disableDubTimestamps}
                  onClick={() => onUpdateClip(selectedClip.id, { dubTimestamps: [selectedClip.startTime] })}
                  className="bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-zinc-300 hover:text-amber-300 py-1.5 rounded text-[10px] font-bold transition-colors cursor-pointer"
                >
                  Put at Start ({selectedClip.startTime.toFixed(2)}s)
                </button>
                <button
                  disabled={disableDubTimestamps}
                  onClick={() => onUpdateClip(selectedClip.id, { dubTimestamps: [selectedClip.endTime] })}
                  className="bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-zinc-300 hover:text-amber-300 py-1.5 rounded text-[10px] font-bold transition-colors cursor-pointer"
                >
                  Put at End ({selectedClip.endTime.toFixed(2)}s)
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* 4. Subtitle / Caption Text Editor */}
        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <label className="text-[10px] text-zinc-300 font-bold flex items-center gap-1">
              <Quote className="w-3 h-3 text-amber-400" />
              English text <span className="text-amber-400 font-sans text-[11px]">(text)</span>
            </label>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => setSmartQuotesEnabled(!smartQuotesEnabled)}
                  className={`px-1.5 py-0.5 rounded text-[9px] font-bold border transition-colors flex items-center gap-1 cursor-pointer ${
                    smartQuotesEnabled
                      ? 'bg-amber-500/20 text-amber-300 border-zinc-800'
                      : 'bg-zinc-800 text-zinc-500 border-zinc-800'
                  }`}
                >
                  <Sparkles className="w-2.5 h-2.5" />
                  <span>Smart Quotes</span>
                </button>
              </TooltipTrigger>
              <TooltipContent>Auto convert plain quotes to smart curly quotes “ ”</TooltipContent>
            </Tooltip>
          </div>

          <textarea
            rows={3}
            value={selectedClip.caption}
            onChange={(e) => handleCaptionChange(e.target.value)}
            placeholder="English line (shown in EN mode)…"
            disabled={!hasVideo}
            className={`w-full bg-zinc-950 border border-zinc-800/80 rounded-lg p-2.5 text-zinc-100 text-xs focus:outline-none focus:border-amber-500 font-sans resize-none leading-relaxed ${!hasVideo ? 'opacity-50 cursor-not-allowed' : ''}`}
          />
          <label className="text-[10px] text-zinc-300 font-bold flex items-center gap-1 mt-2">
            German text <span className="text-amber-400 font-sans text-[11px]">(de)</span>
          </label>
          <textarea
            rows={3}
            value={selectedClip.captionDe || ''}
            onChange={(e) => onUpdateClip(selectedClip.id, { captionDe: e.target.value })}
            placeholder="Deutsche Zeile (DE-Modus)…"
            disabled={!hasVideo}
            className={`w-full bg-zinc-950 border border-zinc-800/80 rounded-lg p-2.5 text-zinc-100 text-xs focus:outline-none focus:border-amber-500 font-sans resize-none leading-relaxed ${!hasVideo ? 'opacity-50 cursor-not-allowed' : ''}`}
          />
        </div>

        {/* 5. Associated Image Selection */}
        <div className="space-y-1">
          <label className="text-[10px] text-zinc-400 font-semibold flex items-center justify-between gap-1">
            <span className="flex items-center gap-1">
              <ImageIcon className="w-3 h-3 text-amber-400" />
              Clip Image Filename <span className="text-amber-400 font-sans text-[11px]">(image)</span>
            </span>
          </label>
          <div className="flex gap-1.5">
            <input
              type="text"
              value={selectedClip.imageFilename || ''}
              onChange={(e) => onUpdateClip(selectedClip.id, { imageFilename: e.target.value })}
              placeholder="e.g. buzz.png"
              className="flex-1 bg-zinc-950 border border-zinc-800/80 rounded-lg px-2.5 py-1.5 text-zinc-100 font-sans text-xs focus:outline-none focus:border-amber-500"
            />
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => {
                    const primaryCharName = selectedClip.dubCharacters[0];
                    const primaryCharObj = characters.find((c) => c.name === primaryCharName);
                    const autoImg = primaryCharObj
                      ? (primaryCharObj.avatarFilename || `${primaryCharObj.name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}_avatar.png`)
                      : 'default.png';
                    onUpdateClip(selectedClip.id, { imageFilename: autoImg });
                  }}
                  className="px-2.5 py-1.5 bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 hover:border-amber-500/50 text-amber-400 font-bold rounded-lg text-[10px] transition-colors cursor-pointer shrink-0"
                >
                  Auto
                </button>
              </TooltipTrigger>
              <TooltipContent>Reset to primary character's avatar image filename</TooltipContent>
            </Tooltip>
          </div>
        </div>

        {/* 6. Start / End Time numeric controls */}
        <div className="grid grid-cols-2 gap-2 pt-2 border-t border-zinc-800 text-[10px]">
          <div>
            <span className="text-zinc-400 font-medium">Start Time:</span>
            <div className="flex items-center gap-1 mt-1">
              <button
                onClick={() =>
                  onUpdateClip(selectedClip.id, {
                    startTime: Math.max(0, Math.min(selectedClip.endTime - 0.5, selectedClip.startTime - 0.1)),
                  })
                }
                className="p-1 bg-zinc-950 border border-zinc-800 rounded hover:bg-zinc-800 cursor-pointer"
              >
                <ChevronLeft className="w-3 h-3 text-zinc-400" />
              </button>
              <span className="font-sans text-zinc-200 font-bold px-1">{selectedClip.startTime.toFixed(2)}s</span>
              <button
                onClick={() =>
                  onUpdateClip(selectedClip.id, {
                    startTime: Math.min(selectedClip.endTime - 0.5, selectedClip.startTime + 0.1),
                  })
                }
                className="p-1 bg-zinc-950 border border-zinc-800 rounded hover:bg-zinc-800 cursor-pointer"
              >
                <ChevronRight className="w-3 h-3 text-zinc-400" />
              </button>
            </div>
          </div>

          <div>
            <span className="text-zinc-400 font-medium">End Time:</span>
            <div className="flex items-center gap-1 mt-1">
              <button
                onClick={() =>
                  onUpdateClip(selectedClip.id, {
                    endTime: Math.max(selectedClip.startTime + 0.5, selectedClip.endTime - 0.1),
                  })
                }
                className="p-1 bg-zinc-950 border border-zinc-800 rounded hover:bg-zinc-800 cursor-pointer"
              >
                <ChevronLeft className="w-3 h-3 text-zinc-400" />
              </button>
              <span className="font-sans text-zinc-200 font-bold px-1">{selectedClip.endTime.toFixed(2)}s</span>
              <button
                onClick={() => onUpdateClip(selectedClip.id, { endTime: selectedClip.endTime + 0.1 })}
                className="p-1 bg-zinc-950 border border-zinc-800 rounded hover:bg-zinc-800 cursor-pointer"
              >
                <ChevronRight className="w-3 h-3 text-zinc-400" />
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
