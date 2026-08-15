import React, { useRef } from 'react';
import { Download, FileText, HelpCircle, Plus, Upload, Home } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { PackInfo } from '../types';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';

interface HeaderProps {
  packInfo: PackInfo;
  view?: 'editor' | 'home';
  onGoHome?: () => void;
  onUpdatePackInfo: (info: Partial<PackInfo>) => void;
  onOpenMetadata: () => void;
  onOpenGuidelines: () => void;
  onExportZip: () => void;
  onExportDraft: () => void;
  onImportDraft: (file: File) => void;
  onReset: () => void;
  isExporting: boolean;
  hasVideo: boolean;
}

export const Header: React.FC<HeaderProps> = ({
  packInfo,
  view = 'editor',
  onGoHome,
  onUpdatePackInfo,
  onOpenMetadata,
  onOpenGuidelines,
  onExportZip,
  onExportDraft,
  onImportDraft,
  onReset,
  isExporting,
  hasVideo,
}) => {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      onImportDraft(file);
    }
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  return (
    <header className="h-16 shrink-0 bg-[#0a0a0b] border-b border-zinc-800/80 px-5 flex items-center justify-between gap-4 select-none overflow-x-auto overflow-y-hidden">
      {/* Brand & App Title */}
      <div className="flex items-center gap-3 shrink-0">
        {onGoHome && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={onGoHome}
                className={`px-3 py-1.5 rounded-lg transition-all flex items-center gap-2 text-xs font-bold cursor-pointer overflow-hidden ${
                  view === 'home'
                    ? 'bg-amber-500/15 text-amber-400 border-transparent'
                    : 'bg-zinc-900 hover:bg-zinc-800 text-zinc-300 hover:text-amber-400 border-transparent'
                }`}
              >
                <Home className="w-4 h-4 shrink-0 text-amber-400" />
                <span className="whitespace-nowrap">
                  {view === 'home' ? 'Editor Workspace' : 'Home'}
                </span>
              </button>
            </TooltipTrigger>
            <TooltipContent>{view === 'home' ? 'Switch to Editor Workspace' : 'Back to Home / Recent Works'}</TooltipContent>
          </Tooltip>
        )}

        <img
          src="https://i.ibb.co/b59hT0xb/mmlogo.png"
          alt="Mod Maker Logo"
          draggable={false}
          className="h-8 object-contain cursor-pointer shrink-0"
          onClick={onGoHome}
        />

        <div className="hidden sm:flex items-center border-l border-zinc-800 pl-3 gap-2 shrink-0">
          <h1 className="text-sm font-bold text-zinc-100 flex items-center gap-2">
            Szenen-Editor
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-500/10 text-amber-400 font-sans border border-zinc-800">
              Sync
            </span>
          </h1>
        </div>
      </div>

      {/* Editable Pack Title & Editing Actions - Only shown when in Editor Mode */}
      {view === 'editor' && (
        <>
          <div className="flex-1 max-w-xs mx-2 shrink">
            <div className="relative flex items-center">
              <input
                type="text"
                value={packInfo.title}
                onChange={(e) => onUpdatePackInfo({ title: e.target.value })}
                placeholder="Scene title"
                className="w-full bg-zinc-900/50 hover:bg-zinc-900 border border-zinc-800 text-zinc-100 text-xs rounded-lg px-3 py-1.5 focus:outline-none focus:border-amber-500/50 focus:ring-2 focus:ring-amber-500/20 font-medium transition-all"
              />
            </div>
          </div>

          {/* Actions */}
          <div className="flex items-center gap-2 shrink-0">
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={onOpenMetadata}
                  className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 text-zinc-300 hover:text-zinc-100 text-xs font-medium border border-zinc-800 transition-colors cursor-pointer"
                >
                  <FileText className="w-3.5 h-3.5 text-amber-400" />
                  <span>Config</span>
                </button>
              </TooltipTrigger>
              <TooltipContent>Configure _pack_info.ini metadata</TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={onOpenGuidelines}
                  className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 text-zinc-300 hover:text-zinc-100 text-xs font-medium border border-zinc-800 transition-colors cursor-pointer"
                >
                  <HelpCircle className="w-3.5 h-3.5 text-amber-400" />
                  <span>Guide</span>
                </button>
              </TooltipTrigger>
              <TooltipContent>Best Practices & .cvmmd Draft info</TooltipContent>
            </Tooltip>

            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold transition-all bg-zinc-800 hover:bg-zinc-700 text-zinc-200 cursor-pointer"
            >
              <Upload className="w-3.5 h-3.5 text-amber-400" />
              <span>Import Draft</span>
            </button>
            <input
              type="file"
              accept=".cvmmd,.json,.zip"
              ref={fileInputRef}
              className="hidden"
              onChange={handleFileChange}
            />

            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={onExportDraft}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold transition-all bg-amber-500/10 hover:bg-amber-500/20 text-amber-300 cursor-pointer"
                >
                  <Download className="w-3.5 h-3.5 text-amber-400" />
                  <span>Export Draft (.cvmmd)</span>
                </button>
              </TooltipTrigger>
              <TooltipContent>Save progress as a lightweight .cvmmd file. Media files need re-linking upon import.</TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <span className="inline-block">
                  <button
                    type="button"
                    onClick={onExportZip}
                    disabled={isExporting || !hasVideo}
                    className={`flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-bold transition-all ${
                      isExporting || !hasVideo
                        ? 'bg-[#d97706]/40 text-white/40 cursor-not-allowed border-none'
                        : 'bg-[#d97706] hover:bg-[#f59e0b] text-white border-none cursor-pointer'
                    }`}
                  >
                    <Download className="w-3.5 h-3.5" />
                    <span>{isExporting ? 'Exporting...' : 'Export Scene (.zip)'}</span>
                  </button>
                </span>
              </TooltipTrigger>
              <TooltipContent>
                {!hasVideo
                  ? 'Please upload a video file first to enable ZIP export.'
                  : 'Package and transcode assets into a standard .zip modpack.'}
              </TooltipContent>
            </Tooltip>
          </div>
        </>
      )}
    </header>
  );
};
