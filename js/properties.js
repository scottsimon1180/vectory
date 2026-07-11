/* fileName: properties.js */

// Properties panel: an editable, Illustrator-style transform readout for the selected element.
// It shows X / Y / Width / Height, flip / rotate controls, align-to-artboard buttons, and lets
// the user retype any value to move (X/Y) or resize (Width/Height) the shape. Edits are written to globalOptimizedSvg and pushed through
// renderOutput() so both the live preview and the exported SVG update. A constrain-proportions
// link couples Width/Height.
//
// Read values are GEOMETRY bounds (getBBox, stroke excluded), in the SVG's viewBox user units
// (1 unit = 1px at native size), X/Y = top-left, measured from the artboard top-left. An edit is
// expressed as the shape's own transform via newOwn = P^-1 * M * P * own, where P is the shape's
// ancestor matrix (cumulativeAncestorMatrix) and M is a root-space translate/scale/rotate/flip -- the same
// transform math the canvas tools and layer-reorder use (layers.js). Stroke scales with the shape
// (the natural result of a transform).

const propEmptyEl = $('propertiesEmpty');
const propGridEl = $('propertiesGrid');
const propLinkBtn = $('propConstrainBtn');
const propInputs = { x: $('propX'), y: $('propY'), width: $('propWidth'), height: $('propHeight') };
const propRotateInput = $('propRotate');
const propAngleIcon = $('propAngleIcon');
const propRotatePresetBtn = $('propRotatePreset');
const propFlipBtns = Array.from(document.querySelectorAll('[data-prop-flip]'));
const propAlignBtns = Array.from(document.querySelectorAll('[data-prop-align]'));
const propScaleOptsEl = $('propsScaleOpts');
const propScaleOptionInputs = Array.from(document.querySelectorAll('#propsScaleOpts input'));
const propRefPointEl = $('propsRefPoint');
const propRefDots = propRefPointEl ? Array.from(propRefPointEl.querySelectorAll('.props-rp-dot')) : [];
const PROP_FIELDS = ['x', 'y', 'width', 'height'];
const PROP_EMPTY_VALUE = '-';
const PROP_MIN_SIZE = 0.01;        // smallest allowed Width / Height (px)
const ARTBOARD_PROP_MIN_SIZE = 1;

let propConstrain = false;         // constrain-proportions link (in-memory, default off)
let propSuppressCommit = false;    // set by Escape so the following blur reverts instead of commits
const propRotationAngles = new WeakMap(); // per global shape; 0deg is the shape's session start angle

// Illustrator-style reference point: the 9-way anchor that X/Y, scale, rotate, and flip act about
// (in-memory global mode, default middle-center). [hx, vy] are the fractional position within the
// selection's root-space bounding box; getRefAnchor() turns them into a concrete root-space point.
let propRefPoint = 'mc';
const REF_FACTORS = { tl: [0, 0], tc: [0.5, 0], tr: [1, 0], ml: [0, 0.5], mc: [0.5, 0.5], mr: [1, 0.5], bl: [0, 1], bc: [0.5, 1], br: [1, 1] };
const getRefAnchor = (rootBBox) => {
    const [hx, vy] = REF_FACTORS[propRefPoint] || REF_FACTORS.tl;
    return { ax: rootBBox.minX + hx * rootBBox.w, ay: rootBBox.minY + vy * rootBBox.h };
};

// Fixed 2 decimals for display; normalize -0 so a value on the origin never reads "-0.00".
const fmtPropNum = (n) => (Object.is(n, -0) ? 0 : n).toFixed(2);

// Round + stringify a transform component the way matrixToString does (tiny -> 0, else trimmed).
const fmtTransformNum = (n) => String(Math.abs(n) < 1e-6 ? 0 : +n.toFixed(6));

// Cleanest standards-compliant serialization of an element's own transform matrix: pure translate
// -> translate(), pure scale -> scale(), otherwise matrix(); null when identity (-> remove attr).
const formatOwnTransform = (m) => {
    const { a, b, c, d, e, f } = m;
    const near = (x, y) => Math.abs(x - y) < 1e-6;
    const T = fmtTransformNum;
    if (near(a, 1) && near(b, 0) && near(c, 0) && near(d, 1) && near(e, 0) && near(f, 0)) return null;
    if (near(b, 0) && near(c, 0) && near(a, 1) && near(d, 1))
        return near(f, 0) ? `translate(${T(e)})` : `translate(${T(e)}, ${T(f)})`;
    if (near(b, 0) && near(c, 0) && near(e, 0) && near(f, 0))
        return near(a, d) ? `scale(${T(a)})` : `scale(${T(a)}, ${T(d)})`;
    return `matrix(${T(a)}, ${T(b)}, ${T(c)}, ${T(d)}, ${T(e)}, ${T(f)})`;
};

const isFiniteMatrix = (m) => [m.a, m.b, m.c, m.d, m.e, m.f].every(Number.isFinite);

const normalizeAngle = (deg) => {
    let v = deg % 360;
    if (v < 0) v += 360;
    if (Math.abs(v) < 1e-6 || Math.abs(v - 360) < 1e-6) v = 0;
    return v;
};

const fmtAngle = (deg) => {
    const v = normalizeAngle(deg);
    return String(Math.abs(v - Math.round(v)) < 1e-6 ? Math.round(v) : +v.toFixed(2));
};

const parseAngle = (raw) => {
    const v = parseFloat(String(raw || '').trim());
    return Number.isFinite(v) ? v : null;
};

const getGlobalSelectedShape = () =>
    (globalOptimizedSvg && editSelectedIndex != null) ? globalOptimizedSvg.querySelector(`[data-pf-index="${editSelectedIndex}"]`) : null;

// Multi-selection (2+ objects): the group acts as one unit. groupRotationAngle is the persisted
// orientation of the group bounding box (Illustrator-style: it survives gestures and only resets
// when the selection membership changes); it replaces the per-shape WeakMap angle while multi.
const isMultiSelection = () => editSelectedIndices.size > 1;
let groupRotationAngle = 0;

const getStoredRotation = () => {
    if (isMultiSelection()) return groupRotationAngle;
    const shape = getGlobalSelectedShape();
    return shape && propRotationAngles.has(shape) ? propRotationAngles.get(shape) : 0;
};

const setStoredRotation = (deg) => {
    if (isMultiSelection()) { groupRotationAngle = normalizeAngle(deg); return; }
    const shape = getGlobalSelectedShape();
    if (shape) propRotationAngles.set(shape, normalizeAngle(deg));
};

const setRotationReadout = (deg) => {
    if (propRotateInput && !propRotateInput.disabled) propRotateInput.value = fmtAngle(deg);
};

window.getSelectionRotation = getStoredRotation;
window.setSelectionRotation = (deg) => {
    setStoredRotation(deg);
    setRotationReadout(deg);
};
window.addSelectionRotationDelta = (deltaDeg) => {
    const next = getStoredRotation() + deltaDeg;
    setStoredRotation(next);
    // Group rotations also accrue on each member so a later single selection reads a sane angle.
    if (isMultiSelection() && globalOptimizedSvg) {
        editSelectedIndices.forEach(idx => {
            const shape = globalOptimizedSvg.querySelector(`[data-pf-index="${idx}"]`);
            if (shape) propRotationAngles.set(shape, normalizeAngle((propRotationAngles.get(shape) || 0) + deltaDeg));
        });
    }
    setRotationReadout(next);
};

// viewBox origin (min-x/min-y) of the preview svg; artboard coords = root coords minus this.
const getViewBoxOrigin = (svg) => {
    const vb = svg.getAttribute('viewBox') || svg.getAttribute('viewbox');
    if (vb) {
        const p = vb.trim().split(/[\s,]+/);
        if (p.length === 4) return { x: parseFloat(p[0]) || 0, y: parseFloat(p[1]) || 0 };
    }
    return { x: 0, y: 0 };
};

const getViewBoxBounds = (svg) => {
    const vb = svg.getAttribute('viewBox') || svg.getAttribute('viewbox');
    if (vb) {
        const p = vb.trim().split(/[\s,]+/);
        if (p.length === 4) {
            return {
                x: parseFloat(p[0]) || 0,
                y: parseFloat(p[1]) || 0,
                w: parseFloat(p[2]) || 0,
                h: parseFloat(p[3]) || 0
            };
        }
    }
    return {
        x: 0,
        y: 0,
        w: parseFloat(svg.dataset.nativeW || svg.getAttribute('width')) || 0,
        h: parseFloat(svg.dataset.nativeH || svg.getAttribute('height')) || 0
    };
};

