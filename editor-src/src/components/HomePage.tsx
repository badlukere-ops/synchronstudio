import React, { useState, useRef } from 'react';
import {
  FolderPlus,
  Upload,
  Clock,
  Users,
  Film,
  Trash2,
  ArrowRight,
  ShieldCheck,
  Search,
} from 'lucide-react';
import { SavedProject, getSavedProjectsList, deleteSavedProject } from '../utils/projectStorage';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';

interface HomePageProps {
  currentActiveProject: SavedProject | null;
  onOpenProject: (project: SavedProject) => void;
  onCreateNewProject: () => void;
  onImportZip: (file: File) => void;
  onDeleteProject?: (id: string) => void;
}

export const HomePage: React.FC<HomePageProps> = ({
  currentActiveProject,
  onOpenProject,
  onCreateNewProject,
  onImportZip,
  onDeleteProject,
}) => {
  const [projectsList, setProjectsList] = useState<SavedProject[]>(getSavedProjectsList());
  const [searchTerm, setSearchTerm] = useState('');
  const zipInputRef = useRef<HTMLInputElement>(null);

  const handleDelete = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    deleteSavedProject(id);
    setProjectsList(getSavedProjectsList());
    if (onDeleteProject) {
      onDeleteProject(id);
    }
  };

  const handleZipFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      onImportZip(file);
    }
    if (zipInputRef.current) {
      zipInputRef.current.value = '';
    }
  };

  const filteredProjects = projectsList.filter(
    (p) =>
      p.title.toLowerCase().includes(searchTerm.toLowerCase()) ||
      p.packInfo?.authors?.some((a) => a.toLowerCase().includes(searchTerm.toLowerCase()))
  );

  return (
    <div className="min-h-screen bg-[#0a0a0b] text-zinc-100 flex flex-col font-sans selection:bg-amber-500/30">
      {/* Hidden ZIP File Input */}
      <input
        type="file"
        accept=".zip"
        ref={zipInputRef}
        className="hidden"
        onChange={handleZipFileChange}
      />

      {/* Main Content Area */}
      <main className="flex-1 max-w-6xl w-full mx-auto px-6 py-8 space-y-8">
        {/* Game Header */}
        <div className="flex justify-center mb-8">
          <img src="https://i.ibb.co/PzjnXrhK/vclogo.png" alt="Game Logo" draggable={false} className="h-20 object-contain" />
        </div>

        {/* Active Project Resume / New Project Banner */}
        {currentActiveProject ? (
          <div className="bg-gradient-to-r from-amber-500/15 via-zinc-900 to-zinc-900 border border-zinc-800 rounded-xl p-5 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 shadow-lg">
            <div className="flex items-center gap-4">
              <img src="https://i.ibb.co/qMLtgW2g/faviconcv.png" alt="Game Logo" draggable={false} className="h-12 w-12 object-contain shrink-0" />
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <span className="inline-flex items-center gap-1 text-[10px] uppercase font-bold text-amber-400 bg-amber-500/20 border border-zinc-800 px-2 py-0.5 rounded-full">
                    <Clock className="w-3 h-3" /> Active Session
                  </span>
                  <span className="text-xs text-zinc-400">
                    Last saved {new Date(currentActiveProject.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </span>
                </div>
                <h2 className="text-lg font-bold text-zinc-100">{currentActiveProject.title || 'Untitled Project'}</h2>
                <p className="text-xs text-zinc-400 flex items-center gap-4">
                  <span className="flex items-center gap-1">
                    <Users className="w-3.5 h-3.5 text-amber-400" />
                    {currentActiveProject.characters?.length || 0} Characters
                  </span>
                  <span className="flex items-center gap-1">
                    <Film className="w-3.5 h-3.5 text-amber-400" />
                    {currentActiveProject.clips?.length || 0} Voice Clips
                  </span>
                </p>
              </div>
            </div>

            <button
              type="button"
              onClick={() => onOpenProject(currentActiveProject)}
              className="bg-[#d97706] hover:bg-[#f59e0b] text-white font-bold px-5 py-2.5 rounded-lg text-xs flex items-center gap-2 transition-all cursor-pointer border-none shadow-md hover:shadow-amber-500/20 shrink-0"
            >
              <span>Continue Editing Work</span>
              <ArrowRight className="w-4 h-4" />
            </button>
          </div>
        ) : (
          <div className="bg-gradient-to-r from-amber-500/15 via-zinc-900 to-zinc-900 border border-zinc-800 rounded-xl p-5 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 shadow-lg">
            <div className="flex items-center gap-4">
              <img src="https://i.ibb.co/qMLtgW2g/faviconcv.png" alt="Game Logo" draggable={false} className="h-12 w-12 object-contain shrink-0" />
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <span className="inline-flex items-center gap-1 text-[10px] uppercase font-bold text-amber-400 bg-amber-500/20 border border-zinc-800 px-2 py-0.5 rounded-full">
                    <FolderPlus className="w-3 h-3" /> Start Fresh
                  </span>
                  <span className="text-xs text-zinc-400">Ready to build</span>
                </div>
                <h2 className="text-lg font-bold text-zinc-100">Create a New Project</h2>
                <p className="text-xs text-zinc-400">
                  Create a new custom dub project for Synchronstudio.
                </p>
              </div>
            </div>

            <button
              type="button"
              onClick={onCreateNewProject}
              className="bg-[#d97706] hover:bg-[#f59e0b] text-white font-bold px-5 py-2.5 rounded-lg text-xs flex items-center gap-2 transition-all cursor-pointer border-none shadow-md hover:shadow-amber-500/20 shrink-0"
            >
              <FolderPlus className="w-4 h-4" />
              <span>Create New Project</span>
              <ArrowRight className="w-4 h-4" />
            </button>
          </div>
        )}

        {/* Quick Action Tiles */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <button
            type="button"
            onClick={onCreateNewProject}
            className="group bg-zinc-900/80 hover:bg-zinc-800/90 border border-zinc-800 hover:border-amber-500/50 rounded-xl p-5 text-left transition-all flex flex-col justify-between h-36 cursor-pointer"
          >
            <div className="flex items-center justify-between">
              <div className="w-10 h-10 rounded-lg bg-amber-500/10 border border-zinc-800 flex items-center justify-center text-amber-400 transition-colors">
                <FolderPlus className="w-5 h-5" />
              </div>
              <span className="text-xs text-zinc-500 group-hover:text-amber-400 transition-colors">Blank Start</span>
            </div>
            <div>
              <h3 className="font-bold text-sm text-zinc-100 group-hover:text-amber-300 transition-colors">
                Create New Modpack
              </h3>
              <p className="text-xs text-zinc-400 mt-1">Start fresh with empty timeline, custom title & characters</p>
            </div>
          </button>

          <button
            type="button"
            onClick={() => {
              if (zipInputRef.current) {
                zipInputRef.current.accept = ".zip";
                zipInputRef.current.click();
              }
            }}
            className="group bg-zinc-900/80 hover:bg-zinc-800/90 border border-zinc-800 hover:border-amber-500/50 rounded-xl p-5 text-left transition-all flex flex-col justify-between h-36 cursor-pointer"
          >
            <div className="flex items-center justify-between">
              <div className="w-10 h-10 rounded-lg bg-amber-500/10 border border-zinc-800 flex items-center justify-center text-amber-400 transition-colors">
                <Upload className="w-5 h-5" />
              </div>
              <span className="text-xs text-zinc-500 group-hover:text-amber-400 transition-colors">Import ZIP</span>
            </div>
            <div>
              <h3 className="font-bold text-sm text-zinc-100 group-hover:text-amber-300 transition-colors">
                Open Existing ZIP Mod
              </h3>
              <p className="text-xs text-zinc-400 mt-1">Import .zip archive containing INI metadata, video & audio</p>
            </div>
          </button>

          <button
            type="button"
            onClick={() => {
              if (zipInputRef.current) {
                zipInputRef.current.accept = ".cvmmd,.json";
                zipInputRef.current.click();
              }
            }}
            className="group bg-zinc-900/80 hover:bg-zinc-800/90 border border-zinc-800 hover:border-amber-500/50 rounded-xl p-5 text-left transition-all flex flex-col justify-between h-36 cursor-pointer"
          >
            <div className="flex items-center justify-between">
              <div className="w-10 h-10 rounded-lg bg-amber-500/10 border border-zinc-800 flex items-center justify-center transition-colors overflow-hidden">
                <img src="https://i.ibb.co/FLHzb9ks/cvmmdfile.png" alt="CVMMD File Icon" className="w-6 h-6 object-contain" referrerPolicy="no-referrer" />
              </div>
              <span className="text-xs text-zinc-500 group-hover:text-amber-400 transition-colors">Import Draft</span>
            </div>
            <div>
              <h3 className="font-bold text-sm text-zinc-100 group-hover:text-amber-300 transition-colors">
                Open CVMMD Project
              </h3>
              <p className="text-xs text-zinc-400 mt-1">Import a .cvmmd draft project to continue editing</p>
            </div>
          </button>
        </div>

        {/* Recent Works Section */}
        <section className="space-y-4 pt-2">
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 border-b border-zinc-800 pb-3">
            <div>
              <h2 className="text-base font-bold text-zinc-100 flex items-center gap-2">
                <Clock className="w-4 h-4 text-amber-400" />
                Recent Works & Projects
              </h2>
              <p className="text-xs text-zinc-400">All your saved dub modpacks stored safely in your browser</p>
            </div>

            {projectsList.length > 0 && (
              <div className="relative w-full sm:w-64">
                <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-500 pointer-events-none" />
                <input
                  type="text"
                  placeholder="Search project title..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="w-full bg-zinc-900 border border-zinc-800 rounded-lg pl-8 pr-3 py-1.5 text-xs text-zinc-200 focus:outline-none focus:border-amber-500/80 transition-colors"
                />
              </div>
            )}
          </div>

          {filteredProjects.length === 0 ? (
            <div className="bg-zinc-900/40 border border-dashed border-zinc-800 rounded-xl p-8 text-center space-y-3">
              <div className="w-12 h-12 rounded-full bg-zinc-800/80 mx-auto flex items-center justify-center text-zinc-500">
                <Clock className="w-6 h-6" />
              </div>
              <p className="text-sm text-zinc-400 font-medium">No recent projects found</p>
              <p className="text-xs text-zinc-500 max-w-sm mx-auto">
                Create a new project or open an existing ZIP archive to start building your voiceover dubs.
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {filteredProjects.map((proj) => (
                <div
                  key={proj.id}
                  onClick={() => onOpenProject(proj)}
                  className="group bg-zinc-900/70 hover:bg-zinc-800/80 border border-zinc-800/80 hover:border-amber-500/40 rounded-xl p-4 transition-all flex flex-col justify-between cursor-pointer space-y-4"
                >
                  <div className="space-y-2">
                    <div className="flex items-start justify-between gap-2">
                      <h3 className="font-bold text-sm text-zinc-100 group-hover:text-amber-300 transition-colors line-clamp-1">
                        {proj.title}
                      </h3>
                      <div className="flex items-center gap-1 opacity-80 group-hover:opacity-100">
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <button
                              type="button"
                              onClick={(e) => handleDelete(proj.id, e)}
                              className="p-1 text-zinc-500 hover:text-red-400 rounded transition-colors"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </TooltipTrigger>
                          <TooltipContent>Delete Saved Work</TooltipContent>
                        </Tooltip>
                      </div>
                    </div>

                    <p className="text-[11px] text-zinc-400 line-clamp-1">
                      Author: {proj.packInfo?.authors?.join(', ') || 'Anonymous'}
                    </p>
                  </div>

                  <div className="flex items-center justify-between text-[11px] text-zinc-400 pt-2 border-t border-zinc-800/60">
                    <div className="flex items-center gap-3">
                      <span className="flex items-center gap-1">
                        <Users className="w-3 h-3 text-amber-400" />
                        {proj.characters?.length || 0}
                      </span>
                      <span className="flex items-center gap-1">
                        <Film className="w-3 h-3 text-amber-400" />
                        {proj.clips?.length || 0} clips
                      </span>
                    </div>
                    <span className="text-[10px] text-zinc-500">
                      {new Date(proj.updatedAt).toLocaleDateString()}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </main>
    </div>
  );
};
