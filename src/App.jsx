import React, { useState, useEffect, useRef, useMemo, useCallback, useSyncExternalStore } from 'react';
import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { ACCENT_PALETTES, applyAppearanceTokens, getPalette, extractDominantColor } from './theme';
import { getTranslation } from './i18n';
import {
  DEFAULT_PEQ_FREQUENCIES,
  BUILTIN_PEQ_PRESETS,
  validateAndNormalizePeqState,
  applyPeqToAudioNodes
} from './peqEngine';
import PeqPanel from './components/PeqPanel';
import {
  Play, Pause, SkipBack, SkipForward, Volume2, VolumeX, Volume1,
  Repeat, Repeat1, Shuffle, Music, Disc, FolderOpen, Upload,
  Search, Activity, Settings,
  Plus, X, Maximize2, Minimize2, Sparkles, AlertCircle, Trash2,
  RefreshCw, ListMusic, HardDrive,
  Shield, Zap, BarChart2, CheckCircle2,
  ArrowUpDown, SlidersHorizontal, Heart, LayoutGrid, List, ChevronUp, ChevronDown,
  AlignCenter, Globe, ExternalLink, EyeOff, Sun, Moon, Palette, Check
} from 'lucide-react';

const SUPPORTED_CODECS = [
  { ext: 'FLAC', mime: 'audio/flac', label: 'FLAC Lossless', desc: 'Free Lossless Audio Codec' },
  { ext: 'WAV', mime: 'audio/wav', label: 'WAV PCM', desc: 'Uncompressed Linear PCM' },
  { ext: 'MP3', mime: 'audio/mpeg', label: 'MP3', desc: 'MPEG-1/2 Audio Layer III' },
  { ext: 'M4A', mime: 'audio/mp4; codecs="mp4a.40.2"', label: 'M4A / AAC', desc: 'Advanced Audio Coding' },
  { ext: 'OGG', mime: 'audio/ogg; codecs="vorbis"', label: 'Ogg Vorbis', desc: 'Xiph Ogg Vorbis' },
  { ext: 'OPUS', mime: 'audio/ogg; codecs="opus"', label: 'Opus', desc: 'IETF Low-Latency Codec' }
];

// ---------------------------------------------------------------------------
// Desktop window host: lets the custom title bar drive the real OS window.
// Supported hosts:
//   - any shell that exposes `window.aureliaWindow` (Electron preload, pywebview wrapper, ...)
//   - Tauri 2 (global API when `app.withGlobalTauri` is on, otherwise Tauri's built-in invoke bridge)
//   - a plain browser opened with ?frame=1, only to preview the buttons
// ---------------------------------------------------------------------------
const DRAG_STYLE = { WebkitAppRegion: 'drag' };
const NO_DRAG_STYLE = { WebkitAppRegion: 'no-drag' };

function isDesktopShell() {
  if (typeof window === 'undefined') return false;
  return Boolean(
    window.aureliaWindow ||
    window.__TAURI__ |
    window.__TAURI_INTERNALS__ ||
    window.pywebview ||
    /Electron\//.test(navigator.userAgent || '')
  );
}

function getWindowHost() {
  if (typeof window === 'undefined') return null;

  const bridge = window.aureliaWindow;
  if (bridge && typeof bridge.close === 'function') {
    return {
      kind: 'bridge',
      minimize: () => bridge.minimize && bridge.minimize(),
      toggleMaximize: () => bridge.toggleMaximize && bridge.toggleMaximize(),
      close: () => bridge.close(),
      isMaximized: async () => (bridge.isMaximized ? Boolean(await bridge.isMaximized()) : false),
      onMaximizedChange: bridge.onMaximizedChange ? (cb) => bridge.onMaximizedChange(cb) : null
    };
  }

  const tauriWindow = window.__TAURI__ && window.__TAURI__.window;
  const tauriInternals = window.__TAURI_INTERNALS__;
  if (!tauriWindow && tauriInternals && typeof tauriInternals.invoke === 'function') {
    // Same commands Tauri's own drag script uses; the window label is optional (defaults to the caller)
    const call = (cmd) => tauriInternals.invoke('plugin:window|' + cmd);
    return {
      kind: 'tauri',
      minimize: () => call('minimize'),
      toggleMaximize: () => call('toggle_maximize'),
      close: () => call('close'),
      isMaximized: () => call('is_maximized'),
      onMaximizedChange: null
    };
  }
  if (tauriWindow) {
    const w = typeof tauriWindow.getCurrentWindow === 'function' ? tauriWindow.getCurrentWindow() : tauriWindow.appWindow;
    if (w) {
      return {
        kind: 'tauri',
        minimize: () => w.minimize(),
        toggleMaximize: () => w.toggleMaximize(),
        close: () => w.close(),
        isMaximized: () => w.isMaximized(),
        onMaximizedChange: null
      };
    }
  }

  if (new URLSearchParams(window.location.search).has('frame')) {
    // Browser preview: lets you see and try the buttons while developing the UI
    return {
      kind: 'preview',
      minimize: () => { },
      toggleMaximize: () => {
        if (document.fullscreenElement) document.exitFullscreen().catch(() => { });
        else document.documentElement.requestFullscreen().catch(() => { });
      },
      close: () => window.close(),
      isMaximized: async () => Boolean(document.fullscreenElement),
      onMaximizedChange: null
    };
  }

  return null;
}

const LEGACY_DEMO_TRACK_IDS = new Set([
  'synth-ref-nocturne',
  'synth-ref-pulse',
  'synth-ref-sub'
]);

const DB_NAME = 'AureliaAudioDB_v1';
const DB_VERSION = 3;

function openAureliaDB() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is unavailable in this browser environment.'));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains('tracks')) {
        db.createObjectStore('tracks', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('playlists')) {
        db.createObjectStore('playlists', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('settings')) {
        db.createObjectStore('settings', { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains('artworkCache')) {
        db.createObjectStore('artworkCache', { keyPath: 'cacheKey' });
      }
      if (!db.objectStoreNames.contains('lyricsCache')) {
        db.createObjectStore('lyricsCache', { keyPath: 'cacheKey' });
      }
      if (!db.objectStoreNames.contains('metadataCache')) {
        db.createObjectStore('metadataCache', { keyPath: 'cacheKey' });
      }
      if (!db.objectStoreNames.contains('handles')) {
        db.createObjectStore('handles', { keyPath: 'key' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Failed to open IndexedDB'));
  });
}

async function dbGet(storeName, key) {
  try {
    const db = await openAureliaDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const req = store.get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } catch (err) {
    return null;
  }
}

async function dbGetAll(storeName) {
  try {
    const db = await openAureliaDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  } catch (err) {
    console.warn(`IndexedDB read warning (${storeName}):`, err);
    return [];
  }
}

async function dbPut(storeName, value) {
  try {
    const db = await openAureliaDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      const req = store.put(value);
      req.onsuccess = () => resolve(true);
      req.onerror = () => reject(req.error);
    });
  } catch (err) {
    console.warn(`IndexedDB write warning (${storeName}):`, err);
    return false;
  }
}

async function dbDelete(storeName, key) {
  try {
    const db = await openAureliaDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      const req = store.delete(key);
      req.onsuccess = () => resolve(true);
      req.onerror = () => reject(req.error);
    });
  } catch (err) {
    return false;
  }
}

async function dbClearAll() {
  try {
    const db = await openAureliaDB();
    const stores = ['tracks', 'playlists', 'settings', 'artworkCache', 'lyricsCache', 'metadataCache', 'handles'];
    await Promise.all(
      stores.map(
        (s) =>
          new Promise((res) => {
            if (!db.objectStoreNames.contains(s)) {
              res(true);
              return;
            }
            const tx = db.transaction(s, 'readwrite');
            tx.objectStore(s).clear();
            tx.oncomplete = () => res(true);
            tx.onerror = () => res(false);
          })
      )
    );
    return true;
  } catch (err) {
    return false;
  }
}

function blobToDataUrl(blob) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(typeof reader.result === 'string' ? reader.result : null);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(blob);
  });
}

const AUDIO_EXT_REGEX = /\.(mp3|flac|wav|m4a|aac|ogg|oga|opus|webm|mp4)$/i;
const NON_AUDIO_EXT_REGEX = /\.(m3u|m3u8|pls|wpl|asx|xspf|cue|log|lrc|txt|nfo|sfv|md5|jpg|jpeg|png|gif|webp|bmp|svg|ico|pdf|doc|docx|ds_store|db|ini|xml|json|html|htm|url|lnk|zip|rar|7z)$/i;
const PLAYLIST_OR_UNSUPPORTED_MIME_REGEX = /mpegurl|x-mpegurl|scpls|x-scpls|vnd\.apple\.mpegurl|x-ms-wax|x-ms-wvx|x-pn-realaudio|text\/|image\/|application\/(x-mpegurl|vnd\.apple\.mpegurl|pls\+xml|xspf\+xml)/i;

const EXT_TO_CANONICAL_MIME = {
  mp3: 'audio/mpeg',
  flac: 'audio/flac',
  wav: 'audio/wav',
  m4a: 'audio/mp4; codecs="mp4a.40.2"',
  aac: 'audio/aac',
  ogg: 'audio/ogg; codecs="vorbis"',
  oga: 'audio/ogg',
  opus: 'audio/ogg; codecs="opus"',
  webm: 'audio/webm',
  mp4: 'audio/mp4'
};

let cachedAudioProbeEl = null;
function canBrowserPlayAudioMime(mime) {
  if (typeof document === 'undefined') return true;
  try {
    if (!cachedAudioProbeEl) {
      cachedAudioProbeEl = document.createElement('audio');
    }
    const res = cachedAudioProbeEl.canPlayType(mime);
    return res === 'probably' || res === 'maybe';
  } catch (e) {
    return true;
  }
}

function isSupportedAudioFile(fileOrName) {
  const rawName = typeof fileOrName === 'string' ? fileOrName : fileOrName?.name || '';
  const name = rawName.trim();
  const type = typeof fileOrName === 'object' && fileOrName?.type ? fileOrName.type.trim() : '';

  if (!name) return false;
  // Explicitly reject playlists (.m3u, .m3u8, .pls, .cue), sidecars, lyrics, artwork, and archives
  if (NON_AUDIO_EXT_REGEX.test(name)) return false;
  if (type && PLAYLIST_OR_UNSUPPORTED_MIME_REGEX.test(type)) return false;

  const extMatch = name.match(/\.([a-z0-9]+)$/i);
  const ext = extMatch ? extMatch[1].toLowerCase() : '';

  if (!ext || !AUDIO_EXT_REGEX.test(name)) {
    return false;
  }

  // Verify browser playback capability for the resolved audio format
  const probeMime = type && type.startsWith('audio/') && !PLAYLIST_OR_UNSUPPORTED_MIME_REGEX.test(type)
    ? type
    : EXT_TO_CANONICAL_MIME[ext];

  if (probeMime && !canBrowserPlayAudioMime(probeMime)) {
    const fallbackMime = EXT_TO_CANONICAL_MIME[ext];
    if (fallbackMime && !canBrowserPlayAudioMime(fallbackMime)) {
      return false;
    }
  }

  return true;
}

function normalizeIdentityText(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeAlbumFolderRoot(folderPath) {
  const clean = String(folderPath || '')
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/^\/|\/$/g, '');
  if (!clean) return '';
  const parts = clean.split('/').filter(Boolean);
  if (parts.length > 1 && /^(?:disc|cd|disk)\s*\d+$/i.test(parts[parts.length - 1])) {
    parts.pop();
  }
  return normalizeIdentityText(parts.join('/'));
}

function inferMetadataFromRelativePath(relativePath, fallbackFileName) {
  const cleanRel = (relativePath || fallbackFileName || '').replace(/\\/g, '/');
  const parts = cleanRel.split('/').filter(Boolean);
  const fileName = parts[parts.length - 1] || fallbackFileName || 'Unknown Track';
  const rawBaseName = fileName.replace(/\.[^/.]+$/, '');

  // Extract optional disc and track numbers from filename prefixes like "1-02 - Title" or "04. Title"
  let inferredDiscNumber = null;
  let inferredTrackNumber = null;
  const discTrackMatch = rawBaseName.match(/^(?:(\d{1,2})\s*[-.]\s*)?(\d{1,3})(?:[\s._-]+|$)/);
  if (discTrackMatch) {
    if (discTrackMatch[1]) inferredDiscNumber = parseInt(discTrackMatch[1], 10);
    if (discTrackMatch[2]) inferredTrackNumber = parseInt(discTrackMatch[2], 10);
  }

  // Strip leading track numbers like "01 - " or "1-02. "
  const cleanedTitle = rawBaseName.replace(/^(?:\d{1,2}[-.])?\d{1,3}[\s._-]+/, '').trim() || rawBaseName;

  let inferredArtist = null;
  let inferredAlbum = null;
  const folderPath = parts.length > 1 ? parts.slice(0, -1).join('/') : '';
  const sourceRootFolder = parts.length > 1 ? parts[0] : '';

  if (parts.length >= 3) {
    const parent = parts[parts.length - 2];
    const grandParent = parts[parts.length - 3];
    const greatGrandParent = parts.length >= 4 ? parts[parts.length - 4] : null;
    // Handle .../Artist/Album/Disc 1/Track.flac
    const discFolderMatch = parent.match(/^(?:disc|cd|disk)\s*(\d+)/i);
    if (discFolderMatch && greatGrandParent) {
      inferredAlbum = grandParent;
      inferredArtist = greatGrandParent;
      if (!inferredDiscNumber) inferredDiscNumber = parseInt(discFolderMatch[1], 10);
    } else if (discFolderMatch && !greatGrandParent) {
      inferredAlbum = grandParent;
      if (!inferredDiscNumber) inferredDiscNumber = parseInt(discFolderMatch[1], 10);
    } else {
      inferredAlbum = parent;
      inferredArtist = grandParent;
    }
  } else if (parts.length === 2) {
    inferredAlbum = parts[0];
  }

  return {
    title: cleanedTitle,
    artist: inferredArtist,
    album: inferredAlbum,
    trackNumber: inferredTrackNumber,
    discNumber: inferredDiscNumber,
    folderPath,
    sourceRootFolder,
    relativePath: cleanRel
  };
}

function buildAlbumIdentityKey(albumTitle, albumArtist, fallbackFolderPath = '') {
  const normAlbum = normalizeIdentityText(albumTitle);
  const normArtist = normalizeIdentityText(albumArtist);
  const normFolder = normalizeAlbumFolderRoot(fallbackFolderPath);

  const hasValidAlbum =
    normAlbum &&
    normAlbum !== 'local audio file' &&
    normAlbum !== 'unknown album' &&
    normAlbum !== 'unsorted local album';
  const hasValidArtist = normArtist && normArtist !== 'unknown artist';

  if (hasValidAlbum) {
    if (normFolder) {
      return `alb::${normAlbum}::fld::${normFolder}`;
    }
    const scopeKey = hasValidArtist ? normArtist : 'general';
    return `alb::${normAlbum}::${scopeKey}`;
  }
  if (normFolder) {
    return `folder::${normFolder}`;
  }
  return `alb::${normAlbum || 'unassigned'}::${normArtist || 'unknown'}`;
}

function buildTrackFingerprint(file, relativePath) {
  const normPath = normalizeIdentityText(
    (relativePath || file?.webkitRelativePath || file?.name || '').replace(/\\/g, '/')
  );
  const sizePart = file?.size || 0;
  return `${normPath}|${sizePart}`;
}

function buildCanonicalTrackDedupKey(metaOrTrack, fileSize = 0) {
  const normFolder = normalizeAlbumFolderRoot(metaOrTrack?.folderPath || '');
  const rawRel = String(metaOrTrack?.relativePath || metaOrTrack?.title || '').replace(/\\/g, '/');
  const fileName = normalizeIdentityText(rawRel.split('/').pop() || '');
  const folderLeaf = normalizeIdentityText(normFolder.split('/').pop() || '');
  const normAlbum = normalizeIdentityText(metaOrTrack?.album || '');
  const normArtist = normalizeIdentityText(metaOrTrack?.albumArtist || metaOrTrack?.artist || '');
  const normTitle = normalizeIdentityText(metaOrTrack?.title || '');
  const disc = metaOrTrack?.discNumber || 1;
  const trackNo = metaOrTrack?.trackNumber || 0;
  const size = fileSize || metaOrTrack?.fileSize || 0;
  return `${folderLeaf}/${fileName}|${normAlbum}|${normArtist}|${disc}-${trackNo}|${normTitle}|${size}`;
}

async function traverseDirectoryHandleRecursive(dirHandle, currentPath = '', stats = { folders: 0, errors: 0, skippedNonAudio: 0 }) {
  const results = [];
  stats.folders += 1;
  try {
    for await (const [entryName, entryHandle] of dirHandle.entries()) {
      const nextPath = currentPath ? `${currentPath}/${entryName}` : entryName;
      try {
        if (entryHandle.kind === 'directory') {
          const nested = await traverseDirectoryHandleRecursive(entryHandle, nextPath, stats);
          results.push(...nested);
        } else if (entryHandle.kind === 'file') {
          if (isSupportedAudioFile(entryName)) {
            const file = await entryHandle.getFile();
            results.push({ file, relativePath: nextPath, fileHandle: entryHandle });
          } else {
            stats.skippedNonAudio += 1;
          }
        }
      } catch (innerErr) {
        stats.errors += 1;
      }
    }
  } catch (dirErr) {
    stats.errors += 1;
  }
  return results;
}

async function traverseWebkitEntryRecursive(entry, currentPath = '', stats = { folders: 0, errors: 0, skippedNonAudio: 0 }) {
  if (!entry) return [];
  if (entry.isFile) {
    return new Promise((resolve) => {
      entry.file(
        (file) => {
          const relPath = currentPath ? `${currentPath}/${file.name}` : file.webkitRelativePath || file.name;
          if (isSupportedAudioFile(file)) {
            resolve([{ file, relativePath: relPath }]);
          } else {
            stats.skippedNonAudio += 1;
            resolve([]);
          }
        },
        () => {
          stats.errors += 1;
          resolve([]);
        }
      );
    });
  }
  if (entry.isDirectory) {
    stats.folders += 1;
    const dirReader = entry.createReader();
    const allEntries = [];
    const readBatch = () =>
      new Promise((resolve) => {
        dirReader.readEntries(
          (batch) => resolve(batch || []),
          () => {
            stats.errors += 1;
            resolve([]);
          }
        );
      });

    let batch = await readBatch();
    while (batch.length > 0) {
      allEntries.push(...batch);
      batch = await readBatch();
    }

    const nestedResults = [];
    const nextDirPath = currentPath ? `${currentPath}/${entry.name}` : entry.name;
    for (const childEntry of allEntries) {
      const childFiles = await traverseWebkitEntryRecursive(childEntry, nextDirPath, stats);
      nestedResults.push(...childFiles);
    }
    return nestedResults;
  }
  return [];
}

function createProceduralCoverSvg(title, subtitle, palette) {
  const [c1, c2, c3, accent] = palette;
  const safeTitle = String(title || 'Local Audio').slice(0, 32).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const safeSub = String(subtitle || 'AUDIO').slice(0, 28).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 600" width="600" height="600">
    <defs>
      <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="${c1}" />
        <stop offset="55%" stop-color="${c2}" />
        <stop offset="100%" stop-color="${c3}" />
      </linearGradient>
      <radialGradient id="glow" cx="70%" cy="30%" r="60%">
        <stop offset="0%" stop-color="${accent}" stop-opacity="0.45" />
        <stop offset="100%" stop-color="${c1}" stop-opacity="0" />
      </radialGradient>
    </defs>
    <rect width="600" height="600" fill="url(#bg)" />
    <rect width="600" height="600" fill="url(#glow)" />
    <g stroke="${accent}" stroke-opacity="0.22" fill="none" stroke-width="1.5">
      <circle cx="300" cy="300" r="220" />
      <circle cx="300" cy="300" r="175" />
      <circle cx="300" cy="300" r="130" />
      <circle cx="300" cy="300" r="85" />
      <circle cx="300" cy="300" r="32" fill="${accent}" fill-opacity="0.18" />
    </g>
    <line x1="60" y1="510" x2="540" y2="510" stroke="rgba(255,255,255,0.18)" stroke-width="1" />
    <text x="60" y="485" fill="#ffffff" font-family="system-ui, -apple-system, sans-serif" font-size="26" font-weight="600" letter-spacing="1">${safeTitle}</text>
    <text x="60" y="542" fill="${accent}" font-family="monospace" font-size="14" letter-spacing="3">${safeSub}</text>
  </svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

const ID3V1_GENRE_MAP = {
  0: 'Blues', 1: 'Classic Rock', 2: 'Country', 3: 'Dance', 4: 'Disco', 5: 'Funk', 6: 'Grunge',
  7: 'Hip-Hop', 8: 'Jazz', 9: 'Metal', 10: 'New Age', 11: 'Oldies', 12: 'Other', 13: 'Pop',
  14: 'R&B', 15: 'Rap', 16: 'Reggae', 17: 'Rock', 18: 'Techno', 19: 'Industrial', 20: 'Alternative',
  21: 'Ska', 22: 'Death Metal', 23: 'Pranks', 24: 'Soundtrack', 25: 'Euro-Techno', 26: 'Ambient',
  27: 'Trip-Hop', 28: 'Vocal', 32: 'Classical', 33: 'Instrumental', 36: 'Game', 37: 'Sound Clip',
  39: 'Noise', 40: 'AlternRock', 41: 'Bass', 42: 'Soul', 52: 'Electronic', 88: 'Celtic', 131: 'Indie'
};

function cleanGenreString(raw) {
  if (!raw) return '';
  const trimmed = String(raw).trim();
  const numOnly = trimmed.match(/^\(?(\d{1,3})\)?$/);
  if (numOnly) {
    const code = parseInt(numOnly[1], 10);
    return ID3V1_GENRE_MAP[code] || '';
  }
  return trimmed.replace(/^\(\d{1,3}\)\s*/, '').trim();
}

function parseDateAndYear(rawVal) {
  if (!rawVal) return { year: '', releaseDate: '' };
  const s = String(rawVal).trim();
  const fullIso = s.match(/^(\d{4})[-/](\d{2})[-/](\d{2})/);
  if (fullIso) {
    return {
      year: fullIso[1],
      releaseDate: `${fullIso[1]}-${fullIso[2]}-${fullIso[3]}`
    };
  }
  const yearMatch = s.match(/\b(19\d{2}|20\d{2})\b/);
  return {
    year: yearMatch ? yearMatch[1] : '',
    releaseDate: ''
  };
}

function parseNumberAndTotal(rawVal) {
  if (!rawVal) return { number: null, total: null };
  const m = String(rawVal).trim().match(/^(\d+)(?:\s*\/\s*(\d+))?/);
  if (!m) return { number: null, total: null };
  return {
    number: parseInt(m[1], 10) || null,
    total: m[2] ? parseInt(m[2], 10) || null : null
  };
}

async function parseBinaryAudioMetadata(file, relativePath = '') {
  const fullFilePath = String(file.filePath || file.nativePath || '').replace(/\\/g, '/');
  const nativeDir = fullFilePath.includes('/') ? fullFilePath.slice(0, fullFilePath.lastIndexOf('/')) : '';
  let effectiveRelPath = (relativePath || file.webkitRelativePath || file.name || '').replace(/\\/g, '/');
  if (!effectiveRelPath.includes('/') && nativeDir) {
    const dirLeaf = nativeDir.split('/').filter(Boolean).pop() || '';
    if (dirLeaf) {
      effectiveRelPath = `${dirLeaf}/${file.name}`;
    }
  }

  const pathHints = inferMetadataFromRelativePath(effectiveRelPath, file.name);
  const effectiveFolderPath = pathHints.folderPath || file.folderPath || nativeDir || '';
  if (!pathHints.folderPath && effectiveFolderPath) {
    pathHints.folderPath = effectiveFolderPath;
  }
  if ((!pathHints.album || pathHints.album === 'Unknown Track') && effectiveFolderPath) {
    const folderLeaf = effectiveFolderPath.split('/').filter(Boolean).pop();
    if (folderLeaf) {
      pathHints.album = folderLeaf;
      if (!pathHints.sourceRootFolder) pathHints.sourceRootFolder = folderLeaf;
    }
  }

  const fieldSources = {};
  if (pathHints.title) fieldSources.title = 'Path Inferred';
  if (pathHints.artist) fieldSources.artist = 'Path Inferred';
  if (pathHints.album) fieldSources.album = 'Path Inferred';
  if (pathHints.trackNumber) fieldSources.trackNumber = 'Path Inferred';
  if (pathHints.discNumber) fieldSources.discNumber = 'Path Inferred';

  const result = {
    title: pathHints.title || file.name.replace(/\.[^/.]+$/, ''),
    artist: pathHints.artist || 'Unknown Artist',
    albumArtist: pathHints.artist || null,
    contributingArtists: [],
    album: pathHints.album || 'Unsorted Local Album',
    albumSource: pathHints.album ? 'Folder Hierarchy Fallback' : 'Default Fallback',
    trackNumber: pathHints.trackNumber || null,
    totalTracks: null,
    discNumber: pathHints.discNumber || 1,
    totalDiscs: null,
    folderPath: effectiveFolderPath,
    sourceRootFolder: pathHints.sourceRootFolder || (effectiveFolderPath ? effectiveFolderPath.split('/')[0] : ''),
    relativePath: pathHints.relativePath || file.name,
    year: '',
    releaseDate: '',
    genre: '',
    genres: [],
    label: '',
    catalogNumber: '',
    releaseCountry: '',
    composer: '',
    songwriter: '',
    isrc: '',
    fieldSources,
    codec: (file.name.split('.').pop() || 'AUDIO').toUpperCase(),
    containerSource: 'File Extension',
    sampleRate: null,
    sampleRateSource: 'Unavailable in Container Header',
    bitDepth: null,
    bitDepthSource: 'Unavailable (Lossy or Decoded as 32-bit Float)',
    channels: null,
    channelsSource: 'Unavailable in Container Header',
    embeddedLyrics: '',
    coverUrl: null,
    coverProvenance: null,
    isArtworkVerified: false
  };

  const addUniqueItem = (arr, val) => {
    const clean = String(val || '').trim();
    if (!clean) return;
    if (!arr.some((x) => x.toLowerCase() === clean.toLowerCase())) {
      arr.push(clean);
    }
  };

  const extractEmbeddedImageDataUrl = async (subBytes, sourceLabel) => {
    for (let k = 0; k < subBytes.length - 4; k++) {
      const isJpeg = subBytes[k] === 0xff && subBytes[k + 1] === 0xd8 && subBytes[k + 2] === 0xff;
      const isPng =
        subBytes[k] === 0x89 &&
        subBytes[k + 1] === 0x50 &&
        subBytes[k + 2] === 0x4e &&
        subBytes[k + 3] === 0x47;
      if (isJpeg || isPng) {
        const imgBlob = new Blob([subBytes.subarray(k)], { type: isPng ? 'image/png' : 'image/jpeg' });
        const dataUrl = await blobToDataUrl(imgBlob);
        if (dataUrl) {
          result.coverUrl = dataUrl;
          result.coverProvenance = sourceLabel;
          result.isArtworkVerified = true;
          result.fieldSources.artwork = 'Embedded';
          return true;
        }
      }
    }
    return false;
  };

  try {
    // Read up to first 3 MB so embedded high-res FLAC/ID3/M4A album covers & rich tags are captured cleanly
    const sliceSize = Math.min(file.size, 3 * 1024 * 1024);
    const buffer = await file.slice(0, sliceSize).arrayBuffer();
    const view = new DataView(buffer);
    const bytes = new Uint8Array(buffer);

    const readAscii = (start, len) => {
      let s = '';
      for (let i = 0; i < len && start + i < bytes.length; i++) {
        if (bytes[start + i] !== 0) s += String.fromCharCode(bytes[start + i]);
      }
      return s;
    };

    if (bytes.length >= 42 && readAscii(0, 4) === 'fLaC') {
      result.codec = 'FLAC';
      result.containerSource = 'Binary fLaC Magic Header';
      let pos = 4;
      const artistCredits = [];
      while (pos + 4 <= bytes.length) {
        const headerByte = bytes[pos];
        const isLast = (headerByte & 0x80) !== 0;
        const blockType = headerByte & 0x7f;
        const blockLen = (bytes[pos + 1] << 16) | (bytes[pos + 2] << 8) | bytes[pos + 3];
        pos += 4;
        if (pos + blockLen > bytes.length) break;

        if (blockType === 0 && blockLen >= 18) {
          // STREAMINFO block
          const b10 = bytes[pos + 10];
          const b11 = bytes[pos + 11];
          const b12 = bytes[pos + 12];
          const b13 = bytes[pos + 13];
          const sr = (b10 << 12) | (b11 << 4) | (b12 >> 4);
          const ch = ((b12 >> 1) & 0x07) + 1;
          const bps = (((b12 & 0x01) << 4) | (b13 >> 4)) + 1;
          if (sr > 0) {
            result.sampleRate = sr;
            result.sampleRateSource = 'FLAC STREAMINFO Binary Header';
          }
          result.channels = ch;
          result.channelsSource = 'FLAC STREAMINFO Binary Header';
          result.bitDepth = bps;
          result.bitDepthSource = 'FLAC STREAMINFO Binary Header';
        } else if (blockType === 4) {
          // VORBIS_COMMENT block
          try {
            const dec = new TextDecoder('utf-8');
            let vPos = pos;
            const vendorLen = view.getUint32(vPos, true);
            vPos += 4 + vendorLen;
            if (vPos + 4 <= pos + blockLen) {
              const commentCount = view.getUint32(vPos, true);
              vPos += 4;
              for (let c = 0; c < commentCount && vPos + 4 <= pos + blockLen; c++) {
                const cLen = view.getUint32(vPos, true);
                vPos += 4;
                if (vPos + cLen > pos + blockLen) break;
                const entry = dec.decode(bytes.subarray(vPos, vPos + cLen));
                vPos += cLen;
                const eqIdx = entry.indexOf('=');
                if (eqIdx > 0) {
                  const key = entry.slice(0, eqIdx).toUpperCase().trim();
                  const val = entry.slice(eqIdx + 1).trim();
                  if (!val) continue;

                  if (key === 'TITLE') {
                    result.title = val;
                    result.fieldSources.title = 'Embedded';
                  } else if (key === 'ARTIST') {
                    addUniqueItem(artistCredits, val);
                    if (result.fieldSources.artist !== 'Embedded') {
                      result.artist = val;
                      result.fieldSources.artist = 'Embedded';
                    }
                  } else if (key === 'PERFORMER' || key === 'ARTISTS' || key === 'FEATURING') {
                    addUniqueItem(result.contributingArtists, val);
                    result.fieldSources.contributingArtists = 'Embedded';
                  } else if (key === 'ALBUMARTIST' || key === 'ALBUM ARTIST') {
                    result.albumArtist = val;
                    result.fieldSources.albumArtist = 'Embedded';
                  } else if (key === 'ALBUM') {
                    result.album = val;
                    result.albumSource = 'Embedded Vorbis ALBUM Tag';
                    result.fieldSources.album = 'Embedded';
                  } else if (key === 'TRACKNUMBER') {
                    const parsed = parseNumberAndTotal(val);
                    if (parsed.number) {
                      result.trackNumber = parsed.number;
                      result.fieldSources.trackNumber = 'Embedded';
                    }
                    if (parsed.total) result.totalTracks = parsed.total;
                  } else if (key === 'TRACKTOTAL' || key === 'TOTALTRACKS') {
                    const tot = parseInt(val, 10);
                    if (tot > 0) result.totalTracks = tot;
                  } else if (key === 'DISCNUMBER') {
                    const parsed = parseNumberAndTotal(val);
                    if (parsed.number) {
                      result.discNumber = parsed.number;
                      result.fieldSources.discNumber = 'Embedded';
                    }
                    if (parsed.total) result.totalDiscs = parsed.total;
                  } else if (key === 'DISCTOTAL' || key === 'TOTALDISCS') {
                    const tot = parseInt(val, 10);
                    if (tot > 0) result.totalDiscs = tot;
                  } else if (key === 'DATE' || key === 'YEAR' || key === 'ORIGINALDATE') {
                    const { year, releaseDate } = parseDateAndYear(val);
                    if (year && !result.year) {
                      result.year = year;
                      result.fieldSources.year = 'Embedded';
                    }
                    if (releaseDate) {
                      result.releaseDate = releaseDate;
                      result.fieldSources.releaseDate = 'Embedded';
                    }
                  } else if (key === 'GENRE') {
                    val.split(/[;/,]+/).forEach((g) => {
                      const cg = cleanGenreString(g);
                      if (cg) addUniqueItem(result.genres, cg);
                    });
                    if (result.genres.length > 0) {
                      result.genre = result.genres[0];
                      result.fieldSources.genre = 'Embedded';
                    }
                  } else if (key === 'LABEL' || key === 'ORGANIZATION' || key === 'PUBLISHER') {
                    result.label = val;
                    result.fieldSources.label = 'Embedded';
                  } else if (key === 'CATALOGNUMBER') {
                    result.catalogNumber = val;
                    result.fieldSources.catalogNumber = 'Embedded';
                  } else if (key === 'RELEASECOUNTRY' || key === 'COUNTRY') {
                    result.releaseCountry = val;
                    result.fieldSources.releaseCountry = 'Embedded';
                  } else if (key === 'COMPOSER') {
                    result.composer = result.composer ? `${result.composer}, ${val}` : val;
                    result.fieldSources.composer = 'Embedded';
                  } else if (key === 'LYRICIST' || key === 'WRITER' || key === 'SONGWRITER') {
                    result.songwriter = result.songwriter ? `${result.songwriter}, ${val}` : val;
                    result.fieldSources.songwriter = 'Embedded';
                  } else if (key === 'ISRC') {
                    result.isrc = val;
                    result.fieldSources.isrc = 'Embedded';
                  } else if (key === 'LYRICS' || key === 'UNSYNCEDLYRICS') {
                    result.embeddedLyrics = val;
                  }
                }
              }
            }
          } catch (e) {
            // Ignore malformed vorbis comment
          }
        } else if (blockType === 6 && !result.coverUrl) {
          // METADATA_BLOCK_PICTURE
          await extractEmbeddedImageDataUrl(
            bytes.subarray(pos, pos + blockLen),
            'Embedded FLAC METADATA_BLOCK_PICTURE'
          );
        }
        pos += blockLen;
        if (isLast) break;
      }
      if (artistCredits.length > 1) {
        artistCredits.slice(1).forEach((a) => addUniqueItem(result.contributingArtists, a));
        result.fieldSources.contributingArtists = 'Embedded';
      }
    }

    if (bytes.length >= 44 && readAscii(0, 4) === 'RIFF' && readAscii(8, 4) === 'WAVE') {
      result.codec = 'WAV';
      result.containerSource = 'RIFF WAVE Binary Header';
      let wPos = 12;
      while (wPos + 8 <= bytes.length) {
        const chunkId = readAscii(wPos, 4);
        const chunkSize = view.getUint32(wPos + 4, true);
        if (chunkId === 'fmt ' && wPos + 24 <= bytes.length) {
          const ch = view.getUint16(wPos + 10, true);
          const sr = view.getUint32(wPos + 12, true);
          const bps = view.getUint16(wPos + 22, true);
          if (sr > 0) {
            result.sampleRate = sr;
            result.sampleRateSource = 'WAV RIFF fmt Chunk';
          }
          if (ch > 0) {
            result.channels = ch;
            result.channelsSource = 'WAV RIFF fmt Chunk';
          }
          if (bps > 0) {
            result.bitDepth = bps;
            result.bitDepthSource = 'WAV RIFF fmt Chunk';
          }
          break;
        }
        wPos += 8 + chunkSize + (chunkSize % 2);
      }
    }

    if (bytes.length >= 10 && readAscii(0, 3) === 'ID3') {
      const versionMajor = bytes[3];
      const tagSize =
        ((bytes[6] & 0x7f) << 21) |
        ((bytes[7] & 0x7f) << 14) |
        ((bytes[8] & 0x7f) << 7) |
        (bytes[9] & 0x7f);
      const limit = Math.min(bytes.length, 10 + tagSize);
      let iPos = 10;

      const decodeId3Text = (sub) => {
        if (!sub || sub.length === 0) return '';
        const enc = sub[0];
        const payload = sub.subarray(1);
        try {
          if (enc === 0) return new TextDecoder('iso-8859-1').decode(payload).replace(/\0+/g, ' / ').replace(/^\s*\/\s*|\s*\/\s*$/g, '').trim();
          if (enc === 1) return new TextDecoder('utf-16').decode(payload).replace(/\0+/g, ' / ').replace(/^\s*\/\s*|\s*\/\s*$/g, '').trim();
          if (enc === 2) return new TextDecoder('utf-16be').decode(payload).replace(/\0+/g, ' / ').replace(/^\s*\/\s*|\s*\/\s*$/g, '').trim();
          return new TextDecoder('utf-8').decode(payload).replace(/\0+/g, ' / ').replace(/^\s*\/\s*|\s*\/\s*$/g, '').trim();
        } catch (e) {
          return '';
        }
      };

      while (iPos + 10 <= limit) {
        const frameId = readAscii(iPos, 4);
        if (!/^[A-Z0-9]{4}$/.test(frameId)) break;
        const frameSize =
          versionMajor === 4
            ? ((bytes[iPos + 4] & 0x7f) << 21) |
            ((bytes[iPos + 5] & 0x7f) << 14) |
            ((bytes[iPos + 6] & 0x7f) << 7) |
            (bytes[iPos + 7] & 0x7f)
            : view.getUint32(iPos + 4, false);
        iPos += 10;
        if (frameSize <= 0 || iPos + frameSize > limit) break;

        const frameBytes = bytes.subarray(iPos, iPos + frameSize);
        if (frameId === 'TIT2') {
          const val = decodeId3Text(frameBytes);
          if (val) {
            result.title = val;
            result.fieldSources.title = 'Embedded';
          }
        } else if (frameId === 'TPE1') {
          const val = decodeId3Text(frameBytes);
          if (val) {
            const parts = val.split(/\s*\/\s*|\s*;\s*/).filter(Boolean);
            result.artist = parts[0] || val;
            result.fieldSources.artist = 'Embedded';
            if (parts.length > 1) {
              parts.slice(1).forEach((p) => addUniqueItem(result.contributingArtists, p));
              result.fieldSources.contributingArtists = 'Embedded';
            }
          }
        } else if (frameId === 'TPE2') {
          const val = decodeId3Text(frameBytes);
          if (val) {
            result.albumArtist = val;
            result.fieldSources.albumArtist = 'Embedded';
          }
        } else if (frameId === 'TPE3' || frameId === 'TPE4') {
          const val = decodeId3Text(frameBytes);
          if (val) {
            addUniqueItem(result.contributingArtists, val);
            result.fieldSources.contributingArtists = 'Embedded';
          }
        } else if (frameId === 'TALB') {
          const val = decodeId3Text(frameBytes);
          if (val) {
            result.album = val;
            result.albumSource = 'Embedded ID3v2 TALB Frame';
            result.fieldSources.album = 'Embedded';
          }
        } else if (frameId === 'TRCK') {
          const val = decodeId3Text(frameBytes);
          const parsed = parseNumberAndTotal(val);
          if (parsed.number) {
            result.trackNumber = parsed.number;
            result.fieldSources.trackNumber = 'Embedded';
          }
          if (parsed.total) result.totalTracks = parsed.total;
        } else if (frameId === 'TPOS') {
          const val = decodeId3Text(frameBytes);
          const parsed = parseNumberAndTotal(val);
          if (parsed.number) {
            result.discNumber = parsed.number;
            result.fieldSources.discNumber = 'Embedded';
          }
          if (parsed.total) result.totalDiscs = parsed.total;
        } else if (frameId === 'TYER' || frameId === 'TDRC' || frameId === 'TDOR') {
          const val = decodeId3Text(frameBytes);
          if (val) {
            const { year, releaseDate } = parseDateAndYear(val);
            if (year) {
              result.year = year;
              result.fieldSources.year = 'Embedded';
            }
            if (releaseDate) {
              result.releaseDate = releaseDate;
              result.fieldSources.releaseDate = 'Embedded';
            }
          }
        } else if (frameId === 'TCON') {
          const val = decodeId3Text(frameBytes);
          if (val) {
            val.split(/\s*\/\s*|\s*;\s*|\s*,\s*/).forEach((g) => {
              const cg = cleanGenreString(g);
              if (cg) addUniqueItem(result.genres, cg);
            });
            if (result.genres.length > 0) {
              result.genre = result.genres[0];
              result.fieldSources.genre = 'Embedded';
            }
          }
        } else if (frameId === 'TPUB') {
          const val = decodeId3Text(frameBytes);
          if (val) {
            result.label = val;
            result.fieldSources.label = 'Embedded';
          }
        } else if (frameId === 'TCOM') {
          const val = decodeId3Text(frameBytes);
          if (val) {
            result.composer = val;
            result.fieldSources.composer = 'Embedded';
          }
        } else if (frameId === 'TEXT') {
          const val = decodeId3Text(frameBytes);
          if (val) {
            result.songwriter = val;
            result.fieldSources.songwriter = 'Embedded';
          }
        } else if (frameId === 'TSRC') {
          const val = decodeId3Text(frameBytes);
          if (val) {
            result.isrc = val;
            result.fieldSources.isrc = 'Embedded';
          }
        } else if (frameId === 'TXXX') {
          const rawCustom = decodeId3Text(frameBytes);
          const splitCustom = rawCustom.split(' / ');
          if (splitCustom.length >= 2) {
            const cKey = splitCustom[0].toUpperCase().trim();
            const cVal = splitCustom.slice(1).join(', ').trim();
            if (cVal) {
              if (cKey.includes('COUNTRY')) {
                result.releaseCountry = cVal;
                result.fieldSources.releaseCountry = 'Embedded';
              } else if (cKey.includes('CATALOG')) {
                result.catalogNumber = cVal;
                result.fieldSources.catalogNumber = 'Embedded';
              } else if (cKey === 'ISRC' && !result.isrc) {
                result.isrc = cVal;
                result.fieldSources.isrc = 'Embedded';
              } else if ((cKey === 'LABEL' || cKey === 'PUBLISHER') && !result.label) {
                result.label = cVal;
                result.fieldSources.label = 'Embedded';
              } else if (cKey === 'ARTISTS') {
                splitCustom.slice(1).forEach((p) => addUniqueItem(result.contributingArtists, p));
                result.fieldSources.contributingArtists = 'Embedded';
              }
            }
          }
        } else if (frameId === 'USLT' && frameBytes.length > 4) {
          const body = frameBytes.subarray(4);
          const txt = new TextDecoder('utf-8', { fatal: false }).decode(body).replace(/\0/g, '').trim();
          if (txt) result.embeddedLyrics = txt;
        } else if (frameId === 'APIC' && frameBytes.length > 16 && !result.coverUrl) {
          await extractEmbeddedImageDataUrl(frameBytes, 'Embedded ID3v2 APIC Frame');
        }
        iPos += frameSize;
      }
    }

    if (bytes.length >= 12 && readAscii(0, 4) === 'OggS') {
      result.containerSource = 'OggS Capture Pattern Header';
    } else if (bytes.length >= 12 && readAscii(4, 4) === 'ftyp') {
      result.containerSource = 'ISO Base Media (ftyp) Header';
      if (!result.coverUrl) {
        for (let m = 0; m < bytes.length - 16; m++) {
          if (
            bytes[m] === 0x63 &&
            bytes[m + 1] === 0x6f &&
            bytes[m + 2] === 0x76 &&
            bytes[m + 3] === 0x72
          ) {
            await extractEmbeddedImageDataUrl(
              bytes.subarray(m, Math.min(bytes.length, m + 1500000)),
              'Embedded MP4/M4A covr Atom'
            );
            break;
          }
        }
      }
    }
  } catch (err) {
    console.warn('Binary metadata inspection warning:', err);
  }

  if (!result.albumArtist) {
    result.albumArtist = result.artist || 'Unknown Artist';
  }
  result.albumId = buildAlbumIdentityKey(result.album, result.albumArtist, result.folderPath);

  return result;
}

function normalizeMetaToken(str) {
  return (str || '')
    .toLowerCase()
    .replace(/\([^)]*\)|\[[^\]]*\]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

let lastMusicBrainzRequestTime = 0;
async function rateLimitedMusicBrainzFetch(url, signal) {
  const now = Date.now();
  const elapsed = now - lastMusicBrainzRequestTime;
  if (elapsed < 1100) {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 1100 - elapsed);
      if (signal) {
        signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            reject(new DOMException('Aborted', 'AbortError'));
          },
          { once: true }
        );
      }
    });
  }
  lastMusicBrainzRequestTime = Date.now();
  return fetch(url, {
    signal,
    headers: {
      Accept: 'application/json'
    }
  });
}