// Geometry of the current selection, measured on the LIVE preview shape (rendered, so getBBox is
// valid). null when nothing/no-svg is selected; { previewShape: null } when the selected shape was
// pruned from the preview (e.g. fully hidden).
const getSelectionGeom = () => {
    if (!globalOptimizedSvg || editSelectedIndex == null) return null;
    const svg = previewArea.querySelector(PREVIEW_SVG_SELECTOR);
    if (!svg) return null;
    const previewShape = svg.querySelector(`[data-pf-index="${editSelectedIndex}"]`);
    if (!previewShape) return { svg, previewShape: null };

    let bb;
    try { bb = previewShape.getBBox(); } catch (_) { return { svg, previewShape: null }; }

    const P = cumulativeAncestorMatrix(previewShape, svg);
    const own = svgTransformToMatrix(previewShape.getAttribute('transform') || '');
    const F = P.multiply(own);                 // shape-local -> svg-root

    const pts = [
        [bb.x, bb.y], [bb.x + bb.width, bb.y],
        [bb.x, bb.y + bb.height], [bb.x + bb.width, bb.y + bb.height]
    ].map(([x, y]) => F.transformPoint(new DOMPoint(x, y)));

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    pts.forEach(p => {
        if (p.x < minX) minX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x;
        if (p.y > maxY) maxY = p.y;
    });

    const vb = getViewBoxOrigin(svg);
    return { svg, previewShape, P, own, rootBBox: { minX, minY, w: maxX - minX, h: maxY - minY }, vbX: vb.x, vbY: vb.y };
};

// Group geometry for a multi-selection: per-member matrices plus the axis-aligned union of the
// members' projected bboxes. previewShape aliases the first member so getDisplayValues() and the
// single path's null checks keep working unmodified.
const getGroupSelectionGeom = () => {
    if (!globalOptimizedSvg || editSelectedIndices.size === 0) return null;
    const svg = previewArea.querySelector(PREVIEW_SVG_SELECTOR);
    if (!svg) return null;
    const members = [];
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    editSelectedIndices.forEach(idx => {
        const previewShape = svg.querySelector(`[data-pf-index="${idx}"]`);
        if (!previewShape) return;
        let bb;
        try { bb = previewShape.getBBox(); } catch (_) { return; }
        const P = cumulativeAncestorMatrix(previewShape, svg);
        const own = svgTransformToMatrix(previewShape.getAttribute('transform') || '');
        const F = P.multiply(own);
        [[bb.x, bb.y], [bb.x + bb.width, bb.y], [bb.x, bb.y + bb.height], [bb.x + bb.width, bb.y + bb.height]]
            .forEach(([x, y]) => {
                const p = F.transformPoint(new DOMPoint(x, y));
                if (p.x < minX) minX = p.x;
                if (p.y < minY) minY = p.y;
                if (p.x > maxX) maxX = p.x;
                if (p.y > maxY) maxY = p.y;
            });
        members.push({ idx, previewShape, P, own });
    });
    if (!members.length) return { svg, previewShape: null };
    const vb = getViewBoxOrigin(svg);
    return { svg, previewShape: members[0].previewShape, members, rootBBox: { minX, minY, w: maxX - minX, h: maxY - minY }, vbX: vb.x, vbY: vb.y };
};

const getActiveSelectionGeom = () => isMultiSelection() ? getGroupSelectionGeom() : getSelectionGeom();

// Current artboard-space display values for the selection, or null when not measurable.
const getDisplayValues = (g) => {
    if (!g || !g.previewShape) return null;
    const { rootBBox, vbX, vbY } = g;
    const { ax, ay } = getRefAnchor(rootBBox);   // X/Y read the reference-point anchor, not always top-left
    return { x: ax - vbX, y: ay - vbY, width: rootBBox.w, height: rootBBox.h };
};

// ---- Geometry baking: keep strokes uniform under non-uniform scaling (Illustrator-style) -------
// SVG strokes are drawn in an element's local space and then transformed, so a non-uniform scale
// folded into the `transform` matrix distorts the stroke (thick on one axis, thin on the other).
// Illustrator avoids this by baking scale into the geometry coordinates and stroking the result
// uniformly. applyScaleGesture() (below) does the same: a scale gesture is baked into the shape's
// coordinates (path d, polygon points, rect w/h, ...) via its local-space equivalent B = F⁻¹·M·F,
// leaving `own` untouched (so any import transform -- and its stroke -- is preserved). Move / rotate
// / flip / align keep folding into the matrix (they never distort a stroke). Shapes/transforms the
// baker can't represent (arc paths, rotated/sheared or non-uniform primitives) fall back to a fold.

const BAKE_DP = 4;                                       // geometry coordinate precision (sub-pixel; clean export)
const roundCoord = (n) => { const v = +n.toFixed(BAKE_DP); return Object.is(v, -0) ? 0 : v; };
const isAxisAligned = (m) => Math.abs(m.b) < 1e-6 && Math.abs(m.c) < 1e-6;
const bakePoint = (m, x, y) => [roundCoord(m.a * x + m.c * y + m.e), roundCoord(m.b * x + m.d * y + m.f)];

// Multiply a numeric (or numeric-list) presentation attribute by `factor`, in place. Left untouched
// if missing, 'none', or non-numeric (so url()/percentage paint refs survive).
const scaleNumericAttr = (shape, attr, factor) => {
    const raw = shape.getAttribute(attr);
    if (raw == null || raw === '' || raw.trim() === 'none') return;
    const out = [];
    for (const p of raw.trim().split(/[\s,]+/)) {
        const n = parseFloat(p);
        if (!Number.isFinite(n)) return;
        out.push(String(roundCoord(n * factor)));
    }
    shape.setAttribute(attr, out.join(' '));
};

// --- SVG path data: tokenize, transform every coordinate by B, re-serialize (absolute output) -----
// Handles M L H V C S Q T Z, implicit-repeat coordinates, and relative or absolute commands. Arc
// commands (A/a) are NOT transformed here -- callers detect them and fall back.
const PATH_TOKEN_RE = /([MmLlHhVvCcSsQqTtZz])|(-?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?)/g;
const PATH_PARAMS = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, Z: 0 };

const transformPathData = (d, B) => {
    const toks = [];
    let mt;
    PATH_TOKEN_RE.lastIndex = 0;
    while ((mt = PATH_TOKEN_RE.exec(d)) !== null) toks.push(mt[1] != null ? mt[1] : parseFloat(mt[2]));

    const axis = isAxisAligned(B);
    const out = [];
    const emit = (...parts) => out.push(parts.join(' '));
    let i = 0, cmd = null;
    let curX = 0, curY = 0, startX = 0, startY = 0;      // absolute current point + subpath start

    while (i < toks.length) {
        if (typeof toks[i] === 'string') cmd = toks[i++];
        else if (cmd == null) { i++; continue; }          // stray number before any command
        const c = cmd;
        if (c === 'M') cmd = 'L'; else if (c === 'm') cmd = 'l';   // implicit repeats after M are L
        const up = c.toUpperCase();
        const rel = c !== up && up !== 'Z';               // lowercase letter = relative

        if (up === 'Z') { emit('Z'); curX = startX; curY = startY; continue; }

        const cpx = curX, cpy = curY;                     // origin for this instance's relative coords
        if (up === 'H') {
            let x = toks[i++]; if (rel) x += cpx;
            curX = x;                                      // y unchanged
            const [nx, ny] = bakePoint(B, x, cpy);
            if (axis) emit('H', nx); else emit('L', nx, ny);
            continue;
        }
        if (up === 'V') {
            let y = toks[i++]; if (rel) y += cpy;
            curY = y;                                      // x unchanged
            const [nx, ny] = bakePoint(B, cpx, y);
            if (axis) emit('V', ny); else emit('L', nx, ny);
            continue;
        }

        const pairs = [];                                 // M L C S Q T: (x,y) pairs, all rel to (cpx,cpy)
        for (let k = 0; k < PATH_PARAMS[up]; k += 2) {
            let x = toks[i++], y = toks[i++];
            if (rel) { x += cpx; y += cpy; }
            pairs.push(bakePoint(B, x, y));
            curX = x; curY = y;                           // last pair becomes the current point
        }
        if (up === 'M') { startX = curX; startY = curY; }
        emit(up, ...pairs.flat());
    }
    return out.join(' ');
};

