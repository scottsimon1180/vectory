/* fileName: pen-tool.js */

// Canvas Pen Tool (Illustrator-style). Draw mode places real anchors into the document as you
// click: the first click creates a live <path> (fill hidden, artboard-relative black stroke,
// new TOP layer), every following click appends a corner anchor, and click-DRAG pulls out
// smooth Bezier handles (Alt splits the pair so the leading handle moves alone). A green
// rubber band previews the upcoming segment from the last anchor to the cursor. Clicking the
// first anchor closes the path (close-drag reshapes the closing anchor); Enter / Escape /
// double-click end an open path; clicking an open path's endpoint continues it. The Draw /
// Add / Minus mode bar (#penModeBar, visible only while the tool is active) switches the pen
// between drawing, add-anchor (click a segment), and delete-anchor (click an anchor) modes.
//
// Geometry runs through the SHARED anchor model in js/direct-selection-tool.js
// (window.dselModelBridge: parse / serialize / convert-primitive / sig-gated cache), so pen
// paths are immediately editable by the Direct Selection tool and vice-versa. All chrome is
// drawn into the screen-space #penToolOverlay (pointer-events:none) -- never into
// globalOptimizedSvg -- mirroring the other canvas tools' projection math. Holding Ctrl
// temporarily switches to the Direct Selection tool (the in-progress path is preserved and
// re-armed on release); P activates the Pen tool. Cursors (nib + * o + - states) live in
// js/custom-cursors.js.

