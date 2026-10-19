export const ACCENT_PALETTES = {
    amber: {
        id: 'amber',
        label: 'Amber (Default)',
        swatch: '#f59e0b',
        rgb200: '253 230 138',
        rgb300: '252 211 77',
        rgb400: '251 191 36',
        rgb500: '245 158 11',
        rgb600: '217 119 6',
        rgb700: '180 83 9',
        hex200: '#fde68a',
        hex300: '#fcd34d',
        hex400: '#fbbf24',
        hex500: '#f59e0b',
        hex600: '#d97706',
        hex700: '#b45309'
    },
    blue: {
        id: 'blue',
        label: 'Sapphire Blue',
        swatch: '#3b82f6',
        rgb200: '191 219 254',
        rgb300: '147 197 253',
        rgb400: '96 165 250',
        rgb500: '59 130 246',
        rgb600: '37 99 235',
        rgb700: '29 78 216',
        hex200: '#bfdbfe',
        hex300: '#93c5fd',
        hex400: '#60a5fa',
        hex500: '#3b82f6',
        hex600: '#2563eb',
        hex700: '#1d4ed8'
    },
    cyan: {
        id: 'cyan',
        label: 'Electric Cyan',
        swatch: '#06b6d4',
        rgb200: '165 243 252',
        rgb300: '103 232 249',
        rgb400: '34 211 238',
        rgb500: '6 182 212',
        rgb600: '8 145 178',
        rgb700: '14 116 144',
        hex200: '#a5f3fc',
        hex300: '#67e8f9',
        hex400: '#22d3ee',
        hex500: '#06b6d4',
        hex600: '#0891b2',
        hex700: '#0e7490'
    },
    violet: {
        id: 'violet',
        label: 'Studio Violet',
        swatch: '#8b5cf6',
        rgb200: '221 214 254',
        rgb300: '196 181 253',
        rgb400: '167 139 250',
        rgb500: '139 92 246',
        rgb600: '124 58 237',
        rgb700: '109 40 217',
        hex200: '#ddd6fe',
        hex300: '#c4b5fd',
        hex400: '#a78bfa',
        hex500: '#8b5cf6',
        hex600: '#7c3aed',
        hex700: '#6d28d9'
    },
    emerald: {
        id: 'emerald',
        label: 'Master Emerald',
        swatch: '#10b981',
        rgb200: '167 243 208',
        rgb300: '110 231 183',
        rgb400: '52 211 153',
        rgb500: '16 185 129',
        rgb600: '5 150 105',
        rgb700: '4 120 87',
        hex200: '#a7f3d0',
        hex300: '#6ee7b7',
        hex400: '#34d399',
        hex500: '#10b981',
        hex600: '#059669',
        hex700: '#047857'
    },
    rose: {
        id: 'rose',
        label: 'Velvet Rose',
        swatch: '#f43f5e',
        rgb200: '254 205 211',
        rgb300: '253 164 175',
        rgb400: '251 113 133',
        rgb500: '244 63 94',
        rgb600: '225 29 72',
        rgb700: '190 18 60',
        hex200: '#fecdd3',
        hex300: '#fda4af',
        hex400: '#fb7185',
        hex500: '#f43f5e',
        hex600: '#e11d48',
        hex700: '#be123c'
    }
};

function hexToRgb(hex) {
    if (!hex || typeof hex !== 'string') return { r: 245, g: 158, b: 11 };
    let c = hex.replace('#', '').trim();
    if (c.length === 3) {
        c = c.split('').map(ch => ch + ch).join('');
    }
    const val = parseInt(c, 16);
    if (isNaN(val) || c.length !== 6) return { r: 245, g: 158, b: 11 };
    return {
        r: (val >> 16) & 255,
        g: (val >> 8) & 255,
        b: val & 255
    };
}

function rgbToHex(r, g, b) {
    return '#' + [r, g, b].map(x => {
        const h = Math.max(0, Math.min(255, Math.round(x))).toString(16);
        return h.padStart(2, '0');
    }).join('');
}

function mixRgb(c1, c2, weight) {
    return {
        r: Math.round(c1.r * (1 - weight) + c2.r * weight),
        g: Math.round(c1.g * (1 - weight) + c2.g * weight),
        b: Math.round(c1.b * (1 - weight) + c2.b * weight)
    };
}

export function generateCustomPalette(hex) {
    const base = hexToRgb(hex);
    const white = { r: 255, g: 255, b: 255 };
    const black = { r: 0, g: 0, b: 0 };

    const c200 = mixRgb(base, white, 0.65);
    const c300 = mixRgb(base, white, 0.45);
    const c400 = mixRgb(base, white, 0.22);
    const c500 = base;
    const c600 = mixRgb(base, black, 0.18);
    const c700 = mixRgb(base, black, 0.36);

    const fmtRgb = (c) => `${c.r} ${c.g} ${c.b}`;
    const cleanHex = rgbToHex(base.r, base.g, base.b);

    return {
        id: 'custom',
        label: 'Custom Color',
        swatch: cleanHex,
        rgb200: fmtRgb(c200),
        rgb300: fmtRgb(c300),
        rgb400: fmtRgb(c400),
        rgb500: fmtRgb(c500),
        rgb600: fmtRgb(c600),
        rgb700: fmtRgb(c700),
        hex200: rgbToHex(c200.r, c200.g, c200.b),
        hex300: rgbToHex(c300.r, c300.g, c300.b),
        hex400: rgbToHex(c400.r, c400.g, c400.b),
        hex500: cleanHex,
        hex600: rgbToHex(c600.r, c600.g, c600.b),
        hex700: rgbToHex(c700.r, c700.g, c700.b)
    };
}