// --- Per-shape-type geometry bakers. Return false when B can't be represented in the element's
//     attributes (rotated/sheared/non-uniform primitive, or an arc path) -> caller keeps the matrix.
const bakePath = (shape, B) => {
    const d = shape.getAttribute('d');
    if (!d || /[Aa]/.test(d)) return false;               // missing, or contains arc segments
    shape.setAttribute('d', transformPathData(d, B));
    return true;
};
const bakePoints = (shape, B) => {
    const raw = shape.getAttribute('points');
    if (!raw) return false;
    const nums = raw.trim().split(/[\s,]+/).map(parseFloat);
    if (nums.length < 2 || nums.some(n => !Number.isFinite(n))) return false;
    const out = [];
    for (let k = 0; k + 1 < nums.length; k += 2) { const [nx, ny] = bakePoint(B, nums[k], nums[k + 1]); out.push(nx + ',' + ny); }
    shape.setAttribute('points', out.join(' '));
    return true;
};
const bakeLine = (shape, B) => {
    const [nx1, ny1] = bakePoint(B, parseFloat(shape.getAttribute('x1')) || 0, parseFloat(shape.getAttribute('y1')) || 0);
    const [nx2, ny2] = bakePoint(B, parseFloat(shape.getAttribute('x2')) || 0, parseFloat(shape.getAttribute('y2')) || 0);
    shape.setAttribute('x1', nx1); shape.setAttribute('y1', ny1);
    shape.setAttribute('x2', nx2); shape.setAttribute('y2', ny2);
    return true;
};
const bakeRect = (shape, B) => {
    if (!isAxisAligned(B)) return false;
    const x = parseFloat(shape.getAttribute('x')) || 0, y = parseFloat(shape.getAttribute('y')) || 0;
    const w = parseFloat(shape.getAttribute('width')), h = parseFloat(shape.getAttribute('height'));
    if (!Number.isFinite(w) || !Number.isFinite(h)) return false;
    const x1 = B.a * x + B.e, x2 = B.a * (x + w) + B.e, y1 = B.d * y + B.f, y2 = B.d * (y + h) + B.f;
    const nw = Math.abs(x2 - x1), nh = Math.abs(y2 - y1);
    shape.setAttribute('x', roundCoord(Math.min(x1, x2)));
    shape.setAttribute('y', roundCoord(Math.min(y1, y2)));
    shape.setAttribute('width', roundCoord(nw));
    shape.setAttribute('height', roundCoord(nh));
    if (scaleCorners) {                                   // corner radii ride along only when the option is ON
        const sx = Math.abs(B.a), sy = Math.abs(B.d);
        const rx = shape.getAttribute('rx'), ry = shape.getAttribute('ry');
        if (rx != null) shape.setAttribute('rx', roundCoord(Math.min(parseFloat(rx) * sx, nw / 2)));
        if (ry != null) shape.setAttribute('ry', roundCoord(Math.min(parseFloat(ry) * sy, nh / 2)));
    }
    return true;
};
const bakeEllipse = (shape, B) => {
    if (!isAxisAligned(B)) return false;
    const rx = parseFloat(shape.getAttribute('rx')), ry = parseFloat(shape.getAttribute('ry'));
    if (!Number.isFinite(rx) || !Number.isFinite(ry)) return false;
    shape.setAttribute('cx', roundCoord(B.a * (parseFloat(shape.getAttribute('cx')) || 0) + B.e));
    shape.setAttribute('cy', roundCoord(B.d * (parseFloat(shape.getAttribute('cy')) || 0) + B.f));
    shape.setAttribute('rx', roundCoord(Math.abs(B.a) * rx));
    shape.setAttribute('ry', roundCoord(Math.abs(B.d) * ry));
    return true;
};
const bakeCircle = (shape, B) => {
    if (!isAxisAligned(B) || Math.abs(Math.abs(B.a) - Math.abs(B.d)) > 1e-6) return false;   // must stay circular
    const r = parseFloat(shape.getAttribute('r'));
    if (!Number.isFinite(r)) return false;
    shape.setAttribute('cx', roundCoord(B.a * (parseFloat(shape.getAttribute('cx')) || 0) + B.e));
    shape.setAttribute('cy', roundCoord(B.d * (parseFloat(shape.getAttribute('cy')) || 0) + B.f));
    shape.setAttribute('r', roundCoord(Math.abs(B.a) * r));
    return true;
};
const bakeMatrixIntoGeometry = (shape, B) => {
    switch ((shape.tagName || '').toLowerCase()) {
        case 'path': return bakePath(shape, B);
        case 'polygon':
        case 'polyline': return bakePoints(shape, B);
        case 'line': return bakeLine(shape, B);
        case 'rect': return bakeRect(shape, B);
        case 'ellipse': return bakeEllipse(shape, B);
        case 'circle': return bakeCircle(shape, B);
        default: return false;
    }
};

// Capture / restore the geometry + stroke attributes the baker can touch, so the Selection tool can
// cancel a scale drag (which now mutates geometry, not just the transform). Used from selection-tool.js.
const GEOM_SNAPSHOT_ATTRS = ['d', 'points', 'x', 'y', 'width', 'height', 'rx', 'ry', 'cx', 'cy', 'r', 'x1', 'y1', 'x2', 'y2', 'transform', 'stroke-width', 'stroke-dasharray', 'stroke-dashoffset'];
window.snapshotShapeGeometry = (shape) => {
    if (!shape) return null;
    const snap = {};
    for (const a of GEOM_SNAPSHOT_ATTRS) snap[a] = shape.getAttribute(a);
    return snap;
};
window.restoreShapeGeometry = (shape, snap) => {
    if (!shape || !snap) return;
    for (const a of GEOM_SNAPSHOT_ATTRS) { const v = snap[a]; if (v == null) shape.removeAttribute(a); else shape.setAttribute(a, v); }
};

// Fold a root-space transform M into the selected shape's own transform (newOwn = P⁻¹·M·P·own),
// write it to the global shape, and render. Shared core for both the Properties fields and the
// Selection tool's canvas drags. isScrubbing=true uses the deferred render path (preview only, no
// export/refresh) for smooth real-time drags; commit with false to flush.
const applyOwnFromRootMatrix = (M, P, own, isScrubbing) => {
    const Pinv = P.inverse();
    if (!isFiniteMatrix(Pinv)) return false;

    const newOwn = Pinv.multiply(M).multiply(P).multiply(own);
    if (!isFiniteMatrix(newOwn)) return false;

    const globalShape = globalOptimizedSvg.querySelector(`[data-pf-index="${editSelectedIndex}"]`);
    if (!globalShape) return false;

    const str = formatOwnTransform(newOwn);
    if (str) globalShape.setAttribute('transform', str);
    else globalShape.removeAttribute('transform');

    renderOutput(isScrubbing);   // preview always rebuilds; export + fields refresh only when committing
    return true;
};

// Apply a SCALE gesture (root-space matrix M) by baking it into the shape's GEOMETRY instead of
// folding it into the matrix, so the stroke renders uniformly (Illustrator-style) rather than being
// distorted per-axis by a non-uniform transform. The gesture's local-space equivalent B = F⁻¹·M·F
// (F = ancestors·own) is baked into the coordinates while `own` is left untouched, so any import
// transform on the shape is preserved (its stroke isn't disturbed). Falls back to a matrix fold for
// shapes/transforms the baker can't represent (arc paths, rotated/sheared or non-uniform primitives).
const applyScaleGesture = (M, isScrubbing) => {
    if (isMultiSelection()) {
        if (!globalOptimizedSvg) return false;
        let any = false;
        editSelectedIndices.forEach(idx => {
            const shape = globalOptimizedSvg.querySelector(`[data-pf-index="${idx}"]`);
            if (shape) { applyScaleToShapeBody(shape, M); any = true; }
        });
        if (any) renderOutput(isScrubbing);
        return any;
    }
    const g = getSelectionGeom();
    if (!g || !g.previewShape) return false;
    const F = g.P.multiply(g.own);                 // shape-local -> svg-root
    const Finv = F.inverse();
    if (!isFiniteMatrix(Finv)) return false;
    const B = Finv.multiply(M).multiply(F);        // the gesture, expressed in the shape's local space
    if (!isFiniteMatrix(B)) return false;

    const globalShape = globalOptimizedSvg.querySelector(`[data-pf-index="${editSelectedIndex}"]`);
    if (!globalShape) return false;

    if (isRasterLayerShape(globalShape))
        return applyOwnFromRootMatrix(M, g.P, g.own, isScrubbing);   // preserve embedded pixels; resize via transform only

    if (!bakeMatrixIntoGeometry(globalShape, B))
        return applyOwnFromRootMatrix(M, g.P, g.own, isScrubbing);   // fall back to the matrix path

    // Geometry is now baked (uniform stroke); stroke weight / dashes ride along only when ON.
    if (scaleStrokesEffects) {
        const stretch = Math.sqrt(Math.abs(B.a * B.d - B.b * B.c));   // √|det| of the local gesture
        if (stretch > 1e-9 && Math.abs(stretch - 1) > 1e-9) {
            scaleNumericAttr(globalShape, 'stroke-width', stretch);
            scaleNumericAttr(globalShape, 'stroke-dasharray', stretch);
            scaleNumericAttr(globalShape, 'stroke-dashoffset', stretch);
        }
    }
    renderOutput(isScrubbing);
    return true;
};
window.applyScaleGesture = applyScaleGesture;