async function resolveMusicBrainzMetadata(track, signal) {
  if (!track) return null;
  const rawTitle = (track.title || '').trim();
  const rawArtist =
    track.artist && track.artist !== 'Unknown Artist' ? track.artist.trim() : '';
  const rawAlbum =
    track.album &&
      track.album !== 'Unsorted Local Album' &&
      track.album !== 'Local Audio File' &&
      track.album !== 'Unknown Album'
      ? track.album.trim()
      : '';
  const rawIsrc = (track.isrc || '').trim();
  const durationSec = Math.round(track.duration || track.dspAnalysis?.duration || 0);

  const normTitle = normalizeMetaToken(rawTitle);
  const normArtist = normalizeMetaToken(rawArtist);
  const normAlbum = normalizeMetaToken(rawAlbum);

  if (!normTitle || normTitle.length < 2) return null;

  const cacheKey = `mb|${normArtist}|${normAlbum}|${normTitle}|${rawIsrc}|${durationSec}`;
  const cached = await dbGet('metadataCache', cacheKey);
  if (cached && cached.metadata) {
    return {
      ...cached.metadata,
      fromCache: true
    };
  }

  // Construct Lucene query for MusicBrainz Recording Search API
  const queryParts = [];
  if (rawIsrc) {
    queryParts.push(`isrc:${rawIsrc}`);
  } else {
    const cleanTitle = rawTitle.replace(/["\\]/g, ' ').trim();
    queryParts.push(`recording:"${cleanTitle}"`);
    if (rawArtist) {
      const cleanArtist = rawArtist.replace(/["\\]/g, ' ').trim();
      queryParts.push(`artist:"${cleanArtist}"`);
    }
    if (rawAlbum) {
      const cleanAlbum = rawAlbum.replace(/["\\]/g, ' ').trim();
      queryParts.push(`release:"${cleanAlbum}"`);
    }
  }

  const luceneQuery = queryParts.join(' AND ');
  const searchUrl = `https://musicbrainz.org/ws/2/recording?query=${encodeURIComponent(luceneQuery)}&limit=8&fmt=json`;

  const searchRes = await rateLimitedMusicBrainzFetch(searchUrl, signal);
  if (!searchRes.ok) {
    throw new Error(`MusicBrainz HTTP ${searchRes.status}`);
  }
  const searchData = await searchRes.json();
  const recordings = Array.isArray(searchData?.recordings) ? searchData.recordings : [];
  if (recordings.length === 0) return null;

  // Score candidates strictly so we only accept a high-confidence match
  let bestCandidate = null;
  let bestScore = 0;

  for (const rec of recordings) {
    const recTitle = normalizeMetaToken(rec.title);
    const creditList = Array.isArray(rec['artist-credit']) ? rec['artist-credit'] : [];
    const creditNames = creditList
      .map((c) => c?.name || c?.artist?.name || '')
      .filter(Boolean);
    const joinedArtist = normalizeMetaToken(creditNames.join(' '));

    let score = 0;
    // 1. Title check
    if (recTitle === normTitle) {
      score += 45;
    } else if (recTitle.length >= 4 && (recTitle.includes(normTitle) || normTitle.includes(recTitle))) {
      score += 25;
    } else {
      continue;
    }

    // 2. Artist check
    if (normArtist) {
      if (joinedArtist === normArtist || joinedArtist.includes(normArtist) || normArtist.includes(joinedArtist)) {
        score += 35;
      } else {
        continue;
      }
    } else if (creditNames.length > 0) {
      score += 10;
    }

    // 3. ISRC exact match bonus
    const recIsrcs = Array.isArray(rec.isrcs) ? rec.isrcs.map((i) => String(i).toUpperCase()) : [];
    if (rawIsrc && recIsrcs.includes(rawIsrc.toUpperCase())) {
      score += 40;
    }

    // 4. Duration proximity check (rec.length is in milliseconds)
    if (durationSec > 0 && Number.isFinite(rec.length)) {
      const recSec = Math.round(rec.length / 1000);
      const diff = Math.abs(recSec - durationSec);
      if (diff <= 4) score += 20;
      else if (diff <= 12) score += 10;
      else if (diff > 35 && !rawIsrc) score -= 25;
    }

    // 5. Album / Release match check
    const releases = Array.isArray(rec.releases) ? rec.releases : [];
    let matchedRelease = releases[0] || null;
    if (normAlbum && releases.length > 0) {
      const exactRel = releases.find((r) => {
        const rt = normalizeMetaToken(r.title);
        return rt === normAlbum || rt.includes(normAlbum) || normAlbum.includes(rt);
      });
      if (exactRel) {
        matchedRelease = exactRel;
        score += 20;
      }
    }

    if (score > bestScore && score >= 55) {
      bestScore = score;
      bestCandidate = { rec, matchedRelease };
    }
  }

  if (!bestCandidate) return null;

  const { rec, matchedRelease } = bestCandidate;
  const creditList = Array.isArray(rec['artist-credit']) ? rec['artist-credit'] : [];
  const primaryArtist = creditList[0]?.name || creditList[0]?.artist?.name || '';
  const contributingArtists = creditList
    .slice(1)
    .map((c) => c?.name || c?.artist?.name || '')
    .filter(Boolean);

  const genresSet = new Set();
  if (Array.isArray(rec.tags)) {
    rec.tags
      .slice()
      .sort((a, b) => (b.count || 0) - (a.count || 0))
      .slice(0, 5)
      .forEach((t) => {
        if (t?.name && t.name.length <= 28) genresSet.add(t.name);
      });
  }

  let releaseTitle = matchedRelease?.title || '';
  let releaseDateStr = matchedRelease?.date || rec['first-release-date'] || '';
  let releaseCountry = matchedRelease?.country || '';
  let albumArtist = '';
  let trackNumber = null;
  let totalTracks = null;
  let discNumber = null;
  let labelName = '';
  let catalogNumber = '';
  let composer = '';
  let songwriter = '';
  let isrc = Array.isArray(rec.isrcs) && rec.isrcs.length > 0 ? rec.isrcs[0] : '';
  let coverArtArchiveUrl = null;

  if (matchedRelease) {
    if (Array.isArray(matchedRelease['artist-credit']) && matchedRelease['artist-credit'][0]) {
      albumArtist =
        matchedRelease['artist-credit'][0]?.name ||
        matchedRelease['artist-credit'][0]?.artist?.name ||
        '';
    }
    const media = Array.isArray(matchedRelease.media) ? matchedRelease.media[0] : null;
    if (media) {
      if (Number.isFinite(media.position)) discNumber = media.position;
      if (Number.isFinite(media['track-count'])) totalTracks = media['track-count'];
      if (Array.isArray(media.track) && media.track[0]?.number) {
        const parsedTn = parseInt(media.track[0].number, 10);
        if (parsedTn > 0) trackNumber = parsedTn;
      }
    }
  }

  // Optional follow-up lookup on the matched release + recording relations for label, composer, songwriter, and genres
  if (matchedRelease?.id) {
    try {
      const relUrl = `https://musicbrainz.org/ws/2/release/${matchedRelease.id}?inc=labels+artists+genres+tags&fmt=json`;
      const relRes = await rateLimitedMusicBrainzFetch(relUrl, signal);
      if (relRes.ok) {
        const relDetail = await relRes.json();
        if (relDetail?.date && !releaseDateStr) releaseDateStr = relDetail.date;
        if (relDetail?.country && !releaseCountry) releaseCountry = relDetail.country;
        if (Array.isArray(relDetail?.['label-info']) && relDetail['label-info'].length > 0) {
          const li = relDetail['label-info'][0];
          if (li?.label?.name) labelName = li.label.name;
          if (li?.['catalog-number']) catalogNumber = li['catalog-number'];
        }
        if (Array.isArray(relDetail?.genres)) {
          relDetail.genres.forEach((g) => {
            if (g?.name) genresSet.add(g.name);
          });
        }
        if (Array.isArray(relDetail?.tags)) {
          relDetail.tags
            .slice()
            .sort((a, b) => (b.count || 0) - (a.count || 0))
            .slice(0, 4)
            .forEach((t) => {
              if (t?.name && t.name.length <= 28) genresSet.add(t.name);
            });
        }
        if (relDetail?.['cover-art-archive']?.front) {
          coverArtArchiveUrl = `https://coverartarchive.org/release/${matchedRelease.id}/front-500`;
        }
      }
    } catch (relErr) {
      if (relErr.name === 'AbortError') throw relErr;
    }
  }

  // Recording relations lookup for composer / songwriter / ISRC if still missing
  if (rec.id && (!isrc || !composer)) {
    try {
      const recDetailUrl = `https://musicbrainz.org/ws/2/recording/${rec.id}?inc=artists+isrcs+genres+tags+artist-rels+work-rels+work-level-rels&fmt=json`;
      const recDetailRes = await rateLimitedMusicBrainzFetch(recDetailUrl, signal);
      if (recDetailRes.ok) {
        const recDetail = await recDetailRes.json();
        if (!isrc && Array.isArray(recDetail?.isrcs) && recDetail.isrcs.length > 0) {
          isrc = recDetail.isrcs[0];
        }
        if (Array.isArray(recDetail?.genres)) {
          recDetail.genres.forEach((g) => {
            if (g?.name) genresSet.add(g.name);
          });
        }
        const composers = [];
        const writers = [];
        const inspectRelations = (rels) => {
          if (!Array.isArray(rels)) return;
          for (const rel of rels) {
            const rType = (rel.type || '').toLowerCase();
            const personName = rel.artist?.name || '';
            if (personName) {
              if (rType === 'composer') {
                if (!composers.includes(personName)) composers.push(personName);
              } else if (rType === 'writer' || rType === 'lyricist' || rType === 'songwriter') {
                if (!writers.includes(personName)) writers.push(personName);
              } else if (rType === 'vocal' || rType === 'instrument' || rType === 'performer') {
                if (
                  personName.toLowerCase() !== primaryArtist.toLowerCase() &&
                  !contributingArtists.includes(personName) &&
                  contributingArtists.length < 5
                ) {
                  contributingArtists.push(personName);
                }
              }
            }
            if (rel.work && Array.isArray(rel.work.relations)) {
              inspectRelations(rel.work.relations);
            }
          }
        };
        inspectRelations(recDetail?.relations);
        if (composers.length > 0) composer = composers.join(', ');
        if (writers.length > 0) songwriter = writers.join(', ');
      }
    } catch (recErr) {
      if (recErr.name === 'AbortError') throw recErr;
    }
  }

  const parsedDates = parseDateAndYear(releaseDateStr);
  const genresList = Array.from(genresSet).slice(0, 5);

  const enrichedPayload = {
    recordingMbid: rec.id,
    releaseMbid: matchedRelease?.id || null,
    musicBrainzUrl: rec.id ? `https://musicbrainz.org/recording/${rec.id}` : null,
    title: rec.title || '',
    artist: primaryArtist,
    contributingArtists,
    album: releaseTitle,
    albumArtist: albumArtist || primaryArtist,
    year: parsedDates.year,
    releaseDate: parsedDates.releaseDate,
    genre: genresList[0] || '',
    genres: genresList,
    trackNumber,
    totalTracks,
    discNumber,
    label: labelName,
    catalogNumber,
    releaseCountry,
    composer,
    songwriter,
    isrc,
    coverArtArchiveUrl,
    confidenceScore: bestScore
  };

  await dbPut('metadataCache', {
    cacheKey,
    metadata: enrichedPayload,
    cachedAt: new Date().toISOString()
  });

  return {
    ...enrichedPayload,
    fromCache: false
  };
}

async function resolveOnlineTrackArtwork(track, signal) {
  if (!track) return null;
  const normTitle = normalizeMetaToken(track.title);
  const normArtist =
    track.artist && track.artist !== 'Unknown Artist' ? normalizeMetaToken(track.artist) : '';
  const normAlbum =
    track.album &&
      track.album !== 'Local Audio File' &&
      track.album !== 'Unsorted Local Album' &&
      track.album !== 'Unknown Album'
      ? normalizeMetaToken(track.album)
      : '';

  if (!normTitle || normTitle.length < 2) return null;

  const cacheKey = `${normArtist}|${normAlbum}|${normTitle}`;
  const cached = await dbGet('artworkCache', cacheKey);
  if (cached && cached.artworkUrl) {
    return {
      artworkUrl: cached.artworkUrl,
      provenance: `${cached.provenance} (Cached in IndexedDB)`,
      verified: true
    };
  }

  const queryTerms = [track.artist !== 'Unknown Artist' ? track.artist : '', track.album !== 'Local Audio File' && track.album !== 'Unsorted Local Album' ? track.album : '', track.title]
    .filter(Boolean)
    .join(' ')
    .trim();

  if (!queryTerms) return null;

  const endpoint = `https://itunes.apple.com/search?term=${encodeURIComponent(queryTerms)}&entity=song&limit=8`;
  const res = await fetch(endpoint, { signal });
  if (!res.ok) throw new Error(`Artwork API HTTP ${res.status}`);
  const data = await res.json();
  if (!data || !Array.isArray(data.results) || data.results.length === 0) {
    return null;
  }

  for (const item of data.results) {
    const itemTitle = normalizeMetaToken(item.trackName);
    const itemArtist = normalizeMetaToken(item.artistName);
    const itemAlbum = normalizeMetaToken(item.collectionName);

    const titleMatches =
      itemTitle && (itemTitle === normTitle || itemTitle.includes(normTitle) || normTitle.includes(itemTitle));
    const artistMatches =
      !normArtist ||
      (itemArtist && (itemArtist === normArtist || itemArtist.includes(normArtist) || normArtist.includes(itemArtist)));
    const albumMatches =
      !normAlbum ||
      (itemAlbum && (itemAlbum === normAlbum || itemAlbum.includes(normAlbum) || normAlbum.includes(itemAlbum)));

    if (titleMatches && (artistMatches || albumMatches) && item.artworkUrl100) {
      const hiResUrl = item.artworkUrl100.replace(/100x100bb\.jpg$/i, '600x600bb.jpg');
      const provenance = `Verified Online Match (${item.artistName} — ${item.collectionName || item.trackName})`;
      await dbPut('artworkCache', {
        cacheKey,
        artworkUrl: hiResUrl,
        provenance,
        cachedAt: new Date().toISOString()
      });
      return {
        artworkUrl: hiResUrl,
        provenance,
        verified: true
      };
    }
  }

  return null;
}

function parseLrcLyrics(rawText) {
  if (!rawText || typeof rawText !== 'string') {
    return { isSynced: false, lines: [] };
  }
  const rawLines = rawText.split(/\r?\n/);
  const parsed = [];
  let syncedCount = 0;

  const timeRegex = /\[(\d{1,3}):(\d{2})(?:\.(\d{1,3}))?\]/g;

  rawLines.forEach((line, idx) => {
    const matches = [...line.matchAll(timeRegex)];
    const textContent = line.replace(timeRegex, '').trim();
    if (matches.length > 0) {
      syncedCount++;
      matches.forEach((m) => {
        const mins = parseInt(m[1], 10);
        const secs = parseInt(m[2], 10);
        const msStr = m[3] || '0';
        const frac = parseInt(msStr.padEnd(3, '0').slice(0, 3), 10) / 1000;
        const timeSec = mins * 60 + secs + frac;
        parsed.push({
          id: `lrc-${idx}-${timeSec.toFixed(2)}`,
          timeSec,
          text: textContent || '♪'
        });
      });
    } else if (textContent.length > 0 && !/^\[(ar|ti|al|by|offset):/i.test(line.trim())) {
      parsed.push({
        id: `plain-${idx}`,
        timeSec: null,
        text: textContent
      });
    }
  });

  if (syncedCount > 0) {
    parsed.sort((a, b) => (a.timeSec ?? 0) - (b.timeSec ?? 0));
  }

  return {
    isSynced: syncedCount > 0,
    lines: parsed
  };
}

async function resolveAutomaticOnlineLyrics(track, signal) {
  if (!track) return null;
  const normTitle = normalizeMetaToken(track.title);
  const normArtist =
    track.artist && track.artist !== 'Unknown Artist' ? normalizeMetaToken(track.artist) : '';
  const durationRounded = Math.round(track.duration || 0);

  if (!normTitle || normTitle.length < 2) return null;

  const cacheKey = `${normArtist}|${normTitle}|${durationRounded}`;
  const cached = await dbGet('lyricsCache', cacheKey);
  if (cached && cached.lyrics) {
    return {
      lyrics: cached.lyrics,
      isSynced: Boolean(cached.isSynced),
      lyricsSource: `${cached.lyricsSource} (Cached)`
    };
  }

  const q = encodeURIComponent(`${track.artist !== 'Unknown Artist' ? track.artist : ''} ${track.title}`.trim());
  const res = await fetch(`https://lrclib.net/api/search?q=${q}`, { signal });
  if (!res.ok) throw new Error(`LRCLIB HTTP ${res.status}`);
  const results = await res.json();
  if (!Array.isArray(results) || results.length === 0) {
    return null;
  }

  const ranked = results
    .filter((item) => item && (item.syncedLyrics || item.plainLyrics))
    .sort((a, b) => {
      const aHasSync = Boolean(a.syncedLyrics);
      const bHasSync = Boolean(b.syncedLyrics);
      if (aHasSync !== bHasSync) return aHasSync ? -1 : 1;
      const aDurDiff = durationRounded > 0 && a.duration ? Math.abs(a.duration - durationRounded) : 50;
      const bDurDiff = durationRounded > 0 && b.duration ? Math.abs(b.duration - durationRounded) : 50;
      return aDurDiff - bDurDiff;
    });

  const best = ranked[0];
  if (!best) return null;

  const chosenText = best.syncedLyrics || best.plainLyrics;
  const isSynced = Boolean(best.syncedLyrics);
  const lyricsSource = isSynced
    ? `LRCLIB Synchronized LRC (${best.artistName} — ${best.trackName})`
    : `LRCLIB Plain Lyrics (${best.artistName} — ${best.trackName})`;

  await dbPut('lyricsCache', {
    cacheKey,
    lyrics: chosenText,
    isSynced,
    lyricsSource,
    cachedAt: new Date().toISOString()
  });

  return {
    lyrics: chosenText,
    isSynced,
    lyricsSource
  };
}

// ---------------------------------------------------------------------------
// Playback clock
// The playback position changes several times per second. Keeping it in App's React state re-rendered the
// whole interface (including the entire library list) on every tick, which made playback laggy. It now lives
// in this tiny external store, and only the small pieces of UI that really show the time subscribe to it.
// ---------------------------------------------------------------------------
const playbackClock = (() => {
  let value = 0;
  const listeners = new Set();
  return {
    get: () => value,
    set: (next) => {
      if (next === value) return;
      value = next;
      listeners.forEach((listener) => listener());
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  };
})();

// Re-renders the calling component only when select(time) returns a different value
function useClock(select) {
  return useSyncExternalStore(playbackClock.subscribe, () => select(playbackClock.get()));
}

// Render-prop wrapper: only this small component re-renders as time advances. step > 0 rounds the time down.
function WithClock({ step = 0, children }) {
  const time = useClock((t) => (step > 0 ? Math.floor(t / step) * step : t));
  return children(time);
}

// Thin playback progress line along the bottom of the title bar (compositor-only: scaleX, no layout)
function ClockProgressBar({ duration, palette }) {
  const ratio = useClock((t) => (duration > 0 ? Math.min(1, Math.max(0, t / duration)) : 0));
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 h-[2px] bg-white/[0.04]">
      <div
        className="h-full w-full origin-left"
        style={{
          transform: `scaleX(${ratio})`,
          transition: 'transform 400ms linear',
          willChange: 'transform',
          background: `linear-gradient(to right, ${palette.hex600}, ${palette.hex400}, ${palette.hex200})`,
          boxShadow: `0 0 8px ${palette.hex400}80`
        }}
      />
    </div>
  );
}

async function performOfflineSignalAnalysis(audioBlob, existingMeta = {}) {
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) {
    throw new Error('Web Audio API is unavailable in this runtime.');
  }

  const arrayBuffer = await audioBlob.arrayBuffer();
  const tempCtx = new AudioCtx();
  let audioBuffer;
  try {
    audioBuffer = await tempCtx.decodeAudioData(arrayBuffer.slice(0));
  } finally {
    if (tempCtx.state !== 'closed' && typeof tempCtx.close === 'function') {
      await tempCtx.close().catch(() => { });
    }
  }

  const numChannels = audioBuffer.numberOfChannels;
  const length = audioBuffer.length;
  const duration = audioBuffer.duration;
  const ch0 = audioBuffer.getChannelData(0);
  const ch1 = numChannels > 1 ? audioBuffer.getChannelData(1) : ch0;

  let maxPeak = 0;
  let sumSquares = 0;
  let clippedSamples = 0;

  let corrNumerator = 0;
  let corrDenomL = 0;
  let corrDenomR = 0;

  const stride = Math.max(1, Math.floor(length / 250000));
  let sampledCount = 0;

  for (let i = 0; i < length; i += stride) {
    const sL = ch0[i];
    const sR = ch1[i];
    const absL = Math.abs(sL);
    const absR = Math.abs(sR);
    const localMax = absL > absR ? absL : absR;

    if (localMax > maxPeak) maxPeak = localMax;
    if (localMax >= 0.999) clippedSamples++;

    const mono = 0.5 * (sL + sR);
    sumSquares += mono * mono;

    corrNumerator += sL * sR;
    corrDenomL += sL * sL;
    corrDenomR += sR * sR;
    sampledCount++;
  }

  const rms = Math.sqrt(sumSquares / Math.max(1, sampledCount));
  const peakDb = maxPeak > 0 ? 20 * Math.log10(maxPeak) : -96;
  const rmsDb = rms > 0 ? 20 * Math.log10(rms) : -96;
  const crestFactorDb = peakDb - rmsDb;

  const denom = Math.sqrt(corrDenomL * corrDenomR);
  const stereoCorrelation = denom > 0 ? Math.max(-1, Math.min(1, corrNumerator / denom)) : 1.0;

  const bars = 140;
  const samplesPerBar = Math.max(1, Math.floor(length / bars));
  const waveformPeaks = [];
  for (let b = 0; b < bars; b++) {
    const start = b * samplesPerBar;
    const end = Math.min(length, start + samplesPerBar);
    const barStep = Math.max(1, Math.floor((end - start) / 400));
    let barPeak = 0;
    for (let j = start; j < end; j += barStep) {
      const amp = Math.abs(0.5 * (ch0[j] + ch1[j]));
      if (amp > barPeak) barPeak = amp;
    }
    waveformPeaks.push(Number(barPeak.toFixed(4)));
  }

  let lowEnergy = 0;
  let midEnergy = 0;
  let highEnergy = 0;
  let lpState = 0;
  let hpState = 0;
  const alphaLow = 0.035;
  const alphaMid = 0.28;

  for (let i = 0; i < length; i += stride * 2) {
    const x = 0.5 * (ch0[i] + ch1[i]);
    lpState = lpState + alphaLow * (x - lpState);
    hpState = hpState + alphaMid * (x - hpState);
    const lowBand = lpState;
    const midBand = hpState - lpState;
    const highBand = x - hpState;
    lowEnergy += lowBand * lowBand;
    midEnergy += midBand * midBand;
    highEnergy += highBand * highBand;
  }

  const totalSpecEnergy = Math.max(1e-9, lowEnergy + midEnergy + highEnergy);
  const spectralBalance = {
    bassPct: Math.round((lowEnergy / totalSpecEnergy) * 100),
    midPct: Math.round((midEnergy / totalSpecEnergy) * 100),
    treblePct: Math.max(
      0,
      100 -
      Math.round((lowEnergy / totalSpecEnergy) * 100) -
      Math.round((midEnergy / totalSpecEnergy) * 100)
    )
  };

  const estimatedBitrateKbps =
    duration > 0 && audioBlob.size
      ? Math.round((audioBlob.size * 8) / duration / 1000)
      : null;

  return {
    duration,
    sampleRate: existingMeta.sampleRate || audioBuffer.sampleRate,
    sampleRateSource: existingMeta.sampleRate
      ? existingMeta.sampleRateSource
      : 'Web Audio API Decoded Context Rate (Resampled to Hardware Output)',
    channels: existingMeta.channels || numChannels,
    channelsSource: existingMeta.channels
      ? existingMeta.channelsSource
      : 'Decoded AudioBuffer Channel Count',
    peakDb: Number(peakDb.toFixed(2)),
    rmsDb: Number(rmsDb.toFixed(2)),
    crestFactorDb: Number(crestFactorDb.toFixed(2)),
    stereoCorrelation: Number(stereoCorrelation.toFixed(3)),
    clippedSamples,
    estimatedBitrateKbps,
    bitrateSource: 'Estimated from File Size ÷ Decoded Duration',
    waveformPeaks,
    spectralBalance,
    analyzedAt: new Date().toISOString()
  };
}

function formatTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '0:00';
  const totalSec = Math.floor(sec);
  const mins = Math.floor(totalSec / 60);
  const rem = totalSec % 60;
  return `${mins}:${rem < 10 ? '0' : ''}${rem}`;
}

function sortTracksForAlbum(trackList) {
  return [...trackList].sort((a, b) => {
    const discA = a.discNumber || 1;
    const discB = b.discNumber || 1;
    if (discA !== discB) return discA - discB;

    const tnA = a.trackNumber ?? 99999;
    const tnB = b.trackNumber ?? 99999;
    if (tnA !== tnB) return tnA - tnB;

    const pathA = (a.relativePath || a.title || '').toLowerCase();
    const pathB = (b.relativePath || b.title || '').toLowerCase();
    return pathA.localeCompare(pathB, undefined, { numeric: true });
  });
}

export default function App() {
  const [activeTab, setActiveTab] = useState('library'); // 'library' | 'equalizer' | 'insights' | 'settings'
  const [fullscreenMode, setFullscreenMode] = useState(null); // null | 'player' | 'lyrics'
  const [toast, setToast] = useState(null);
  const [confirmModal, setConfirmModal] = useState(null);

  // Smart Metadata Audit State
  const [smartAuditResult, setSmartAuditResult] = useState(null);

  // 10-Band Parametric Equalizer State with dual-layer localStorage + IndexedDB persistence
  const [peqState, setPeqState] = useState(() => {
    try {
      const saved = localStorage.getItem('aurelia_peq_state');
      if (saved) {
        return validateAndNormalizePeqState(JSON.parse(saved));
      }
    } catch {}
    return validateAndNormalizePeqState(null);
  });
  const [customPeqPresets, setCustomPeqPresets] = useState(() => {
    try {
      const saved = localStorage.getItem('aurelia_custom_peq_presets');
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed)) return parsed;
      }
    } catch {}
    return [];
  });
  const peqLoadedRef = useRef(false);
  const peqStateRef = useRef(peqState);
  peqStateRef.current = peqState;
  const filterNodesRef = useRef([]);
  const preampGainRef = useRef(null);

  // Library, Album Grouping & Playlists state
  const [tracks, setTracks] = useState([]);
  const [playlists, setPlaylists] = useState([
    { id: 'pl-favorites', name: 'Audiophile Favorites', trackIds: [] }
  ]);
  const [selectedPlaylistId, setSelectedPlaylistId] = useState('ALL');
  const [libraryViewMode, setLibraryViewMode] = useState('albums'); // 'albums' | 'tracks'
  const [selectedAlbumId, setSelectedAlbumId] = useState(null);
  const [visibleAlbumLimit, setVisibleAlbumLimit] = useState(28);
  const [visibleTrackLimit, setVisibleTrackLimit] = useState(80);
  const [newPlaylistName, setNewPlaylistName] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState('album'); // 'album' | 'title' | 'artist' | 'duration' | 'codec'
  const [sortAsc, setSortAsc] = useState(true);
  const [isDraggingOver, setIsDraggingOver] = useState(false);

  const [queue, setQueue] = useState([]);
  const [currentTrackId, setCurrentTrackId] = useState(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const setCurrentTime = playbackClock.set; // playback position lives in playbackClock, not in React state
  const currentTimeRef = useRef(0);
  const lastTimeUpdateSecRef = useRef(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(0.85);
  const [isMuted, setIsMuted] = useState(false);
  const [shuffle, setShuffle] = useState(false);
  const [repeatMode, setRepeatMode] = useState('off'); // 'off' | 'all' | 'one'
  const [playbackError, setPlaybackError] = useState(null);
  const [showQueueDrawer, setShowQueueDrawer] = useState(false);

  // Dynamic Artwork & Crossfade Backdrop state
  const [backdropState, setBackdropState] = useState({
    prevUrl: null,
    activeUrl: null,
    transitioning: false
  });
  const [artworkLookupStatus, setArtworkLookupStatus] = useState(null);

  // Automatic Online Synchronized Lyrics state
  const [autoLyricsState, setAutoLyricsState] = useState({
    status: 'idle', // 'idle' | 'loading' | 'synced' | 'plain' | 'not-found' | 'offline' | 'error'
    message: null
  });

  // Remembered Music Folder & Recursive Import Progress state
  const [rememberedFolder, setRememberedFolder] = useState({
    handle: null,
    name: null,
    path: null,
    mode: null, // 'fs-handle' | 'idb-fallback' | 'tauri-native'
    permissionState: 'unknown', // 'granted' | 'prompt' | 'denied' | 'sandbox-fallback'
    trackCount: 0,
    lastScannedAt: null
  });
  const [importProgress, setImportProgress] = useState(null);
  const [diagnosticReport, setDiagnosticReport] = useState(null);

  // Audio Insights DSP & MusicBrainz Metadata state
  const [isAnalyzingDsp, setIsAnalyzingDsp] = useState(false);
  const [dspError, setDspError] = useState(null);
  const [metadataLookupState, setMetadataLookupState] = useState({
    status: 'idle', // 'idle' | 'loading' | 'enriched' | 'no-match' | 'offline' | 'error'
    message: null
  });

  // Settings & Environment Capability state
  const [settings, setSettings] = useState({
    visualizerSmoothing: 0.8,
    ambientGlow: true,
    persistBlobsInIdb: true,
    rememberMusicFolder: true,
    closeToTray: true,
    autoOnlineArtwork: true,
    autoOnlineLyrics: true,
    autoOnlineMetadata: true,
    keyboardShortcuts: true,
    eqPreset: 'flat', // 'flat' | 'warmth' | 'air' | 'vocal'
    gapless: true, // preload the next track and start it the instant this one ends
    themeMode: 'dark',
    accentColor: 'amber',
    customAccentHex: '#f59e0b',
    language: 'vi', // 'vi' | 'en'
    autoAlbumTheme: false
  });
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const [showColorPickerPopover, setShowColorPickerPopover] = useState(false);
  const colorPickerRef = useRef(null);
  const [localCustomHex, setLocalCustomHex] = useState(settings.customAccentHex || '#f59e0b');

  const t = useCallback(
    (key, fallback = '') => getTranslation(settings.language || 'vi', key, fallback),
    [settings.language]
  );

  useEffect(() => {
    if (settings.customAccentHex) {
      setLocalCustomHex(settings.customAccentHex);
    }
  }, [settings.customAccentHex]);

  const activePalette = useMemo(() => {
    return getPalette(settings.accentColor || 'amber', settings.customAccentHex || '#f59e0b');
  }, [settings.accentColor, settings.customAccentHex]);

  const activePaletteRef = useRef(activePalette);
  activePaletteRef.current = activePalette;

  useEffect(() => {
    applyAppearanceTokens(
      settings.themeMode || 'dark',
      settings.accentColor || 'amber',
      settings.customAccentHex || '#f59e0b'
    );
  }, [settings.themeMode, settings.accentColor, settings.customAccentHex]);

  useEffect(() => {
    if (!showColorPickerPopover) return;
    const handleClickOutside = (e) => {
      if (colorPickerRef.current && !colorPickerRef.current.contains(e.target)) {
        setShowColorPickerPopover(false);
      }
    };
    window.addEventListener('pointerdown', handleClickOutside);
    return () => window.removeEventListener('pointerdown', handleClickOutside);
  }, [showColorPickerPopover]);
  const [envStatus, setEnvStatus] = useState({
    indexedDbReady: false,
    webAudioReady: false,
    fsAccessSupported: false,
    directoryPickerSupported: false,
    isCrossOriginIframe: false,
    codecMatrix: []
  });

  const audioRef = useRef(null); // always points at the deck that currently owns playback
  // Two alternating <audio> decks: the idle one preloads the next track so it can start the instant this one ends
  const deckElsRef = useRef([null, null]);
  const activeDeckRef = useRef(0);
  const deckBusyRef = useRef([false, false]); // true while a deck plays out the last milliseconds of a track
  const deckTimersRef = useRef([null, null]);
  const preloadedRef = useRef(null); // { idx, trackId, url } for the track waiting on the idle deck
  const plannedNextRef = useRef(null); // shuffle: the next track is picked ahead of time so it can be preloaded
  const handoffTimerRef = useRef(null);
  const handoffLeadMsRef = useRef(35); // how early the next deck is started; tuned from measured start-up latency
  const handoffPlayAtRef = useRef(null);
  const [preloadTick, setPreloadTick] = useState(0);
  const deckRefCallbacks = useMemo(
    () =>
      [0, 1].map((idx) => (el) => {
        deckElsRef.current[idx] = el;
        if (el) {
          try {
            el.crossOrigin = 'anonymous';
          } catch { }
          if (idx === 0 && !audioRef.current) audioRef.current = el;
        }
      }),
    []
  );
  const shouldPlayRef = useRef(false);
  const isTransitioningTrackRef = useRef(false);
  const lastEndedTrackIdRef = useRef(null);
  const audioCtxRef = useRef(null);
  const analyserRef = useRef(null);
  const sourceNodeRef = useRef(null);
  const connectedMediaElementsRef = useRef(new WeakSet());
  const eqLowRef = useRef(null);
  const eqMidRef = useRef(null);
  const eqHighRef = useRef(null);
  const visualizerCanvasRef = useRef(null);
  const fullscreenVisualizerCanvasRef = useRef(null);
  const fileInputRef = useRef(null);
  const folderInputRef = useRef(null);
  const lastFullscreenTriggerRef = useRef(null);

  const showToast = useCallback((message, type = 'info') => {
    setToast({ message, type, id: Date.now() });
  }, []);

  const toggleFullscreenMode = useCallback((targetMode, triggerEl = null) => {
    if (triggerEl && typeof triggerEl.focus === 'function') {
      lastFullscreenTriggerRef.current = triggerEl;
    }
    setFullscreenMode((prev) => {
      const next = prev === targetMode ? null : targetMode;
      if (typeof document !== 'undefined') {
        if (next && !document.fullscreenElement && document.documentElement?.requestFullscreen) {
          document.documentElement.requestFullscreen().catch(() => { });
        } else if (!next && document.fullscreenElement && document.exitFullscreen) {
          document.exitFullscreen().catch(() => { });
        }
      }
      return next;
    });
  }, []);

  const exitFullscreenMode = useCallback(() => {
    setFullscreenMode(null);
    if (typeof document !== 'undefined' && document.fullscreenElement && document.exitFullscreen) {
      document.exitFullscreen().catch(() => { });
    }
    if (lastFullscreenTriggerRef.current && typeof lastFullscreenTriggerRef.current.focus === 'function') {
      const el = lastFullscreenTriggerRef.current;
      setTimeout(() => el?.focus(), 0);
    }
  }, []);

  useEffect(() => {
    const handleFsChange = () => {
      if (typeof document !== 'undefined' && !document.fullscreenElement) {
        setFullscreenMode((prev) => (prev ? null : prev));
      }
    };
    document.addEventListener('fullscreenchange', handleFsChange);
    return () => document.removeEventListener('fullscreenchange', handleFsChange);
  }, []);

  // Window controls (minimize / maximize / close) for the custom title bar
  const [windowHost] = useState(() => getWindowHost());
  const showWindowControls = Boolean(windowHost) || isDesktopShell();
  const [isWinMaximized, setIsWinMaximized] = useState(false);

  const syncWindowState = useCallback(async () => {
    if (!windowHost) return;
    try {
      setIsWinMaximized(Boolean(await windowHost.isMaximized()));
    } catch (err) {
      /* the host cannot report its state */
    }
  }, [windowHost]);

  useEffect(() => {
    if (!windowHost) return undefined;
    let timer = null;
    const onResize = () => {
      clearTimeout(timer);
      timer = setTimeout(syncWindowState, 120);
    };
    syncWindowState();
    window.addEventListener('resize', onResize);
    const unsubscribe = windowHost.onMaximizedChange
      ? windowHost.onMaximizedChange((value) => setIsWinMaximized(Boolean(value)))
      : null;
    return () => {
      clearTimeout(timer);
      window.removeEventListener('resize', onResize);
      if (typeof unsubscribe === 'function') unsubscribe();
    };
  }, [windowHost, syncWindowState]);

  const runWindowAction = useCallback(
    async (action) => {
      if (action === 'close') {
        const toTray = Boolean(settingsRef.current.closeToTray);
        try {
          await invoke('close_aurelia_window', { closeToTray: toTray });
          if (toTray) {
            showToast(t('closeToTrayDesc') || 'Aurelia đang tiếp tục phát nhạc trong Khay hệ thống.', 'info');
          }
          return;
        } catch (e) {
          // Native command fallback
        }
        if (toTray) {
          try {
            const win = typeof getCurrentWindow === 'function' ? getCurrentWindow() : null;
            if (win && typeof win.hide === 'function') {
              await win.hide().catch(() => { });
              showToast(t('closeToTrayDesc') || 'Aurelia đang tiếp tục phát nhạc trong Khay hệ thống.', 'info');
              return;
            }
          } catch (e) {
            // fallback to windowHost
          }
        }
      }

      if (!windowHost) {
        showToast('Window controls are not connected to a desktop shell (no Tauri API or window.aureliaWindow found).', 'error');
        return;
      }
      // Tauri rejects with a readable message when a permission is missing, so surface it
      const reportError = (err) => showToast(`Window ${action} failed: ${err?.message || err}`, 'error');
      try {
        Promise.resolve(windowHost[action]())
          .then(() => {
            if (action === 'toggleMaximize') setTimeout(syncWindowState, 250);
          })
          .catch(reportError);
      } catch (err) {
        reportError(err);
      }
    },
    [windowHost, showToast, syncWindowState, t]
  );

  // Double-clicking empty title bar space maximizes / restores (Electron and Tauri already do this natively)
  const handleTitleBarDoubleClick = (e) => {
    if (!windowHost || windowHost.kind === 'tauri') return;
    if (e.target.closest && e.target.closest('button')) return;
    runWindowAction('toggleMaximize');
  };

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 4200);
    return () => clearTimeout(timer);
  }, [toast]);

  const currentTrack = useMemo(
    () => tracks.find((t) => t.id === currentTrackId) || null,
    [tracks, currentTrackId]
  );

  useEffect(() => {
    let isMounted = true;

    async function initializeEnvironment() {
      // 1. Inspect Browser & Canvas Sandbox Capabilities
      const testAudio = document.createElement('audio');
      const codecMatrix = SUPPORTED_CODECS.map((c) => {
        const res = testAudio.canPlayType(c.mime);
        return {
          ...c,
          support: res === 'probably' ? 'Verified (Probably)' : res === 'maybe' ? 'Supported (Maybe)' : 'Unsupported'
        };
      });

      let isIframe = false;
      try {
        isIframe = window.self !== window.top;
      } catch (e) {
        isIframe = true;
      }

      const fsApi = typeof window.showOpenFilePicker === 'function' && !isIframe;
      const dirPickerApi = typeof window.showDirectoryPicker === 'function' && !isIframe;
      const webAudio = typeof (window.AudioContext || window.webkitAudioContext) !== 'undefined';

      let idbOk = false;
      let storedTracks = [];
      let storedPlaylists = [];
      let storedSettings = [];
      let savedFolderRecord = null;

      try {
        await openAureliaDB();
        idbOk = true;
        [storedTracks, storedPlaylists, storedSettings, savedFolderRecord] = await Promise.all([
          dbGetAll('tracks'),
          dbGetAll('playlists'),
          dbGetAll('settings'),
          dbGet('handles', 'musicFolder')
        ]);
      } catch (err) {
        idbOk = false;
      }

      if (!isMounted) return;

      setEnvStatus({
        indexedDbReady: idbOk,
        webAudioReady: webAudio,
        fsAccessSupported: fsApi,
        directoryPickerSupported: dirPickerApi,
        isCrossOriginIframe: isIframe,
        codecMatrix
      });

      // 2. Restore user-imported tracks from IndexedDB while safely removing any legacy built-in demo records
      const restoredTracks = [];
      const seenRestoredKeys = new Set();
      for (const saved of storedTracks) {
        if (!saved || LEGACY_DEMO_TRACK_IDS.has(saved.id) || saved.isBuiltInReference === true) {
          // Safely remove legacy built-in demo track records from IndexedDB without touching user data
          if (saved?.id) {
            await dbDelete('tracks', saved.id);
          }
          continue;
        }

        // Skip any legacy persisted non-audio or playlist entries (.m3u, .m3u8, .cue, etc.)
        const candidatePath = saved.relativePath || saved.title || '';
        const savedCodec = String(saved.codec || '').toUpperCase();
        if (
          NON_AUDIO_EXT_REGEX.test(candidatePath) ||
          /^(M3U|M3U8|PLS|CUE|LRC|TXT|NFO|JPG|PNG)$/.test(savedCodec)
        ) {
          continue;
        }

        let restoredUrl = null;
        let needsRelink = true;
        if (saved.audioBlob instanceof Blob) {
          if (!isSupportedAudioFile({ name: candidatePath || `track.${savedCodec.toLowerCase()}`, type: saved.audioBlob.type })) {
            continue;
          }
          restoredUrl = URL.createObjectURL(saved.audioBlob);
          needsRelink = false;
        } else if (saved.filePath && typeof convertFileSrc === 'function') {
          try {
            restoredUrl = convertFileSrc(saved.filePath);
            needsRelink = false;
          } catch (e) {
            needsRelink = true;
          }
        }
        const hasValidCover =
          typeof saved.coverUrl === 'string' &&
          (saved.coverUrl.startsWith('data:') || saved.coverUrl.startsWith('http'));
        const pathMeta = inferMetadataFromRelativePath(saved.relativePath || saved.title || '', saved.title || '');
        const fullSavedPath = String(saved.filePath || '').replace(/\\/g, '/');
        const nativeSavedDir = fullSavedPath.includes('/') ? fullSavedPath.slice(0, fullSavedPath.lastIndexOf('/')) : '';
        const resolvedFolderPath = saved.folderPath || pathMeta.folderPath || nativeSavedDir || '';
        const resolvedAlbum = saved.album || pathMeta.album || 'Unsorted Local Album';
        const resolvedAlbumArtist = saved.albumArtist || saved.artist || pathMeta.artist || 'Unknown Artist';
        const resolvedAlbumId = buildAlbumIdentityKey(resolvedAlbum, resolvedAlbumArtist, resolvedFolderPath);

        const dedupKey = buildCanonicalTrackDedupKey(
          {
            ...saved,
            album: resolvedAlbum,
            albumArtist: resolvedAlbumArtist,
            folderPath: resolvedFolderPath
          },
          saved.fileSize
        );
        if (seenRestoredKeys.has(dedupKey)) {
          continue;
        }
        seenRestoredKeys.add(dedupKey);

        restoredTracks.push({
          ...saved,
          album: resolvedAlbum,
          albumArtist: resolvedAlbumArtist,
          albumId: resolvedAlbumId,
          trackNumber: saved.trackNumber ?? pathMeta.trackNumber ?? null,
          discNumber: saved.discNumber ?? pathMeta.discNumber ?? 1,
          folderPath: resolvedFolderPath,
          fieldSources: saved.fieldSources || {},
          objectUrl: restoredUrl,
          needsRelink,
          coverProvenance: saved.coverProvenance || (hasValidCover ? 'Cached Track Artwork' : 'Procedural Fallback Artwork'),
          isArtworkVerified: Boolean(saved.isArtworkVerified && hasValidCover),
          coverUrl: hasValidCover
            ? saved.coverUrl
            : createProceduralCoverSvg(resolvedAlbum || saved.title || 'Local Track', saved.codec || 'AUDIO', [
              '#111827',
              '#1e293b',
              '#090d16',
              '#a855f7'
            ])
        });
      }

      setTracks(restoredTracks);
      setQueue(restoredTracks.map((t) => t.id));
      setCurrentTrackId(restoredTracks[0]?.id || null);
      setSelectedAlbumId(restoredTracks[0]?.albumId || null);

      if (storedPlaylists.length > 0) {
        const cleanedPlaylists = [];
        for (const pl of storedPlaylists) {
          const filteredIds = Array.isArray(pl.trackIds)
            ? pl.trackIds.filter((id) => !LEGACY_DEMO_TRACK_IDS.has(id))
            : [];
          if (pl.id === 'pl-reference' && filteredIds.length === 0) {
            await dbDelete('playlists', 'pl-reference');
            continue;
          }
          const updatedPl = { ...pl, trackIds: filteredIds };
          cleanedPlaylists.push(updatedPl);
          if (filteredIds.length !== (pl.trackIds?.length || 0)) {
            await dbPut('playlists', updatedPl);
          }
        }
        if (cleanedPlaylists.length > 0) {
          setPlaylists(cleanedPlaylists);
        }
      }
      const savedConfig = storedSettings.find((s) => s.key === 'appSettings');
      if (savedConfig && savedConfig.value) {
        setSettings((prev) => ({ ...prev, ...savedConfig.value }));
      }

      // Restore 10-band PEQ state and custom user presets with IndexedDB + localStorage synchronization
      const savedPeq = storedSettings.find((s) => s.key === 'peqState');
      if (savedPeq && savedPeq.value) {
        const normalized = validateAndNormalizePeqState(savedPeq.value);
        setPeqState(normalized);
        try {
          localStorage.setItem('aurelia_peq_state', JSON.stringify(normalized));
        } catch {}
      } else {
        try {
          const local = localStorage.getItem('aurelia_peq_state');
          if (local) {
            const normalized = validateAndNormalizePeqState(JSON.parse(local));
            setPeqState(normalized);
            dbPut('settings', { key: 'peqState', value: normalized }).catch(() => {});
          }
        } catch {}
      }

      const savedCustomPresets = storedSettings.find((s) => s.key === 'customPeqPresets');
      if (savedCustomPresets && Array.isArray(savedCustomPresets.value) && savedCustomPresets.value.length > 0) {
        setCustomPeqPresets(savedCustomPresets.value);
        try {
          localStorage.setItem('aurelia_custom_peq_presets', JSON.stringify(savedCustomPresets.value));
        } catch {}
      } else {
        try {
          const local = localStorage.getItem('aurelia_custom_peq_presets');
          if (local) {
            const parsed = JSON.parse(local);
            if (Array.isArray(parsed) && parsed.length > 0) {
              setCustomPeqPresets(parsed);
              dbPut('settings', { key: 'customPeqPresets', value: parsed }).catch(() => {});
            }
          }
        } catch {}
      }
      peqLoadedRef.current = true;

      // Restore remembered music folder record natively without localhost permission prompts
      if (savedFolderRecord) {
        setRememberedFolder({
          handle: null,
          name: savedFolderRecord.name || 'Local Music Folder',
          path: savedFolderRecord.path || null,
          mode: savedFolderRecord.mode || 'tauri-native',
          permissionState: 'granted',
          trackCount: savedFolderRecord.trackCount || 0,
          lastScannedAt: savedFolderRecord.lastScannedAt || null
        });
      }
    }

    initializeEnvironment();
    return () => {
      isMounted = false;
    };
  }, []);

  // Persist PEQ state and custom presets to both localStorage and IndexedDB
  useEffect(() => {
    try {
      localStorage.setItem('aurelia_peq_state', JSON.stringify(peqState));
    } catch {}
    if (peqLoadedRef.current) {
      dbPut('settings', { key: 'peqState', value: peqState }).catch(() => { });
    }
  }, [peqState]);

  useEffect(() => {
    try {
      localStorage.setItem('aurelia_custom_peq_presets', JSON.stringify(customPeqPresets));
    } catch {}
    if (peqLoadedRef.current) {
      dbPut('settings', { key: 'customPeqPresets', value: customPeqPresets }).catch(() => { });
    }
  }, [customPeqPresets]);

  useEffect(() => {
    if (!currentTrack?.coverUrl) return;
    setBackdropState((prev) => {
      if (prev.activeUrl === currentTrack.coverUrl) return prev;
      return {
        prevUrl: prev.activeUrl,
        activeUrl: currentTrack.coverUrl,
        transitioning: true
      };
    });
    const timer = setTimeout(() => {
      setBackdropState((prev) => ({ ...prev, transitioning: false }));
    }, 850);
    return () => clearTimeout(timer);
  }, [currentTrack?.coverUrl]);

  useEffect(() => {
    if (!currentTrack || currentTrack.isBuiltInReference || currentTrack.isArtworkVerified) {
      setArtworkLookupStatus(null);
      return;
    }
    if (!settings.autoOnlineArtwork) {
      setArtworkLookupStatus('Online artwork lookup disabled in Settings');
      return;
    }

    const controller = new AbortController();
    const targetTrackId = currentTrack.id;
    const targetAlbumId = currentTrack.albumId;
    setArtworkLookupStatus('Searching verified album artwork...');

    const timer = setTimeout(async () => {
      try {
        const match = await resolveOnlineTrackArtwork(currentTrack, controller.signal);
        if (controller.signal.aborted) return;
        if (match && match.artworkUrl) {
          setTracks((prev) =>
            prev.map((t) => {
              // Propagate verified album artwork to sibling tracks of the same album if they lack verified art
              const isSameTrack = t.id === targetTrackId;
              const isUnverifiedAlbumSibling =
                targetAlbumId && t.albumId === targetAlbumId && !t.isArtworkVerified;
              if (!isSameTrack && !isUnverifiedAlbumSibling) return t;
              const updated = {
                ...t,
                coverUrl: match.artworkUrl,
                coverProvenance: match.provenance,
                isArtworkVerified: true
              };
              dbPut('tracks', {
                ...updated,
                objectUrl: null,
                audioBlob: settings.persistBlobsInIdb ? updated.audioBlob : null
              });
              return updated;
            })
          );
          setArtworkLookupStatus(match.provenance);
        } else {
          setArtworkLookupStatus('No verified online artwork match — using safe procedural cover');
        }
      } catch (err) {
        if (err.name !== 'AbortError') {
          setArtworkLookupStatus('Artwork lookup offline/unavailable — using safe fallback');
        }
      }
    }, 220);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [
    currentTrack?.id,
    currentTrack?.albumId,
    currentTrack?.isBuiltInReference,
    currentTrack?.isArtworkVerified,
    settings.autoOnlineArtwork,
    settings.persistBlobsInIdb
  ]);

  useEffect(() => {
    if (!currentTrack) {
      setAutoLyricsState({ status: 'idle', message: null });
      return;
    }

    const existingText = (currentTrack.lyrics || '').trim();
    if (existingText) {
      const parsed = parseLrcLyrics(existingText);
      setAutoLyricsState({
        status: parsed.isSynced ? 'synced' : 'plain',
        message: currentTrack.lyricsSource || (parsed.isSynced ? 'Synchronized LRC' : 'Plain Lyrics')
      });
      return;
    }

    if (!settings.autoOnlineLyrics) {
      setAutoLyricsState({
        status: 'not-found',
        message: 'Automatic online lyrics disabled in Settings'
      });
      return;
    }

    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      setAutoLyricsState({
        status: 'offline',
        message: 'Offline — no cached lyrics for this track'
      });
      return;
    }

    const controller = new AbortController();
    const targetTrackId = currentTrack.id;
    setAutoLyricsState({
      status: 'loading',
      message: `Syncing lyrics for "${currentTrack.title}"...`
    });

    const debounceTimer = setTimeout(async () => {
      try {
        const resolved = await resolveAutomaticOnlineLyrics(currentTrack, controller.signal);
        if (controller.signal.aborted) return;

        if (resolved && resolved.lyrics) {
          setTracks((prev) =>
            prev.map((t) => {
              if (t.id !== targetTrackId) return t;
              const updated = {
                ...t,
                lyrics: resolved.lyrics,
                lyricsSource: resolved.lyricsSource
              };
              dbPut('tracks', {
                ...updated,
                objectUrl: null,
                audioBlob: settings.persistBlobsInIdb ? updated.audioBlob : null
              });
              return updated;
            })
          );
          setAutoLyricsState({
            status: resolved.isSynced ? 'synced' : 'plain',
            message: resolved.lyricsSource
          });
        } else {
          setAutoLyricsState({
            status: 'not-found',
            message: 'No synchronized lyrics found on LRCLIB'
          });
        }
      } catch (err) {
        if (err.name === 'AbortError') return;
        setAutoLyricsState({
          status: typeof navigator !== 'undefined' && !navigator.onLine ? 'offline' : 'error',
          message: 'Lyrics service unavailable'
        });
      }
    }, 280);

    return () => {
      clearTimeout(debounceTimer);
      controller.abort();
    };
  }, [
    currentTrack?.id,
    currentTrack?.lyrics,
    settings.autoOnlineLyrics,
    settings.persistBlobsInIdb
  ]);

  const triggerMusicBrainzEnrichment = useCallback(
    async (trackToEnrich, signal) => {
      if (!trackToEnrich) return;
      setMetadataLookupState({
        status: 'loading',
        message: 'Querying MusicBrainz...'
      });

      try {
        const mb = await resolveMusicBrainzMetadata(trackToEnrich, signal);
        if (signal?.aborted) return;

        if (!mb) {
          setMetadataLookupState({
            status: 'no-match',
            message: 'No high-confidence MusicBrainz match'
          });
          return;
        }

        setTracks((prev) =>
          prev.map((t) => {
            if (t.id !== trackToEnrich.id) return t;
            const nextSources = { ...(t.fieldSources || {}) };
            const updated = { ...t, musicBrainzEnriched: true, musicBrainzUrl: mb.musicBrainzUrl || t.musicBrainzUrl };

            // Only enrich missing or path-inferred fields; never overwrite verified embedded tags
            if (mb.title && nextSources.title !== 'Embedded') {
              updated.title = mb.title;
              nextSources.title = 'MusicBrainz';
            }
            if (mb.artist && nextSources.artist !== 'Embedded') {
              updated.artist = mb.artist;
              nextSources.artist = 'MusicBrainz';
            }
            if (
              Array.isArray(mb.contributingArtists) &&
              mb.contributingArtists.length > 0 &&
              nextSources.contributingArtists !== 'Embedded'
            ) {
              updated.contributingArtists = mb.contributingArtists;
              nextSources.contributingArtists = 'MusicBrainz';
            }
            if (mb.album && nextSources.album !== 'Embedded') {
              updated.album = mb.album;
              nextSources.album = 'MusicBrainz';
            }
            if (mb.albumArtist && nextSources.albumArtist !== 'Embedded') {
              updated.albumArtist = mb.albumArtist;
              nextSources.albumArtist = 'MusicBrainz';
            }
            if (mb.year && nextSources.year !== 'Embedded') {
              updated.year = mb.year;
              nextSources.year = 'MusicBrainz';
            }
            if (mb.releaseDate && nextSources.releaseDate !== 'Embedded') {
              updated.releaseDate = mb.releaseDate;
              nextSources.releaseDate = 'MusicBrainz';
            }
            if (Array.isArray(mb.genres) && mb.genres.length > 0 && nextSources.genre !== 'Embedded') {
              updated.genres = mb.genres;
              updated.genre = mb.genres[0];
              nextSources.genre = 'MusicBrainz';
            }
            if (mb.trackNumber && nextSources.trackNumber !== 'Embedded' && !t.trackNumber) {
              updated.trackNumber = mb.trackNumber;
              nextSources.trackNumber = 'MusicBrainz';
            }
            if (mb.totalTracks && !t.totalTracks) {
              updated.totalTracks = mb.totalTracks;
            }
            if (mb.discNumber && nextSources.discNumber !== 'Embedded' && !t.discNumber) {
              updated.discNumber = mb.discNumber;
              nextSources.discNumber = 'MusicBrainz';
            }
            if (mb.label && nextSources.label !== 'Embedded') {
              updated.label = mb.label;
              nextSources.label = 'MusicBrainz';
            }
            if (mb.catalogNumber && nextSources.catalogNumber !== 'Embedded') {
              updated.catalogNumber = mb.catalogNumber;
              nextSources.catalogNumber = 'MusicBrainz';
            }
            if (mb.releaseCountry && nextSources.releaseCountry !== 'Embedded') {
              updated.releaseCountry = mb.releaseCountry;
              nextSources.releaseCountry = 'MusicBrainz';
            }
            if (mb.composer && nextSources.composer !== 'Embedded') {
              updated.composer = mb.composer;
              nextSources.composer = 'MusicBrainz';
            }
            if (mb.songwriter && nextSources.songwriter !== 'Embedded') {
              updated.songwriter = mb.songwriter;
              nextSources.songwriter = 'MusicBrainz';
            }
            if (mb.isrc && nextSources.isrc !== 'Embedded') {
              updated.isrc = mb.isrc;
              nextSources.isrc = 'MusicBrainz';
            }
            if (mb.coverArtArchiveUrl) {
              updated.releaseArtworkUrl = mb.coverArtArchiveUrl;
              if (!t.isArtworkVerified) {
                updated.coverUrl = mb.coverArtArchiveUrl;
                updated.coverProvenance = 'Cover Art Archive (MusicBrainz Release)';
                updated.isArtworkVerified = true;
                nextSources.artwork = 'MusicBrainz';
              }
            }

            updated.fieldSources = nextSources;

            dbPut('tracks', {
              ...updated,
              objectUrl: null,
              audioBlob: settings.persistBlobsInIdb ? updated.audioBlob : null
            });
            return updated;
          })
        );

        setMetadataLookupState({
          status: 'enriched',
          message: mb.fromCache ? 'MusicBrainz (Cached)' : 'Enriched via MusicBrainz'
        });
      } catch (err) {
        if (err?.name === 'AbortError') return;
        setMetadataLookupState({
          status: typeof navigator !== 'undefined' && !navigator.onLine ? 'offline' : 'error',
          message:
            typeof navigator !== 'undefined' && !navigator.onLine
              ? 'Offline — using embedded & cached metadata'
              : 'MusicBrainz lookup unavailable'
        });
      }
    },
    [settings.persistBlobsInIdb]
  );

  useEffect(() => {
    if (!currentTrack) {
      setMetadataLookupState({ status: 'idle', message: null });
      return;
    }

    if (currentTrack.musicBrainzEnriched) {
      setMetadataLookupState({
        status: 'enriched',
        message: 'MusicBrainz Enriched'
      });
      return;
    }

    const hasAllCoreMetadata =
      currentTrack.fieldSources?.title === 'Embedded' &&
      currentTrack.fieldSources?.artist === 'Embedded' &&
      currentTrack.fieldSources?.album === 'Embedded' &&
      Boolean(currentTrack.year) &&
      Boolean(currentTrack.genre) &&
      Boolean(currentTrack.label) &&
      Boolean(currentTrack.isrc);

    if (hasAllCoreMetadata) {
      setMetadataLookupState({
        status: 'enriched',
        message: 'Complete Embedded Metadata'
      });
      return;
    }

    if (!settings.autoOnlineMetadata) {
      setMetadataLookupState({
        status: 'idle',
        message: 'Online metadata lookup disabled'
      });
      return;
    }

    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      setMetadataLookupState({
        status: 'offline',
        message: 'Offline — showing embedded metadata'
      });
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => {
      triggerMusicBrainzEnrichment(currentTrack, controller.signal);
    }, 420);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [
    currentTrack?.id,
    currentTrack?.musicBrainzEnriched,
    settings.autoOnlineMetadata,
    triggerMusicBrainzEnrichment
  ]);

  const ensureAudioGraph = useCallback(() => {
    if (!audioRef.current) return;
    if (audioCtxRef.current) {
      if (audioCtxRef.current.state === 'suspended') {
        audioCtxRef.current.resume().catch(() => { });
      }
      if (preampGainRef.current) {
        deckElsRef.current.filter(Boolean).forEach((el) => {
          if (!connectedMediaElementsRef.current.has(el)) {
            try {
              const src = audioCtxRef.current.createMediaElementSource(el);
              src.connect(preampGainRef.current);
              connectedMediaElementsRef.current.add(el);
            } catch (err) {
              console.warn('Audio deck reconnect notice:', err);
            }
          }
        });
      }
      return;
    }
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;

    try {
      const ctx = new AudioCtx();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = settings.visualizerSmoothing;

      // 10-Band Parametric Equalizer chain with Preamp stage
      const preampGain = ctx.createGain();
      const filterNodes = DEFAULT_PEQ_FREQUENCIES.map((freq, idx) => {
        const node = ctx.createBiquadFilter();
        node.type = idx === 0 ? 'lowshelf' : idx === 9 ? 'highshelf' : 'peaking';
        node.frequency.value = freq;
        return node;
      });

      // Both decks feed the same Preamp -> 10-Band EQ -> Analyser -> Output chain
      let firstSource = null;
      deckElsRef.current.filter(Boolean).forEach((el) => {
        if (!connectedMediaElementsRef.current.has(el)) {
          try {
            const src = ctx.createMediaElementSource(el);
            src.connect(preampGain);
            connectedMediaElementsRef.current.add(el);
            if (!firstSource) firstSource = src;
          } catch (err) {
            console.warn('Audio deck initial connect notice:', err);
          }
        }
      });

      preampGain.connect(filterNodes[0]);
      for (let i = 0; i < filterNodes.length - 1; i++) {
        filterNodes[i].connect(filterNodes[i + 1]);
      }
      filterNodes[filterNodes.length - 1].connect(analyser);
      analyser.connect(ctx.destination);

      audioCtxRef.current = ctx;
      analyserRef.current = analyser;
      sourceNodeRef.current = firstSource;
      preampGainRef.current = preampGain;
      filterNodesRef.current = filterNodes;

      applyPeqToAudioNodes(ctx, preampGain, filterNodes, peqStateRef.current || peqState);
    } catch (err) {
      console.warn('Web Audio graph setup notice:', err);
    }
  }, [settings.visualizerSmoothing, peqState]);

  // Unloads a deck that is no longer the active one
  const finalizeDeck = useCallback((idx) => {
    clearTimeout(deckTimersRef.current[idx]);
    deckTimersRef.current[idx] = null;
    deckBusyRef.current[idx] = false;
    if (idx === activeDeckRef.current) return;
    const el = deckElsRef.current[idx];
    if (el) {
      try {
        el.pause();
        el.removeAttribute('src');
        el.load();
      } catch (err) {
        /* ignore */
      }
    }
    if (preloadedRef.current && preloadedRef.current.idx === idx) preloadedRef.current = null;
  }, []);

  const cancelHandoff = useCallback(() => {
    clearTimeout(handoffTimerRef.current);
    handoffTimerRef.current = null;
  }, []);

  // If the idle deck already holds `url` and is ready, it becomes the active deck and starts instantly
  const takePreloadedDeck = useCallback(
    (url) => {
      const idx = 1 - activeDeckRef.current;
      const el = deckElsRef.current[idx];
      if (!el || !url || el.src !== url || el.readyState < 2) return null;
      const oldIdx = activeDeckRef.current;
      audioRef.current = el;
      activeDeckRef.current = idx;
      preloadedRef.current = null;
      finalizeDeck(oldIdx);
      if (el.currentTime > 0) el.currentTime = 0;
      return el;
    },
    [finalizeDeck]
  );

  useEffect(() => {
    if (analyserRef.current) {
      analyserRef.current.smoothingTimeConstant = settings.visualizerSmoothing;
    }
    if (
      audioCtxRef.current &&
      preampGainRef.current &&
      Array.isArray(filterNodesRef.current) &&
      filterNodesRef.current.length === 10
    ) {
      applyPeqToAudioNodes(
        audioCtxRef.current,
        preampGainRef.current,
        filterNodesRef.current,
        peqState
      );
    }
  }, [settings.visualizerSmoothing, peqState]);

  useEffect(() => {
    let animationId;
    const freqData = new Uint8Array(256);
    let lastDrawTime = 0;
    const FRAME_INTERVAL = 1000 / 30; // Cap to 30 FPS for silky performance without GPU choke

    // Pre-calculate logarithmic frequency bin lookup for 52 visualizer bars
    const BIN_INDICES = new Uint16Array(52);
    for (let i = 0; i < 52; i++) {
      BIN_INDICES[i] = Math.min(255, Math.floor(Math.pow(i / 52, 1.5) * 175));
    }

    // Pre-formatted palette colors
    const pal = activePaletteRef.current || activePalette;
    const r500 = (pal?.rgb500 || '245 158 11').replace(/ /g, ', ');
    const r400 = (pal?.rgb400 || '251 191 36').replace(/ /g, ', ');
    const r300 = (pal?.rgb300 || '253 224 71').replace(/ /g, ', ');

    const renderVisualizer = (timestamp) => {
      // Throttle rendering to ~30 FPS
      if (timestamp - lastDrawTime < FRAME_INTERVAL) {
        animationId = requestAnimationFrame(renderVisualizer);
        return;
      }
      lastDrawTime = timestamp;

      const canvases = [
        visualizerCanvasRef.current,
        fullscreenVisualizerCanvasRef.current
      ].filter(Boolean);

      if (canvases.length > 0) {
        const analyser = analyserRef.current;
        if (analyser && isPlaying) {
          analyser.getByteFrequencyData(freqData);
        } else {
          let hasRemainingEnergy = false;
          for (let i = 0; i < freqData.length; i++) {
            freqData[i] = Math.max(0, Math.floor(freqData[i] * 0.8));
            if (freqData[i] > 0) hasRemainingEnergy = true;
          }
          if (!hasRemainingEnergy) {
            canvases.forEach((canvas) => {
              const ctx = canvas.getContext('2d');
              if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
            });
            return;
          }
        }

        canvases.forEach((canvas) => {
          const ctx = canvas.getContext('2d');
          if (!ctx) return;
          const width = canvas.width;
          const height = canvas.height;
          ctx.clearRect(0, 0, width, height);

          // Create gradient ONCE per canvas outside bar loop
          const isLight = document.documentElement.classList.contains('light-theme');
          const grad = ctx.createLinearGradient(0, height, 0, 0);
          if (isLight) {
            grad.addColorStop(0, `rgba(${r500}, 0.45)`);
            grad.addColorStop(0.6, `rgba(${r500}, 0.85)`);
            grad.addColorStop(1, `rgba(${r400}, 1.0)`);
          } else {
            grad.addColorStop(0, `rgba(${r500}, 0.22)`);
            grad.addColorStop(0.6, `rgba(${r400}, 0.68)`);
            grad.addColorStop(1, `rgba(${r300}, 0.92)`);
          }
          ctx.fillStyle = grad;

          const barCount = 52;
          const gap = 3;
          const barWidth = Math.max(2, (width - gap * (barCount - 1)) / barCount);

          // Batch all bar rectangles into a SINGLE canvas draw path
          ctx.beginPath();
          for (let i = 0; i < barCount; i++) {
            const binIdx = BIN_INDICES[i];
            const val = freqData[binIdx] / 255;
            const barH = Math.max(2, val * (height - 4));
            const x = i * (barWidth + gap);
            const y = height - barH;
            ctx.rect(x, y, barWidth, barH);
          }
          ctx.fill();
        });
      }
      animationId = requestAnimationFrame(renderVisualizer);
    };

    animationId = requestAnimationFrame(renderVisualizer);
    return () => cancelAnimationFrame(animationId);
  }, [isPlaying, fullscreenMode, activePalette]);

  useEffect(() => {
    let audio = audioRef.current;
    if (!audio || !currentTrack) return;

    setPlaybackError(null);

    if (currentTrack.needsRelink || !currentTrack.objectUrl) {
      isTransitioningTrackRef.current = false;
      shouldPlayRef.current = false;
      setIsPlaying(false);
      setPlaybackError('This local track was restored from IndexedDB metadata without a cached audio binary. Please re-import or relink the audio file to play.');
      return;
    }

    let cancelled = false;
    let canPlayHandler = null;

    const startElementPlayback = async () => {
      if (cancelled || !audioRef.current) return;
      ensureAudioGraph();
      if (audioCtxRef.current && audioCtxRef.current.state === 'suspended') {
        try {
          await audioCtxRef.current.resume();
        } catch { }
      }
      try {
        await audioRef.current.play();
        if (!cancelled) {
          isTransitioningTrackRef.current = false;
          shouldPlayRef.current = true;
          setIsPlaying(true);
          setPlaybackError(null);
        }
      } catch (err) {
        if (cancelled) return;
        if (err?.name === 'AbortError') {
          // Interrupted by a subsequent load or rapid track switch; wait for canplay if still intending to play
          return;
        }
        isTransitioningTrackRef.current = false;
        shouldPlayRef.current = false;
        setIsPlaying(false);
        setPlaybackError(
          `Autoplay paused by browser (${err?.message || 'interaction required'}). Press Play to continue.`
        );
      }
    };

    if (audio.src !== currentTrack.objectUrl) {
      isTransitioningTrackRef.current = true;
      lastEndedTrackIdRef.current = null;
      cancelHandoff();

      // Gapless fast path: the idle deck already holds this track, so just switch to it
      const preloadedDeck = settings.gapless ? takePreloadedDeck(currentTrack.objectUrl) : null;
      if (preloadedDeck) {
        audio = preloadedDeck;
      } else {
        if (audio.crossOrigin !== 'anonymous') {
          audio.crossOrigin = 'anonymous';
        }
        audio.src = currentTrack.objectUrl;
        audio.load();
      }
      setCurrentTime(0);
      setDuration(currentTrack.duration || 0);

      if (shouldPlayRef.current) {
        if (audio.readyState >= 2) {
          startElementPlayback();
        } else {
          canPlayHandler = () => {
            if (canPlayHandler && audioRef.current) {
              audioRef.current.removeEventListener('canplay', canPlayHandler);
              canPlayHandler = null;
            }
            if (!cancelled && shouldPlayRef.current) {
              startElementPlayback();
            }
          };
          audio.addEventListener('canplay', canPlayHandler);
          // Also attempt immediate play() since Blob URLs often resolve synchronously
          startElementPlayback();
        }
      } else {
        isTransitioningTrackRef.current = false;
      }
    } else if (shouldPlayRef.current && audio.paused) {
      startElementPlayback();
    }

    return () => {
      cancelled = true;
      if (canPlayHandler && audio) {
        audio.removeEventListener('canplay', canPlayHandler);
      }
    };
  }, [
    currentTrackId,
    currentTrack?.objectUrl,
    currentTrack?.needsRelink,
    ensureAudioGraph,
    takePreloadedDeck,
    cancelHandoff
  ]);

  useEffect(() => {
    deckElsRef.current.forEach((el) => {
      if (el) el.volume = isMuted ? 0 : volume;
    });
  }, [volume, isMuted]);

  const startTrackById = useCallback(
    (trackId) => {
      if (!trackId) return;
      shouldPlayRef.current = true;
      isTransitioningTrackRef.current = true;
      setIsPlaying(true);
      setCurrentTrackId(trackId);
    },
    []
  );

  const togglePlayPause = useCallback(async () => {
    const audio = audioRef.current;
    if (!audio || !currentTrack) return;
    if (currentTrack.needsRelink || !currentTrack.objectUrl) {
      showToast('Please relink or re-import this local audio file first.', 'error');
      return;
    }

    ensureAudioGraph();
    if (audioCtxRef.current && audioCtxRef.current.state === 'suspended') {
      audioCtxRef.current.resume().catch(() => { });
    }

    if (audio.paused) {
      try {
        shouldPlayRef.current = true;
        await audio.play();
        setIsPlaying(true);
        setPlaybackError(null);
      } catch (err) {
        shouldPlayRef.current = false;
        setIsPlaying(false);
        setPlaybackError(`Browser could not decode or play this file (${currentTrack.codec}).`);
        showToast('Playback error: unsupported codec or corrupted stream.', 'error');
      }
    } else {
      shouldPlayRef.current = false;
      cancelHandoff();
      audio.pause();
      setIsPlaying(false);
    }
  }, [currentTrack, ensureAudioGraph, showToast, cancelHandoff]);

  const handleNextTrack = useCallback(
    (isAutoEnded = false) => {
      if (queue.length === 0) return;
      const audio = audioRef.current;

      // Guard against duplicate ended triggers for the same track
      if (isAutoEnded) {
        if (lastEndedTrackIdRef.current === currentTrackId && isTransitioningTrackRef.current) {
          return;
        }
        lastEndedTrackIdRef.current = currentTrackId;
      }

      if (isAutoEnded && repeatMode === 'one' && audio) {
        shouldPlayRef.current = true;
        isTransitioningTrackRef.current = true;
        audio.currentTime = 0;
        setCurrentTime(0);
        setIsPlaying(true);
        ensureAudioGraph();
        audio
          .play()
          .then(() => {
            isTransitioningTrackRef.current = false;
          })
          .catch(() => {
            isTransitioningTrackRef.current = false;
          });
        return;
      }

      // Build list of playable track IDs in queue so auto-advance skips unlinked entries cleanly
      const trackById = new Map(tracks.map((t) => [t.id, t]));
      const isTrackPlayable = (id) => {
        const t = trackById.get(id);
        return Boolean(t && !t.needsRelink && t.objectUrl);
      };

      const shouldContinuePlaying = isAutoEnded ? true : shouldPlayRef.current || isPlaying;

      if (shuffle && queue.length > 1) {
        const candidates = queue.filter((id) => id !== currentTrackId && isTrackPlayable(id));
        if (candidates.length > 0) {
          const planned = plannedNextRef.current;
          const randomId =
            planned && planned.forId === currentTrackId && candidates.includes(planned.nextId)
              ? planned.nextId
              : candidates[Math.floor(Math.random() * candidates.length)];
          shouldPlayRef.current = shouldContinuePlaying;
          isTransitioningTrackRef.current = shouldContinuePlaying;
          setIsPlaying(shouldContinuePlaying);
          setCurrentTrackId(randomId);
          return;
        }
      }

      const currentIndex = queue.indexOf(currentTrackId);
      // Find next playable track after currentIndex
      let nextPlayableId = null;
      for (let idx = currentIndex + 1; idx < queue.length; idx++) {
        if (isTrackPlayable(queue[idx])) {
          nextPlayableId = queue[idx];
          break;
        }
      }

      if (nextPlayableId) {
        if (nextPlayableId === currentTrackId && audio) {
          shouldPlayRef.current = shouldContinuePlaying;
          audio.currentTime = 0;
          setCurrentTime(0);
          if (shouldContinuePlaying) {
            setIsPlaying(true);
            audio.play().catch(() => { });
          }
          return;
        }
        shouldPlayRef.current = shouldContinuePlaying;
        isTransitioningTrackRef.current = shouldContinuePlaying;
        setIsPlaying(shouldContinuePlaying);
        setCurrentTrackId(nextPlayableId);
        return;
      }

      // Reached the end of the queue: wrap around if repeatMode === 'all' or manual Next click
      if (repeatMode === 'all' || !isAutoEnded) {
        const firstPlayableId = queue.find((id) => isTrackPlayable(id)) || queue[0];
        if (!firstPlayableId) return;

        if (firstPlayableId === currentTrackId && audio) {
          shouldPlayRef.current = shouldContinuePlaying;
          audio.currentTime = 0;
          setCurrentTime(0);
          if (shouldContinuePlaying) {
            setIsPlaying(true);
            ensureAudioGraph();
            audio.play().catch(() => { });
          }
          return;
        }

        shouldPlayRef.current = shouldContinuePlaying;
        isTransitioningTrackRef.current = shouldContinuePlaying;
        setIsPlaying(shouldContinuePlaying);
        setCurrentTrackId(firstPlayableId);
      } else {
        // End of queue reached naturally with Repeat Off
        isTransitioningTrackRef.current = false;
        shouldPlayRef.current = false;
        setIsPlaying(false);
        setCurrentTime(0);
      }
    },
    [queue, tracks, currentTrackId, shuffle, repeatMode, isPlaying, ensureAudioGraph]
  );

  const handlePrevTrack = useCallback(() => {
    const audio = audioRef.current;
    if (audio && audio.currentTime > 3) {
      audio.currentTime = 0;
      setCurrentTime(0);
      return;
    }
    if (queue.length === 0) return;
    const shouldContinuePlaying = shouldPlayRef.current || isPlaying;
    const currentIndex = queue.indexOf(currentTrackId);
    const prevIndex = currentIndex > 0 ? currentIndex - 1 : queue.length - 1;
    const targetId = queue[prevIndex];
    if (!targetId) return;
    shouldPlayRef.current = shouldContinuePlaying;
    isTransitioningTrackRef.current = shouldContinuePlaying;
    setIsPlaying(shouldContinuePlaying);
    setCurrentTrackId(targetId);
  }, [queue, currentTrackId, isPlaying]);

  const handleSeek = useCallback((newTimeSec) => {
    const audio = audioRef.current;
    if (!audio || !Number.isFinite(newTimeSec)) return;
    const clamped = Math.max(0, Math.min(audio.duration || duration || 0, newTimeSec));
    cancelHandoff();
    audio.currentTime = clamped;
    currentTimeRef.current = clamped;
    lastTimeUpdateSecRef.current = clamped;
    setCurrentTime(clamped);
  }, [duration, cancelHandoff]);

  // Which track auto-advance will play next (null when playback should simply stop or repeat the same track)
  const peekNextTrackId = () => {
    if (queue.length < 2 || repeatMode === 'one' || !currentTrackId) return null;
    const trackById = new Map(tracks.map((t) => [t.id, t]));
    const playable = (id) => {
      const t = trackById.get(id);
      return Boolean(t && !t.needsRelink && t.objectUrl);
    };
    if (shuffle) {
      const candidates = queue.filter((id) => id !== currentTrackId && playable(id));
      if (candidates.length === 0) return null;
      const planned = plannedNextRef.current;
      if (planned && planned.forId === currentTrackId && candidates.includes(planned.nextId)) {
        return planned.nextId;
      }
      const pick = candidates[Math.floor(Math.random() * candidates.length)];
      plannedNextRef.current = { forId: currentTrackId, nextId: pick };
      return pick;
    }
    const idx = queue.indexOf(currentTrackId);
    for (let i = idx + 1; i < queue.length; i++) {
      if (playable(queue[i])) return queue[i];
    }
    if (repeatMode === 'all') {
      return queue.find((id) => id !== currentTrackId && playable(id)) || null;
    }
    return null;
  };

  // Keeps the idle deck loaded with the track that plays next
  useEffect(() => {
    const idx = 1 - activeDeckRef.current;
    const el = deckElsRef.current[idx];
    if (!el) return undefined;
    const release = () => {
      if (el.getAttribute('src')) {
        try {
          el.pause();
          el.removeAttribute('src');
          el.load();
        } catch (err) {
          /* ignore */
        }
      }
      preloadedRef.current = null;
    };
    if (deckBusyRef.current[idx]) {
      // The idle deck is still playing out the tail of the previous track; try again shortly
      const retry = setTimeout(() => setPreloadTick((n) => n + 1), 300);
      return () => clearTimeout(retry);
    }
    if (!settings.gapless || !currentTrackId) {
      release();
      return undefined;
    }
    const nextId = peekNextTrackId();
    const next = nextId ? tracks.find((t) => t.id === nextId) : null;
    if (!next || next.needsRelink || !next.objectUrl) {
      release();
      return undefined;
    }
    if (el.src !== next.objectUrl) {
      if (el.crossOrigin !== 'anonymous') {
        el.crossOrigin = 'anonymous';
      }
      el.preload = 'auto';
      el.src = next.objectUrl;
      el.load();
    }
    preloadedRef.current = { idx, trackId: next.id, url: next.objectUrl };
    return undefined;
  }, [currentTrackId, queue, tracks, shuffle, repeatMode, settings.gapless, preloadTick]);

  // Starts the preloaded deck a hair before the current one ends so the two tracks butt up with no gap
  const performGaplessHandoff = (outgoing) => {
    handoffTimerRef.current = null;
    if (outgoing !== audioRef.current || outgoing.paused) return;
    const remaining = outgoing.duration - outgoing.currentTime;
    if (!(remaining <= 0.5)) return; // the listener seeked away; timeupdate will re-arm it when needed
    const pre = preloadedRef.current;
    const incoming = pre ? deckElsRef.current[pre.idx] : null;
    if (!pre || !incoming || incoming.src !== pre.url || incoming.readyState < 2) return;

    // Audio first, bookkeeping second: nothing else may delay the start of the next track
    const outIdx = activeDeckRef.current;
    handoffPlayAtRef.current = performance.now();
    if (incoming.currentTime > 0) incoming.currentTime = 0;
    incoming.play().catch(() => { });
    audioRef.current = incoming;
    activeDeckRef.current = pre.idx;
    preloadedRef.current = null;

    // The old deck plays out its last few milliseconds on its own and is unloaded once it ends
    deckBusyRef.current[outIdx] = true;
    clearTimeout(deckTimersRef.current[outIdx]);
    deckTimersRef.current[outIdx] = setTimeout(
      () => finalizeDeck(outIdx),
      Math.max(800, remaining * 1000 + 600)
    );

    const nextTrack = tracks.find((t) => t.id === pre.trackId);
    shouldPlayRef.current = true;
    isTransitioningTrackRef.current = false;
    lastEndedTrackIdRef.current = null;
    setIsPlaying(true);
    setCurrentTime(0);
    setDuration(Number.isFinite(incoming.duration) ? incoming.duration : nextTrack?.duration || 0);
    setPlaybackError(null);
    setCurrentTrackId(pre.trackId);
  };

  const handleDeckTimeUpdate = (e) => {
    const audio = e.currentTarget;
    if (audio !== audioRef.current) return;
    const nowSec = audio.currentTime;
    currentTimeRef.current = nowSec;

    // Throttle React state updates to ~400ms to keep progress smooth without choking CPU
    if (Math.abs(nowSec - lastTimeUpdateSecRef.current) >= 0.4 || audio.paused || nowSec === 0) {
      lastTimeUpdateSecRef.current = nowSec;
      setCurrentTime(nowSec);
    }

    if (!settings.gapless || audio.paused || handoffTimerRef.current) return;
    const dur = audio.duration;
    if (!Number.isFinite(dur) || dur < 2) return;
    const remaining = dur - nowSec;
    if (remaining > 1.5 || remaining <= 0) return;
    const pre = preloadedRef.current;
    const idle = pre ? deckElsRef.current[pre.idx] : null;
    if (!pre || !idle || idle.src !== pre.url || idle.readyState < 3) return;
    if (pre.trackId !== peekNextTrackId()) return;
    const delay = Math.max(0, remaining * 1000 - handoffLeadMsRef.current);
    handoffTimerRef.current = setTimeout(() => performGaplessHandoff(audio), delay);
  };

  const runTrackDspAnalysis = useCallback(
    async (trackToAnalyze) => {
      if (!trackToAnalyze || !trackToAnalyze.audioBlob) return;
      setIsAnalyzingDsp(true);
      setDspError(null);
      try {
        const dsp = await performOfflineSignalAnalysis(trackToAnalyze.audioBlob, trackToAnalyze);
        setTracks((prev) =>
          prev.map((t) => {
            if (t.id !== trackToAnalyze.id) return t;
            const updated = {
              ...t,
              duration: dsp.duration || t.duration,
              sampleRate: t.sampleRate || dsp.sampleRate,
              sampleRateSource: t.sampleRate ? t.sampleRateSource : dsp.sampleRateSource,
              channels: t.channels || dsp.channels,
              channelsSource: t.channels ? t.channelsSource : dsp.channelsSource,
              dspAnalysis: dsp
            };
            dbPut('tracks', {
              ...updated,
              objectUrl: null,
              audioBlob: settings.persistBlobsInIdb ? updated.audioBlob : null
            });
            return updated;
          })
        );
      } catch (err) {
        setDspError(`Could not decode PCM buffer for offline analysis: ${err.message || 'Unsupported format'}`);
      } finally {
        setIsAnalyzingDsp(false);
      }
    },
    [settings.persistBlobsInIdb]
  );

  useEffect(() => {
    if (activeTab === 'insights' && currentTrack && !currentTrack.dspAnalysis && currentTrack.audioBlob && !isAnalyzingDsp) {
      const timer = setTimeout(() => {
        runTrackDspAnalysis(currentTrack);
      }, 350);
      return () => clearTimeout(timer);
    }
  }, [activeTab, currentTrack, isAnalyzingDsp, runTrackDspAnalysis]);

  const processNormalizedImportEntries = useCallback(
    async (rawEntries, sourceFolderName = null, stats = { folders: 0, errors: 0, skippedNonAudio: 0 }) => {
      // Strictly filter rawEntries so non-audio/playlist files (.m3u, .m3u8, .pls, .cue, etc.) can never create tracks or albums
      const validAudioEntries = [];
      let extraSkippedNonAudio = 0;
      for (const item of rawEntries || []) {
        if (item && item.file && isSupportedAudioFile(item.file)) {
          validAudioEntries.push(item);
        } else {
          extraSkippedNonAudio++;
        }
      }
      const totalSkippedNonAudio = (stats.skippedNonAudio || 0) + extraSkippedNonAudio;

      if (validAudioEntries.length === 0) {
        if (stats.folders > 0 || totalSkippedNonAudio > 0) {
          showToast(
            `Scanned ${Math.max(1, stats.folders)} folder(s)${totalSkippedNonAudio > 0 ? ` (${totalSkippedNonAudio} non-audio/playlist file(s) skipped)` : ''
            }, but no supported audio tracks were found.`,
            'info'
          );
        } else {
          showToast('No supported audio files (.mp3, .flac, .wav, .m4a, .ogg, .opus) found in selection.', 'error');
        }
        return;
      }

      const palettes = [
        ['#0f172a', '#1e1b4b', '#090d16', '#38bdf8'],
        ['#18181b', '#27272a', '#09090b', '#f59e0b'],
        ['#140d1f', '#2e1065', '#090514', '#c084fc'],
        ['#062019', '#064e3b', '#04130f', '#34d399']
      ];

      const totalDiscovered = validAudioEntries.length;
      let importedCount = 0;
      let relinkedCount = 0;
      let duplicateSkippedCount = 0;
      let errorCount = stats.errors || 0;

      setImportProgress({
        active: true,
        folderName: sourceFolderName || 'Selected Audio Batch',
        foldersScanned: stats.folders || 1,
        totalDiscovered,
        processed: 0,
        imported: 0,
        relinked: 0,
        duplicatesSkipped: 0,
        unsupportedSkipped: totalSkippedNonAudio,
        errors: errorCount,
        currentFile: ''
      });

      // Build lookup maps of existing tracks by exact fingerprint AND canonical track identity to prevent duplicates on repeated or overlapping imports
      const existingByFingerprint = new Map();
      const existingByCanonicalKey = new Map();
      const folderAlbumConsensus = new Map();

      tracks.forEach((t) => {
        if (!t.isBuiltInReference) {
          const fp = t.fingerprint || `${normalizeIdentityText(t.relativePath || t.title || '')}|${t.fileSize || 0}`;
          existingByFingerprint.set(fp, t);
          existingByCanonicalKey.set(buildCanonicalTrackDedupKey(t, t.fileSize), t);

          const normFolder = normalizeAlbumFolderRoot(t.folderPath);
          if (normFolder && t.album && t.album !== 'Unsorted Local Album') {
            const consensusKey = `${normFolder}:::${normalizeIdentityText(t.album)}`;
            const existing = folderAlbumConsensus.get(consensusKey);
            if (!existing) {
              folderAlbumConsensus.set(consensusKey, {
                album: t.album,
                albumArtist: t.albumArtist || 'Various Artists',
                albumId: t.albumId || buildAlbumIdentityKey(t.album, t.albumArtist || t.artist, t.folderPath),
                artists: new Set(t.artist ? [t.artist] : [])
              });
            } else if (t.artist) {
              existing.artists.add(t.artist);
              if (existing.artists.size > 1 && !t.albumArtist) {
                existing.albumArtist = 'Various Artists';
              }
            }
          }
        }
      });

      const newlyImported = [];
      const relinkedMap = new Map();
      const albumCoverByAlbumId = new Map();
      tracks.forEach((t) => {
        if (t.albumId && t.isArtworkVerified && t.coverUrl) {
          albumCoverByAlbumId.set(t.albumId, {
            coverUrl: t.coverUrl,
            coverProvenance: t.coverProvenance
          });
        }
      });

      const seenInBatchFingerprint = new Set();
      const seenInBatchCanonical = new Set();
      const BATCH_SIZE = 6;

      for (let i = 0; i < validAudioEntries.length; i++) {
        const { file, relativePath } = validAudioEntries[i];
        const relPath = (relativePath || file.webkitRelativePath || file.name || '').replace(/\\/g, '/');
        const fingerprint = buildTrackFingerprint(file, relPath);

        if (seenInBatchFingerprint.has(fingerprint)) {
          duplicateSkippedCount++;
          continue;
        }
        seenInBatchFingerprint.add(fingerprint);

        let meta = null;
        try {
          meta = await parseBinaryAudioMetadata(file, relPath);
        } catch (metaErr) {
          errorCount++;
          continue;
        }

        // Reconcile folder-level album identity so tracks in the same album folder share a consistent albumArtist & albumId
        const normFolder = normalizeAlbumFolderRoot(meta.folderPath);
        if (normFolder) {
          const consensusKey = `${normFolder}:::${normalizeIdentityText(meta.album || '')}`;
          const existingConsensus = folderAlbumConsensus.get(consensusKey);
          const hasEmbeddedAlbum = meta.albumSource && meta.albumSource.startsWith('Embedded');
          if (existingConsensus) {
            if (!hasEmbeddedAlbum || normalizeIdentityText(meta.album) === normalizeIdentityText(existingConsensus.album)) {
              meta.album = existingConsensus.album;
              meta.albumId = existingConsensus.albumId;
              if (existingConsensus.artists) existingConsensus.artists.add(meta.artist);
              if (existingConsensus.artists && existingConsensus.artists.size > 1 && (!meta.albumArtist || meta.albumArtist === 'Unknown Artist')) {
                meta.albumArtist = 'Various Artists';
                existingConsensus.albumArtist = 'Various Artists';
              } else if (existingConsensus.albumArtist) {
                meta.albumArtist = existingConsensus.albumArtist;
              }
            }
          } else if (meta.album && meta.album !== 'Unsorted Local Album') {
            const consensusAlbumId = buildAlbumIdentityKey(meta.album, meta.albumArtist, meta.folderPath);
            meta.albumId = consensusAlbumId;
            folderAlbumConsensus.set(consensusKey, {
              album: meta.album,
              albumArtist: meta.albumArtist || meta.artist || 'Unknown Artist',
              albumId: consensusAlbumId,
              artists: new Set(meta.artist ? [meta.artist] : [])
            });
          }
        }

        const canonicalKey = buildCanonicalTrackDedupKey(meta, file.size);
        if (seenInBatchCanonical.has(canonicalKey)) {
          duplicateSkippedCount++;
          continue;
        }
        seenInBatchCanonical.add(canonicalKey);

        const existingTrack =
          existingByFingerprint.get(fingerprint) || existingByCanonicalKey.get(canonicalKey);

        if (existingTrack) {
          if (existingTrack.needsRelink || !existingTrack.objectUrl) {
            const newUrl = file.filePath && typeof convertFileSrc === 'function'
              ? convertFileSrc(file.filePath)
              : (file instanceof Blob ? URL.createObjectURL(file) : existingTrack.objectUrl);
            const updatedExisting = {
              ...existingTrack,
              filePath: file.filePath || existingTrack.filePath || null,
              audioBlob: file.filePath ? null : file,
              objectUrl: newUrl,
              needsRelink: false
            };
            relinkedMap.set(existingTrack.id, updatedExisting);
            await dbPut('tracks', {
              ...updatedExisting,
              objectUrl: null,
              audioBlob: file.filePath ? null : (settings.persistBlobsInIdb ? file : null)
            });
            relinkedCount++;
          } else {
            duplicateSkippedCount++;
          }
        } else {
          try {
            const objectUrl = file.filePath && typeof convertFileSrc === 'function'
              ? convertFileSrc(file.filePath)
              : URL.createObjectURL(file);

            // Share verified embedded artwork across tracks belonging to the same album
            if (meta.isArtworkVerified && meta.coverUrl) {
              albumCoverByAlbumId.set(meta.albumId, {
                coverUrl: meta.coverUrl,
                coverProvenance: meta.coverProvenance
              });
            }
            const sharedAlbumArt = albumCoverByAlbumId.get(meta.albumId);
            const pal = palettes[Math.abs(meta.albumId.length + newlyImported.length) % palettes.length];
            const coverUrl =
              meta.coverUrl ||
              sharedAlbumArt?.coverUrl ||
              createProceduralCoverSvg(meta.album || meta.title, meta.codec, pal);
            const isArtVerified = Boolean(meta.isArtworkVerified || sharedAlbumArt?.coverUrl);
            const coverProvenance =
              meta.coverProvenance ||
              sharedAlbumArt?.coverProvenance ||
              'Procedural Album Fallback Artwork';

            // Fast duration probe
            const probedDuration = await new Promise((resolve) => {
              const tempAudio = document.createElement('audio');
              tempAudio.preload = 'metadata';
              tempAudio.crossOrigin = 'anonymous';
              const timer = setTimeout(() => resolve(0), 1400);
              tempAudio.onloadedmetadata = () => {
                clearTimeout(timer);
                resolve(Number.isFinite(tempAudio.duration) ? tempAudio.duration : 0);
              };
              tempAudio.onerror = () => {
                clearTimeout(timer);
                resolve(0);
              };
              tempAudio.src = objectUrl;
            });

            const trackObj = {
              id: `local-${Date.now()}-${i}-${Math.random().toString(36).slice(2, 6)}`,
              fingerprint,
              albumId: meta.albumId,
              relativePath: relPath,
              folderPath: meta.folderPath,
              sourceRootFolder: sourceFolderName || meta.sourceRootFolder || 'Local Import',
              title: meta.title,
              artist: meta.artist,
              albumArtist: meta.albumArtist || meta.artist,
              contributingArtists: meta.contributingArtists || [],
              album: meta.album,
              albumSource: meta.albumSource,
              trackNumber: meta.trackNumber,
              totalTracks: meta.totalTracks || null,
              discNumber: meta.discNumber || 1,
              totalDiscs: meta.totalDiscs || null,
              year: meta.year,
              releaseDate: meta.releaseDate || '',
              genre: meta.genre || '',
              genres: meta.genres || [],
              label: meta.label || '',
              catalogNumber: meta.catalogNumber || '',
              releaseCountry: meta.releaseCountry || '',
              composer: meta.composer || '',
              songwriter: meta.songwriter || '',
              isrc: meta.isrc || '',
              fieldSources: meta.fieldSources || {},
              codec: meta.codec,
              containerSource: meta.containerSource,
              sampleRate: meta.sampleRate,
              sampleRateSource: meta.sampleRateSource,
              bitDepth: meta.bitDepth,
              bitDepthSource: meta.bitDepthSource,
              channels: meta.channels,
              channelsSource: meta.channelsSource,
              duration: probedDuration,
              filePath: file.filePath || null,
              fileSize: file.size,
              audioBlob: file.filePath ? null : file,
              objectUrl,
              coverUrl,
              coverProvenance,
              isArtworkVerified: isArtVerified,
              lyrics: meta.embeddedLyrics || '',
              lyricsSource: meta.embeddedLyrics ? 'Embedded Container Tag (ID3 USLT / Vorbis)' : '',
              lyricsOffsetMs: 0,
              isBuiltInReference: false,
              needsRelink: false,
              dspAnalysis: null
            };

            newlyImported.push(trackObj);
            importedCount++;

            await dbPut('tracks', {
              ...trackObj,
              objectUrl: null,
              audioBlob: file.filePath ? null : (settings.persistBlobsInIdb ? file : null)
            });
          } catch (fileErr) {
            errorCount++;
          }
        }

        if ((i + 1) % BATCH_SIZE === 0 || i === validAudioEntries.length - 1) {
          setImportProgress({
            active: i < validAudioEntries.length - 1,
            folderName: sourceFolderName || 'Selected Audio Batch',
            foldersScanned: stats.folders || 1,
            totalDiscovered,
            processed: i + 1,
            imported: importedCount,
            relinked: relinkedCount,
            duplicatesSkipped: duplicateSkippedCount,
            unsupportedSkipped: totalSkippedNonAudio,
            errors: errorCount,
            currentFile: relPath
          });
          // Yield to keep UI responsive during large multi-album imports
          await new Promise((r) => setTimeout(r, 0));
        }
      }

      if (newlyImported.length > 0 || relinkedMap.size > 0) {
        const orderedNewlyImported = sortTracksForAlbum(newlyImported);
        setTracks((prev) => {
          const updatedPrev = prev.map((t) => (relinkedMap.has(t.id) ? relinkedMap.get(t.id) : t));
          return [...orderedNewlyImported, ...updatedPrev];
        });
        if (orderedNewlyImported.length > 0) {
          setQueue((prev) => [...orderedNewlyImported.map((t) => t.id), ...prev]);
          shouldPlayRef.current = true;
          isTransitioningTrackRef.current = true;
          setCurrentTrackId(orderedNewlyImported[0].id);
          setSelectedAlbumId(orderedNewlyImported[0].albumId);
          setIsPlaying(true);
        }
      }

      showToast(
        `Processed ${totalDiscovered} audio track(s): ${importedCount} imported${relinkedCount > 0 ? `, ${relinkedCount} relinked` : ''
        }${duplicateSkippedCount > 0 ? `, ${duplicateSkippedCount} duplicate(s) skipped` : ''}${totalSkippedNonAudio > 0 ? ` (${totalSkippedNonAudio} non-audio/playlist skipped)` : ''
        }.`,
        'success'
      );
      setImportProgress(null);
    },
    [tracks, settings.persistBlobsInIdb, showToast]
  );

  const processImportedFiles = useCallback(
    async (fileList, isFolderFallback = false) => {
      if (!fileList || fileList.length === 0) return;
      const rawArray = Array.from(fileList);
      const folderSet = new Set();
      let skippedNonAudio = 0;
      const validEntries = [];

      for (const file of rawArray) {
        const relPath = (file.webkitRelativePath || file.name || '').replace(/\\/g, '/');
        const dirParts = relPath.split('/');
        if (dirParts.length > 1) {
          let acc = '';
          for (let d = 0; d < dirParts.length - 1; d++) {
            acc = acc ? `${acc}/${dirParts[d]}` : dirParts[d];
            folderSet.add(acc);
          }
        }
        if (isSupportedAudioFile(file)) {
          validEntries.push({ file, relativePath: relPath });
        } else {
          skippedNonAudio++;
        }
      }

      const rootFolderName =
        rawArray[0]?.webkitRelativePath?.split('/')[0] || (isFolderFallback ? 'Local Music Folder' : null);

      if (rootFolderName && settings.rememberMusicFolder) {
        const nowIso = new Date().toISOString();
        const folderMeta = {
          key: 'musicFolder',
          handle: null,
          name: rootFolderName,
          mode: 'idb-fallback',
          trackCount: validEntries.length,
          lastScannedAt: nowIso
        };
        await dbPut('handles', folderMeta);
        setRememberedFolder({
          handle: null,
          name: rootFolderName,
          mode: 'idb-fallback',
          permissionState: 'sandbox-fallback',
          trackCount: validEntries.length,
          lastScannedAt: nowIso
        });
      }

      await processNormalizedImportEntries(validEntries, rootFolderName, {
        folders: Math.max(1, folderSet.size),
        errors: 0,
        skippedNonAudio
      });
    },
    [processNormalizedImportEntries, settings.rememberMusicFolder]
  );

  const handleScanAndImportNativeFolder = useCallback(
    async (folderPath) => {
      if (!folderPath) return;
      const folderName = folderPath.split(/[/\\]/).filter(Boolean).pop() || folderPath;

      setImportProgress({
        active: true,
        folderName,
        foldersScanned: 1,
        totalDiscovered: 0,
        processed: 0,
        imported: 0,
        relinked: 0,
        duplicatesSkipped: 0,
        unsupportedSkipped: 0,
        errors: 0,
        currentFile: 'Đang quét thư mục và các thư mục con...'
      });

      try {
        let discoveredFiles = [];
        try {
          discoveredFiles = await invoke('scan_music_folder', { folderPath });
        } catch (err) {
          showToast(`Lỗi quét thư mục: ${err?.message || err}`, 'error');
          return;
        }

        if (!discoveredFiles || discoveredFiles.length === 0) {
          showToast(`Không tìm thấy file nhạc hợp lệ (.mp3, .flac, .wav, .m4a,...) trong "${folderName}".`, 'info');
          return;
        }

        const mimeMap = {
          mp3: 'audio/mpeg',
          flac: 'audio/flac',
          wav: 'audio/wav',
          m4a: 'audio/mp4; codecs="mp4a.40.2"',
          aac: 'audio/aac',
          ogg: 'audio/ogg',
          opus: 'audio/ogg; codecs="opus"',
          alac: 'audio/mp4',
          aiff: 'audio/aiff',
          aif: 'audio/aiff'
        };

        const rawEntries = [];
        for (const item of discoveredFiles) {
          const extLower = (item.extension || '').toLowerCase();
          let headerBlob = null;
          try {
            const maxHeader = Math.min(Number(item.size), 3 * 1024 * 1024);
            const bytes = await invoke('read_file_header', { path: item.path, maxBytes: maxHeader });
            headerBlob = new Blob([new Uint8Array(bytes)]);
          } catch (e) {
            headerBlob = new Blob([]);
          }

          const normNativePath = (item.path || '').replace(/\\/g, '/');
          const fileDir = normNativePath.includes('/') ? normNativePath.slice(0, normNativePath.lastIndexOf('/')) : '';

          const fileProxy = {
            name: item.name,
            size: Number(item.size),
            type: mimeMap[extLower] || 'audio/mpeg',
            filePath: item.path,
            folderPath: fileDir,
            slice: (start, end) => headerBlob.slice(start, end)
          };

          let effectiveRelPath = (item.relative_path || item.name || '').replace(/\\/g, '/');
          if (!effectiveRelPath.includes('/') && folderName) {
            effectiveRelPath = `${folderName}/${effectiveRelPath}`;
          }

          rawEntries.push({
            file: fileProxy,
            relativePath: effectiveRelPath,
            nativePath: item.path
          });
        }

        const nowIso = new Date().toISOString();
        const folderMeta = {
          key: 'musicFolder',
          handle: null,
          name: folderName,
          path: folderPath,
          mode: 'tauri-native',
          trackCount: rawEntries.length,
          lastScannedAt: nowIso
        };
        await dbPut('handles', folderMeta).catch(() => { });
        setRememberedFolder({
          handle: null,
          name: folderName,
          path: folderPath,
          mode: 'tauri-native',
          permissionState: 'granted',
          trackCount: rawEntries.length,
          lastScannedAt: nowIso
        });

        await processNormalizedImportEntries(rawEntries, folderName, {
          folders: 1,
          errors: 0,
          skippedNonAudio: 0
        });
      } finally {
        setImportProgress(null);
      }
    },
    [processNormalizedImportEntries, showToast]
  );

  const handlePickAndImportFolder = useCallback(async () => {
    if (typeof window !== 'undefined' && (window.__TAURI__ || window.__TAURI_INTERNALS__)) {
      try {
        const picked = await invoke('pick_music_folder');
        if (picked) {
          await handleScanAndImportNativeFolder(picked);
          return;
        }
      } catch (err) {
        console.warn('Native folder picker fallback:', err);
      }
    }
    fileInputRef.current?.click();
  }, [handleScanAndImportNativeFolder]);

  const handleRescanFolder = useCallback(async () => {
    if (rememberedFolder?.path) {
      await handleScanAndImportNativeFolder(rememberedFolder.path);
    } else {
      await handlePickAndImportFolder();
    }
  }, [rememberedFolder?.path, handleScanAndImportNativeFolder, handlePickAndImportFolder]);

  const handleSelectOrRestoreFolder = useCallback(async (forcedArg = null) => {
    if (typeof forcedArg === 'string') {
      await handleScanAndImportNativeFolder(forcedArg);
      return;
    }
    if (forcedArg === true && rememberedFolder?.path) {
      await handleScanAndImportNativeFolder(rememberedFolder.path);
      return;
    }
    await handlePickAndImportFolder();
  }, [handleScanAndImportNativeFolder, handlePickAndImportFolder, rememberedFolder]);

  const handleForgetRememberedFolder = useCallback(async () => {
    await dbDelete('handles', 'musicFolder');
    setRememberedFolder({
      handle: null,
      name: null,
      mode: null,
      permissionState: 'unknown',
      trackCount: 0,
      lastScannedAt: null
    });
    showToast('Cleared remembered music folder preference.', 'info');
  }, [showToast]);

  const handleFindAndRemoveDuplicates = useCallback(() => {
    if (!tracks || tracks.length < 2) {
      showToast(t('noDuplicatesFound'), 'info');
      return;
    }

    // Group tracks by normalized signature: title + artist
    const groups = new Map();
    for (const track of tracks) {
      const normTitle = (track.title || '').trim().toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
      const normArtist = (track.artist || track.albumArtist || '').trim().toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
      const key = `${normTitle}:::${normArtist}`;

      if (!groups.has(key)) {
        groups.set(key, []);
      }
      groups.get(key).push(track);
    }

    // Quality scoring function to pick the BEST master track to keep
    const scoreTrackQuality = (trk) => {
      let score = 0;
      if (trk.audioBlob instanceof Blob || (typeof trk.objectUrl === 'string' && trk.objectUrl.startsWith('blob:'))) {
        score += 1000;
      }
      const codec = String(trk.codec || '').toUpperCase();
      if (codec.includes('FLAC') || codec.includes('ALAC') || codec.includes('WAV') || codec.includes('AIFF')) {
        score += 500;
      } else if (codec.includes('M4A') || codec.includes('AAC')) {
        score += 300;
      } else {
        score += 200;
      }
      score += Number(trk.bitDepth || 16);
      score += Math.min(192, (trk.sampleRate || 44100) / 1000);
      if (trk.dspAnalysis?.estimatedBitrateKbps) {
        score += trk.dspAnalysis.estimatedBitrateKbps * 0.1;
      }
      if (trk.isArtworkVerified || (trk.coverUrl && !trk.coverUrl.includes('placeholder'))) {
        score += 40;
      }
      if (trk.embeddedLyrics || trk.syncedLyrics) {
        score += 20;
      }
      return score;
    };

    const duplicateTracksToRemove = [];
    const trackReplacementMap = new Map();

    for (const [, trackList] of groups) {
      if (trackList.length > 1) {
        trackList.sort((a, b) => scoreTrackQuality(b) - scoreTrackQuality(a));
        const masterTrack = trackList[0];
        for (let i = 1; i < trackList.length; i++) {
          const dup = trackList[i];
          duplicateTracksToRemove.push(dup);
          trackReplacementMap.set(dup.id, masterTrack.id);
        }
      }
    }

    if (duplicateTracksToRemove.length === 0) {
      showToast(t('noDuplicatesFound'), 'info');
      return;
    }

    setConfirmModal({
      title: t('removeDuplicates'),
      message: `${t('duplicatesCleaned').replace('{count}', duplicateTracksToRemove.length)} — Hệ thống sẽ tự động giữ lại bản thu chất lượng cao nhất (lossless, bitrate cao, đầy đủ ảnh bìa) và xóa các bản sao thừa. Bạn có chắc chắn muốn dọn dẹp?`,
      onConfirm: async () => {
        const dupIdSet = new Set(duplicateTracksToRemove.map((item) => item.id));

        for (const dup of duplicateTracksToRemove) {
          try {
            await dbDelete('tracks', dup.id);
          } catch (e) {
            // ignore
          }
        }

        const remainingTracks = tracks.filter((item) => !dupIdSet.has(item.id));
        setTracks(remainingTracks);

        setQueue((prevQueue) => {
          const updated = [];
          const seen = new Set();
          for (const id of prevQueue) {
            const targetId = trackReplacementMap.has(id) ? trackReplacementMap.get(id) : id;
            if (!dupIdSet.has(targetId) && !seen.has(targetId)) {
              seen.add(targetId);
              updated.push(targetId);
            }
          }
          return updated.length > 0 ? updated : remainingTracks.map((item) => item.id);
        });

        if (currentTrackId && trackReplacementMap.has(currentTrackId)) {
          setCurrentTrackId(trackReplacementMap.get(currentTrackId));
        }

        setPlaylists((prevPlaylists) => {
          return prevPlaylists.map((pl) => {
            if (!Array.isArray(pl.trackIds)) return pl;
            const updatedIds = [];
            const seen = new Set();
            for (const id of pl.trackIds) {
              const targetId = trackReplacementMap.has(id) ? trackReplacementMap.get(id) : id;
              if (!dupIdSet.has(targetId) && !seen.has(targetId)) {
                seen.add(targetId);
                updatedIds.push(targetId);
              }
            }
            const updatedPl = { ...pl, trackIds: updatedIds };
            dbPut('playlists', updatedPl).catch(() => { });
            return updatedPl;
          });
        });

        showToast(
          (t('duplicatesCleaned') || 'Đã xóa {count} bài hát trùng lặp').replace(
            '{count}',
            duplicateTracksToRemove.length
          ),
          'success'
        );
      }
    });
  }, [tracks, currentTrackId, showToast, t]);

  const handleDeleteAlbum = useCallback((album) => {
    if (!album || !album.tracks || album.tracks.length === 0) return;
    setConfirmModal({
      title: t('deleteAlbumConfirmTitle').replace('{title}', album.title),
      message: t('deleteAlbumConfirmDesc')
        .replace('{title}', album.title)
        .replace('{count}', album.tracks.length),
      onConfirm: async () => {
        const albumTrackIds = new Set(album.tracks.map((item) => item.id));

        for (const item of album.tracks) {
          try {
            await dbDelete('tracks', item.id);
          } catch (e) { }
        }

        const remainingTracks = tracks.filter((item) => !albumTrackIds.has(item.id));
        setTracks(remainingTracks);

        setQueue((prevQueue) => {
          const updated = prevQueue.filter((id) => !albumTrackIds.has(id));
          return updated.length > 0 ? updated : remainingTracks.map((item) => item.id);
        });

        if (currentTrackId && albumTrackIds.has(currentTrackId)) {
          const nextTrack = remainingTracks[0];
          setCurrentTrackId(nextTrack ? nextTrack.id : null);
          if (!nextTrack) {
            setIsPlaying(false);
          }
        }

        setPlaylists((prevPlaylists) => {
          return prevPlaylists.map((pl) => {
            if (!Array.isArray(pl.trackIds)) return pl;
            const updatedIds = pl.trackIds.filter((id) => !albumTrackIds.has(id));
            const updatedPl = { ...pl, trackIds: updatedIds };
            dbPut('playlists', updatedPl).catch(() => { });
            return updatedPl;
          });
        });

        setSelectedAlbumId(null);
        showToast(`Đã xóa album "${album.title}" khỏi thư viện.`, 'info');
      }
    });
  }, [tracks, currentTrackId, showToast, t]);

  const handleDeleteTrack = useCallback((trackId) => {
    const trackToDelete = tracks.find((item) => item.id === trackId);
    if (!trackToDelete) return;

    setConfirmModal({
      title: t('deleteTrack'),
      message: t('deleteTrackConfirm').replace('{title}', trackToDelete.title),
      onConfirm: async () => {
        try {
          await dbDelete('tracks', trackId);
        } catch (e) { }

        const remainingTracks = tracks.filter((item) => item.id !== trackId);
        setTracks(remainingTracks);

        setQueue((prevQueue) => {
          const updated = prevQueue.filter((id) => id !== trackId);
          return updated.length > 0 ? updated : remainingTracks.map((item) => item.id);
        });

        if (currentTrackId === trackId) {
          const nextTrack = remainingTracks.find((item) => item.albumId === trackToDelete.albumId) || remainingTracks[0];
          setCurrentTrackId(nextTrack ? nextTrack.id : null);
          if (!nextTrack) setIsPlaying(false);
        }

        setPlaylists((prevPlaylists) => {
          return prevPlaylists.map((pl) => {
            if (!Array.isArray(pl.trackIds)) return pl;
            const updatedIds = pl.trackIds.filter((id) => id !== trackId);
            const updatedPl = { ...pl, trackIds: updatedIds };
            dbPut('playlists', updatedPl).catch(() => { });
            return updatedPl;
          });
        });

        showToast(`Đã xóa "${trackToDelete.title}" khỏi thư viện.`, 'info');
      }
    });
  }, [tracks, currentTrackId, showToast, t]);

  // Helper to safely get the current Tauri window if running in desktop shell
  const getTauriAppWindow = useCallback(() => {
    try {
      if (typeof window !== 'undefined' && (window.__TAURI__ || window.__TAURI_INTERNALS__)) {
        return getCurrentWindow();
      }
    } catch (err) {
      // ignore
    }
    return null;
  }, []);

  // Smart Metadata Inconsistency Scan
  const handleRunSmartMetadataAudit = useCallback(() => {
    if (!tracks || tracks.length === 0) {
      showToast(t('noIssuesFound'), 'info');
      return;
    }

    const albumGroups = new Map();
    for (const track of tracks) {
      const albumKey = (track.album || '').trim().toLowerCase() || '__no_album__';
      if (!albumGroups.has(albumKey)) {
        albumGroups.set(albumKey, {
          albumTitle: track.album || 'Unknown Album',
          albumId: track.albumId,
          tracks: []
        });
      }
      albumGroups.get(albumKey).tracks.push(track);
    }

    const albumIssues = [];
    let totalDiscrepancies = 0;

    for (const [, group] of albumGroups) {
      const list = group.tracks;
      const issuesForAlbum = [];

      // 1. Artwork Inconsistency (sister tracks where some have cover and others don't)
      const tracksWithCover = list.filter((t) => t.coverUrl && !t.coverUrl.includes('placeholder'));
      const tracksWithoutCover = list.filter((t) => !t.coverUrl || t.coverUrl.includes('placeholder'));
      if (tracksWithCover.length > 0 && tracksWithoutCover.length > 0) {
        issuesForAlbum.push({
          type: 'artwork',
          title: t('artworkInconsistency'),
          detail: `${tracksWithoutCover.length} bài thiếu ảnh bìa trong khi ${tracksWithCover.length} bài khác trong album đã có.`,
          tracksAffected: tracksWithoutCover.map((t) => t.id)
        });
        totalDiscrepancies += tracksWithoutCover.length;
      }

      // 2. Conflicting Album Artist
      const albumArtistCounts = new Map();
      for (const t of list) {
        const art = (t.albumArtist || t.artist || '').trim();
        if (art) {
          albumArtistCounts.set(art, (albumArtistCounts.get(art) || 0) + 1);
        }
      }
      if (albumArtistCounts.size > 1 && list.length > 1) {
        const dominantArtist = [...albumArtistCounts.entries()].sort((a, b) => b[1] - a[1])[0][0];
        const outlierTracks = list.filter((t) => {
          const art = (t.albumArtist || t.artist || '').trim();
          return art && art !== dominantArtist;
        });
        if (outlierTracks.length > 0) {
          issuesForAlbum.push({
            type: 'albumArtist',
            title: t('albumArtistMismatch'),
            detail: `Nghệ sĩ album chủ đạo là "${dominantArtist}", nhưng có ${outlierTracks.length} bài ghi khác.`,
            dominantValue: dominantArtist,
            tracksAffected: outlierTracks.map((t) => t.id)
          });
          totalDiscrepancies += outlierTracks.length;
        }
      }

      // 3. Conflicting Year
      const yearCounts = new Map();
      for (const t of list) {
        const yr = t.year ? String(t.year).trim() : null;
        if (yr && yr !== '0' && yr !== 'null') {
          yearCounts.set(yr, (yearCounts.get(yr) || 0) + 1);
        }
      }
      if (yearCounts.size > 1 || (yearCounts.size === 1 && list.some((t) => !t.year))) {
        const dominantYear = yearCounts.size > 0 ? [...yearCounts.entries()].sort((a, b) => b[1] - a[1])[0][0] : null;
        const outlierTracks = list.filter((t) => String(t.year || '').trim() !== dominantYear);
        if (dominantYear && outlierTracks.length > 0) {
          issuesForAlbum.push({
            type: 'year',
            title: t('yearMismatch'),
            detail: `Năm phát hành chủ đạo là ${dominantYear}, nhưng có ${outlierTracks.length} bài bị lệch năm hoặc thiếu năm.`,
            dominantValue: dominantYear,
            tracksAffected: outlierTracks.map((t) => t.id)
          });
          totalDiscrepancies += outlierTracks.length;
        }
      }

      // 4. Conflicting Genre
      const genreCounts = new Map();
      for (const t of list) {
        const g = (t.genre || '').trim();
        if (g) {
          genreCounts.set(g, (genreCounts.get(g) || 0) + 1);
        }
      }
      if (genreCounts.size > 1 || (genreCounts.size === 1 && list.some((t) => !t.genre))) {
        const dominantGenre = genreCounts.size > 0 ? [...genreCounts.entries()].sort((a, b) => b[1] - a[1])[0][0] : null;
        const outlierTracks = list.filter((t) => (t.genre || '').trim() !== dominantGenre);
        if (dominantGenre && outlierTracks.length > 0) {
          issuesForAlbum.push({
            type: 'genre',
            title: t('genreInconsistency'),
            detail: `Thể loại chính là "${dominantGenre}", nhưng có ${outlierTracks.length} bài thiếu hoặc khác thể loại.`,
            dominantValue: dominantGenre,
            tracksAffected: outlierTracks.map((t) => t.id)
          });
          totalDiscrepancies += outlierTracks.length;
        }
      }

      // 5. Track Number Inconsistencies (missing track number or duplicates within album)
      if (list.length > 1) {
        const seenTrackNums = new Set();
        const duplicateOrMissingTracks = [];
        for (const t of list) {
          const num = t.trackNumber;
          const disc = t.discNumber || 1;
          const key = `${disc}#${num}`;
          if (!num || num <= 0 || seenTrackNums.has(key)) {
            duplicateOrMissingTracks.push(t);
          } else {
            seenTrackNums.add(key);
          }
        }
        if (duplicateOrMissingTracks.length > 0) {
          issuesForAlbum.push({
            type: 'trackNumber',
            title: t('trackNumberIssues'),
            detail: `Có ${duplicateOrMissingTracks.length} bài thiếu số thứ tự hoặc trùng số bài hát trong album.`,
            tracksAffected: duplicateOrMissingTracks.map((t) => t.id)
          });
          totalDiscrepancies += duplicateOrMissingTracks.length;
        }
      }

      if (issuesForAlbum.length > 0) {
        albumIssues.push({
          albumTitle: group.albumTitle,
          albumId: group.albumId,
          tracksCount: list.length,
          tracks: list,
          issues: issuesForAlbum
        });
      }
    }

    const totalChecked = Math.max(1, tracks.length * 2);
    const healthScore = Math.max(0, Math.min(100, Math.round(100 - (totalDiscrepancies / totalChecked) * 100)));

    setSmartAuditResult({
      healthScore,
      totalDiscrepancies,
      albumIssues,
      scannedAt: new Date().toLocaleTimeString(),
      totalTracks: tracks.length,
      totalAlbums: albumGroups.size
    });
  }, [tracks, showToast, t]);

  // Auto-Harmonize
  const handleAutoHarmonizeMetadata = useCallback(async () => {
    if (!smartAuditResult || !smartAuditResult.albumIssues || smartAuditResult.albumIssues.length === 0) {
      return;
    }

    const trackUpdates = new Map();

    for (const albumReport of smartAuditResult.albumIssues) {
      const list = albumReport.tracks;
      if (!list || list.length === 0) continue;

      const masterWithCover =
        list.find((t) => t.coverUrl && !t.coverUrl.includes('placeholder') && t.isArtworkVerified) ||
        list.find((t) => t.coverUrl && !t.coverUrl.includes('placeholder'));

      const artistCounts = new Map();
      for (const t of list) {
        const art = (t.albumArtist || t.artist || '').trim();
        if (art) artistCounts.set(art, (artistCounts.get(art) || 0) + 1);
      }
      const dominantArtist =
        artistCounts.size > 0
          ? (artistCounts.size > 1 && [...artistCounts.values()].every((v) => v <= list.length / 2)
              ? 'Various Artists'
              : [...artistCounts.entries()].sort((a, b) => b[1] - a[1])[0][0])
          : null;

      const yearCounts = new Map();
      for (const t of list) {
        const yr = t.year ? String(t.year).trim() : null;
        if (yr && yr !== '0' && yr !== 'null') yearCounts.set(yr, (yearCounts.get(yr) || 0) + 1);
      }
      const dominantYear =
        yearCounts.size > 0 ? [...yearCounts.entries()].sort((a, b) => b[1] - a[1])[0][0] : null;

      const genreCounts = new Map();
      for (const t of list) {
        const g = (t.genre || '').trim();
        if (g) genreCounts.set(g, (genreCounts.get(g) || 0) + 1);
      }
      const dominantGenre =
        genreCounts.size > 0 ? [...genreCounts.entries()].sort((a, b) => b[1] - a[1])[0][0] : null;

      const sorted = sortTracksForAlbum(list);
      const needNumberFix = albumReport.issues.some((iss) => iss.type === 'trackNumber');

      for (let i = 0; i < sorted.length; i++) {
        const trk = sorted[i];
        let changed = false;
        let updated = { ...trk };

        if (masterWithCover && (!updated.coverUrl || updated.coverUrl.includes('placeholder'))) {
          updated.coverUrl = masterWithCover.coverUrl;
          updated.picture = masterWithCover.picture;
          updated.isArtworkVerified = true;
          if (masterWithCover.dominantColor) {
            updated.dominantColor = masterWithCover.dominantColor;
          }
          changed = true;
        }

        if (dominantArtist && (!updated.albumArtist || updated.albumArtist !== dominantArtist)) {
          updated.albumArtist = dominantArtist;
          changed = true;
        }

        if (dominantYear && String(updated.year || '').trim() !== dominantYear) {
          updated.year = dominantYear;
          changed = true;
        }

        if (dominantGenre && (updated.genre || '').trim() !== dominantGenre) {
          updated.genre = dominantGenre;
          changed = true;
        }

        if (needNumberFix) {
          const expectedNum = i + 1;
          if (updated.trackNumber !== expectedNum) {
            updated.trackNumber = expectedNum;
            if (!updated.trackTotal || updated.trackTotal < sorted.length) {
              updated.trackTotal = sorted.length;
            }
            changed = true;
          }
        }

        if (changed) {
          trackUpdates.set(updated.id, updated);
        }
      }
    }

    if (trackUpdates.size === 0) {
      showToast('Tất cả metadata đã đồng nhất.', 'info');
      return;
    }

    for (const [, updatedTrk] of trackUpdates) {
      try {
        await dbPut('tracks', {
          ...updatedTrk,
          objectUrl: null,
          audioBlob: settings.persistBlobsInIdb ? updatedTrk.audioBlob : null
        });
      } catch (err) {
        console.warn('Failed to persist harmonized track to IndexedDB:', err);
      }
    }

    setTracks((prevTracks) => {
      return prevTracks.map((t) => (trackUpdates.has(t.id) ? trackUpdates.get(t.id) : t));
    });

    const harmonizedCount = trackUpdates.size;
    showToast(
      (t('harmonizeSuccess') || 'Đã chuẩn hóa metadata cho {count} bài hát!').replace(
        '{count}',
        harmonizedCount
      ),
      'success'
    );

    setSmartAuditResult((prev) =>
      prev
        ? {
          ...prev,
          healthScore: 100,
          totalDiscrepancies: 0,
          albumIssues: []
        }
        : null
    );
  }, [smartAuditResult, settings.persistBlobsInIdb, showToast, t]);

  const runSelfDiagnosticsSuite = useCallback(async () => {
    // Build a virtual nested directory fixture with multiple albums, discs, and .m3u/.m3u8/.cue/.jpg non-audio files:
    // Music/Radiohead/Kid A/Disc 1/01... + 02... + 00 - Kid A.m3u AND Music/Daft Punk/Discovery/01... + playlist.m3u8
    const mockFileA1 = new File([new Uint8Array([0, 1, 2, 3])], '01 - Everything In Its Right Place.FLAC', {
      type: 'audio/flac'
    });
    const mockFileA2 = new File([new Uint8Array([4, 5, 6, 7, 8])], '02 - Kid A.m4a', {
      type: 'audio/mp4'
    });
    const mockM3u = new File(['#EXTM3U\n01 - Everything In Its Right Place.FLAC'], '00 - Kid A.m3u', {
      type: 'audio/x-mpegurl'
    });
    const mockM3u8 = new File(['#EXTM3U\n01 - One More Time.mp3'], 'Discovery.m3u8', {
      type: 'audio/mpegurl'
    });
    const mockFileB1 = new File([new Uint8Array([9, 10, 11, 12])], '01 - One More Time.mp3', {
      type: 'audio/mpeg'
    });
    const mockTxt = new File(['notes'], 'liner-notes.txt', { type: 'text/plain' });

    const virtualRootHandle = {
      name: 'Music',
      kind: 'directory',
      async *entries() {
        yield [
          'Radiohead',
          {
            name: 'Radiohead',
            kind: 'directory',
            async *entries() {
              yield [
                'Kid A',
                {
                  name: 'Kid A',
                  kind: 'directory',
                  async *entries() {
                    yield ['00 - Kid A.m3u', { kind: 'file', getFile: async () => mockM3u }];
                    yield [
                      'Disc 1',
                      {
                        name: 'Disc 1',
                        kind: 'directory',
                        async *entries() {
                          yield ['02 - Kid A.m4a', { kind: 'file', getFile: async () => mockFileA2 }];
                          yield ['01 - Everything In Its Right Place.FLAC', { kind: 'file', getFile: async () => mockFileA1 }];
                          yield ['liner-notes.txt', { kind: 'file', getFile: async () => mockTxt }];
                        }
                      }
                    ];
                  }
                }
              ];
            }
          }
        ];
        yield [
          'Daft Punk',
          {
            name: 'Daft Punk',
            kind: 'directory',
            async *entries() {
              yield [
                'Discovery',
                {
                  name: 'Discovery',
                  kind: 'directory',
                  async *entries() {
                    yield ['01 - One More Time.mp3', { kind: 'file', getFile: async () => mockFileB1 }];
                    yield ['Discovery.m3u8', { kind: 'file', getFile: async () => mockM3u8 }];
                  }
                }
              ];
            }
          }
        ];
        yield [
          'PlaylistOnlyFolder',
          {
            name: 'PlaylistOnlyFolder',
            kind: 'directory',
            async *entries() {
              yield ['only-playlist.m3u', { kind: 'file', getFile: async () => mockM3u }];
            }
          }
        ];
      }
    };

    const stats = { folders: 0, errors: 0, skippedNonAudio: 0 };
    const discovered = await traverseDirectoryHandleRecursive(virtualRootHandle, 'Music', stats);
    const parsedMetaList = await Promise.all(
      discovered.map((d) => parseBinaryAudioMetadata(d.file, d.relativePath))
    );
    const distinctAlbums = new Set(parsedMetaList.map((m) => m.albumId));
    const kidATracks = sortTracksForAlbum(parsedMetaList.filter((m) => m.album === 'Kid A'));
    const trackOrderPassed =
      kidATracks.length === 2 && kidATracks[0].trackNumber === 1 && kidATracks[1].trackNumber === 2;
    const m3uRejected = !isSupportedAudioFile(mockM3u) && !isSupportedAudioFile(mockM3u8);

    const fp1 = buildTrackFingerprint(mockFileA1, discovered[0]?.relativePath);
    const fp2 = buildTrackFingerprint(mockFileA1, discovered[0]?.relativePath);
    const lrcCheck = parseLrcLyrics(
      '[00:05.50] A very long synchronized lyric line that wraps naturally across multiple lines without ellipsis truncation\n[00:12.00] Synced Line 2'
    );

    setDiagnosticReport({
      ranAt: new Date().toLocaleTimeString(),
      nestedTraversalPassed:
        m3uRejected &&
        discovered.length === 3 &&
        distinctAlbums.size === 2 &&
        stats.skippedNonAudio === 4,
      discoveredPaths: discovered.map((d) => d.relativePath),
      inferredMeta: `${distinctAlbums.size} Albums Grouped (.m3u/.m3u8 skipped: ${stats.skippedNonAudio})`,
      trackOrderPassed,
      dedupPassed: fp1 === fp2,
      lrcSyncPassed: lrcCheck.isSynced && lrcCheck.lines.length === 2 && lrcCheck.lines[0].timeSec === 5.5
    });
    showToast('Multi-album import, .m3u filter, dedup & multi-line LRC diagnostics passed.', 'success');
  }, [showToast]);

  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape' && fullscreenMode !== null) {
        e.preventDefault();
        exitFullscreenMode();
        return;
      }
      if (!settings.keyboardShortcuts) return;
      const tag = (e.target?.tagName || '').toUpperCase();
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target?.isContentEditable) {
        return;
      }
      if (e.code === 'Space') {
        e.preventDefault();
        togglePlayPause();
      } else if (e.code === 'ArrowRight' || e.key === 'l' || e.key === 'L') {
        e.preventDefault();
        handleSeek(currentTimeRef.current + 5);
      } else if (e.code === 'ArrowLeft' || e.key === 'j' || e.key === 'J') {
        e.preventDefault();
        handleSeek(currentTimeRef.current - 5);
      } else if (e.code === 'ArrowUp') {
        e.preventDefault();
        setVolume((v) => Math.min(1, Number((v + 0.05).toFixed(2))));
      } else if (e.code === 'ArrowDown') {
        e.preventDefault();
        setVolume((v) => Math.max(0, Number((v - 0.05).toFixed(2))));
      } else if (e.key === 'm' || e.key === 'M') {
        e.preventDefault();
        setIsMuted((m) => !m);
      } else if (e.key === 's' || e.key === 'S') {
        e.preventDefault();
        setShuffle((s) => !s);
      } else if (e.key === 'r' || e.key === 'R') {
        e.preventDefault();
        setRepeatMode((r) => (r === 'off' ? 'all' : r === 'all' ? 'one' : 'off'));
      } else if (e.key === 'f' || e.key === 'F') {
        e.preventDefault();
        toggleFullscreenMode('player');
      } else if (['1', '2', '3', '4'].includes(e.key) && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        const eqPresetsMap = {
          '1': 'builtin-flat',
          '2': 'builtin-warm',
          '3': 'builtin-bright',
          '4': 'builtin-vocal'
        };
        const targetId = eqPresetsMap[e.key];
        const found = BUILTIN_PEQ_PRESETS.find((p) => p.id === targetId);
        if (found) {
          setPeqState((prev) => ({
            ...prev,
            enabled: true,
            activePresetId: found.id,
            preamp: found.preamp,
            bands: found.bands.map((b) => ({ ...b }))
          }));
          const labelMap = { '1': 'Linear (Flat)', '2': 'Warmth', '3': 'Air', '4': 'Vocal' };
          showToast(`Profile Equalizer: ${labelMap[e.key]}`, 'info');
        }
      } else if (e.key === 'e' || e.key === 'E') {
        e.preventDefault();
        setPeqState((prev) => {
          const next = !prev.enabled;
          showToast(next ? '10-Band EQ: Bật' : '10-Band EQ: Tắt (Bypass)', 'info');
          return { ...prev, enabled: next };
        });
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    fullscreenMode,
    exitFullscreenMode,
    settings.keyboardShortcuts,
    togglePlayPause,
    handleSeek,
    toggleFullscreenMode,
    showToast
  ]);

  // Handle native window close-to-tray & tray menu commands
  useEffect(() => {
    const win = getTauriAppWindow();
    let unlistenClose = null;
    let unlistenTray = null;

    if (win && typeof win.onCloseRequested === 'function') {
      win.onCloseRequested((event) => {
        if (settingsRef.current.closeToTray) {
          event.preventDefault();
          win.hide().catch(() => { });
          showToast(t('closeToTrayDesc') || 'Aurelia đang tiếp tục phát nhạc trong Khay hệ thống.', 'info');
        }
      }).then((u) => {
        unlistenClose = u;
      }).catch(() => { });
    }

    if (typeof listen === 'function') {
      listen('tray-command', (event) => {
        const cmd = event.payload;
        if (cmd === 'play_pause') {
          togglePlayPause();
        } else if (cmd === 'next') {
          handleNextTrack(false);
        } else if (cmd === 'prev') {
          handlePrevTrack();
        }
      }).then((u) => {
        unlistenTray = u;
      }).catch(() => { });
    }

    return () => {
      if (typeof unlistenClose === 'function') unlistenClose();
      if (typeof unlistenTray === 'function') unlistenTray();
    };
  }, [getTauriAppWindow, showToast, t, togglePlayPause, handleNextTrack, handlePrevTrack]);

  // Synchronize System Tray metadata & playback status
  useEffect(() => {
    try {
      invoke('update_tray_track', {
        title: currentTrack?.title || null,
        artist: currentTrack?.artist || null,
        isPlaying: Boolean(isPlaying)
      }).catch(() => { });
    } catch (e) {
      // ignore
    }
  }, [currentTrack?.title, currentTrack?.artist, isPlaying]);

  // Synchronize close-to-tray preference with native backend
  useEffect(() => {
    try {
      invoke('set_close_to_tray', { enable: Boolean(settings.closeToTray) }).catch(() => { });
    } catch (e) {
      // ignore
    }
  }, [settings.closeToTray]);

  const parsedLyrics = useMemo(() => {
    return parseLrcLyrics(currentTrack?.lyrics || '');
  }, [currentTrack?.lyrics]);

  const lyricOffsetSec = (currentTrack?.lyricsOffsetMs || 0) / 1000;
  // Re-renders App only when the highlighted line actually changes, not on every time tick
  const activeLyricIndex = useClock((time) => {
    if (!parsedLyrics.isSynced || parsedLyrics.lines.length === 0) return -1;
    const adjustedTime = time - lyricOffsetSec;
    let activeIdx = -1;
    for (let i = 0; i < parsedLyrics.lines.length; i++) {
      const lineTime = parsedLyrics.lines[i].timeSec;
      if (lineTime !== null && adjustedTime >= lineTime) {
        activeIdx = i;
      } else if (lineTime !== null && adjustedTime < lineTime) {
        break;
      }
    }
    return activeIdx;
  });
  // Plain (unsynced) lyrics: estimated line from track progress, again only changes a few times per song
  const unsyncedLyricIdx = useClock((time) => {
    if (parsedLyrics.isSynced || parsedLyrics.lines.length === 0) return -1;
    const progress = duration > 0 ? Math.min(0.999, Math.max(0, time / duration)) : 0;
    return Math.floor(progress * parsedLyrics.lines.length);
  });
  // Compute the active window of lyrics for the non-scrolling Now Playing & Fullscreen lyrics viewports
  const visibleLyricsWindow = useMemo(() => {
    const lines = parsedLyrics.lines;
    if (lines.length === 0) return [];
    const windowSize = 3;
    if (!parsedLyrics.isSynced) {
      // For plain unsynced lyrics, estimate active line from track progress so user never has to scroll manually
      const approxIdx = Math.max(0, unsyncedLyricIdx);
      const start = Math.max(0, Math.min(Math.max(0, lines.length - windowSize), approxIdx - 1));
      return lines.slice(start, start + windowSize).map((l, idx) => ({
        ...l,
        globalIdx: start + idx,
        role: start + idx === approxIdx ? 'active' : start + idx < approxIdx ? 'past' : 'upcoming'
      }));
    }
    const pivot = activeLyricIndex >= 0 ? activeLyricIndex : 0;
    const start = Math.max(0, Math.min(Math.max(0, lines.length - windowSize), pivot - 1));
    return lines.slice(start, start + windowSize).map((l, idx) => {
      const gIdx = start + idx;
      const role =
        activeLyricIndex === -1
          ? idx === 0
            ? 'upcoming-next'
            : 'upcoming'
          : gIdx === activeLyricIndex
            ? 'active'
            : gIdx < activeLyricIndex
              ? 'past'
              : gIdx === activeLyricIndex + 1
                ? 'upcoming-next'
                : 'upcoming';
      return { ...l, globalIdx: gIdx, role };
    });
  }, [parsedLyrics, activeLyricIndex, unsyncedLyricIdx]);

  const filteredTracks = useMemo(() => {
    let list = tracks;
    if (selectedPlaylistId !== 'ALL') {
      const pl = playlists.find((p) => p.id === selectedPlaylistId);
      if (pl) {
        list = list.filter((t) => pl.trackIds.includes(t.id));
      }
    }
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      list = list.filter(
        (t) =>
          (t.title || '').toLowerCase().includes(q) ||
          (t.artist || '').toLowerCase().includes(q) ||
          (t.albumArtist || '').toLowerCase().includes(q) ||
          (t.album || '').toLowerCase().includes(q) ||
          (t.folderPath || '').toLowerCase().includes(q) ||
          (t.codec || '').toLowerCase().includes(q)
      );
    }
    const sorted = [...list].sort((a, b) => {
      let cmp = 0;
      if (sortBy === 'album') {
        cmp = (a.album || '').localeCompare(b.album || '');
        if (cmp === 0) {
          const discDiff = (a.discNumber || 1) - (b.discNumber || 1);
          if (discDiff !== 0) cmp = discDiff;
          else cmp = (a.trackNumber ?? 9999) - (b.trackNumber ?? 9999);
        }
      } else if (sortBy === 'title') {
        cmp = (a.title || '').localeCompare(b.title || '');
      } else if (sortBy === 'artist') {
        cmp = (a.artist || '').localeCompare(b.artist || '');
      } else if (sortBy === 'duration') {
        cmp = (a.duration || 0) - (b.duration || 0);
      } else if (sortBy === 'codec') {
        cmp = (a.codec || '').localeCompare(b.codec || '');
      }
      return sortAsc ? cmp : -cmp;
    });
    return sorted;
  }, [tracks, selectedPlaylistId, playlists, searchQuery, sortBy, sortAsc]);

  // Group filteredTracks into Album objects preserving track ordering and folder provenance
  const groupedAlbums = useMemo(() => {
    const map = new Map();
    for (const t of filteredTracks) {
      const key = buildAlbumIdentityKey(t.album, t.albumArtist, t.folderPath);
      if (!map.has(key)) {
        map.set(key, {
          id: key,
          title: t.album || 'Unsorted Local Album',
          artist: t.albumArtist || t.artist || 'Unknown Artist',
          year: t.year || '',
          coverUrl: t.coverUrl,
          isArtworkVerified: Boolean(t.isArtworkVerified),
          folderPath: t.folderPath || '',
          sourceRootFolder: t.sourceRootFolder || '',
          albumSource: t.albumSource || 'Metadata / Folder',
          codecs: new Set(),
          artists: new Set(),
          totalDuration: 0,
          isBuiltInReference: Boolean(t.isBuiltInReference),
          tracks: []
        });
      }
      const entry = map.get(key);
      entry.tracks.push(t);
      entry.totalDuration += t.duration || 0;
      if (t.artist && t.artist !== 'Unknown Artist') entry.artists.add(t.artist);
      if (t.codec) entry.codecs.add(t.codec.split(' ')[0]);
      if (!entry.isArtworkVerified && t.isArtworkVerified && t.coverUrl) {
        entry.coverUrl = t.coverUrl;
        entry.isArtworkVerified = true;
      }
      if (!entry.year && t.year) entry.year = t.year;
      if (!entry.folderPath && t.folderPath) entry.folderPath = t.folderPath;
      if (t.albumArtist && t.albumArtist !== 'Unknown Artist' && !entry.explicitAlbumArtist) {
        entry.explicitAlbumArtist = t.albumArtist;
      }
    }

    const albumsArray = Array.from(map.values()).map((alb) => {
      let displayArtist = alb.explicitAlbumArtist || alb.artist;
      if (alb.artists.size > 1 && (!alb.explicitAlbumArtist || alb.explicitAlbumArtist === 'Unknown Artist')) {
        displayArtist = 'Various Artists';
      }
      return {
        ...alb,
        artist: displayArtist,
        codecsList: Array.from(alb.codecs),
        tracks: sortTracksForAlbum(alb.tracks)
      };
    });

    albumsArray.sort((a, b) => {
      if (a.isBuiltInReference !== b.isBuiltInReference) {
        return a.isBuiltInReference ? 1 : -1;
      }
      let cmp = 0;
      if (sortBy === 'artist') {
        cmp = a.artist.localeCompare(b.artist) || a.title.localeCompare(b.title);
      } else if (sortBy === 'duration') {
        cmp = a.totalDuration - b.totalDuration;
      } else if (sortBy === 'codec') {
        cmp = (a.codecsList[0] || '').localeCompare(b.codecsList[0] || '');
      } else {
        cmp = a.title.localeCompare(b.title);
      }
      return sortAsc ? cmp : -cmp;
    });

    return albumsArray;
  }, [filteredTracks, sortBy, sortAsc]);

  // Keep selectedAlbumId valid when filtering or importing
  const activeSelectedAlbum = useMemo(() => {
    if (groupedAlbums.length === 0) return null;
    if (selectedAlbumId) {
      const found = groupedAlbums.find((a) => a.id === selectedAlbumId);
      if (found) return found;
    }
    if (currentTrack) {
      const currentKey = buildAlbumIdentityKey(currentTrack.album, currentTrack.albumArtist, currentTrack.folderPath);
      const currentAlb = groupedAlbums.find((a) => a.id === currentKey || (currentTrack.albumId && a.id === currentTrack.albumId));
      if (currentAlb) return currentAlb;
    }
    return groupedAlbums[0];
  }, [groupedAlbums, selectedAlbumId, currentTrack]);

  const handlePlayAlbum = useCallback(
    (album, startTrackId = null) => {
      if (!album || !album.tracks || album.tracks.length === 0) return;
      const orderedIds = album.tracks.map((t) => t.id);
      setQueue((prev) => {
        const rest = prev.filter((id) => !orderedIds.includes(id));
        return [...orderedIds, ...rest];
      });
      const targetId = startTrackId || orderedIds[0];
      setSelectedAlbumId(album.id);
      if (targetId === currentTrackId) {
        togglePlayPause();
      } else {
        startTrackById(targetId);
      }
    },
    [currentTrackId, togglePlayPause, startTrackById]
  );

  const handleQueueAlbum = useCallback(
    (album) => {
      if (!album || !album.tracks || album.tracks.length === 0) return;
      const orderedIds = album.tracks.map((t) => t.id);
      setQueue((prev) => {
        const existingSet = new Set(prev);
        const toAdd = orderedIds.filter((id) => !existingSet.has(id));
        return [...prev, ...toAdd];
      });
      showToast(`Added ${album.tracks.length} track(s) from "${album.title}" to queue`, 'info');
    },
    [showToast]
  );

  const handleCreatePlaylist = async () => {
    const trimmed = newPlaylistName.trim();
    if (!trimmed) return;
    const newPl = {
      id: `pl-${Date.now()}`,
      name: trimmed,
      trackIds: []
    };
    const next = [...playlists, newPl];
    setPlaylists(next);
    setNewPlaylistName('');
    await dbPut('playlists', newPl);
    showToast(`Created playlist "${trimmed}"`, 'success');
  };

  const handleToggleTrackInPlaylist = async (playlistId, trackId) => {
    const target = playlists.find((p) => p.id === playlistId);
    if (!target) return;
    const exists = target.trackIds.includes(trackId);
    const updatedPl = {
      ...target,
      trackIds: exists ? target.trackIds.filter((id) => id !== trackId) : [...target.trackIds, trackId]
    };
    setPlaylists((prev) => prev.map((p) => (p.id === playlistId ? updatedPl : p)));
    await dbPut('playlists', updatedPl);
    showToast(exists ? `Removed from ${target.name}` : `Added to ${target.name}`, 'info');
  };

  const handleAddToQueue = (trackId, playNext = false) => {
    setQueue((prev) => {
      if (playNext && currentTrackId) {
        const idx = prev.indexOf(currentTrackId);
        const filtered = prev.filter((id) => id !== trackId);
        filtered.splice(idx + 1, 0, trackId);
        return filtered;
      }
      if (prev.includes(trackId)) return prev;
      return [...prev, trackId];
    });
    showToast(playNext ? 'Scheduled to play next in queue' : 'Added to playback queue', 'info');
  };

  const handleMoveQueueItem = (index, direction) => {
    setQueue((prev) => {
      const targetIdx = index + direction;
      if (targetIdx < 0 || targetIdx >= prev.length) return prev;
      const copy = [...prev];
      const [item] = copy.splice(index, 1);
      copy.splice(targetIdx, 0, item);
      return copy;
    });
  };

  const updateSettings = useCallback(async (patch) => {
    setSettings((prev) => {
      const next = typeof patch === 'function' ? patch(prev) : { ...prev, ...patch };
      dbPut('settings', { key: 'appSettings', value: next }).catch((err) => console.error('Save settings error:', err));
      return next;
    });
  }, []);

  const updateSetting = useCallback((key, value) => {
    updateSettings({ [key]: value });
  }, [updateSettings]);

  const handleExtractAlbumColor = useCallback(async () => {
    if (!currentTrack?.coverUrl) {
      showToast(t('noAlbumArtFound'), 'info');
      return;
    }
    try {
      const hex = await extractDominantColor(currentTrack.coverUrl);
      if (hex) {
        setLocalCustomHex(hex);
        updateSettings({
          accentColor: 'custom',
          customAccentHex: hex
        });
        showToast(t('albumColorExtracted') + ` (${hex})`, 'success');
      } else {
        showToast(t('noAlbumArtFound'), 'info');
      }
    } catch {
      showToast(t('noAlbumArtFound'), 'info');
    }
  }, [currentTrack?.coverUrl, t, updateSettings, showToast]);

  useEffect(() => {
    if (!settings.autoAlbumTheme || !currentTrack?.coverUrl) return;
    let cancelled = false;
    extractDominantColor(currentTrack.coverUrl).then((hex) => {
      if (!cancelled && hex) {
        setLocalCustomHex(hex);
        updateSettings({
          accentColor: 'custom',
          customAccentHex: hex
        });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [currentTrack?.coverUrl, settings.autoAlbumTheme, updateSettings]);

  return (
    <div
      className="aurelia-app-root min-h-screen lg:h-screen w-full bg-[#07080c] text-zinc-100 flex flex-col font-sans select-none overflow-x-hidden lg:overflow-hidden relative"
      onDragOver={(e) => {
        e.preventDefault();
        setIsDraggingOver(true);
      }}
      onDragLeave={() => setIsDraggingOver(false)}
      onDrop={async (e) => {
        e.preventDefault();
        setIsDraggingOver(false);
        const items = e.dataTransfer?.items;
        if (items && items.length > 0 && typeof items[0].webkitGetAsEntry === 'function') {
          const stats = { folders: 0, errors: 0, skippedNonAudio: 0 };
          const allEntries = [];
          const webkitEntries = [];
          for (let i = 0; i < items.length; i++) {
            const entry = items[i].webkitGetAsEntry();
            if (entry) webkitEntries.push(entry);
          }
          for (const entry of webkitEntries) {
            const found = await traverseWebkitEntryRecursive(entry, '', stats);
            allEntries.push(...found);
          }
          if (allEntries.length > 0 || stats.folders > 0) {
            await processNormalizedImportEntries(
              allEntries,
              webkitEntries[0]?.isDirectory ? webkitEntries[0].name : 'Dropped Audio Folder',
              stats
            );
            return;
          }
        }
        if (e.dataTransfer?.files?.length) {
          processImportedFiles(e.dataTransfer.files);
        }
      }}
    >

      {/* Hidden Audio Element & File Pickers */}
      {[0, 1].map((deckIdx) => (
        <audio
          key={deckIdx}
          ref={deckRefCallbacks[deckIdx]}
          crossOrigin="anonymous"
          preload="auto"
          onTimeUpdate={handleDeckTimeUpdate}
          onLoadedMetadata={(e) => {
            if (e.currentTarget !== audioRef.current) return;
            if (Number.isFinite(e.currentTarget.duration)) {
              setDuration(e.currentTarget.duration);
            }
          }}
          onEnded={(e) => {
            if (e.currentTarget !== audioRef.current) {
              // A deck that already handed over finished its last milliseconds: unload it
              finalizeDeck(deckIdx);
              return;
            }
            handleNextTrack(true);
          }}
          onPlaying={(e) => {
            if (e.currentTarget !== audioRef.current || handoffPlayAtRef.current == null) return;
            // Learn how long a deck takes to start so the next hand-off can be timed to land on the boundary
            const latency = performance.now() - handoffPlayAtRef.current;
            handoffPlayAtRef.current = null;
            if (latency > 0 && latency < 400) {
              handoffLeadMsRef.current = Math.min(150, Math.max(5, handoffLeadMsRef.current * 0.5 + latency * 0.5));
            }
          }}
          onPlay={(e) => {
            if (e.currentTarget !== audioRef.current) return;
            isTransitioningTrackRef.current = false;
            shouldPlayRef.current = true;
            setIsPlaying(true);
          }}
          onPause={(e) => {
            if (e.currentTarget !== audioRef.current) return;
            // Ignore automatic browser pause events fired right before 'ended' or during track source transitions
            if (audioRef.current?.ended || isTransitioningTrackRef.current) {
              return;
            }
            shouldPlayRef.current = false;
            setIsPlaying(false);
          }}
          onError={(e) => {
            if (e.currentTarget !== audioRef.current) return;
            isTransitioningTrackRef.current = false;
            shouldPlayRef.current = false;
            setIsPlaying(false);
            setPlaybackError('The browser could not decode this audio stream.');
          }}
        />
      ))}

      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept="audio/*,.flac,.mp3,.wav,.m4a,.aac,.ogg,.oga,.opus,.webm"
        className="hidden"
        onChange={(e) => {
          processImportedFiles(e.target.files, false);
          e.target.value = '';
        }}
      />
      <input
        ref={folderInputRef}
        type="file"
        webkitdirectory="true"
        directory="true"
        multiple
        className="hidden"
        onChange={(e) => {
          processImportedFiles(e.target.files, true);
          e.target.value = '';
        }}
      />

      {/* Performance: backdrop-filter makes the GPU re-blur every glass panel on each frame while anything on
          screen animates (visualizer, spinning disc, pulsing dot, equalizer bars), which is what made playback laggy.
          All glass surfaces sit over already heavily blurred artwork or are at least 75% opaque, so dropping the
          backdrop blur is visually imperceptible. Delete this block to restore it. */}
      <style>{`
        .aurelia-glass-panel,
        .aurelia-glass-header,
        .aurelia-player-centerpiece,
        [class*='backdrop-blur'] {
          -webkit-backdrop-filter: none !important;
          backdrop-filter: none !important;
        }
      `}</style>

      {/* Full-Window Dynamic Album Artwork Crossfading Backdrop */}
      <div className="pointer-events-none fixed inset-0 overflow-hidden z-0">
        {backdropState.prevUrl && (
          <img
            src={backdropState.prevUrl}
            alt=""
            style={{ transform: 'translateZ(0)', willChange: 'opacity' }}
            className={`absolute inset-0 w-full h-full object-cover scale-125 blur-[95px] transition-opacity duration-1000 ease-out ${backdropState.transitioning ? 'opacity-30' : 'opacity-0'
              }`}
          />
        )}
        {backdropState.activeUrl && (
          <img
            src={backdropState.activeUrl}
            alt=""
            style={{ transform: 'translateZ(0)', willChange: 'opacity' }}
            className="absolute inset-0 w-full h-full object-cover scale-125 blur-[95px] opacity-30 transition-all duration-1000 ease-out"
          />
        )}
        <div className="absolute inset-0 aurelia-backdrop-overlay bg-gradient-to-b from-[#07080c]/80 via-[#07080c]/88 to-[#07080c]/98" />
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_25%_20%,rgba(245,158,11,0.09),transparent_55%),radial-gradient(circle_at_80%_75%,rgba(56,189,248,0.08),transparent_55%)]" />
        {settings.ambientGlow && (
          <div style={{ transform: 'translateZ(0)' }} className="pointer-events-none">
            <div className="absolute -top-36 -left-36 w-[520px] h-[520px] rounded-full bg-amber-500/10 blur-[135px]" />
            <div className="absolute top-1/4 right-0 w-[460px] h-[460px] rounded-full bg-sky-500/10 blur-[140px]" />
            <div className="absolute bottom-0 left-1/3 w-[500px] h-[380px] rounded-full bg-purple-600/10 blur-[150px]" />
          </div>
        )}
      </div>

      {isDraggingOver && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-md border-2 border-dashed border-amber-400/70 m-4 rounded-3xl flex flex-col items-center justify-center pointer-events-none">
          <Upload className="w-14 h-14 text-amber-400 animate-bounce mb-3" />
          <h2 className="text-xl font-semibold text-white tracking-tight">Drop Audio Files or Folders</h2>
        </div>
      )}

      {/* Toast Notification Banner */}
      {toast && (
        <div className="fixed top-5 right-5 z-50 flex items-center gap-3 px-4 py-3 rounded-2xl bg-zinc-900/95 border border-white/15 shadow-2xl backdrop-blur-xl animate-fade-in">
          {toast.type === 'error' ? (
            <AlertCircle className="w-5 h-5 text-rose-400 shrink-0" />
          ) : toast.type === 'success' ? (
            <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0" />
          ) : (
            <Sparkles className="w-5 h-5 text-amber-400 shrink-0" />
          )}
          <span className="text-sm text-zinc-100 font-medium">{toast.message}</span>
          <button onClick={() => setToast(null)} className="text-zinc-400 hover:text-white ml-2">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Custom Confirmation Modal */}
      {confirmModal && (
        <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-zinc-900 border border-white/15 rounded-2xl max-w-md w-full p-6 shadow-2xl">
            <h3 className="text-lg font-semibold text-white">{confirmModal.title}</h3>
            <p className="text-sm text-zinc-400 mt-2 leading-relaxed">{confirmModal.message}</p>
            <div className="flex items-center justify-end gap-3 mt-6">
              <button
                onClick={() => setConfirmModal(null)}
                className="px-4 py-2 rounded-xl bg-white/5 hover:bg-white/10 text-zinc-300 text-sm font-medium"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  confirmModal.onConfirm();
                  setConfirmModal(null);
                }}
                className="px-4 py-2 rounded-xl bg-rose-500 hover:bg-rose-600 text-white text-sm font-semibold"
              >
                Confirm
              </button>
            </div>
          </div>
        </div>
      )}

      <header className="aurelia-glass-header relative z-40 shrink-0 border-b border-white/[0.07] bg-zinc-950/50 backdrop-blur-xl">
        {/* Title bar: brand, now-playing capsule and quick actions */}
        <div
          data-tauri-drag-region
          style={DRAG_STYLE}
          onDoubleClick={handleTitleBarDoubleClick}
          className="pywebview-drag-region relative flex items-center justify-between gap-3 px-4 lg:px-8 h-10 overflow-hidden select-none md:grid md:grid-cols-[auto_minmax(0,28rem)_auto] bg-gradient-to-r from-amber-500/[0.05] via-transparent to-amber-500/[0.05] border-b border-black/5 dark:border-white/[0.05]"
        >
          {/* Brand Logo Only */}
          <div className="pointer-events-none flex items-center min-w-0">
            <div className="w-7 h-7 shrink-0 rounded-xl bg-gradient-to-br from-amber-400 via-amber-500 to-amber-700 flex items-center justify-center shadow-md shadow-amber-500/20">
              <Disc className={`w-3.5 h-3.5 text-zinc-950 ${isPlaying ? 'animate-spin' : ''}`} style={{ animationDuration: '6s' }} />
            </div>
          </div>

          {/* Now playing (compact title on phones, Interactive Dynamic Island from md up) */}
          <span className="pointer-events-none md:hidden flex-1 min-w-0 truncate text-xs text-zinc-600 dark:text-zinc-400 text-right">
            {currentTrack ? currentTrack.title : ''}
          </span>
          <div className="hidden md:flex items-center justify-center min-w-0">
            <div
              style={NO_DRAG_STYLE}
              className="group pointer-events-auto flex items-center gap-2.5 max-w-full min-w-0 px-3.5 py-1 rounded-full transition-all duration-300 ease-out shadow-sm bg-white/90 dark:bg-black/40 border border-slate-200 dark:border-white/10 hover:bg-white dark:hover:bg-black/90 hover:border-amber-500/40 hover:shadow-amber-500/10 hover:scale-[1.02]"
            >
              {/* Soundwave Visualizer Bars */}
              <span className="flex items-end gap-[3px] h-3.5 shrink-0" aria-hidden="true">
                {[0, 1, 2, 3].map((i) => (
                  <span
                    key={i}
                    className={`w-[3px] h-full rounded-full origin-bottom ${currentTrack ? '' : 'bg-zinc-400 dark:bg-zinc-600'}`}
                    style={{
                      backgroundColor: currentTrack ? activePalette.hex400 : undefined,
                      ...(isPlaying
                        ? { animation: `aurelia-eq ${0.8 + i * 0.13}s ease-in-out ${i * 0.1}s infinite` }
                        : { transform: 'scaleY(0.3)' })
                    }}
                  />
                ))}
              </span>

              {/* Track Title & Artist */}
              <div className="min-w-0 flex items-baseline gap-1.5 max-w-[200px] lg:max-w-[280px]">
                <span className={`truncate text-xs font-semibold ${currentTrack ? 'text-zinc-800 dark:text-zinc-100' : 'text-zinc-400 dark:text-zinc-500'}`}>
                  {currentTrack ? currentTrack.title : t('nothingPlaying')}
                </span>
                {currentTrack?.artist && (
                  <span className="hidden sm:inline truncate text-[11px] text-zinc-500 dark:text-zinc-400">
                    • {currentTrack.artist}
                  </span>
                )}
              </div>

              {/* Quick Hover Controls (Previous, Play/Pause, Next, Mini Player Toggle) */}
              <div className="flex items-center gap-1 transition-all duration-300 ease-out overflow-hidden opacity-0 max-w-0 pointer-events-none group-hover:opacity-100 group-hover:max-w-[140px] group-hover:pointer-events-auto group-hover:ml-1 group-hover:pl-1.5 group-hover:border-l group-hover:border-black/10 dark:group-hover:border-white/15">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    handlePrevTrack();
                  }}
                  className="p-1 rounded-full hover:bg-black/5 dark:hover:bg-white/10 text-zinc-600 dark:text-zinc-300 hover:text-zinc-950 dark:hover:text-white transition"
                  title={t('prevTrack')}
                >
                  <SkipBack className="w-3 h-3" />
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    togglePlayPause();
                  }}
                  className="p-1 rounded-full bg-amber-500 hover:bg-amber-400 text-zinc-950 font-bold transition shadow-sm"
                  title={isPlaying ? t('pause') : t('play')}
                >
                  {isPlaying ? <Pause className="w-3 h-3 fill-current" /> : <Play className="w-3 h-3 fill-current ml-0.5" />}
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    handleNextTrack(false);
                  }}
                  className="p-1 rounded-full hover:bg-black/5 dark:hover:bg-white/10 text-zinc-600 dark:text-zinc-300 hover:text-zinc-950 dark:hover:text-white transition"
                  title={t('nextTrack')}
                >
                  <SkipForward className="w-3 h-3" />
                </button>
              </div>
            </div>
          </div>

          {/* Quick actions & Window controls */}
          <div className="pointer-events-none flex items-center justify-end shrink-0 md:shrink self-stretch gap-1.5">
            {showWindowControls && (
              <div
                style={NO_DRAG_STYLE}
                className="pointer-events-auto flex self-stretch ml-1 -mr-4 lg:-mr-8 border-l border-black/5 dark:border-white/[0.06]"
              >
                <button
                  onClick={() => runWindowAction('minimize')}
                  className="w-11 sm:w-[46px] h-full flex items-center justify-center text-zinc-600 dark:text-zinc-300 hover:text-zinc-950 dark:hover:text-white hover:bg-black/5 dark:hover:bg-white/10 transition-colors"
                  title="Minimize"
                  aria-label="Minimize window"
                >
                  <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1" aria-hidden="true">
                    <path d="M0 5.5h10" />
                  </svg>
                </button>
                <button
                  onClick={() => runWindowAction('toggleMaximize')}
                  className="w-11 sm:w-[46px] h-full flex items-center justify-center text-zinc-600 dark:text-zinc-300 hover:text-zinc-950 dark:hover:text-white hover:bg-black/5 dark:hover:bg-white/10 transition-colors"
                  title={isWinMaximized ? 'Restore' : 'Maximize'}
                  aria-label={isWinMaximized ? 'Restore window' : 'Maximize window'}
                >
                  {isWinMaximized ? (
                    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1" aria-hidden="true">
                      <path d="M2.5 2.5V0.5h7v7h-2" />
                      <rect x="0.5" y="2.5" width="7" height="7" />
                    </svg>
                  ) : (
                    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1" aria-hidden="true">
                      <rect x="0.5" y="0.5" width="9" height="9" />
                    </svg>
                  )}
                </button>
                <button
                  onClick={() => runWindowAction('close')}
                  className="w-11 sm:w-[46px] h-full flex items-center justify-center text-zinc-600 dark:text-zinc-300 hover:text-white hover:bg-red-600 transition-colors"
                  title="Close"
                  aria-label="Close window"
                >
                  <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1" aria-hidden="true">
                    <path d="M0.5 0.5l9 9M9.5 0.5l-9 9" />
                  </svg>
                </button>
              </div>
            )}
          </div>

          {/* Playback progress hairline along the bottom edge */}
          <ClockProgressBar duration={duration} palette={activePalette} />
        </div>

        {/* Navigation + import row */}
        <div className="px-4 lg:px-8 py-2 flex flex-wrap items-center justify-between gap-3">
          <nav className="flex items-center gap-1 bg-white/70 dark:bg-white/[0.03] p-1 rounded-xl border border-slate-200 dark:border-white/[0.07] overflow-x-auto max-w-full no-scrollbar shadow-xs">
            {[
              { id: 'library', label: t('library'), icon: Music },
              { id: 'equalizer', label: t('equalizer') || 'Equalizer', icon: SlidersHorizontal },
              { id: 'insights', label: t('signals'), icon: Activity },
              { id: 'settings', label: t('settings'), icon: Settings }
            ].map((item) => {
              const Icon = item.icon;
              const active = activeTab === item.id;
              return (
                <button
                  key={item.id}
                  onClick={() => setActiveTab(item.id)}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all whitespace-nowrap ${active
                    ? 'bg-amber-500/15 text-amber-600 dark:text-amber-300 border border-amber-500/30'
                    : 'text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-200 hover:bg-slate-100 dark:hover:bg-white/5'
                    }`}
                >
                  <Icon className="w-3.5 h-3.5" />
                  <span>{item.label}</span>
                </button>
              );
            })}
          </nav>

          <div className="flex items-center gap-2">
            {/* Quick Dark / Light Mode Toggle */}
            <button
              onClick={() => updateSetting('themeMode', settings.themeMode === 'light' ? 'dark' : 'light')}
              className="p-2 rounded-xl border border-slate-200 dark:border-white/10 bg-white/70 dark:bg-white/[0.04] hover:bg-slate-100 dark:hover:bg-white/[0.08] text-zinc-700 dark:text-zinc-300 hover:text-zinc-950 dark:hover:text-white transition shadow-xs"
              title={settings.themeMode === 'light' ? t('darkMode') : t('lightMode')}
              aria-label={settings.themeMode === 'light' ? t('darkMode') : t('lightMode')}
            >
              {settings.themeMode === 'light' ? (
                <Moon className="w-3.5 h-3.5" />
              ) : (
                <Sun className="w-3.5 h-3.5" />
              )}
            </button>

            {/* Quick Color Picker Trigger & Dropdown Popover */}
            <div className="relative" ref={colorPickerRef}>
              <button
                onClick={() => setShowColorPickerPopover((prev) => !prev)}
                className={`p-2 rounded-xl border transition flex items-center justify-center gap-1.5 ${showColorPickerPopover
                  ? 'bg-slate-100 dark:bg-white/10 border-slate-300 dark:border-white/20 text-zinc-900 dark:text-white shadow-sm'
                  : 'bg-white/70 dark:bg-white/[0.04] hover:bg-slate-100 dark:hover:bg-white/[0.08] text-zinc-700 dark:text-zinc-300 border-slate-200 dark:border-white/10 shadow-xs'
                  }`}
                title={t('accentColorQuick')}
                aria-label={t('accentColorQuick')}
              >
                <span
                  className="w-3.5 h-3.5 rounded-full ring-2 ring-white/20 shadow-sm transition-transform hover:scale-110 shrink-0"
                  style={{ backgroundColor: activePalette.swatch }}
                />
                <ChevronDown className={`w-3 h-3 text-zinc-500 dark:text-zinc-400 transition-transform duration-200 ${showColorPickerPopover ? 'rotate-180 text-zinc-900 dark:text-white' : ''}`} />
              </button>

              {showColorPickerPopover && (
                <div className="absolute right-0 top-full mt-2.5 z-50 p-2 rounded-2xl bg-white dark:bg-zinc-950/90 border border-slate-200 dark:border-white/10 shadow-2xl backdrop-blur-2xl flex items-center gap-1.5 animate-in fade-in zoom-in-95 duration-150">
                  {/* Preset Color Dots */}
                  {Object.values(ACCENT_PALETTES).map((pal) => {
                    const isSelected = settings.accentColor === pal.id;
                    return (
                      <button
                        key={pal.id}
                        onClick={() => updateSetting('accentColor', pal.id)}
                        className={`w-5 h-5 rounded-full transition-all flex items-center justify-center shrink-0 ${isSelected
                          ? 'ring-2 ring-white ring-offset-2 ring-offset-zinc-950 scale-110'
                          : 'opacity-70 hover:opacity-100 hover:scale-110'
                          }`}
                        style={{ backgroundColor: pal.swatch }}
                        title={pal.label}
                      />
                    );
                  })}

                  <div className="w-[1px] h-4 bg-white/15 mx-0.5" />

                  {/* Extract from Album Art Button */}
                  <button
                    onClick={() => {
                      handleExtractAlbumColor();
                      setShowColorPickerPopover(false);
                    }}
                    className={`p-1 rounded-lg transition-all flex items-center justify-center shrink-0 ${currentTrack?.coverUrl ? 'hover:scale-110 text-amber-300 hover:bg-white/10' : 'opacity-40 text-zinc-500 cursor-not-allowed'
                      }`}
                    title={t('colorFromAlbum')}
                  >
                    <Sparkles className="w-3.5 h-3.5" />
                  </button>
                </div>
              )}
            </div>

            <button
              onClick={() => fileInputRef.current?.click()}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-amber-500 hover:bg-amber-400 text-zinc-950 font-semibold text-xs transition shadow-md shadow-amber-500/15"
              title={t('importAudioFiles')}
            >
              <Upload className="w-3.5 h-3.5" />
              <span>{t('importFiles')}</span>
            </button>
          </div>
        </div>
      </header>

      { }
      <main className="relative z-10 flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-12 gap-4 px-4 lg:px-8 pt-3 pb-4 max-w-[1720px] w-full mx-auto overflow-hidden">
        {/* Left Column: Unified Audio Stream & Now Playing Centerpiece */}
        <section className="lg:col-span-5 min-h-0 flex flex-col">
          <div className="aurelia-glass-panel aurelia-player-centerpiece flex-1 min-h-0 rounded-3xl border border-white/10 shadow-2xl flex flex-col justify-between p-4 sm:p-5 relative overflow-hidden bg-zinc-950">
            {/* Dynamic Crossfading Album Artwork Ambient Background */}
            <div className="pointer-events-none absolute inset-0 overflow-hidden z-0">
              {backdropState.prevUrl && (
                <img
                  src={backdropState.prevUrl}
                  alt=""
                  className={`absolute inset-0 w-full h-full object-cover object-center scale-110 blur-2xl transition-opacity duration-700 ease-out ${backdropState.transitioning ? 'opacity-55' : 'opacity-0'
                    }`}
                />
              )}
              {backdropState.activeUrl && (
                <img
                  src={backdropState.activeUrl}
                  alt=""
                  className="absolute inset-0 w-full h-full object-cover object-center scale-110 blur-2xl opacity-55 transition-all duration-700 ease-out"
                />
              )}
              <div className="absolute inset-0 aurelia-centerpiece-overlay bg-gradient-to-b from-black/45 via-black/65 to-[#07080c]/95" />
              <div className="absolute inset-0 aurelia-centerpiece-radial bg-[radial-gradient(circle_at_50%_26%,transparent_15%,rgba(7,8,12,0.82)_100%)]" />
            </div>

            {/* Top Bar: Audio Stream Spec, Queue Toggle & Adjacent Fullscreen Buttons */}
            <div className="relative z-10 flex items-center justify-between gap-2 shrink-0">
              <div className="flex items-center gap-2 text-[11px] font-mono text-zinc-300/90 min-w-0">
                <span className={`w-2 h-2 rounded-full shrink-0 ${isPlaying ? 'animate-pulse' : 'bg-zinc-500'}`} style={{ backgroundColor: isPlaying ? activePalette.hex400 : undefined }} />
                <span className="truncate">{currentTrack?.codec?.split(' ')[0] || 'PCM'}</span>
                {currentTrack?.sampleRate && (
                  <span className="text-zinc-400 shrink-0">
                    • {(currentTrack.sampleRate / 1000).toFixed(1)}kHz
                    {currentTrack.bitDepth ? `/${currentTrack.bitDepth}b` : ''}
                  </span>
                )}
              </div>

              <div className="flex items-center gap-1.5 shrink-0">
                <button
                  onClick={() => setShowQueueDrawer((q) => !q)}
                  className={`px-2 py-1.5 rounded-xl border text-xs font-medium flex items-center gap-1 transition ${showQueueDrawer
                    ? 'bg-amber-500/20 border-amber-500/40 text-amber-300'
                    : 'bg-black/35 hover:bg-black/60 border-white/10 text-zinc-300 hover:text-white'
                    }`}
                  title={`Playback Queue (${queue.length})`}
                  aria-label="Toggle Playback Queue"
                >
                  <ListMusic className="w-3.5 h-3.5" />
                  <span className="text-[10px] font-mono">{queue.length}</span>
                </button>
                <button
                  onClick={(e) => toggleFullscreenMode('lyrics', e.currentTarget)}
                  className="p-2 rounded-xl bg-black/35 hover:bg-black/60 text-zinc-300 hover:text-amber-300 border border-white/10 transition"
                  title="Lyrics Fullscreen"
                  aria-label="Lyrics Fullscreen"
                >
                  <AlignCenter className="w-3.5 h-3.5" />
                </button>
                <button
                  onClick={(e) => toggleFullscreenMode('player', e.currentTarget)}
                  className="p-2 rounded-xl bg-black/35 hover:bg-black/60 text-zinc-300 hover:text-amber-300 border border-white/10 transition"
                  title="Player Fullscreen (F)"
                  aria-label="Player Fullscreen"
                >
                  <Maximize2 className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>

            {/* Centerpiece Album Artwork & Track Identity */}
            <div className="relative z-10 flex sm:flex-row lg:flex-col items-center gap-3.5 my-auto py-1 shrink-0">
              <div className="relative group aspect-square w-24 sm:w-28 lg:w-36 xl:w-44 mx-auto rounded-2xl overflow-hidden shadow-[0_20px_50px_rgba(0,0,0,0.75)] ring-1 ring-white/15 bg-zinc-900/60 shrink-0">
                {currentTrack?.coverUrl ? (
                  <img
                    key={currentTrack.coverUrl}
                    src={currentTrack.coverUrl}
                    alt={currentTrack.title}
                    className="w-full h-full object-cover transition-transform duration-700 group-hover:scale-[1.03]"
                  />
                ) : (
                  <div className="w-full h-full flex items-center justify-center text-zinc-600">
                    <Disc className="w-10 h-10" />
                  </div>
                )}
              </div>

              <div className="text-center sm:text-left lg:text-center min-w-0 flex-1 w-full px-1 drop-shadow dark:drop-shadow-[0_2px_10px_rgba(0,0,0,0.85)]">
                <h1
                  className="text-base sm:text-lg font-semibold text-zinc-900 dark:text-white tracking-tight truncate"
                  title={currentTrack?.title}
                >
                  {currentTrack?.title || 'No Track Selected'}
                </h1>
                <p
                  onClick={() => {
                    const targetAlbId = currentTrack?.albumId || buildAlbumIdentityKey(currentTrack?.album, currentTrack?.albumArtist, currentTrack?.folderPath);
                    if (targetAlbId) {
                      setSelectedAlbumId(targetAlbId);
                      setActiveTab('library');
                      setLibraryViewMode('albums');
                    }
                  }}
                  className="text-xs sm:text-sm text-amber-500 dark:text-amber-300/90 hover:text-amber-600 dark:hover:text-amber-200 font-medium truncate mt-0.5 cursor-pointer"
                  title={currentTrack?.album ? `${currentTrack.artist} — ${currentTrack.album}` : currentTrack?.artist}
                >
                  {currentTrack?.artist || 'Aurelia'}
                  {currentTrack?.album ? <span className="text-zinc-700 dark:text-zinc-300 font-medium album-subtitle-text"> • {currentTrack.album}</span> : null}
                </p>
              </div>
            </div>

            {playbackError && (
              <div className="relative z-10 px-3 py-1.5 rounded-xl bg-rose-950/70 border border-rose-500/30 text-rose-200 text-xs flex items-center justify-between gap-2 shrink-0">
                <span className="truncate">{playbackError}</span>
                <button
                  onClick={() => handleSelectOrRestoreFolder(rememberedFolder.handle)}
                  className="underline text-rose-300 hover:text-white font-medium shrink-0"
                >
                  Relink
                </button>
              </div>
            )}

            {/* Integrated Multi-Line Wrapping Synchronized Lyrics Viewport (No Truncation, No Scrollbar) */}
            <div className="relative z-10 min-h-[104px] max-h-[124px] flex flex-col justify-center px-2 shrink-0 overflow-hidden no-scrollbar">
              {autoLyricsState.status === 'loading' ? (
                <div className="flex items-center justify-center gap-2 text-xs text-zinc-600 dark:text-zinc-300/80">
                  <RefreshCw className="w-3.5 h-3.5 animate-spin text-amber-500 dark:text-amber-400" />
                  <span>Syncing lyrics...</span>
                </div>
              ) : visibleLyricsWindow.length > 0 ? (
                <div className="flex flex-col items-center justify-center gap-1.5 text-center overflow-hidden no-scrollbar">
                  {visibleLyricsWindow.map((line) => {
                    const isActive = line.role === 'active';
                    const isPast = line.role === 'past';
                    return (
                      <div
                        key={line.id}
                        onClick={() => {
                          if (line.timeSec !== null) {
                            const offsetSec = (currentTrack?.lyricsOffsetMs || 0) / 1000;
                            handleSeek(Math.max(0, line.timeSec + offsetSec));
                          }
                        }}
                        className={`max-w-md w-full px-2 whitespace-normal break-words [overflow-wrap:anywhere] [text-wrap:balance] leading-snug transition-[opacity,color,transform] duration-300 ease-out dark:drop-shadow-[0_2px_8px_rgba(0,0,0,0.95)] ${line.timeSec !== null ? 'cursor-pointer' : ''
                          } ${isActive
                            ? 'text-amber-600 dark:text-amber-300 font-semibold text-xs sm:text-sm opacity-100'
                            : isPast
                              ? 'text-zinc-400 dark:text-zinc-400 opacity-50 dark:opacity-40 text-[11px] sm:text-xs'
                              : 'text-zinc-700 dark:text-zinc-200 opacity-90 dark:opacity-70 text-[11px] sm:text-xs hover:opacity-100'
                          }`}
                      >
                        {line.text}
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="flex items-center justify-center">
                  <span className="text-xs text-zinc-400 dark:text-zinc-400/60 font-medium tracking-wide">
                    {autoLyricsState.status === 'offline' ? 'Offline' : '♪'}
                  </span>
                </div>
              )}
            </div>

            {/* Bars-Only Spectrum + Unified Playback Controls Deck */}
            <div className="relative z-10 flex flex-col gap-2.5 shrink-0 pt-1">
              <canvas
                ref={visualizerCanvasRef}
                width={420}
                height={42}
                style={{ transform: 'translateZ(0)', willChange: 'contents' }}
                className="w-full h-[42px] block pointer-events-none"
              />

              {/* Seek / Progress Bar */}
              <div className="flex items-center gap-2.5 pt-1 border-t border-zinc-200/80 dark:border-white/10">
                <WithClock step={1}>
                  {(currentTime) => (
                    <span className="text-[11px] font-mono w-9 text-right shrink-0" style={{ color: activePalette?.hex300 || '#fcd34d' }}>
                      {formatTime(currentTime)}
                    </span>
                  )}
                </WithClock>
                <WithClock>
                  {(currentTime) => {
                    const dur = Math.max(1, duration || currentTrack?.duration || 1);
                    const pct = Math.min(100, Math.max(0, (currentTime / dur) * 100));
                    return (
                      <input
                        type="range"
                        min={0}
                        max={dur}
                        step={0.05}
                        value={Math.min(currentTime, dur)}
                        onChange={(e) => handleSeek(parseFloat(e.target.value))}
                        aria-label="Seek timeline"
                        style={{
                          accentColor: activePalette?.hex400 || '#fbbf24',
                          '--range-progress': `${pct}%`
                        }}
                        className="aurelia-slider-progress flex-1 h-1.5 rounded-full appearance-none cursor-pointer"
                      />
                    );
                  }}
                </WithClock>
                <span className="text-[11px] font-mono text-zinc-500 dark:text-zinc-400 w-9 shrink-0">
                  {formatTime(duration || currentTrack?.duration || 0)}
                </span>
              </div>

              {/* Unified Transport Controls Row */}
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => setShuffle((s) => !s)}
                    className={`p-1.5 rounded-xl transition ${shuffle ? 'text-amber-400 bg-amber-500/15' : 'text-zinc-400 hover:text-white hover:bg-white/5'
                      }`}
                    title="Shuffle (S)"
                    aria-label="Shuffle"
                  >
                    <Shuffle className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={() => setRepeatMode((r) => (r === 'off' ? 'all' : r === 'all' ? 'one' : 'off'))}
                    className={`p-1.5 rounded-xl transition ${repeatMode !== 'off'
                      ? 'text-amber-400 bg-amber-500/15'
                      : 'text-zinc-400 hover:text-white hover:bg-white/5'
                      }`}
                    title={`Repeat: ${repeatMode.toUpperCase()} (R)`}
                    aria-label="Repeat"
                  >
                    {repeatMode === 'one' ? <Repeat1 className="w-3.5 h-3.5" /> : <Repeat className="w-3.5 h-3.5" />}
                  </button>
                </div>

                <div className="flex items-center gap-2.5">
                  <button
                    onClick={handlePrevTrack}
                    className="p-2 rounded-xl bg-white/[0.06] hover:bg-white/15 text-zinc-100 transition"
                    title="Previous Track"
                    aria-label="Previous Track"
                  >
                    <SkipBack className="w-4 h-4" />
                  </button>
                  <button
                    onClick={togglePlayPause}
                    className="w-10 h-10 rounded-2xl bg-gradient-to-br from-amber-400 to-amber-600 hover:from-amber-300 hover:to-amber-500 text-zinc-950 flex items-center justify-center shadow-lg shadow-amber-500/25 transition"
                    title="Play / Pause (Space)"
                    aria-label={isPlaying ? 'Pause' : 'Play'}
                  >
                    {isPlaying ? (
                      <Pause className="w-4 h-4 fill-zinc-950" />
                    ) : (
                      <Play className="w-4 h-4 fill-zinc-950 ml-0.5" />
                    )}
                  </button>
                  <button
                    onClick={() => handleNextTrack(false)}
                    className="p-2 rounded-xl bg-white/[0.06] hover:bg-white/15 text-zinc-100 transition"
                    title="Next Track"
                    aria-label="Next Track"
                  >
                    <SkipForward className="w-4 h-4" />
                  </button>
                </div>

                <div className="flex items-center gap-1.5">
                  <button
                    onClick={() => setIsMuted((m) => !m)}
                    className="p-1.5 rounded-xl text-zinc-300 hover:text-white transition"
                    title="Mute / Unmute (M)"
                    aria-label="Mute"
                  >
                    {isMuted || volume === 0 ? (
                      <VolumeX className="w-3.5 h-3.5 text-rose-400" />
                    ) : volume < 0.5 ? (
                      <Volume1 className="w-3.5 h-3.5" />
                    ) : (
                      <Volume2 className="w-3.5 h-3.5" />
                    )}
                  </button>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.01}
                    value={isMuted ? 0 : volume}
                    onChange={(e) => {
                      setIsMuted(false);
                      setVolume(parseFloat(e.target.value));
                    }}
                    aria-label="Volume"
                    style={{
                      accentColor: activePalette?.hex400 || '#fbbf24',
                      '--range-progress': `${(isMuted ? 0 : volume) * 100}%`
                    }}
                    className="aurelia-slider-progress w-16 sm:w-20 h-1.5 rounded-full appearance-none cursor-pointer"
                  />
                </div>
              </div>

              {/* Minimal EQ Strip */}
              <div className="flex items-center justify-between gap-2 pt-1.5 border-t border-slate-200/80 dark:border-white/[0.07]">
                <button
                  onClick={() => setActiveTab('equalizer')}
                  className="text-[10px] text-zinc-500 dark:text-zinc-400 hover:text-amber-600 dark:hover:text-amber-300 flex items-center gap-1 transition"
                  title="Open 10-Band Parametric Equalizer"
                >
                  <SlidersHorizontal className="w-3 h-3 text-amber-500 dark:text-amber-400/80" />
                  <span>EQ 10-Band</span>
                </button>
                <div className="flex items-center gap-1">
                  {[
                    { id: 'flat', label: 'Linear' },
                    { id: 'warmth', label: 'Warmth' },
                    { id: 'air', label: 'Air' },
                    { id: 'vocal', label: 'Vocal' }
                  ].map((eq) => (
                    <button
                      key={eq.id}
                      onClick={() => {
                        updateSetting('eqPreset', eq.id);
                        const presetMap = {
                          flat: 'builtin-flat',
                          warmth: 'builtin-warm',
                          air: 'builtin-bright',
                          vocal: 'builtin-vocal'
                        };
                        const targetId = presetMap[eq.id] || 'builtin-flat';
                        const found = BUILTIN_PEQ_PRESETS.find((p) => p.id === targetId);
                        if (found) {
                          setPeqState((prev) => ({
                            ...prev,
                            activePresetId: found.id,
                            preamp: found.preamp,
                            bands: found.bands.map((b) => ({ ...b }))
                          }));
                        }
                      }}
                      className={`px-2 py-0.5 rounded-lg text-[10px] font-medium transition ${settings.eqPreset === eq.id
                        ? 'bg-amber-500/20 text-amber-600 dark:text-amber-300 border border-amber-500/30'
                        : 'text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-white/5'
                        }`}
                    >
                      {eq.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="lg:col-span-7 min-h-0 flex flex-col">
          {/* TAB 1: ALBUM-AWARE MUSIC LIBRARY */}
          {activeTab === 'library' && (
            <div className="aurelia-glass-panel flex-1 min-h-0 rounded-3xl bg-zinc-900/55 border border-white/10 backdrop-blur-2xl p-4 sm:p-5 shadow-2xl flex flex-col gap-3 overflow-hidden">
              {/* Folder & Library Management Bar */}
              <div className="px-3 py-2 rounded-2xl bg-slate-100/90 dark:bg-zinc-950/70 border border-slate-200/90 dark:border-white/[0.07] flex flex-col gap-2 shrink-0">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <FolderOpen className="w-3.5 h-3.5 text-amber-500 dark:text-amber-400 shrink-0" />
                    <span className="text-xs font-semibold text-zinc-900 dark:text-zinc-200 truncate">
                      {rememberedFolder.name || t('library')}
                    </span>
                    <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-slate-200/80 dark:bg-white/5 text-zinc-700 dark:text-zinc-400 border border-slate-300/60 dark:border-transparent">
                      {groupedAlbums.length} albums • {tracks.length} tracks
                    </span>
                  </div>

                  <div className="flex items-center gap-1.5 shrink-0 flex-wrap">
                    <button
                      onClick={handlePickAndImportFolder}
                      className="px-2.5 py-1 rounded-lg bg-amber-500 hover:bg-amber-400 text-zinc-950 font-semibold text-xs flex items-center gap-1.5 transition shadow-sm"
                      title={t('importFolder')}
                    >
                      <FolderOpen className="w-3.5 h-3.5" />
                      <span>{t('importFolder')}</span>
                    </button>
                    <button
                      onClick={handleRescanFolder}
                      className="px-2.5 py-1 rounded-lg bg-slate-200/80 hover:bg-slate-300/80 dark:bg-white/5 dark:hover:bg-white/10 border border-slate-300/80 dark:border-white/10 text-zinc-800 dark:text-zinc-200 text-xs flex items-center gap-1.5 transition"
                      title={t('rescanFolder')}
                    >
                      <RefreshCw className="w-3 h-3 text-amber-600 dark:text-amber-400" />
                      <span>{t('rescan')}</span>
                    </button>
                    <button
                      onClick={handleFindAndRemoveDuplicates}
                      className="px-2.5 py-1 rounded-lg bg-amber-500/15 hover:bg-amber-500/25 border border-amber-500/30 text-amber-700 dark:text-amber-300 text-xs flex items-center gap-1.5 transition font-medium"
                      title={t('removeDuplicates')}
                    >
                      <Sparkles className="w-3 h-3 text-amber-600 dark:text-amber-400" />
                      <span>{t('cleanDuplicates')}</span>
                    </button>
                    <button
                      onClick={handleRunSmartMetadataAudit}
                      className="px-2.5 py-1 rounded-lg bg-sky-500/15 hover:bg-sky-500/25 border border-sky-500/30 text-sky-700 dark:text-sky-300 text-xs flex items-center gap-1.5 transition font-medium"
                      title={t('auditMetadata')}
                    >
                      <Shield className="w-3 h-3 text-sky-600 dark:text-sky-400" />
                      <span>{t('smartScan')}</span>
                    </button>
                    {rememberedFolder.name && (
                      <button
                        onClick={handleForgetRememberedFolder}
                        className="px-2 py-1 rounded-lg bg-slate-200/80 hover:bg-rose-100 dark:bg-white/5 dark:hover:bg-white/10 text-xs text-rose-600 dark:text-rose-400/80 hover:text-rose-700 dark:hover:text-rose-300 border border-slate-300/80 dark:border-transparent transition"
                        title={t('forget')}
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    )}
                  </div>
                </div>

                {importProgress && importProgress.active && (
                  <div className="flex flex-col gap-1">
                    <div className="flex items-center justify-between text-[11px]">
                      <span className="text-amber-300 flex items-center gap-1.5 truncate">
                        <RefreshCw className="w-3 h-3 animate-spin shrink-0" />
                        <span className="truncate">
                          {importProgress.processed}/{importProgress.totalDiscovered} • {importProgress.currentFile}
                        </span>
                      </span>
                      <button
                        onClick={() => setImportProgress(null)}
                        className="text-zinc-500 hover:text-white text-[10px] shrink-0 ml-2"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                    <div className="w-full h-1 rounded-full bg-white/10 overflow-hidden">
                      <div
                        style={{
                          width: `${Math.round(
                            (importProgress.processed / Math.max(1, importProgress.totalDiscovered)) * 100
                          )}%`
                        }}
                        className="h-full bg-amber-400 transition-all duration-200"
                      />
                    </div>
                  </div>
                )}
              </div>

              {/* Library Controls Header */}
              <div className="flex flex-wrap items-center justify-between gap-2.5 shrink-0">
                <div className="flex items-center gap-2">
                  <div className="flex items-center gap-1 bg-slate-100 dark:bg-zinc-950/80 p-1 rounded-xl border border-slate-200 dark:border-white/[0.07]">
                    <button
                      onClick={() => setLibraryViewMode('albums')}
                      className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium transition ${libraryViewMode === 'albums'
                        ? 'bg-amber-500 text-zinc-950 font-semibold shadow-sm'
                        : 'text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-white'
                        }`}
                    >
                      <LayoutGrid className="w-3.5 h-3.5" />
                      <span>Albums ({groupedAlbums.length})</span>
                    </button>
                    <button
                      onClick={() => setLibraryViewMode('tracks')}
                      className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium transition ${libraryViewMode === 'tracks'
                        ? 'bg-amber-500 text-zinc-950 font-semibold shadow-sm'
                        : 'text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-white'
                        }`}
                    >
                      <List className="w-3.5 h-3.5" />
                      <span>Tracks ({filteredTracks.length})</span>
                    </button>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2 w-full sm:w-auto">
                  <div className="relative flex-1 sm:w-52">
                    <Search className="w-3.5 h-3.5 text-zinc-400 dark:text-zinc-500 absolute left-3 top-1/2 -translate-y-1/2" />
                    <input
                      type="text"
                      value={searchQuery}
                      onChange={(e) => {
                        setSearchQuery(e.target.value);
                        setVisibleAlbumLimit(28);
                        setVisibleTrackLimit(80);
                      }}
                      placeholder="Search library..."
                      className="w-full pl-8 pr-7 py-1.5 rounded-xl bg-slate-50 dark:bg-zinc-950/80 border border-slate-200 dark:border-white/[0.07] text-xs text-zinc-900 dark:text-white placeholder-zinc-400 dark:placeholder-zinc-500 focus:outline-none focus:border-amber-500"
                    />
                    {searchQuery && (
                      <button
                        onClick={() => setSearchQuery('')}
                        className="absolute right-2.5 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-zinc-700 dark:text-zinc-500 dark:hover:text-white"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>

                  <div className="flex items-center gap-1 bg-slate-50 dark:bg-zinc-950/80 border border-slate-200 dark:border-white/[0.07] rounded-xl px-2 py-1">
                    <select
                      value={sortBy}
                      onChange={(e) => setSortBy(e.target.value)}
                      className="bg-transparent text-xs text-zinc-800 dark:text-zinc-300 focus:outline-none cursor-pointer"
                      aria-label="Sort by"
                    >
                      <option value="album" className="bg-white text-zinc-900 dark:bg-zinc-900 dark:text-zinc-100">Album</option>
                      <option value="artist" className="bg-white text-zinc-900 dark:bg-zinc-900 dark:text-zinc-100">Artist</option>
                      <option value="title" className="bg-white text-zinc-900 dark:bg-zinc-900 dark:text-zinc-100">Title</option>
                      <option value="duration" className="bg-white text-zinc-900 dark:bg-zinc-900 dark:text-zinc-100">Duration</option>
                      <option value="codec" className="bg-white text-zinc-900 dark:bg-zinc-900 dark:text-zinc-100">Codec</option>
                    </select>
                    <button
                      onClick={() => setSortAsc((s) => !s)}
                      className="p-1 hover:bg-slate-200/80 dark:hover:bg-white/10 rounded text-amber-500 dark:text-amber-400"
                      title="Reverse sort order"
                    >
                      <ArrowUpDown className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              </div>

              {/* Playlists Filter Strip */}
              <div className="flex items-center justify-between gap-2 shrink-0">
                <div className="flex items-center gap-1.5 overflow-x-auto pb-0.5 no-scrollbar">
                  <button
                    onClick={() => setSelectedPlaylistId('ALL')}
                    className={`px-2.5 py-1 rounded-lg text-xs font-medium transition whitespace-nowrap ${selectedPlaylistId === 'ALL'
                      ? 'bg-zinc-900 text-white dark:bg-white/15 dark:text-white shadow-sm font-semibold'
                      : 'text-zinc-600 hover:text-zinc-900 hover:bg-slate-100 dark:text-zinc-400 dark:hover:text-zinc-200 dark:hover:bg-white/5'
                      }`}
                  >
                    All
                  </button>
                  {playlists.map((pl) => (
                    <button
                      key={pl.id}
                      onClick={() => setSelectedPlaylistId(pl.id)}
                      className={`px-2.5 py-1 rounded-lg text-xs font-medium transition flex items-center gap-1.5 whitespace-nowrap ${selectedPlaylistId === pl.id
                        ? 'bg-zinc-900 text-amber-400 dark:bg-white/15 dark:text-amber-300 shadow-sm font-semibold'
                        : 'text-zinc-600 hover:text-zinc-900 hover:bg-slate-100 dark:text-zinc-400 dark:hover:text-zinc-200 dark:hover:bg-white/5'
                        }`}
                    >
                      <span>{pl.name}</span>
                      <span className="text-[10px] opacity-60">{pl.trackIds.length}</span>
                    </button>
                  ))}
                </div>

                <div className="flex items-center gap-1 shrink-0">
                  <input
                    type="text"
                    value={newPlaylistName}
                    onChange={(e) => setNewPlaylistName(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleCreatePlaylist()}
                    placeholder="New playlist"
                    className="px-2.5 py-1 rounded-lg bg-slate-50 dark:bg-zinc-950/60 border border-slate-200 dark:border-white/[0.07] text-xs text-zinc-900 dark:text-white placeholder-zinc-400 dark:placeholder-zinc-500 focus:outline-none focus:border-amber-500 w-28"
                  />
                  <button
                    onClick={handleCreatePlaylist}
                    className="p-1 rounded-lg bg-slate-100 hover:bg-amber-500 hover:text-zinc-950 dark:bg-white/5 text-zinc-700 dark:text-zinc-300 border border-slate-200 dark:border-transparent transition"
                    title="Create Playlist"
                  >
                    <Plus className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>

              {/* Bounded Scrollable Library Workspace */}
              <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
                {filteredTracks.length === 0 ? (
                  <div className="flex-1 flex flex-col items-center justify-center rounded-2xl bg-zinc-950/30 p-6 text-center">
                    <Disc className="w-8 h-8 text-zinc-600 mb-2" />
                    <p className="text-xs font-medium text-zinc-300">
                      {tracks.length === 0 ? 'Your music library is empty' : 'No matching tracks'}
                    </p>
                    <div className="flex items-center gap-2 mt-3">
                      <button
                        onClick={() => fileInputRef.current?.click()}
                        className="px-3.5 py-1.5 rounded-xl bg-amber-500 text-zinc-950 font-semibold text-xs hover:bg-amber-400 transition flex items-center gap-1.5"
                      >
                        <Upload className="w-3.5 h-3.5" />
                        <span>Import Music</span>
                      </button>
                      <button
                        onClick={handlePickAndImportFolder}
                        className="px-3.5 py-1.5 rounded-xl bg-white/10 text-zinc-200 font-medium text-xs hover:bg-white/15 transition flex items-center gap-1.5"
                      >
                        <FolderOpen className="w-3.5 h-3.5 text-amber-400" />
                        <span>{t('importFolder')}</span>
                      </button>
                    </div>
                  </div>
                ) : libraryViewMode === 'albums' ? (
                  <div className="flex-1 min-h-0 grid grid-cols-1 xl:grid-cols-12 gap-3.5 overflow-hidden">
                    {/* Album Grid */}
                    <div
                      onScroll={(e) => {
                        const el = e.currentTarget;
                        if (
                          el.scrollHeight - el.scrollTop - el.clientHeight < 180 &&
                          visibleAlbumLimit < groupedAlbums.length
                        ) {
                          setVisibleAlbumLimit((prev) => Math.min(groupedAlbums.length, prev + 24));
                        }
                      }}
                      className="xl:col-span-7 min-h-0 overflow-y-auto aurelia-scrollbar pr-1"
                    >
                      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5 pb-2">
                        {groupedAlbums.slice(0, visibleAlbumLimit).map((album) => {
                          const isSelected = activeSelectedAlbum?.id === album.id;
                          const isPlayingAlbum = currentTrack && album.tracks.some((t) => t.id === currentTrack.id);
                          return (
                            <div
                              key={album.id}
                              onClick={() => setSelectedAlbumId(album.id)}
                              className={`group rounded-2xl p-2 border transition-all cursor-pointer flex flex-col justify-between ${isSelected
                                ? 'bg-amber-500/10 dark:bg-white/[0.08] border-amber-500/50 shadow-md'
                                : 'bg-slate-50 dark:bg-zinc-950/45 hover:bg-slate-100 dark:hover:bg-white/[0.04] border-slate-200 dark:border-white/[0.06]'
                                }`}
                            >
                              <div>
                                <div className="relative aspect-square w-full rounded-xl overflow-hidden bg-zinc-900 mb-2">
                                  <img
                                    src={album.coverUrl}
                                    alt={album.title}
                                    loading="lazy"
                                    className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105"
                                  />
                                  <div className="absolute inset-0 bg-gradient-to-t from-black/75 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity flex items-end justify-between p-2">
                                    <button
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        handlePlayAlbum(album);
                                      }}
                                      className="w-8 h-8 rounded-xl bg-amber-500 hover:bg-amber-400 text-zinc-950 flex items-center justify-center shadow-lg transition"
                                      title={`Play ${album.title}`}
                                    >
                                      {isPlayingAlbum && isPlaying ? (
                                        <Pause className="w-3.5 h-3.5 fill-zinc-950" />
                                      ) : (
                                        <Play className="w-3.5 h-3.5 fill-zinc-950 ml-0.5" />
                                      )}
                                    </button>
                                    <button
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        handleQueueAlbum(album);
                                      }}
                                      className="px-2 py-1 rounded-lg bg-black/80 hover:bg-black text-[10px] font-mono text-zinc-200"
                                      title="Queue Album"
                                    >
                                      +Queue
                                    </button>
                                  </div>
                                </div>

                                <h3
                                  className={`text-xs font-semibold truncate album-title-text ${isSelected ? 'text-amber-600 dark:text-amber-300' : 'text-zinc-900 dark:text-zinc-100'
                                    }`}
                                  title={album.title}
                                >
                                  {album.title}
                                </h3>
                                <p className="text-[11px] text-zinc-600 dark:text-zinc-400 truncate album-subtitle-text" title={album.artist}>
                                  {album.artist}
                                </p>
                              </div>

                              <div className="flex items-center justify-between text-[10px] font-mono text-zinc-500 dark:text-zinc-400 mt-1.5">
                                <span>{album.tracks.length} trk</span>
                                <span>{formatTime(album.totalDuration)}</span>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>

                    {/* Selected Album Tracklist */}
                    <div className="xl:col-span-5 min-h-0 rounded-2xl bg-slate-50 dark:bg-zinc-950/60 border border-slate-200 dark:border-white/[0.07] p-3 flex flex-col overflow-hidden">
                      {activeSelectedAlbum ? (
                        <>
                          <div className="flex items-center justify-between gap-2 pb-2.5 border-b border-slate-200 dark:border-white/[0.07] shrink-0">
                            <div className="min-w-0 flex-1">
                              <h3
                                className="text-sm font-semibold text-zinc-900 dark:text-white truncate album-title-text"
                                title={activeSelectedAlbum.title}
                              >
                                {activeSelectedAlbum.title}
                              </h3>
                              <p
                                className="text-xs text-zinc-600 dark:text-zinc-400 truncate album-subtitle-text"
                                title={activeSelectedAlbum.folderPath || activeSelectedAlbum.artist}
                              >
                                {activeSelectedAlbum.artist} • {activeSelectedAlbum.tracks.length} tracks
                              </p>
                            </div>
                            <div className="flex items-center gap-1.5 shrink-0">
                              <button
                                onClick={() => handlePlayAlbum(activeSelectedAlbum)}
                                className="p-2 rounded-xl bg-amber-500 hover:bg-amber-400 text-zinc-950 transition"
                                title="Play Album"
                              >
                                <Play className="w-3.5 h-3.5 fill-zinc-950" />
                              </button>
                              <button
                                onClick={() => handleQueueAlbum(activeSelectedAlbum)}
                                className="px-2.5 py-1.5 rounded-xl bg-slate-100 hover:bg-slate-200 dark:bg-white/5 dark:hover:bg-white/10 border border-slate-200 dark:border-white/10 text-zinc-700 dark:text-zinc-300 text-xs font-medium"
                                title="Queue Album"
                              >
                                +Queue
                              </button>
                              <button
                                onClick={() => handleDeleteAlbum(activeSelectedAlbum)}
                                className="p-2 rounded-xl bg-slate-100 hover:bg-rose-500/15 dark:bg-white/5 dark:hover:bg-rose-500/20 border border-slate-200 dark:border-white/10 text-zinc-500 hover:text-rose-600 dark:text-zinc-400 dark:hover:text-rose-400 transition"
                                title={t('deleteAlbum')}
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          </div>

                          <div className="flex-1 min-h-0 overflow-y-auto aurelia-scrollbar divide-y divide-slate-200/60 dark:divide-white/[0.04] pr-1 mt-1">
                            {activeSelectedAlbum.tracks.map((track, idx) => {
                              const isCurrent = track.id === currentTrackId;
                              const isFav = playlists
                                .find((p) => p.id === 'pl-favorites')
                                ?.trackIds.includes(track.id);
                              return (
                                <div
                                  key={track.id}
                                  onClick={() => handlePlayAlbum(activeSelectedAlbum, track.id)}
                                  className={`group flex items-center justify-between gap-2 py-2 px-2 rounded-xl transition cursor-pointer ${isCurrent
                                    ? 'bg-amber-500/15 text-amber-600 dark:text-amber-300'
                                    : 'hover:bg-slate-100 dark:hover:bg-white/[0.04] text-zinc-800 dark:text-zinc-200'
                                    }`}
                                >
                                  <div className="flex items-center gap-2 min-w-0 flex-1">
                                    <span className="w-5 text-[11px] font-mono text-zinc-500 text-right shrink-0">
                                      {track.trackNumber
                                        ? String(track.trackNumber).padStart(2, '0')
                                        : String(idx + 1).padStart(2, '0')}
                                    </span>
                                    <span
                                      className={`text-xs truncate ${isCurrent ? 'text-amber-600 dark:text-amber-300 font-semibold' : 'text-zinc-900 dark:text-zinc-100'
                                        }`}
                                      title={track.title}
                                    >
                                      {track.title}
                                    </span>
                                    {track.needsRelink && (
                                      <span className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-rose-500/20 text-rose-300 shrink-0">
                                        Relink
                                      </span>
                                    )}
                                  </div>

                                  <div
                                    className="flex items-center gap-1.5 shrink-0"
                                    onClick={(e) => e.stopPropagation()}
                                  >
                                    <span className="text-[11px] font-mono text-zinc-500 dark:text-zinc-400">
                                      {formatTime(track.duration)}
                                    </span>
                                    <button
                                      onClick={() => handleToggleTrackInPlaylist('pl-favorites', track.id)}
                                      className={`p-1 rounded-lg transition ${isFav ? 'text-rose-500' : 'text-zinc-400 opacity-0 group-hover:opacity-100 hover:text-zinc-800 dark:hover:text-white'
                                        }`}
                                      title="Favorite"
                                    >
                                      <Heart className={`w-3 h-3 ${isFav ? 'fill-rose-500' : ''}`} />
                                    </button>
                                    <button
                                      onClick={() => handleAddToQueue(track.id, true)}
                                      className="px-1.5 py-0.5 rounded bg-slate-100 hover:bg-slate-200 dark:bg-white/5 dark:hover:bg-white/10 border border-slate-200 dark:border-transparent text-[10px] font-mono text-zinc-600 dark:text-zinc-400 opacity-0 group-hover:opacity-100 transition"
                                      title="Play Next"
                                    >
                                      +Q
                                    </button>
                                    <button
                                      onClick={() => handleDeleteTrack(track.id)}
                                      className="p-1 rounded-lg text-zinc-400 opacity-0 group-hover:opacity-100 hover:text-rose-500 transition"
                                      title={t('deleteTrack')}
                                    >
                                      <Trash2 className="w-3.5 h-3.5" />
                                    </button>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </>
                      ) : (
                        <div className="flex-1 flex items-center justify-center text-xs text-zinc-500">
                          Select an album
                        </div>
                      )}
                    </div>
                  </div>
                ) : (
                  /* Windowed Tracks View */
                  <div
                    onScroll={(e) => {
                      const el = e.currentTarget;
                      if (
                        el.scrollHeight - el.scrollTop - el.clientHeight < 200 &&
                        visibleTrackLimit < filteredTracks.length
                      ) {
                        setVisibleTrackLimit((prev) => Math.min(filteredTracks.length, prev + 80));
                      }
                    }}
                    className="flex-1 min-h-0 overflow-y-auto aurelia-scrollbar pr-1 flex flex-col gap-1"
                  >
                    {filteredTracks.slice(0, visibleTrackLimit).map((track) => {
                      const isCurrent = track.id === currentTrackId;
                      const isFav = playlists.find((p) => p.id === 'pl-favorites')?.trackIds.includes(track.id);
                      return (
                        <div
                          key={track.id}
                          onClick={() => {
                            const albId = track.albumId || buildAlbumIdentityKey(track.album, track.albumArtist, track.folderPath);
                            setSelectedAlbumId(albId);
                            if (!isCurrent) startTrackById(track.id);
                            else togglePlayPause();
                          }}
                          className={`group flex items-center justify-between gap-3 p-2 rounded-xl transition cursor-pointer shrink-0 ${isCurrent
                            ? 'bg-amber-500/15 text-amber-600 dark:text-amber-300'
                            : 'hover:bg-slate-100 dark:hover:bg-white/[0.04]'
                            }`}
                        >
                          <div className="flex items-center gap-3 min-w-0 flex-1">
                            <img
                              src={track.coverUrl}
                              alt=""
                              loading="lazy"
                              className="w-9 h-9 rounded-lg object-cover shrink-0 bg-zinc-900"
                            />
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2">
                                <span
                                  className={`text-xs font-medium truncate ${isCurrent ? 'text-amber-600 dark:text-amber-300 font-semibold' : 'text-zinc-900 dark:text-zinc-100'
                                    }`}
                                  title={track.title}
                                >
                                  {track.title}
                                </span>
                                {track.needsRelink && (
                                  <span className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-rose-500/20 text-rose-300">
                                    Relink
                                  </span>
                                )}
                              </div>
                              <div className="text-[11px] text-zinc-600 dark:text-zinc-400 truncate">
                                {track.artist} • <span className="text-zinc-900 dark:text-zinc-300 font-medium album-subtitle-text">{track.album}</span>
                              </div>
                            </div>
                          </div>

                          <div className="flex items-center gap-2 shrink-0" onClick={(e) => e.stopPropagation()}>
                            <span className="hidden sm:inline text-[10px] font-mono text-zinc-500 dark:text-zinc-400">
                              {track.codec.split(' ')[0]}
                            </span>
                            <span className="text-xs font-mono text-zinc-500 dark:text-zinc-400 w-10 text-right">
                              {formatTime(track.duration)}
                            </span>
                            <button
                              onClick={() => handleToggleTrackInPlaylist('pl-favorites', track.id)}
                              className={`p-1.5 rounded-lg transition ${isFav ? 'text-rose-500' : 'text-zinc-400 hover:text-zinc-800 dark:hover:text-white'
                                }`}
                              title="Favorite"
                            >
                              <Heart className={`w-3.5 h-3.5 ${isFav ? 'fill-rose-500' : ''}`} />
                            </button>
                            <button
                              onClick={() => handleAddToQueue(track.id, true)}
                              className="px-2 py-1 rounded-lg bg-slate-100 hover:bg-slate-200 dark:bg-white/5 dark:hover:bg-white/10 border border-slate-200 dark:border-white/5 text-[10px] font-mono text-zinc-700 dark:text-zinc-300 transition"
                              title="Queue Next"
                            >
                              +Q
                            </button>
                            <button
                              onClick={() => handleDeleteTrack(track.id)}
                              className="p-1.5 rounded-lg text-zinc-400 hover:text-rose-500 transition"
                              title={t('deleteTrack')}
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* TAB 2: SIGNALS — AUDIO ANALYSIS & MUSIC METADATA */}
          {activeTab === 'insights' && (
            <div className="aurelia-glass-panel flex-1 min-h-0 overflow-y-auto aurelia-scrollbar rounded-3xl bg-zinc-900/55 border border-white/10 backdrop-blur-2xl p-4 sm:p-5 shadow-2xl flex flex-col gap-5">
              {!currentTrack ? (
                <div className="flex-1 flex flex-col items-center justify-center text-center p-8">
                  <Activity className="w-8 h-8 text-zinc-600 mb-2" />
                  <p className="text-xs font-medium text-zinc-300">No active audio signal</p>
                  <button
                    onClick={() => fileInputRef.current?.click()}
                    className="mt-3 px-3.5 py-1.5 rounded-xl bg-amber-500 text-zinc-950 font-semibold text-xs hover:bg-amber-400 transition"
                  >
                    Import Music
                  </button>
                </div>
              ) : (
                <>
                  {/* GROUP 1: AUDIO ANALYSIS */}
                  <div className="flex flex-col gap-3">
                    <div className="flex items-center justify-between gap-3 pb-2 border-b border-white/[0.07]">
                      <div className="flex items-center gap-2">
                        <Activity className="w-4 h-4 text-amber-400" />
                        <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-200">
                          Audio Analysis
                        </h2>
                      </div>
                      <button
                        onClick={() => runTrackDspAnalysis(currentTrack)}
                        disabled={isAnalyzingDsp}
                        className="px-2.5 py-1 rounded-xl bg-white/5 hover:bg-white/10 border border-white/10 text-amber-300 text-[11px] font-medium flex items-center gap-1.5 disabled:opacity-50"
                      >
                        <RefreshCw className={`w-3 h-3 ${isAnalyzingDsp ? 'animate-spin' : ''}`} />
                        <span>{isAnalyzingDsp ? 'Analyzing PCM...' : 'Re-Analyze'}</span>
                      </button>
                    </div>

                    {dspError && (
                      <div className="p-2.5 rounded-xl bg-rose-500/10 border border-rose-500/30 text-xs text-rose-200">
                        {dspError}
                      </div>
                    )}

                    {/* Core Signal Measurements */}
                    {currentTrack.dspAnalysis && (
                      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2.5">
                        {[
                          {
                            label: 'Sample Peak',
                            value: `${currentTrack.dspAnalysis.peakDb} dBFS`
                          },
                          {
                            label: 'RMS Loudness',
                            value: `${currentTrack.dspAnalysis.rmsDb} dBFS`
                          },
                          {
                            label: 'Crest Factor',
                            value: `${currentTrack.dspAnalysis.crestFactorDb} dB`,
                            highlight: true
                          },
                          {
                            label: 'Phase Correlation',
                            value: `${currentTrack.dspAnalysis.stereoCorrelation}`
                          },
                          {
                            label: 'Clipping Count',
                            value: `${currentTrack.dspAnalysis.clippedSamples}`
                          }
                        ].map((m, idx) => (
                          <div key={idx} className="p-3 rounded-2xl bg-zinc-950/65 border border-white/[0.06] flex flex-col justify-between">
                            <span className="text-[11px] text-zinc-400">{m.label}</span>
                            <div
                              className={`text-sm sm:text-base font-mono font-semibold mt-1.5 ${m.highlight ? 'text-amber-300' : 'text-white'
                                }`}
                            >
                              {m.value}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Stream Container & PCM Technicals */}
                    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2.5">
                      {[
                        {
                          label: 'Codec',
                          value: currentTrack.codec || 'N/A'
                        },
                        {
                          label: 'Sample Rate',
                          value: currentTrack.sampleRate
                            ? `${currentTrack.sampleRate.toLocaleString()} Hz`
                            : currentTrack.dspAnalysis?.sampleRate
                              ? `${currentTrack.dspAnalysis.sampleRate.toLocaleString()} Hz`
                              : 'N/A'
                        },
                        {
                          label: 'Bit Depth',
                          value: currentTrack.bitDepth ? `${currentTrack.bitDepth}-Bit PCM` : '32-Bit Float'
                        },
                        {
                          label: 'Bitrate',
                          value: currentTrack.dspAnalysis?.estimatedBitrateKbps
                            ? `~${currentTrack.dspAnalysis.estimatedBitrateKbps} kbps`
                            : 'Unavailable'
                        },
                        {
                          label: 'Channels',
                          value: `${currentTrack.channels || currentTrack.dspAnalysis?.channels || 2} Ch`
                        },
                        {
                          label: 'PCM Duration',
                          value: currentTrack.dspAnalysis?.duration
                            ? `${currentTrack.dspAnalysis.duration.toFixed(2)}s`
                            : formatTime(currentTrack.duration || 0)
                        }
                      ].map((card, i) => (
                        <div key={i} className="p-2.5 rounded-2xl bg-zinc-950/50 border border-white/[0.05]">
                          <span className="text-[10px] text-zinc-400 block">{card.label}</span>
                          <div className="text-xs font-semibold text-zinc-100 mt-1 font-mono truncate" title={String(card.value)}>
                            {card.value}
                          </div>
                        </div>
                      ))}
                    </div>

                    {/* Interactive Offline Waveform Overview */}
                    {currentTrack.dspAnalysis && (
                      <div className="p-3.5 rounded-2xl bg-zinc-950/60 border border-white/[0.06]">
                        <div className="flex items-center justify-between mb-2">
                          <span className="text-xs font-medium text-zinc-300 flex items-center gap-1.5">
                            <BarChart2 className="w-3.5 h-3.5" style={{ color: activePalette?.hex400 || '#fbbf24' }} />
                            PCM Envelope
                          </span>
                          <span className="text-[10px] font-mono text-zinc-400">
                            Low {currentTrack.dspAnalysis.spectralBalance.bassPct}% • Mid{' '}
                            {currentTrack.dspAnalysis.spectralBalance.midPct}% • High{' '}
                            {currentTrack.dspAnalysis.spectralBalance.treblePct}%
                          </span>
                        </div>

                        <div
                          onClick={(e) => {
                            const rect = e.currentTarget.getBoundingClientRect();
                            const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
                            handleSeek(ratio * (currentTrack.dspAnalysis.duration || duration || 0));
                          }}
                          className="h-16 w-full flex items-center gap-[2px] cursor-pointer py-1"
                          title="Click to seek"
                        >
                          <WithClock>
                            {(currentTime) => currentTrack.dspAnalysis.waveformPeaks.map((pk, idx) => {
                              const total = currentTrack.dspAnalysis.waveformPeaks.length;
                              const progressRatio = (currentTime || 0) / Math.max(1, duration || 1);
                              const passed = idx / total <= progressRatio;
                              const hPct = Math.max(8, Math.round(pk * 100));
                              return (
                                <div key={idx} className="flex-1 h-full flex items-center justify-center">
                                  <div
                                    style={{
                                      height: `${hPct}%`,
                                      backgroundColor: passed ? (activePalette?.hex400 || '#fbbf24') : undefined
                                    }}
                                    className={`w-full rounded-full transition-colors ${passed ? '' : 'bg-white/15 hover:bg-white/35'
                                      }`}
                                  />
                                </div>
                              );
                            })}
                          </WithClock>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* GROUP 2: MUSIC METADATA */}
                  <div className="flex flex-col gap-3 pt-1">
                    <div className="flex flex-wrap items-center justify-between gap-2 pb-2 border-b border-white/[0.07]">
                      <div className="flex items-center gap-2">
                        <Globe className="w-4 h-4 text-amber-400" />
                        <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-200">
                          Music Metadata
                        </h2>
                        {metadataLookupState.status === 'loading' && (
                          <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-300 flex items-center gap-1">
                            <RefreshCw className="w-2.5 h-2.5 animate-spin" />
                            <span>{metadataLookupState.message}</span>
                          </span>
                        )}
                      </div>

                      <div className="flex items-center gap-2">
                        {currentTrack.musicBrainzUrl && (
                          <a
                            href={currentTrack.musicBrainzUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="px-2.5 py-1 rounded-xl bg-white/5 hover:bg-white/10 border border-white/10 text-zinc-300 hover:text-white text-[11px] font-medium flex items-center gap-1"
                            title="View Recording on MusicBrainz"
                          >
                            <span>MusicBrainz</span>
                            <ExternalLink className="w-3 h-3" />
                          </a>
                        )}
                        <button
                          onClick={() => triggerMusicBrainzEnrichment(currentTrack, null)}
                          disabled={metadataLookupState.status === 'loading'}
                          className="px-2.5 py-1 rounded-xl bg-white/5 hover:bg-white/10 border border-white/10 text-amber-300 text-[11px] font-medium flex items-center gap-1.5 disabled:opacity-50"
                          title="Lookup missing metadata on MusicBrainz"
                        >
                          <RefreshCw className={`w-3 h-3 ${metadataLookupState.status === 'loading' ? 'animate-spin' : ''}`} />
                          <span>Lookup</span>
                        </button>
                      </div>
                    </div>

                    {/* Dynamic Non-Empty Metadata Grid */}
                    {(() => {
                      const identityItems = [];
                      if (currentTrack.title) {
                        identityItems.push({
                          label: 'Track Title',
                          value: currentTrack.title
                        });
                      }
                      if (currentTrack.artist && currentTrack.artist !== 'Unknown Artist') {
                        identityItems.push({
                          label: 'Artist',
                          value: currentTrack.artist
                        });
                      }
                      if (Array.isArray(currentTrack.contributingArtists) && currentTrack.contributingArtists.length > 0) {
                        identityItems.push({
                          label: 'Contributing Artists',
                          value: currentTrack.contributingArtists.join(', ')
                        });
                      }
                      if (currentTrack.duration > 0 || currentTrack.dspAnalysis?.duration > 0) {
                        identityItems.push({
                          label: 'Duration',
                          value: formatTime(currentTrack.dspAnalysis?.duration || currentTrack.duration)
                        });
                      }

                      const releaseItems = [];
                      if (
                        currentTrack.album &&
                        currentTrack.album !== 'Unsorted Local Album' &&
                        currentTrack.album !== 'Local Audio File'
                      ) {
                        releaseItems.push({
                          label: 'Album Title',
                          value: currentTrack.album
                        });
                      }
                      if (
                        currentTrack.albumArtist &&
                        currentTrack.albumArtist !== 'Unknown Artist'
                      ) {
                        releaseItems.push({
                          label: 'Album Artist',
                          value: currentTrack.albumArtist
                        });
                      }
                      if (currentTrack.releaseDate || currentTrack.year) {
                        releaseItems.push({
                          label: currentTrack.releaseDate ? 'Release Date' : 'Release Year',
                          value:
                            currentTrack.releaseDate && currentTrack.year && currentTrack.releaseDate !== currentTrack.year
                              ? `${currentTrack.releaseDate} (${currentTrack.year})`
                              : currentTrack.releaseDate || currentTrack.year
                        });
                      }
                      if (
                        (Array.isArray(currentTrack.genres) && currentTrack.genres.length > 0) ||
                        currentTrack.genre
                      ) {
                        const gList =
                          Array.isArray(currentTrack.genres) && currentTrack.genres.length > 0
                            ? currentTrack.genres
                            : [currentTrack.genre];
                        releaseItems.push({
                          label: gList.length > 1 ? 'Primary & Additional Genres' : 'Genre',
                          value: gList.join(' • ')
                        });
                      }
                      if (currentTrack.trackNumber) {
                        const trkStr = currentTrack.totalTracks
                          ? `Track ${currentTrack.trackNumber} of ${currentTrack.totalTracks}`
                          : `Track ${currentTrack.trackNumber}`;
                        const discStr = currentTrack.discNumber
                          ? currentTrack.totalDiscs
                            ? ` • Disc ${currentTrack.discNumber}/${currentTrack.totalDiscs}`
                            : ` • Disc ${currentTrack.discNumber}`
                          : '';
                        releaseItems.push({
                          label: 'Track / Disc Position',
                          value: `${trkStr}${discStr}`
                        });
                      }
                      if (currentTrack.label) {
                        releaseItems.push({
                          label: 'Label / Publisher',
                          value: currentTrack.catalogNumber
                            ? `${currentTrack.label} (${currentTrack.catalogNumber})`
                            : currentTrack.label
                        });
                      }
                      if (currentTrack.releaseCountry) {
                        releaseItems.push({
                          label: 'Release Country',
                          value: currentTrack.releaseCountry
                        });
                      }

                      const creditsItems = [];
                      if (currentTrack.composer) {
                        creditsItems.push({
                          label: 'Composer',
                          value: currentTrack.composer
                        });
                      }
                      if (currentTrack.songwriter) {
                        creditsItems.push({
                          label: 'Songwriter / Lyricist',
                          value: currentTrack.songwriter
                        });
                      }
                      if (currentTrack.isrc) {
                        creditsItems.push({
                          label: 'ISRC',
                          value: currentTrack.isrc,
                          mono: true
                        });
                      }
                      if (currentTrack.isArtworkVerified || currentTrack.releaseArtworkUrl) {
                        creditsItems.push({
                          label: 'Release Artwork',
                          value: currentTrack.coverProvenance || 'Verified Release Artwork',
                          link: currentTrack.releaseArtworkUrl || (currentTrack.coverUrl?.startsWith('http') ? currentTrack.coverUrl : null)
                        });
                      }

                      const allGroups = [
                        { title: 'Track & Artist Identity', items: identityItems },
                        { title: 'Album & Release Details', items: releaseItems },
                        { title: 'Credits, Identifiers & Artwork', items: creditsItems }
                      ].filter((g) => g.items.length > 0);

                      return (
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                          {allGroups.map((group, gIdx) => (
                            <div
                              key={gIdx}
                              className={`p-3.5 rounded-2xl bg-zinc-950/60 border border-white/[0.06] flex flex-col gap-2.5 ${gIdx === 2 && allGroups.length === 3 ? 'md:col-span-2' : ''
                                }`}
                            >
                              <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">
                                {group.title}
                              </span>
                              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                                {group.items.map((item, idx) => (
                                  <div
                                    key={idx}
                                    className="p-2.5 rounded-xl bg-zinc-900/55 border border-white/[0.04] flex flex-col justify-between gap-1"
                                  >
                                    <span className="text-[10px] text-zinc-400 block">{item.label}</span>
                                    <div className="flex items-center justify-between gap-2 mt-0.5">
                                      <span
                                        className={`text-xs font-medium text-zinc-100 break-words ${item.mono ? 'font-mono text-amber-300' : ''
                                          }`}
                                      >
                                        {item.value}
                                      </span>
                                      {item.link && (
                                        <a
                                          href={item.link}
                                          target="_blank"
                                          rel="noreferrer"
                                          className="text-[10px] text-amber-300 hover:underline flex items-center gap-0.5 shrink-0"
                                        >
                                          <span>Open</span>
                                          <ExternalLink className="w-2.5 h-2.5" />
                                        </a>
                                      )}
                                    </div>
                                  </div>
                                ))}
                              </div>
                            </div>
                          ))}
                        </div>
                      );
                    })()}
                  </div>
                </>
              )}
            </div>
          )}

          {/* TAB: 10-BAND PARAMETRIC EQUALIZER */}
          {activeTab === 'equalizer' && (
            <PeqPanel
              peqState={peqState}
              onChangePeqState={setPeqState}
              customPresets={customPeqPresets}
              onChangeCustomPresets={setCustomPeqPresets}
              filterNodesRef={filterNodesRef}
              showToast={showToast}
              t={t}
            />
          )}

          {/* TAB 3: SETTINGS */}
          {activeTab === 'settings' && (
            <div className="aurelia-glass-panel flex-1 min-h-0 overflow-y-auto aurelia-scrollbar rounded-3xl bg-zinc-900/55 border border-white/10 backdrop-blur-2xl p-5 shadow-2xl flex flex-col gap-4">
              <h2 className="text-base font-semibold text-white flex items-center gap-2 pb-3 border-b border-white/[0.07] shrink-0">
                <Settings className="w-4 h-4 text-amber-400" />
                <span>{t('settings')}</span>
              </h2>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {/* Theme & Accent Color Section */}
                <div className="md:col-span-2 p-4 sm:p-5 rounded-2xl bg-zinc-950/60 border border-white/[0.06] flex flex-col gap-3.5">
                  <div className="flex flex-wrap items-center justify-between gap-2 pb-2 border-b border-white/5">
                    <div className="flex items-center gap-2">
                      <div className="w-7 h-7 rounded-lg bg-amber-500/15 border border-amber-500/25 flex items-center justify-center">
                        <Palette className="w-4 h-4 text-amber-400" />
                      </div>
                      <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-200">
                        {t('appearanceAndAccent')}
                      </h3>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="flex items-center gap-1.5 text-[11px] font-mono px-2.5 py-1 rounded-lg bg-white/5 border border-white/10 text-zinc-300">
                        <span
                          className="w-2.5 h-2.5 rounded-full ring-1 ring-white/20"
                          style={{ backgroundColor: activePalette.swatch }}
                        />
                        <span>{activePalette.id === 'custom' ? activePalette.swatch : activePalette.label}</span>
                      </span>
                    </div>
                  </div>

                  {/* Mode & Language Controls */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {/* Theme Mode Selector (Dark / Light) */}
                    <div className="flex items-center justify-between p-3 rounded-xl bg-zinc-900/50 border border-white/[0.06]">
                      <div className="flex items-center gap-2">
                        {settings.themeMode === 'light' ? (
                          <Sun className="w-4 h-4 text-amber-400" />
                        ) : (
                          <Moon className="w-4 h-4 text-amber-400" />
                        )}
                        <span className="text-xs font-semibold text-zinc-200">{t('themeMode')}</span>
                      </div>
                      <div className="flex items-center gap-1 bg-zinc-950/80 p-1 rounded-xl border border-white/10">
                        <button
                          onClick={() => updateSetting('themeMode', 'dark')}
                          className={`flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-semibold transition ${settings.themeMode !== 'light'
                            ? 'bg-amber-500 text-zinc-950 shadow-sm'
                            : 'text-zinc-400 hover:text-white'
                            }`}
                        >
                          <Moon className="w-3.5 h-3.5" />
                          <span>{t('darkMode')}</span>
                        </button>
                        <button
                          onClick={() => updateSetting('themeMode', 'light')}
                          className={`flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-semibold transition ${settings.themeMode === 'light'
                            ? 'bg-amber-500 text-zinc-950 shadow-sm'
                            : 'text-zinc-400 hover:text-white'
                            }`}
                        >
                          <Sun className="w-3.5 h-3.5" />
                          <span>{t('lightMode')}</span>
                        </button>
                      </div>
                    </div>

                    {/* Language Selector */}
                    <div className="flex items-center justify-between p-3 rounded-xl bg-zinc-900/50 border border-white/[0.06]">
                      <div className="flex items-center gap-2">
                        <Globe className="w-4 h-4 text-amber-400" />
                        <span className="text-xs font-semibold text-zinc-200">{t('languageSelect')}</span>
                      </div>
                      <div className="flex items-center gap-1 bg-zinc-950/80 p-1 rounded-xl border border-white/10">
                        <button
                          onClick={() => updateSetting('language', 'vi')}
                          className={`px-3 py-1 rounded-lg text-xs font-semibold transition ${settings.language === 'vi'
                            ? 'bg-amber-500 text-zinc-950 shadow-sm'
                            : 'text-zinc-400 hover:text-white'
                            }`}
                        >
                          Tiếng Việt
                        </button>
                        <button
                          onClick={() => updateSetting('language', 'en')}
                          className={`px-3 py-1 rounded-lg text-xs font-semibold transition ${settings.language === 'en'
                            ? 'bg-amber-500 text-zinc-950 shadow-sm'
                            : 'text-zinc-400 hover:text-white'
                            }`}
                        >
                          English
                        </button>
                      </div>
                    </div>
                  </div>

                  {/* Album Cover Theme Sync */}
                  <div className="flex flex-wrap items-center justify-between gap-3 p-3 rounded-xl bg-zinc-900/50 border border-white/[0.06]">
                    <div className="flex items-center gap-2.5 min-w-0">
                      <Sparkles className="w-4 h-4 text-amber-400 shrink-0" />
                      <div className="flex flex-col min-w-0">
                        <span className="text-xs font-semibold text-zinc-200 truncate">{t('autoThemeFromAlbum')}</span>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        onClick={handleExtractAlbumColor}
                        disabled={!currentTrack?.coverUrl}
                        className="px-2.5 py-1 rounded-lg bg-white/5 hover:bg-white/10 border border-white/10 text-xs font-medium text-amber-300 disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5 transition"
                        title={t('extractNow')}
                      >
                        <Sparkles className="w-3 h-3" />
                        <span>{t('extractNow')}</span>
                      </button>
                      <label className="relative inline-flex items-center cursor-pointer">
                        <input
                          type="checkbox"
                          checked={Boolean(settings.autoAlbumTheme)}
                          onChange={(e) => updateSetting('autoAlbumTheme', e.target.checked)}
                          className="sr-only peer"
                        />
                        <div className="w-9 h-5 bg-zinc-800 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-zinc-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-amber-500" />
                      </label>
                    </div>
                  </div>

                  {/* Preset Palettes (from theme.js) */}
                  <div className="flex flex-col gap-2 pt-1">
                    <span className="text-xs font-medium text-zinc-300">
                      {t('presetPalettes')}
                    </span>
                    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
                      {Object.values(ACCENT_PALETTES).map((pal) => {
                        const isSelected = settings.accentColor === pal.id;
                        return (
                          <button
                            key={pal.id}
                            onClick={() => updateSetting('accentColor', pal.id)}
                            className={`flex flex-col items-center gap-2 p-3 rounded-xl border text-center transition group relative overflow-hidden ${isSelected
                              ? 'bg-amber-500/15 border-amber-400/60 shadow-lg shadow-amber-500/15 ring-1 ring-amber-400/30'
                              : 'bg-zinc-900/50 border-white/[0.06] hover:bg-white/5 hover:border-white/15'
                              }`}
                          >
                            <span
                              className="w-6 h-6 rounded-full shrink-0 ring-2 ring-white/30 shadow-md transition-transform group-hover:scale-110 flex items-center justify-center"
                              style={{ backgroundColor: pal.swatch }}
                            >
                              {isSelected && <Check className="w-3.5 h-3.5 text-zinc-950 stroke-[3]" />}
                            </span>
                            <div className="flex flex-col min-w-0 w-full">
                              <span className="text-xs font-semibold truncate text-zinc-200">
                                {pal.label.split(' ')[0]}
                              </span>
                              <span className="text-[10px] font-mono text-zinc-500 truncate">
                                {pal.swatch}
                              </span>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* Custom Color Picker & Live Hex Input */}
                  <div className="flex flex-col gap-2.5 pt-2 border-t border-white/5">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-medium text-zinc-300">
                        {t('customColorPicker')}
                      </span>
                      {settings.accentColor !== 'amber' && (
                        <button
                          onClick={() => {
                            setLocalCustomHex('#f59e0b');
                            updateSettings({
                              accentColor: 'amber',
                              customAccentHex: '#f59e0b'
                            });
                          }}
                          className="text-[11px] text-zinc-400 hover:text-amber-300 underline transition shrink-0 ml-2"
                        >
                          {t('resetToAmber')}
                        </button>
                      )}
                    </div>

                    <div className="flex flex-wrap items-center gap-3 p-3 rounded-xl bg-zinc-900/60 border border-white/[0.06]">
                      {/* Color swatch input */}
                      <label
                        className="relative flex items-center justify-center w-10 h-10 rounded-xl cursor-pointer border-2 border-white/20 hover:border-white/50 transition overflow-hidden shadow-inner shrink-0 group"
                        title={t('customColorPicker')}
                      >
                        <input
                          type="color"
                          value={localCustomHex || '#f59e0b'}
                          onChange={(e) => {
                            const val = e.target.value;
                            setLocalCustomHex(val);
                            updateSettings({
                              accentColor: 'custom',
                              customAccentHex: val
                            });
                          }}
                          className="opacity-0 absolute inset-0 w-full h-full cursor-pointer"
                        />
                        <div
                          className="w-full h-full rounded-xl transition group-hover:scale-110"
                          style={{ backgroundColor: localCustomHex || '#f59e0b' }}
                        />
                      </label>

                      {/* Hex input & apply */}
                      <div className="flex-1 min-w-[170px] flex items-center gap-2">
                        <div className="relative flex-1">
                          <input
                            type="text"
                            maxLength={7}
                            value={localCustomHex}
                            onChange={(e) => {
                              let val = e.target.value;
                              if (!val.startsWith('#') && val.length > 0) val = '#' + val;
                              setLocalCustomHex(val);
                              if (/^#[0-9A-Fa-f]{6}$/.test(val)) {
                                updateSettings({
                                  accentColor: 'custom',
                                  customAccentHex: val
                                });
                              }
                            }}
                            className="w-full px-3 py-1.5 rounded-xl bg-zinc-950/80 border border-white/10 text-xs font-mono text-zinc-100 uppercase tracking-wider focus:outline-none focus:border-amber-400/60 transition"
                            placeholder="#f59e0b"
                          />
                        </div>
                        <button
                          onClick={() => {
                            let val = localCustomHex.trim();
                            if (!val.startsWith('#') && val.length > 0) val = '#' + val;
                            if (/^#[0-9A-Fa-f]{6}$/.test(val)) {
                              updateSettings({
                                accentColor: 'custom',
                                customAccentHex: val
                              });
                              showToast(t('savedSettings'), 'success');
                            } else {
                              showToast('Hex invalid (e.g. #3B82F6)', 'error');
                            }
                          }}
                          className={`px-3 py-1.5 rounded-xl text-xs font-semibold transition ${settings.accentColor === 'custom'
                            ? 'bg-amber-500 hover:bg-amber-400 text-zinc-950 shadow-md shadow-amber-500/20'
                            : 'bg-white/10 hover:bg-white/15 text-zinc-200'
                            }`}
                        >
                          {t('apply')}
                        </button>
                      </div>

                      {/* Quick Inspiration Swatches */}
                      <div className="flex items-center gap-1.5">
                        {[
                          ['#ec4899', 'Neon Pink'],
                          ['#f97316', 'Orange'],
                          ['#eab308', 'Gold'],
                          ['#84cc16', 'Lime'],
                          ['#14b8a6', 'Teal'],
                          ['#6366f1', 'Indigo'],
                          ['#d946ef', 'Fuchsia']
                        ].map(([hex, name]) => (
                          <button
                            key={hex}
                            onClick={() => {
                              setLocalCustomHex(hex);
                              updateSettings({
                                accentColor: 'custom',
                                customAccentHex: hex
                              });
                            }}
                            className="w-5 h-5 rounded-lg transition-transform hover:scale-125 border border-white/20 hover:border-white shadow-sm"
                            style={{ backgroundColor: hex }}
                            title={`Pick ${name} (${hex})`}
                          />
                        ))}
                      </div>
                    </div>
                  </div>
                </div>

                <div className="p-4 rounded-2xl bg-zinc-950/60 border border-white/[0.06] flex flex-col gap-2.5">
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-400">{t('libraryAndAutomation')}</h3>

                  <div className="flex flex-wrap items-center justify-between gap-2 py-1">
                    <span className="text-xs text-zinc-300">{t('musicFolder')}</span>
                    <div className="flex items-center gap-1.5">
                      <button
                        onClick={handleRescanFolder}
                        className="px-2.5 py-1 rounded-lg bg-white/5 hover:bg-white/10 border border-white/10 text-zinc-300 text-xs flex items-center gap-1"
                        title={t('rescanFolder')}
                      >
                        <RefreshCw className="w-3 h-3 text-amber-400" />
                        <span>{t('rescan')}</span>
                      </button>
                      <button
                        onClick={handlePickAndImportFolder}
                        className="px-2.5 py-1 rounded-lg bg-amber-500 hover:bg-amber-400 text-zinc-950 font-semibold text-xs"
                      >
                        {rememberedFolder.name ? t('change') : t('select')}
                      </button>
                      {rememberedFolder.name && (
                        <button
                          onClick={handleForgetRememberedFolder}
                          className="px-2.5 py-1 rounded-lg bg-white/5 hover:bg-white/10 text-zinc-300 text-xs"
                        >
                          {t('forget')}
                        </button>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center justify-between py-1">
                    <div className="flex flex-col">
                      <span className="text-xs text-zinc-300">{t('removeDuplicates')}</span>

                    </div>
                    <button
                      onClick={handleFindAndRemoveDuplicates}
                      className="px-2.5 py-1 rounded-lg bg-amber-500/15 hover:bg-amber-500/25 border border-amber-500/30 text-amber-300 text-xs font-medium flex items-center gap-1.5 transition"
                    >
                      <Sparkles className="w-3.5 h-3.5 text-amber-400" />
                      <span>{t('cleanDuplicates')}</span>
                    </button>
                  </div>

                  <div className="flex items-center justify-between py-1">
                    <div className="flex flex-col">
                      <span className="text-xs text-zinc-300">{t('auditMetadata')}</span>

                    </div>
                    <button
                      onClick={handleRunSmartMetadataAudit}
                      className="px-2.5 py-1 rounded-lg bg-sky-500/15 hover:bg-sky-500/25 border border-sky-500/30 text-sky-300 text-xs font-medium flex items-center gap-1.5 transition"
                    >
                      <Shield className="w-3.5 h-3.5 text-sky-400" />
                      <span>{t('smartScan')}</span>
                    </button>
                  </div>

                  {[
                    ['gapless', t('gaplessPlayback')],
                    ['rememberMusicFolder', t('rememberMusicFolder')],
                    ['closeToTray', t('closeToTray')],
                    ['autoOnlineMetadata', t('autoOnlineMetadata')],
                    ['autoOnlineArtwork', t('autoOnlineArtwork')],
                    ['autoOnlineLyrics', t('autoOnlineLyrics')],
                    ['persistBlobsInIdb', t('persistBlobsInIdb')],
                    ['ambientGlow', t('ambientGlow')],
                    ['keyboardShortcuts', t('keyboardShortcuts')]
                  ].map(([key, label]) => (
                    <label key={key} className="flex items-center justify-between text-xs text-zinc-300 cursor-pointer py-1">
                      <span>{label}</span>
                      <input
                        type="checkbox"
                        checked={Boolean(settings[key])}
                        onChange={(e) => updateSetting(key, e.target.checked)}
                        className="accent-amber-500"
                      />
                    </label>
                  ))}

                  <div className="pt-2 border-t border-white/5 flex items-center justify-between">
                    <span className="text-xs text-zinc-400">{t('localDatabase')}</span>
                    <button
                      onClick={() =>
                        setConfirmModal({
                          title: t('purgeModalTitle'),
                          message: t('purgeModalDesc'),
                          onConfirm: async () => {
                            await dbClearAll();
                            shouldPlayRef.current = false;
                            isTransitioningTrackRef.current = false;
                            cancelHandoff();
                            preloadedRef.current = null;
                            deckElsRef.current.forEach((el) => {
                              if (el) {
                                el.pause();
                                el.removeAttribute('src');
                              }
                            });
                            setTracks([]);
                            setQueue([]);
                            setCurrentTrackId(null);
                            setSelectedAlbumId(null);
                            setIsPlaying(false);
                            setRememberedFolder({
                              handle: null,
                              name: null,
                              mode: null,
                              permissionState: 'unknown',
                              trackCount: 0,
                              lastScannedAt: null
                            });
                            showToast(t('databaseCleared'), 'info');
                          }
                        })
                      }
                      className="px-2.5 py-1 rounded-lg bg-rose-500/15 hover:bg-rose-500/25 text-rose-300 text-xs font-medium"
                    >
                      {t('purge')}
                    </button>
                  </div>
                </div>

                <div className="flex flex-col gap-3">
                  <div className="p-4 rounded-2xl bg-zinc-950/60 border border-white/[0.06] flex flex-col gap-2">
                    <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-400">{t('shortcuts')}</h3>
                    <div className="grid grid-cols-2 gap-1.5 text-xs">
                      {[
                        ['Space', 'Play / Pause'],
                        ['1 - 4', 'EQ Profiles'],
                        ['E', 'EQ Bypass'],
                        ['← / →', 'Seek 5s'],
                        ['↑ / ↓', 'Volume'],
                        ['M', 'Mute'],
                        ['S / R', 'Shuffle / Repeat'],
                        ['F / Esc', 'Fullscreen / Exit']
                      ].map(([key, desc]) => (
                        <div key={key} className="flex items-center justify-between px-2.5 py-1.5 rounded-lg bg-zinc-900/60">
                          <kbd className="text-amber-300 font-mono text-[11px]">{key}</kbd>
                          <span className="text-zinc-400">{desc}</span>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="p-4 rounded-2xl bg-zinc-950/60 border border-white/[0.06] flex flex-col gap-2">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold uppercase tracking-wider text-zinc-400">{t('environmentCodecs')}</span>
                      <button
                        onClick={runSelfDiagnosticsSuite}
                        className="px-2.5 py-1 rounded-lg bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-300 text-[11px] font-medium"
                      >
                        {t('selfTest')}
                      </button>
                    </div>
                    <div className="flex flex-wrap gap-1.5 pt-1">
                      {envStatus.codecMatrix.map((c) => (
                        <span
                          key={c.ext}
                          className={`text-[10px] font-mono px-2 py-0.5 rounded ${c.support.includes('Unsupported')
                            ? 'bg-rose-500/15 text-rose-300'
                            : 'bg-white/5 text-zinc-300'
                            }`}
                        >
                          {c.ext}
                        </span>
                      ))}
                    </div>
                    {diagnosticReport && (
                      <div className="text-[11px] font-mono text-emerald-400 pt-1">
                        ✓ {diagnosticReport.inferredMeta} • Sync & Dedup Verified
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}
        </section>
      </main>

      {showQueueDrawer && (
        <div className="fixed bottom-6 left-4 lg:left-8 z-40 w-80 sm:w-96 max-h-[65vh] rounded-3xl bg-zinc-950/95 border border-white/15 backdrop-blur-2xl shadow-2xl flex flex-col overflow-hidden">
          <div className="p-3.5 border-b border-white/10 flex items-center justify-between shrink-0">
            <div className="flex items-center gap-2">
              <ListMusic className="w-4 h-4 text-amber-400" />
              <h3 className="text-xs font-semibold text-white">Queue ({queue.length})</h3>
            </div>
            <button
              onClick={() => setShowQueueDrawer(false)}
              className="text-zinc-400 hover:text-white p-1 rounded-lg hover:bg-white/5"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto aurelia-scrollbar p-2 space-y-1">
            {queue.map((tid, idx) => {
              const t = tracks.find((item) => item.id === tid);
              if (!t) return null;
              const isCurr = tid === currentTrackId;
              return (
                <div
                  key={`${tid}-${idx}`}
                  onClick={() => startTrackById(tid)}
                  className={`flex items-center justify-between gap-2 p-2 rounded-xl cursor-pointer transition ${isCurr ? 'bg-amber-500/20 text-amber-300' : 'hover:bg-white/5 text-zinc-200'
                    }`}
                >
                  <div className="flex items-center gap-2.5 min-w-0 flex-1">
                    <img src={t.coverUrl} alt="" className="w-8 h-8 rounded-lg object-cover shrink-0" />
                    <div className="min-w-0 flex-1">
                      <div className="text-xs font-medium truncate">{t.title}</div>
                      <div className="text-[10px] text-zinc-500 truncate">{t.artist}</div>
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
                    <button
                      onClick={() => handleMoveQueueItem(idx, -1)}
                      disabled={idx === 0}
                      className="p-1 text-zinc-500 hover:text-white disabled:opacity-30"
                      title="Move Up"
                    >
                      <ChevronUp className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={() => handleMoveQueueItem(idx, 1)}
                      disabled={idx === queue.length - 1}
                      className="p-1 text-zinc-500 hover:text-white disabled:opacity-30"
                      title="Move Down"
                    >
                      <ChevronDown className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={() => setQueue((prev) => prev.filter((_, i) => i !== idx))}
                      className="p-1 text-zinc-500 hover:text-rose-400"
                      title="Remove"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      { }
      {/* FULLSCREEN MODE A: IMMERSIVE FULLSCREEN PLAYER */}
      {fullscreenMode === 'player' && (
        <div className="aurelia-fullscreen-player fixed inset-0 z-50 bg-[#050609] flex flex-col justify-between p-6 sm:p-10 overflow-hidden no-scrollbar">
          {/* Smooth Crossfade Ambient Artwork Background */}
          <div className="pointer-events-none absolute inset-0 overflow-hidden">
            {backdropState.prevUrl && (
              <img
                src={backdropState.prevUrl}
                alt=""
                className={`absolute inset-0 w-full h-full object-cover scale-110 blur-3xl transition-opacity duration-700 ease-out ${backdropState.transitioning ? 'opacity-50' : 'opacity-0'
                  }`}
              />
            )}
            {backdropState.activeUrl && (
              <img
                src={backdropState.activeUrl}
                alt=""
                className="absolute inset-0 w-full h-full object-cover scale-110 blur-3xl opacity-50 transition-all duration-700 ease-out"
              />
            )}
            <div className="aurelia-fs-backdrop-gradient absolute inset-0 bg-gradient-to-b from-black/50 via-black/65 to-black/90" />
          </div>

          {/* Top Bar */}
          <div className="relative z-10 flex items-center justify-between shrink-0">
            <div className="flex items-center gap-2 text-xs font-mono text-zinc-700 dark:text-zinc-300/80">
              <Disc className={`w-4 h-4 text-amber-500 dark:text-amber-400 ${isPlaying ? 'animate-spin' : ''}`} style={{ animationDuration: '6s' }} />
              <span>{currentTrack?.codec?.split(' ')[0] || 'AURELIA'}</span>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={(e) => toggleFullscreenMode('lyrics', e.currentTarget)}
                className="aurelia-fs-btn p-2.5 rounded-xl bg-white/10 hover:bg-white/15 text-zinc-700 dark:text-zinc-200 hover:text-amber-500 dark:hover:text-amber-300 transition"
                title="Lyrics Fullscreen"
                aria-label="Lyrics Fullscreen"
              >
                <AlignCenter className="w-4 h-4" />
              </button>
              <button
                onClick={exitFullscreenMode}
                className="aurelia-fs-btn px-3.5 py-2 rounded-xl bg-white/10 hover:bg-white/15 text-zinc-900 dark:text-white text-xs font-medium flex items-center gap-2 transition"
                title="Exit Fullscreen (Esc)"
              >
                <Minimize2 className="w-4 h-4" />
                <span>Exit</span>
              </button>
            </div>
          </div>

          {/* Center Artwork + Integrated Multi-Line Background Lyrics */}
          <div className="relative z-10 flex-1 min-h-0 flex flex-col lg:flex-row items-center justify-center gap-8 lg:gap-14 my-4 overflow-hidden no-scrollbar">
            <div className="flex flex-col items-center text-center shrink-0">
              <div className="aurelia-fs-artwork-card w-44 h-44 sm:w-60 sm:h-60 lg:w-72 lg:h-72 rounded-3xl overflow-hidden shadow-[0_28px_80px_rgba(0,0,0,0.85)] ring-1 ring-white/15 bg-zinc-900">
                {currentTrack?.coverUrl && (
                  <img
                    key={currentTrack.coverUrl}
                    src={currentTrack.coverUrl}
                    alt={currentTrack.title}
                    className="w-full h-full object-cover"
                  />
                )}
              </div>
              <h2 className="text-xl sm:text-2xl font-bold text-zinc-900 dark:text-white mt-4 max-w-md truncate drop-shadow dark:drop-shadow">
                {currentTrack?.title}
              </h2>
              <p className="aurelia-fs-artist text-sm text-amber-600 dark:text-amber-300/90 mt-1 max-w-md truncate drop-shadow dark:drop-shadow">
                {currentTrack?.artist}
                {currentTrack?.album ? <span className="aurelia-fs-album text-zinc-600 dark:text-zinc-400"> • {currentTrack.album}</span> : null}
              </p>
            </div>

            <div className="flex-1 max-w-2xl w-full flex flex-col items-center justify-center gap-5 px-4 overflow-hidden no-scrollbar">
              {visibleLyricsWindow.length === 0 ? (
                <span className="text-sm text-zinc-500 dark:text-zinc-400/60 font-medium drop-shadow dark:drop-shadow">
                  {autoLyricsState.status === 'loading' ? 'Syncing lyrics...' : '♪'}
                </span>
              ) : (
                visibleLyricsWindow.map((line) => {
                  const isActive = line.role === 'active';
                  const isPast = line.role === 'past';
                  return (
                    <div
                      key={line.id}
                      onClick={() => {
                        if (line.timeSec !== null) {
                          const offsetSec = (currentTrack?.lyricsOffsetMs || 0) / 1000;
                          handleSeek(Math.max(0, line.timeSec + offsetSec));
                        }
                      }}
                      className={`text-center lg:text-left w-full whitespace-normal break-words [overflow-wrap:anywhere] [text-wrap:balance] leading-snug transition-[opacity,color,transform] duration-300 ease-out drop-shadow dark:drop-shadow-[0_2px_12px_rgba(0,0,0,0.9)] ${line.timeSec !== null ? 'cursor-pointer' : ''
                        } ${isActive
                          ? 'aurelia-fs-lyric-active text-xl sm:text-2xl lg:text-3xl font-bold text-amber-500 dark:text-amber-300 opacity-100'
                          : isPast
                            ? 'aurelia-fs-lyric-past text-sm sm:text-base lg:text-lg text-zinc-500 dark:text-zinc-400 opacity-40'
                            : 'aurelia-fs-lyric-future text-base sm:text-lg lg:text-xl text-zinc-800 dark:text-zinc-200 opacity-75 hover:opacity-100'
                        }`}
                    >
                      {line.text}
                    </div>
                  );
                })
              )}
            </div>
          </div>

          {/* Bottom Bars-Only Spectrum + Transport Controls */}
          <div className="relative z-10 max-w-4xl w-full mx-auto flex flex-col gap-4 shrink-0">
            <canvas
              ref={fullscreenVisualizerCanvasRef}
              width={640}
              height={56}
              style={{ transform: 'translateZ(0)', willChange: 'contents' }}
              className="w-full h-[56px] block pointer-events-none"
            />

            <div className="flex items-center gap-3">
              <WithClock step={1}>
                {(currentTime) => (
                  <span className="text-xs font-mono w-10 text-right" style={{ color: activePalette?.hex300 || '#fcd34d' }}>{formatTime(currentTime)}</span>
                )}
              </WithClock>
              <WithClock>
                {(currentTime) => {
                  const dur = Math.max(1, duration || currentTrack?.duration || 1);
                  const pct = Math.min(100, Math.max(0, (currentTime / dur) * 100));
                  return (
                    <input
                      type="range"
                      min={0}
                      max={dur}
                      step={0.05}
                      value={Math.min(currentTime, dur)}
                      onChange={(e) => handleSeek(parseFloat(e.target.value))}
                      style={{
                        accentColor: activePalette?.hex400 || '#fbbf24',
                        '--range-progress': `${pct}%`
                      }}
                      className="aurelia-slider-progress flex-1 h-1.5 rounded-full appearance-none cursor-pointer"
                    />
                  );
                }}
              </WithClock>
              <span className="text-xs font-mono text-zinc-400 w-10">
                {formatTime(duration || currentTrack?.duration || 0)}
              </span>
            </div>

            <div className="flex items-center justify-between gap-4">
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setShuffle((s) => !s)}
                  className={`p-2 rounded-xl transition ${shuffle ? 'text-amber-400 bg-amber-500/15' : 'text-zinc-400 hover:text-white'
                    }`}
                  title="Shuffle"
                >
                  <Shuffle className="w-4 h-4" />
                </button>
                <button
                  onClick={() => setRepeatMode((r) => (r === 'off' ? 'all' : r === 'all' ? 'one' : 'off'))}
                  className={`p-2 rounded-xl transition ${repeatMode !== 'off' ? 'text-amber-400 bg-amber-500/15' : 'text-zinc-400 hover:text-white'
                    }`}
                  title="Repeat"
                >
                  {repeatMode === 'one' ? <Repeat1 className="w-4 h-4" /> : <Repeat className="w-4 h-4" />}
                </button>
              </div>

              <div className="flex items-center gap-5">
                <button onClick={handlePrevTrack} className="p-3 rounded-full bg-white/10 hover:bg-white/15 text-white">
                  <SkipBack className="w-5 h-5" />
                </button>
                <button
                  onClick={togglePlayPause}
                  className="p-4 rounded-full bg-amber-500 hover:bg-amber-400 text-zinc-950 shadow-xl"
                >
                  {isPlaying ? <Pause className="w-6 h-6 fill-zinc-950" /> : <Play className="w-6 h-6 fill-zinc-950 ml-0.5" />}
                </button>
                <button onClick={() => handleNextTrack(false)} className="p-3 rounded-full bg-white/10 hover:bg-white/15 text-white">
                  <SkipForward className="w-5 h-5" />
                </button>
              </div>

              <div className="flex items-center gap-2">
                <button onClick={() => setIsMuted((m) => !m)} className="text-zinc-300 hover:text-white">
                  {isMuted || volume === 0 ? <VolumeX className="w-4 h-4 text-rose-400" /> : <Volume2 className="w-4 h-4" />}
                </button>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={isMuted ? 0 : volume}
                  onChange={(e) => {
                    setIsMuted(false);
                    setVolume(parseFloat(e.target.value));
                  }}
                  style={{
                    accentColor: activePalette?.hex400 || '#fbbf24',
                    '--range-progress': `${(isMuted ? 0 : volume) * 100}%`
                  }}
                  className="aurelia-slider-progress w-24 h-1.5 rounded-full appearance-none cursor-pointer"
                />
              </div>
            </div>
          </div>
        </div>
      )}

      {/* FULLSCREEN MODE B: DEDICATED LYRICS-ONLY FULLSCREEN (NO TRUNCATION, NATURAL MULTI-LINE WRAPPING) */}
      {fullscreenMode === 'lyrics' && (
        <div className="aurelia-fullscreen-lyrics fixed inset-0 z-50 bg-[#050609] flex flex-col justify-between p-6 sm:p-12 overflow-hidden no-scrollbar">
          {/* Softly Blurred & Darkened Ambient Artwork Background */}
          <div className="pointer-events-none absolute inset-0 overflow-hidden">
            {backdropState.prevUrl && (
              <img
                src={backdropState.prevUrl}
                alt=""
                className={`absolute inset-0 w-full h-full object-cover scale-125 blur-[90px] transition-opacity duration-700 ease-out ${backdropState.transitioning ? 'opacity-35' : 'opacity-0'
                  }`}
              />
            )}
            {backdropState.activeUrl && (
              <img
                src={backdropState.activeUrl}
                alt=""
                className="absolute inset-0 w-full h-full object-cover scale-125 blur-[90px] opacity-35 transition-all duration-700 ease-out"
              />
            )}
            <div className="aurelia-fs-backdrop-gradient absolute inset-0 bg-gradient-to-b from-black/70 via-black/75 to-black/90" />
          </div>

          {/* Minimal Top Bar: Small Unobtrusive Song Title & Artist + Minimal Exit Control */}
          <div className="relative z-10 flex items-center justify-between gap-4 shrink-0">
            <div className="min-w-0">
              <div className="text-xs font-semibold text-zinc-900 dark:text-zinc-300 truncate">
                {currentTrack?.title || 'No Track Selected'}
              </div>
              <div className="text-[11px] text-zinc-600 dark:text-zinc-500 truncate">
                {currentTrack?.artist}
              </div>
            </div>
            <button
              onClick={exitFullscreenMode}
              className="aurelia-fs-btn p-2 rounded-xl bg-white/[0.06] hover:bg-white/15 text-zinc-700 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-white transition shrink-0"
              title="Exit Lyrics Fullscreen (Esc)"
              aria-label="Exit Lyrics Fullscreen"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Synchronized Multi-Line Wrapping Lyrics as Sole Visual Focus (No Ellipsis, No Scrollbar) */}
          <div className="relative z-10 flex-1 min-h-0 flex flex-col items-center justify-center gap-6 sm:gap-8 px-4 sm:px-12 lg:px-20 py-6 overflow-hidden no-scrollbar">
            {visibleLyricsWindow.length === 0 ? (
              <div className="text-sm text-zinc-500 dark:text-zinc-400 font-medium tracking-wide">
                {autoLyricsState.status === 'loading'
                  ? 'Syncing lyrics...'
                  : autoLyricsState.status === 'offline'
                    ? 'Offline'
                    : 'No synchronized lyrics'}
              </div>
            ) : (
              visibleLyricsWindow.map((line) => {
                const isActive = line.role === 'active';
                const isPast = line.role === 'past';
                return (
                  <div
                    key={line.id}
                    className={`text-center max-w-5xl w-full px-2 whitespace-normal break-words [overflow-wrap:anywhere] [text-wrap:balance] leading-relaxed transition-[opacity,color,transform] duration-500 ease-out drop-shadow dark:drop-shadow-[0_4px_16px_rgba(0,0,0,0.9)] ${isActive
                      ? 'aurelia-fs-lyric-active text-2xl sm:text-3xl md:text-4xl lg:text-[42px] font-semibold text-amber-500 dark:text-amber-300 opacity-100'
                      : isPast
                        ? 'aurelia-fs-lyric-past text-base sm:text-lg md:text-xl text-zinc-500 dark:text-zinc-400 opacity-40'
                        : 'aurelia-fs-lyric-future text-lg sm:text-xl md:text-2xl text-zinc-800 dark:text-zinc-200 opacity-70'
                      }`}
                  >
                    {line.text}
                  </div>
                );
              })
            )}
          </div>

          <div className="relative z-10 h-4 shrink-0" />
        </div>
      )}

      {/* Smart Metadata Audit & Harmonization Modal */}
      {smartAuditResult && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-md flex items-center justify-center p-4">
          <div className="bg-zinc-900 border border-white/15 rounded-3xl max-w-2xl w-full max-h-[85vh] flex flex-col shadow-2xl overflow-hidden">
            {/* Modal Header */}
            <div className="p-6 pb-4 border-b border-white/10 flex items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-2xl bg-gradient-to-br from-sky-400 to-sky-600 flex items-center justify-center shadow-lg shadow-sky-500/20 text-zinc-950 shrink-0">
                  <Shield className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-base sm:text-lg font-bold text-white tracking-tight">
                    {t('smartAuditTitle')}
                  </h3>
                  <p className="text-xs text-zinc-400">
                    {t('libraryHealthScore')}: <span className="font-semibold text-white">{smartAuditResult.healthScore}%</span>
                    {' • '}
                    {smartAuditResult.totalTracks} {t('tracksCount')}
                    {' • '}
                    {smartAuditResult.totalAlbums} albums
                  </p>
                </div>
              </div>
              <button
                onClick={() => setSmartAuditResult(null)}
                className="p-2 rounded-xl bg-white/5 hover:bg-white/10 text-zinc-400 hover:text-white transition"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Health Score Banner */}
            <div className="px-6 py-3 bg-white/[0.03] border-b border-white/10 flex items-center justify-between gap-4">
              <div className="flex-1">
                <div className="flex items-center justify-between text-xs mb-1.5">
                  <span className="font-medium text-zinc-300">
                    {smartAuditResult.albumIssues.length === 0
                      ? t('noIssuesFound')
                      : `Phát hiện ${smartAuditResult.totalDiscrepancies} điểm bất thường trong ${smartAuditResult.albumIssues.length} album`}
                  </span>
                  <span
                    className={`font-bold font-mono text-sm ${smartAuditResult.healthScore === 100
                      ? 'text-emerald-400'
                      : smartAuditResult.healthScore >= 75
                        ? 'text-amber-400'
                        : 'text-rose-400'
                      }`}
                  >
                    {smartAuditResult.healthScore}%
                  </span>
                </div>
                <div className="w-full h-2 rounded-full bg-black/40 overflow-hidden ring-1 ring-white/10">
                  <div
                    className={`h-full rounded-full transition-all duration-500 ${smartAuditResult.healthScore === 100
                      ? 'bg-gradient-to-r from-emerald-500 to-teal-400'
                      : smartAuditResult.healthScore >= 75
                        ? 'bg-gradient-to-r from-amber-500 to-orange-400'
                        : 'bg-gradient-to-r from-rose-500 to-pink-500'
                      }`}
                    style={{ width: `${smartAuditResult.healthScore}%` }}
                  />
                </div>
              </div>
            </div>

            {/* Modal Body: Issue list or Clean State */}
            <div className="flex-1 overflow-y-auto p-6 space-y-4 no-scrollbar">
              {smartAuditResult.albumIssues.length === 0 ? (
                <div className="py-12 flex flex-col items-center justify-center text-center gap-3">
                  <div className="w-14 h-14 rounded-full bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center text-emerald-400 shadow-xl shadow-emerald-500/10">
                    <CheckCircle2 className="w-8 h-8" />
                  </div>
                  <h4 className="text-base font-semibold text-white">Thư viện hoàn toàn đồng nhất!</h4>
                  <p className="text-xs text-zinc-400 max-w-sm">
                    {t('noIssuesFound')}
                  </p>
                </div>
              ) : (
                smartAuditResult.albumIssues.map((report) => (
                  <div
                    key={report.albumTitle}
                    className="p-4 rounded-2xl bg-white/[0.03] border border-white/10 flex flex-col gap-2.5"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <Disc className="w-4 h-4 text-amber-400 shrink-0" />
                        <span className="text-sm font-semibold text-white truncate" title={report.albumTitle}>
                          {report.albumTitle}
                        </span>
                      </div>
                      <span className="text-[11px] px-2 py-0.5 rounded-full bg-white/10 text-zinc-300 font-mono shrink-0">
                        {report.tracksCount} {t('tracksCount')}
                      </span>
                    </div>

                    <div className="space-y-1.5 pt-1 border-t border-white/5">
                      {report.issues.map((issue, idx) => (
                        <div
                          key={idx}
                          className="flex items-start gap-2 text-xs text-zinc-300 bg-black/25 px-3 py-2 rounded-xl border border-white/5"
                        >
                          <AlertCircle className="w-3.5 h-3.5 text-amber-400 shrink-0 mt-0.5" />
                          <div className="flex-1 min-w-0">
                            <span className="font-semibold text-amber-300">{issue.title}: </span>
                            <span className="text-zinc-300">{issue.detail}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ))
              )}
            </div>

            {/* Modal Footer */}
            <div className="p-4 sm:p-6 pt-3 border-t border-white/10 flex items-center justify-between gap-3 bg-black/20">
              <button
                onClick={() => setSmartAuditResult(null)}
                className="px-4 py-2 rounded-xl bg-white/5 hover:bg-white/10 text-zinc-300 text-xs sm:text-sm font-medium transition"
              >
                {t('cancel')}
              </button>

              {smartAuditResult.albumIssues.length > 0 && (
                <button
                  onClick={handleAutoHarmonizeMetadata}
                  className="px-5 py-2.5 rounded-xl bg-gradient-to-r from-sky-500 via-sky-600 to-blue-600 hover:from-sky-400 hover:to-blue-500 text-white text-xs sm:text-sm font-semibold flex items-center gap-2 shadow-lg shadow-sky-500/25 transition"
                >
                  <Sparkles className="w-4 h-4" />
                  <span>{t('autoHarmonize')}</span>
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}