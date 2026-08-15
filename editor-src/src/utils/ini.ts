import { PackInfo, TimelineClip } from '../types';

/**
 * Format string array as INI array string e.g. ["Woody","Buzz"]
 */
export function formatIniArray(arr: string[]): string {
  const items = arr.map(item => `"${item.replace(/"/g, '\\"')}"`).join(',');
  return `[${items}]`;
}

/**
 * Format numbers array as INI array string e.g. [05.865]
 */
export function formatIniNumberArray(arr: number[]): string {
  const items = arr.map(n => {
    // Format timestamp with 3 decimal places e.g. 05.865 or 5.865
    return n.toFixed(3);
  }).join(',');
  return `[${items}]`;
}

/**
 * Generate _pack_info.ini string
 */
export function generatePackInfoIni(packInfo: PackInfo): string {
  const title = packInfo.title || 'Untitled Pack';
  const icon = packInfo.iconFilename || '_icon.png';
  const authors = packInfo.authors.length > 0 ? packInfo.authors : ['Anonymous'];
  const readme = (packInfo.readme || '').replace(/\r?\n/g, ' ');
  const preselected = packInfo.preselectedDubCharacters.length > 0
    ? packInfo.preselectedDubCharacters
    : [];

  return `[data]

title="${title.replace(/"/g, '\\"')}"
icon="${icon.replace(/"/g, '\\"')}"
authors=${formatIniArray(authors)}
readme="${readme.replace(/"/g, '\\"')}"
preselected_dub_characters=${formatIniArray(preselected)}
`;
}

/**
 * Generate clip INI string (e.g., 01_buzz.ini)
 */
export function generateClipIni(clip: TimelineClip, disableDubTimestamps?: boolean): string {
  const caption = (clip.caption || '').replace(/\r?\n/g, ' ');
  const image = clip.imageFilename || 'default.png';
  const characters = clip.dubCharacters.length > 0 ? clip.dubCharacters : ['Unknown'];

  let content = `[data]\n\ncaption="${caption.replace(/"/g, '\\"')}"\nimage="${image.replace(/"/g, '\\"')}"\n`;
  if (disableDubTimestamps) {
    content += `dub_timestamps=${formatIniNumberArray([Number(clip.startTime.toFixed(3))])}\n`;
  } else {
    const timestamps = clip.dubTimestamps.length > 0 ? clip.dubTimestamps : [Number(clip.startTime.toFixed(3))];
    content += `dub_timestamps=${formatIniNumberArray(timestamps)}\n`;
  }
  content += `dub_characters=${formatIniArray(characters)}\n`;
  return content;
}

/**
 * Apply smart quotes to text (e.g. convert "text" to “text”)
 */