// Apply an edit of one field, expressed as a root-space transform M folded into the shape's own
// transform. Returns true on success, false if rejected.
const applyTransformEdit = (field, value, isScrubbing = false) => {
    const g = getActiveSelectionGeom();
    if (!g || !g.previewShape) return false;
    if (!isScrubbing) window.setHistoryLabel?.((field === 'width' || field === 'height') ? 'Scale' : 'Move', 'selection-tool');
    const { P, own, rootBBox, vbX, vbY } = g;

    const { ax, ay } = getRefAnchor(rootBBox);                 // reference-point anchor, root coords
    let M;
    if (field === 'x') {
        M = new DOMMatrix().translate((value + vbX) - ax, 0);
    } else if (field === 'y') {
        M = new DOMMatrix().translate(0, (value + vbY) - ay);
    } else if (field === 'width' || field === 'height') {
        if (value < PROP_MIN_SIZE) return false;
        let sx = 1, sy = 1;
        if (field === 'width') {
            if (rootBBox.w <= 1e-6) return false;
            sx = value / rootBBox.w;
            if (propConstrain) sy = sx;
        } else {
            if (rootBBox.h <= 1e-6) return false;
            sy = value / rootBBox.h;
            if (propConstrain) sx = sy;
        }
        M = new DOMMatrix().translate(ax, ay).scale(sx, sy).translate(-ax, -ay);
    } else {
        return false;
    }

    // Width/Height are scales -> bake into geometry (uniform stroke); X/Y are moves -> matrix fold.
    return (field === 'width' || field === 'height')
        ? applyScaleGesture(M, isScrubbing)
        : (isMultiSelection() ? applyGroupRootMatrix(M, isScrubbing) : applyOwnFromRootMatrix(M, P, own, isScrubbing));
};

// Shared entry points for the Selection tool's canvas drags: it measures the current selection,
// builds a root-space gesture matrix M, and folds it into whatever is selected -- one engine, so
// the canvas and the Properties fields can never disagree. applySelectionRootMatrix re-measures
// each call, so callers pass an incremental M (fold deltas, matching the scrub model).
window.getSelectionGeom = getSelectionGeom;

// Group variant of applySelectionRootMatrix: fold the same root-space M into every selected
// shape's own transform, with ONE render for the whole group (isScrubbing discipline preserved).
const applyGroupRootMatrix = (M, isScrubbing) => {
    if (!globalOptimizedSvg) return false;
    let any = false;
    editSelectedIndices.forEach(idx => {
        const shape = globalOptimizedSvg.querySelector(`[data-pf-index="${idx}"]`);
        if (!shape) return;
        const P = cumulativeAncestorMatrix(shape, globalOptimizedSvg);
        const own = svgTransformToMatrix(shape.getAttribute('transform') || '');
        foldMatrixIntoShape(shape, M, P, own);
        any = true;
    });
    if (any) renderOutput(isScrubbing);
    return any;
};

window.applySelectionRootMatrix = (M, isScrubbing = false) => {
    if (isMultiSelection()) return applyGroupRootMatrix(M, isScrubbing);
    const g = getSelectionGeom();
    if (!g || !g.previewShape) return false;
    return applyOwnFromRootMatrix(M, g.P, g.own, isScrubbing);
};

const isGuidePropertiesMode = () => !!window.isGuidePropertiesMode?.();

const isArtboardPropertiesMode = () => !!window.isArtboardToolActive?.();

// Anchor mode (Direct Selection tool, anchor point selected): X/Y read/edit that anchor.
const isAnchorPropertiesMode = () => !!window.isDirectSelectionAnchorMode?.();

const getCurrentPropValues = () =>
    isGuidePropertiesMode() ? (window.getGuideDisplayValues?.() || null)
    : isArtboardPropertiesMode() ? (window.getArtboardDisplayValues?.() || null)
    : isAnchorPropertiesMode() ? (window.getAnchorDisplayValues?.() || null)
    : getDisplayValues(getActiveSelectionGeom());

const applyCurrentPropEdit = (field, value, isScrubbing = false) =>
    isGuidePropertiesMode() ? !!window.applyGuidePropertyEdit?.(field, value, isScrubbing)
    : isArtboardPropertiesMode() ? !!window.applyArtboardPropertyEdit?.(field, value, isScrubbing)
    : isAnchorPropertiesMode() ? !!window.applyAnchorPropertyEdit?.(field, value, isScrubbing)
    : applyTransformEdit(field, value, isScrubbing);

// Scale-option checkbox handlers (global modes; apply to subsequent scale gestures, like Illustrator).
window.toggleScaleStrokesEffects = (on) => { scaleStrokesEffects = !!on; };
window.toggleScaleCorners = (on) => { scaleCorners = !!on; };
window.toggleScaleContentsWithArtboard = (on) => {
    scaleContentsWithArtboard = !!on;
    // Un-grey / grey Scale strokes + Scale corners as this toggles (only meaningful in artboard mode).
    if (propScaleOptsEl) propScaleOptsEl.classList.toggle('contents-locked', isArtboardPropertiesMode() && !scaleContentsWithArtboard);
};

// Shared reads for the Artboard tool (its box math lives in artboard-tool.js but must honour the
// same reference point + constrain link the element mode uses).
window.getActiveRefFactors = () => REF_FACTORS[propRefPoint] || REF_FACTORS.tl;
window.getPropConstrain = () => propConstrain;

// ---- "Scale contents with artboard" engine -----------------------------------------------------
// While the artboard is being resized with this option ON, the whole artwork scales about the
// resize's fixed anchor (content coords). The live preview is one cheap temporary transform on the
// #ink-wrapper; on release it is baked into every shape's geometry (reusing the per-shape bakers)
// so the "Scale strokes & effects" / "Scale corners" flags take effect and the export stays clean.
let abContentBase = null;   // { wrap, base } captured when a content-scale preview begins

const scaleAboutMatrix = (ax, ay, sx, sy) =>
    new DOMMatrix().translate(ax, ay).scale(sx, sy).translate(-ax, -ay);

const restoreContentBase = () => {
    if (!abContentBase) return;
    const { wrap, base } = abContentBase;
    if (base) wrap.setAttribute('transform', base); else wrap.removeAttribute('transform');
    abContentBase = null;
};

// Live preview: set (not accumulate) a temporary scale transform on the ink wrapper, layered over
// any pre-existing wrapper transform (captured once, restored on clear/commit).
window.previewScaleAllContent = (ax, ay, sx, sy) => {
    const wrap = globalOptimizedSvg && globalOptimizedSvg.querySelector('#ink-wrapper');
    if (!wrap) return false;
    if (!abContentBase || abContentBase.wrap !== wrap) abContentBase = { wrap, base: wrap.getAttribute('transform') || '' };
    const T = fmtTransformNum;
    const M = `translate(${T(ax)}, ${T(ay)}) scale(${T(sx)}, ${T(sy)}) translate(${T(-ax)}, ${T(-ay)})`;
    wrap.setAttribute('transform', abContentBase.base ? `${M} ${abContentBase.base}` : M);
    renderOutput(true);
    return true;
};

window.clearContentScalePreview = () => { restoreContentBase(); renderOutput(true); };

// Fold a root-space M into one shape's own transform (per-shape variant of applyOwnFromRootMatrix,
// for the "scale all content" path where the target isn't editSelectedIndex).
const foldMatrixIntoShape = (shape, M, P, own) => {
    const Pinv = P.inverse();
    if (!isFiniteMatrix(Pinv)) return;
    const newOwn = Pinv.multiply(M).multiply(P).multiply(own);
    if (!isFiniteMatrix(newOwn)) return;
    const str = formatOwnTransform(newOwn);
    if (str) shape.setAttribute('transform', str); else shape.removeAttribute('transform');
};

// Scale ONE shape by a root-space M: bake B = F⁻¹·M·F into its geometry (uniform stroke), falling
// back to a matrix fold for rasters / non-bakeable shapes, honouring the scale-strokes flag.
// Shared by commitScaleAllContent and multi-selection (group) scale gestures.
const applyScaleToShapeBody = (shape, M) => {
    const P = cumulativeAncestorMatrix(shape, globalOptimizedSvg);
    const own = svgTransformToMatrix(shape.getAttribute('transform') || '');
    if (isRasterLayerShape(shape)) { foldMatrixIntoShape(shape, M, P, own); return; }
    const F = P.multiply(own);
    const Finv = F.inverse();
    const B = isFiniteMatrix(Finv) ? Finv.multiply(M).multiply(F) : null;
    if (!B || !isFiniteMatrix(B) || !bakeMatrixIntoGeometry(shape, B)) { foldMatrixIntoShape(shape, M, P, own); return; }
    if (scaleStrokesEffects) {
        const stretch = Math.sqrt(Math.abs(B.a * B.d - B.b * B.c));
        if (stretch > 1e-9 && Math.abs(stretch - 1) > 1e-9) {
            scaleNumericAttr(shape, 'stroke-width', stretch);
            scaleNumericAttr(shape, 'stroke-dasharray', stretch);
            scaleNumericAttr(shape, 'stroke-dashoffset', stretch);
        }
    }
};