export function getPalette(accentId = 'amber', customHex = null) {
    if (accentId === 'custom' || (typeof accentId === 'string' && accentId.startsWith('#'))) {
        const hex = (typeof accentId === 'string' && accentId.startsWith('#')) ? accentId : (customHex || '#f59e0b');
        return generateCustomPalette(hex);
    }
    return ACCENT_PALETTES[accentId] || ACCENT_PALETTES.amber;
}

export function applyAppearanceTokens(themeMode = 'dark', accentId = 'amber', customHex = null) {
    if (typeof document === 'undefined') return;
    const root = document.documentElement;
    const pal = getPalette(accentId, customHex);
    const mode = themeMode === 'light' ? 'light' : 'dark';

    root.setAttribute('data-theme', mode);
    root.setAttribute('data-accent', pal.id);
    if (mode === 'dark') {
        root.classList.add('dark');
    } else {
        root.classList.remove('dark');
    }
    if (document.body) {
        document.body.setAttribute('data-theme', mode);
        if (mode === 'dark') {
            document.body.classList.add('dark');
        } else {
            document.body.classList.remove('dark');
        }
    }

    root.style.setProperty('--accent-200', pal.rgb200);
    root.style.setProperty('--accent-300', pal.rgb300);
    root.style.setProperty('--accent-400', pal.rgb400);
    root.style.setProperty('--accent-500', pal.rgb500);
    root.style.setProperty('--accent-600', pal.rgb600);
    root.style.setProperty('--accent-700', pal.rgb700);

    root.style.setProperty('--accent-hex-200', pal.hex200);
    root.style.setProperty('--accent-hex-300', pal.hex300);
    root.style.setProperty('--accent-hex-400', pal.hex400);
    root.style.setProperty('--accent-hex-500', pal.hex500);
    root.style.setProperty('--accent-hex-600', pal.hex600);
    root.style.setProperty('--accent-hex-700', pal.hex700);

    root.style.setProperty('--accent', pal.hex500);
    root.style.setProperty('--accent-swatch', pal.swatch);
}

export function extractDominantColor(imageUrl) {
    return new Promise((resolve) => {
        if (!imageUrl || typeof window === 'undefined') {
            resolve(null);
            return;
        }
        const img = new Image();
        if (!imageUrl.startsWith('data:') && !imageUrl.startsWith('blob:')) {
            img.crossOrigin = 'anonymous';
        }
        img.onload = () => {
            try {
                const canvas = document.createElement('canvas');
                const ctx = canvas.getContext('2d', { willReadFrequently: true });
                if (!ctx) {
                    resolve(null);
                    return;
                }
                const size = 32;
                canvas.width = size;
                canvas.height = size;
                ctx.drawImage(img, 0, 0, size, size);
                const imgData = ctx.getImageData(0, 0, size, size);
                const data = imgData.data;

                let bestColor = null;
                let maxScore = -1;

                for (let i = 0; i < data.length; i += 4) {
                    const r = data[i];
                    const g = data[i + 1];
                    const b = data[i + 2];
                    const a = data[i + 3];
                    if (a < 128) continue;

                    const max = Math.max(r, g, b);
                    const min = Math.min(r, g, b);
                    const delta = max - min;
                    const brightness = (max + min) / 2 / 255;
                    const saturation = max === 0 ? 0 : delta / max;

                    if (brightness < 0.16 || brightness > 0.86 || saturation < 0.2) {
                        continue;
                    }

                    const brightnessPenalty = Math.abs(brightness - 0.52);
                    const score = saturation * 1.8 + (1 - brightnessPenalty * 1.5);

                    if (score > maxScore) {
                        maxScore = score;
                        bestColor = { r, g, b };
                    }
                }

                if (!bestColor && data.length > 0) {
                    let totalR = 0, totalG = 0, totalB = 0, count = 0;
                    for (let i = 0; i < data.length; i += 16) {
                        totalR += data[i];
                        totalG += data[i + 1];
                        totalB += data[i + 2];
                        count++;
                    }
                    if (count > 0) {
                        bestColor = {
                            r: Math.round(totalR / count),
                            g: Math.round(totalG / count),
                            b: Math.round(totalB / count)
                        };
                    }
                }

                if (bestColor) {
                    resolve(rgbToHex(bestColor.r, bestColor.g, bestColor.b));
                } else {
                    resolve(null);
                }
            } catch {
                resolve(null);
            }
        };
        img.onerror = () => resolve(null);
        img.src = imageUrl;
    });
}