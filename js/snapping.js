/* fileName: snapping.js */

// Smart-guide snapping engine (Illustrator-style Smart Guides / Snap to Point). One shared
// engine the canvas tools call while moving, scaling, drawing, anchor-editing, and dragging
// guides: candidate geometry (visible objects' root-space bounds edges/centers, artboard
// edges/center, guide lines) is collected once per gesture, then each frame the dragged
// point/bounds snap to the nearest candidate within a fixed screen tolerance. X and Y resolve
// independently; a stronger candidate kind wins over a weaker one whenever it is in tolerance
// (guide > center > edge), distance breaks ties inside a kind.
//
// Feedback is drawn into the screen-space #snapOverlay svg (pointer-events:none, never in
// globalOptimizedSvg -- nothing enters export): a magenta hairline per snapped axis plus a
// small circle marker where the dragged point lands, and a kind label in the canvas status
// bar (#csSnapLabel). The header Snap button (#btnToggleSnap) turns the feature on/off
// (default on); holding Ctrl temporarily inverts the toggle (the Pen tool's own Ctrl-hold
// tool switch takes precedence for pen anchor placement -- see docs/snapping.md).
//
// Snapping only adjusts coordinates inside the tools' existing gesture pipelines, so undo/
// redo needs no changes (every commit still funnels through renderOutput(false)).