// Commit: remove the temp wrapper transform, then bake the scale into every ink shape (geometry,
// so strokes stay uniform), honouring the scale-strokes/scale-corners flags; non-bakeable shapes
// (arc paths, rotated/sheared primitives, rasters) fall back to a matrix fold. Finishes with a full render.
window.commitScaleAllContent = (ax, ay, sx, sy) => {
    if (!globalOptimizedSvg) return false;
    restoreContentBase();
    // A ~identity scale (e.g. a 1px nudge) shouldn't rewrite every shape's geometry.
    if (Math.abs(sx - 1) < 1e-9 && Math.abs(sy - 1) < 1e-9) { renderOutput(false); return true; }
    window.setHistoryLabel?.('Scale', 'selection-tool');
    const M = scaleAboutMatrix(ax, ay, sx, sy);
    globalOptimizedSvg.querySelectorAll('[data-pf-index]').forEach(shape => applyScaleToShapeBody(shape, M));
    renderOutput(false);
    return true;
};

const setFieldsEnabled = (enabled) => {
    PROP_FIELDS.forEach(k => { if (propInputs[k]) propInputs[k].disabled = !enabled; });
    if (propRotateInput) propRotateInput.disabled = !enabled;
    if (propRotatePresetBtn) propRotatePresetBtn.disabled = !enabled;
    if (propLinkBtn) propLinkBtn.disabled = !enabled;
    propFlipBtns.forEach(btn => { btn.disabled = !enabled; });
    propAlignBtns.forEach(btn => { btn.disabled = !enabled; });
};

const setScaleOptionsDisabled = (disabled) => {
    if (propScaleOptsEl) { propScaleOptsEl.classList.toggle('is-disabled', !!disabled); propScaleOptsEl.classList.remove('contents-locked'); }
    propScaleOptionInputs.forEach(inp => { inp.disabled = !!disabled; });
    if (propRefPointEl) propRefPointEl.classList.toggle('is-disabled', !!disabled);   // ref point is irrelevant in artboard mode
};

const showPropsEmpty = () => {
    if (propEmptyEl) propEmptyEl.hidden = true;
    if (propGridEl) {
        propGridEl.hidden = false;
        propGridEl.classList.add('is-empty');
        propGridEl.classList.remove('is-artboard');
        propGridEl.classList.remove('is-anchor');
        propGridEl.classList.remove('is-guide', 'is-guide-v', 'is-guide-h');
    }
    setScaleOptionsDisabled(false);
    setFieldsEnabled(false);
    PROP_FIELDS.forEach(k => {
        const el = propInputs[k];
        if (el) el.value = PROP_EMPTY_VALUE;
    });
    if (propRotateInput) propRotateInput.value = PROP_EMPTY_VALUE;
};

// Paint the four fields. values === null -> a selection with no measurable geometry (disabled, "-").
const showPropsValues = (values) => {
    if (propEmptyEl) propEmptyEl.hidden = true;
    if (propGridEl) {
        propGridEl.hidden = false;
        propGridEl.classList.toggle('is-empty', !values);
        propGridEl.classList.remove('is-artboard');
        propGridEl.classList.remove('is-anchor');
        propGridEl.classList.remove('is-guide', 'is-guide-v', 'is-guide-h');
    }
    setScaleOptionsDisabled(false);
    setFieldsEnabled(!!values);
    PROP_FIELDS.forEach(k => {
        const el = propInputs[k];
        if (el) el.value = values ? fmtPropNum(values[k]) : PROP_EMPTY_VALUE;
    });
    if (propRotateInput) propRotateInput.value = values ? fmtAngle(getStoredRotation()) : PROP_EMPTY_VALUE;
    // Width/Height can't be scaled from a zero dimension.
    if (values && propInputs.width) propInputs.width.disabled = values.width <= 1e-6;
    if (values && propInputs.height) propInputs.height.disabled = values.height <= 1e-6;
};

// Artboard mode (Artboard tool active): X/Y reposition the artboard, Width/Height resize it, the
// constrain link couples W/H, the reference point + scale options are live, and the align buttons
// move the artboard onto its contents. Rotation + flip don't apply to the artboard, so they grey out.
const showArtboardPropsValues = (values) => {
    if (propEmptyEl) propEmptyEl.hidden = true;
    if (propGridEl) {
        propGridEl.hidden = false;
        propGridEl.classList.toggle('is-empty', !values);
        propGridEl.classList.add('is-artboard');
        propGridEl.classList.remove('is-anchor');
        propGridEl.classList.remove('is-guide', 'is-guide-v', 'is-guide-h');
    }
    setScaleOptionsDisabled(false);          // scale options + reference-point grid are live here
    // Scale strokes/effects + Scale corners only apply when Scale contents is on -> grey them otherwise.
    if (propScaleOptsEl) propScaleOptsEl.classList.toggle('contents-locked', !scaleContentsWithArtboard);
    PROP_FIELDS.forEach(k => {
        const el = propInputs[k];
        if (el) { el.disabled = !values; el.value = values ? fmtPropNum(values[k]) : PROP_EMPTY_VALUE; }
    });
    if (values) {
        if (propInputs.width) propInputs.width.disabled = values.width <= 1e-6;
        if (propInputs.height) propInputs.height.disabled = values.height <= 1e-6;
    }
    if (propLinkBtn) propLinkBtn.disabled = !values;                 // constrain link couples W/H
    propAlignBtns.forEach(btn => { btn.disabled = !values; });       // align artboard to its contents
    // Rotation + flip are not applicable to the artboard.
    if (propRotateInput) { propRotateInput.disabled = true; propRotateInput.value = PROP_EMPTY_VALUE; }
    if (propRotatePresetBtn) propRotatePresetBtn.disabled = true;
    propFlipBtns.forEach(btn => { btn.disabled = true; });
};

// Anchor mode: only X/Y (the selected anchor's artboard position) and the align buttons are
// live; size, rotate, flip, constrain, scale options, and reference point are irrelevant to a
// single point, so they grey out (mirrors the artboard-mode treatment).
const showAnchorPropsValues = (values) => {
    if (propEmptyEl) propEmptyEl.hidden = true;
    if (propGridEl) {
        propGridEl.hidden = false;
        propGridEl.classList.toggle('is-empty', !values);
        propGridEl.classList.remove('is-artboard');
        propGridEl.classList.toggle('is-anchor', !!values);
        propGridEl.classList.remove('is-guide', 'is-guide-v', 'is-guide-h');
    }
    setScaleOptionsDisabled(true);
    setFieldsEnabled(false);
    PROP_FIELDS.forEach(k => {
        const el = propInputs[k];
        if (el) el.value = (values && (k === 'x' || k === 'y')) ? fmtPropNum(values[k]) : PROP_EMPTY_VALUE;
    });
    if (propRotateInput) propRotateInput.value = PROP_EMPTY_VALUE;
    if (values) {
        if (propInputs.x) propInputs.x.disabled = false;
        if (propInputs.y) propInputs.y.disabled = false;
        propAlignBtns.forEach(btn => { btn.disabled = false; });
    }
};

// Guide mode: guides are canvas UI, not document content. A vertical guide exposes X only; a
// horizontal guide exposes Y only. The inactive coordinate and all transform controls stay disabled.
const showGuidePropsValues = (values) => {
    if (propEmptyEl) propEmptyEl.hidden = true;
    if (propGridEl) {
        propGridEl.hidden = false;
        propGridEl.classList.toggle('is-empty', !values);
        propGridEl.classList.remove('is-artboard');
        propGridEl.classList.remove('is-anchor');
        propGridEl.classList.toggle('is-guide', !!values);
        propGridEl.classList.toggle('is-guide-v', !!values && values.axis === 'v');
        propGridEl.classList.toggle('is-guide-h', !!values && values.axis === 'h');
    }
    setScaleOptionsDisabled(true);
    setFieldsEnabled(false);
    PROP_FIELDS.forEach(k => {
        const el = propInputs[k];
        if (!el) return;
        if (values && k === 'x' && values.axis === 'v') el.value = fmtPropNum(values.x);
        else if (values && k === 'y' && values.axis === 'h') el.value = fmtPropNum(values.y);
        else el.value = PROP_EMPTY_VALUE;
    });
    if (propRotateInput) propRotateInput.value = PROP_EMPTY_VALUE;
    if (values && values.axis === 'v' && propInputs.x) propInputs.x.disabled = false;
    if (values && values.axis === 'h' && propInputs.y) propInputs.y.disabled = false;
};