(() => {

    let penActive = false;
    let penMode = 'draw';           // 'draw' | 'add' | 'minus'
    // In-progress path, null when idle: { idx, sub, createdNew }. The anchor model itself
    // lives in the shared bridge cache -- always re-fetched, never stored here.
    let penPath = null;
    // Active pointer gesture, null when idle:
    // { kind:'first'|'place'|'close'|'continue', pointerId, downX, downY, moved, ai, F, Finv,
    //   globalShape, model, snapshot, altLatched }
    let penDrag = null;
    let penDragRaf = 0, penDragPending = null;
    let penRaf = 0;
    let penCursorPt = null;         // last pointer position (client px) for the rubber band
    let penTarget = null;           // add/minus modes: sticky shape whose anchors are shown
    let penHoverEndpoint = null;    // draw mode, no path: { idx, sub, end } under the cursor
    let penTempSel = null;          // Ctrl-hold temp Direct Selection: { resume: penPath|null }
    let penTempSwitching = false;   // true only while the temp switch itself runs deactivate
    let penPendingRebuild = false;  // a primitive/line converted to <path> -> rebuild panel once

    const PEN_GREEN = '#00E676';
    const PEN_W = '1.5';            // screen px -- matches the other tools' chrome weight
    const PEN_ANCHOR_PX = 6;        // anchor square size (same as the Direct Selection tool)
    const PEN_HANDLE_R = 2.5;       // Bezier handle dot radius
    const PEN_HIT_PX = 6;           // screen tolerance: close / continue / add / delete hits
    const PEN_DRAG_THRESHOLD = 3;   // px of travel before a press becomes a handle drag
    const PEN_EPS_HANDLE = 5e-4;    // control point closer than this to its anchor = no handle
    const SVGNS = 'http://www.w3.org/2000/svg';

    const penOverlay = $('penToolOverlay');
    const penPreviewSvg = () => previewArea.querySelector(PREVIEW_SVG_SELECTOR);
    const isStatusBarTarget = (el) => el && el.closest && el.closest('.canvas-statusbar');
    const bridge = () => window.dselModelBridge;

    const penNum = (n) => {
        const v = +n.toFixed(4);
        return Object.is(v, -0) ? 0 : v;
    };
    const penDist = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);
    const mkHandle = (hx, hy, ax, ay) =>
        (penDist(hx, hy, ax, ay) > PEN_EPS_HANDLE) ? { x: hx, y: hy } : null;

    const penShapeFromTarget = (el) =>
        (el && el.tagName && el.matches && el.matches(SVG_VECTOR_LAYER_SHAPE_SELECTOR) && el.hasAttribute('data-pf-index')) ? el : null;

    const penFindPreviewShape = (idx) => {
        const svg = penPreviewSvg();
        return (svg && idx != null) ? svg.querySelector(`[data-pf-index="${idx}"]`) : null;
    };
    const penSharedVectorIndex = () => [...editSelectedIndices].find(idx => {
        const shape = penFindPreviewShape(idx);
        return !!(shape && shape.matches(SVG_VECTOR_LAYER_SHAPE_SELECTOR) && !lockedLayers.has(String(idx)));
    }) || null;
    const penGlobalShape = (idx) =>
        (globalOptimizedSvg && idx != null) ? globalOptimizedSvg.querySelector(`[data-pf-index="${idx}"]`) : null;

    /* ==== Projection (mirrors the other canvas tools) ======================================= */

    const penAreaMetrics = () => {
        const areaRect = previewArea.getBoundingClientRect();
        const areaStyle = getComputedStyle(previewArea);
        const borderL = parseFloat(areaStyle.borderLeftWidth) || 0;
        const borderT = parseFloat(areaStyle.borderTopWidth) || 0;
        return {
            areaRect, borderL, borderT,
            areaW: areaRect.width - borderL - (parseFloat(areaStyle.borderRightWidth) || 0),
            areaH: areaRect.height - borderT - (parseFloat(areaStyle.borderBottomWidth) || 0)
        };
    };

    const penClientToOverlay = (clientX, clientY) => {
        const m = penAreaMetrics();
        return { x: clientX - m.areaRect.left - m.borderL, y: clientY - m.areaRect.top - m.borderT };
    };

    // Projection matrix: viewBox-root coords -> #penToolOverlay screen px (and size the overlay).
    const penScreenMatrix = () => {
        const svg = penPreviewSvg();
        if (!svg || !penOverlay) return null;
        const m = penAreaMetrics();
        const svgRect = svg.getBoundingClientRect();
        const vb = svg.getAttribute('viewBox') || svg.getAttribute('viewbox');
        let vbX = 0, vbY = 0;
        let vbW = parseFloat(svg.dataset.nativeW) || 128;
        let vbH = parseFloat(svg.dataset.nativeH) || 128;
        if (vb) {
            const p = vb.trim().split(/[\s,]+/);
            if (p.length === 4) { vbX = parseFloat(p[0]) || 0; vbY = parseFloat(p[1]) || 0; vbW = parseFloat(p[2]) || vbW; vbH = parseFloat(p[3]) || vbH; }
        }
        if (m.areaW <= 0 || m.areaH <= 0 || vbW <= 0 || vbH <= 0 || svgRect.width <= 0 || svgRect.height <= 0) return null;

        penOverlay.setAttribute('viewBox', `0 0 ${m.areaW} ${m.areaH}`);
        penOverlay.setAttribute('width', m.areaW);
        penOverlay.setAttribute('height', m.areaH);

        return new DOMMatrix()
            .translate(svgRect.left - m.areaRect.left - m.borderL, svgRect.top - m.areaRect.top - m.borderT)
            .scale(svgRect.width / vbW, svgRect.height / vbH)
            .translate(-vbX, -vbY);
    };

    // Pointer position -> artboard (viewBox) user units (same math as the other tools).
    const penPointerRoot = (clientX, clientY) => {
        const svg = penPreviewSvg();
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

    // Root (artboard) point -> client px (inverse of penPointerRoot); used to pin the rubber
    // band to a snapped hover point so the preview matches where the click will land.
    const penRootToClient = (x, y) => {
        const svg = penPreviewSvg();
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
        return { x: r.left + (x - vbX) * (r.width / vbW), y: r.top + (y - vbY) * (r.height / vbH) };
    };

    // Live geometry for one shape: preview shape + local<->root matrices (stable during a drag).
    const penGeom = (idx) => {
        const svg = penPreviewSvg();
        if (!svg || idx == null) return null;
        const previewShape = svg.querySelector(`[data-pf-index="${idx}"]`);
        if (!previewShape) return null;
        const P = cumulativeAncestorMatrix(previewShape, svg);
        const own = svgTransformToMatrix(previewShape.getAttribute('transform') || '');
        const F = P.multiply(own);
        const Finv = F.inverse();
        if (![Finv.a, Finv.b, Finv.c, Finv.d, Finv.e, Finv.f].every(Number.isFinite)) return null;
        return { svg, previewShape, F, Finv };
    };

    const penPointerLocal = (Finv, clientX, clientY) => {
        const root = penPointerRoot(clientX, clientY);
        return root ? Finv.transformPoint(new DOMPoint(root.x, root.y)) : null;
    };

    // Model of a shape via the shared bridge (preview shape for chrome, global shape for edits --
    // both carry identical geometry, and the cache is keyed by pf-index + geometry signature).
    const penModel = (shape, idx) => (shape && bridge()) ? bridge().getModel(shape, idx) : null;

    /* ==== Overlay chrome ==================================================================== */

    const hidePenOverlay = () => {
        if (penRaf) { cancelAnimationFrame(penRaf); penRaf = 0; }
        if (!penOverlay) return;
        if (penOverlay.hasAttribute('hidden') && !penOverlay.children.length) return;
        penOverlay.replaceChildren();
        penOverlay.toggleAttribute('hidden', true);
    };

    const penDrawSquare = (p, solid) => {
        const half = PEN_ANCHOR_PX / 2;
        const r = document.createElementNS(SVGNS, 'rect');
        r.setAttribute('x', p.x - half);
        r.setAttribute('y', p.y - half);
        r.setAttribute('width', PEN_ANCHOR_PX);
        r.setAttribute('height', PEN_ANCHOR_PX);
        r.setAttribute('fill', solid ? PEN_GREEN : '#ffffff');
        r.setAttribute('stroke', PEN_GREEN);
        r.setAttribute('stroke-width', '1');
        r.setAttribute('pointer-events', 'none');
        penOverlay.appendChild(r);
    };

    const penDrawHandle = (pa, ph) => {
        const line = document.createElementNS(SVGNS, 'line');
        line.setAttribute('x1', pa.x); line.setAttribute('y1', pa.y);
        line.setAttribute('x2', ph.x); line.setAttribute('y2', ph.y);
        line.setAttribute('stroke', PEN_GREEN);
        line.setAttribute('stroke-width', '1');
        line.setAttribute('pointer-events', 'none');
        penOverlay.appendChild(line);
        const dot = document.createElementNS(SVGNS, 'circle');
        dot.setAttribute('cx', ph.x); dot.setAttribute('cy', ph.y);
        dot.setAttribute('r', PEN_HANDLE_R);
        dot.setAttribute('fill', PEN_GREEN);
        dot.setAttribute('pointer-events', 'none');
        penOverlay.appendChild(dot);
    };

    // Green path outline for the add/minus target (cloned shape, transform baked, constant px).
    const penDrawOutline = (shape, svg, screenMatrix) => {
        const outline = shape.cloneNode(false);
        ['data-pf-index', 'data-pf-default-fill', 'class', 'style', 'clip-path', 'mask', 'filter',
         'opacity', 'fill-opacity', 'stroke-opacity', 'stroke-dasharray'].forEach(a => outline.removeAttribute(a));
        const anc = cumulativeAncestorMatrix(shape, svg);
        const own = shape.getAttribute('transform');
        const full = screenMatrix.multiply(own ? anc.multiply(svgTransformToMatrix(own)) : anc);
        if (full.isIdentity) outline.removeAttribute('transform');
        else outline.setAttribute('transform', matrixToString(full));
        outline.setAttribute('fill', 'none');
        outline.setAttribute('stroke', PEN_GREEN);
        outline.setAttribute('stroke-width', PEN_W);
        outline.setAttribute('vector-effect', 'non-scaling-stroke');
        outline.setAttribute('stroke-linecap', 'round');
        outline.setAttribute('stroke-linejoin', 'round');
        outline.setAttribute('pointer-events', 'none');
        penOverlay.appendChild(outline);
    };

    const redrawPenOverlay = () => {
        if (!penActive || !penOverlay) { hidePenOverlay(); return; }
        const M = penScreenMatrix();
        penOverlay.replaceChildren();
        if (!M) { penOverlay.toggleAttribute('hidden', true); return; }
        const svg = penPreviewSvg();

        if (penMode === 'draw') {
            if (penPath) {
                const g = penGeom(penPath.idx);
                const model = g ? penModel(g.previewShape, penPath.idx) : null;
                const sub = model && model.subpaths[penPath.sub];
                if (!sub || !sub.anchors.length) { penPath = null; penOverlay.toggleAttribute('hidden', true); return; }
                const full = M.multiply(g.F);
                const proj = (x, y) => full.transformPoint(new DOMPoint(x, y));
                const A = sub.anchors;
                const last = A[A.length - 1];

                // Rubber band: the segment a click would create, last anchor -> cursor.
                if (!penDrag && penCursorPt && !sub.closed) {
                    const p0 = proj(last.x, last.y);
                    const pc = penClientToOverlay(penCursorPt.x, penCursorPt.y);
                    const band = document.createElementNS(SVGNS, 'path');
                    if (last.hOut) {
                        const h = proj(last.hOut.x, last.hOut.y);
                        band.setAttribute('d', `M ${p0.x} ${p0.y} C ${h.x} ${h.y} ${pc.x} ${pc.y} ${pc.x} ${pc.y}`);
                    } else {
                        band.setAttribute('d', `M ${p0.x} ${p0.y} L ${pc.x} ${pc.y}`);
                    }
                    band.setAttribute('fill', 'none');
                    band.setAttribute('stroke', PEN_GREEN);
                    band.setAttribute('stroke-width', PEN_W);
                    band.setAttribute('pointer-events', 'none');
                    penOverlay.appendChild(band);
                }

                // Handles: the dragged anchor's pair during a gesture, else the last anchor's hOut.
                const handleAnchor = (penDrag && penDrag.moved) ? A[penDrag.ai] : null;
                if (handleAnchor) {
                    const pa = proj(handleAnchor.x, handleAnchor.y);
                    if (handleAnchor.hIn) penDrawHandle(pa, proj(handleAnchor.hIn.x, handleAnchor.hIn.y));
                    if (handleAnchor.hOut) penDrawHandle(pa, proj(handleAnchor.hOut.x, handleAnchor.hOut.y));
                } else if (last.hOut) {
                    penDrawHandle(proj(last.x, last.y), proj(last.hOut.x, last.hOut.y));
                }

                A.forEach((a, ai) => penDrawSquare(proj(a.x, a.y), ai === A.length - 1));
            } else if (penHoverEndpoint) {
                // Continue affordance: highlight the hovered open endpoint.
                const g = penGeom(penHoverEndpoint.idx);
                const model = g ? penModel(g.previewShape, penHoverEndpoint.idx) : null;
                const sub = model && model.subpaths[penHoverEndpoint.sub];
                if (sub && sub.anchors.length) {
                    const a = sub.anchors[penHoverEndpoint.end === 'start' ? 0 : sub.anchors.length - 1];
                    const p = M.multiply(g.F).transformPoint(new DOMPoint(a.x, a.y));
                    penDrawSquare(p, true);
                }
            } else if (penTarget != null) {
                // An idle Pen keeps the selected vector's outline and anchors visible, matching
                // Illustrator's persistent object selection across tool switches.
                const g = penGeom(penTarget);
                const model = g ? penModel(g.previewShape, penTarget) : null;
                if (model) {
                    penDrawOutline(g.previewShape, svg, M);
                    const full = M.multiply(g.F);
                    model.subpaths.forEach(sub => sub.anchors.forEach(a => {
                        penDrawSquare(full.transformPoint(new DOMPoint(a.x, a.y)), false);
                    }));
                } else {
                    penTarget = null;
                }
            }
        } else if (penTarget != null) {
            // Add / Minus: outline + every anchor of the sticky target shape.
            const g = penGeom(penTarget);
            const model = g ? penModel(g.previewShape, penTarget) : null;
            if (model) {
                penDrawOutline(g.previewShape, svg, M);
                const full = M.multiply(g.F);
                model.subpaths.forEach(sub => sub.anchors.forEach(a => {
                    const p = full.transformPoint(new DOMPoint(a.x, a.y));
                    penDrawSquare(p, false);
                }));
            } else {
                penTarget = null;
            }
        }

        penOverlay.toggleAttribute('hidden', !penOverlay.children.length);
    };

    const queuePenRedraw = () => {
        if (penRaf) return;
        penRaf = requestAnimationFrame(() => { penRaf = 0; redrawPenOverlay(); });
    };

    /* ==== Cursor state ====================================================================== */

    const PEN_CURSOR_CLASSES = ['pen-cur-new', 'pen-cur-close', 'pen-cur-add', 'pen-cur-minus'];
    const penSetCursor = (state) => {
        PEN_CURSOR_CLASSES.forEach(c => previewArea.classList.toggle(c, c === `pen-cur-${state}`));
    };
    const penApplyModeCursor = () => {
        if (penMode === 'add') penSetCursor('add');
        else if (penMode === 'minus') penSetCursor('minus');
        else penSetCursor(penPath ? null : 'new');
    };

    /* ==== Hit tests ========================================================================= */

    // Screen distance from the pointer to a shape-local point, or Infinity.
    const penScreenDistTo = (g, M, lx, ly, clientX, clientY) => {
        const p = M.multiply(g.F).transformPoint(new DOMPoint(lx, ly));
        const c = penClientToOverlay(clientX, clientY);
        return penDist(p.x, p.y, c.x, c.y);
    };

    // Draw mode + in-progress path: is the pointer on the first anchor (close target)?
    const penHitFirstAnchor = (clientX, clientY) => {
        if (!penPath) return false;
        const g = penGeom(penPath.idx);
        const model = g ? penModel(g.previewShape, penPath.idx) : null;
        const sub = model && model.subpaths[penPath.sub];
        if (!sub || sub.closed || sub.anchors.length < 2) return false;
        const M = penScreenMatrix();
        if (!M) return false;
        const a = sub.anchors[0];
        return penScreenDistTo(g, M, a.x, a.y, clientX, clientY) <= PEN_HIT_PX;
    };

    // Draw mode, idle: nearest open-subpath endpoint of any visible vector shape.
    const penFindOpenEndpoint = (clientX, clientY) => {
        const svg = penPreviewSvg();
        const M = penScreenMatrix();
        if (!svg || !M) return null;
        let best = null, bestD = PEN_HIT_PX;
        getEditableLayerShapes(svg).forEach(shape => {
            if (!shape.matches(SVG_VECTOR_LAYER_SHAPE_SELECTOR)) return;
            const idx = shape.getAttribute('data-pf-index');
            if (idx == null) return;
            const g = penGeom(idx);
            const model = g ? penModel(shape, idx) : null;
            if (!model) return;
            model.subpaths.forEach((sub, si) => {
                if (sub.closed || !sub.anchors.length) return;
                const first = sub.anchors[0], last = sub.anchors[sub.anchors.length - 1];
                const dEnd = penScreenDistTo(g, M, last.x, last.y, clientX, clientY);
                if (dEnd <= bestD) { bestD = dEnd; best = { idx, sub: si, end: 'end' }; }
                if (sub.anchors.length > 1) {
                    const dStart = penScreenDistTo(g, M, first.x, first.y, clientX, clientY);
                    if (dStart < bestD) { bestD = dStart; best = { idx, sub: si, end: 'start' }; }
                }
            });
        });
        return best;
    };

    // Cubic point at t for the segment a->b (either handle may be missing).
    const penSegPoint = (a, b, t) => {
        if (!a.hOut && !b.hIn) return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
        const p1 = a.hOut || a, p2 = b.hIn || b;
        const u = 1 - t;
        const w0 = u * u * u, w1 = 3 * u * u * t, w2 = 3 * u * t * t, w3 = t * t * t;
        return { x: w0 * a.x + w1 * p1.x + w2 * p2.x + w3 * b.x, y: w0 * a.y + w1 * p1.y + w2 * p2.y + w3 * b.y };
    };

    // Nearest point on the model's outline to the pointer: { sub, seg, t, distPx }.
    const penNearestOnModel = (model, g, clientX, clientY, screenMatrix = null, clientPoint = null) => {
        const M = screenMatrix || penScreenMatrix();
        if (!M) return null;
        const full = M.multiply(g.F);
        const c = clientPoint || penClientToOverlay(clientX, clientY);
        const distAt = (a, b, t) => {
            const q = penSegPoint(a, b, t);
            const p = full.transformPoint(new DOMPoint(q.x, q.y));
            return penDist(p.x, p.y, c.x, c.y);
        };
        let best = null;
        model.subpaths.forEach((sub, si) => {
            const A = sub.anchors, n = A.length;
            if (n < 2) return;
            const segCount = sub.closed ? n : n - 1;
            for (let k = 0; k < segCount; k++) {
                const a = A[k], b = A[(k + 1) % n];
                const SAMPLES = 24;
                let bi = 0, bd = Infinity;
                for (let i = 0; i <= SAMPLES; i++) {
                    const d = distAt(a, b, i / SAMPLES);
                    if (d < bd) { bd = d; bi = i; }
                }
                // Ternary refine around the best sample.
                let lo = Math.max(0, (bi - 1) / SAMPLES), hi = Math.min(1, (bi + 1) / SAMPLES);
                for (let i = 0; i < 14; i++) {
                    const m1 = lo + (hi - lo) / 3, m2 = hi - (hi - lo) / 3;
                    if (distAt(a, b, m1) <= distAt(a, b, m2)) hi = m2; else lo = m1;
                }
                const t = (lo + hi) / 2;
                const d = distAt(a, b, t);
                if (!best || d < best.distPx) best = { sub: si, seg: k, t, distPx: d };
            }
        });
        return best;
    };

    // Nearest anchor to the pointer across the model: { sub, ai, distPx }.
    const penNearestAnchor = (model, g, clientX, clientY, screenMatrix = null, clientPoint = null) => {
        const M = screenMatrix || penScreenMatrix();
        if (!M) return null;
        const full = M.multiply(g.F);
        const c = clientPoint || penClientToOverlay(clientX, clientY);
        let best = null;
        model.subpaths.forEach((sub, si) => sub.anchors.forEach((a, ai) => {
            const p = full.transformPoint(new DOMPoint(a.x, a.y));
            const d = penDist(p.x, p.y, c.x, c.y);
            if (!best || d < best.distPx) best = { sub: si, ai, distPx: d };
        }));
        return best;
    };

    /* ==== Model edits ======================================================================= */

    const penReverseSub = (sub) => {
        sub.anchors.reverse();
        sub.anchors.forEach(a => { const t = a.hIn; a.hIn = a.hOut; a.hOut = t; });
    };

    // De Casteljau split of segment `seg` of subpath `sub` at parameter t (line = plain insert).
    const penInsertAnchor = (model, hit) => {
        const sub = model.subpaths[hit.sub];
        const A = sub.anchors, n = A.length;
        const a = A[hit.seg], b = A[(hit.seg + 1) % n];
        let na;
        if (!a.hOut && !b.hIn) {
            const q = penSegPoint(a, b, hit.t);
            na = { x: q.x, y: q.y, hIn: null, hOut: null };
        } else {
            const t = hit.t;
            const P0 = a, P1 = a.hOut || a, P2 = b.hIn || b, P3 = b;
            const lerp = (p, q) => ({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t });
            const p01 = lerp(P0, P1), p12 = lerp(P1, P2), p23 = lerp(P2, P3);
            const p012 = lerp(p01, p12), p123 = lerp(p12, p23);
            const pM = lerp(p012, p123);
            a.hOut = mkHandle(p01.x, p01.y, a.x, a.y);
            b.hIn = mkHandle(p23.x, p23.y, b.x, b.y);
            na = { x: pM.x, y: pM.y, hIn: mkHandle(p012.x, p012.y, pM.x, pM.y), hOut: mkHandle(p123.x, p123.y, pM.x, pM.y) };
        }
        A.splice(hit.seg + 1, 0, na);
    };

    // Shared by the Scissors tool: keep the curve hit-test and de Casteljau split math in one
    // place while allowing each tool to supply its own screen-space overlay projection.
    window.pathEditGeometryBridge = {
        nearestOnModel: (model, g, clientX, clientY, screenMatrix, clientPoint) => penNearestOnModel(model, g, clientX, clientY, screenMatrix, clientPoint),
        nearestAnchor: (model, g, clientX, clientY, screenMatrix, clientPoint) => penNearestAnchor(model, g, clientX, clientY, screenMatrix, clientPoint),
        insertAnchor: (model, hit) => penInsertAnchor(model, hit),
        segmentPoint: (a, b, t) => penSegPoint(a, b, t)
    };

    // Rebuild the layers panel once after a primitive/line converted to <path> (layer cards
    // close over shape nodes), keeping the shape selected.
    const penRebindPanel = (idx) => {
        buildLayersPanel();
        window.setLayerSelectionSet?.([idx]);
        window.setEditSelectionSet?.([idx]);
        window.updateAllScrollbars?.();
    };

    /* ==== End / cancel ====================================================================== */

    const penTeardownDrag = () => {
        if (penDragRaf) { cancelAnimationFrame(penDragRaf); penDragRaf = 0; }
        penDragPending = null;
        if (penDrag) { try { previewArea.releasePointerCapture(penDrag.pointerId); } catch (_) {} }
        previewArea.removeEventListener('pointermove', penOnDragMove);
        previewArea.removeEventListener('pointerup', penOnDragEnd);
        previewArea.removeEventListener('pointercancel', penOnDragEnd);
    };

    // End the in-progress path: the geometry is already live, so this just finalizes -- a
    // brand-new path abandoned with fewer than 2 anchors is invisible and gets removed.
    const penEndPath = () => {
        if (penDrag) { penTeardownDrag(); penDrag = null; }
        if (!penPath) return;
        const p = penPath;
        penPath = null;
        const globalShape = penGlobalShape(p.idx);
        if (globalShape) {
            const model = penModel(globalShape, p.idx);
            const total = model ? model.subpaths.reduce((s, x) => s + x.anchors.length, 0) : 0;
            if (p.createdNew && total < 2) {
                globalShape.remove();
                bridge()?.invalidate(p.idx);
                buildLayersPanel();
                window.clearLayerSelection?.();
                window.clearEditSelection?.();
                window.updateAllScrollbars?.();
            }
        }
        renderOutput(false);
        if (penGlobalShape(p.idx)) {
            penTarget = String(p.idx);
            window.adoptCanvasSelection?.([p.idx]);
        } else {
            penTarget = null;
            window.adoptCanvasSelection?.([]);
        }
        if (penPendingRebuild) { penPendingRebuild = false; penRebindPanel(p.idx); }
        penApplyModeCursor();
        redrawPenOverlay();
    };

    // Esc mid-gesture: roll the shape back to its pre-gesture geometry.
    const penCancelDrag = () => {
        const d = penDrag;
        if (!d) return;
        penTeardownDrag();
        penDrag = null;
        if (d.globalShape && d.snapshot) {
            window.restoreShapeGeometry?.(d.globalShape, d.snapshot);
            bridge()?.invalidate(d.ownerIdx);
        }
        if (d.kind === 'first') {
            // The path itself was created on this press -- remove it entirely.
            const globalShape = penGlobalShape(d.ownerIdx);
            if (globalShape) globalShape.remove();
            bridge()?.invalidate(d.ownerIdx);
            penPath = null;
            buildLayersPanel();
            window.clearLayerSelection?.();
            window.clearEditSelection?.();
            window.updateAllScrollbars?.();
        }
        renderOutput(false);
        if (d.kind === 'first') window.adoptCanvasSelection?.([]);
        penApplyModeCursor();
    };

    /* ==== Drag frames ======================================================================= */

    const penApplyDragFrame = () => {
        penDragRaf = 0;
        const d = penDrag;
        if (!d || !d.moved || !penDragPending) return;
        const local = penPointerLocal(d.Finv, penDragPending.x, penDragPending.y);
        if (!local) return;
        const sub = d.model.subpaths[d.sub];
        const a = sub && sub.anchors[d.ai];
        if (!a) return;

        if (d.kind === 'continue') {
            // Pull out the leading handle only (the incoming segment keeps its shape).
            a.hOut = mkHandle(local.x, local.y, a.x, a.y);
        } else if (d.kind === 'close' && d.altLatched) {
            // Alt on close: only the closing-side handle follows (mirrored), hOut stays.
            a.hIn = mkHandle(2 * a.x - local.x, 2 * a.y - local.y, a.x, a.y);
        } else {
            // Smooth pair: leading handle under the cursor, trailing handle mirrored.
            a.hOut = mkHandle(local.x, local.y, a.x, a.y);
            if (!d.altLatched) a.hIn = mkHandle(2 * a.x - local.x, 2 * a.y - local.y, a.x, a.y);
        }

        bridge().writeGeometry(d.globalShape, d.model);
        renderOutput(true);      // deferred path; tail re-applies the pen chrome
    };

    function penOnDragMove(e) {
        const d = penDrag;
        if (!d || e.pointerId !== d.pointerId) return;
        if (!d.moved) {
            if (Math.abs(e.clientX - d.downX) < PEN_DRAG_THRESHOLD && Math.abs(e.clientY - d.downY) < PEN_DRAG_THRESHOLD) return;
            d.moved = true;
        }
        if (e.altKey) d.altLatched = true;   // Alt splits the pair; stays split for this drag
        penDragPending = { x: e.clientX, y: e.clientY };
        if (!penDragRaf) penDragRaf = requestAnimationFrame(penApplyDragFrame);
    }

    function penOnDragEnd(e) {
        const d = penDrag;
        if (!d || (e && e.pointerId !== d.pointerId)) return;
        penTeardownDrag();
        penDrag = null;
        if (d.kind === 'close') { penEndPath(); return; }
        renderOutput(false);     // commit (click or drag-end): flush export
        if (penPendingRebuild && penPath) { penPendingRebuild = false; penRebindPanel(penPath.idx); }
        penApplyModeCursor();
    }

    const penBeginDrag = (e, kind, idx, sub, ai, globalShape, model, snapshot) => {
        const g = penGeom(idx);
        if (!g) return;
        penDrag = {
            kind, pointerId: e.pointerId, moved: false,
            downX: e.clientX, downY: e.clientY,
            ownerIdx: String(idx), sub, ai,
            F: g.F, Finv: g.Finv,
            globalShape, model, snapshot,
            altLatched: !!e.altKey
        };
        try { previewArea.setPointerCapture(e.pointerId); } catch (_) {}
        previewArea.addEventListener('pointermove', penOnDragMove);
        previewArea.addEventListener('pointerup', penOnDragEnd);
        previewArea.addEventListener('pointercancel', penOnDragEnd);
    };

    /* ==== Mode clicks: add / delete anchors ================================================= */

    const penAddAnchorClick = (e) => {
        if (!globalOptimizedSvg) return;
        const shape = penShapeFromTarget(e.target);
        const idx = shape ? shape.getAttribute('data-pf-index') : penTarget;
        if (idx == null) return;
        let globalShape = penGlobalShape(idx);
        const g = penGeom(idx);
        const model = globalShape && g ? penModel(globalShape, idx) : null;
        if (!model) return;
        const hit = penNearestOnModel(model, g, e.clientX, e.clientY);
        if (!hit || hit.distPx > PEN_HIT_PX) {
            if (!shape) { penTarget = null; redrawPenOverlay(); }
            else if (idx !== penTarget) { penTarget = idx; redrawPenOverlay(); }
            return;
        }
        e.preventDefault();
        if (model.needsConversion || model.kind === 'line') {
            globalShape = bridge().convertToPath(globalShape, model);
            penPendingRebuild = true;
        }
        penInsertAnchor(model, hit);
        bridge().writeGeometry(globalShape, model);
        window.setHistoryLabel?.('Add Anchor', 'plus');
        renderOutput(false);
        if (penPendingRebuild) { penPendingRebuild = false; penRebindPanel(idx); }
        penTarget = idx;
        redrawPenOverlay();
    };

    const penDeleteAnchorClick = (e) => {
        if (!globalOptimizedSvg) return;
        const shape = penShapeFromTarget(e.target);
        const idx = shape ? shape.getAttribute('data-pf-index') : penTarget;
        if (idx == null) return;
        let globalShape = penGlobalShape(idx);
        const g = penGeom(idx);
        const model = globalShape && g ? penModel(globalShape, idx) : null;
        if (!model) return;
        const hit = penNearestAnchor(model, g, e.clientX, e.clientY);
        if (!hit || hit.distPx > PEN_HIT_PX) {
            if (!shape) { penTarget = null; redrawPenOverlay(); }
            else if (idx !== penTarget) { penTarget = idx; redrawPenOverlay(); }
            return;
        }
        e.preventDefault();
        window.setHistoryLabel?.('Delete Anchor', 'minus');
        if (model.needsConversion) {
            globalShape = bridge().convertToPath(globalShape, model);
            penPendingRebuild = true;
        }
        const sub = model.subpaths[hit.sub];
        sub.anchors.splice(hit.ai, 1);
        if (sub.anchors.length < 2) model.subpaths.splice(hit.sub, 1);
        if (!model.subpaths.length) {
            // Nothing left to draw -- remove the layer itself.
            globalShape.remove();
            bridge().invalidate(idx);
            penTarget = null;
            penPendingRebuild = false;
            buildLayersPanel();
            window.clearLayerSelection?.();
            window.clearEditSelection?.();
            window.updateAllScrollbars?.();
            renderOutput(false);
            return;
        }
        bridge().writeGeometry(globalShape, model);
        renderOutput(false);
        if (penPendingRebuild) { penPendingRebuild = false; penRebindPanel(idx); }
        penTarget = idx;
        redrawPenOverlay();
    };

    /* ==== Draw-mode pointer routing ========================================================= */

    const penStartNewPath = (e) => {
        let root = penPointerRoot(e.clientX, e.clientY);
        const wrapper = globalOptimizedSvg && (globalOptimizedSvg.querySelector(':scope > g#ink-wrapper') || globalOptimizedSvg);
        if (!root || !wrapper) return;
        const sp = window.snapRootPoint?.(root);
        if (sp) root = sp;
        const path = document.createElementNS(SVGNS, 'path');
        path.setAttribute('d', `M ${penNum(root.x)} ${penNum(root.y)}`);
        // New paths take the current drawing defaults (Paint Panel with nothing
        // selected, js/layers.js); the app default is no fill + black stroke.
        const d = window.getDrawingDefaults ? window.getDrawingDefaults() : { fill: 'none', stroke: '#000000', strokeWidth: (window.getShapeToolDefaultStrokeWidth ? window.getShapeToolDefaultStrokeWidth() : '1') };
        path.setAttribute('fill', d.fill);
        path.setAttribute('stroke', d.stroke);
        path.setAttribute('stroke-width', d.strokeWidth);
        const idx = window.getNextLayerPfIndex ? window.getNextLayerPfIndex() : '0';
        path.setAttribute('data-pf-index', idx);
        path.setAttribute('data-pf-label', 'Path');
        wrapper.appendChild(path);
        buildLayersPanel();
        window.selectLayer?.(idx);
        window.setEditSelectionSet?.([idx]);
        penTarget = String(idx);
        renderOutput(true);                              // live preview; the pointerup commits
        window.adoptCanvasSelection?.([idx]);
        window.updateAllScrollbars?.();
        penPath = { idx: String(idx), sub: 0, createdNew: true };
        const model = penModel(path, idx);
        if (model) penBeginDrag(e, 'first', idx, 0, 0, path, model, null);   // cancel removes the element
        penSetCursor(null);
    };

    // Root-space position of the in-progress path's last anchor -- the base point for the
    // Shift 45-degree constraint (anchor placement + hover rubber-band pinning).
    const penPrevAnchorRoot = () => {
        if (!penPath) return null;
        const globalShape = penGlobalShape(penPath.idx);
        const g = penGeom(penPath.idx);
        const model = globalShape && g ? penModel(globalShape, penPath.idx) : null;
        const sub = model && model.subpaths[penPath.sub];
        if (!sub || !sub.anchors.length || sub.closed) return null;
        const a = sub.anchors[sub.anchors.length - 1];
        const p = g.F.transformPoint(new DOMPoint(a.x, a.y));
        return { x: p.x, y: p.y };
    };

    const penPlaceAnchor = (e) => {
        const globalShape = penGlobalShape(penPath.idx);
        const g = penGeom(penPath.idx);
        const model = globalShape && g ? penModel(globalShape, penPath.idx) : null;
        const sub = model && model.subpaths[penPath.sub];
        if (!sub || sub.closed) { penPath = null; penApplyModeCursor(); return; }
        let root = penPointerRoot(e.clientX, e.clientY);
        if (!root) return;
        if (e.shiftKey && sub.anchors.length) {
            // Shift constrains the new anchor to the nearest 45-degree direction from the
            // previous anchor (constraint wins over snapping, Illustrator-style).
            const prev = sub.anchors[sub.anchors.length - 1];
            const p = g.F.transformPoint(new DOMPoint(prev.x, prev.y));
            const c = constrainVec45(root.x - p.x, root.y - p.y);
            root = { x: p.x + c.x, y: p.y + c.y };
        } else {
            const sp = window.snapRootPoint?.(root);
            if (sp) root = sp;
        }
        const local = g.Finv.transformPoint(new DOMPoint(root.x, root.y));
        const snapshot = window.snapshotShapeGeometry?.(globalShape);
        sub.anchors.push({ x: local.x, y: local.y, hIn: null, hOut: null });
        bridge().writeGeometry(globalShape, model);
        renderOutput(true);                              // stroke appears on click; commit on release
        penBeginDrag(e, 'place', penPath.idx, penPath.sub, sub.anchors.length - 1, globalShape, model, snapshot);
    };

    const penClosePath = (e) => {
        const globalShape = penGlobalShape(penPath.idx);
        const g = penGeom(penPath.idx);
        const model = globalShape && g ? penModel(globalShape, penPath.idx) : null;
        const sub = model && model.subpaths[penPath.sub];
        if (!sub || sub.closed) { penPath = null; penApplyModeCursor(); return; }
        const snapshot = window.snapshotShapeGeometry?.(globalShape);
        sub.closed = true;
        bridge().writeGeometry(globalShape, model);
        renderOutput(true);
        penBeginDrag(e, 'close', penPath.idx, penPath.sub, 0, globalShape, model, snapshot);
    };

    const penContinuePath = (e, ep) => {
        let globalShape = penGlobalShape(ep.idx);
        if (!globalShape) return;
        let model = penModel(globalShape, ep.idx);
        if (!model) return;
        // Appending curves needs a real <path>; convert line/polyline (open primitives) once.
        if (model.kind !== 'path') {
            globalShape = bridge().convertToPath(globalShape, model);
            penPendingRebuild = true;
        }
        const sub = model.subpaths[ep.sub];
        if (!sub || sub.closed) return;
        if (ep.end === 'start' && sub.anchors.length > 1) penReverseSub(sub);
        bridge().writeGeometry(globalShape, model);
        penPath = { idx: String(ep.idx), sub: ep.sub, createdNew: false };
        penHoverEndpoint = null;
        window.selectLayer?.(ep.idx);
        window.setEditSelectionSet?.([ep.idx]);
        penTarget = String(ep.idx);
        renderOutput(true);
        window.adoptCanvasSelection?.([ep.idx]);
        const snapshot = window.snapshotShapeGeometry?.(globalShape);
        penBeginDrag(e, 'continue', ep.idx, ep.sub, sub.anchors.length - 1, globalShape, model, snapshot);
        penSetCursor(null);
    };

    // Manual double-click detection for pointerdown (e.detail is 0 on pointer events in some
    // browsers): two presses within the time/distance window count as a double-click. The FIRST
    // press of the pair places the final anchor as usual; the second ends the path.
    let penLastClick = null;    // { t, x, y } of the previous path-in-progress press
    const PEN_DBLCLICK_MS = 400, PEN_DBLCLICK_PX = 5;
    const penIsDoubleClick = (e) => {
        const now = performance.now();
        const last = penLastClick;
        penLastClick = { t: now, x: e.clientX, y: e.clientY };
        return !!(last && now - last.t <= PEN_DBLCLICK_MS
            && Math.abs(e.clientX - last.x) <= PEN_DBLCLICK_PX
            && Math.abs(e.clientY - last.y) <= PEN_DBLCLICK_PX);
    };

    previewArea.addEventListener('pointerdown', (e) => {
        if (window.isGuideDragActive?.()) return;
        if (!penActive || e.button !== 0 || penDrag) return;
        if (isStatusBarTarget(e.target)) return;
        if (window.isHandToolTemporaryPan?.()) return;
        if (penMode === 'add') { penAddAnchorClick(e); return; }
        if (penMode === 'minus') { penDeleteAnchorClick(e); return; }

        if (penPath) {
            e.preventDefault();
            // Double-click ends the path (the pair's first press already placed the final anchor).
            if (e.detail >= 2 || penIsDoubleClick(e)) { penLastClick = null; penEndPath(); return; }
            if (penHitFirstAnchor(e.clientX, e.clientY)) { penClosePath(e); return; }
            penPlaceAnchor(e);
            return;
        }
        penLastClick = null;    // presses outside an in-progress path never pair into a double-click

        const ep = penFindOpenEndpoint(e.clientX, e.clientY);
        e.preventDefault();
        if (ep) penContinuePath(e, ep);
        else penStartNewPath(e);
    });

    // Hover: cursor state + rubber band / endpoint highlight.
    previewArea.addEventListener('pointermove', (e) => {
        if (window.isGuideDragActive?.()) return;
        if (!penActive || penDrag || window.isHandToolTemporaryPan?.()) return;
        penCursorPt = { x: e.clientX, y: e.clientY };
        if (penMode === 'draw') {
            if (penPath) {
                penSetCursor(penHitFirstAnchor(e.clientX, e.clientY) ? 'close' : null);
            } else {
                penHoverEndpoint = penFindOpenEndpoint(e.clientX, e.clientY);
                penSetCursor(penHoverEndpoint ? null : 'new');
            }
            // Smart-guide preview: snap the hover point (feedback only -- the click itself snaps
            // in penStartNewPath/penPlaceAnchor) and pin the rubber band to the snapped spot.
            // With Shift held mid-path, the rubber band pins to the 45-degree-constrained point
            // instead (matching what a Shift-click would place).
            const rootPt = penPointerRoot(e.clientX, e.clientY);
            if (rootPt) {
                const prev = (e.shiftKey && penPath) ? penPrevAnchorRoot() : null;
                if (prev) {
                    const cv = constrainVec45(rootPt.x - prev.x, rootPt.y - prev.y);
                    const pin = penRootToClient(prev.x + cv.x, prev.y + cv.y);
                    if (pin) penCursorPt = pin;
                } else {
                    const sp = window.snapRootPoint?.(rootPt);
                    if (sp && (sp.x !== rootPt.x || sp.y !== rootPt.y)) {
                        const c = penRootToClient(sp.x, sp.y);
                        if (c) penCursorPt = c;
                    }
                }
            }
            queuePenRedraw();
        } else {
            const shape = penShapeFromTarget(e.target);
            if (shape) {
                const idx = shape.getAttribute('data-pf-index');
                if (idx !== penTarget) { penTarget = idx; queuePenRedraw(); }
            }
        }
    });

    /* ==== Renderer / import hooks =========================================================== */

    window.clearPenToolOverlay = hidePenOverlay;

    window.syncPenToolOverlay = () => {
        if (window.isGuideDragActive?.()) { hidePenOverlay(); return; }
        if (penActive) queuePenRedraw();
        else hidePenOverlay();
    };

    // renderOutput() rebuilds the preview svg on every edit -> re-apply chrome onto the fresh
    // svg (and drop pen state whose shape no longer exists, e.g. hidden or deleted).
    window.refreshPenToolOverlay = () => {
        if (window.isGuideDragActive?.()) { hidePenOverlay(); return; }
        if (!penActive) { hidePenOverlay(); return; }
        if (penPath && !penFindPreviewShape(penPath.idx)) { penPath = null; penApplyModeCursor(); }
        if (penTarget != null && !penFindPreviewShape(penTarget)) penTarget = null;
        redrawPenOverlay();
    };

    // Fresh import / reset: drop all pen state without turning the tool off.
    window.clearPenToolState = () => {
        if (penDrag) { penTeardownDrag(); penDrag = null; }
        penPath = null;
        penTarget = null;
        penHoverEndpoint = null;
        penCursorPt = null;
        penPendingRebuild = false;
        penTempSel = null;
        hidePenOverlay();
        if (penActive) penApplyModeCursor();
    };

    /* ==== Mode bar ========================================================================== */

    const PEN_MODE_BTN = { draw: 'btnPenModeDraw', add: 'btnPenModeAdd', minus: 'btnPenModeMinus' };
    const penSetModeButtons = () => {
        Object.entries(PEN_MODE_BTN).forEach(([m, id]) => {
            const b = $(id);
            if (b) b.classList.toggle('active', penMode === m);
        });
    };

    window.setPenToolMode = (mode, _btn) => {
        if (!penActive || !PEN_MODE_BTN[mode] || penMode === mode) return;
        if (penDrag) { penTeardownDrag(); penDrag = null; }
        if (penPath) penEndPath();
        penMode = mode;
        penTarget = penSharedVectorIndex();
        penHoverEndpoint = null;
        penSetModeButtons();
        penApplyModeCursor();
        redrawPenOverlay();
    };

    /* ==== Activation ======================================================================== */

    const penActivate = (btn) => {
        window.deactivateSelectionTool?.();
        window.deactivateDirectSelectionTool?.();
        window.deactivateHandTool?.();
        window.deactivateArtboardTool?.();
        window.deactivateShapeTool?.();
        window.deactivateScissorsTool?.();
        penActive = true;
        (btn || $('btnPenTool'))?.classList.add('active');
        previewArea.classList.add('pen-active');
        const bar = $('penModeBar');
        if (bar) bar.hidden = false;
        penSetModeButtons();
        penApplyModeCursor();
        penTarget = penSharedVectorIndex();
        redrawPenOverlay();
    };

    const penDeactivate = () => {
        if (penDrag) { penTeardownDrag(); penDrag = null; renderOutput(false); }
        if (penTempSwitching) penPath = null;    // preserved in penTempSel; skip finalizing
        else penEndPath();
        penActive = false;
        $('btnPenTool')?.classList.remove('active');
        previewArea.classList.remove('pen-active');
        penSetCursor(null);
        const bar = $('penModeBar');
        if (bar) bar.hidden = true;
        penTarget = null;
        penHoverEndpoint = null;
        penCursorPt = null;
        hidePenOverlay();
    };

    window.deactivatePenTool = () => { if (penActive) penDeactivate(); };

    window.togglePenTool = (btn) => {
        if (penActive) return;
        penMode = 'draw';                        // a fresh activation always starts in draw mode
        penActivate(btn);
    };

    // Ctrl released (or focus lost) while temp-switched: return to the pen and re-arm the
    // in-progress path if its shape/subpath still exists and is still open.
    const penResumeFromTempSwitch = () => {
        if (!penTempSel) return;
        const saved = penTempSel;
        penTempSel = null;
        const dselBtn = $('btnDirectSelectionTool');
        if (!dselBtn || !dselBtn.classList.contains('active')) return;   // user moved on
        window.deactivateDirectSelectionTool?.();
        penActivate();                            // keeps the current penMode
        if (saved.resume) {
            const globalShape = penGlobalShape(saved.resume.idx);
            const model = globalShape ? penModel(globalShape, saved.resume.idx) : null;
            const sub = model && model.subpaths[saved.resume.sub];
            if (sub && !sub.closed && sub.anchors.length) penPath = saved.resume;
        }
        penApplyModeCursor();
        redrawPenOverlay();
    };

    /* ==== Keyboard ========================================================================== */

    document.addEventListener('keydown', (e) => {
        // P selects the Pen tool (Illustrator) -- inert in text fields / eyedropper / no artboard.
        if ((e.key === 'p' || e.key === 'P') && !e.ctrlKey && !e.altKey && !e.metaKey && !e.repeat
            && !penActive && globalOptimizedSvg && !isTextInputFocused() && !isEyedropperMode) {
            e.preventDefault();
            window.togglePenTool();
            return;
        }
        if (!penActive) return;
        if (e.key === 'Escape' && isTextInputFocused()) return;

        if (e.key === 'Escape') {
            if (penDrag) { e.preventDefault(); penCancelDrag(); return; }
            if (penPath) { e.preventDefault(); penEndPath(); return; }
            if (penTarget != null && !isEyedropperMode) {
                e.preventDefault();
                const selectedTarget = editSelectedIndices.has(String(penTarget));
                penTarget = null;
                if (selectedTarget) window.adoptCanvasSelection?.([]);
                redrawPenOverlay();
            }
            return;
        }
        if (e.key === 'Enter' && penPath && !isTextInputFocused()) {
            e.preventDefault();
            penEndPath();
            return;
        }
        // Ctrl (hold): temporarily switch to the Direct Selection tool (Illustrator-style);
        // the in-progress path is preserved and re-armed when Ctrl is released.
        if (e.key === 'Control' && !e.repeat && !penDrag && !isTextInputFocused()) {
            penTempSel = { resume: penPath ? { ...penPath } : null };
            penTempSwitching = true;
            window.toggleDirectSelectionTool?.();
            penTempSwitching = false;
        }
    });

    document.addEventListener('keyup', (e) => {
        if (e.key === 'Control' && penTempSel) penResumeFromTempSwitch();
    });

    window.addEventListener('blur', () => {
        if (penTempSel) penResumeFromTempSwitch();
    });

})();
