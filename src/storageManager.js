import { convertFileSrc, invoke } from '@tauri-apps/api/core';

/**
 * Storage & Filesystem helper for Aurelia Audio.
 * Ensures audio files are read directly from local folders and not duplicated into IndexedDB.
 */

export function isTauriEnvironment() {
  if (typeof window === 'undefined') return false;
  return Boolean(window.__TAURI__ || window.__TAURI_INTERNALS__);
}

export async function verifyFolderAccess(folderRecord) {
  if (!folderRecord) {
    return { ok: false, reason: 'no-folder' };
  }

  // 1. Native Tauri environment
  if (isTauriEnvironment() && folderRecord.path) {
    try {
      const exists = await invoke('verify_folder_access', { folderPath: folderRecord.path });
      return {
        ok: Boolean(exists),
        mode: 'tauri-native',
        reason: exists ? 'available' : 'path-not-found'
      };
    } catch (err) {
      // Fallback: If command fails or not available, assume unavailable
      return { ok: false, mode: 'tauri-native', reason: 'access-error', error: err };
    }
  }

  // 2. Browser File System Access API
  if (folderRecord.handle && typeof folderRecord.handle.queryPermission === 'function') {
    try {
      const perm = await folderRecord.handle.queryPermission({ mode: 'read' });
      return {
        ok: perm === 'granted',
        mode: 'fs-handle',
        reason: perm,
        needsPrompt: perm === 'prompt'
      };
    } catch (err) {
      return { ok: false, mode: 'fs-handle', reason: 'query-failed', error: err };
    }
  }

  // 3. Fallback mode
  return {
    ok: Boolean(folderRecord.path || folderRecord.handle),
    mode: folderRecord.mode || 'fallback',
    reason: 'unverified'
  };
}

/**
 * Strips heavy audioBlob from track before persisting to IndexedDB,
 * unless persistBlobsInIdb is explicitly enabled by the user.
 * Preserves existing audioBlob on legacy tracks if they lack a filePath.
 */
export function sanitizeTrackForStorage(trackObj, persistBlobsInIdb = false) {
  if (!trackObj) return trackObj;

  let blobToStore = null;

  if (persistBlobsInIdb) {
    blobToStore = trackObj.audioBlob instanceof Blob ? trackObj.audioBlob : null;
  } else if (!trackObj.filePath && trackObj.audioBlob instanceof Blob) {
    // Preserve existing legacy blob for tracks without native filesystem path
    // so user data remains recoverable during transition.
    blobToStore = trackObj.audioBlob;
  }

  return {
    ...trackObj,
    objectUrl: null, // Never persist session blob/asset URLs
    audioBlob: blobToStore
  };
}

/**
 * Resolves a playable URL for a track directly from disk or memory.
 */
export function resolveTrackPlayableUrl(track) {
  if (!track) return null;

  // 1. If native filePath exists and Tauri is active, use Tauri's asset protocol
  if (track.filePath && typeof convertFileSrc === 'function') {
    try {
      return convertFileSrc(track.filePath);
    } catch (err) {
      console.warn('Failed to convert native file path to asset protocol URL:', err);
    }
  }

  // 2. If track already has an active objectUrl in this session
  if (typeof track.objectUrl === 'string' && track.objectUrl) {
    return track.objectUrl;
  }

  // 3. If track has an in-memory or legacy audioBlob
  if (track.audioBlob instanceof Blob) {
    try {
      return URL.createObjectURL(track.audioBlob);
    } catch (err) {
      console.warn('Failed to create object URL for audioBlob:', err);
    }
  }

  return null;
}

/**
 * Safely strips cached audio Blobs from all tracks in IndexedDB,
 * freeing storage space while preserving all track metadata, playlists, lyrics, and artwork.
 */
export async function reclaimAudioBlobStorage(dbGetAll, dbPut) {
  if (typeof dbGetAll !== 'function' || typeof dbPut !== 'function') {
    throw new Error('Database functions dbGetAll and dbPut must be provided');
  }

  const allTracks = await dbGetAll('tracks');
  let reclaimedCount = 0;
  let estimatedBytesFreed = 0;

  for (const track of allTracks) {
    if (track && track.audioBlob instanceof Blob) {
      estimatedBytesFreed += track.audioBlob.size || track.fileSize || 0;
      await dbPut('tracks', {
        ...track,
        objectUrl: null,
        audioBlob: null
      });
      reclaimedCount++;
    }
  }

  return {
    reclaimedCount,
    estimatedBytesFreed
  };
}