// Sole external entry point: repaint for the current editSelectedIndex (the Selection-tool canvas pick).
// The Pathfinder buttons (js/path-finder.js) key off the same selection/mode state, so every tail
// also refreshes them.
window.refreshElementProperties = () => {
    if (isGuidePropertiesMode()) {
        showGuidePropsValues(window.getGuideDisplayValues?.() || null);
        window.refreshPathfinderButtons?.();
        window.refreshStrokeOptionButtons?.();
        return;
    }
    if (isArtboardPropertiesMode()) {
        showArtboardPropsValues(window.getArtboardDisplayValues?.() || null);
        window.refreshPathfinderButtons?.();
        window.refreshStrokeOptionButtons?.();
        return;
    }
    if (isAnchorPropertiesMode()) {
        showAnchorPropsValues(window.getAnchorDisplayValues?.() || null);
        window.refreshPathfinderButtons?.();
        window.refreshStrokeOptionButtons?.();
        return;
    }
    const g = getActiveSelectionGeom();
    if (!g) { showPropsEmpty(); window.refreshPathfinderButtons?.(); window.refreshStrokeOptionButtons?.(); return; }
    showPropsValues(getDisplayValues(g));     // g.previewShape === null -> null -> disabled dashes
    window.refreshPathfinderButtons?.();
    window.refreshStrokeOptionButtons?.();
};

// Edit selection = the object(s) the Properties panel / transform engine acts on. Owned by the
// Selection tool (canvas); clicking a layer card or Path-Locating a path does NOT set it.
// setEditSelectionSet keeps the scalar/Set invariant (scalar non-null iff exactly one selected).
window.setEditSelectionSet = (indices) => {
    const next = [];
    (indices || []).forEach(v => { if (v != null) next.push(String(v)); });
    // Same membership -> no-op (gesture-start syncs must not reset the group angle mid-session).
    if (next.length === editSelectedIndices.size && next.every(idx => editSelectedIndices.has(idx))) return;
    editSelectedIndices.clear();
    next.forEach(idx => editSelectedIndices.add(idx));
    editSelectedIndex = (editSelectedIndices.size === 1) ? next[0] : null;
    groupRotationAngle = 0;
    window.refreshElementProperties();
};
window.setEditSelection = (pfIndex) => {
    window.setEditSelectionSet(pfIndex == null ? [] : [pfIndex]);
};
window.clearEditSelection = () => {
    if (editSelectedIndex === null && editSelectedIndices.size === 0) return;
    editSelectedIndex = null;
    editSelectedIndices.clear();
    groupRotationAngle = 0;
    window.refreshElementProperties();
};

/* ---- Field editing (static elements; bound once at load) -------------------- */

// Commit the typed value: parse, validate, apply. Reverts (repaints) on invalid input.
const commitField = (field) => {
    if (propSuppressCommit) { propSuppressCommit = false; return; }
    const el = propInputs[field];
    if (!el || el.disabled) return;
    const parsed = parseFloat(el.value);
    const invalid = !Number.isFinite(parsed) || ((field === 'width' || field === 'height') && parsed < PROP_MIN_SIZE);
    if (invalid || !applyCurrentPropEdit(field, parsed)) window.refreshElementProperties();
};

const nudgeField = (field, dir, big) => {
    const el = propInputs[field];
    if (!el || el.disabled) return;
    const cur = parseFloat(el.value);
    if (!Number.isFinite(cur)) return;
    let next = cur + dir * (big ? 10 : 1);
    if (field === 'width' || field === 'height') next = Math.max(isArtboardPropertiesMode() ? ARTBOARD_PROP_MIN_SIZE : PROP_MIN_SIZE, next);
    if (!applyCurrentPropEdit(field, next)) window.refreshElementProperties();          // renderOutput's tail repaints the (still-focused) field
};

PROP_FIELDS.forEach(field => {
    const el = propInputs[field];
    if (!el) return;
    // Defer select() past the click's mouseup so a click selects the whole value (type-to-replace).
    el.addEventListener('focus', () => requestAnimationFrame(() => { if (document.activeElement === el) el.select(); }));
    el.addEventListener('blur', () => commitField(field));
    el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); el.blur(); }
        else if (e.key === 'Escape') { e.preventDefault(); propSuppressCommit = true; window.refreshElementProperties(); el.blur(); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); nudgeField(field, 1, e.shiftKey); }
        else if (e.key === 'ArrowDown') { e.preventDefault(); nudgeField(field, -1, e.shiftKey); }
    });
});

if (propLinkBtn) {
    propLinkBtn.addEventListener('click', () => {
        propConstrain = !propConstrain;
        propLinkBtn.classList.toggle('active', propConstrain);
        propLinkBtn.setAttribute('aria-pressed', propConstrain ? 'true' : 'false');
    });
}

// Reference-point grid: pick the anchor, then repaint X/Y to read the new corner (no geometry change).
const syncRefPointUI = () => propRefDots.forEach(d => d.classList.toggle('active', d.dataset.rp === propRefPoint));
propRefDots.forEach(dot => {
    dot.addEventListener('click', () => {
        const rp = dot.dataset.rp;
        if (!rp || rp === propRefPoint) return;
        propRefPoint = rp;
        syncRefPointUI();
        window.refreshElementProperties();
    });
});

const rotateSelectionTo = (targetDeg) => {
    const g = getActiveSelectionGeom();
    if (!g || !g.previewShape) return false;

    const target = normalizeAngle(targetDeg);
    const prev = getStoredRotation();
    const delta = target - prev;
    window.setHistoryLabel?.('Rotate', 'angle');
    const { ax: cx, ay: cy } = getRefAnchor(g.rootBBox);   // rotate about the reference point
    const M = new DOMMatrix().translate(cx, cy).rotate(delta).translate(-cx, -cy);

    setStoredRotation(target);
    if (isMultiSelection() ? applyGroupRootMatrix(M, false) : applyOwnFromRootMatrix(M, g.P, g.own, false)) return true;
    setStoredRotation(prev);
    return false;
};

const commitRotation = () => {
    if (propSuppressCommit) { propSuppressCommit = false; return; }
    if (!propRotateInput || propRotateInput.disabled) return;
    const parsed = parseAngle(propRotateInput.value);
    if (parsed === null || !rotateSelectionTo(parsed)) window.refreshElementProperties();
};

const nudgeRotation = (dir, big) => {
    if (!propRotateInput || propRotateInput.disabled) return;
    const cur = parseAngle(propRotateInput.value);
    rotateSelectionTo((cur === null ? getStoredRotation() : cur) + dir * (big ? 10 : 1));
};

if (propRotateInput) {
    propRotateInput.addEventListener('focus', () => requestAnimationFrame(() => { if (document.activeElement === propRotateInput) propRotateInput.select(); }));
    propRotateInput.addEventListener('blur', commitRotation);
    propRotateInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); propRotateInput.blur(); }
        else if (e.key === 'Escape') { e.preventDefault(); propSuppressCommit = true; window.refreshElementProperties(); propRotateInput.blur(); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); nudgeRotation(1, e.shiftKey); }
        else if (e.key === 'ArrowDown') { e.preventDefault(); nudgeRotation(-1, e.shiftKey); }
    });
}

const flipSelection = (axis) => {
    const g = getActiveSelectionGeom();
    if (!g || !g.previewShape) return false;

    const { ax: cx, ay: cy } = getRefAnchor(g.rootBBox);   // flip about the reference point
    const sx = axis === 'horizontal' ? -1 : 1;
    const sy = axis === 'vertical' ? -1 : 1;
    if (sx === 1 && sy === 1) return false;

    window.setHistoryLabel?.('Flip', axis === 'horizontal' ? 'flip-horizontal' : 'flip-vertical');
    const M = new DOMMatrix().translate(cx, cy).scale(sx, sy).translate(-cx, -cy);
    return isMultiSelection() ? applyGroupRootMatrix(M, false) : applyOwnFromRootMatrix(M, g.P, g.own, false);
};

propFlipBtns.forEach(btn => {
    btn.addEventListener('click', () => {
        if (btn.disabled) return;
        flipSelection(btn.getAttribute('data-prop-flip'));
    });
});

