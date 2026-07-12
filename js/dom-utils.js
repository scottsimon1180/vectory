/* fileName: dom-utils.js */

const createEl = (tag, className = '', props = {}, children = []) => {

    const el = document.createElement(tag);

    if (className) el.className = className;

    Object.entries(props).forEach(([k, v]) => k === 'style' ? Object.assign(el.style, v) : el[k] = v);

    children.forEach(c => el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c));

    return el;

};



const colorToHex = col => {

    if (!col || col === 'none' || col.includes('url')) return '#000000';

    ctxHelper.fillStyle = '#000000'; ctxHelper.fillStyle = col; return ctxHelper.fillStyle;

};



// Round a single numeric string to `prec` decimals, dropping trailing zeros. Non-finite / non-numeric

// input (e.g. "auto", a percentage, empty) is returned untouched so it passes through unharmed.

const roundCoordValue = (v, prec) => {

    const s = String(v == null ? '' : v).trim();

    const x = +s;

    if (s === '' || !isFinite(x)) return v;

    if (Number.isInteger(x)) return String(x);

    // Strip trailing zeros only when a decimal point exists -- toFixed(0) yields no '.', so a blanket

    // strip would chew into the integer digits ("10" -> "1", "0" -> "").

    const r = x.toFixed(prec);

    return r.indexOf('.') >= 0 ? r.replace(/0+$/, '').replace(/\.$/, '') : r;

};



// Round the numbers in SVG path-like data (`d` / `points`) to `prec` decimals WITHOUT fusing

// coordinates. Illustrator flush-packs numbers (the next number's leading '.'/'-' is the only

// separator, e.g. "1.26.702" = 1.26 & .702), so rewriting each number in place can merge adjacent

// ones -- silently dropping a coordinate and scrambling the geometry. Tokenize into command letters

// + numbers, round each, and re-join (single space between consecutive numbers; letters attach directly).

