/* fileName: colorPicker-color-math.js */

function parseColorStr(str) {
    if (!str || typeof str !== 'string') return { hex: '#000000', op: 100 };
    str = str.trim();
    const lower = str.toLowerCase();
    if (lower.startsWith('rgb')) {
        let m = str.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+)\s*)?\)/i);
        if (m) {
            const alpha = m[4] === undefined ? 1 : parseFloat(m[4]);
            return {
                hex: rgbToHex(clamp8Bit(parseFloat(m[1])), clamp8Bit(parseFloat(m[2])), clamp8Bit(parseFloat(m[3]))),
                op: Math.max(0, Math.min(100, Math.round((Number.isFinite(alpha) ? alpha : 1) * 100)))
            };
        }
    }
    if (str.startsWith('#')) {
        let raw = str.substring(1);
        if (/^[0-9A-Fa-f]{3,4}$/.test(raw)) raw = raw.split('').map(c => c + c).join('');
        if (/^[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$/.test(raw)) {
            let hex = '#' + raw.substring(0, 6).toUpperCase();
            let op = 100;
            if (raw.length === 8) {
                op = Math.round((parseInt(raw.substring(6, 8), 16) / 255) * 100);
            }
            return { hex, op };
        }
    }
    return { hex: '#000000', op: 100 };
}

function normalizeGradientStops(stops) {
    let clean = (Array.isArray(stops) ? stops : []).map(parseColorStr);
    if (clean.length >= 2) return clean;
    if (clean.length === 1) return [clean[0], { ...clean[0], op: 0 }];
    return ['#ff3b30', '#007aff'].map(parseColorStr);
}

function hex8(hex, op) {
    let alpha = Math.round((op / 100) * 255).toString(16).padStart(2, '0');
    return hex.substring(0, 7) + alpha;
}

function hexToRgbaStr(hex, op) {
    let r = parseInt(hex.slice(1, 3), 16);
    let g = parseInt(hex.slice(3, 5), 16);
    let b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${op / 100})`;
}

function getSendAngle() {
    if (gradType === 'linear') {
        return (gradAngle + 180 + 360) % 360;
    }
    return gradAngle;
}

const clamp8Bit = (val) => Math.max(0, Math.min(255, Math.round(val)));

function rgbToHsb(r, g, b, oldH = 0, oldS = 0) {
    r /= 255; g /= 255; b /= 255;
    let max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    let h = 0, s = max === 0 ? 0 : d / max, v = max;
    if (max !== min) {
        switch (max) { case r: h = (g - b) / d + (g < b ? 6 : 0); break; case g: h = (b - r) / d + 2; break; case b: h = (r - g) / d + 4; break; }
        h /= 6;
    }
    return { h: (max === min) ? oldH : h * 360, s: (max === 0) ? oldS : s * 100, b: v * 100 };
}

function hsbToRgb(h, s, v) {
    let r, g, b, i, f, p, q, t;
    h /= 360; s /= 100; v /= 100;
    i = Math.floor(h * 6); f = h * 6 - i;
    p = v * (1 - s); q = v * (1 - f * s); t = v * (1 - (1 - f) * s);
    switch (i % 6) { case 0: r = v, g = t, b = p; break; case 1: r = q, g = v, b = p; break; case 2: r = p, g = v, b = t; break; case 3: r = p, g = q, b = v; break; case 4: r = t, g = p, b = v; break; case 5: r = v, g = p, b = q; break; }
    return { r: clamp8Bit(r * 255), g: clamp8Bit(g * 255), b: clamp8Bit(b * 255) };
}

function hexToHsb(hex) {
    let r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
    return rgbToHsb(r, g, b);
}

function rgbToHex(r, g, b) {
    return "#" + (1 << 24 | r << 16 | g << 8 | b).toString(16).slice(1).toUpperCase();
}

function hsbToHsl(h, s, b) {
    s /= 100; b /= 100;
    let l = (2 - s) * b / 2;
    let sl = l !== 0 ? (s * b) / (l < 0.5 ? l * 2 : 2 - l * 2) : 0;
    return { h: h, s: isNaN(sl) ? 0 : sl * 100, l: l * 100 };
}

function hslToHsb(h, s, l, oldH = 0, oldS = 0) {
    s /= 100; l /= 100;
    let b = l + s * (l < 0.5 ? l : 1 - l);
    let sb = b === 0 ? 0 : 2 * (1 - l / b);
    return { h: (sb === 0) ? oldH : h, s: (b === 0) ? oldS : sb * 100, b: b * 100 };
}

function getHex() {
    const rgb = hsbToRgb(cpState.h, cpState.s, cpState.b);
    return rgbToHex(rgb.r, rgb.g, rgb.b);
}
