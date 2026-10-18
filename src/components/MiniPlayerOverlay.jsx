import React from 'react';
import {
    Play, Pause, SkipBack, SkipForward, Pin, Maximize2, EyeOff, Disc, Volume2, VolumeX
} from 'lucide-react';

export default function MiniPlayerOverlay({
    currentTrack,
    isPlaying,
    currentTime,
    duration,
    volume,
    isMuted,
    onTogglePlayPause,
    onPrevTrack,
    onNextTrack,
    onSeek,
    onToggleMute,
    onVolumeChange,
    alwaysOnTop,
    onToggleAlwaysOnTop,
    onExitMiniPlayer,
    onHideToTray,
    formatTime
}) {
    return (
        <div className="fixed inset-0 z-50 bg-[#07080c] text-zinc-100 flex flex-col justify-between p-3 select-none overflow-hidden border border-white/15">
            {/* Ambient blurred cover backdrop */}
            {currentTrack?.coverUrl && (
                <img
                    src={currentTrack.coverUrl}
                    alt=""
                    className="pointer-events-none absolute inset-0 w-full h-full object-cover scale-125 blur-2xl opacity-35"
                />
            )}
            <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-black/55 via-black/70 to-black/90" />

            {/* Top Draggable Companion Bar */}
            <div
                data-tauri-drag-region
                style={{ WebkitAppRegion: 'drag' }}
                className="relative z-10 flex items-center justify-between gap-2 pb-1.5 border-b border-white/10"
            >
                <div className="pointer-events-none flex items-center gap-1.5">
                    <Disc className={`w-3.5 h-3.5 text-amber-400 ${isPlaying ? 'animate-spin' : ''}`} style={{ animationDuration: '6s' }} />
                    <span className="text-[10px] font-semibold tracking-[0.22em] text-zinc-200">AURELIA MINI</span>
                </div>

                <div style={{ WebkitAppRegion: 'no-drag' }} className="flex items-center gap-1">
                    <button
                        onClick={onToggleAlwaysOnTop}
                        className={`p-1 rounded-lg border text-xs transition ${alwaysOnTop
                                ? 'bg-amber-500/25 border-amber-400/50 text-amber-300'
                                : 'bg-white/5 border-white/10 text-zinc-400 hover:text-white'
                            }`}
                        title={alwaysOnTop ? 'Always on Top: ON' : 'Always on Top: OFF'}
                    >
                        <Pin className="w-3 h-3" />
                    </button>
                    <button
                        onClick={onHideToTray}
                        className="p-1 rounded-lg bg-white/5 hover:bg-white/10 border border-white/10 text-zinc-400 hover:text-white transition"
                        title="Hide to System Tray (Playback Continues)"
                    >
                        <EyeOff className="w-3 h-3" />
                    </button>
                    <button
                        onClick={onExitMiniPlayer}
                        className="p-1 rounded-lg bg-amber-500 hover:bg-amber-400 text-zinc-950 font-semibold transition"
                        title="Restore Full Desktop Window"
                    >
                        <Maximize2 className="w-3 h-3" />
                    </button>
                </div>
            </div>

            {/* Track Info + Compact Transport Controls */}
            <div className="relative z-10 flex items-center justify-between gap-3 my-auto py-1">
                <div className="flex items-center gap-2.5 min-w-0 flex-1">
                    <div className="w-12 h-12 rounded-xl overflow-hidden bg-zinc-900 ring-1 ring-white/15 shrink-0 shadow-lg">
                        {currentTrack?.coverUrl ? (
                            <img src={currentTrack.coverUrl} alt="" className="w-full h-full object-cover" />
                        ) : (
                            <div className="w-full h-full flex items-center justify-center text-zinc-600">
                                <Disc className="w-5 h-5" />
                            </div>
                        )}
                    </div>
                    <div className="min-w-0 flex-1">
                        <div className="text-xs font-semibold text-white truncate" title={currentTrack?.title}>
                            {currentTrack?.title || 'No Track Selected'}
                        </div>
                        <div className="text-[11px] text-amber-300/90 truncate" title={currentTrack?.artist}>
                            {currentTrack?.artist || 'Aurelia Audio'}
                        </div>
                        <div className="text-[10px] font-mono text-zinc-400">
                            {formatTime(currentTime)} / {formatTime(duration || currentTrack?.duration || 0)}
                        </div>
                    </div>
                </div>

                <div className="flex items-center gap-1.5 shrink-0">
                    <button
                        onClick={onPrevTrack}
                        className="p-1.5 rounded-xl bg-white/10 hover:bg-white/15 text-zinc-100 transition"
                        title="Previous Track"
                    >
                        <SkipBack className="w-3.5 h-3.5" />
                    </button>
                    <button
                        onClick={onTogglePlayPause}
                        className="w-9 h-9 rounded-xl bg-amber-500 hover:bg-amber-400 text-zinc-950 flex items-center justify-center shadow-md transition"
                        title="Play / Pause"
                    >
                        {isPlaying ? <Pause className="w-4 h-4 fill-zinc-950" /> : <Play className="w-4 h-4 fill-zinc-950 ml-0.5" />}
                    </button>
                    <button
                        onClick={onNextTrack}
                        className="p-1.5 rounded-xl bg-white/10 hover:bg-white/15 text-zinc-100 transition"
                        title="Next Track"
                    >
                        <SkipForward className="w-3.5 h-3.5" />
                    </button>
                </div>
            </div>

            {/* Bottom Seek Bar + Volume */}
            <div className="relative z-10 flex items-center gap-2 pt-1">
                <input
                    type="range"
                    min={0}
                    max={Math.max(1, duration || currentTrack?.duration || 1)}
                    step={0.05}
                    value={Math.min(currentTime, duration || currentTrack?.duration || 1)}
                    onChange={(e) => onSeek(parseFloat(e.target.value))}
                    className="flex-1 h-1 bg-white/20 rounded-lg appearance-none cursor-pointer accent-amber-400"
                />
                <button onClick={onToggleMute} className="text-zinc-400 hover:text-white">
                    {isMuted || volume === 0 ? <VolumeX className="w-3.5 h-3.5 text-rose-400" /> : <Volume2 className="w-3.5 h-3.5" />}
                </button>
                <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.01}
                    value={isMuted ? 0 : volume}
                    onChange={(e) => onVolumeChange(parseFloat(e.target.value))}
                    className="w-14 h-1 bg-white/20 rounded-lg appearance-none cursor-pointer accent-amber-400"
                />
            </div>
        </div>
    );
}