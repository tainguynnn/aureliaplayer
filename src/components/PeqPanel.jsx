import React, { useEffect, useRef, useState } from 'react';
import {
    SlidersHorizontal, RotateCcw, Download, Upload, Plus, Copy, Trash2, Edit3, Check, Power
} from 'lucide-react';
import {
    BUILTIN_PEQ_PRESETS,
    FILTER_TYPES,
    createFlatBands,
    computeFrequencyResponseCurve,
    validateImportedPresetJson
} from '../peqEngine';

export default function PeqPanel({
    peqState,
    onChangePeqState,
    customPresets,
    onChangeCustomPresets,
    filterNodesRef,
    showToast
}) {
    const canvasRef = useRef(null);
    const importInputRef = useRef(null);
    const [presetNameInput, setPresetNameInput] = useState('');
    const [renamingId, setRenamingId] = useState(null);

    const allPresets = [...BUILTIN_PEQ_PRESETS, ...(customPresets || [])];
    const activePreset = allPresets.find((p) => p.id === peqState.activePresetId) || null;
    // Draw real-time Frequency Response Graph (20 Hz - 20 kHz, -15 dB to +15 dB)

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        const width = canvas.width;
        const height = canvas.height;
        ctx.clearRect(0, 0, width, height);

        const accentColor =
            getComputedStyle(document.documentElement).getPropertyValue('--accent-hex-400').trim() || '#fbbf24';

        const dbToY = (db) => {
            const clamped = Math.max(-15, Math.min(15, db));
            return height / 2 - (clamped / 15) * (height / 2 - 14);
        };
        const freqToX = (f) => {
            const minL = Math.log10(20);
            const maxL = Math.log10(20000);
            return ((Math.log10(Math.max(20, Math.min(20000, f))) - minL) / (maxL - minL)) * width;
        };

        // Grid lines (-12, -6, 0, +6, +12 dB)
        ctx.lineWidth = 1;
        [-12, -6, 0, 6, 12].forEach((db) => {
            const y = dbToY(db);
            ctx.strokeStyle = db === 0 ? 'rgba(255,255,255,0.22)' : 'rgba(255,255,255,0.06)';
            ctx.beginPath();
            ctx.moveTo(0, y);
            ctx.lineTo(width, y);
            ctx.stroke();

            ctx.fillStyle = 'rgba(161,161,170,0.65)';
            ctx.font = '10px monospace';
            ctx.fillText(`${db > 0 ? `+${db}` : db}dB`, 6, y - 3);
        });

        // Frequency markers
        [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000].forEach((f) => {
            const x = freqToX(f);
            ctx.strokeStyle = 'rgba(255,255,255,0.05)';
            ctx.beginPath();
            ctx.moveTo(x, 0);
            ctx.lineTo(x, height);
            ctx.stroke();

            ctx.fillStyle = 'rgba(161,161,170,0.65)';
            ctx.font = '10px monospace';
            const label = f >= 1000 ? `${f / 1000}k` : `${f}`;
            ctx.fillText(label, Math.max(4, Math.min(width - 24, x - 10)), height - 4);
        });

        // Compute composite response curve
        const { freqs, totalDb } = computeFrequencyResponseCurve(filterNodesRef?.current, peqState, 180);

        ctx.beginPath();
        for (let i = 0; i < freqs.length; i++) {
            const x = freqToX(freqs[i]);
            const y = dbToY(totalDb[i]);
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
        }
        ctx.strokeStyle = peqState.enabled ? accentColor : 'rgba(161,161,170,0.4)';
        ctx.lineWidth = 2.5;
        ctx.stroke();

        // Soft fill under curve to 0 dB line
        ctx.lineTo(width, dbToY(0));
        ctx.lineTo(0, dbToY(0));
        ctx.closePath();
        ctx.fillStyle = peqState.enabled ? `${accentColor}22` : 'rgba(161,161,170,0.06)';
        ctx.fill();

        // Draw nodes for each of the 10 bands
        peqState.bands.forEach((b, idx) => {
            const x = freqToX(b.frequency);
            const y = dbToY(peqState.enabled && b.enabled ? b.gain + peqState.preamp : 0);
            ctx.beginPath();
            ctx.arc(x, y, 4.5, 0, Math.PI * 2);
            ctx.fillStyle = peqState.enabled && b.enabled ? accentColor : '#52525b';
            ctx.fill();
            ctx.strokeStyle = '#09090b';
            ctx.lineWidth = 1.5;
            ctx.stroke();
        });
    }, [peqState, filterNodesRef]);

    const handleSelectPreset = (presetId) => {
        const found = allPresets.find((p) => p.id === presetId);
        if (!found) return;
        onChangePeqState({
            ...peqState,
            activePresetId: found.id,
            preamp: found.preamp,
            bands: found.bands.map((b) => ({ ...b }))
        });
    };

    const handleBandChange = (idx, patch) => {
        const nextBands = peqState.bands.map((b, i) => (i === idx ? { ...b, ...patch } : b));
        onChangePeqState({
            ...peqState,
            activePresetId: activePreset && !activePreset.isBuiltIn ? activePreset.id : 'custom',
            bands: nextBands
        });
    };

    const handleSaveNewPreset = () => {
        const name = (presetNameInput || 'Custom PEQ').trim();
        const newPreset = {
            id: `custom-${Date.now()}`,
            name,
            isBuiltIn: false,
            preamp: peqState.preamp,
            bands: peqState.bands.map((b) => ({ ...b }))
        };
        const nextCustom = [...(customPresets || []), newPreset];
        onChangeCustomPresets(nextCustom);
        onChangePeqState({ ...peqState, activePresetId: newPreset.id });
        setPresetNameInput('');
        showToast(`Saved PEQ preset "${name}"`, 'success');
    };

    const handleUpdateActivePreset = () => {
        if (!activePreset || activePreset.isBuiltIn) return;
        const nextCustom = (customPresets || []).map((p) =>
            p.id === activePreset.id
                ? {
                    ...p,
                    name: presetNameInput.trim() || p.name,
                    preamp: peqState.preamp,
                    bands: peqState.bands.map((b) => ({ ...b }))
                }
                : p
        );
        onChangeCustomPresets(nextCustom);
        setRenamingId(null);
        setPresetNameInput('');
        showToast(`Updated preset "${activePreset.name}"`, 'success');
    };

    const handleDuplicatePreset = () => {
        const baseName = activePreset ? `${activePreset.name} (Copy)` : 'Custom PEQ Copy';
        const dup = {
            id: `custom-${Date.now()}`,
            name: baseName,
            isBuiltIn: false,
            preamp: peqState.preamp,
            bands: peqState.bands.map((b) => ({ ...b }))
        };
        onChangeCustomPresets([...(customPresets || []), dup]);
        onChangePeqState({ ...peqState, activePresetId: dup.id });
        showToast(`Duplicated as "${baseName}"`, 'info');
    };

    const handleDeletePreset = () => {
        if (!activePreset || activePreset.isBuiltIn) return;
        const nextCustom = (customPresets || []).filter((p) => p.id !== activePreset.id);
        onChangeCustomPresets(nextCustom);
        handleSelectPreset('builtin-flat');
        showToast(`Deleted preset "${activePreset.name}"`, 'info');
    };

    const handleExportJson = () => {
        const payload = {
            name: activePreset ? activePreset.name : 'Aurelia Custom PEQ',
            exportedAt: new Date().toISOString(),
            preamp: peqState.preamp,
            bands: peqState.bands
        };
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${payload.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-peq.json`;
        a.click();
        URL.revokeObjectURL(url);
        showToast('Exported 10-band PEQ preset as JSON.', 'success');
    };

    const handleImportJson = async (e) => {
        const file = e.target.files?.[0];
        e.target.value = '';
        if (!file) return;
        try {
            const text = await file.text();
            const parsed = JSON.parse(text);
            const validated = validateImportedPresetJson(parsed);
            onChangeCustomPresets([...(customPresets || []), validated]);
            onChangePeqState({
                ...peqState,
                enabled: true,
                activePresetId: validated.id,
                preamp: validated.preamp,
                bands: validated.bands
            });
            showToast(`Imported PEQ preset "${validated.name}"`, 'success');
        } catch (err) {
            showToast(`Invalid PEQ JSON: ${err.message || 'Parse error'}`, 'error');
        }
    };

    return (
        <div className="aurelia-glass-panel flex-1 min-h-0 overflow-y-auto aurelia-scrollbar rounded-3xl bg-zinc-900/55 border border-white/10 backdrop-blur-2xl p-4 sm:p-5 shadow-2xl flex flex-col gap-4">
            <input
                ref={importInputRef}
                type="file"
                accept=".json,application/json"
                className="hidden"
                onChange={handleImportJson}
            />

            {/* Top Header: Bypass, Preset Selector, Flat Reset, Import/Export */}
            <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-white/[0.07]">
                <div className="flex items-center gap-2.5">
                    <button
                        onClick={() => onChangePeqState({ ...peqState, enabled: !peqState.enabled })}
                        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold transition border ${peqState.enabled
                            ? 'bg-amber-500 text-zinc-950 border-amber-400/50 shadow-md shadow-amber-500/20'
                            : 'bg-white/5 text-zinc-400 border-white/10'
                            }`}
                        title="Enable or Bypass 10-Band Parametric EQ"
                    >
                        <Power className="w-3.5 h-3.5" />
                        <span>{peqState.enabled ? 'PEQ Active' : 'Bypassed'}</span>
                    </button>

                    <select
                        value={peqState.activePresetId || 'custom'}
                        onChange={(e) => handleSelectPreset(e.target.value)}
                        className="px-3 py-1.5 rounded-xl bg-zinc-950/80 border border-white/10 text-xs text-zinc-100 focus:outline-none focus:border-amber-400/50"
                    >
                        <optgroup label="Built-in Audiophile Presets" className="bg-zinc-900">
                            {BUILTIN_PEQ_PRESETS.map((p) => (
                                <option key={p.id} value={p.id}>
                                    {p.name}
                                </option>
                            ))}
                        </optgroup>
                        {customPresets?.length > 0 && (
                            <optgroup label="Custom User Presets" className="bg-zinc-900">
                                {customPresets.map((p) => (
                                    <option key={p.id} value={p.id}>
                                        {p.name}
                                    </option>
                                ))}
                            </optgroup>
                        )}
                        <option value="custom" className="bg-zinc-900">
                            Unsaved Custom Curve
                        </option>
                    </select>

                    <button
                        onClick={() =>
                            onChangePeqState({
                                ...peqState,
                                activePresetId: 'builtin-flat',
                                preamp: 0,
                                bands: createFlatBands()
                            })
                        }
                        className="px-2.5 py-1.5 rounded-xl bg-white/5 hover:bg-white/10 border border-white/10 text-xs text-zinc-300 flex items-center gap-1"
                        title="Reset all bands and preamp to 0 dB Flat"
                    >
                        <RotateCcw className="w-3.5 h-3.5 text-amber-400" />
                        <span>Flat</span>
                    </button>
                </div>

                <div className="flex flex-wrap items-center gap-1.5">
                    <input
                        type="text"
                        value={presetNameInput}
                        onChange={(e) => setPresetNameInput(e.target.value)}
                        placeholder={activePreset && !activePreset.isBuiltIn ? activePreset.name : 'Preset name...'}
                        className="px-2.5 py-1 rounded-xl bg-zinc-950/75 border border-white/10 text-xs text-white placeholder-zinc-500 w-32 focus:outline-none focus:border-amber-400/50"
                    />
                    <button
                        onClick={handleSaveNewPreset}
                        className="p-1.5 rounded-xl bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 border border-amber-500/30 text-xs flex items-center gap-1 px-2.5"
                        title="Save as New Custom Preset"
                    >
                        <Plus className="w-3.5 h-3.5" />
                        <span>Save New</span>
                    </button>
                    {activePreset && !activePreset.isBuiltIn && (
                        <>
                            <button
                                onClick={handleUpdateActivePreset}
                                className="p-1.5 rounded-xl bg-white/5 hover:bg-white/10 text-emerald-300 border border-white/10 text-xs flex items-center gap-1 px-2"
                                title="Update / Rename Selected Custom Preset"
                            >
                                <Check className="w-3.5 h-3.5" />
                                <span>Update</span>
                            </button>
                            <button
                                onClick={handleDeletePreset}
                                className="p-1.5 rounded-xl bg-rose-500/15 hover:bg-rose-500/25 text-rose-300 border border-rose-500/30"
                                title="Delete Custom Preset"
                            >
                                <Trash2 className="w-3.5 h-3.5" />
                            </button>
                        </>
                    )}
                    <button
                        onClick={handleDuplicatePreset}
                        className="p-1.5 rounded-xl bg-white/5 hover:bg-white/10 text-zinc-300 border border-white/10"
                        title="Duplicate Preset"
                    >
                        <Copy className="w-3.5 h-3.5" />
                    </button>
                    <button
                        onClick={() => importInputRef.current?.click()}
                        className="p-1.5 rounded-xl bg-white/5 hover:bg-white/10 text-zinc-300 border border-white/10"
                        title="Import PEQ JSON"
                    >
                        <Upload className="w-3.5 h-3.5" />
                    </button>
                    <button
                        onClick={handleExportJson}
                        className="p-1.5 rounded-xl bg-white/5 hover:bg-white/10 text-zinc-300 border border-white/10"
                        title="Export PEQ JSON"
                    >
                        <Download className="w-3.5 h-3.5" />
                    </button>
                </div>
            </div>

            {/* Real-time Frequency Response Graph + Preamp Control */}
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-3 items-stretch">
                <div className="lg:col-span-9 rounded-2xl bg-zinc-950/75 border border-white/[0.07] p-3 flex flex-col justify-between">
                    <div className="flex items-center justify-between text-[11px] text-zinc-400 mb-1.5">
                        <span className="font-semibold uppercase tracking-wider flex items-center gap-1.5 text-zinc-300">
                            <SlidersHorizontal className="w-3.5 h-3.5 text-amber-400" />
                            10-Band Parametric Frequency Response (20 Hz – 20 kHz)
                        </span>
                        <span className="font-mono text-[10px]">
                            Preamp {peqState.preamp > 0 ? `+${peqState.preamp}` : peqState.preamp} dB
                        </span>
                    </div>
                    <canvas
                        ref={canvasRef}
                        width={680}
                        height={165}
                        className="w-full h-[155px] rounded-xl bg-black/25"
                    />
                </div>

                <div className="lg:col-span-3 rounded-2xl bg-zinc-950/75 border border-white/[0.07] p-3.5 flex flex-col justify-between">
                    <div>
                        <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">
                            Preamp Headroom
                        </span>
                        <div className="text-xl font-mono font-bold text-amber-300 mt-1">
                            {peqState.preamp > 0 ? `+${peqState.preamp.toFixed(1)}` : peqState.preamp.toFixed(1)} dB
                        </div>
                        <p className="text-[11px] text-zinc-400 mt-1 leading-relaxed">
                            Reduce preamp gain when boosting bands to prevent digital inter-sample clipping.
                        </p>
                    </div>
                    <div className="mt-3">
                        <input
                            type="range"
                            min={-12}
                            max={12}
                            step={0.1}
                            value={peqState.preamp}
                            onChange={(e) =>
                                onChangePeqState({
                                    ...peqState,
                                    preamp: parseFloat(e.target.value)
                                })
                            }
                            className="w-full h-1.5 bg-white/15 rounded-lg appearance-none cursor-pointer accent-amber-400"
                        />
                        <div className="flex justify-between text-[10px] font-mono text-zinc-500 mt-1">
                            <span>-12 dB</span>
                            <button
                                onClick={() => onChangePeqState({ ...peqState, preamp: 0 })}
                                className="hover:text-amber-300"
                            >
                                0 dB
                            </button>
                            <span>+12 dB</span>
                        </div>
                    </div>
                </div>
            </div>

            {/* 10 Parametric Band Channel Strips */}
            <div className="grid grid-cols-2 sm:grid-cols-5 lg:grid-cols-10 gap-2">
                {peqState.bands.map((band, idx) => (
                    <div
                        key={band.id}
                        className={`p-2.5 rounded-2xl border flex flex-col justify-between gap-2 transition ${band.enabled && peqState.enabled
                            ? 'bg-zinc-950/70 border-white/10'
                            : 'bg-zinc-950/30 border-white/[0.04] opacity-55'
                            }`}
                    >
                        <div className="flex items-center justify-between gap-1">
                            <span className="text-[10px] font-mono font-semibold text-amber-300">
                                B{idx + 1}
                            </span>
                            <input
                                type="checkbox"
                                checked={band.enabled}
                                onChange={(e) => handleBandChange(idx, { enabled: e.target.checked })}
                                className="accent-amber-500 cursor-pointer"
                                title={`Enable Band ${idx + 1}`}
                            />
                        </div>

                        {/* Filter Type */}
                        <select
                            value={band.type}
                            onChange={(e) => handleBandChange(idx, { type: e.target.value })}
                            className="w-full px-1.5 py-1 rounded-lg bg-zinc-900 border border-white/10 text-[10px] text-zinc-200 focus:outline-none"
                            title="Filter Type"
                        >
                            {FILTER_TYPES.map((ft) => (
                                <option key={ft.id} value={ft.id} className="bg-zinc-900">
                                    {ft.label}
                                </option>
                            ))}
                        </select>

                        {/* Gain Slider (-12 dB to +12 dB) */}
                        <div className="flex flex-col items-center my-1">
                            <span className="text-[11px] font-mono font-semibold text-white mb-1">
                                {band.gain > 0 ? `+${band.gain.toFixed(1)}` : band.gain.toFixed(1)} dB
                            </span>
                            <input
                                type="range"
                                min={-12}
                                max={12}
                                step={0.1}
                                value={band.gain}
                                onDoubleClick={() => handleBandChange(idx, { gain: 0 })}
                                onChange={(e) => handleBandChange(idx, { gain: parseFloat(e.target.value) })}
                                className="w-full h-1.5 bg-white/15 rounded-lg appearance-none cursor-pointer accent-amber-400"
                                title="Gain (dB) — Double-click to reset to 0 dB"
                            />
                        </div>

                        {/* Frequency Input (20 - 20000 Hz) */}
                        <div className="flex flex-col gap-0.5">
                            <label className="text-[9px] uppercase tracking-wider text-zinc-500">Freq (Hz)</label>
                            <input
                                type="number"
                                min={20}
                                max={20000}
                                step={1}
                                value={Math.round(band.frequency)}
                                onChange={(e) =>
                                    handleBandChange(idx, {
                                        frequency: Math.max(20, Math.min(20000, Number(e.target.value) || 20))
                                    })
                                }
                                className="w-full px-1.5 py-1 rounded-lg bg-zinc-900/90 border border-white/10 text-[11px] font-mono text-zinc-100 focus:outline-none focus:border-amber-400/50"
                            />
                        </div>

                        {/* Q Factor Input (0.1 - 18.0) */}
                        <div className="flex flex-col gap-0.5">
                            <label className="text-[9px] uppercase tracking-wider text-zinc-500">Q Factor</label>
                            <input
                                type="number"
                                min={0.1}
                                max={18}
                                step={0.05}
                                value={band.q}
                                onChange={(e) =>
                                    handleBandChange(idx, {
                                        q: Math.max(0.1, Math.min(18, parseFloat(e.target.value) || 0.71))
                                    })
                                }
                                className="w-full px-1.5 py-1 rounded-lg bg-zinc-900/90 border border-white/10 text-[11px] font-mono text-zinc-100 focus:outline-none focus:border-amber-400/50"
                            />
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
}