const roundPathData = (d, prec) => {

    const toks = String(d).match(/[a-zA-Z]|[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g);

    if (!toks) return '';

    let out = '', prevNum = false;

    for (const t of toks) {

        if (/[a-zA-Z]/.test(t)) { out += t; prevNum = false; continue; }

        out += (prevNum ? ' ' : '') + roundCoordValue(t, prec);

        prevNum = true;

    }

    return out;

};


// True while a text-entry element has focus -- keyboard shortcuts (e.g. Ctrl+A select-all)
// must stand down so native editing behavior is preserved.
const isTextInputFocused = () => {
    const el = document.activeElement;
    return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
};

// Shift-constrain a drag vector to the nearest 45-degree direction (Illustrator-style): the
// vector is projected onto the closest of the 8 compass rays. Shared by the Selection tool
// (constrained move), Direct Selection (constrained anchor drag), Pen (constrained anchor
// placement), and the Line Segment tool. Returns a new {x, y}; a zero vector passes through.
const constrainVec45 = (dx, dy) => {
    if (dx === 0 && dy === 0) return { x: 0, y: 0 };
    const step = Math.PI / 4;
    const ang = Math.round(Math.atan2(dy, dx) / step) * step;
    const ux = Math.cos(ang), uy = Math.sin(ang);
    const len = dx * ux + dy * uy;
    return { x: ux * len, y: uy * len };
};

const SVG_VECTOR_LAYER_SHAPE_SELECTOR = 'path, circle, rect, polygon, polyline, ellipse, line';
const SVG_LAYER_SHAPE_SELECTOR = `${SVG_VECTOR_LAYER_SHAPE_SELECTOR}, image`;
const XLINK_NS = 'http://www.w3.org/1999/xlink';

const SVG_NON_LAYER_CONTAINERS = new Set(['defs', 'clippath', 'mask', 'lineargradient', 'radialgradient', 'pattern', 'marker', 'symbol']);

const getRasterImageHref = (node) =>
    (node && (node.getAttribute('href') || node.getAttributeNS(XLINK_NS, 'href') || node.getAttribute('xlink:href'))) || '';

const isRasterLayerShape = (node) =>
    !!(node && node.tagName && node.tagName.toLowerCase() === 'image');

const isEmbeddedRasterLayerShape = (node) =>
    isRasterLayerShape(node) && /^data:image\//i.test(getRasterImageHref(node).trim());

const getRasterImageNameFromHref = (href) => {

    const raw = String(href || '').trim();

    if (!raw) return '';

    const dataName = raw.match(/^data:image\/[^;,]+;(?:[^,;]+;)*?(?:name|filename)=([^;,]+)/i);

    if (dataName && dataName[1]) {

        try { return decodeURIComponent(dataName[1]).trim(); } catch (_) { return dataName[1].trim(); }

    }

    if (/^data:image\//i.test(raw)) return '';

    const clean = raw.split('#')[0].split('?')[0].replace(/\\/g, '/');

    const name = clean.slice(clean.lastIndexOf('/') + 1).trim();

    try { return decodeURIComponent(name); } catch (_) { return name; }

};

const resolveLayerDefaultName = (node, index) => {

    const t = node.tagName.toLowerCase();

    if (t === 'image') {

        const fileName = getRasterImageNameFromHref(getRasterImageHref(node));

        return fileName || `Image ${index + 1}`;

    }

    return `${t.charAt(0).toUpperCase() + t.slice(1)} ${index + 1}`;

};

const isEditableLayerShape = (shape, stopAncestor) => {

    if (!shape || !shape.tagName || !shape.matches(SVG_LAYER_SHAPE_SELECTOR)) return false;

    if (isRasterLayerShape(shape) && !isEmbeddedRasterLayerShape(shape)) return false;

    let el = shape.parentNode;

    while (el && el !== stopAncestor && el.nodeType === 1) {

        if (SVG_NON_LAYER_CONTAINERS.has(el.tagName.toLowerCase())) return false;

        el = el.parentNode;

    }

    return true;

};

const getEditableLayerShapes = (rootSvg) => {

    if (!rootSvg) return [];

    const root = rootSvg.querySelector(':scope > g#ink-wrapper') || rootSvg;

    return Array.from(root.querySelectorAll(SVG_LAYER_SHAPE_SELECTOR)).filter(shape => isEditableLayerShape(shape, root));

};



// Resolve a display name for any element: its own id, else "Tag N". Node-agnostic (leaf shapes now, groups later).

const resolveLayerName = (node, index) => {

    const label = node.getAttribute('data-pf-label');

    if (label && label.trim()) return label;

    const id = node.getAttribute('id');

    if (id && id.trim() && id !== 'ink-wrapper') return id;

    return resolveLayerDefaultName(node, index);

};



// Coerce arbitrary user text into a valid, querySelector-safe id. '' => caller drops the id.

const sanitizeSvgId = (raw) => {

    let v = String(raw || '').trim();

    if (!v) return '';

    v = v.replace(/\s+/g, '_').replace(/[^A-Za-z0-9_-]/g, '').replace(/_{2,}/g, '_');

    if (!v) return '';

    if (/^[0-9-]/.test(v)) v = '_' + v;

    return v.slice(0, 64);

};



// Guarantee an id is unique within the doc; never collide with the internal wrapper.

const ensureUniqueSvgId = (rootSvg, candidate, selfNode) => {

    if (!candidate) return '';

    const taken = new Set();

    rootSvg.querySelectorAll('[id]').forEach(el => { if (el !== selfNode) taken.add(el.getAttribute('id')); });

    taken.add('ink-wrapper');

    if (!taken.has(candidate)) return candidate;

    let n = 2, c = `${candidate}-${n}`;

    while (taken.has(c)) { n++; c = `${candidate}-${n}`; }

    return c;

};



// Collect ids that are functionally referenced (gradients, clip-path, mask, filter, <use>) — never strip these.

const collectReferencedIds = (rootSvg) => {

    const refs = new Set();

    const urlRe = /url\(['"]?#([^)'"]+)['"]?\)/g;

    rootSvg.querySelectorAll('*').forEach(el => {

        for (const attr of el.attributes) {

            if (attr.name === 'href' || attr.name === 'xlink:href') {

                if (attr.value.charAt(0) === '#') refs.add(attr.value.slice(1));

            } else {

                let m; urlRe.lastIndex = 0;

                while ((m = urlRe.exec(attr.value)) !== null) refs.add(m[1]);

            }

        }

    });

    return refs;

};

