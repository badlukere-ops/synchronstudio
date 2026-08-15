import React, { useState, useRef } from 'react';
import { Users, Plus, Trash2, Tag, Upload, Check, Pencil, X, UserPlus } from 'lucide-react';
import { Character } from '../types';
import { createAvatarSvgDataUrl } from '../utils/sampleData';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';

interface CharacterManagerProps {
  characters: Character[];
  preselectedCharacters: string[];
  activeClipCharacters?: string[];
  onAddCharacter: (char: Character) => void;
  onUpdateCharacter?: (charId: string, updatedChar: Character, oldCharName: string) => void;
  onRemoveCharacter: (id: string) => void;
  onTogglePreselected: (charName: string) => void;
  onAssignToActiveClip?: (charName: string) => void;
  setIsLoading?: (loading: boolean) => void;
  setLoadingMessage?: (msg: string) => void;
}

const PRESET_COLORS = [
  '#8b5cf6', // purple (Buzz)
  '#eab308', // amber (Woody)
  '#22c55e', // green (Rex)
  '#ef4444', // red
  '#3b82f6', // blue
  '#ec4899', // pink
  '#f97316', // orange
  '#06b6d4', // cyan
];

const getDarkBorderColor = (c: string) => {
  return c === '#ef4444' ? '#991b1b'
       : c === '#f97316' ? '#9a3412'
       : c === '#f59e0b' ? '#92400e'
       : c === '#10b981' ? '#065f46'
       : c === '#06b6d4' ? '#155e75'
       : c === '#3b82f6' ? '#1e40af'
       : c === '#8b5cf6' ? '#5b21b6'
       : c === '#ec4899' ? '#9d174d'
       : '#3f3f46';
};

