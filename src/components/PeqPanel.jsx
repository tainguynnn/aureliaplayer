import React, { useEffect, useRef, useState } from 'react';
import {
    SlidersHorizontal,
    RotateCcw,
    Download,
    Upload,
    Plus,
    Minus,
    Copy,
    Trash2,
    Check,
    Power,
    FileText,
    X,
    Sparkles,
    FileCode
} from 'lucide-react';
import {
    BUILTIN_PEQ_PRESETS,
    FILTER_TYPES,
    createFlatBands,
    computeFrequencyResponseCurve,
    validateImportedPresetJson,
    parseEqualizerApoText,
    exportToEqualizerApoText,
    isEqualizerApoText
} from '../peqEngine';

function PeqPanel({
    peqState,
    onChangePeqState,
    customPresets,
    onChangeCustomPresets,
    filterNodesRef,
    showToast,
    t = (k) => k
}) {
    const canvasRef = useRef(null);
    const importInputRef = useRef(null);
    const [presetNameInput, setPresetNameInput] = useState('');
    const [isImportModalOpen, setIsImportModalOpen] = useState(false);
    const [pasteText, setPasteText] = useState('');
    const [importPresetTitle, setImportPresetTitle] = useState('');
    const [showExportMenu, setShowExportMenu] = useState(false);

    const allPresets = [...BUILTIN_PEQ_PRESETS, ...(customPresets || [])];
    const activePreset = allPresets.find((p) => p.id === peqState.activePresetId) || null;

    // Real-time Frequency Response Graph (20 Hz - 20 kHz, -15 dB to +15 dB)
    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        const width = canvas.width;
        const height = canvas.height;
        ctx.clearRect(0, 0, width, height);

        const isLight = document.documentElement.getAttribute('data-theme') === 'light';
        const accentColor = isLight
            ? (getComputedStyle(document.documentElement).getPropertyValue('--accent-hex-600').trim() || '#d97706')
            : (getComputedStyle(document.documentElement).getPropertyValue('--accent-hex-400').trim() || '#fbbf24');

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
            ctx.strokeStyle = db === 0
                ? (isLight ? 'rgba(15, 23, 42, 0.28)' : 'rgba(255, 255, 255, 0.22)')
                : (isLight ? 'rgba(15, 23, 42, 0.08)' : 'rgba(255, 255, 255, 0.06)');
            ctx.beginPath();
            ctx.moveTo(0, y);
            ctx.lineTo(width, y);
            ctx.stroke();

            ctx.fillStyle = isLight ? 'rgba(51, 65, 85, 0.85)' : 'rgba(161, 161, 170, 0.65)';
            ctx.font = '10px monospace';
            ctx.fillText(`${db > 0 ? `+${db}` : db}dB`, 6, y - 3);
        });

        // Frequency markers
        [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000].forEach((f) => {
            const x = freqToX(f);
            ctx.strokeStyle = isLight ? 'rgba(15, 23, 42, 0.08)' : 'rgba(255, 255, 255, 0.05)';
            ctx.beginPath();
            ctx.moveTo(x, 0);
            ctx.lineTo(x, height);
            ctx.stroke();

            ctx.fillStyle = isLight ? 'rgba(51, 65, 85, 0.85)' : 'rgba(161, 161, 170, 0.65)';
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
        ctx.strokeStyle = peqState.enabled ? accentColor : (isLight ? 'rgba(100, 116, 139, 0.6)' : 'rgba(161,161,170,0.4)');
        ctx.lineWidth = 2.5;
        ctx.stroke();

        // Soft fill under curve to 0 dB line
        ctx.lineTo(width, dbToY(0));
        ctx.lineTo(0, dbToY(0));
        ctx.closePath();
        ctx.fillStyle = peqState.enabled ? `${accentColor}25` : (isLight ? 'rgba(15, 23, 42, 0.04)' : 'rgba(161,161,170,0.06)');
        ctx.fill();

        // Draw nodes for each of the 10 bands
        peqState.bands.forEach((b) => {
            const x = freqToX(b.frequency);
            const y = dbToY(peqState.enabled && b.enabled ? b.gain + peqState.preamp : 0);
            ctx.beginPath();
            ctx.arc(x, y, 4.5, 0, Math.PI * 2);
            ctx.fillStyle = peqState.enabled && b.enabled ? accentColor : (isLight ? '#94a3b8' : '#52525b');
            ctx.fill();
            ctx.strokeStyle = isLight ? '#ffffff' : '#09090b';
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
        const updatedPeq = {
            ...peqState,
            activePresetId: activePreset && !activePreset.isBuiltIn ? activePreset.id : 'custom',
            bands: nextBands
        };
        onChangePeqState(updatedPeq);

        // Auto-sync custom preset so tweaks are preserved immediately
        if (activePreset && !activePreset.isBuiltIn) {
            const nextCustom = (customPresets || []).map((p) =>
                p.id === activePreset.id ? { ...p, bands: nextBands } : p
            );
            onChangeCustomPresets(nextCustom);
        }
    };

    const handleGainStep = (idx, delta) => {
        const band = peqState.bands[idx];
        if (!band) return;
        const nextGain = Math.max(-12, Math.min(12, Number((band.gain + delta).toFixed(1))));
        handleBandChange(idx, { gain: nextGain });
    };

    const handlePreampStep = (delta) => {
        const nextPreamp = Math.max(-12, Math.min(12, Number((peqState.preamp + delta).toFixed(1))));
        const updatedPeq = {
            ...peqState,
            preamp: nextPreamp
        };
        onChangePeqState(updatedPeq);

        if (activePreset && !activePreset.isBuiltIn) {
            const nextCustom = (customPresets || []).map((p) =>
                p.id === activePreset.id ? { ...p, preamp: nextPreamp } : p
            );
            onChangeCustomPresets(nextCustom);
        }
    };

    const handleSaveNewPreset = () => {
        const name = (presetNameInput || (activePreset ? `${activePreset.name} (Custom)` : 'Custom PEQ')).trim();
        const newPreset = {
            id: `custom-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            name,
            isBuiltIn: false,
            preamp: peqState.preamp,
            bands: peqState.bands.map((b) => ({ ...b }))
        };
        const nextCustom = [...(customPresets || []), newPreset];
        try {
            localStorage.setItem('aurelia_custom_peq_presets', JSON.stringify(nextCustom));
            localStorage.setItem('aurelia_peq_state', JSON.stringify({ ...peqState, activePresetId: newPreset.id }));
        } catch {}
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
        try {
            localStorage.setItem('aurelia_custom_peq_presets', JSON.stringify(nextCustom));
        } catch {}
        onChangeCustomPresets(nextCustom);
        setPresetNameInput('');
        showToast(`Updated preset "${activePreset.name}"`, 'success');
    };

    const handleDuplicatePreset = () => {
        const baseName = activePreset ? `${activePreset.name} (Copy)` : 'Custom PEQ Copy';
        const dup = {
            id: `custom-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            name: baseName,
            isBuiltIn: false,
            preamp: peqState.preamp,
            bands: peqState.bands.map((b) => ({ ...b }))
        };
        const nextCustom = [...(customPresets || []), dup];
        try {
            localStorage.setItem('aurelia_custom_peq_presets', JSON.stringify(nextCustom));
            localStorage.setItem('aurelia_peq_state', JSON.stringify({ ...peqState, activePresetId: dup.id }));
        } catch {}
        onChangeCustomPresets(nextCustom);
        onChangePeqState({ ...peqState, activePresetId: dup.id });
        showToast(`Duplicated as "${baseName}"`, 'info');
    };

    const handleDeletePreset = () => {
        if (!activePreset || activePreset.isBuiltIn) return;
        const nextCustom = (customPresets || []).filter((p) => p.id !== activePreset.id);
        try {
            localStorage.setItem('aurelia_custom_peq_presets', JSON.stringify(nextCustom));
        } catch {}
        onChangeCustomPresets(nextCustom);
        handleSelectPreset('builtin-flat');
        showToast(`Deleted preset "${activePreset.name}"`, 'info');
    };

    const handleExportJson = () => {
        setShowExportMenu(false);
        const presetName = activePreset ? activePreset.name : 'Aurelia Custom PEQ';
        const payload = {
            name: presetName,
            exportedAt: new Date().toISOString(),
            preamp: peqState.preamp,
            bands: peqState.bands
        };
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${presetName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-peq.json`;
        a.click();
        URL.revokeObjectURL(url);
        showToast('Exported EQ preset as JSON.', 'success');
    };

    const handleExportApoText = () => {
        setShowExportMenu(false);
        const presetName = activePreset ? activePreset.name : 'Aurelia Parametric EQ';
        const text = exportToEqualizerApoText(peqState, presetName);
        const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${presetName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-apo.txt`;
        a.click();
        URL.revokeObjectURL(url);
        showToast('Exported EQ preset as Equalizer APO .txt format.', 'success');
    };

    const processImportedContent = (rawText, sourceName = '') => {
        const trimmed = (rawText || '').trim();
        if (!trimmed) {
            throw new Error('EQ content is empty.');
        }

        let validated = null;
        if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
            try {
                const parsed = JSON.parse(trimmed);
                validated = validateImportedPresetJson(parsed);
            } catch {
                // Not valid JSON, fallback to APO parser below
            }
        }

        if (!validated) {
            validated = parseEqualizerApoText(trimmed, sourceName || importPresetTitle || 'Imported EQ');
        }

        if (importPresetTitle.trim()) {
            validated.name = importPresetTitle.trim();
        }

        const nextCustom = [...(customPresets || []), validated];
        const nextPeqState = {
            ...peqState,
            enabled: true,
            activePresetId: validated.id,
            preamp: validated.preamp,
            bands: validated.bands
        };

        try {
            localStorage.setItem('aurelia_custom_peq_presets', JSON.stringify(nextCustom));
            localStorage.setItem('aurelia_peq_state', JSON.stringify(nextPeqState));
        } catch {}

        onChangeCustomPresets(nextCustom);
        onChangePeqState(nextPeqState);

        setIsImportModalOpen(false);
        setPasteText('');
        setImportPresetTitle('');
        showToast(`Imported EQ profile "${validated.name}"`, 'success');
    };

    const handleImportFile = async (e) => {
        const file = e.target.files?.[0];
        e.target.value = '';
        if (!file) return;
        try {
            const text = await file.text();
            processImportedContent(text, file.name);
        } catch (err) {
            showToast(`Import error: ${err.message || 'Could not parse file'}`, 'error');
        }
    };

    const handlePasteImportSubmit = (e) => {
        e?.preventDefault();
        try {
            processImportedContent(pasteText, importPresetTitle || 'Pasted Parametric EQ');
        } catch (err) {
            showToast(`Import error: ${err.message || 'Invalid format'}`, 'error');
        }
    };

    const formatFreq = (hz) => {
        if (hz >= 1000) {
            const k = hz / 1000;
            return `${Number.isInteger(k) ? k : k.toFixed(1)}k`;
        }
        return `${Math.round(hz)}`;
    };

    const renderBandCard = (band, idx) => (
        <div
            key={band.id}
            className={`p-3 rounded-2xl border flex flex-col justify-between gap-2.5 transition-all duration-200 ${band.enabled && peqState.enabled
                ? 'bg-zinc-950/75 border-white/10 hover:border-white/20 shadow-lg'
                : 'bg-zinc-950/35 border-white/[0.04] opacity-55'
                }`}
        >
            {/* Header: Band number, Frequency Tag, On/Off toggle */}
            <div className="flex items-center justify-between gap-1.5">
                <div className="flex items-center gap-1.5 min-w-0">
                    <span className="px-2 py-0.5 rounded-md bg-amber-500/15 border border-amber-500/30 text-amber-300 font-mono text-[11px] font-bold">
                        B{idx + 1}
                    </span>
                    <span className="text-[11px] font-mono text-zinc-300 truncate">
                        {formatFreq(band.frequency)} Hz
                    </span>
                </div>

                <button
                    type="button"
                    onClick={() => handleBandChange(idx, { enabled: !band.enabled })}
                    className={`px-2 py-0.5 rounded-full text-[10px] font-semibold transition border flex items-center gap-1 ${band.enabled && peqState.enabled
                        ? 'bg-emerald-500/15 border-emerald-500/35 text-emerald-400'
                        : 'bg-zinc-800/80 border-white/5 text-zinc-500 hover:text-zinc-400'
                        }`}
                    title={band.enabled ? 'Click to bypass band' : 'Click to enable band'}
                >
                    <span
                        className={`w-1.5 h-1.5 rounded-full ${band.enabled && peqState.enabled
                            ? 'bg-emerald-400 shadow-sm shadow-emerald-400'
                            : 'bg-zinc-600'
                            }`}
                    />
                    <span>{band.enabled ? 'ON' : 'OFF'}</span>
                </button>
            </div>

            {/* Filter Type Selector */}
            <div className="flex flex-col gap-1">
                <label className="text-[9px] uppercase tracking-wider text-zinc-500 font-semibold">
                    Filter Type
                </label>
                <select
                    value={band.type}
                    onChange={(e) => handleBandChange(idx, { type: e.target.value })}
                    className="w-full px-2 py-1 rounded-xl bg-zinc-900/90 border border-white/10 text-[11px] text-zinc-200 focus:outline-none focus:border-amber-400/50"
                >
                    {FILTER_TYPES.map((ft) => (
                        <option key={ft.id} value={ft.id} className="bg-zinc-900">
                            {ft.label}
                        </option>
                    ))}
                </select>
            </div>

            {/* Gain (dB) Control with explicit + and - stepper buttons */}
            <div className="flex flex-col gap-1 bg-black/25 p-2 rounded-xl border border-white/[0.04]">
                <div className="flex items-center justify-between">
                    <span className="text-[9px] uppercase tracking-wider text-zinc-500 font-semibold">
                        Gain (dB)
                    </span>
                    <button
                        type="button"
                        onClick={() => handleBandChange(idx, { gain: 0 })}
                        className={`text-xs font-mono font-bold transition px-1.5 py-0.5 rounded hover:scale-105 active:scale-95 ${band.gain > 0
                            ? 'text-amber-400 bg-amber-500/10'
                            : band.gain < 0
                                ? 'text-sky-400 bg-sky-500/10'
                                : 'text-zinc-400 hover:text-white'
                            }`}
                        title="Click to reset Gain to 0.0 dB"
                    >
                        {band.gain > 0 ? `+${band.gain.toFixed(1)}` : band.gain.toFixed(1)} dB
                    </button>
                </div>

                <div className="flex items-center gap-1.5 mt-0.5">
                    <button
                        type="button"
                        onClick={(e) => handleGainStep(idx, e.shiftKey ? -0.5 : -0.1)}
                        className="w-6 h-6 rounded-lg bg-white/5 hover:bg-white/15 border border-white/10 text-zinc-300 hover:text-white flex items-center justify-center transition active:scale-95 shrink-0"
                        title="Decrease Gain (-0.1 dB, Shift+click for -0.5 dB)"
                    >
                        <Minus className="w-3.5 h-3.5" />
                    </button>

                    <div className="flex-1 relative flex items-center">
                        <input
                            type="range"
                            min={-12}
                            max={12}
                            step={0.1}
                            value={band.gain}
                            onDoubleClick={() => handleBandChange(idx, { gain: 0 })}
                            onChange={(e) => handleBandChange(idx, { gain: parseFloat(e.target.value) })}
                            className="w-full h-1.5 rounded-full appearance-none cursor-pointer accent-amber-400"
                            title="Gain (dB) — Double-click to reset to 0 dB"
                        />
                    </div>

                    <button
                        type="button"
                        onClick={(e) => handleGainStep(idx, e.shiftKey ? +0.5 : +0.1)}
                        className="w-6 h-6 rounded-lg bg-white/5 hover:bg-white/15 border border-white/10 text-zinc-300 hover:text-white flex items-center justify-center transition active:scale-95 shrink-0"
                        title="Increase Gain (+0.1 dB, Shift+click for +0.5 dB)"
                    >
                        <Plus className="w-3.5 h-3.5" />
                    </button>
                </div>
            </div>

            {/* Frequency & Q Factor Controls (Side by Side) */}
            <div className="grid grid-cols-2 gap-2 mt-0.5">
                <div className="flex flex-col gap-0.5">
                    <label className="text-[9px] uppercase tracking-wider text-zinc-500 font-semibold truncate">
                        Freq (Hz)
                    </label>
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
                        className="w-full px-2 py-1 rounded-lg bg-zinc-900/90 border border-white/10 text-xs font-mono text-zinc-100 focus:outline-none focus:border-amber-400/50"
                    />
                </div>

                <div className="flex flex-col gap-0.5">
                    <label className="text-[9px] uppercase tracking-wider text-zinc-500 font-semibold truncate">
                        Q Factor
                    </label>
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
                        className="w-full px-2 py-1 rounded-lg bg-zinc-900/90 border border-white/10 text-xs font-mono text-zinc-100 focus:outline-none focus:border-amber-400/50"
                    />
                </div>
            </div>
        </div>
    );

    return (
        <div className="aurelia-glass-panel flex-1 min-h-0 overflow-y-auto aurelia-scrollbar rounded-3xl bg-zinc-900/55 border border-white/10 backdrop-blur-2xl p-4 sm:p-5 shadow-2xl flex flex-col gap-4">
            <input
                ref={importInputRef}
                type="file"
                accept=".txt,.json,.peq,.eq,text/plain,application/json"
                className="hidden"
                onChange={handleImportFile}
            />

            {/* Top Toolbar: Bypass, Preset Selector, Flat Reset, Preset Management & Import/Export */}
            <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-white/[0.07]">
                <div className="flex flex-wrap items-center gap-2.5">
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
                        className="px-2.5 py-1.5 rounded-xl bg-white/5 hover:bg-white/10 border border-white/10 text-xs text-zinc-300 flex items-center gap-1 transition"
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
                        className="p-1.5 rounded-xl bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 border border-amber-500/30 text-xs flex items-center gap-1 px-2.5 transition"
                        title="Save as New Custom Preset"
                    >
                        <Plus className="w-3.5 h-3.5" />
                        <span>Save</span>
                    </button>
                    {activePreset && !activePreset.isBuiltIn && (
                        <>
                            <button
                                onClick={handleUpdateActivePreset}
                                className="p-1.5 rounded-xl bg-white/5 hover:bg-white/10 text-emerald-300 border border-white/10 text-xs flex items-center gap-1 px-2 transition"
                                title="Update Selected Custom Preset"
                            >
                                <Check className="w-3.5 h-3.5" />
                                <span>Update</span>
                            </button>
                            <button
                                onClick={handleDeletePreset}
                                className="p-1.5 rounded-xl bg-rose-500/15 hover:bg-rose-500/25 text-rose-300 border border-rose-500/30 transition"
                                title="Delete Custom Preset"
                            >
                                <Trash2 className="w-3.5 h-3.5" />
                            </button>
                        </>
                    )}
                    <button
                        onClick={handleDuplicatePreset}
                        className="p-1.5 rounded-xl bg-white/5 hover:bg-white/10 text-zinc-300 border border-white/10 transition"
                        title="Duplicate Preset"
                    >
                        <Copy className="w-3.5 h-3.5" />
                    </button>

                    {/* Import Button: Opens Import / Paste EQ Modal */}
                    <button
                        onClick={() => setIsImportModalOpen(true)}
                        className="p-1.5 rounded-xl bg-white/5 hover:bg-white/10 text-zinc-300 hover:text-amber-300 border border-white/10 text-xs flex items-center gap-1.5 px-2.5 transition"
                        title="Import EQ (Equalizer APO .txt / AutoEq / JSON)"
                    >
                        <Upload className="w-3.5 h-3.5 text-amber-400" />
                        <span>Import EQ</span>
                    </button>

                    {/* Export Dropdown Menu */}
                    <div className="relative">
                        <button
                            onClick={() => setShowExportMenu(!showExportMenu)}
                            className="p-1.5 rounded-xl bg-white/5 hover:bg-white/10 text-zinc-300 hover:text-amber-300 border border-white/10 text-xs flex items-center gap-1.5 px-2.5 transition"
                            title="Export EQ Profile"
                        >
                            <Download className="w-3.5 h-3.5 text-amber-400" />
                            <span>Export</span>
                        </button>
                        {showExportMenu && (
                            <div className="absolute right-0 top-full mt-1.5 w-48 rounded-xl bg-zinc-950/95 border border-white/10 backdrop-blur-xl shadow-2xl p-1 z-30 flex flex-col gap-0.5">
                                <button
                                    onClick={handleExportApoText}
                                    className="w-full text-left px-3 py-2 rounded-lg text-xs text-zinc-200 hover:bg-amber-500/15 hover:text-amber-300 flex items-center gap-2 transition"
                                >
                                    <FileText className="w-3.5 h-3.5 text-amber-400" />
                                    <span>Equalizer APO (.txt)</span>
                                </button>
                                <button
                                    onClick={handleExportJson}
                                    className="w-full text-left px-3 py-2 rounded-lg text-xs text-zinc-200 hover:bg-amber-500/15 hover:text-amber-300 flex items-center gap-2 transition"
                                >
                                    <FileCode className="w-3.5 h-3.5 text-amber-400" />
                                    <span>Aurelia Preset (.json)</span>
                                </button>
                            </div>
                        )}
                    </div>
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
                        <span className="font-mono text-[10px] text-amber-300">
                            Preamp {peqState.preamp > 0 ? `+${peqState.preamp.toFixed(1)}` : peqState.preamp.toFixed(1)} dB
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

                        {/* Preamp with + and - stepper buttons */}
                        <div className="flex items-center justify-between mt-1.5">
                            <div className="flex items-center gap-2">
                                <button
                                    type="button"
                                    onClick={(e) => handlePreampStep(e.shiftKey ? -0.5 : -0.1)}
                                    className="w-7 h-7 rounded-lg bg-white/5 hover:bg-white/15 border border-white/10 flex items-center justify-center text-zinc-300 hover:text-white transition active:scale-95"
                                    title="Decrease Preamp (-0.1 dB, Shift+click for -0.5 dB)"
                                >
                                    <Minus className="w-3.5 h-3.5" />
                                </button>
                                <span className="text-xl font-mono font-bold text-amber-300">
                                    {peqState.preamp > 0 ? `+${peqState.preamp.toFixed(1)}` : peqState.preamp.toFixed(1)} dB
                                </span>
                                <button
                                    type="button"
                                    onClick={(e) => handlePreampStep(e.shiftKey ? +0.5 : +0.1)}
                                    className="w-7 h-7 rounded-lg bg-white/5 hover:bg-white/15 border border-white/10 flex items-center justify-center text-zinc-300 hover:text-white transition active:scale-95"
                                    title="Increase Preamp (+0.1 dB, Shift+click for +0.5 dB)"
                                >
                                    <Plus className="w-3.5 h-3.5" />
                                </button>
                            </div>
                        </div>

                        <p className="text-[11px] text-zinc-400 mt-2 leading-relaxed">
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
                            onDoubleClick={() => {
                                const updated = { ...peqState, preamp: 0 };
                                onChangePeqState(updated);
                                if (activePreset && !activePreset.isBuiltIn) {
                                    const nextCustom = (customPresets || []).map((p) =>
                                        p.id === activePreset.id ? { ...p, preamp: 0 } : p
                                    );
                                    onChangeCustomPresets(nextCustom);
                                }
                            }}
                            onChange={(e) => {
                                const val = parseFloat(e.target.value);
                                const updated = { ...peqState, preamp: val };
                                onChangePeqState(updated);
                                if (activePreset && !activePreset.isBuiltIn) {
                                    const nextCustom = (customPresets || []).map((p) =>
                                        p.id === activePreset.id ? { ...p, preamp: val } : p
                                    );
                                    onChangeCustomPresets(nextCustom);
                                }
                            }}
                            className="w-full h-1.5 rounded-full appearance-none cursor-pointer accent-amber-400"
                        />
                        <div className="flex justify-between text-[10px] font-mono text-zinc-500 mt-1">
                            <span>-12 dB</span>
                            <button
                                type="button"
                                onClick={() => {
                                    const updated = { ...peqState, preamp: 0 };
                                    onChangePeqState(updated);
                                    if (activePreset && !activePreset.isBuiltIn) {
                                        const nextCustom = (customPresets || []).map((p) =>
                                            p.id === activePreset.id ? { ...p, preamp: 0 } : p
                                        );
                                        onChangeCustomPresets(nextCustom);
                                    }
                                }}
                                className="hover:text-amber-300 transition"
                                title="Reset Preamp to 0 dB"
                            >
                                0 dB
                            </button>
                            <span>+12 dB</span>
                        </div>
                    </div>
                </div>
            </div>

            {/* Reorganized EQ Bands: Split into 2 Rows (5 Bands each) */}
            <div className="flex flex-col gap-4 mt-1">
                {/* ROW 1: Bands 1 – 5 */}
                <div className="flex flex-col gap-2">
                    <div className="flex items-center justify-between px-1">
                        <div className="flex items-center gap-2">
                            <span className="w-2 h-2 rounded-full bg-amber-400 shadow-sm shadow-amber-400/50" />
                            <span className="text-xs font-semibold uppercase tracking-wider text-zinc-200">
                                Low & Mid Frequencies (Band 1 – 5)
                            </span>
                        </div>
                        <span className="text-[11px] text-zinc-500 font-mono hidden sm:inline">
                            Sub-bass • Bass • Lower Midrange
                        </span>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
                        {peqState.bands.slice(0, 5).map((band, idx) => renderBandCard(band, idx))}
                    </div>
                </div>

                {/* ROW 2: Bands 6 – 10 */}
                <div className="flex flex-col gap-2 pt-2 border-t border-white/[0.05]">
                    <div className="flex items-center justify-between px-1">
                        <div className="flex items-center gap-2">
                            <span className="w-2 h-2 rounded-full bg-amber-400 shadow-sm shadow-amber-400/50" />
                            <span className="text-xs font-semibold uppercase tracking-wider text-zinc-200">
                                High & Air Frequencies (Band 6 – 10)
                            </span>
                        </div>
                        <span className="text-[11px] text-zinc-500 font-mono hidden sm:inline">
                            Upper Midrange • Presence • Treble / Air
                        </span>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
                        {peqState.bands.slice(5, 10).map((band, i) => renderBandCard(band, i + 5))}
                    </div>
                </div>
            </div>

            {/* Import EQ Modal: Supports file browsing or pasting Equalizer APO / AutoEq text directly */}
            {isImportModalOpen && (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-md animate-fade-in">
                    <div className="w-full max-w-xl rounded-3xl bg-zinc-950 border border-white/15 p-5 sm:p-6 shadow-2xl flex flex-col gap-4 max-h-[90vh] overflow-y-auto aurelia-scrollbar">
                        <div className="flex items-center justify-between pb-3 border-b border-white/10">
                            <div className="flex items-center gap-2.5">
                                <div className="w-8 h-8 rounded-xl bg-amber-500/15 border border-amber-500/30 flex items-center justify-center text-amber-400">
                                    <Sparkles className="w-4 h-4" />
                                </div>
                                <div>
                                    <h3 className="text-sm font-semibold text-white">
                                        Import Parametric EQ Profile
                                    </h3>
                                    <p className="text-[11px] text-zinc-400">
                                        Supports Equalizer APO, AutoEq (.txt) or Aurelia JSON
                                    </p>
                                </div>
                            </div>
                            <button
                                onClick={() => setIsImportModalOpen(false)}
                                className="w-8 h-8 rounded-xl bg-white/5 hover:bg-white/10 border border-white/10 flex items-center justify-center text-zinc-400 hover:text-white transition"
                            >
                                <X className="w-4 h-4" />
                            </button>
                        </div>

                        {/* File Upload Button */}
                        <div className="flex flex-col gap-2">
                            <span className="text-xs font-medium text-zinc-300">
                                Option 1: Select file from computer
                            </span>
                            <button
                                type="button"
                                onClick={() => importInputRef.current?.click()}
                                className="w-full py-3 px-4 rounded-2xl bg-zinc-900 hover:bg-zinc-800/80 border border-dashed border-white/20 hover:border-amber-400/50 flex items-center justify-center gap-2.5 text-xs text-zinc-200 transition group"
                            >
                                <Upload className="w-4 h-4 text-amber-400 group-hover:scale-110 transition-transform" />
                                <span>Choose .txt (Equalizer APO / AutoEq) or .json file</span>
                            </button>
                        </div>

                        {/* Textarea Paste Area */}
                        <form onSubmit={handlePasteImportSubmit} className="flex flex-col gap-3">
                            <div className="flex items-center justify-between">
                                <span className="text-xs font-medium text-zinc-300">
                                    Option 2: Paste EQ text directly
                                </span>
                                {pasteText && isEqualizerApoText(pasteText) && (
                                    <span className="text-[10px] font-mono text-emerald-400 flex items-center gap-1">
                                        <Check className="w-3 h-3" /> Valid APO / AutoEq format detected
                                    </span>
                                )}
                            </div>

                            <textarea
                                value={pasteText}
                                onChange={(e) => setPasteText(e.target.value)}
                                rows={8}
                                placeholder={`Preamp: -0.9258 dB\nFilter 1: ON PK Fc 37 Hz Gain -3.5 dB Q 0.5\nFilter 2: ON PK Fc 170 Hz Gain 0.9 dB Q 1.4\nFilter 3: ON PK Fc 720 Hz Gain 0.6 dB Q 2.5\nFilter 4: ON PK Fc 2000 Hz Gain 1.1 dB Q 3.8\nFilter 5: ON PK Fc 3000 Hz Gain -1.2 dB Q 3\nFilter 6: ON PK Fc 5400 Hz Gain -2.6 dB Q 4`}
                                className="w-full p-3 rounded-2xl bg-zinc-900/90 border border-white/10 text-xs font-mono text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-amber-400/60 transition resize-none"
                            />

                            <div className="flex flex-col gap-1">
                                <label className="text-[11px] text-zinc-400">Preset Name (Optional)</label>
                                <input
                                    type="text"
                                    value={importPresetTitle}
                                    onChange={(e) => setImportPresetTitle(e.target.value)}
                                    placeholder="e.g. Sennheiser HD 600 (AutoEq)"
                                    className="px-3 py-2 rounded-xl bg-zinc-900 border border-white/10 text-xs text-white placeholder-zinc-500 focus:outline-none focus:border-amber-400/50"
                                />
                            </div>

                            <div className="flex items-center justify-end gap-2 pt-2 border-t border-white/10">
                                <button
                                    type="button"
                                    onClick={() => {
                                        setIsImportModalOpen(false);
                                        setPasteText('');
                                    }}
                                    className="px-4 py-2 rounded-xl bg-white/5 hover:bg-white/10 text-zinc-300 text-xs font-medium transition"
                                >
                                    Cancel
                                </button>
                                <button
                                    type="submit"
                                    disabled={!pasteText.trim()}
                                    className="px-5 py-2 rounded-xl bg-amber-500 hover:bg-amber-400 text-zinc-950 text-xs font-bold transition disabled:opacity-40 disabled:cursor-not-allowed shadow-md shadow-amber-500/20"
                                >
                                    Apply & Save Preset
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            )}
        </div>
    );
}

export default React.memo(PeqPanel);