import React, { useEffect, useRef } from 'react';

export interface ContextMenuItem {
  id: string;
  label: string;
  icon?: React.ReactNode;
  shortcut?: string;
  disabled?: boolean;
  danger?: boolean;
  divider?: boolean;
  action?: () => void;
}

interface ContextMenuProps {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}

export const ContextMenu: React.FC<ContextMenuProps> = ({ x, y, items, onClose }) => {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose]);

  // Keep menu within screen boundaries
  const menuWidth = 220;
  const menuHeight = items.length * 36;
  const adjustedX = Math.min(x, window.innerWidth - menuWidth - 10);
  const adjustedY = Math.min(y, window.innerHeight - menuHeight - 10);

  return (
    <div
      ref={menuRef}
      style={{ top: `${adjustedY}px`, left: `${adjustedX}px` }}
      className="fixed z-50 w-56 bg-zinc-900/95 backdrop-blur-md border border-zinc-800/70 rounded-lg shadow-2xl py-1 text-xs text-zinc-200 animate-in fade-in zoom-in-95 duration-100 select-none"
    >
      {items.map((item, idx) => {
        if (item.divider) {
          return <div key={`div_${idx}`} className="my-1 border-t border-zinc-800" />;
        }

        return (
          <button
            key={item.id}
            disabled={item.disabled}
            onClick={() => {
              if (item.disabled) return;
              item.action?.();
              onClose();
            }}
            className={`w-full px-3 py-1.5 flex items-center justify-between text-left transition-colors ${
              item.disabled
                ? 'opacity-40 cursor-not-allowed text-zinc-500'
                : item.danger
                ? 'hover:bg-red-500/20 text-red-400 hover:text-red-300'
                : 'hover:bg-amber-500/15 hover:text-amber-300 text-zinc-200'
            }`}
          >
            <div className="flex items-center gap-2 font-medium">
              {item.icon && <span className="w-4 h-4 flex items-center justify-center">{item.icon}</span>}
              <span>{item.label}</span>
            </div>
            {item.shortcut && (
              <span className="text-[10px] text-zinc-500 font-sans tracking-wider uppercase ml-2">{item.shortcut}</span>
            )}
          </button>
        );
      })}
    </div>
  );
};