const alignSelectionToArtboard = (mode) => {
    const g = getActiveSelectionGeom();
    if (!g || !g.previewShape) return false;

    const { rootBBox } = g;
    const vb = getViewBoxBounds(g.svg);
    if (vb.w <= 0 || vb.h <= 0) return false;

    let dx = 0, dy = 0;
    if (mode === 'left') dx = vb.x - rootBBox.minX;
    else if (mode === 'hcenter') dx = (vb.x + vb.w / 2) - (rootBBox.minX + rootBBox.w / 2);
    else if (mode === 'right') dx = (vb.x + vb.w) - (rootBBox.minX + rootBBox.w);
    else if (mode === 'top') dy = vb.y - rootBBox.minY;
    else if (mode === 'vcenter') dy = (vb.y + vb.h / 2) - (rootBBox.minY + rootBBox.h / 2);
    else if (mode === 'bottom') dy = (vb.y + vb.h) - (rootBBox.minY + rootBBox.h);
    else return false;

    if (Math.abs(dx) < 1e-6 && Math.abs(dy) < 1e-6) return false;
    window.setHistoryLabel?.('Align', 'align-' + mode);
    const M = new DOMMatrix().translate(dx, dy);
    return isMultiSelection() ? applyGroupRootMatrix(M, false) : applyOwnFromRootMatrix(M, g.P, g.own, false);
};

propAlignBtns.forEach(btn => {
    btn.addEventListener('click', () => {
        if (btn.disabled) return;
        const mode = btn.getAttribute('data-prop-align');
        // Artboard mode: move the artboard itself onto its contents.
        if (isArtboardPropertiesMode()) { window.alignArtboardToContent?.(mode); return; }
        // Anchor mode: align the selected anchor point itself to the artboard.
        if (isAnchorPropertiesMode()) { window.alignSelectedAnchorToArtboard?.(mode); return; }
        alignSelectionToArtboard(mode);
    });
});

/* ---- Stroke options rows (Align / Cap / Corner) ---------------------------------------------- */
// Illustrator-style stroke controls under the Pathfinder row (#propsStrokeOptsGroup, index.html).
// Cap / Corner write the native stroke-linecap / stroke-linejoin presentation attributes on every
// selected shape; the SVG defaults (butt / miter) are stored by REMOVING the attribute so exports
// stay clean. Align has no native SVG equivalent: it stores intent as data-stroke-align="inner|
// outer" on the model shape (absent = center) and renderOutput() expands it into a clip-path
// (inner) or a masked stroke ghost (outer) on every render -- see expandStrokeAlignment()
// (preview-renderer.js). The pressed button mirrors the selection's common value; a mixed
// selection shows none pressed. Align enables only when every selected shape is closed
// (isStrokeAlignableShape, Illustrator-style).

const STROKE_OPT_TAGS = new Set(['path', 'rect', 'circle', 'ellipse', 'polygon', 'polyline', 'line']);
const strokeAlignBtns = Array.from(document.querySelectorAll('#propsStrokeOptsGroup [data-stroke-align]'));
const strokeCapBtns = Array.from(document.querySelectorAll('#propsStrokeOptsGroup [data-stroke-cap]'));
const strokeJoinBtns = Array.from(document.querySelectorAll('#propsStrokeOptsGroup [data-stroke-join]'));

// Selected stroke-eligible vector shapes from the live model (any count, unlike Pathfinder's 2+).
const strokeOptSelectedShapes = () => {
    if (!globalOptimizedSvg || editSelectedIndices.size === 0) return [];
    const out = [];
    editSelectedIndices.forEach(idx => {
        const shape = globalOptimizedSvg.querySelector(`[data-pf-index="${idx}"]`);
        if (shape && STROKE_OPT_TAGS.has((shape.tagName || '').toLowerCase())) out.push(shape);
    });
    return out;
};

// Common value across the selection for one option; null = mixed (no pressed button).
const strokeOptCommonValue = (shapes, read) => {
    let common = null;
    for (const s of shapes) {
        const v = read(s);
        if (common === null) common = v;
        else if (common !== v) return null;
    }
    return common;
};

