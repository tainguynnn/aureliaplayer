export const DEFAULT_PEQ_FREQUENCIES = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];

export const FILTER_TYPES = [
    { id: 'peaking', label: 'Peak (Bell)' },
    { id: 'lowshelf', label: 'Low Shelf' },
    { id: 'highshelf', label: 'High Shelf' },
    { id: 'lowpass', label: 'Low Pass' },
    { id: 'highpass', label: 'High Pass' }
];

export function createFlatBands() {
    return DEFAULT_PEQ_FREQUENCIES.map((freq, idx) => ({
        id: `band-${idx + 1}`,
        enabled: true,
        type: idx === 0 ? 'lowshelf' : idx === 9 ? 'highshelf' : 'peaking',
        frequency: freq,
        gain: 0,
        q: idx === 0 || idx === 9 ? 0.71 : 1.41
    }));
}

function makePresetBands(gains, customTypes = {}, customQs = {}) {
    return DEFAULT_PEQ_FREQUENCIES.map((freq, idx) => ({
        id: `band-${idx + 1}`,
        enabled: true,
        type: customTypes[idx] || (idx === 0 ? 'lowshelf' : idx === 9 ? 'highshelf' : 'peaking'),
        frequency: freq,
        gain: Number((gains[idx] ?? 0).toFixed(1)),
        q: customQs[idx] || (idx === 0 || idx === 9 ? 0.71 : 1.41)
    }));
}

export const BUILTIN_PEQ_PRESETS = [
    {
        id: 'builtin-flat',
        name: 'Flat',
        isBuiltIn: true,
        preamp: 0,
        bands: createFlatBands()
    },
    {
        id: 'builtin-bass-boost',
        name: 'Bass Boost',
        isBuiltIn: true,
        preamp: -3.5,
        bands: makePresetBands([5.5, 4.8, 3.2, 1.4, 0.0, 0.0, 0.0, 0.4, 0.8, 1.0])
    },
    {
        id: 'builtin-warm',
        name: 'Warm',
        isBuiltIn: true,
        preamp: -2.0,
        bands: makePresetBands([2.5, 3.0, 2.4, 1.5, 0.5, -0.4, -1.0, -1.5, -1.8, -2.2])
    },
    {
        id: 'builtin-vocal',
        name: 'Vocal',
        isBuiltIn: true,
        preamp: -2.2,
        bands: makePresetBands([-2.0, -1.5, -0.5, 1.0, 2.5, 3.5, 3.2, 1.8, 0.5, -0.5])
    },
    {
        id: 'builtin-bright',
        name: 'Bright',
        isBuiltIn: true,
        preamp: -3.0,
        bands: makePresetBands([0.0, 0.0, 0.0, -0.5, 0.0, 0.8, 2.0, 3.2, 4.2, 4.8])
    },
    {
        id: 'builtin-smooth-treble',
        name: 'Smooth Treble',
        isBuiltIn: true,
        preamp: -1.0,
        bands: makePresetBands([1.0, 1.0, 0.5, 0.0, 0.0, -0.5, -1.8, -3.2, -4.0, -3.0], {}, { 7: 2.0, 8: 1.8 })
    }
];

export function validateAndNormalizePeqState(raw) {
    const fallback = {
        enabled: true,
        preamp: 0,
        activePresetId: 'builtin-flat',
        bands: createFlatBands()
    };
    if (!raw || typeof raw !== 'object') return fallback;

    const preamp = Number.isFinite(Number(raw.preamp))
        ? Math.max(-12, Math.min(12, Number(raw.preamp)))
        : 0;

    const rawBands = Array.isArray(raw.bands) && raw.bands.length === 10 ? raw.bands : fallback.bands;
    const validTypes = new Set(FILTER_TYPES.map((f) => f.id));

    const bands = rawBands.map((b, idx) => ({
        id: `band-${idx + 1}`,
        enabled: b?.enabled !== false,
        type: validTypes.has(b?.type) ? b.type : idx === 0 ? 'lowshelf' : idx === 9 ? 'highshelf' : 'peaking',
        frequency: Math.max(20, Math.min(20000, Number(b?.frequency) || DEFAULT_PEQ_FREQUENCIES[idx])),
        gain: Math.max(-12, Math.min(12, Number.isFinite(Number(b?.gain)) ? Number(b.gain) : 0)),
        q: Math.max(0.1, Math.min(18, Number.isFinite(Number(b?.q)) ? Number(b.q) : 1.41))
    }));

    return {
        enabled: raw.enabled !== false,
        preamp,
        activePresetId: typeof raw.activePresetId === 'string' ? raw.activePresetId : 'custom',
        bands
    };
}