export const CharacterManager: React.FC<CharacterManagerProps> = ({
  characters,
  preselectedCharacters,
  activeClipCharacters = [],
  onAddCharacter,
  onUpdateCharacter,
  onRemoveCharacter,
  onTogglePreselected,
  onAssignToActiveClip,
  setIsLoading,
  setLoadingMessage,
}) => {
  const [isAdding, setIsAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const [selectedColor, setSelectedColor] = useState(PRESET_COLORS[0]);
  const [avatarDataUrl, setAvatarDataUrl] = useState<string | null>(null);
  const [avatarFilename, setAvatarFilename] = useState('');
  const [autoScreenshot, setAutoScreenshot] = useState(false);

  // Editing state
  const [editingCharId, setEditingCharId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editColor, setEditColor] = useState(PRESET_COLORS[0]);
  const [editAvatarDataUrl, setEditAvatarDataUrl] = useState<string | null>(null);
  const [editAvatarFilename, setEditAvatarFilename] = useState('');
  const [editAutoScreenshot, setEditAutoScreenshot] = useState(false);

  const avatarInputRef = useRef<HTMLInputElement>(null);
  const editAvatarInputRef = useRef<HTMLInputElement>(null);

  const handleAvatarUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      if (setIsLoading && setLoadingMessage) {
        setIsLoading(true);
        setLoadingMessage('Uploading character avatar...');
        await new Promise((resolve) => setTimeout(resolve, 400));
        setIsLoading(false);
      }
      setAvatarFilename(file.name);
      const reader = new FileReader();
      reader.onload = (ev) => {
        setAvatarDataUrl(ev.target?.result as string);
      };
      reader.readAsDataURL(file);
    }
  };

  const handleEditAvatarUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      if (setIsLoading && setLoadingMessage) {
        setIsLoading(true);
        setLoadingMessage('Uploading character avatar...');
        await new Promise((resolve) => setTimeout(resolve, 400));
        setIsLoading(false);
      }
      setEditAvatarFilename(file.name);
      const reader = new FileReader();
      reader.onload = (ev) => {
        setEditAvatarDataUrl(ev.target?.result as string);
      };
      reader.readAsDataURL(file);
    }
  };

  const startEditing = (char: Character) => {
    setIsAdding(false);
    setEditingCharId(char.id);
    setEditName(char.name);
    setEditColor(char.color || PRESET_COLORS[0]);
    setEditAvatarDataUrl(char.avatarUrl || null);
    setEditAvatarFilename(char.avatarFilename || '');
    setEditAutoScreenshot(char.autoScreenshot || false);
  };

  const handleSaveEdit = (e: React.FormEvent, char: Character) => {
    e.preventDefault();
    if (!editName.trim()) return;

    const safeName = editName.trim().toLowerCase().replace(/[^a-z0-9]/gi, '_');
    const ext = editAvatarFilename ? (editAvatarFilename.split('.').pop() || 'png') : (char.avatarFilename?.split('.').pop() || 'png');
    const formattedFilename = `${safeName}_avatar.${ext}`;

    const isDicebear = editAvatarDataUrl?.startsWith('https://api.dicebear.com/');
    const avatar = editAutoScreenshot ? createAvatarSvgDataUrl(editName.trim(), editColor) : (editAvatarDataUrl && !isDicebear ? editAvatarDataUrl : createAvatarSvgDataUrl(editName.trim(), editColor));

    const updatedChar: Character = {
      ...char,
      name: editName.trim(),
      avatarFilename: formattedFilename,
      originalFilename: editAvatarFilename || undefined,
      avatarUrl: avatar,
      color: editColor,
      autoScreenshot: editAutoScreenshot,
    };

    if (onUpdateCharacter) {
      onUpdateCharacter(char.id, updatedChar, char.name);
    }

    setEditingCharId(null);
  };

  const handleCreate = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName.trim()) return;

    const safeName = newName.trim().toLowerCase().replace(/[^a-z0-9]/gi, '_');
    const ext = avatarFilename ? (avatarFilename.split('.').pop() || 'png') : 'png';
    const formattedFilename = `${safeName}_avatar.${ext}`;
    const avatar = autoScreenshot ? createAvatarSvgDataUrl(newName.trim(), selectedColor) : (avatarDataUrl || createAvatarSvgDataUrl(newName.trim(), selectedColor));

    const newChar: Character = {
      id: `char_${Date.now()}`,
      name: newName.trim(),
      avatarFilename: formattedFilename,
      originalFilename: avatarFilename || undefined,
      avatarUrl: avatar,
      color: selectedColor,
      autoScreenshot,
    };

    onAddCharacter(newChar);
    setNewName('');
    setAvatarDataUrl(null);
    setAvatarFilename('');
    setAutoScreenshot(false);
    setIsAdding(false);
  };

  return (
    <div className="flex flex-col gap-3 p-4 bg-[#121214] border border-zinc-800/80 rounded-xl text-xs flex-1 min-h-0 h-full">
      <div className="flex items-center justify-between pb-2 border-b border-zinc-800/80 shrink-0">
        <h2 className="font-bold text-zinc-100 flex items-center gap-1.5 uppercase tracking-wide text-[11px] truncate">
          <Users className="w-3.5 h-3.5 text-amber-500 shrink-0" />
          <span className="truncate">Character Roster</span>
        </h2>
        <button
          onClick={() => {
            setEditingCharId(null);
            setIsAdding(!isAdding);
          }}
          className="flex items-center gap-1 text-[11px] font-bold text-amber-500 hover:text-amber-400 transition-colors uppercase tracking-wide shrink-0 cursor-pointer"
        >
          <Plus className="w-3.5 h-3.5" />
          <span>Add Character</span>
        </button>
      </div>

      {/* Add New Character Form - takes full panel when active */}
      {isAdding ? (
        <form onSubmit={handleCreate} className="flex-1 flex flex-col justify-between space-y-3 pr-2 bg-[#121214] p-2 rounded-xl overflow-y-auto [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]">
          <div className="space-y-3 shrink-0">
            <div className="flex items-center justify-between pb-1 border-b border-zinc-800">
              <p className="font-bold text-amber-400 text-xs flex items-center gap-1.5">
                <Plus className="w-3.5 h-3.5" />
                <span>New Character Profile</span>
              </p>
            </div>
            
            <div>
              <label className="text-[10px] text-zinc-400 font-semibold block mb-1">Character Name</label>
              <input
                type="text"
                placeholder="Character Name (e.g., Buzz, Woody)"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-1.5 text-zinc-100 text-xs focus:outline-none focus:border-amber-500"
                autoFocus
              />
            </div>

            <div>
              <label className="text-[10px] text-zinc-400 font-semibold block mb-1">Color Tag</label>
              <div className="flex flex-wrap gap-2">
                {PRESET_COLORS.map((c) => {
                  const isSelected = selectedColor === c;
                  return (
                    <button
                      key={c}
                      type="button"
                      onClick={() => setSelectedColor(c)}
                      style={{ backgroundColor: c }}
                      className={`w-6 h-6 rounded-full flex items-center justify-center transition-all cursor-pointer ${
                        isSelected ? 'scale-110' : 'opacity-80 hover:opacity-100'
                      }`}
                    >
                      {isSelected && <Check className="w-3.5 h-3.5 text-white stroke-[3]" />}
                    </button>
                  );
                })}
              </div>
            </div>

            <div>
              <label className="text-[10px] text-zinc-400 font-semibold block mb-1">Avatar Image</label>
              <button
                type="button"
                onClick={() => avatarInputRef.current?.click()}
                disabled={autoScreenshot}
                className={`w-full text-xs px-3 py-2 rounded-lg flex items-center justify-center gap-2 transition-colors border ${
                  autoScreenshot
                    ? 'bg-zinc-800/40 text-zinc-600 border-zinc-800/50 cursor-not-allowed'
                    : 'bg-zinc-900 text-zinc-300 border-zinc-800 hover:border-zinc-700 hover:text-zinc-100 cursor-pointer'
                }`}
              >
                <Upload className={`w-3.5 h-3.5 ${autoScreenshot ? 'text-zinc-600' : 'text-amber-400'}`} />
                <span className="truncate">{avatarFilename ? avatarFilename : 'Upload Avatar Image (.png/.jpg)'}</span>
              </button>
              <input
                ref={avatarInputRef}
                type="file"
                accept=".png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp"
                className="hidden"
                onChange={handleAvatarUpload}
              />
              <p className="text-[10px] text-zinc-500 mt-1">If no image uploaded, an avatar will be automatically generated.</p>

              {/* Auto Screenshot Toggle */}
              <div
                onClick={() => setAutoScreenshot(!autoScreenshot)}
                className="flex items-center gap-2 cursor-pointer group select-none py-2 px-3 bg-zinc-950 rounded-lg border border-zinc-800 hover:border-zinc-800 transition-colors mt-2"
              >
                <div
                  className={`w-4 h-4 rounded flex items-center justify-center transition-colors shrink-0 ${
                    autoScreenshot
                      ? 'bg-amber-500 text-zinc-950 font-bold'
                      : 'bg-zinc-800 border border-zinc-800 group-hover:border-zinc-500 text-transparent'
                  }`}
                >
                  <Check className="w-3 h-3 stroke-[3]" />
                </div>
                <span className="text-[10px] text-zinc-300 font-semibold group-hover:text-zinc-200 transition-colors">
                  Auto-capture video frame for clips
                </span>
              </div>
            </div>
          </div>

          <div className="flex items-center justify-end gap-2 pt-2 border-t border-zinc-800">
            <button
              type="button"
              onClick={() => setIsAdding(false)}
              className="text-xs text-zinc-400 hover:text-zinc-200 px-3 py-1.5 font-medium cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!newName.trim()}
              className={`text-zinc-950 font-bold px-4 py-1.5 rounded-lg text-xs transition-colors border-0 outline-none ${
                !newName.trim()
                  ? 'bg-zinc-700/50 text-zinc-500 opacity-50 cursor-not-allowed'
                  : 'bg-[#d97706] hover:bg-[#f59e0b] text-white cursor-pointer'
              }`}
            >
              Save Profile
            </button>
          </div>
        </form>
      ) : (
        /* Characters List */
        <div className="space-y-1.5 flex-1 min-h-0 overflow-y-auto pr-1 flex flex-col [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]">
          {characters.length === 0 ? (
            <div className="flex flex-col items-center justify-center my-auto py-8 px-4 text-center text-zinc-500 bg-zinc-900/30 rounded-lg">
              <div className="w-10 h-10 rounded-full bg-zinc-900 border border-zinc-800 flex items-center justify-center mb-2.5 text-zinc-400">
                <UserPlus className="w-5 h-5 text-amber-500/90" />
              </div>
              <p className="text-xs font-bold text-zinc-300">No characters added yet</p>
              <p className="text-[10px] text-zinc-500 mt-1 max-w-[200px] leading-normal">
                Click &quot;Add Character&quot; above to create cast members for your dub pack.
              </p>
            </div>
          ) : (
            characters.map((char) => {
              const isPreselected = preselectedCharacters.includes(char.name);
              const isAssignedToClip = activeClipCharacters.includes(char.name);
              const isEditingThis = editingCharId === char.id;

              if (isEditingThis) {
                return (
                  <form
                    key={char.id}
                    onSubmit={(e) => handleSaveEdit(e, char)}
                    className="bg-zinc-900 p-2.5 rounded border border-amber-500/80 space-y-2 shrink-0"
                  >
                    <div className="flex items-center justify-between">
                      <p className="font-semibold text-amber-400 text-[11px] flex items-center gap-1 truncate">
                        <Pencil className="w-3 h-3 shrink-0" />
                        <span className="truncate">Edit {char.name}</span>
                      </p>
                      <button
                        type="button"
                        onClick={() => setEditingCharId(null)}
                        className="text-zinc-400 hover:text-zinc-200 shrink-0"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>

                    <div>
                      <input
                        type="text"
                        placeholder="Character Name"
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        className="w-full bg-zinc-950 border border-zinc-800 rounded px-2.5 py-1 text-zinc-100 focus:outline-none focus:border-amber-500"
                        autoFocus
                      />
                    </div>

                    <div className="flex items-center gap-2">
                      <span className="text-xs text-zinc-400 font-medium">Color:</span>
                      <div className="flex flex-wrap gap-2">
                        {PRESET_COLORS.map((c) => {
                          const isSelected = editColor === c;
                          return (
                            <button
                              key={c}
                              type="button"
                              onClick={() => setEditColor(c)}
                              style={{ backgroundColor: c }}
                              className={`w-5 h-5 rounded-full flex items-center justify-center transition-transform cursor-pointer ${
                                isSelected ? 'scale-110' : 'opacity-80 hover:opacity-100 hover:scale-105'
                              }`}
                            >
                              {isSelected && <Check className="w-3 h-3 text-white stroke-[3]" />}
                            </button>
                          );
                        })}
                      </div>
                    </div>

                    <div className="flex flex-col gap-2 pt-1">
                      <button
                        type="button"
                        onClick={() => editAvatarInputRef.current?.click()}
                        disabled={editAutoScreenshot}
                        className={`text-xs px-2 py-1.5 rounded flex items-center justify-center gap-1.5 transition-colors border w-full ${
                          editAutoScreenshot
                            ? 'bg-zinc-800/40 text-zinc-600 border-zinc-800/50 cursor-not-allowed'
                            : 'bg-zinc-800 text-zinc-300 border-zinc-700 hover:bg-zinc-700 hover:border-zinc-600 cursor-pointer'
                        }`}
                      >
                        <Upload className={`w-3 h-3 shrink-0 ${editAutoScreenshot ? 'text-zinc-600' : 'text-amber-400'}`} />
                        <span className="truncate">{editAvatarFilename ? 'Change Avatar' : 'Upload Avatar'}</span>
                      </button>
                      <input
                        ref={editAvatarInputRef}
                        type="file"
                        accept=".png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp"
                        className="hidden"
                        onChange={handleEditAvatarUpload}
                      />

                      {/* Auto Screenshot Toggle for Edit */}
                      <div
                        onClick={() => setEditAutoScreenshot(!editAutoScreenshot)}
                        className="flex items-center gap-2 cursor-pointer group select-none py-2 px-3 bg-zinc-950 rounded-lg border border-zinc-800 hover:border-zinc-800 transition-colors"
                      >
                        <div
                          className={`w-4 h-4 rounded flex items-center justify-center transition-colors shrink-0 ${
                            editAutoScreenshot
                              ? 'bg-amber-500 text-zinc-950 font-bold'
                              : 'bg-zinc-800 border border-zinc-800 group-hover:border-zinc-500 text-transparent'
                          }`}
                        >
                          <Check className="w-3 h-3 stroke-[3]" />
                        </div>
                        <span className="text-[10px] text-zinc-300 font-semibold group-hover:text-zinc-200 transition-colors">
                          Auto-capture video frame for clips
                        </span>
                      </div>
                    </div>
                    <div className="flex items-center justify-end gap-1.5 shrink-0 pt-2 border-t border-zinc-800">
                      <div className="flex items-center gap-1.5 shrink-0">
                        <button
                          type="button"
                          onClick={() => setEditingCharId(null)}
                          className="text-xs text-zinc-400 hover:text-zinc-200 px-2 py-1 font-medium"
                        >
                          Cancel
                        </button>
                        <button
                          type="submit"
                          disabled={!editName.trim()}
                          className={`font-bold px-3 py-1 rounded-md text-xs transition-colors border-0 outline-none ${
                            !editName.trim()
                              ? 'bg-zinc-700/50 text-zinc-500 opacity-50 cursor-not-allowed'
                              : 'bg-[#d97706] hover:bg-[#f59e0b] text-white cursor-pointer'
                          }`}
                        >
                          Update
                        </button>
                      </div>
                    </div>
                  </form>
                );
              }

              return (
                <div
                  key={char.id}
                  className="flex items-center justify-between bg-[#121214] p-2 rounded-lg border border-zinc-800 hover:border-zinc-800 transition-colors gap-2 overflow-hidden shrink-0"
                >
                  <div className="flex items-center gap-2 min-w-0 flex-1">
                    <div
                      className="w-8 h-8 rounded-md overflow-hidden shrink-0 border flex items-center justify-center bg-zinc-900"
                      style={{ borderColor: `${char.color}40` }}
                    >
                      {char.avatarUrl ? (
                        <img src={char.avatarUrl} alt={char.name} draggable={false} className="w-full h-full object-cover" />
                      ) : (
                        <img
                          src={createAvatarSvgDataUrl(char.name, char.color)}
                          alt={char.name}
                          draggable={false}
                          className="w-full h-full object-cover"
                        />
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <span className="font-bold text-zinc-200 text-xs flex items-center gap-1.5 truncate">
                        <span className="truncate">{char.name}</span>
                        <span
                          className="w-2 h-2 rounded-full inline-block shrink-0"
                          style={{ backgroundColor: char.color }}
                        />
                      </span>
                      <span className="text-[10px] text-zinc-500 font-medium tracking-wide block opacity-80 mt-0.5 truncate max-w-full">
                        {char.avatarFilename || `${char.name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}_avatar.png`}
                      </span>
                    </div>
                  </div>

                <div className="flex items-center gap-1 shrink-0">
                  {/* Tag on active clip button */}
                  {onAssignToActiveClip && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          onClick={() => onAssignToActiveClip(char.name)}
                          className={`px-1.5 py-0.5 rounded text-[10px] font-medium flex items-center gap-1 transition-colors border cursor-pointer ${
                            isAssignedToClip
                              ? 'bg-amber-500/20 text-amber-300 border-transparent'
                              : 'bg-zinc-800 text-zinc-400 border-transparent hover:text-zinc-200'
                          }`}
                        >
                          <Tag className="w-2.5 h-2.5" />
                          <span>Tag Clip</span>
                        </button>
                      </TooltipTrigger>
                      <TooltipContent>
                        {isAssignedToClip ? 'Assigned to active clip' : 'Tag active clip with character'}
                      </TooltipContent>
                    </Tooltip>
                  )}

                  {/* Preselected dub character toggle */}
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        onClick={() => onTogglePreselected(char.name)}
                        className={`px-1.5 py-0.5 rounded text-[10px] font-medium flex items-center gap-1 border transition-colors cursor-pointer ${
                          isPreselected
                            ? 'bg-emerald-500/20 text-emerald-300 border-transparent'
                            : 'bg-zinc-800 text-zinc-500 border-transparent hover:text-zinc-300'
                        }`}
                      >
                        <Check className="w-3 h-3" />
                        <span>Preselected</span>
                      </button>
                    </TooltipTrigger>
                    <TooltipContent>
                      {isPreselected
                        ? 'Preselected in _pack_info.ini & auto-assigned to new clips'
                        : 'Mark as preselected in _pack_info.ini & default for new clips'}
                    </TooltipContent>
                  </Tooltip>

                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        onClick={() => startEditing(char)}
                        className="p-1 text-zinc-500 hover:text-amber-400 transition-colors"
                      >
                        <Pencil className="w-3 h-3" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent>Edit Character</TooltipContent>
                  </Tooltip>

                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        onClick={() => onRemoveCharacter(char.id)}
                        className="p-1 text-zinc-500 hover:text-red-400 transition-colors"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent>Remove Character</TooltipContent>
                  </Tooltip>
                </div>
              </div>
            );
          })
        )}
      </div>
      )}
    </div>
  );
};