(() => {

    if (!previewArea) return;

    const SNAP_TOL_PX = 6;                              // screen px, converted through viewScale
    const SNAP_PRIO = { guide: 3, center: 2, edge: 1 }; // stronger kind wins when both are in tolerance
    const SNAP_MARKER_R = 3.5;                          // screen px, landing-point circle
    const SVGNS = 'http://www.w3.org/2000/svg';

    const snapOverlay = $('snapOverlay');
    const btnSnap = $('btnToggleSnap');
    const snapLabel = $('csSnapLabel');

    let snapUserOn = true;      // header Snap toggle (default on)
    let ctrlHeld = false;       // Ctrl-hold inverts snapUserOn for its duration
    let frozen = null;          // gesture-frozen target set ({ xs, ys }), null when idle
    let cache = null;           // lazy target set for out-of-gesture queries (pen hover/clicks)
    let cacheDirty = true;
    let lastFeedback = null;    // { vx, vy, label, markers } in root coords (re-projected on view sync)

    const snapPreviewSvg = () => previewArea.querySelector(PREVIEW_SVG_SELECTOR);

    const snapEnabled = () => !!globalOptimizedSvg && (snapUserOn !== ctrlHeld);
    window.isSnapEnabled = snapEnabled;

    const snapViewBox = (svg) => {
        let x = 0, y = 0;
        let w = parseFloat(svg.dataset.nativeW) || 128;
        let h = parseFloat(svg.dataset.nativeH) || 128;
        const vb = svg.getAttribute('viewBox') || svg.getAttribute('viewbox');
        if (vb) {
            const p = vb.trim().split(/[\s,]+/);
            if (p.length === 4) { x = parseFloat(p[0]) || 0; y = parseFloat(p[1]) || 0; w = parseFloat(p[2]) || w; h = parseFloat(p[3]) || h; }
        }
        return { x, y, w, h };
    };

    // Root-space AABB of one preview shape (bbox corners through its full transform chain).
    const snapShapeBounds = (shape, svg) => {
        let bb;
        try { bb = shape.getBBox(); } catch (_) { return null; }
        const anc = cumulativeAncestorMatrix(shape, svg);
        const own = shape.getAttribute('transform');
        const F = own ? anc.multiply(svgTransformToMatrix(own)) : anc;
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        [[bb.x, bb.y], [bb.x + bb.width, bb.y], [bb.x + bb.width, bb.y + bb.height], [bb.x, bb.y + bb.height]]
            .forEach(([x, y]) => {
                const p = F.transformPoint(new DOMPoint(x, y));
                if (p.x < minX) minX = p.x;
                if (p.y < minY) minY = p.y;
                if (p.x > maxX) maxX = p.x;
                if (p.y > maxY) maxY = p.y;
            });
        return Number.isFinite(minX) && Number.isFinite(minY) ? { minX, minY, maxX, maxY } : null;
    };

    // Candidate lists per axis: entries { v, kind ('edge'|'center'|'guide'), label, idx }.
    // The preview svg only contains visible shapes (renderOutput prunes hidden ones), so
    // hidden layers never become targets.
    const buildTargets = (excludeSet, includeGuides) => {
        const svg = snapPreviewSvg();
        if (!svg || !globalOptimizedSvg) return null;
        const xs = [], ys = [];
        const vb = snapViewBox(svg);

        getEditableLayerShapes(svg).forEach(shape => {
            const idx = shape.getAttribute('data-pf-index');
            if (idx == null || (excludeSet && excludeSet.has(String(idx)))) return;
            const b = snapShapeBounds(shape, svg);
            if (!b) return;
            xs.push({ v: b.minX, kind: 'edge', label: 'edge', idx },
                    { v: b.maxX, kind: 'edge', label: 'edge', idx },
                    { v: (b.minX + b.maxX) / 2, kind: 'center', label: 'center', idx });
            ys.push({ v: b.minY, kind: 'edge', label: 'edge', idx },
                    { v: b.maxY, kind: 'edge', label: 'edge', idx },
                    { v: (b.minY + b.maxY) / 2, kind: 'center', label: 'center', idx });
        });

        xs.push({ v: vb.x, kind: 'edge', label: 'artboard', idx: null },
                { v: vb.x + vb.w, kind: 'edge', label: 'artboard', idx: null },
                { v: vb.x + vb.w / 2, kind: 'center', label: 'center', idx: null });
        ys.push({ v: vb.y, kind: 'edge', label: 'artboard', idx: null },
                { v: vb.y + vb.h, kind: 'edge', label: 'artboard', idx: null },
                { v: vb.y + vb.h / 2, kind: 'center', label: 'center', idx: null });

        if (includeGuides) {
            (window.getSnapGuidePositions?.() || []).forEach(g => {
                if (g.axis === 'v') xs.push({ v: vb.x + g.pos, kind: 'guide', label: 'guide', idx: null });
                else ys.push({ v: vb.y + g.pos, kind: 'guide', label: 'guide', idx: null });
            });
        }
        return { xs, ys };
    };

    const getQueryTargets = () => {
        if (frozen) return frozen;
        if (!cache || cacheDirty) { cache = buildTargets(null, true); cacheDirty = false; }
        return cache;
    };

    // Committed document changes (renderOutput tail) and guide edits mark the lazy cache stale;
    // a gesture-frozen set is deliberately untouched (targets hold still for the whole drag).
    window.invalidateSnapTargets = () => { cacheDirty = true; cache = null; };

    const snapTolRoot = () => SNAP_TOL_PX / Math.max(viewScale, 1e-6);

    // Best candidate on one axis: a stronger kind wins whenever it is in tolerance at all;
    // distance breaks ties inside a kind (the predictable priority system).
    const snapAxisBest = (entries, value, tol, excl) => {
        let best = null;
        for (let i = 0; i < entries.length; i++) {
            const t = entries[i];
            if (excl && t.idx != null && excl.has(t.idx)) continue;
            const d = Math.abs(t.v - value);
            if (d > tol) continue;
            const p = SNAP_PRIO[t.kind] || 0;
            if (!best || p > best.p || (p === best.p && d < best.d)) best = { v: t.v, d, p, kind: t.kind, label: t.label };
        }
        return best;
    };

    /* ==== Feedback overlay + status-bar label =============================================== */

    // Projection: viewBox-root coords -> #snapOverlay screen px (and size the overlay).
    const snapScreenMatrix = () => {
        const svg = snapPreviewSvg();
        if (!svg || !snapOverlay) return null;
        const areaRect = previewArea.getBoundingClientRect();
        const areaStyle = getComputedStyle(previewArea);
        const areaBorderL = parseFloat(areaStyle.borderLeftWidth) || 0;
        const areaBorderT = parseFloat(areaStyle.borderTopWidth) || 0;
        const areaW = areaRect.width - areaBorderL - (parseFloat(areaStyle.borderRightWidth) || 0);
        const areaH = areaRect.height - areaBorderT - (parseFloat(areaStyle.borderBottomWidth) || 0);
        const svgRect = svg.getBoundingClientRect();
        const vb = snapViewBox(svg);
        if (areaW <= 0 || areaH <= 0 || vb.w <= 0 || vb.h <= 0 || svgRect.width <= 0 || svgRect.height <= 0) return null;

        snapOverlay.setAttribute('viewBox', `0 0 ${areaW} ${areaH}`);
        snapOverlay.setAttribute('width', areaW);
        snapOverlay.setAttribute('height', areaH);

        const M = new DOMMatrix()
            .translate(svgRect.left - areaRect.left - areaBorderL, svgRect.top - areaRect.top - areaBorderT)
            .scale(svgRect.width / vb.w, svgRect.height / vb.h)
            .translate(-vb.x, -vb.y);
        return { M, areaW, areaH };
    };

    const snapColor = () => {
        const v = getComputedStyle(document.documentElement).getPropertyValue('--snap-guide').trim();
        return v || '#ff2fd2';
    };

    const hideSnapFeedback = () => {
        lastFeedback = null;
        if (snapOverlay && (!snapOverlay.hasAttribute('hidden') || snapOverlay.children.length)) {
            snapOverlay.replaceChildren();
            snapOverlay.toggleAttribute('hidden', true);
        }
        if (snapLabel && !snapLabel.hidden) snapLabel.hidden = true;
    };

    window.clearSnapFeedback = hideSnapFeedback;

    const drawSnapFeedback = () => {
        if (!snapOverlay || !lastFeedback) return;
        const proj = snapScreenMatrix();
        snapOverlay.replaceChildren();
        if (!proj) { snapOverlay.toggleAttribute('hidden', true); return; }
        const { M, areaW, areaH } = proj;
        const color = snapColor();

        const line = (x1, y1, x2, y2) => {
            const l = document.createElementNS(SVGNS, 'line');
            l.setAttribute('x1', x1); l.setAttribute('y1', y1);
            l.setAttribute('x2', x2); l.setAttribute('y2', y2);
            l.setAttribute('stroke', color);
            l.setAttribute('stroke-width', '1');
            l.setAttribute('shape-rendering', 'crispEdges');
            l.setAttribute('pointer-events', 'none');
            snapOverlay.appendChild(l);
        };
        if (lastFeedback.vx != null) {
            const sx = Math.round(M.transformPoint(new DOMPoint(lastFeedback.vx, 0)).x) + 0.5;
            line(sx, 0, sx, areaH);
        }
        if (lastFeedback.vy != null) {
            const sy = Math.round(M.transformPoint(new DOMPoint(0, lastFeedback.vy)).y) + 0.5;
            line(0, sy, areaW, sy);
        }
        (lastFeedback.markers || []).forEach(pt => {
            const p = M.transformPoint(new DOMPoint(pt.x, pt.y));
            const c = document.createElementNS(SVGNS, 'circle');
            c.setAttribute('cx', p.x); c.setAttribute('cy', p.y);
            c.setAttribute('r', SNAP_MARKER_R);
            c.setAttribute('fill', 'none');
            c.setAttribute('stroke', color);
            c.setAttribute('stroke-width', '1');
            c.setAttribute('pointer-events', 'none');
            snapOverlay.appendChild(c);
        });
        snapOverlay.toggleAttribute('hidden', !snapOverlay.children.length);

        if (snapLabel) {
            snapLabel.textContent = lastFeedback.label || '';
            snapLabel.hidden = !lastFeedback.label;
        }
    };

    // Re-project the current feedback through a changed view (zoom/pan/resize mid-gesture).
    window.syncSnapOverlay = () => { if (lastFeedback) drawSnapFeedback(); };

    const setFeedback = (mx, my, markers) => {
        if (!mx && !my) { hideSnapFeedback(); return; }
        const label = (mx && my) ? 'intersection' : (mx ? mx.label : my.label);
        lastFeedback = { vx: mx ? mx.v : null, vy: my ? my.v : null, label, markers };
        drawSnapFeedback();
    };

    /* ==== Gesture + query API ================================================================ */

    // Freeze the target set for a drag: opts.exclude = pf-indices being dragged (they must not
    // snap to themselves), opts.includeGuides = false while dragging a guide.
    window.beginSnapGesture = (opts = {}) => {
        const excl = opts.exclude ? new Set([...opts.exclude].map(String)) : null;
        frozen = buildTargets(excl, opts.includeGuides !== false);
    };

    window.endSnapGesture = () => {
        frozen = null;
        hideSnapFeedback();
    };

    // Snap one root-space point (pen clicks/hover, shape-draw points, scale handle targets,
    // guide positions). opts.axes limits which axes may snap; opts.exclude filters candidate
    // shapes on out-of-gesture queries. Returns the (possibly) adjusted point.
    window.snapRootPoint = (pt, opts = {}) => {
        if (!pt) return null;
        if (!snapEnabled()) { hideSnapFeedback(); return { x: pt.x, y: pt.y }; }
        const targets = getQueryTargets();
        if (!targets) { hideSnapFeedback(); return { x: pt.x, y: pt.y }; }
        const tol = snapTolRoot();
        const excl = opts.exclude ? new Set([...opts.exclude].map(String)) : null;
        const axes = opts.axes || { x: true, y: true };
        const mx = axes.x ? snapAxisBest(targets.xs, pt.x, tol, excl) : null;
        const my = axes.y ? snapAxisBest(targets.ys, pt.y, tol, excl) : null;
        const out = { x: mx ? mx.v : pt.x, y: my ? my.v : pt.y };
        setFeedback(mx, my, (mx && my) ? [out] : null);
        return out;
    };

    // Snap a move delta: points = the dragged selection's key points (bounds corners, edge
    // mids, center). The best candidate over all points adjusts the delta per axis, so the
    // whole selection lands exactly on the snapped alignment.
    window.snapRootDelta = (points, dx, dy) => {
        if (!points || !points.length || !snapEnabled()) { hideSnapFeedback(); return { dx, dy }; }
        const targets = getQueryTargets();
        if (!targets) { hideSnapFeedback(); return { dx, dy }; }
        const tol = snapTolRoot();
        let bestX = null, bestY = null;
        for (const p of points) {
            const mx = snapAxisBest(targets.xs, p.x + dx, tol, null);
            if (mx && (!bestX || mx.p > bestX.m.p || (mx.p === bestX.m.p && mx.d < bestX.m.d))) bestX = { m: mx, p };
            const my = snapAxisBest(targets.ys, p.y + dy, tol, null);
            if (my && (!bestY || my.p > bestY.m.p || (my.p === bestY.m.p && my.d < bestY.m.d))) bestY = { m: my, p };
        }
        const outDx = bestX ? bestX.m.v - bestX.p.x : dx;
        const outDy = bestY ? bestY.m.v - bestY.p.y : dy;
        const markers = [];
        if (bestX && bestY && bestX.p === bestY.p) markers.push({ x: bestX.m.v, y: bestY.m.v });
        else {
            if (bestX) markers.push({ x: bestX.m.v, y: bestX.p.y + outDy });
            if (bestY) markers.push({ x: bestY.p.x + outDx, y: bestY.m.v });
        }
        setFeedback(bestX && bestX.m, bestY && bestY.m, markers);
        return { dx: outDx, dy: outDy };
    };

    /* ==== Snap toggle button + Ctrl invert =================================================== */

    const syncSnapButton = () => {
        if (!btnSnap) return;
        btnSnap.classList.toggle('is-checked', snapUserOn);
        btnSnap.setAttribute('aria-pressed', snapUserOn ? 'true' : 'false');
        btnSnap.title = (snapUserOn ? 'Disable snapping' : 'Enable snapping') + ' (hold Ctrl to invert while editing)';
    };

    if (btnSnap) btnSnap.addEventListener('click', () => {
        snapUserOn = !snapUserOn;
        syncSnapButton();
        if (!snapEnabled()) hideSnapFeedback();
    });

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Control' && !ctrlHeld) {
            ctrlHeld = true;
            if (!snapEnabled()) hideSnapFeedback();
        }
    });
    document.addEventListener('keyup', (e) => {
        if (e.key === 'Control' && ctrlHeld) {
            ctrlHeld = false;
            if (!snapEnabled()) hideSnapFeedback();
        }
    });
    window.addEventListener('blur', () => {
        if (ctrlHeld) {
            ctrlHeld = false;
            if (!snapEnabled()) hideSnapFeedback();
        }
    });

    // Hover feedback (pen) should not linger when the pointer leaves the canvas; a captured
    // in-gesture drag keeps its feedback (frozen is set).
    previewArea.addEventListener('pointerleave', () => { if (!frozen) hideSnapFeedback(); });

    syncSnapButton();

})();