const paintStrokeOptGroup = (btns, attr, value, enabled) => {
    btns.forEach(btn => {
        btn.disabled = !enabled;
        const on = enabled && value !== null && btn.getAttribute(attr) === value;
        btn.classList.toggle('active', on);
        btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
};

window.refreshStrokeOptionButtons = () => {
    const modeOk = !isArtboardPropertiesMode() && !isGuidePropertiesMode() && !isAnchorPropertiesMode();
    const shapes = modeOk ? strokeOptSelectedShapes() : [];
    const enabled = shapes.length > 0;
    const alignOk = enabled && shapes.every(isStrokeAlignableShape);
    paintStrokeOptGroup(strokeAlignBtns, 'data-stroke-align', alignOk ? strokeOptCommonValue(shapes, s => s.getAttribute('data-stroke-align') || 'center') : null, alignOk);
    paintStrokeOptGroup(strokeCapBtns, 'data-stroke-cap', enabled ? strokeOptCommonValue(shapes, s => s.getAttribute('stroke-linecap') || 'butt') : null, enabled);
    paintStrokeOptGroup(strokeJoinBtns, 'data-stroke-join', enabled ? strokeOptCommonValue(shapes, s => s.getAttribute('stroke-linejoin') || 'miter') : null, enabled);
};

// Write one option to every selected shape; the default value is stored by removing the attribute.
const applyStrokeOption = (attr, value, defaultValue, label, icon) => {
    const shapes = strokeOptSelectedShapes();
    if (!shapes.length) return;
    window.setHistoryLabel?.(label, icon);
    shapes.forEach(s => { if (value === defaultValue) s.removeAttribute(attr); else s.setAttribute(attr, value); });
    renderOutput(false);   // committed render: export + history + refreshElementProperties -> button repaint
};

strokeAlignBtns.forEach(btn => btn.addEventListener('click', () => {
    if (btn.disabled) return;
    const v = btn.getAttribute('data-stroke-align');
    applyStrokeOption('data-stroke-align', v, 'center', 'Align Stroke', 'stroke-align-' + v);
}));
strokeCapBtns.forEach(btn => btn.addEventListener('click', () => {
    if (btn.disabled) return;
    const v = btn.getAttribute('data-stroke-cap');
    applyStrokeOption('stroke-linecap', v, 'butt', 'Stroke Cap', 'stroke-cap-' + (v === 'square' ? 'projecting' : v));
}));
strokeJoinBtns.forEach(btn => btn.addEventListener('click', () => {
    if (btn.disabled) return;
    const v = btn.getAttribute('data-stroke-join');
    applyStrokeOption('stroke-linejoin', v, 'miter', 'Stroke Corner', 'stroke-join-' + v);
}));

window.refreshStrokeOptionButtons();

/* ---- Scrubby-slider labels (Illustrator-style: drag a label to change its value) ------------ */
// Pressing a property label and dragging left/right moves (X/Y) or resizes (Width/Height) the
// shape in real time. Each frame feeds applyTransformEdit on the deferred (scrubbing) render path
// so the preview stays smooth; release commits once (export + exact-value refresh). A plain click
// (no drag past the threshold) instead focuses the field for typing.

const SCRUB_THRESHOLD = 3;          // px of movement before a press becomes a scrub (vs a click)
const LABEL_FIELD = { propX: 'x', propY: 'y', propWidth: 'width', propHeight: 'height' };

let scrub = null;                   // { field, labelEl, downX, lastX, value, start, moved, pointerId }
let scrubRaf = 0;

// Live pixels-per-unit modifier, read each move so it can change mid-drag (matches the stroke field).
const scrubMultiplier = (e) => (e.shiftKey ? 10 : ((e.ctrlKey || e.altKey) ? 0.1 : 1));

// Update the readouts during a scrub without re-measuring (the auto-refresh is skipped while
// scrubbing): the dragged field shows its value; a constrained partner is derived analytically.
const updateScrubDisplay = () => {
    const { field, value, start } = scrub;
    if (propInputs[field]) propInputs[field].value = fmtPropNum(value);
    if (propConstrain) {   // linked W/H track live during a label scrub (element + artboard modes)
        if (field === 'width' && start.width > 1e-6 && propInputs.height) propInputs.height.value = fmtPropNum(start.height * (value / start.width));
        else if (field === 'height' && start.height > 1e-6 && propInputs.width) propInputs.width.value = fmtPropNum(start.width * (value / start.height));
    }
};

const flushScrub = () => {
    scrubRaf = 0;
    if (!scrub || !scrub.moved) return;
    if (applyCurrentPropEdit(scrub.field, scrub.value, true)) updateScrubDisplay();
};

const onScrubMove = (e) => {
    if (!scrub) return;
    if (!scrub.moved) {
        if (Math.abs(e.clientX - scrub.downX) < SCRUB_THRESHOLD) return;
        scrub.moved = true;
        scrub.lastX = e.clientX;                      // rebaseline so the dead-zone doesn't shift the value
        document.body.classList.add('is-scrubbing-prop');
    }
    scrub.value += (e.clientX - scrub.lastX) * scrubMultiplier(e);
    scrub.lastX = e.clientX;
    if (scrub.field === 'width' || scrub.field === 'height') scrub.value = Math.max(isArtboardPropertiesMode() ? ARTBOARD_PROP_MIN_SIZE : PROP_MIN_SIZE, scrub.value);
    if (!scrubRaf) scrubRaf = requestAnimationFrame(flushScrub);
};

const onScrubEnd = () => {
    if (!scrub) return;
    const s = scrub;
    if (scrubRaf) { cancelAnimationFrame(scrubRaf); scrubRaf = 0; }
    s.labelEl.removeEventListener('pointermove', onScrubMove);
    s.labelEl.removeEventListener('pointerup', onScrubEnd);
    s.labelEl.removeEventListener('pointercancel', onScrubEnd);
    try { s.labelEl.releasePointerCapture(s.pointerId); } catch (_) {}
    document.body.classList.remove('is-scrubbing-prop');
    scrub = null;
    if (s.moved) applyCurrentPropEdit(s.field, s.value, false);   // final commit: export + fields refresh
    else propInputs[s.field]?.focus();                          // it was a click -> type
};

if (propGridEl) {
    propGridEl.querySelectorAll('.prop-label').forEach(labelEl => {
        const field = LABEL_FIELD[labelEl.htmlFor];
        if (!field) return;
        labelEl.addEventListener('pointerdown', (e) => {
            if (e.button !== 0 || scrub) return;
            const input = propInputs[field];
            if (!input || input.disabled) return;
            // Commit any in-progress typed edit before scrubbing.
            const active = document.activeElement;
            if (active && active.classList && active.classList.contains('prop-value')) active.blur();
            const vals = getCurrentPropValues();
            if (!vals) return;
            e.preventDefault();
            scrub = { field, labelEl, downX: e.clientX, lastX: e.clientX, value: vals[field], start: vals, moved: false, pointerId: e.pointerId };
            try { labelEl.setPointerCapture(e.pointerId); } catch (_) {}
            labelEl.addEventListener('pointermove', onScrubMove);
            labelEl.addEventListener('pointerup', onScrubEnd);
            labelEl.addEventListener('pointercancel', onScrubEnd);
        });
        // Focus is managed manually (drag scrubs, click types), so neutralize native <label for> activation.
        labelEl.addEventListener('click', (e) => e.preventDefault());
    });
}

/* ---- Rotate field: angle-icon scrub + 45° preset dropdown ----------------------------------- */
// The angle icon is a scrubby handle (drag left/right to rotate, like the X/Y/W/H labels). Each
// frame rotates from the captured start orientation about the (fixed) reference-point pivot, so the
// motion is smooth and free of the 0/360 wrap that a stored-delta approach would hit. The caret
// button opens a 45°-increment preset menu, mirroring the layers stroke-width dropdown.

let rotScrub = null;                // { downX, lastX, value, startVal, applied, own0, P0, cx, cy, moved, pointerId }
let rotScrubRaf = 0;

const applyRotScrub = (isScrubbing) => {
    if (!rotScrub) return;
    if (!isScrubbing) window.setHistoryLabel?.('Rotate', 'angle');
    setStoredRotation(rotScrub.value);   // before render so a committed tail repaints the right angle
    if (isMultiSelection()) {
        // No captured own0/P0 exists for N shapes -> fold the delta incrementally each frame.
        const M = new DOMMatrix().translate(rotScrub.cx, rotScrub.cy).rotate(rotScrub.value - rotScrub.applied).translate(-rotScrub.cx, -rotScrub.cy);
        if (applyGroupRootMatrix(M, isScrubbing)) {
            rotScrub.applied = rotScrub.value;
            if (propRotateInput) propRotateInput.value = fmtAngle(rotScrub.value);
        }
        return;
    }
    const M = new DOMMatrix().translate(rotScrub.cx, rotScrub.cy).rotate(rotScrub.value - rotScrub.startVal).translate(-rotScrub.cx, -rotScrub.cy);
    if (applyOwnFromRootMatrix(M, rotScrub.P0, rotScrub.own0, isScrubbing) && propRotateInput) {
        propRotateInput.value = fmtAngle(rotScrub.value);
    }
};

const flushRotScrub = () => { rotScrubRaf = 0; if (rotScrub && rotScrub.moved) applyRotScrub(true); };

const onRotScrubMove = (e) => {
    if (!rotScrub) return;
    if (!rotScrub.moved) {
        if (Math.abs(e.clientX - rotScrub.downX) < SCRUB_THRESHOLD) return;
        rotScrub.moved = true;
        rotScrub.lastX = e.clientX;                   // rebaseline so the dead-zone doesn't shift the value
        document.body.classList.add('is-scrubbing-prop');
    }
    rotScrub.value += (e.clientX - rotScrub.lastX) * scrubMultiplier(e);
    rotScrub.lastX = e.clientX;
    if (!rotScrubRaf) rotScrubRaf = requestAnimationFrame(flushRotScrub);
};

const onRotScrubEnd = () => {
    if (!rotScrub) return;
    const s = rotScrub;
    if (rotScrubRaf) { cancelAnimationFrame(rotScrubRaf); rotScrubRaf = 0; }
    propAngleIcon.removeEventListener('pointermove', onRotScrubMove);
    propAngleIcon.removeEventListener('pointerup', onRotScrubEnd);
    propAngleIcon.removeEventListener('pointercancel', onRotScrubEnd);
    try { propAngleIcon.releasePointerCapture(s.pointerId); } catch (_) {}
    document.body.classList.remove('is-scrubbing-prop');
    if (s.moved) applyRotScrub(false);               // final commit: export + fields refresh
    rotScrub = null;
};

if (propAngleIcon) {
    propAngleIcon.addEventListener('pointerdown', (e) => {
        if (e.button !== 0 || rotScrub || !propRotateInput || propRotateInput.disabled) return;
        const g = getActiveSelectionGeom();
        if (!g || !g.previewShape) return;
        const active = document.activeElement;
        if (active && active.classList && active.classList.contains('prop-value')) active.blur();
        e.preventDefault();
        const parsed = parseAngle(propRotateInput.value);
        const start = (parsed === null ? getStoredRotation() : parsed);
        const a = getRefAnchor(g.rootBBox);
        rotScrub = { downX: e.clientX, lastX: e.clientX, value: start, startVal: start, applied: start, own0: g.own, P0: g.P, cx: a.ax, cy: a.ay, moved: false, pointerId: e.pointerId };
        try { propAngleIcon.setPointerCapture(e.pointerId); } catch (_) {}
        propAngleIcon.addEventListener('pointermove', onRotScrubMove);
        propAngleIcon.addEventListener('pointerup', onRotScrubEnd);
        propAngleIcon.addEventListener('pointercancel', onRotScrubEnd);
    });
}

const ANGLE_PRESETS = [0, 45, 90, 135, 180, 225, 270, 315];
let angleDropdown = null;

const ensureAngleDropdown = () => {
    if (angleDropdown) return angleDropdown;
    angleDropdown = document.createElement('div');
    angleDropdown.className = 'stroke-dropdown';     // reuse the layers stroke-width dropdown styling
    document.body.appendChild(angleDropdown);
    document.addEventListener('pointerdown', (e) => {
        if (angleDropdown.style.display === 'block' && !angleDropdown.contains(e.target) && !(e.target.closest && e.target.closest('.props-rotate-dd-btn'))) {
            angleDropdown.style.display = 'none';
        }
    });
    return angleDropdown;
};

const openAngleDropdown = () => {
    const dd = ensureAngleDropdown();
    if (dd.style.display === 'block') { dd.style.display = 'none'; return; }
    dd.innerHTML = '';
    ANGLE_PRESETS.forEach(deg => {
        const item = document.createElement('div');
        item.className = 'stroke-dd-item';
        item.textContent = `${deg}°`;
        item.addEventListener('click', () => {
            dd.style.display = 'none';
            if (!propRotateInput || propRotateInput.disabled) return;
            if (!rotateSelectionTo(deg)) window.refreshElementProperties();
        });
        dd.appendChild(item);
    });
    const field = propRotatePresetBtn.closest('.props-rotate-field') || propRotatePresetBtn;
    const rect = field.getBoundingClientRect();
    dd.style.display = 'block';
    dd.style.minWidth = `${rect.width}px`;
    dd.style.left = `${rect.left}px`;
    dd.style.top = `${rect.bottom + 4}px`;
    const ddRect = dd.getBoundingClientRect();
    if (ddRect.bottom > window.innerHeight - 8) dd.style.top = `${Math.max(8, rect.top - ddRect.height - 4)}px`;
    if (ddRect.right > window.innerWidth - 8) dd.style.left = `${Math.max(8, window.innerWidth - 8 - ddRect.width)}px`;
};

if (propRotatePresetBtn) {
    propRotatePresetBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (propRotatePresetBtn.disabled) return;
        openAngleDropdown();
    });
}
