/* fileName: direct-selection-tool.js */

// "Direct Selection" tool (Illustrator-style). While active, hovering the canvas traces the
// shape under the cursor with a thin green hairline (no bounding box); clicking selects the
// object and reveals its ANCHOR POINTS (small squares -- white fill / green border, all
// unselected on object-click). Clicking an anchor selects it (solid green); a selected anchor
// can be dragged on canvas, retyped/scrubbed via the Properties X/Y (anchor mode), or aligned
// to the artboard. Selecting an anchor that sits on curves also reveals its Bezier handles
// plus the facing handle of each neighbour anchor; handles are draggable -- a smooth pair
// stays anti-collinear (the opposite handle rotates, keeping its own length), Alt breaks the
// pair, and Alt-dropping a handle onto its anchor retracts (deletes) it.
//
// Geometry model: the shape's outline is parsed into shape-local anchors
// { x, y, hIn, hOut } per subpath. Paths accept any command set (relative, H/V, S/T/Q, arcs --
// all normalized to absolute cubics for the model); the `d` is rewritten (absolute M/L/C/Z)
// only when the user actually edits. Polygons / polylines / lines are edited natively through
// their own attributes. Rect / ellipse / circle primitives show their natural anchors
// immediately and are silently converted to a <path> on the FIRST edit (attributes, label and
// layer identity preserved; the layers panel is rebuilt once on commit because layer cards
// close over shape nodes).
//
// Mirrors selection-tool.js: hit-testing is free (pointer-events:none overlays leave e.target
// as the painted shape), and all chrome lives in the screen-space #directSelectionOverlay --
// never in globalOptimizedSvg -- so nothing leaks into export. Raster <image> layers have no
// anchors and are ignored entirely. Wrapped in an IIFE; reuses the matrix helpers from
// layers.js, selectLayer/clearLayerSelection, and snapshot/restoreShapeGeometry from
// properties.js. The Properties panel drives anchor edits through the window.* bridge at the
// bottom (isDirectSelectionAnchorMode / getAnchorDisplayValues / applyAnchorPropertyEdit /
// alignSelectedAnchorToArtboard).