export function validateImportedPresetJson(jsonObj) {
    if (!jsonObj || typeof jsonObj !== 'object') {
        throw new Error('Preset JSON must be an object.');
    }
    const name = String(jsonObj.name || 'Imported Preset').trim().slice(0, 48);
    if (!Array.isArray(jsonObj.bands) || jsonObj.bands.length !== 10) {
        throw new Error('Preset JSON must contain an array of 10 EQ bands.');
    }
    const normalized = validateAndNormalizePeqState({
        enabled: true,
        preamp: jsonObj.preamp ?? 0,
        bands: jsonObj.bands
    });
    return {
        id: `custom-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        name: name || 'Imported PEQ',
        isBuiltIn: false,
        preamp: normalized.preamp,
        bands: normalized.bands
    };
}

/**
 * Applies PEQ parameters to the live Web Audio graph in-place without recreating AudioContext.
 */
export function applyPeqToAudioNodes(ctx, preampNode, filterNodes, peqState) {
    if (!ctx || !preampNode || !Array.isArray(filterNodes) || filterNodes.length !== 10) return;
    const safe = validateAndNormalizePeqState(peqState);
    const now = ctx.currentTime || 0;

    // Convert Preamp dB to linear gain (1.0 when bypassed)
    const targetPreampGain = safe.enabled ? Math.pow(10, safe.preamp / 20) : 1.0;
    try {
        preampNode.gain.setTargetAtTime(targetPreampGain, now, 0.015);
    } catch {
        preampNode.gain.value = targetPreampGain;
    }

    for (let i = 0; i < 10; i++) {
        const node = filterNodes[i];
        const band = safe.bands[i];
        if (!node || !band) continue;

        if (!safe.enabled || !band.enabled) {
            // Neutralize disabled band in-place without disconnecting graph
            node.type = 'peaking';
            node.gain.value = 0;
            node.frequency.value = band.frequency;
            node.Q.value = 1.0;
        } else {
            node.type = band.type;
            node.frequency.value = band.frequency;
            node.Q.value = band.q;
            node.gain.value = band.gain;
        }
    }
}

/**
 * Computes combined frequency response curve (dB) across log-spaced frequencies (20 Hz – 20 kHz)
 * using live BiquadFilterNode.getFrequencyResponse when available, or analytical biquad math.
 */
export function computeFrequencyResponseCurve(filterNodes, peqState, numPoints = 160) {
    const minLog = Math.log10(20);
    const maxLog = Math.log10(20000);
    const freqs = new Float32Array(numPoints);
    for (let i = 0; i < numPoints; i++) {
        freqs[i] = Math.pow(10, minLog + (i / (numPoints - 1)) * (maxLog - minLog));
    }

    const totalDb = new Float32Array(numPoints);
    const safe = validateAndNormalizePeqState(peqState);
    if (!safe.enabled) {
        return { freqs, totalDb };
    }

    for (let i = 0; i < numPoints; i++) {
        totalDb[i] = safe.preamp;
    }

    // If live Web Audio BiquadFilterNodes exist, query exact hardware filter response
    if (Array.isArray(filterNodes) && filterNodes.length === 10 && filterNodes[0]?.getFrequencyResponse) {
        const mag = new Float32Array(numPoints);
        const phase = new Float32Array(numPoints);
        for (let b = 0; b < 10; b++) {
            if (!safe.bands[b]?.enabled) continue;
            filterNodes[b].getFrequencyResponse(freqs, mag, phase);
            for (let i = 0; i < numPoints; i++) {
                const m = Math.max(1e-5, mag[i]);
                totalDb[i] += 20 * Math.log10(m);
            }
        }
        return { freqs, totalDb };
    }

    // Analytical RBJ biquad fallback when AudioContext hasn't been initialized yet
    const sampleRate = 48000;
    for (const band of safe.bands) {
        if (!band.enabled) continue;
        const f0 = band.frequency;
        const dbGain = band.gain;
        const Q = Math.max(0.1, band.q);
        const A = Math.pow(10, dbGain / 40);
        const w0 = (2 * Math.PI * f0) / sampleRate;
        const cosW0 = Math.cos(w0);
        const sinW0 = Math.sin(w0);
        const alpha = sinW0 / (2 * Q);

        let b0 = 1, b1 = 0, b2 = 0, a0 = 1, a1 = 0, a2 = 0;
        if (band.type === 'peaking') {
            b0 = 1 + alpha * A;
            b1 = -2 * cosW0;
            b2 = 1 - alpha * A;
            a0 = 1 + alpha / A;
            a1 = -2 * cosW0;
            a2 = 1 - alpha / A;
        } else if (band.type === 'lowshelf') {
            const sqA = 2 * Math.sqrt(A) * alpha;
            b0 = A * ((A + 1) - (A - 1) * cosW0 + sqA);
            b1 = 2 * A * ((A - 1) - (A + 1) * cosW0);
            b2 = A * ((A + 1) - (A - 1) * cosW0 - sqA);
            a0 = (A + 1) + (A - 1) * cosW0 + sqA;
            a1 = -2 * ((A - 1) + (A + 1) * cosW0);
            a2 = (A + 1) + (A - 1) * cosW0 - sqA;
        } else if (band.type === 'highshelf') {
            const sqA = 2 * Math.sqrt(A) * alpha;
            b0 = A * ((A + 1) + (A - 1) * cosW0 + sqA);
            b1 = -2 * A * ((A - 1) + (A + 1) * cosW0);
            b2 = A * ((A + 1) + (A - 1) * cosW0 - sqA);
            a0 = (A + 1) - (A - 1) * cosW0 + sqA;
            a1 = 2 * ((A - 1) - (A + 1) * cosW0);
            a2 = (A + 1) - (A - 1) * cosW0 - sqA;
        } else if (band.type === 'lowpass') {
            b0 = (1 - cosW0) / 2;
            b1 = 1 - cosW0;
            b2 = (1 - cosW0) / 2;
            a0 = 1 + alpha;
            a1 = -2 * cosW0;
            a2 = 1 - alpha;
        } else if (band.type === 'highpass') {
            b0 = (1 + cosW0) / 2;
            b1 = -(1 + cosW0);
            b2 = (1 + cosW0) / 2;
            a0 = 1 + alpha;
            a1 = -2 * cosW0;
            a2 = 1 - alpha;
        }

        b0 /= a0; b1 /= a0; b2 /= a0;
        a1 /= a0; a2 /= a0;

        for (let i = 0; i < numPoints; i++) {
            const w = (2 * Math.PI * freqs[i]) / sampleRate;
            const cw = Math.cos(w);
            const sw = Math.sin(w);
            const c2w = Math.cos(2 * w);
            const s2w = Math.sin(2 * w);

            const numRe = b0 + b1 * cw + b2 * c2w;
            const numIm = -(b1 * sw + b2 * s2w);
            const denRe = 1 + a1 * cw + a2 * c2w;
            const denIm = -(a1 * sw + a2 * s2w);

            const magSq = (numRe * numRe + numIm * numIm) / Math.max(1e-12, denRe * denRe + denIm * denIm);
            totalDb[i] += 10 * Math.log10(Math.max(1e-8, magSq));
        }
    }

    return { freqs, totalDb };
}