export function applySmartQuotes(str: string): string {
  return str
    .replace(/(^|[\s([{])"/g, '$1“')
    .replace(/"/g, '”')
    .replace(/(^|[\s([{])'/g, '$1‘')
    .replace(/'/g, '’');
}

/**
 * Parse simple INI file key-value pairs
 */
export function parseIniKeyValuePairs(iniText: string): Record<string, string> {
  const result: Record<string, string> = {};
  const lines = iniText.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('[') || trimmed.startsWith(';') || trimmed.startsWith('#')) {
      continue; // Skip empty lines, headers, comments
    }
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx !== -1) {
      const key = trimmed.slice(0, eqIdx).trim().toLowerCase();
      let val = trimmed.slice(eqIdx + 1).trim();
      // If enclosed in double quotes, remove them
      if (val.startsWith('"') && val.endsWith('"') && val.length >= 2) {
        val = val.slice(1, -1).replace(/\\"/g, '"');
      }
      result[key] = val;
    }
  }
  return result;
}

export function parseIniArray(valStr: string): string[] {
  if (!valStr) return [];
  let s = valStr.trim();
  if (s.startsWith('[') && s.endsWith(']')) {
    s = s.slice(1, -1);
  }
  if (!s.trim()) return [];
  // Match quoted items or comma separated items
  const items: string[] = [];
  const regex = /"([^"\\]*(\\.[^"\\]*)*)"|([^,]+)/g;
  let match;
  while ((match = regex.exec(s)) !== null) {
    const item = match[1] !== undefined ? match[1].replace(/\\"/g, '"') : match[3];
    if (item && item.trim()) {
      items.push(item.trim());
    }
  }
  return items;
}

export function parseIniNumberArray(valStr: string): number[] {
  const arr = parseIniArray(valStr);
  return arr.map(item => parseFloat(item)).filter(n => !isNaN(n));
}

export function parsePackInfoIni(iniText: string): Partial<PackInfo> {
  const kv = parseIniKeyValuePairs(iniText);
  return {
    title: kv['title'] || 'Imported Modpack',
    iconFilename: kv['icon'] || '_icon.png',
    authors: parseIniArray(kv['authors'] || '["Anonymous"]'),
    readme: kv['readme'] || '',
    preselectedDubCharacters: parseIniArray(kv['preselected_dub_characters'] || '[]'),
  };
}

export function parseClipIni(iniText: string): Partial<TimelineClip> {
  const kv = parseIniKeyValuePairs(iniText);
  return {
    caption: kv['caption'] || '',
    imageFilename: kv['image'] || 'default.png',
    dubTimestamps: parseIniNumberArray(kv['dub_timestamps'] || '[]'),
    dubCharacters: parseIniArray(kv['dub_characters'] || '[]'),
  };
}

export function getSmartFilenameForCharacter(
  charName: string,
  allClips: TimelineClip[],
  currentClipId?: string
): string {
  if (!charName) return '01_clip';
  const cleanCharName = charName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

  if (!cleanCharName) return '01_clip';

  // Find all other clips assigned to this character
  const otherClips = allClips.filter((c) => {
    if (currentClipId && c.id === currentClipId) return false;
    return c.dubCharacters.some((ch) => {
      const cleanCh = ch.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
      return cleanCh === cleanCharName;
    });
  });

  let maxNum = 0;

  for (const c of otherClips) {
    if (!c.filename) continue;
    const match = c.filename.match(/^(\d+)/);
    if (match) {
      const num = parseInt(match[1], 10);
      if (!isNaN(num) && num > maxNum) {
        maxNum = num;
      }
    }
  }

  const nextNum = maxNum + 1;
  const paddedNum = String(nextNum).padStart(2, '0');
  return `${paddedNum}_${cleanCharName}`;
}

/**
 * Re-indexes clip filenames chronologically for each character so that
 * clips assigned to a character are named sequentially 01_char, 02_char, 03_char...
 * based on their start time order.
 */
export function reindexClipsByCharacter(clips: TimelineClip[], characters: import('../types').Character[] = []): TimelineClip[] {
  const charCounters: Record<string, number> = {};

  // Sort clips by startTime
  const sortedClips = [...clips].sort((a, b) => a.startTime - b.startTime);

  return sortedClips.map((clip) => {
    const primaryChar = clip.dubCharacters[0];
    if (!primaryChar) return clip;

    const cleanChar = primaryChar
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');

    if (!cleanChar) return clip;

    const count = (charCounters[cleanChar] || 0) + 1;
    charCounters[cleanChar] = count;

    const padded = String(count).padStart(2, '0');
    const newFilename = `${padded}_${cleanChar}`;
    
    // Check if autoScreenshot is enabled for this character
    const charObj = characters.find(c => c.name === primaryChar);
    let updatedImageFilename = clip.imageFilename;
    if (charObj?.autoScreenshot) {
      updatedImageFilename = `${cleanChar}_frame_${count}.png`;
    }

    return {
      ...clip,
      filename: newFilename,
      ...(charObj?.autoScreenshot ? { imageFilename: updatedImageFilename } : {})
    };
  });
}