(() => {

    let dselActive = false;         // tool engaged
    const dselObjects = new Set();  // data-pf-index set of shapes whose anchors are shown (separate from selectedLayerIndex)
    let dselPrimary = null;         // last-clicked object index (rebind/scroll target)
    let dselHoverIndex = null;      // data-pf-index currently traced by the hover outline
    const dselAnchors = new Set();  // selected anchors (may span objects), keys "pfIndex|sub|anchorIdx"

    const dselKey = (idx, sub, ai) => `${idx}|${sub}|${ai}`;
    const dselParseKey = (key) => {
        const p = key.split('|');
        return { idx: p[0], sub: +p[1], ai: +p[2] };
    };
    // The single selected anchor (parsed), or null when 0 or 2+ are selected. Bezier handle
    // chrome and the Properties X/Y bridge only apply to a lone anchor.
    const dselSingleAnchor = () => (dselAnchors.size === 1 ? dselParseKey([...dselAnchors][0]) : null);

    const DSEL_GREEN = '#00E676';
    const DSEL_OUTLINE_W = '1.5';   // screen px -- matches the Selection tool's chrome weight
    const DSEL_ANCHOR_PX = 6;       // anchor square size in screen px (a bit smaller than the 8px sel handles)
    const DSEL_ANCHOR_W = '1';      // anchor square border
    const DSEL_HANDLE_R = 2.5;      // visible Bezier handle dot radius (screen px)
    const DSEL_HANDLE_HIT_R = 6;    // invisible hit circle radius over each handle dot
    const DSEL_CENTER_PX = 3;       // non-interactive object-center marker
    const DSEL_RETRACT_PX = 4;      // Alt-drop a handle within this screen distance of its anchor -> retract
    const DSEL_DRAG_THRESHOLD = 3;  // px of travel before a press becomes a drag (vs a click)
    const DSEL_HOVER_ID = 'dsel-hover-outline';
    const DSEL_ANIM_PAD_MS = 40;
    const SVGNS = 'http://www.w3.org/2000/svg';

    // Marquee (rubber-band select) chrome -- matches the Selection tool's neutral hairline (crisp
    // cool-white line over a soft dark casing) so it reads on the dark canvas and over any artwork.
    const DSEL_MARQUEE_LINE = 'rgba(240,245,255,0.95)';
    const DSEL_MARQUEE_LINE_W = '1.25';
    const DSEL_MARQUEE_CASING = 'rgba(0,0,0,0.4)';
    const DSEL_MARQUEE_CASING_W = '2.75';

    const DSEL_KAPPA = 0.5522847498307936;   // cubic approximation of a quarter arc
    const DSEL_EPS_HANDLE = 5e-4;            // control point closer than this to its anchor = no handle
    const DSEL_EPS_CLOSE = 1e-3;             // closing point within this of the subpath start = same anchor
    const DSEL_GEOM_ATTRS = new Set(['x', 'y', 'width', 'height', 'rx', 'ry', 'cx', 'cy', 'r', 'points', 'x1', 'y1', 'x2', 'y2']);

    let dselSyncRaf = 0, dselAnimRaf = 0, dselAnimUntil = 0;

    // Active gesture, null when idle: { mode:'anchor'|'handle', ... }.
    let dselDrag = null;
    let dselDragRaf = 0, dselDragPending = null;

    // Active marquee gesture (rubber-band anchor select), null when idle:
    // { pointerId, downX, downY, startRoot, curRoot, moved, add, subtract }. Separate from dselDrag.
    let dselMarquee = null;

    // Set when a primitive was converted to <path> during a Properties scrub (deferred render
    // frames); the layers panel rebuild happens once, on the scrub's final commit.
    let dselPendingRebuild = false;

    const dselPreviewSvg = () => previewArea.querySelector(PREVIEW_SVG_SELECTOR);

    // Resolve a pointer target to a vector layer shape (anchors need geometry -- images are ignored).
    const dselShapeFromTarget = (el) =>
        (el && el.tagName && el.matches && el.matches(SVG_VECTOR_LAYER_SHAPE_SELECTOR) && el.hasAttribute('data-pf-index')) ? el : null;

    const dselFindShapeByIndex = (idx) => {
        const svg = dselPreviewSvg();
        return (svg && idx != null) ? svg.querySelector(`[data-pf-index="${idx}"]`) : null;
    };

    const dselNum = (n) => {
        const v = +n.toFixed(4);
        return Object.is(v, -0) ? 0 : v;
    };

    const dselDist = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);

    /* ==== Anchor model ========================================================================
       { kind, needsConversion, subpaths: [ { closed, anchors: [ { x, y, hIn, hOut } ] } ] }
       All coordinates are shape-local. hIn/hOut are absolute control points (null = no handle):
       the segment anchor[k] -> anchor[k+1] is a line when neither hOut(k) nor hIn(k+1) exist,
       else the cubic C hOut(k) hIn(k+1) anchor[k+1]. A closed subpath's last->first segment is
       implicit (last.hOut / first.hIn; both null = the straight Z close). */

    const mkHandle = (hx, hy, ax, ay) =>
        (dselDist(hx, hy, ax, ay) > DSEL_EPS_HANDLE) ? { x: hx, y: hy } : null;

    // Arc -> cubic segments (SVG endpoint parameterization, split at <=90deg per cubic).
    const dselArcToCubics = (x1, y1, rx, ry, phiDeg, fa, fs, x2, y2) => {
        rx = Math.abs(rx); ry = Math.abs(ry);
        if (rx < 1e-9 || ry < 1e-9) return null;   // degenerate arc renders as a straight line
        const phi = phiDeg * Math.PI / 180;
        const cosP = Math.cos(phi), sinP = Math.sin(phi);
        const dx2 = (x1 - x2) / 2, dy2 = (y1 - y2) / 2;
        const x1p = cosP * dx2 + sinP * dy2;
        const y1p = -sinP * dx2 + cosP * dy2;
        const lam = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
        if (lam > 1) { const s = Math.sqrt(lam); rx *= s; ry *= s; }
        const sign = (fa === fs) ? -1 : 1;
        const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
        const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
        const co = den > 1e-12 ? sign * Math.sqrt(Math.max(0, num / den)) : 0;
        const cxp = co * rx * y1p / ry;
        const cyp = -co * ry * x1p / rx;
        const cx = cosP * cxp - sinP * cyp + (x1 + x2) / 2;
        const cy = sinP * cxp + cosP * cyp + (y1 + y2) / 2;
        const ang = (ux, uy, vx, vy) => {
            const dot = ux * vx + uy * vy;
            const len = Math.hypot(ux, uy) * Math.hypot(vx, vy);
            if (len < 1e-12) return 0;
            let a = Math.acos(Math.min(1, Math.max(-1, dot / len)));
            if (ux * vy - uy * vx < 0) a = -a;
            return a;
        };
        const th1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
        let dth = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
        if (!fs && dth > 0) dth -= 2 * Math.PI;
        if (fs && dth < 0) dth += 2 * Math.PI;
        const n = Math.max(1, Math.ceil(Math.abs(dth) / (Math.PI / 2)));
        const delta = dth / n;
        const t = (4 / 3) * Math.tan(delta / 4);
        const pt = (th) => ({
            x: cx + rx * Math.cos(th) * cosP - ry * Math.sin(th) * sinP,
            y: cy + rx * Math.cos(th) * sinP + ry * Math.sin(th) * cosP
        });
        const dpt = (th) => ({
            x: -rx * Math.sin(th) * cosP - ry * Math.cos(th) * sinP,
            y: -rx * Math.sin(th) * sinP + ry * Math.cos(th) * cosP
        });
        const out = [];
        for (let k = 0; k < n; k++) {
            const ta = th1 + k * delta, tb = ta + delta;
            const pa = pt(ta), pb = pt(tb), da = dpt(ta), db = dpt(tb);
            out.push({ c1x: pa.x + t * da.x, c1y: pa.y + t * da.y, c2x: pb.x - t * db.x, c2y: pb.y - t * db.y, x: pb.x, y: pb.y });
        }
        // Pin the final endpoint exactly (the trig walk can drift by float noise).
        out[out.length - 1].x = x2; out[out.length - 1].y = y2;
        return out;
    };

    // Full path-data parser -> subpath segment lists (absolute; every curve as a cubic).
    // Arc flags are read as ordinary numbers (this app's own path tokenizers assume separated
    // flags -- see roundPathData in dom-utils.js -- so compacted "013" flag runs never survive import).
    const DSEL_PATH_RE = /([MmLlHhVvCcSsQqTtAaZz])|(-?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?)/g;

    const dselParsePathSubs = (d) => {
        const toks = [];
        let mt;
        DSEL_PATH_RE.lastIndex = 0;
        while ((mt = DSEL_PATH_RE.exec(d)) !== null) toks.push(mt[1] != null ? mt[1] : parseFloat(mt[2]));

        const subs = [];
        let sp = null;                                   // { startX, startY, list: [], closed }
        let cx = 0, cy = 0, startX = 0, startY = 0;
        let prevC = null, prevQ = null;                  // reflection sources for S / T
        let i = 0, cmd = null;
        const read = () => { const v = toks[i++]; return typeof v === 'number' ? v : 0; };
        const open = (x, y) => { sp = { startX: x, startY: y, list: [], closed: false }; subs.push(sp); };
        const pushQ = (qx, qy, x, y) => {                // quadratic -> cubic (degree elevation)
            sp.list.push({
                t: 'C',
                c1x: cx + (2 / 3) * (qx - cx), c1y: cy + (2 / 3) * (qy - cy),
                c2x: x + (2 / 3) * (qx - x), c2y: y + (2 / 3) * (qy - y),
                x, y
            });
        };

        while (i < toks.length) {
            if (typeof toks[i] === 'string') cmd = toks[i++];
            else if (cmd == null) { i++; continue; }     // stray number before any command
            const c = cmd;
            if (c === 'M') cmd = 'L'; else if (c === 'm') cmd = 'l';   // implicit repeats after M are L
            const up = c.toUpperCase();
            const rel = c !== up && up !== 'Z';

            if (up === 'Z') {
                if (sp) sp.closed = true;
                cx = startX; cy = startY;
                sp = null;                               // drawing after Z starts a new subpath here
                prevC = prevQ = null;
                continue;
            }

            if (up === 'M') {
                let x = read(), y = read();
                if (rel) { x += cx; y += cy; }
                open(x, y);
                startX = cx = x; startY = cy = y;
                prevC = prevQ = null;
                continue;
            }

            if (!sp) { open(cx, cy); startX = cx; startY = cy; }

            if (up === 'H' || up === 'V') {
                let v = read();
                let x = cx, y = cy;
                if (up === 'H') x = rel ? cx + v : v;
                else y = rel ? cy + v : v;
                sp.list.push({ t: 'L', x, y });
                cx = x; cy = y;
                prevC = prevQ = null;
                continue;
            }
            if (up === 'L') {
                let x = read(), y = read();
                if (rel) { x += cx; y += cy; }
                sp.list.push({ t: 'L', x, y });
                cx = x; cy = y;
                prevC = prevQ = null;
                continue;
            }
            if (up === 'C' || up === 'S') {
                let c1x, c1y;
                if (up === 'C') {
                    c1x = read(); c1y = read();
                    if (rel) { c1x += cx; c1y += cy; }
                } else {
                    c1x = prevC ? 2 * cx - prevC.x : cx;
                    c1y = prevC ? 2 * cy - prevC.y : cy;
                }
                let c2x = read(), c2y = read(), x = read(), y = read();
                if (rel) { c2x += cx; c2y += cy; x += cx; y += cy; }
                sp.list.push({ t: 'C', c1x, c1y, c2x, c2y, x, y });
                cx = x; cy = y;
                prevC = { x: c2x, y: c2y };
                prevQ = null;
                continue;
            }
            if (up === 'Q' || up === 'T') {
                let qx, qy;
                if (up === 'Q') {
                    qx = read(); qy = read();
                    if (rel) { qx += cx; qy += cy; }
                } else {
                    qx = prevQ ? 2 * cx - prevQ.x : cx;
                    qy = prevQ ? 2 * cy - prevQ.y : cy;
                }
                let x = read(), y = read();
                if (rel) { x += cx; y += cy; }
                pushQ(qx, qy, x, y);
                cx = x; cy = y;
                prevQ = { x: qx, y: qy };
                prevC = null;
                continue;
            }
            if (up === 'A') {
                const rx = read(), ry = read(), rot = read(), fa = read() !== 0, fs = read() !== 0;
                let x = read(), y = read();
                if (rel) { x += cx; y += cy; }
                if (x !== cx || y !== cy) {
                    const curves = dselArcToCubics(cx, cy, rx, ry, rot, fa, fs, x, y);
                    if (curves) curves.forEach(s => sp.list.push({ t: 'C', ...s }));
                    else sp.list.push({ t: 'L', x, y });
                }
                cx = x; cy = y;
                prevC = prevQ = null;
                continue;
            }
            i++;                                         // unknown command letter: skip defensively
        }
        return subs;
    };

    const dselSubToAnchors = (sp) => {
        const anchors = [{ x: sp.startX, y: sp.startY, hIn: null, hOut: null }];
        for (const s of sp.list) {
            const prev = anchors[anchors.length - 1];
            if (s.t === 'C') {
                prev.hOut = mkHandle(s.c1x, s.c1y, prev.x, prev.y);
                anchors.push({ x: s.x, y: s.y, hIn: mkHandle(s.c2x, s.c2y, s.x, s.y), hOut: null });
            } else {
                anchors.push({ x: s.x, y: s.y, hIn: null, hOut: null });
            }
        }
        if (sp.closed && anchors.length > 1) {
            const first = anchors[0], last = anchors[anchors.length - 1];
            // Explicit return to the start point: merge it into the start anchor.
            if (Math.abs(first.x - last.x) < DSEL_EPS_CLOSE && Math.abs(first.y - last.y) < DSEL_EPS_CLOSE) {
                first.hIn = last.hIn;
                anchors.pop();
            }
        }
        return { closed: sp.closed, anchors };
    };

    const dselRectSubpath = (shape) => {
        const x = parseFloat(shape.getAttribute('x')) || 0;
        const y = parseFloat(shape.getAttribute('y')) || 0;
        const w = parseFloat(shape.getAttribute('width'));
        const h = parseFloat(shape.getAttribute('height'));
        if (!Number.isFinite(w) || !Number.isFinite(h)) return null;
        let rx = shape.getAttribute('rx'), ry = shape.getAttribute('ry');
        rx = (rx == null || rx === '') ? null : parseFloat(rx);
        ry = (ry == null || ry === '') ? null : parseFloat(ry);
        if (rx == null && ry == null) { rx = 0; ry = 0; }
        else if (rx == null) rx = ry;
        else if (ry == null) ry = rx;
        if (!Number.isFinite(rx) || rx < 0) rx = 0;
        if (!Number.isFinite(ry) || ry < 0) ry = 0;
        rx = Math.min(rx, w / 2); ry = Math.min(ry, h / 2);

        if (rx < DSEL_EPS_HANDLE || ry < DSEL_EPS_HANDLE) {
            return {
                closed: true,
                anchors: [
                    { x, y, hIn: null, hOut: null },
                    { x: x + w, y, hIn: null, hOut: null },
                    { x: x + w, y: y + h, hIn: null, hOut: null },
                    { x, y: y + h, hIn: null, hOut: null }
                ]
            };
        }
        const kx = rx * (1 - DSEL_KAPPA), ky = ry * (1 - DSEL_KAPPA);
        return {
            closed: true,
            anchors: [
                { x: x + rx, y, hIn: { x: x + kx, y }, hOut: null },
                { x: x + w - rx, y, hIn: null, hOut: { x: x + w - kx, y } },
                { x: x + w, y: y + ry, hIn: { x: x + w, y: y + ky }, hOut: null },
                { x: x + w, y: y + h - ry, hIn: null, hOut: { x: x + w, y: y + h - ky } },
                { x: x + w - rx, y: y + h, hIn: { x: x + w - kx, y: y + h }, hOut: null },
                { x: x + rx, y: y + h, hIn: null, hOut: { x: x + kx, y: y + h } },
                { x, y: y + h - ry, hIn: { x, y: y + h - ky }, hOut: null },
                { x, y: y + ry, hIn: null, hOut: { x, y: y + ky } }
            ]
        };
    };

    const dselEllipseSubpath = (cx, cy, rx, ry) => {
        if (!Number.isFinite(rx) || !Number.isFinite(ry)) return null;
        const hx = rx * DSEL_KAPPA, hy = ry * DSEL_KAPPA;
        return {
            closed: true,
            anchors: [
                { x: cx + rx, y: cy, hIn: { x: cx + rx, y: cy - hy }, hOut: { x: cx + rx, y: cy + hy } },
                { x: cx, y: cy + ry, hIn: { x: cx + hx, y: cy + ry }, hOut: { x: cx - hx, y: cy + ry } },
                { x: cx - rx, y: cy, hIn: { x: cx - rx, y: cy + hy }, hOut: { x: cx - rx, y: cy - hy } },
                { x: cx, y: cy - ry, hIn: { x: cx - hx, y: cy - ry }, hOut: { x: cx + hx, y: cy - ry } }
            ]
        };
    };

    const dselBuildModel = (shape) => {
        const tag = (shape.tagName || '').toLowerCase();
        if (tag === 'path') {
            const d = shape.getAttribute('d');
            if (!d) return null;
            const subpaths = dselParsePathSubs(d).map(dselSubToAnchors).filter(s => s.anchors.length);
            return subpaths.length ? { kind: 'path', needsConversion: false, subpaths } : null;
        }
        if (tag === 'polygon' || tag === 'polyline') {
            const nums = (shape.getAttribute('points') || '').trim().split(/[\s,]+/).map(parseFloat);
            const anchors = [];
            for (let k = 0; k + 1 < nums.length; k += 2) {
                if (!Number.isFinite(nums[k]) || !Number.isFinite(nums[k + 1])) return null;
                anchors.push({ x: nums[k], y: nums[k + 1], hIn: null, hOut: null });
            }
            return anchors.length ? { kind: tag, needsConversion: false, subpaths: [{ closed: tag === 'polygon', anchors }] } : null;
        }
        if (tag === 'line') {
            const a = { x: parseFloat(shape.getAttribute('x1')) || 0, y: parseFloat(shape.getAttribute('y1')) || 0, hIn: null, hOut: null };
            const b = { x: parseFloat(shape.getAttribute('x2')) || 0, y: parseFloat(shape.getAttribute('y2')) || 0, hIn: null, hOut: null };
            return { kind: 'line', needsConversion: false, subpaths: [{ closed: false, anchors: [a, b] }] };
        }
        if (tag === 'rect') {
            const sub = dselRectSubpath(shape);
            return sub ? { kind: 'rect', needsConversion: true, subpaths: [sub] } : null;
        }
        if (tag === 'ellipse' || tag === 'circle') {
            const cx = parseFloat(shape.getAttribute('cx')) || 0;
            const cy = parseFloat(shape.getAttribute('cy')) || 0;
            const rx = tag === 'circle' ? parseFloat(shape.getAttribute('r')) : parseFloat(shape.getAttribute('rx'));
            const ry = tag === 'circle' ? rx : parseFloat(shape.getAttribute('ry'));
            const sub = dselEllipseSubpath(cx, cy, rx, ry);
            return sub ? { kind: tag, needsConversion: true, subpaths: [sub] } : null;
        }
        return null;
    };

    const dselGeomSig = (shape) => {
        const tag = (shape.tagName || '').toLowerCase();
        const g = (a) => shape.getAttribute(a) || '';
        switch (tag) {
            case 'path': return 'd:' + g('d');
            case 'polygon':
            case 'polyline': return 'p:' + g('points');
            case 'line': return 'l:' + [g('x1'), g('y1'), g('x2'), g('y2')].join('|');
            case 'rect': return 'r:' + [g('x'), g('y'), g('width'), g('height'), g('rx'), g('ry')].join('|');
            case 'ellipse': return 'e:' + [g('cx'), g('cy'), g('rx'), g('ry')].join('|');
            case 'circle': return 'c:' + [g('cx'), g('cy'), g('r')].join('|');
            default: return null;
        }
    };

    // Model cache: one sig-gated entry per shape (multi-object selections keep every member's
    // model warm); reparse only when a shape's geometry string actually changes (external edits) --
    // every zoom/pan/redraw frame just re-projects the cached local-space anchors.
    const dselModels = new Map();   // pf-index -> { sig, model }

    // Drop selected-anchor keys of `idx` that no longer resolve in its (re)parsed model.
    const dselPruneAnchors = (idx, model) => {
        dselAnchors.forEach(key => {
            const k = dselParseKey(key);
            if (k.idx !== idx) return;
            if (!model || !model.subpaths[k.sub] || !model.subpaths[k.sub].anchors[k.ai]) dselAnchors.delete(key);
        });
    };

    const dselGetModel = (shape, idx) => {
        const sig = dselGeomSig(shape);
        if (sig == null) return null;
        idx = String(idx);
        const hit = dselModels.get(idx);
        if (hit && hit.sig === sig) return hit.model;
        const model = dselBuildModel(shape);
        if (model) dselModels.set(idx, { sig, model });
        else dselModels.delete(idx);
        // Structure may have changed under live anchor selections -- drop any now out of range.
        dselPruneAnchors(idx, model);
        return model;
    };

    /* ==== Serialization / write-back ======================================================== */

    const dselSerializePath = (model) => {
        const out = [];
        const seg = (a, b) => {
            if (!a.hOut && !b.hIn) { out.push('L', dselNum(b.x), dselNum(b.y)); return; }
            const c1 = a.hOut || a, c2 = b.hIn || b;
            out.push('C', dselNum(c1.x), dselNum(c1.y), dselNum(c2.x), dselNum(c2.y), dselNum(b.x), dselNum(b.y));
        };
        for (const sub of model.subpaths) {
            const A = sub.anchors;
            if (!A.length) continue;
            out.push('M', dselNum(A[0].x), dselNum(A[0].y));
            for (let k = 1; k < A.length; k++) seg(A[k - 1], A[k]);
            if (sub.closed) {
                const a = A[A.length - 1], b = A[0];
                if (a.hOut || b.hIn) seg(a, b);          // curved close needs the explicit segment
                out.push('Z');
            }
        }
        return out.join(' ');
    };

    const dselWriteGeometry = (globalShape, model) => {
        const tag = (globalShape.tagName || '').toLowerCase();
        if (tag === 'path') {
            globalShape.setAttribute('d', dselSerializePath(model));
        } else if (tag === 'polygon' || tag === 'polyline') {
            globalShape.setAttribute('points', model.subpaths[0].anchors.map(a => `${dselNum(a.x)},${dselNum(a.y)}`).join(' '));
        } else if (tag === 'line') {
            const [a, b] = model.subpaths[0].anchors;
            globalShape.setAttribute('x1', dselNum(a.x)); globalShape.setAttribute('y1', dselNum(a.y));
            globalShape.setAttribute('x2', dselNum(b.x)); globalShape.setAttribute('y2', dselNum(b.y));
        } else {
            return;
        }
        const idx = globalShape.getAttribute('data-pf-index');
        if (idx != null) dselModels.set(String(idx), { sig: dselGeomSig(globalShape), model });
    };

    // First-edit conversion: rect/ellipse/circle -> <path>, all non-geometry attributes kept
    // verbatim (paint, transform, data-pf-*), so the layer keeps its identity and label.
    const dselConvertToPath = (globalShape, model) => {
        const path = document.createElementNS(SVGNS, 'path');
        for (const attr of Array.from(globalShape.attributes)) {
            if (DSEL_GEOM_ATTRS.has(attr.name)) continue;
            path.setAttribute(attr.name, attr.value);
        }
        globalShape.replaceWith(path);
        model.kind = 'path';
        model.needsConversion = false;
        dselWriteGeometry(path, model);
        return path;
    };

    // Layer cards close over shape nodes, so a conversion must rebuild them once (on commit).
    const dselRebindLayersPanel = () => {
        buildLayersPanel();
        if (dselObjects.size) {
            window.setLayerSelectionSet?.([...dselObjects]);
            window.setEditSelectionSet?.([...dselObjects]);
        }
    };

    /* ==== Projection / chrome =============================================================== */

    // Projection matrix: viewBox-root coords -> #directSelectionOverlay screen px (and size the overlay).
    const dselScreenMatrix = () => {
        const svg = dselPreviewSvg();
        if (!svg || !directSelectionOverlay) return null;

        const areaRect = previewArea.getBoundingClientRect();
        const areaStyle = getComputedStyle(previewArea);
        const areaBorderL = parseFloat(areaStyle.borderLeftWidth) || 0;
        const areaBorderT = parseFloat(areaStyle.borderTopWidth) || 0;
        const areaW = areaRect.width - areaBorderL - (parseFloat(areaStyle.borderRightWidth) || 0);
        const areaH = areaRect.height - areaBorderT - (parseFloat(areaStyle.borderBottomWidth) || 0);
        const svgRect = svg.getBoundingClientRect();
        const vb = svg.getAttribute('viewBox') || svg.getAttribute('viewbox');
        let vbX = 0, vbY = 0;
        let vbW = parseFloat(svg.dataset.nativeW) || 128;
        let vbH = parseFloat(svg.dataset.nativeH) || 128;

        if (vb) {
            const p = vb.trim().split(/[\s,]+/);
            if (p.length === 4) {
                vbX = parseFloat(p[0]) || 0;
                vbY = parseFloat(p[1]) || 0;
                vbW = parseFloat(p[2]) || vbW;
                vbH = parseFloat(p[3]) || vbH;
            }
        }

        if (areaW <= 0 || areaH <= 0 || vbW <= 0 || vbH <= 0 || svgRect.width <= 0 || svgRect.height <= 0) return null;

        directSelectionOverlay.setAttribute('viewBox', `0 0 ${areaW} ${areaH}`);
        directSelectionOverlay.setAttribute('width', areaW);
        directSelectionOverlay.setAttribute('height', areaH);

        return new DOMMatrix()
            .translate(svgRect.left - areaRect.left - areaBorderL, svgRect.top - areaRect.top - areaBorderT)
            .scale(svgRect.width / vbW, svgRect.height / vbH)
            .translate(-vbX, -vbY);
    };

    // shape-local -> overlay screen px (full transform for the given shape).
    const dselFullMatrix = (shape, svg, screenMatrix) => {
        const anc = cumulativeAncestorMatrix(shape, svg);
        const own = shape.getAttribute('transform');
        const localToSvg = own ? anc.multiply(svgTransformToMatrix(own)) : anc;
        return screenMatrix.multiply(localToSvg);
    };

    const hideDselOverlay = () => {
        if (dselSyncRaf) { cancelAnimationFrame(dselSyncRaf); dselSyncRaf = 0; }
        if (dselAnimRaf) { cancelAnimationFrame(dselAnimRaf); dselAnimRaf = 0; }
        dselAnimUntil = 0;
        if (!directSelectionOverlay) return;
        if (directSelectionOverlay.hasAttribute('hidden') && !directSelectionOverlay.children.length) return;
        directSelectionOverlay.replaceChildren();
        directSelectionOverlay.toggleAttribute('hidden', true);
    };

    window.clearDirectSelectionOverlay = hideDselOverlay;

    const removeDselHoverOutline = () => {
        if (!directSelectionOverlay) return;
        const el = directSelectionOverlay.querySelector('#' + DSEL_HOVER_ID);
        if (el) el.remove();
        directSelectionOverlay.toggleAttribute('hidden', !directSelectionOverlay.children.length);
    };

    // Green path outline (cloned shape, paint/ids stripped, transform baked, non-scaling stroke).
    const dselDrawOutline = (shape, svg, screenMatrix, id) => {
        const outline = shape.cloneNode(false);
        if (id) outline.setAttribute('id', id);
        ['data-pf-index', 'data-pf-default-fill', 'class', 'style', 'clip-path', 'mask', 'filter',
         'opacity', 'fill-opacity', 'stroke-opacity', 'stroke-dasharray'].forEach(a => outline.removeAttribute(a));

        const full = dselFullMatrix(shape, svg, screenMatrix);
        if (full.isIdentity) outline.removeAttribute('transform');
        else outline.setAttribute('transform', matrixToString(full));

        outline.setAttribute('fill', 'none');
        outline.setAttribute('stroke', DSEL_GREEN);
        outline.setAttribute('stroke-width', DSEL_OUTLINE_W);
        outline.setAttribute('vector-effect', 'non-scaling-stroke');
        outline.setAttribute('stroke-linecap', 'round');
        outline.setAttribute('stroke-linejoin', 'round');
        outline.setAttribute('pointer-events', 'none');
        directSelectionOverlay.appendChild(outline);
    };

    // Which Bezier handles are visible: both sides of the selected anchor, plus each
    // neighbour's handle on the segment it shares with the selected anchor (Illustrator-style).
    const dselVisibleHandles = (sub, idx) => {
        const A = sub.anchors, n = A.length;
        const list = [];
        const add = (ai, side) => {
            const a = A[ai];
            if (a && a[side === 'in' ? 'hIn' : 'hOut'] && !list.some(e => e.ai === ai && e.side === side)) list.push({ ai, side });
        };
        add(idx, 'in');
        add(idx, 'out');
        if (n > 1) {
            const prev = sub.closed ? (idx - 1 + n) % n : idx - 1;
            const next = sub.closed ? (idx + 1) % n : idx + 1;
            if (prev >= 0 && prev !== idx) add(prev, 'out');
            if (next < n && next !== idx) add(next, 'in');
        }
        return list;
    };

    const dselDrawChrome = (shape, svg, screenMatrix, idx) => {
        dselDrawOutline(shape, svg, screenMatrix, null);

        const full = dselFullMatrix(shape, svg, screenMatrix);
        const model = dselGetModel(shape, idx);
        if (!model) return;

        const proj = (x, y) => full.transformPoint(new DOMPoint(x, y));

        // Object-center marker (non-interactive; the local bbox centroid maps exactly under affine).
        let bb = null;
        try { bb = shape.getBBox(); } catch (_) {}
        if (bb) {
            const c = proj(bb.x + bb.width / 2, bb.y + bb.height / 2);
            const m = document.createElementNS(SVGNS, 'rect');
            m.setAttribute('x', c.x - DSEL_CENTER_PX / 2);
            m.setAttribute('y', c.y - DSEL_CENTER_PX / 2);
            m.setAttribute('width', DSEL_CENTER_PX);
            m.setAttribute('height', DSEL_CENTER_PX);
            m.setAttribute('fill', DSEL_GREEN);
            m.setAttribute('pointer-events', 'none');
            directSelectionOverlay.appendChild(m);
        }

        // Handle hairlines go under the anchor squares; dots + hit circles above them. Bezier
        // handle chrome shows only for a lone selected anchor belonging to this shape.
        const single = dselSingleAnchor();
        const dots = [];
        if (single && single.idx === idx && model.subpaths[single.sub]) {
            const sub = model.subpaths[single.sub];
            for (const { ai, side } of dselVisibleHandles(sub, single.ai)) {
                const a = sub.anchors[ai];
                const h = a[side === 'in' ? 'hIn' : 'hOut'];
                const pa = proj(a.x, a.y), ph = proj(h.x, h.y);
                const line = document.createElementNS(SVGNS, 'line');
                line.setAttribute('x1', pa.x); line.setAttribute('y1', pa.y);
                line.setAttribute('x2', ph.x); line.setAttribute('y2', ph.y);
                line.setAttribute('stroke', DSEL_GREEN);
                line.setAttribute('stroke-width', '1');
                line.setAttribute('pointer-events', 'none');
                directSelectionOverlay.appendChild(line);
                dots.push({ ai, side, ph });
            }
        }

        // Anchor squares (interactive).
        const half = DSEL_ANCHOR_PX / 2;
        model.subpaths.forEach((sub, si) => {
            sub.anchors.forEach((a, ai) => {
                const p = proj(a.x, a.y);
                const isSel = dselAnchors.has(dselKey(idx, si, ai));
                const r = document.createElementNS(SVGNS, 'rect');
                r.setAttribute('x', p.x - half);
                r.setAttribute('y', p.y - half);
                r.setAttribute('width', DSEL_ANCHOR_PX);
                r.setAttribute('height', DSEL_ANCHOR_PX);
                r.setAttribute('fill', isSel ? DSEL_GREEN : '#ffffff');
                r.setAttribute('stroke', DSEL_GREEN);
                r.setAttribute('stroke-width', DSEL_ANCHOR_W);
                r.setAttribute('class', 'dsel-anchor');
                r.setAttribute('data-index', idx);
                r.setAttribute('data-sub', si);
                r.setAttribute('data-idx', ai);
                directSelectionOverlay.appendChild(r);
            });
        });

        // Handle dots on top (visible dot + larger invisible hit target).
        for (const { ai, side, ph } of dots) {
            const dot = document.createElementNS(SVGNS, 'circle');
            dot.setAttribute('cx', ph.x); dot.setAttribute('cy', ph.y);
            dot.setAttribute('r', DSEL_HANDLE_R);
            dot.setAttribute('fill', DSEL_GREEN);
            dot.setAttribute('pointer-events', 'none');
            directSelectionOverlay.appendChild(dot);
            const hit = document.createElementNS(SVGNS, 'circle');
            hit.setAttribute('cx', ph.x); hit.setAttribute('cy', ph.y);
            hit.setAttribute('r', DSEL_HANDLE_HIT_R);
            hit.setAttribute('fill', 'transparent');
            hit.setAttribute('class', 'dsel-handle-hit');
            hit.setAttribute('data-index', idx);
            hit.setAttribute('data-sub', single.sub);
            hit.setAttribute('data-idx', ai);
            hit.setAttribute('data-side', side);
            directSelectionOverlay.appendChild(hit);
        }
    };

    const redrawDselOverlay = () => {
        if (!dselActive || !directSelectionOverlay) { hideDselOverlay(); return; }

        const screenMatrix = dselScreenMatrix();
        directSelectionOverlay.replaceChildren();
        if (!screenMatrix) { directSelectionOverlay.toggleAttribute('hidden', true); return; }

        const svg = dselPreviewSvg();

        if (dselObjects.size) {
            // Drop members whose preview shape vanished (hidden/deleted), with their anchors + model.
            dselObjects.forEach(idx => {
                if (dselFindShapeByIndex(idx)) return;
                dselObjects.delete(idx);
                dselModels.delete(idx);
                dselPruneAnchors(idx, null);
            });
            if (dselPrimary != null && !dselObjects.has(dselPrimary)) dselPrimary = dselObjects.size ? [...dselObjects][0] : null;
            dselObjects.forEach(idx => dselDrawChrome(dselFindShapeByIndex(idx), svg, screenMatrix, idx));
        }

        // No hover preview while a gesture (edit or marquee) is in progress.
        if (!dselDrag && !dselMarquee && dselHoverIndex != null && !dselObjects.has(dselHoverIndex)) {
            const hover = dselFindShapeByIndex(dselHoverIndex);
            if (hover) dselDrawOutline(hover, svg, screenMatrix, DSEL_HOVER_ID);
            else dselHoverIndex = null;
        }

        if (dselMarquee && dselMarquee.moved) dselDrawMarquee(screenMatrix);

        directSelectionOverlay.toggleAttribute('hidden', !directSelectionOverlay.children.length);
    };

    const queueDselOverlaySync = () => {
        if (dselSyncRaf) return;
        dselSyncRaf = requestAnimationFrame(() => {
            dselSyncRaf = 0;
            redrawDselOverlay();
        });
    };

    // Keep the chrome registered with the live svg through zoom/pan/resize (matches the other tools).
    window.syncDirectSelectionOverlay = (animate = false) => {
        if (window.isGuideDragActive?.()) { hideDselOverlay(); return; }
        if (!dselActive || (dselHoverIndex == null && !dselObjects.size && !dselMarquee)) {
            if (directSelectionOverlay && (!directSelectionOverlay.hasAttribute('hidden') || directSelectionOverlay.children.length)) hideDselOverlay();
            return;
        }

        if (animate) {
            dselAnimUntil = performance.now() + VIEW_TRANSITION_MS + DSEL_ANIM_PAD_MS;
            const tick = () => {
                redrawDselOverlay();
                if (performance.now() < dselAnimUntil) dselAnimRaf = requestAnimationFrame(tick);
                else dselAnimRaf = 0;
            };
            if (!dselAnimRaf) dselAnimRaf = requestAnimationFrame(tick);
            return;
        }

        queueDselOverlaySync();
    };

    // renderOutput() rebuilds the preview svg on every edit -> re-apply chrome onto the fresh svg.
    window.refreshDirectSelectionOverlay = () => {
        if (window.isGuideDragActive?.()) { hideDselOverlay(); return; }
        if (!dselActive) { hideDselOverlay(); return; }
        dselHoverIndex = null;
        redrawDselOverlay();
    };

    // Clear the selection/hover lock without turning the tool off (fresh import/reset).
    window.clearDirectSelectionToolLock = () => {
        if (dselMarquee) dselTeardownMarquee();
        dselObjects.clear();
        dselPrimary = null;
        dselHoverIndex = null;
        dselAnchors.clear();
        dselModels.clear();
        dselPendingRebuild = false;
        hideDselOverlay();
    };

    /* ==== Activation ======================================================================== */

    const dselDeactivate = () => {
        dselCommitNudge();               // flush an uncommitted nudge burst before the tool leaves
        if (dselMarquee) dselTeardownMarquee();
        if (dselDrag) dselCancelDrag();
        dselActive = false;
        const btn = $('btnDirectSelectionTool');
        if (btn) btn.classList.remove('active');
        previewArea.classList.remove('dsel-active');
        hideDselOverlay();
        dselHoverIndex = null;
        dselObjects.clear();
        dselPrimary = null;
        const hadAnchor = dselAnchors.size > 0;
        dselAnchors.clear();             // panel edit selection (editSelectedIndex) is intentionally left as-is
        if (hadAnchor) window.refreshElementProperties?.();   // exit anchor mode in the Properties panel
    };

    window.deactivateDirectSelectionTool = () => { if (dselActive) dselDeactivate(); };

    // Toolbar button handler. Activating turns other canvas tools off (one active tool at a time).
    window.toggleDirectSelectionTool = (btn) => {
        if (dselActive) return;
        window.deactivateSelectionTool?.();
        window.deactivateHandTool?.();
        window.deactivateArtboardTool?.();
        window.deactivateShapeTool?.();
        window.deactivatePenTool?.();
        window.deactivateScissorsTool?.();
        dselActive = true;
        (btn || $('btnDirectSelectionTool'))?.classList.add('active');
        previewArea.classList.add('dsel-active');
        // Adopt the shared canvas selection (e.g. left by the Selection tool) so the current
        // object(s) stay selected across a tool switch (Illustrator-style); their anchors show
        // with none selected until the user picks one.
        if (editSelectedIndices.size) {
            const adopt = [...editSelectedIndices].filter(idx => !lockedLayers.has(String(idx)) && dselFindShapeByIndex(idx));
            if (adopt.length) {
                adopt.forEach(idx => dselObjects.add(idx));
                dselPrimary = adopt[0];
                dselAnchors.clear();
                redrawDselOverlay();
            }
        }
    };

    /* ==== Gestures: drag an anchor / drag a Bezier handle =================================== */

    // Pointer position -> artboard (viewBox) user units (same math as the Selection tool).
    const dselPointerRoot = (clientX, clientY) => {
        const svg = dselPreviewSvg();
        if (!svg) return null;
        const r = svg.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return null;
        let vbX = 0, vbY = 0;
        let vbW = parseFloat(svg.dataset.nativeW) || 128;
        let vbH = parseFloat(svg.dataset.nativeH) || 128;
        const vb = svg.getAttribute('viewBox') || svg.getAttribute('viewbox');
        if (vb) {
            const p = vb.trim().split(/[\s,]+/);
            if (p.length === 4) { vbX = parseFloat(p[0]) || 0; vbY = parseFloat(p[1]) || 0; vbW = parseFloat(p[2]) || vbW; vbH = parseFloat(p[3]) || vbH; }
        }
        return { x: vbX + (clientX - r.left) * (vbW / r.width), y: vbY + (clientY - r.top) * (vbH / r.height) };
    };

    // Live geometry for one shape: preview shape + local<->root matrices. Stable during a drag
    // (only geometry attributes change, never the transform chain).
    const dselGeom = (idx) => {
        if (!globalOptimizedSvg || idx == null) return null;
        const svg = dselPreviewSvg();
        if (!svg) return null;
        const previewShape = svg.querySelector(`[data-pf-index="${idx}"]`);
        if (!previewShape) return null;
        const P = cumulativeAncestorMatrix(previewShape, svg);
        const own = svgTransformToMatrix(previewShape.getAttribute('transform') || '');
        const F = P.multiply(own);
        const Finv = F.inverse();
        if (![Finv.a, Finv.b, Finv.c, Finv.d, Finv.e, Finv.f].every(Number.isFinite)) return null;
        return { svg, previewShape, F, Finv };
    };

    const dselPointerLocal = (Finv, clientX, clientY) => {
        const root = dselPointerRoot(clientX, clientY);
        return root ? Finv.transformPoint(new DOMPoint(root.x, root.y)) : null;
    };

    const dselIsSmoothAnchor = (a) => {
        if (!a.hIn || !a.hOut) return false;
        const v1x = a.hIn.x - a.x, v1y = a.hIn.y - a.y;
        const v2x = a.hOut.x - a.x, v2y = a.hOut.y - a.y;
        const l1 = Math.hypot(v1x, v1y), l2 = Math.hypot(v2x, v2y);
        if (l1 < DSEL_EPS_HANDLE || l2 < DSEL_EPS_HANDLE) return false;
        return (v1x * v2x + v1y * v2y) / (l1 * l2) < -0.999;   // anti-collinear within ~2.5 degrees
    };

    const dselStartCapture = (e) => {
        try { previewArea.setPointerCapture(e.pointerId); } catch (_) {}
        previewArea.addEventListener('pointermove', dselOnDragMove);
        previewArea.addEventListener('pointerup', dselOnDragEnd);
        previewArea.addEventListener('pointercancel', dselOnDragEnd);
    };

    const dselTeardownDrag = () => {
        if (dselDragRaf) { cancelAnimationFrame(dselDragRaf); dselDragRaf = 0; }
        dselDragPending = null;
        if (dselDrag) {
            try { previewArea.releasePointerCapture(dselDrag.pointerId); } catch (_) {}
        }
        previewArea.removeEventListener('pointermove', dselOnDragMove);
        previewArea.removeEventListener('pointerup', dselOnDragEnd);
        previewArea.removeEventListener('pointercancel', dselOnDragEnd);
        window.endSnapGesture?.();
    };

    // First-move setup. Handle mode: resolve the one global shape, convert a primitive if needed,
    // snapshot for Esc-cancel, capture the grab baselines. Anchor mode: group the selected anchors
    // by owning shape and prepare EVERY affected shape (convert / snapshot / per-shape Finv +
    // per-anchor baselines) so one drag moves them all. Returns false when nothing is editable.
    const dselPrepareDragEdit = (e) => {
        const d = dselDrag;

        if (d.mode === 'handle') {
            let globalShape = globalOptimizedSvg ? globalOptimizedSvg.querySelector(`[data-pf-index="${d.ownerIdx}"]`) : null;
            if (!globalShape) return false;
            const model = dselGetModel(globalShape, d.ownerIdx);
            const a = model && model.subpaths[d.sub] && model.subpaths[d.sub].anchors[d.idx];
            if (!a) return false;

            if (model.needsConversion) {
                d.originalEl = globalShape;
                globalShape = dselConvertToPath(globalShape, model);
                d.converted = true;
            } else {
                d.snapshot = window.snapshotShapeGeometry?.(globalShape);
            }
            d.globalShape = globalShape;
            d.model = model;

            const local = dselPointerLocal(d.Finv, e.clientX, e.clientY);
            if (!local) return false;
            d.baseLocal = { x: local.x, y: local.y };
            d.start = { x: a.x, y: a.y, hIn: a.hIn && { ...a.hIn }, hOut: a.hOut && { ...a.hOut } };

            const h = a[d.side === 'in' ? 'hIn' : 'hOut'];
            if (!h) return false;
            d.grabOffX = h.x - local.x;                  // keep the grabbed dot under the cursor
            d.grabOffY = h.y - local.y;
            const opp = a[d.side === 'in' ? 'hOut' : 'hIn'];
            d.oppLen = opp ? dselDist(opp.x, opp.y, a.x, a.y) : 0;
            d.smooth = dselIsSmoothAnchor(a);
            d.broken = false;
            return true;
        }

        // Anchor mode (the grabbed anchor is always in dselAnchors; the whole set moves together).
        const baseRoot = dselPointerRoot(e.clientX, e.clientY);
        const svg = dselPreviewSvg();
        if (!baseRoot || !svg || !globalOptimizedSvg) return false;
        d.baseRoot = baseRoot;

        const byShape = new Map();
        dselAnchors.forEach(key => {
            const k = dselParseKey(key);
            if (!byShape.has(k.idx)) byShape.set(k.idx, []);
            byShape.get(k.idx).push(k);
        });

        const targets = [];
        let anyConverted = false;
        byShape.forEach((keys, idx) => {
            const globalShape = globalOptimizedSvg.querySelector(`[data-pf-index="${idx}"]`);
            if (!globalShape) return;
            const model = dselGetModel(globalShape, idx);
            if (!model) return;
            const previewShape = svg.querySelector(`[data-pf-index="${idx}"]`);
            if (!previewShape) return;
            const P = cumulativeAncestorMatrix(previewShape, svg);
            const own = svgTransformToMatrix(previewShape.getAttribute('transform') || '');
            const Finv = P.multiply(own).inverse();
            if (![Finv.a, Finv.b, Finv.c, Finv.d, Finv.e, Finv.f].every(Number.isFinite)) return;

            const t = { idx, globalShape, model, Finv, converted: false, originalEl: null, snapshot: null, anchors: [] };
            if (model.needsConversion) {
                t.originalEl = globalShape;
                t.globalShape = dselConvertToPath(globalShape, model);
                t.converted = true;
                anyConverted = true;
            } else {
                t.snapshot = window.snapshotShapeGeometry?.(t.globalShape);
            }
            keys.forEach(k => {
                const a = model.subpaths[k.sub] && model.subpaths[k.sub].anchors[k.ai];
                if (a) t.anchors.push({ sub: k.sub, ai: k.ai, start: { x: a.x, y: a.y, hIn: a.hIn && { ...a.hIn }, hOut: a.hOut && { ...a.hOut } } });
            });
            if (t.anchors.length) targets.push(t);
        });

        if (!targets.length) return false;
        d.targets = targets;
        d.converted = anyConverted;

        // Snap baseline: the grabbed anchor's root-space start position (the whole set rides
        // one shared delta, so snapping the grabbed anchor aligns them all). docs/snapping.md.
        const ownerT = targets.find(t => t.idx === d.ownerIdx);
        const grabbed = ownerT && ownerT.anchors.find(r => r.sub === d.sub && r.ai === d.idx);
        if (grabbed) {
            const p = d.F.transformPoint(new DOMPoint(grabbed.start.x, grabbed.start.y));
            d.snapStart = { x: p.x, y: p.y };
        }
        window.beginSnapGesture?.({ exclude: targets.map(t => t.idx) });
        return true;
    };

    const dselApplyDragFrame = () => {
        dselDragRaf = 0;
        const d = dselDrag;
        if (!d || !d.moved || !dselDragPending) return;

        if (d.mode === 'anchor') {
            // Root-space pointer delta, converted to each shape's local space through its Finv
            // LINEAR part only (a delta carries no translation); every selected anchor rides along.
            const root = dselPointerRoot(dselDragPending.x, dselDragPending.y);
            if (!root) return;
            let rdx = root.x - d.baseRoot.x, rdy = root.y - d.baseRoot.y;
            if (d.shift) {
                // Shift constrains the anchor move to the nearest 45-degree direction
                // (constraint wins over snapping, Illustrator-style).
                const c = constrainVec45(rdx, rdy);
                rdx = c.x; rdy = c.y;
            } else if (d.snapStart) {
                const sp = window.snapRootPoint?.({ x: d.snapStart.x + rdx, y: d.snapStart.y + rdy });
                if (sp) { rdx = sp.x - d.snapStart.x; rdy = sp.y - d.snapStart.y; }
            }
            d.targets.forEach(t => {
                const ldx = t.Finv.a * rdx + t.Finv.c * rdy;
                const ldy = t.Finv.b * rdx + t.Finv.d * rdy;
                t.anchors.forEach(rec => {
                    const a = t.model.subpaths[rec.sub] && t.model.subpaths[rec.sub].anchors[rec.ai];
                    if (!a) return;
                    a.x = rec.start.x + ldx;
                    a.y = rec.start.y + ldy;
                    a.hIn = rec.start.hIn ? { x: rec.start.hIn.x + ldx, y: rec.start.hIn.y + ldy } : null;
                    a.hOut = rec.start.hOut ? { x: rec.start.hOut.x + ldx, y: rec.start.hOut.y + ldy } : null;
                });
                dselWriteGeometry(t.globalShape, t.model);
            });
            renderOutput(true);                  // one deferred render for the whole set
            window.refreshElementProperties?.(); // anchor-mode X/Y tick live (single anchor only)
            return;
        }

        const local = dselPointerLocal(d.Finv, dselDragPending.x, dselDragPending.y);
        if (!local) return;
        const a = d.model.subpaths[d.sub] && d.model.subpaths[d.sub].anchors[d.idx];
        if (!a) return;

        const key = d.side === 'in' ? 'hIn' : 'hOut';
        const oppKey = d.side === 'in' ? 'hOut' : 'hIn';
        a[key] = { x: local.x + d.grabOffX, y: local.y + d.grabOffY };
        if (d.smooth && !d.broken && a[oppKey]) {
            const vx = a.x - a[key].x, vy = a.y - a[key].y;   // opposite direction of the dragged handle
            const L = Math.hypot(vx, vy);
            if (L > 1e-9) a[oppKey] = { x: a.x + vx * (d.oppLen / L), y: a.y + vy * (d.oppLen / L) };
        }

        dselWriteGeometry(d.globalShape, d.model);
        renderOutput(true);                  // deferred path; tail re-applies our chrome onto the fresh svg
        window.refreshElementProperties?.(); // anchor-mode X/Y tick live
    };

    const dselOnDragMove = (e) => {
        const d = dselDrag;
        if (!d || e.pointerId !== d.pointerId) return;
        if (!d.moved) {
            if (Math.abs(e.clientX - d.downX) < DSEL_DRAG_THRESHOLD && Math.abs(e.clientY - d.downY) < DSEL_DRAG_THRESHOLD) return;
            if (!dselPrepareDragEdit(e)) { dselTeardownDrag(); dselDrag = null; return; }
            d.moved = true;
        }
        if (e.altKey) d.broken = true;       // Alt breaks a smooth pair; stays broken for this drag
        d.lastAlt = e.altKey;
        d.shift = e.shiftKey;                // live 45-degree constraint for anchor drags
        dselDragPending = { x: e.clientX, y: e.clientY };
        if (!dselDragRaf) dselDragRaf = requestAnimationFrame(dselApplyDragFrame);
    };

    const dselOnDragEnd = (e) => {
        const d = dselDrag;
        if (!d || (e && e.pointerId !== d.pointerId)) return;
        const moved = d.moved;

        // Alt-drop a handle onto its anchor -> retract (delete) it.
        if (moved && d.mode === 'handle' && d.lastAlt) {
            const a = d.model.subpaths[d.sub] && d.model.subpaths[d.sub].anchors[d.idx];
            const key = d.side === 'in' ? 'hIn' : 'hOut';
            const sm = a && a[key] ? dselScreenMatrix() : null;
            if (sm) {
                const fullM = sm.multiply(d.F);
                const pa = fullM.transformPoint(new DOMPoint(a.x, a.y));
                const ph = fullM.transformPoint(new DOMPoint(a[key].x, a[key].y));
                if (dselDist(pa.x, pa.y, ph.x, ph.y) <= DSEL_RETRACT_PX) {
                    a[key] = null;
                    dselWriteGeometry(d.globalShape, d.model);
                }
            }
        }

        dselTeardownDrag();
        dselDrag = null;
        if (moved) {
            window.setHistoryLabel?.('Edit Path', 'direct-selection');
            renderOutput(false);             // commit: flush export; tail redraws chrome + refreshes fields
            if (d.converted) dselRebindLayersPanel();   // once, even when several shapes converted
        } else if (d.collapseTo != null && dselAnchors.size > 1) {
            // Plain click (no drag) on a member of a multi-anchor selection collapses to it (AI-style).
            dselAnchors.clear();
            dselAnchors.add(d.collapseTo);
            redrawDselOverlay();
            window.refreshElementProperties?.();
        } else {
            redrawDselOverlay();             // it was a click (selection already handled on pointerdown)
        }
    };

    const dselCancelDrag = () => {
        const d = dselDrag;
        if (!d) return;
        dselTeardownDrag();
        dselDrag = null;
        if (!d.moved) { redrawDselOverlay(); return; }
        const targets = d.targets || [{ idx: d.ownerIdx, globalShape: d.globalShape, converted: d.converted, originalEl: d.originalEl, snapshot: d.snapshot }];
        targets.forEach(t => {
            if (t.converted && t.originalEl && t.globalShape) t.globalShape.replaceWith(t.originalEl);
            else if (t.snapshot && t.globalShape) window.restoreShapeGeometry?.(t.globalShape, t.snapshot);
            dselModels.delete(String(t.idx));    // geometry was rolled back -> reparse on next draw
        });
        renderOutput(false);
    };

    const dselBeginDrag = (e, mode, ownerIdx, sub, idx, side, collapseTo) => {
        const g = dselGeom(ownerIdx);
        if (!g) return;
        dselDrag = {
            mode, pointerId: e.pointerId, moved: false,
            downX: e.clientX, downY: e.clientY,
            ownerIdx: String(ownerIdx), sub, idx, side: side || null,
            F: g.F, Finv: g.Finv,
            collapseTo: collapseTo != null ? collapseTo : null,
            converted: false, originalEl: null, snapshot: null, globalShape: null, model: null,
            targets: null, lastAlt: false, shift: e.shiftKey
        };
        dselStartCapture(e);
    };

    /* ==== Marquee (rubber-band) anchor selection =========================================== */
    // A press on empty canvas starts a marquee instead of an immediate deselect. Dragging past the
    // threshold rubber-bands a rectangle (drawn by redrawDselOverlay); on release every anchor of
    // every visible vector shape whose projected point lands inside the rectangle is collected (its
    // owner object is revealed so the anchors show), and the set is applied by modifier: plain =
    // replace, Shift = add, Shift+Ctrl = subtract (Illustrator-style). A press with no drag is a
    // click (plain = deselect all). The marquee never snaps.

    const dselMarqueeBlockedTarget = (el) =>
        !!(el && el.closest && el.closest('.canvas-statusbar, .canvas-ruler, .ruler-corner'));

    const dselTeardownMarquee = () => {
        if (!dselMarquee) return;
        try { previewArea.releasePointerCapture(dselMarquee.pointerId); } catch (_) {}
        previewArea.removeEventListener('pointermove', dselOnMarqueeMove);
        previewArea.removeEventListener('pointerup', dselOnMarqueeEnd);
        previewArea.removeEventListener('pointercancel', dselOnMarqueeEnd);
        dselMarquee = null;
    };

    // Crisp cool-white hairline over a soft dark casing, projected from the marquee's artboard-space
    // start/current points (so a zoom/pan mid-drag re-projects it correctly).
    const dselDrawMarquee = (screenMatrix) => {
        const a = screenMatrix.transformPoint(new DOMPoint(dselMarquee.startRoot.x, dselMarquee.startRoot.y));
        const b = screenMatrix.transformPoint(new DOMPoint(dselMarquee.curRoot.x, dselMarquee.curRoot.y));
        const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
        const w = Math.abs(b.x - a.x), h = Math.abs(b.y - a.y);
        const mk = (stroke, width, crisp) => {
            const r = document.createElementNS(SVGNS, 'rect');
            r.setAttribute('x', x); r.setAttribute('y', y);
            r.setAttribute('width', w); r.setAttribute('height', h);
            r.setAttribute('fill', 'none');
            r.setAttribute('stroke', stroke);
            r.setAttribute('stroke-width', width);
            if (crisp) r.setAttribute('shape-rendering', 'crispEdges');
            r.setAttribute('pointer-events', 'none');
            directSelectionOverlay.appendChild(r);
        };
        mk(DSEL_MARQUEE_CASING, DSEL_MARQUEE_CASING_W, false);   // soft dark casing underneath
        mk(DSEL_MARQUEE_LINE, DSEL_MARQUEE_LINE_W, true);        // crisp cool-white line on top
    };

    // On release: collect every anchor (of every visible vector shape) inside the rectangle, then
    // apply by modifier. Owner objects are added so their anchors are visible/selected.
    const dselApplyMarquee = (m) => {
        const svg = dselPreviewSvg();
        const screenMatrix = dselScreenMatrix();
        if (!svg || !screenMatrix) { redrawDselOverlay(); return; }
        const a = screenMatrix.transformPoint(new DOMPoint(m.startRoot.x, m.startRoot.y));
        const b = screenMatrix.transformPoint(new DOMPoint(m.curRoot.x, m.curRoot.y));
        const minX = Math.min(a.x, b.x), maxX = Math.max(a.x, b.x);
        const minY = Math.min(a.y, b.y), maxY = Math.max(a.y, b.y);

        const hitKeys = [];
        getEditableLayerShapes(svg).forEach(shape => {
            if (!shape.matches(SVG_VECTOR_LAYER_SHAPE_SELECTOR)) return;   // anchors need geometry
            const idx = shape.getAttribute('data-pf-index');
            if (idx == null || lockedLayers.has(String(idx))) return;   // locked layers can't be anchor-selected
            const model = dselGetModel(shape, idx);
            if (!model) return;
            const full = dselFullMatrix(shape, svg, screenMatrix);
            model.subpaths.forEach((sub, si) => {
                sub.anchors.forEach((anc, ai) => {
                    const p = full.transformPoint(new DOMPoint(anc.x, anc.y));
                    if (p.x >= minX && p.x <= maxX && p.y >= minY && p.y <= maxY) hitKeys.push(dselKey(idx, si, ai));
                });
            });
        });

        if (m.subtract) {
            hitKeys.forEach(k => dselAnchors.delete(k));
        } else {
            if (!m.add) { dselObjects.clear(); dselAnchors.clear(); }
            hitKeys.forEach(k => { dselAnchors.add(k); dselObjects.add(dselParseKey(k).idx); });
        }
        if (dselPrimary == null || !dselObjects.has(dselPrimary)) dselPrimary = dselObjects.size ? [...dselObjects][0] : null;

        redrawDselOverlay();
        if (dselObjects.size) {
            window.setLayerSelectionSet?.([...dselObjects]);
            window.setEditSelectionSet?.([...dselObjects]);
        } else {
            window.clearEditSelection();
            window.clearLayerSelection();
        }
        window.refreshElementProperties?.();
    };

    const dselOnMarqueeMove = (e) => {
        if (!dselMarquee || e.pointerId !== dselMarquee.pointerId) return;
        if (!dselMarquee.moved) {
            if (Math.abs(e.clientX - dselMarquee.downX) < DSEL_DRAG_THRESHOLD && Math.abs(e.clientY - dselMarquee.downY) < DSEL_DRAG_THRESHOLD) return;
            dselMarquee.moved = true;
            dselHoverIndex = null;                   // no hover trace while marqueeing
        }
        const root = dselPointerRoot(e.clientX, e.clientY);
        if (root) dselMarquee.curRoot = root;
        queueDselOverlaySync();
    };

    const dselOnMarqueeEnd = (e) => {
        if (!dselMarquee || (e && e.pointerId !== dselMarquee.pointerId)) return;
        if (e && dselMarquee.moved) {
            const root = dselPointerRoot(e.clientX, e.clientY);
            if (root) dselMarquee.curRoot = root;
        }
        const m = dselMarquee;
        dselTeardownMarquee();
        if (!m.moved) {
            // Click on empty canvas: plain click deselects everything; a modified click keeps it.
            if (!m.add && !m.subtract) {
                const had = dselObjects.size > 0 || dselAnchors.size > 0;
                dselObjects.clear();
                dselAnchors.clear();
                dselPrimary = null;
                if (had) redrawDselOverlay();
                window.clearEditSelection();
                window.clearLayerSelection();
            } else {
                redrawDselOverlay();
            }
            return;
        }
        dselApplyMarquee(m);
    };

    const dselBeginMarquee = (e) => {
        const root = dselPointerRoot(e.clientX, e.clientY);
        if (!root) return;
        dselMarquee = {
            pointerId: e.pointerId, downX: e.clientX, downY: e.clientY,
            startRoot: root, curRoot: root, moved: false,
            add: e.shiftKey && !e.ctrlKey, subtract: e.shiftKey && e.ctrlKey
        };
        try { previewArea.setPointerCapture(e.pointerId); } catch (_) {}
        previewArea.addEventListener('pointermove', dselOnMarqueeMove);
        previewArea.addEventListener('pointerup', dselOnMarqueeEnd);
        previewArea.addEventListener('pointercancel', dselOnMarqueeEnd);
    };

    /* ==== Pointer routing =================================================================== */

    // Hover: trace whatever shape sits under the cursor; rebuild only when the shape changes.
    previewArea.addEventListener('pointermove', (e) => {
        if (window.isGuideDragActive?.()) return;
        if (!dselActive || dselDrag || dselMarquee || window.isHandToolTemporaryPan?.()) return;
        const shape = dselShapeFromTarget(e.target);
        const idx = shape ? shape.getAttribute('data-pf-index') : null;
        if (idx === dselHoverIndex) return;
        dselHoverIndex = idx;
        // No hover outline over empty canvas / chrome, or over an already-selected shape.
        if (!shape || dselObjects.has(idx)) { removeDselHoverOutline(); return; }
        redrawDselOverlay();
    });

    // Press routing: a handle dot starts a handle drag, an anchor square selects + arms an anchor
    // drag, the painted shape selects the object (all anchors unselected -- body drags never move
    // anything), empty canvas deselects.
    previewArea.addEventListener('pointerdown', (e) => {
        if (window.isGuideDragActive?.()) return;
        if (!dselActive || e.button !== 0 || dselDrag || dselMarquee) return;
        if (window.isHandToolTemporaryPan?.()) return;      // Space / middle-drag pan owns the press

        const handleEl = (e.target && e.target.closest) ? e.target.closest('.dsel-handle-hit') : null;
        if (handleEl) {
            const ownerIdx = handleEl.getAttribute('data-index');
            if (ownerIdx == null) return;
            e.preventDefault();
            dselBeginDrag(e, 'handle', ownerIdx, +handleEl.getAttribute('data-sub'), +handleEl.getAttribute('data-idx'), handleEl.getAttribute('data-side'));
            return;
        }

        const anchorEl = (e.target && e.target.closest) ? e.target.closest('.dsel-anchor') : null;
        if (anchorEl) {
            const ownerIdx = anchorEl.getAttribute('data-index');
            if (ownerIdx == null) return;
            const sub = +anchorEl.getAttribute('data-sub'), ai = +anchorEl.getAttribute('data-idx');
            const key = dselKey(ownerIdx, sub, ai);
            e.preventDefault();
            if (e.shiftKey) {
                // Shift+click toggles the anchor in/out of the multi-anchor selection.
                if (dselAnchors.has(key)) {
                    dselAnchors.delete(key);
                    redrawDselOverlay();
                    window.refreshElementProperties?.();
                    return;                                       // removed -> nothing to drag
                }
                dselAnchors.add(key);
                redrawDselOverlay();
                window.refreshElementProperties?.();
                dselBeginDrag(e, 'anchor', ownerIdx, sub, ai);
                return;
            }
            if (dselAnchors.has(key) && dselAnchors.size > 1) {
                // Press on a member of a multi set: a drag moves them all; a plain click (no
                // drag) collapses the selection to this anchor on release.
                dselBeginDrag(e, 'anchor', ownerIdx, sub, ai, null, key);
                return;
            }
            if (!dselAnchors.has(key)) {
                dselAnchors.clear();
                dselAnchors.add(key);
                redrawDselOverlay();
                window.refreshElementProperties?.();   // enter anchor mode
            }
            dselBeginDrag(e, 'anchor', ownerIdx, sub, ai);   // armed; moves only past the threshold
            return;
        }

        const shape = dselShapeFromTarget(e.target);

        if (!shape) {
            // Empty canvas: start an anchor marquee (plain = replace, Shift = add, Shift+Ctrl =
            // subtract). The selection change lands on release; a press with no drag falls back to a
            // click (plain click clears). Never start a marquee from the status bar / rulers.
            if (!dselMarqueeBlockedTarget(e.target)) { e.preventDefault(); dselBeginMarquee(e); }
            return;
        }

        const idx = shape.getAttribute('data-pf-index');

        if (e.shiftKey) {
            // Shift+click a shape body: add/remove that object's anchors from the working set
            // WITHOUT dropping the other objects (cross-object anchor selection).
            e.preventDefault();
            if (dselObjects.has(idx)) {
                dselObjects.delete(idx);
                dselPruneAnchors(idx, null);
                if (dselPrimary === idx) dselPrimary = dselObjects.size ? [...dselObjects][0] : null;
            } else {
                dselObjects.add(idx);
                dselPrimary = idx;
                if (dselHoverIndex === idx) dselHoverIndex = null;
            }
            redrawDselOverlay();
            window.setLayerSelectionSet?.([...dselObjects]);
            window.setEditSelectionSet?.([...dselObjects]);
            window.refreshElementProperties?.();
            return;
        }

        if (!dselObjects.has(idx) || dselObjects.size > 1) {
            dselObjects.clear();
            dselObjects.add(idx);
            dselPrimary = idx;
            dselAnchors.clear();                        // object click = all anchors unselected
            if (dselHoverIndex === idx) dselHoverIndex = null;
            redrawDselOverlay();
            window.setLayerSelectionSet?.([idx]);
            window.setEditSelectionSet?.([idx]);
            window.refreshElementProperties?.();
            const card = layersList.querySelector(`.layer-item[data-pf-index="${idx}"]`);
            if (card) {
                card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                if (window.updateAllScrollbars) requestAnimationFrame(window.updateAllScrollbars);
            }
        } else if (dselAnchors.size) {
            dselAnchors.clear();                        // re-clicking the body deselects the anchors
            redrawDselOverlay();
            window.refreshElementProperties?.();
        }
        e.preventDefault();
    });

    /* ==== Keyboard editing: delete anchors + arrow nudges =================================== */

    // Group the selected anchor keys by owning shape (parsed, ready for per-shape model work).
    const dselAnchorsByShape = () => {
        const byShape = new Map();
        dselAnchors.forEach(key => {
            const k = dselParseKey(key);
            if (!byShape.has(k.idx)) byShape.set(k.idx, []);
            byShape.get(k.idx).push(k);
        });
        return byShape;
    };

    // Delete every selected anchor (Pen Minus-mode semantics): the path reshapes with the
    // neighbours' existing handles, a subpath left with <2 anchors is dropped, and a shape left
    // with no subpaths is deleted outright. Primitives convert to <path> first (the usual
    // first-edit conversion). One committed render for the whole set.
    const dselDeleteSelectedAnchors = () => {
        if (!globalOptimizedSvg || !dselAnchors.size) return false;
        let any = false, anyConverted = false, anyRemovedShape = false;
        dselAnchorsByShape().forEach((keys, idx) => {
            let globalShape = globalOptimizedSvg.querySelector(`[data-pf-index="${idx}"]`);
            if (!globalShape) return;
            const model = dselGetModel(globalShape, idx);
            if (!model) return;
            if (model.needsConversion) {
                globalShape = dselConvertToPath(globalShape, model);
                anyConverted = true;
            }
            // Deepest-first so earlier anchor indices stay valid while splicing.
            keys.sort((a, b) => (b.sub - a.sub) || (b.ai - a.ai));
            keys.forEach(k => {
                const sub = model.subpaths[k.sub];
                if (sub && sub.anchors[k.ai]) { sub.anchors.splice(k.ai, 1); any = true; }
            });
            for (let i = model.subpaths.length - 1; i >= 0; i--) {
                if (model.subpaths[i].anchors.length < 2) model.subpaths.splice(i, 1);
            }
            if (!model.subpaths.length) {
                globalShape.remove();
                dselModels.delete(String(idx));
                dselObjects.delete(String(idx));
                anyRemovedShape = true;
            } else {
                dselWriteGeometry(globalShape, model);
            }
        });
        if (!any && !anyRemovedShape) return false;
        dselAnchors.clear();                    // survivors reindexed -> the old keys are stale
        if (dselPrimary != null && !dselObjects.has(dselPrimary)) dselPrimary = dselObjects.size ? [...dselObjects][0] : null;
        if (anyRemovedShape) buildLayersPanel();
        window.setHistoryLabel?.('Delete Anchor', 'minus');
        renderOutput(false);
        if (anyConverted && !anyRemovedShape) dselRebindLayersPanel();
        window.setLayerSelectionSet?.([...dselObjects]);
        window.setEditSelectionSet?.([...dselObjects]);
        redrawDselOverlay();
        window.refreshElementProperties?.();
        return true;
    };

    // Arrow-key nudges (1px / Shift 10px / Ctrl+Shift 0.1px, artboard units): the selected anchors move
    // by a shared root-space delta (each shape converts it through its own Finv linear part, same
    // as an anchor drag). Renders are deferred during a key-repeat burst; the commit (one history
    // entry labeled "Nudge") lands on arrow keyup or after a short idle.
    const DSEL_ARROW = {
        ArrowLeft: { dx: -1, dy: 0 }, ArrowRight: { dx: 1, dy: 0 },
        ArrowUp: { dx: 0, dy: -1 }, ArrowDown: { dx: 0, dy: 1 }
    };
    const DSEL_NUDGE_COMMIT_MS = 500;
    let dselNudgeTimer = 0, dselNudgePending = false, dselNudgeConverted = false;
    const dselCommitNudge = () => {
        if (dselNudgeTimer) { clearTimeout(dselNudgeTimer); dselNudgeTimer = 0; }
        if (!dselNudgePending) return;
        dselNudgePending = false;
        window.setHistoryLabel?.('Nudge', 'direct-selection');
        renderOutput(false);
        if (dselNudgeConverted) { dselNudgeConverted = false; dselRebindLayersPanel(); }
    };

    const dselNudgeAnchors = (dx, dy) => {
        if (!globalOptimizedSvg || !dselAnchors.size) return false;
        let applied = false;
        dselAnchorsByShape().forEach((keys, idx) => {
            let globalShape = globalOptimizedSvg.querySelector(`[data-pf-index="${idx}"]`);
            const g = dselGeom(idx);
            const model = globalShape && g ? dselGetModel(globalShape, idx) : null;
            if (!model) return;
            if (model.needsConversion) {
                globalShape = dselConvertToPath(globalShape, model);
                dselNudgeConverted = true;
            }
            const ldx = g.Finv.a * dx + g.Finv.c * dy;
            const ldy = g.Finv.b * dx + g.Finv.d * dy;
            keys.forEach(k => {
                const a = model.subpaths[k.sub] && model.subpaths[k.sub].anchors[k.ai];
                if (!a) return;
                a.x += ldx; a.y += ldy;
                if (a.hIn) { a.hIn.x += ldx; a.hIn.y += ldy; }
                if (a.hOut) { a.hOut.x += ldx; a.hOut.y += ldy; }
                applied = true;
            });
            dselWriteGeometry(globalShape, model);
        });
        if (applied) {
            renderOutput(true);
            window.refreshElementProperties?.();
        }
        return applied;
    };

    // A selects the Direct Selection tool (Illustrator) -- inert in text fields / eyedropper / no artboard.
    // Escape cancels an in-progress drag (revert geometry); with a multi selection it clears the
    // selection (tool stays on). Ctrl+A selects every anchor of every visible vector shape --
    // skipped while a text field has focus so native select-all survives. Delete/Backspace delete
    // the selected anchors (or the targeted objects when no anchors are selected); arrows nudge.
    document.addEventListener('keydown', (e) => {
        if ((e.key === 'a' || e.key === 'A') && !e.ctrlKey && !e.altKey && !e.metaKey && !e.repeat
            && !dselActive && globalOptimizedSvg && !isTextInputFocused() && !isEyedropperMode) {
            e.preventDefault();
            window.toggleDirectSelectionTool();
            return;
        }
        if (!dselActive) return;
        if (e.key === 'Escape' && isTextInputFocused()) return;
        if (dselDrag && e.key === 'Shift') {
            // Shift pressed mid-drag (no pointer movement needed): constrain immediately.
            dselDrag.shift = true;
            if (dselDrag.moved && dselDragPending && !dselDragRaf) dselDragRaf = requestAnimationFrame(dselApplyDragFrame);
            return;
        }
        if (e.key === 'Escape') {
            if (dselMarquee) { e.preventDefault(); dselTeardownMarquee(); redrawDselOverlay(); return; }
            if (dselDrag) { e.preventDefault(); dselCancelDrag(); return; }
            if ((dselAnchors.size || dselObjects.size) && !isEyedropperMode) {
                e.preventDefault();
                dselObjects.clear();
                dselAnchors.clear();
                dselPrimary = null;
                redrawDselOverlay();
                window.setLayerSelectionSet?.([]);
                window.setEditSelectionSet?.([]);
                window.refreshElementProperties?.();
                return;
            }
            return;
        }
        if ((e.key === 'a' || e.key === 'A') && e.ctrlKey && !e.altKey && !e.repeat && !isTextInputFocused()) {
            const svg = dselPreviewSvg();
            if (!svg) return;
            e.preventDefault();
            dselObjects.clear();
            dselAnchors.clear();
            getEditableLayerShapes(svg).forEach(shape => {
                if (!shape.matches(SVG_VECTOR_LAYER_SHAPE_SELECTOR)) return;   // anchors need geometry
                const idx = shape.getAttribute('data-pf-index');
                if (idx == null || lockedLayers.has(String(idx))) return;   // locked layers can't be anchor-selected
                const model = dselGetModel(shape, idx);
                if (!model) return;
                dselObjects.add(idx);
                model.subpaths.forEach((sub, si) => sub.anchors.forEach((a, ai) => dselAnchors.add(dselKey(idx, si, ai))));
            });
            dselPrimary = dselObjects.size ? [...dselObjects][0] : null;
            redrawDselOverlay();
            window.setLayerSelectionSet?.([...dselObjects]);
            window.setEditSelectionSet?.([...dselObjects]);
            window.refreshElementProperties?.();
            return;
        }
        if (dselDrag || dselMarquee || isTextInputFocused()) return;
        if (e.key === 'Delete' || e.key === 'Backspace') {
            if (dselAnchors.size) {
                e.preventDefault();
                dselCommitNudge();               // flush a pending nudge before the delete commits
                dselDeleteSelectedAnchors();
                return;
            }
            if (dselObjects.size) {
                // No anchors selected: delete the targeted object(s) (Illustrator-style).
                e.preventDefault();
                dselCommitNudge();
                window.deleteSelectedLayer?.();  // panel selection mirrors dselObjects
                dselObjects.clear();
                dselAnchors.clear();
                dselPrimary = null;
                redrawDselOverlay();
            }
            return;
        }
        const arrow = DSEL_ARROW[e.key];
        if (arrow && !e.altKey && !e.metaKey) {
            if (e.ctrlKey && !e.shiftKey) return;                 // plain Ctrl+arrow is unclaimed
            const step = e.ctrlKey ? 0.1 : e.shiftKey ? 10 : 1;   // Ctrl+Shift = fine 0.1px
            let applied = false;
            if (dselAnchors.size) applied = dselNudgeAnchors(arrow.dx * step, arrow.dy * step);
            else if (dselObjects.size) {
                // No anchors selected: nudge the targeted object(s) through the shared engine
                // (the edit selection already mirrors dselObjects).
                applied = !!window.applySelectionRootMatrix?.(new DOMMatrix().translate(arrow.dx * step, arrow.dy * step), true);
                if (applied) window.refreshElementProperties?.();
            }
            if (applied) {
                e.preventDefault();
                dselNudgePending = true;
                if (dselNudgeTimer) clearTimeout(dselNudgeTimer);
                dselNudgeTimer = setTimeout(dselCommitNudge, DSEL_NUDGE_COMMIT_MS);
            }
        }
    });

    // Keyup: commit a nudge burst; release the mid-drag Shift constraint without pointer movement.
    document.addEventListener('keyup', (e) => {
        if (DSEL_ARROW[e.key]) { dselCommitNudge(); return; }
        if (dselDrag && e.key === 'Shift') {
            dselDrag.shift = false;
            if (dselDrag.moved && dselDragPending && !dselDragRaf) dselDragRaf = requestAnimationFrame(dselApplyDragFrame);
        }
    });

    window.addEventListener('blur', dselCommitNudge);

    /* ==== Properties-panel bridge (anchor mode) ============================================= */

    const dselViewBoxBounds = (svg) => {
        const vb = svg.getAttribute('viewBox') || svg.getAttribute('viewbox');
        if (vb) {
            const p = vb.trim().split(/[\s,]+/);
            if (p.length === 4) return { x: parseFloat(p[0]) || 0, y: parseFloat(p[1]) || 0, w: parseFloat(p[2]) || 0, h: parseFloat(p[3]) || 0 };
        }
        return { x: 0, y: 0, w: parseFloat(svg.dataset.nativeW) || 0, h: parseFloat(svg.dataset.nativeH) || 0 };
    };

    window.isDirectSelectionAnchorMode = () => dselActive && dselAnchors.size >= 1;

    // Selected anchor position in artboard units (root coords minus the viewBox origin).
    // Returns null with 2+ anchors selected -> the Properties panel greys out entirely.
    window.getAnchorDisplayValues = () => {
        const single = dselSingleAnchor();
        if (!single) return null;
        const g = dselGeom(single.idx);
        if (!g) return null;
        const model = dselGetModel(g.previewShape, single.idx);
        const a = model && model.subpaths[single.sub] && model.subpaths[single.sub].anchors[single.ai];
        if (!a) return null;
        const pt = g.F.transformPoint(new DOMPoint(a.x, a.y));
        const vb = dselViewBoxBounds(g.svg);
        return { x: pt.x - vb.x, y: pt.y - vb.y, width: 0, height: 0 };
    };

    // Typed / nudged / label-scrubbed X-Y edit of the selected anchor (artboard units).
    window.applyAnchorPropertyEdit = (field, value, isScrubbing = false) => {
        if ((field !== 'x' && field !== 'y') || !Number.isFinite(value)) return false;
        const single = dselSingleAnchor();
        if (!single) return false;                      // multi-anchor: fields are disabled anyway
        const g = dselGeom(single.idx);
        if (!g) return false;
        let globalShape = globalOptimizedSvg ? globalOptimizedSvg.querySelector(`[data-pf-index="${single.idx}"]`) : null;
        if (!globalShape) return false;
        const model = dselGetModel(globalShape, single.idx);
        const a = model && model.subpaths[single.sub] && model.subpaths[single.sub].anchors[single.ai];
        if (!a) return false;

        if (model.needsConversion) {
            globalShape = dselConvertToPath(globalShape, model);
            dselPendingRebuild = true;                   // panel rebind happens on the final commit
        }

        const vb = dselViewBoxBounds(g.svg);
        const cur = g.F.transformPoint(new DOMPoint(a.x, a.y));
        const target = g.Finv.transformPoint(new DOMPoint(
            field === 'x' ? value + vb.x : cur.x,
            field === 'y' ? value + vb.y : cur.y
        ));
        const dx = target.x - a.x, dy = target.y - a.y;
        a.x += dx; a.y += dy;
        if (a.hIn) { a.hIn.x += dx; a.hIn.y += dy; }
        if (a.hOut) { a.hOut.x += dx; a.hOut.y += dy; }

        dselWriteGeometry(globalShape, model);
        renderOutput(isScrubbing);
        if (!isScrubbing && dselPendingRebuild) {
            dselPendingRebuild = false;
            dselRebindLayersPanel();
        }
        return true;
    };

    // Align the selected anchor to the artboard (same semantics as the element align group).
    window.alignSelectedAnchorToArtboard = (mode) => {
        const single = dselSingleAnchor();
        if (!single) return false;                      // multi-anchor: align is disabled anyway
        const g = dselGeom(single.idx);
        if (!g) return false;
        const vb = dselViewBoxBounds(g.svg);
        if (vb.w <= 0 || vb.h <= 0) return false;
        if (mode === 'left') return window.applyAnchorPropertyEdit('x', 0);
        if (mode === 'hcenter') return window.applyAnchorPropertyEdit('x', vb.w / 2);
        if (mode === 'right') return window.applyAnchorPropertyEdit('x', vb.w);
        if (mode === 'top') return window.applyAnchorPropertyEdit('y', 0);
        if (mode === 'vcenter') return window.applyAnchorPropertyEdit('y', vb.h / 2);
        if (mode === 'bottom') return window.applyAnchorPropertyEdit('y', vb.h);
        return false;
    };

    /* ==== Shared path-model bridge ========================================================== */

    // Reused by the Pen and Scissors tools so all three share ONE anchor-model
    // parse/serialize/convert pipeline (and the same sig-gated model cache); edits made by any
    // tool stay coherent for the others. Pen calls invalidate() after an Esc-cancel
    // geometry restore so the rolled-back shape reparses on the next draw.
    window.dselModelBridge = {
        getModel: (shape, idx) => dselGetModel(shape, idx),
        writeGeometry: (globalShape, model) => dselWriteGeometry(globalShape, model),
        convertToPath: (globalShape, model) => dselConvertToPath(globalShape, model),
        invalidate: (idx) => { dselModels.delete(String(idx)); dselPruneAnchors(String(idx), null); }
    };

})();
