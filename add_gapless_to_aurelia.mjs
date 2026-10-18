import fs from 'node:fs';
import path from 'node:path';

const projectRoot = process.cwd();
const candidates = [
  path.join(projectRoot, 'src', 'App.jsx'),
  path.join(projectRoot, 'src', 'App.tsx'),
  path.join(projectRoot, 'App.jsx'),
  path.join(projectRoot, 'App.tsx'),
];
const appPath = candidates.find((p) => fs.existsSync(p));
if (!appPath) {
  console.error('Không tìm thấy src/App.tsx hoặc App.tsx. Hãy chạy script tại thư mục gốc dự án Aurelia.');
  process.exit(1);
}

// Normalize Windows line endings for matching. A backup of the original bytes is kept before writing.
let source = fs.readFileSync(appPath, 'utf8').replace(/\r\n/g, '\n');
const original = source;
const applied = [];

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function replaceExactlyOnce(label, needle, replacement) {
  const patternText = needle
    .trim()
    .split(/\s+/)
    .map(escapeRegExp)
    .join('\\s+');

  const pattern = new RegExp(patternText, 'g');
  const matches = [...source.matchAll(pattern)];

  if (matches.length === 0) {
    throw new Error(`Không tìm thấy đoạn cần sửa: ${label}`);
  }

  if (matches.length > 1) {
    throw new Error(
      `Đoạn cần sửa xuất hiện nhiều hơn một lần: ${label}`
    );
  }

  const match = matches[0];

  source =
    source.slice(0, match.index) +
    replacement +
    source.slice(match.index + match[0].length);

  applied.push(label);
}
try {
  replaceExactlyOnce(
    'thêm tùy chọn Gapless vào settings',
    'keyboardShortcuts: true,',
    'keyboardShortcuts: true,\n    gaplessPlayback: true,'
  );

  replaceExactlyOnce(
    'thêm refs cho preload và timer Gapless',
    "  const pendingFadeSecRef = useRef(null); // set when auto-advance starts the next track early\n  const fadeInSecRef = useRef(null); // fade-in that waits for the new track's 'playing' event",
    "  const pendingFadeSecRef = useRef(null); // set when auto-advance starts the next track early\n  const gaplessPreparedRef = useRef(null); // upcoming track prepared on the inactive audio deck\n  const gaplessEnabledRef = useRef(false);\n  const gaplessTransitionTimerRef = useRef(null);\n  const fadeInSecRef = useRef(null); // fade-in that waits for the new track's 'playing' event"
  );

  replaceExactlyOnce(
    'kết nối trạng thái Gapless với setting',
    '  crossfadeSecRef.current = Math.max(0, Number(settings.crossfadeSeconds) || 0);',
    '  crossfadeSecRef.current = Math.max(0, Number(settings.crossfadeSeconds) || 0);\n  gaplessEnabledRef.current = Boolean(settings.gaplessPlayback) && crossfadeSecRef.current <= 0;'
  );

  replaceExactlyOnce(
    'truyền chỉ số deck vào bộ khởi tạo nguồn âm thanh',
    'const deckNodes = deckElsRef.current.map((el) => {',
    'const deckNodes = deckElsRef.current.map((el, idx) => {'
  );

  replaceExactlyOnce(
    'khởi tạo gain deck không hoạt động ở mức 0',
    '        const gain = ctx.createGain();\n        gain.gain.value = 1;\n        src.connect(gain);',
    '        const gain = ctx.createGain();\n        gain.gain.value = idx === activeDeckRef.current ? 1 : 0;\n        src.connect(gain);'
  );
  replaceExactlyOnce(
    'cho phép beginDeckTransition nhận track đích',
    '  const beginDeckTransition = useCallback(() => {',
    '  const beginDeckTransition = useCallback((targetTrackId = null) => {'
  );

  replaceExactlyOnce(
    'chuyển sang deck đã chuẩn bị khi Gapless bật',
    '    const activeIdx = activeDeckRef.current;\n\n    if (!graphReady || total <= 0) {',
    `    const activeIdx = activeDeckRef.current;

    // Reuse the preloaded inactive deck when Gapless is enabled and the prepared track matches.
    const prepared = gaplessPreparedRef.current;
    if (
      graphReady &&
      total <= 0 &&
      gaplessEnabledRef.current &&
      prepared?.ready &&
      prepared.trackId === targetTrackId &&
      prepared.deckIdx !== activeIdx &&
      !deckBusyRef.current[prepared.deckIdx]
    ) {
      const incoming = deckElsRef.current[prepared.deckIdx];
      if (incoming && incoming.src === prepared.objectUrl && incoming.readyState >= 2) {
        audioRef.current = incoming;
        activeDeckRef.current = prepared.deckIdx;
        fadeOutDeck(activeIdx, 0.04);
        fadeInSecRef.current = 0.04;
        gaplessPreparedRef.current = null;
        result.deck = incoming;
        return result;
      }
    }

    if (!graphReady || total <= 0) {`
  );

  replaceExactlyOnce(
    'không nạp lại nguồn trên deck đã preload',
    '      audio.src = currentTrack.objectUrl;\n      audio.load();\n      setCurrentTime(0);',
    '      if (audio.src !== currentTrack.objectUrl) {\n        audio.src = currentTrack.objectUrl;\n        audio.load();\n      }\n      setCurrentTime(0);'
  );

  replaceExactlyOnce(
    'truyền track đích vào beginDeckTransition',
    '      const transition = beginDeckTransition();',
    '      const transition = beginDeckTransition(currentTrackId);'
  );

  replaceExactlyOnce(
    'dùng track kế tiếp đã preload khi auto-advance',
    `    const isTrackPlayable = (id) => {
      const t = trackById.get(id);
      return Boolean(t && !t.needsRelink && t.objectUrl);
    };

    const shouldContinuePlaying = isAutoEnded ? true : shouldPlayRef.current || isPlaying;`,
    `    const isTrackPlayable = (id) => {
      const t = trackById.get(id);
      return Boolean(t && !t.needsRelink && t.objectUrl);
    };

    // If the prepared deck is ready, prefer it for natural track changes.
    if (isAutoEnded && gaplessEnabledRef.current && crossfadeSecRef.current <= 0) {
      const prepared = gaplessPreparedRef.current;
      if (
        prepared?.ready &&
        prepared.trackId !== currentTrackId &&
        queue.includes(prepared.trackId) &&
        isTrackPlayable(prepared.trackId)
      ) {
        pendingFadeSecRef.current = null;
        shouldPlayRef.current = true;
        isTransitioningTrackRef.current = true;
        setIsPlaying(true);
        setCurrentTrackId(prepared.trackId);
        return;
      }
    }

    const shouldContinuePlaying = isAutoEnded ? true : shouldPlayRef.current || isPlaying;`
  );

  replaceExactlyOnce(
    'lập lịch chuyển deck sát cuối bài khi Gapless bật',
    `    // Start the next track a few seconds early so it can overlap the tail of this one
    const total = crossfadeSecRef.current;
    if (total <= 0 || repeatMode === 'one' || audio.paused || !currentTrackId) return;
    if (!audioCtxRef.current || crossfadeTriggeredForRef.current === currentTrackId) return;
    const dur = audio.duration;
    if (!Number.isFinite(dur) || dur < total * 2 + 2) return;
    const remaining = dur - audio.currentTime;
    if (remaining > total || remaining < 0.25) return;
    if (!hasUpcomingTrack()) return;
    crossfadeTriggeredForRef.current = currentTrackId;
    pendingFadeSecRef.current = remaining;
    handleNextTrack(true);`,
    `    const total = crossfadeSecRef.current;
    if (repeatMode === 'one' || audio.paused || !currentTrackId) return;
    if (crossfadeTriggeredForRef.current === currentTrackId) return;
    const dur = audio.duration;
    if (!Number.isFinite(dur)) return;
    const remaining = dur - audio.currentTime;

    // Keep the existing crossfade path unchanged.
    if (total > 0) {
      if (!audioCtxRef.current || dur < total * 2 + 2 || remaining > total || remaining < 0.25) return;
      if (!hasUpcomingTrack()) return;
      crossfadeTriggeredForRef.current = currentTrackId;
      pendingFadeSecRef.current = remaining;
      handleNextTrack(true);
      return;
    }

    // Gapless path: wait until the next deck is ready, then schedule a handoff near the end.
    if (!gaplessEnabledRef.current || remaining > 1.25 || remaining <= 0) return;
    const prepared = gaplessPreparedRef.current;
    if (!prepared?.ready || prepared.trackId === currentTrackId || !hasUpcomingTrack()) return;
    if (gaplessTransitionTimerRef.current != null) return;

    const expectedTrackId = currentTrackId;
    const performHandoff = () => {
      gaplessTransitionTimerRef.current = null;
      if (
        audioRef.current !== audio ||
        audio.paused ||
        currentTrackId !== expectedTrackId ||
        crossfadeTriggeredForRef.current === expectedTrackId
      ) return;

      const timeLeft = Number.isFinite(audio.duration) ? audio.duration - audio.currentTime : Infinity;
      const latestPrepared = gaplessPreparedRef.current;
      if (!latestPrepared?.ready || latestPrepared.trackId === expectedTrackId) return;
      if (timeLeft > 0.14 && !audio.ended) {
        gaplessTransitionTimerRef.current = setTimeout(performHandoff, Math.max(0, timeLeft * 1000 - 55));
        return;
      }

      crossfadeTriggeredForRef.current = expectedTrackId;
      pendingFadeSecRef.current = null;
      handleNextTrack(true);
    };

    gaplessTransitionTimerRef.current = setTimeout(
      performHandoff,
      Math.max(0, remaining * 1000 - 55)
    );`
  );

  const preloadEffect = `  // Preload only one upcoming track on the inactive deck to limit memory use.
  // HTML audio decks can reduce gaps but cannot guarantee sample-accurate native gapless playback.
  useEffect(() => {
    const enabled = Boolean(settings.gaplessPlayback) && (Number(settings.crossfadeSeconds) || 0) <= 0;
    if (!enabled || !currentTrackId || repeatMode === 'one') {
      gaplessPreparedRef.current = null;
      return;
    }
    if (!isPlaying) return;

    const trackById = new Map(tracks.map((t) => [t.id, t]));
    const isPlayable = (id) => {
      const track = trackById.get(id);
      return Boolean(track && !track.needsRelink && track.objectUrl);
    };

    let nextId = null;
    const previous = gaplessPreparedRef.current;
    if (shuffle) {
      const candidates = queue.filter((id) => id !== currentTrackId && isPlayable(id));
      if (previous && candidates.includes(previous.trackId)) {
        nextId = previous.trackId;
      } else if (candidates.length > 0) {
        nextId = candidates[Math.floor(Math.random() * candidates.length)];
      }
    } else {
      const currentIndex = queue.indexOf(currentTrackId);
      for (let i = currentIndex + 1; i < queue.length; i++) {
        if (isPlayable(queue[i])) {
          nextId = queue[i];
          break;
        }
      }
      if (!nextId && repeatMode === 'all') {
        nextId = queue.find((id) => id !== currentTrackId && isPlayable(id)) || null;
      }
    }

    const nextTrack = trackById.get(nextId);
    if (!nextTrack?.objectUrl || nextTrack.needsRelink) {
      gaplessPreparedRef.current = null;
      return;
    }

    let cancelled = false;
    let retryTimer = null;
    let readyDeck = null;
    let readyHandler = null;
    const removeReadyListeners = () => {
      if (readyDeck && readyHandler) {
        readyDeck.removeEventListener('loadeddata', readyHandler);
        readyDeck.removeEventListener('canplay', readyHandler);
      }
      readyDeck = null;
      readyHandler = null;
    };

    const prepare = () => {
      if (cancelled) return;
      const deckIdx = 1 - activeDeckRef.current;
      if (deckBusyRef.current[deckIdx]) {
        retryTimer = setTimeout(prepare, 80);
        return;
      }
      const el = deckElsRef.current[deckIdx];
      if (!el) return;

      const existing = gaplessPreparedRef.current;
      const record = existing && existing.trackId === nextTrack.id && existing.objectUrl === nextTrack.objectUrl && existing.deckIdx === deckIdx
        ? existing
        : { trackId: nextTrack.id, objectUrl: nextTrack.objectUrl, deckIdx, ready: false };
      gaplessPreparedRef.current = record;

      removeReadyListeners();
      readyDeck = el;
      readyHandler = () => {
        if (!cancelled && gaplessPreparedRef.current === record && el.readyState >= 2) {
          record.ready = true;
        }
      };
      el.addEventListener('loadeddata', readyHandler);
      el.addEventListener('canplay', readyHandler);

      if (audioCtxRef.current && deckGainsRef.current[deckIdx]) {
        rampDeckGain(deckIdx, null, 0, 0);
      }
      if (el.src !== nextTrack.objectUrl) {
        el.pause();
        el.preload = 'auto';
        el.src = nextTrack.objectUrl;
        el.load();
      }
      if (el.readyState >= 2) record.ready = true;
    };

    prepare();
    return () => {
      cancelled = true;
      clearTimeout(retryTimer);
      removeReadyListeners();
    };
  }, [
    settings.gaplessPlayback,
    settings.crossfadeSeconds,
    currentTrackId,
    tracks,
    queue,
    shuffle,
    repeatMode,
    isPlaying,
    rampDeckGain
  ]);

`;

  replaceExactlyOnce(
    'chèn hiệu ứng preload trước hiệu ứng volume',
    `  useEffect(() => {
    deckElsRef.current.forEach((el) => {
      if (el) el.volume = isMuted ? 0 : volume;
    });
  }, [volume, isMuted]);`,
    preloadEffect + `  useEffect(() => {
    deckElsRef.current.forEach((el) => {
      if (el) el.volume = isMuted ? 0 : volume;
    });
  }, [volume, isMuted]);`
  );

  // Cancel a pending automatic handoff when the user explicitly picks another track or seeks.
  replaceExactlyOnce(
    'hủy timer Gapless khi chọn track thủ công',
    `  const startTrackById = useCallback(
    (trackId) => {
      if (!trackId) return;
      shouldPlayRef.current = true;`,
    `  const startTrackById = useCallback(
    (trackId) => {
      if (!trackId) return;
      if (gaplessTransitionTimerRef.current != null) {
        clearTimeout(gaplessTransitionTimerRef.current);
        gaplessTransitionTimerRef.current = null;
      }
      shouldPlayRef.current = true;`
  );

  replaceExactlyOnce(
    'hủy timer Gapless khi tua bài',
    `    const audio = audioRef.current;
    if (!audio || !Number.isFinite(newTimeSec)) return;
    const clamped = Math.max(0, Math.min(audio.duration || duration || 0, newTimeSec));`,
    `    const audio = audioRef.current;
    if (!audio || !Number.isFinite(newTimeSec)) return;
    if (gaplessTransitionTimerRef.current != null) {
      clearTimeout(gaplessTransitionTimerRef.current);
      gaplessTransitionTimerRef.current = null;
    }
    const clamped = Math.max(0, Math.min(audio.duration || duration || 0, newTimeSec));`
  );

  replaceExactlyOnce(
    'hủy timer Gapless khi bấm Play/Pause',
    `  const togglePlayPause = useCallback(async () => {
    const audio = audioRef.current;
    if (!audio || !currentTrack) return;`,
    `  const togglePlayPause = useCallback(async () => {
    const audio = audioRef.current;
    if (!audio || !currentTrack) return;
    if (gaplessTransitionTimerRef.current != null) {
      clearTimeout(gaplessTransitionTimerRef.current);
      gaplessTransitionTimerRef.current = null;
    }`
  );

  replaceExactlyOnce(
    'hủy timer Gapless khi bấm Previous',
    `  const handlePrevTrack = useCallback(() => {
    const audio = audioRef.current;`,
    `  const handlePrevTrack = useCallback(() => {
    if (gaplessTransitionTimerRef.current != null) {
      clearTimeout(gaplessTransitionTimerRef.current);
      gaplessTransitionTimerRef.current = null;
    }
    const audio = audioRef.current;`
  );

  // The natural ended event may beat a delayed timer (e.g. Windows was busy), so clear the old timer there.
  replaceExactlyOnce(
    'dọn timer Gapless trước khi chuyển track',
    `  const handleNextTrack = useCallback(
    (isAutoEnded = false) => {
      if (queue.length === 0) return;
      const audio = audioRef.current;`,
    `  const handleNextTrack = useCallback(
    (isAutoEnded = false) => {
      if (queue.length === 0) return;
      if (gaplessTransitionTimerRef.current != null) {
        clearTimeout(gaplessTransitionTimerRef.current);
        gaplessTransitionTimerRef.current = null;
      }
      const audio = audioRef.current;`
  );

  const settingsToggle = `                  <label className="flex items-center justify-between gap-3 text-xs text-zinc-300 cursor-pointer py-1">
                    <span>Gapless playback (when Crossfade is Off)</span>
                    <input
                      type="checkbox"
                      checked={Boolean(settings.gaplessPlayback)}
                      onChange={(e) => updateSetting('gaplessPlayback', e.target.checked)}
                      className="accent-amber-500"
                    />
                  </label>

                  <div className="py-1 flex flex-col gap-1.5">
                    <div className="flex items-center justify-between text-xs text-zinc-300">
                      <span>Crossfade between tracks</span>`;
  replaceExactlyOnce(
    'thêm công tắc Gapless vào Settings',
    `                  <div className="py-1 flex flex-col gap-1.5">
                    <div className="flex items-center justify-between text-xs text-zinc-300">
                      <span>Crossfade between tracks</span>`,
    settingsToggle
  );

} catch (error) {
  console.error(`\nKhông sửa file vì bước kiểm tra thất bại: ${error.message}`);
  console.error('File gốc vẫn được giữ nguyên. Hãy gửi thông báo này để điều chỉnh script cho đúng phiên bản App.tsx của bạn.');
  process.exit(1);
}

if (source === original) {
  console.log('Không có thay đổi nào được áp dụng.');
  process.exit(0);
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupPath = `${appPath}.backup-${stamp}`;
fs.copyFileSync(appPath, backupPath);
fs.writeFileSync(appPath, source, 'utf8');
console.log('Đã cập nhật Gapless Playback vào:', appPath);
console.log('Bản sao lưu:', backupPath);
console.log('Các thay đổi đã áp dụng:');
for (const item of applied) console.log(`  ✓ ${item}`);
console.log('\nBây giờ hãy chạy: npm.cmd run build');
console.log('Đây là near-gapless bằng hai HTML audio deck, không bảo đảm sample-accurate như audio engine native.');
