/* fileName: selection-tool.js */

// "Selection" tool (Illustrator-style). While active, hovering the canvas traces the shape
// under the cursor with a thin green hairline; clicking selects it -- drawing the green path
// outline PLUS an oriented bounding box with 8 square handles (4 corners + 4 edge mids,
// white fill / green outline). The handles drive the shared scale/rotate transform engine.
// Only one canvas tool may be active at a time, so activating this turns
// the other canvas tools off (and vice-versa, via window.deactivateSelectionTool).
//
// Hit-testing is free (the pointer-events:none overlays mean e.target
// on #previewArea is the painted shape under the cursor), and all chrome lives in a screen-space
// overlay svg (#selectionOverlay) above the artwork -- never in globalOptimizedSvg -- so nothing
// leaks into export. Wrapped in an IIFE so its locals can't collide with the shared global
// script scope; it reuses the matrix helpers from layers.js and selectLayer/clearLayerSelection.

(() => {

    let selActive = false;          // tool engaged
    const selSelection = new Set(); // data-pf-index set of the click-selected shapes (separate from selectedLayerIndex)
    let selHoverIndex = null;       // data-pf-index currently traced by the hover outline

    const SEL_GREEN = '#00E676';
    const SEL_BLUE = '#1E9BFF';
    const SEL_W = '1.5';            // screen px -- one thickness for the outline, box, and handles
    const SEL_HANDLE_PX = 8;        // square handle size in screen px
    const SEL_ROTATE_ZONE_PX = 18;  // invisible hover/drag target just outside each handle
    const SEL_ROTATE_ZONE_GAP = 2;
    const SEL_ROTATE_STICK_DEG = 7; // Shift-rotate: degrees within a 45-degree detent that stick
    const SEL_HOVER_ID = 'sel-hover-outline';
    const SEL_ANIM_PAD_MS = 40;
    const SVGNS = 'http://www.w3.org/2000/svg';

    // Marquee (rubber-band select) chrome -- a crisp cool-white hairline over a soft dark casing so
    // the box stays legible on the dark canvas AND over any artwork (Illustrator-style, neutral in
    // every mode). Drawn in overlay screen px like the rest of the chrome.
    const SEL_MARQUEE_LINE = 'rgba(240,245,255,0.95)';
    const SEL_MARQUEE_LINE_W = '1.25';
    const SEL_MARQUEE_CASING = 'rgba(0,0,0,0.4)';
    const SEL_MARQUEE_CASING_W = '2.75';

    let selSyncRaf = 0, selAnimRaf = 0, selAnimUntil = 0;

    // Active transform gesture, null when idle: { mode:'move'|'scale'|'rotate', ... }.
    // 'move' translates the shape; 'scale' resizes about the opposite handle; 'rotate' spins around center.
    let selDrag = null;
    let selDragRaf = 0, selDragPending = null;
    const SEL_DRAG_THRESHOLD = 3;   // px of travel before a press becomes a drag (vs a click)

    // Active marquee gesture (rubber-band select), null when idle:
    // { pointerId, downX, downY, startRoot, curRoot, moved, add, subtract }. Kept separate from
    // selDrag so a marquee never interferes with a move/scale/rotate gesture.
    let selMarquee = null;

    const SEL_ROTATE_BASE_DEG = { nw: -45, n: 0, ne: 45, w: -90, e: 90, sw: -135, s: 180, se: 135 };
    const SEL_SCALE_AXIS = {
        nw: { sx: true,  sy: true  }, n: { sx: false, sy: true  }, ne: { sx: true,  sy: true  },
        w:  { sx: true,  sy: false },                                e:  { sx: true,  sy: false },
        sw: { sx: true,  sy: true  }, s: { sx: false, sy: true  }, se: { sx: true,  sy: true  }
    };
    const SEL_OPPOSITE_HANDLE = { nw: 'se', n: 's', ne: 'sw', w: 'e', e: 'w', sw: 'ne', s: 'n', se: 'nw' };
    let selRotateCursorAngles = {};

    const selPreviewSvg = () => previewArea.querySelector(PREVIEW_SVG_SELECTOR);
    // Illustrator keeps an object's transform box visible while drawing shapes or panning.
    // Shape tools may also use the existing box handles without becoming the Selection tool.
    const selChromeVisible = () => selActive
        || previewArea.classList.contains('shape-active')
        || previewArea.classList.contains('hand-active');
    const selPassiveTransformEnabled = () => !selActive && previewArea.classList.contains('shape-active');

    // Resolve a pointer target to a real layer shape in the live preview svg (carries data-pf-index).
    // Handles are <rect>s without data-pf-index, so they resolve to null (never treated as a shape).
    const selShapeFromTarget = (el) =>
        (el && el.tagName && el.matches && el.matches(SVG_LAYER_SHAPE_SELECTOR) && el.hasAttribute('data-pf-index')) ? el : null;

    const hideSelectionOverlay = () => {
        if (selSyncRaf) { cancelAnimationFrame(selSyncRaf); selSyncRaf = 0; }
        if (selAnimRaf) { cancelAnimationFrame(selAnimRaf); selAnimRaf = 0; }
        selAnimUntil = 0;
        if (!selectionOverlay) return;
        if (selectionOverlay.hasAttribute('hidden') && !selectionOverlay.children.length) return;
        selectionOverlay.replaceChildren();
        selectionOverlay.toggleAttribute('hidden', true);
    };

    window.clearSelectionOverlay = hideSelectionOverlay;

    // Remove just the transient hover outline, leaving any selection chrome in place.
    const removeHoverOutline = () => {
        if (!selectionOverlay) return;
        const el = selectionOverlay.querySelector('#' + SEL_HOVER_ID);
        if (el) el.remove();
        selectionOverlay.toggleAttribute('hidden', !selectionOverlay.children.length);
    };

    window.clearSelectionToolHover = () => {
        selHoverIndex = null;
        removeHoverOutline();
    };

    const selFindShapeByIndex = (idx) => {
        const svg = selPreviewSvg();
        return (svg && idx != null) ? svg.querySelector(`[data-pf-index="${idx}"]`) : null;
    };
    const selSyncFromSharedSelection = () => {
        selSelection.clear();
        editSelectedIndices.forEach(idx => {
            if (!lockedLayers.has(String(idx)) && selFindShapeByIndex(idx)) selSelection.add(String(idx));
        });
    };

    // Central selection mutators: every membership change redraws the chrome and mirrors the set
    // into the shared edit selection (Properties) and the layer panel highlights. scrollIdx (when
    // given) scrolls that layer card into view.
    const selPushSelection = (scrollIdx) => {
        redrawSelectionOverlay();
        window.setEditSelectionSet?.([...selSelection]);
        window.setLayerSelectionSet?.([...selSelection]);
        if (scrollIdx != null) {
            const card = layersList.querySelector(`.layer-item[data-pf-index="${scrollIdx}"]`);
            if (card) {
                card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                if (window.updateAllScrollbars) requestAnimationFrame(window.updateAllScrollbars);
            }
        }
    };
    const selSetSelection = (indices, scrollIdx) => {
        selSelection.clear();
        // Locked layers are never selectable -- filtering here covers every entry point at once
        // (marquee, Ctrl+A, adopt, direct click), so a locked shape can't slip into the selection.
        (indices || []).forEach(idx => { if (idx != null && !lockedLayers.has(String(idx))) selSelection.add(String(idx)); });
        selPushSelection(scrollIdx);
    };
    const selToggleSelection = (idx) => {
        if (lockedLayers.has(String(idx))) return;
        if (selSelection.has(idx)) selSelection.delete(idx);
        else selSelection.add(idx);
        selPushSelection(selSelection.has(idx) ? idx : null);
    };
    const selClearSelection = () => selSetSelection([]);

    const selRotateCursor = (deg) => {
        const a = +deg.toFixed(2);
        return window.customCursors?.get('selection-rotate', { angle: a }) || 'grab';
    };

    const selRotationDeg = () => window.getSelectionRotation?.() || 0;
    const selRotateCursorAngle = (key) => (SEL_ROTATE_BASE_DEG[key] || 0) + selRotationDeg();
    const selSetRotateCursor = (key) => {
        const cursor = selRotateCursor(selRotateCursorAngles[key] != null ? selRotateCursorAngles[key] : selRotateCursorAngle(key));
        document.body.style.setProperty('--sel-rotate-cursor', cursor);
        return cursor;
    };

    const selMid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
    const selVec = (from, to) => ({ x: to.x - from.x, y: to.y - from.y });
    const selLen = (v) => Math.hypot(v.x, v.y);
    const selNorm = (v) => {
        const d = selLen(v);
        return d > 1e-6 ? { x: v.x / d, y: v.y / d } : null;
    };

    const selBoxFromMatrix = (shape, matrix) => {
        let bb;
        try { bb = shape.getBBox(); } catch (_) { return null; }
        const tl = matrix.transformPoint(new DOMPoint(bb.x, bb.y));
        const tr = matrix.transformPoint(new DOMPoint(bb.x + bb.width, bb.y));
        const bl = matrix.transformPoint(new DOMPoint(bb.x, bb.y + bb.height));
        const br = matrix.transformPoint(new DOMPoint(bb.x + bb.width, bb.y + bb.height));
        return { tl, tr, br, bl, center: { x: (tl.x + br.x) / 2, y: (tl.y + br.y) / 2 } };
    };

    const selHandlePoints = (box) => ({
        nw: box.tl, n: selMid(box.tl, box.tr), ne: box.tr,
        w: selMid(box.tl, box.bl), e: selMid(box.tr, box.br),
        sw: box.bl, s: selMid(box.bl, box.br), se: box.br
    });

    const selBasisFromBox = (box) => {
        const vx = selVec(box.tl, box.tr), vy = selVec(box.tl, box.bl);
        const w = selLen(vx), h = selLen(vy);
        if (w <= 1e-6 || h <= 1e-6) return null;
        const basis = new DOMMatrix([vx.x / w, vx.y / w, vy.x / h, vy.y / h, 0, 0]);
        const basisInv = basis.inverse();
        if (![basisInv.a, basisInv.b, basisInv.c, basisInv.d].every(Number.isFinite)) return null;
        return { basis, basisInv };
    };

    const selBasisCoord = (basisInv, anchor, p) =>
        basisInv.transformPoint(new DOMPoint(p.x - anchor.x, p.y - anchor.y));

    // Oriented union box of the whole multi-selection, in viewBox-root coords: member bbox corners
    // are accumulated in the group's rotated frame (the persisted group angle), so the box follows
    // rotate gestures Illustrator-style and post-rotate scaling works along the rotated axes.
    const selGroupQuadRoot = () => {
        const svg = selPreviewSvg();
        if (!svg || !selSelection.size) return null;
        const R = new DOMMatrix().rotate(selRotationDeg());
        const Rinv = R.inverse();
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        let any = false;
        selSelection.forEach(idx => {
            const shape = selFindShapeByIndex(idx);
            if (!shape) return;
            let bb;
            try { bb = shape.getBBox(); } catch (_) { return; }
            const anc = cumulativeAncestorMatrix(shape, svg);
            const own = shape.getAttribute('transform');
            const F = Rinv.multiply(own ? anc.multiply(svgTransformToMatrix(own)) : anc);   // local -> rotated frame
            [[bb.x, bb.y], [bb.x + bb.width, bb.y], [bb.x + bb.width, bb.y + bb.height], [bb.x, bb.y + bb.height]]
                .forEach(([x, y]) => {
                    const p = F.transformPoint(new DOMPoint(x, y));
                    if (p.x < minX) minX = p.x;
                    if (p.y < minY) minY = p.y;
                    if (p.x > maxX) maxX = p.x;
                    if (p.y > maxY) maxY = p.y;
                });
            any = true;
        });
        if (!any) return null;
        const c = (x, y) => { const p = R.transformPoint(new DOMPoint(x, y)); return { x: p.x, y: p.y }; };
        const tl = c(minX, minY), tr = c(maxX, minY), br = c(maxX, maxY), bl = c(minX, maxY);
        return { tl, tr, br, bl, center: { x: (tl.x + br.x) / 2, y: (tl.y + br.y) / 2 } };
    };

    const selQuadToScreen = (quad, screenMatrix) => {
        const m = (p) => { const q = screenMatrix.transformPoint(new DOMPoint(p.x, p.y)); return { x: q.x, y: q.y }; };
        const tl = m(quad.tl), tr = m(quad.tr), br = m(quad.br), bl = m(quad.bl);
        return { tl, tr, br, bl, center: { x: (tl.x + br.x) / 2, y: (tl.y + br.y) / 2 } };
    };

    // Projection matrix: viewBox-root coords -> #selectionOverlay screen px (and size the overlay).
    const selScreenMatrix = () => {
        const svg = selPreviewSvg();
        if (!svg || !selectionOverlay) return null;

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

        selectionOverlay.setAttribute('viewBox', `0 0 ${areaW} ${areaH}`);
        selectionOverlay.setAttribute('width', areaW);
        selectionOverlay.setAttribute('height', areaH);

        return new DOMMatrix()
            .translate(svgRect.left - areaRect.left - areaBorderL, svgRect.top - areaRect.top - areaBorderT)
            .scale(svgRect.width / vbW, svgRect.height / vbH)
            .translate(-vbX, -vbY);
    };

    // shape-local -> overlay screen px (full transform for the given shape).
    const selFullMatrix = (shape, svg, screenMatrix) => {
        const anc = cumulativeAncestorMatrix(shape, svg);
        const own = shape.getAttribute('transform');
        const localToSvg = own ? anc.multiply(svgTransformToMatrix(own)) : anc;
        return screenMatrix.multiply(localToSvg);
    };

    // Green path outline (cloned shape, paint/ids stripped, transform baked, non-scaling stroke).
    const selDrawOutline = (shape, svg, screenMatrix, id) => {
        if (isRasterLayerShape(shape)) {
            const full = selFullMatrix(shape, svg, screenMatrix);
            const orientedBox = selBoxFromMatrix(shape, full);
            if (!orientedBox) return;
            const box = document.createElementNS(SVGNS, 'polygon');
            if (id) box.setAttribute('id', id);
            box.setAttribute('points', `${orientedBox.tl.x},${orientedBox.tl.y} ${orientedBox.tr.x},${orientedBox.tr.y} ${orientedBox.br.x},${orientedBox.br.y} ${orientedBox.bl.x},${orientedBox.bl.y}`);
            box.setAttribute('fill', 'none');
            box.setAttribute('stroke', SEL_BLUE);
            box.setAttribute('stroke-width', SEL_W);
            box.setAttribute('pointer-events', 'none');
            selectionOverlay.appendChild(box);
            return;
        }

        const outline = shape.cloneNode(false);
        if (id) outline.setAttribute('id', id);
        ['data-pf-index', 'data-pf-default-fill', 'class', 'style', 'clip-path', 'mask', 'filter',
         'opacity', 'fill-opacity', 'stroke-opacity', 'stroke-dasharray'].forEach(a => outline.removeAttribute(a));

        const full = selFullMatrix(shape, svg, screenMatrix);
        if (full.isIdentity) outline.removeAttribute('transform');
        else outline.setAttribute('transform', matrixToString(full));

        outline.setAttribute('fill', 'none');
        outline.setAttribute('stroke', SEL_GREEN);
        outline.setAttribute('stroke-width', SEL_W);
        outline.setAttribute('vector-effect', 'non-scaling-stroke');
        outline.setAttribute('stroke-linecap', 'round');
        outline.setAttribute('stroke-linejoin', 'round');
        outline.setAttribute('pointer-events', 'none');
        selectionOverlay.appendChild(outline);
    };

    // Full selection chrome: green outline + oriented bbox polygon + 8 handles. The box and
    // handles are drawn directly in overlay px (no baked scale), so a plain SEL_W stroke is one
    // screen px; handles are appended last so they sit on top and stay hit-testable.
    const selDrawChrome = (shape, svg, screenMatrix) => {
        const chromeColor = isRasterLayerShape(shape) ? SEL_BLUE : SEL_GREEN;

        if (!isRasterLayerShape(shape)) selDrawOutline(shape, svg, screenMatrix, null);

        const full = selFullMatrix(shape, svg, screenMatrix);
        const orientedBox = selBoxFromMatrix(shape, full);
        if (!orientedBox) return;

        selDrawBoxAndHandles(orientedBox, chromeColor);
    };

    // Multi-selection chrome: each member's outline plus ONE group box (with the usual handles
    // and rotate zones) around the whole selection, in the group's persisted rotated frame.
    const selDrawGroupChrome = (svg, screenMatrix) => {
        selSelection.forEach(idx => {
            const shape = selFindShapeByIndex(idx);
            if (shape) selDrawOutline(shape, svg, screenMatrix, null);
        });
        const quad = selGroupQuadRoot();
        if (!quad) return;
        selDrawBoxAndHandles(selQuadToScreen(quad, screenMatrix), SEL_GREEN);
    };

    // Box + rotate zones + 8 handles for any oriented quad (single shape or group), in overlay px.
    const selDrawBoxAndHandles = (orientedBox, chromeColor) => {
        const box = document.createElementNS(SVGNS, 'polygon');
        box.setAttribute('points', `${orientedBox.tl.x},${orientedBox.tl.y} ${orientedBox.tr.x},${orientedBox.tr.y} ${orientedBox.br.x},${orientedBox.br.y} ${orientedBox.bl.x},${orientedBox.bl.y}`);
        box.setAttribute('fill', 'none');
        box.setAttribute('stroke', chromeColor);
        box.setAttribute('stroke-width', SEL_W);
        box.setAttribute('pointer-events', 'none');
        selectionOverlay.appendChild(box);

        // While a handle is being dragged (resize), all 8 handle squares hide for precision/visibility;
        // only the box + path outline track live. They snap back on release.
        if (selDrag && selDrag.mode === 'scale') return;

        const hp = selHandlePoints(orientedBox);
        const handles = [
            ['nw', hp.nw.x, hp.nw.y, 'sel-handle-nwse'], ['n', hp.n.x, hp.n.y, 'sel-handle-ns'], ['ne', hp.ne.x, hp.ne.y, 'sel-handle-nesw'],
            ['w',  hp.w.x,  hp.w.y,  'sel-handle-ew'],                                  ['e', hp.e.x, hp.e.y, 'sel-handle-ew'],
            ['sw', hp.sw.x, hp.sw.y, 'sel-handle-nesw'], ['s', hp.s.x, hp.s.y, 'sel-handle-ns'], ['se', hp.se.x, hp.se.y, 'sel-handle-nwse']
        ];
        const half = SEL_HANDLE_PX / 2;
        const zoneHalf = SEL_ROTATE_ZONE_PX / 2;
        selRotateCursorAngles = {};
        handles.forEach(([key, cx, cy]) => {
            const out = selNorm(selVec(orientedBox.center, { x: cx, y: cy })) || { x: 0, y: -1 };
            const ux = out.x, uy = out.y;
            const zcx = cx + ux * (SEL_HANDLE_PX / 2 + SEL_ROTATE_ZONE_GAP + zoneHalf);
            const zcy = cy + uy * (SEL_HANDLE_PX / 2 + SEL_ROTATE_ZONE_GAP + zoneHalf);
            const cursorAngle = Math.atan2(uy, ux) * 180 / Math.PI + 90;
            selRotateCursorAngles[key] = cursorAngle;
            const z = document.createElementNS(SVGNS, 'rect');
            z.setAttribute('x', zcx - zoneHalf);
            z.setAttribute('y', zcy - zoneHalf);
            z.setAttribute('width', SEL_ROTATE_ZONE_PX);
            z.setAttribute('height', SEL_ROTATE_ZONE_PX);
            z.setAttribute('fill', 'transparent');
            z.setAttribute('pointer-events', 'all');
            z.setAttribute('class', 'sel-rotate-zone');
            z.setAttribute('data-h', key);
            z.style.cursor = selRotateCursor(cursorAngle);
            selectionOverlay.appendChild(z);
        });
        handles.forEach(([key, cx, cy, cursorClass]) => {
            const h = document.createElementNS(SVGNS, 'rect');
            h.setAttribute('x', cx - half);
            h.setAttribute('y', cy - half);
            h.setAttribute('width', SEL_HANDLE_PX);
            h.setAttribute('height', SEL_HANDLE_PX);
            h.setAttribute('fill', '#ffffff');
            h.setAttribute('stroke', chromeColor);
            h.setAttribute('stroke-width', SEL_W);
            h.setAttribute('class', 'sel-handle ' + cursorClass);
            h.setAttribute('data-h', key);
            selectionOverlay.appendChild(h);
        });
    };

    const redrawSelectionOverlay = () => {
        if (!selChromeVisible() || !selectionOverlay) { hideSelectionOverlay(); return; }

        // While moving, the entire green UI (box, outline, handles) is hidden until release.
        if (selDrag && selDrag.mode === 'move') { hideSelectionOverlay(); return; }

        const screenMatrix = selScreenMatrix();
        selectionOverlay.replaceChildren();
        if (!screenMatrix) { selectionOverlay.toggleAttribute('hidden', true); return; }

        const svg = selPreviewSvg();

        if (selSelection.size) {
            // Drop members whose preview shape vanished (hidden/deleted), then resync the mirrors
            // directly (not via the mutators -- they redraw, and we're already inside a redraw).
            let pruned = false;
            selSelection.forEach(idx => { if (!selFindShapeByIndex(idx)) { selSelection.delete(idx); pruned = true; } });
            if (pruned) {
                window.setEditSelectionSet?.([...selSelection]);
                window.setLayerSelectionSet?.([...selSelection]);
            }
            if (selSelection.size > 1) {
                selDrawGroupChrome(svg, screenMatrix);
            } else if (selSelection.size === 1) {
                const sel = selFindShapeByIndex([...selSelection][0]);
                if (sel) selDrawChrome(sel, svg, screenMatrix);
            }
        }

        // No hover preview while a gesture (transform or marquee) is in progress.
        if (!selDrag && !selMarquee && selHoverIndex != null && !selSelection.has(selHoverIndex)) {
            const hover = selFindShapeByIndex(selHoverIndex);
            if (hover) selDrawOutline(hover, svg, screenMatrix, SEL_HOVER_ID);
            else selHoverIndex = null;
        }

        if (selMarquee && selMarquee.moved) selDrawMarquee(screenMatrix);

        selectionOverlay.toggleAttribute('hidden', !selectionOverlay.children.length);
    };

    const queueSelectionOverlaySync = () => {
        if (selSyncRaf) return;
        selSyncRaf = requestAnimationFrame(() => {
            selSyncRaf = 0;
            redrawSelectionOverlay();
        });
    };

    // Keep the chrome registered with the live svg through zoom/pan/resize. animate=true tracks
    // the view transition for its duration.
    window.syncSelectionOverlay = (animate = false) => {
        if (window.isGuideDragActive?.()) { hideSelectionOverlay(); return; }
        if (!selChromeVisible() || (selHoverIndex == null && !selSelection.size && !selMarquee)) {
            if (selectionOverlay && (!selectionOverlay.hasAttribute('hidden') || selectionOverlay.children.length)) hideSelectionOverlay();
            return;
        }

        if (animate) {
            selAnimUntil = performance.now() + VIEW_TRANSITION_MS + SEL_ANIM_PAD_MS;
            const tick = () => {
                redrawSelectionOverlay();
                if (performance.now() < selAnimUntil) selAnimRaf = requestAnimationFrame(tick);
                else selAnimRaf = 0;
            };
            if (!selAnimRaf) selAnimRaf = requestAnimationFrame(tick);
            return;
        }

        queueSelectionOverlaySync();
    };

    // renderOutput() rebuilds the preview svg on every edit -> re-apply chrome onto the fresh svg
    // (and drop the selection if its shape no longer exists, e.g. it was fully hidden / pruned).
    window.refreshSelectionOverlay = () => {
        if (window.isGuideDragActive?.()) { hideSelectionOverlay(); return; }
        if (!selChromeVisible()) { hideSelectionOverlay(); return; }
        if (!selActive) {
            selSyncFromSharedSelection();
            selHoverIndex = null;
        }
        redrawSelectionOverlay();
    };

    // Clear the selection/hover lock without turning the tool off -- used on a fresh import/reset
    // so a still-active tool doesn't outline an unrelated shape that reused the same index.
    window.clearSelectionToolLock = () => {
        if (selMarquee) selTeardownMarquee();
        selSelection.clear();
        selHoverIndex = null;
        hideSelectionOverlay();
    };

    // Adopt an externally-created selection (e.g. a Pathfinder result) as the canvas selection,
    // mirroring it into the shared edit/panel selections and redrawing the chrome. Call AFTER the
    // commit render, so the new shape exists in the preview (the redraw prunes missing members).
    // This remains live while another tool is active so tool-created/replaced artwork immediately
    // becomes the persistent canvas selection.
    window.adoptCanvasSelection = (indices) => {
        selSelection.clear();
        (indices || []).forEach(idx => { if (idx != null && !lockedLayers.has(String(idx)) && selFindShapeByIndex(String(idx))) selSelection.add(String(idx)); });
        selHoverIndex = null;
        window.setEditSelectionSet?.([...selSelection]);
        window.setLayerSelectionSet?.([...selSelection]);
        redrawSelectionOverlay();
    };

    const selDeactivate = () => {
        selCommitNudge();                // flush an uncommitted nudge burst before the tool leaves
        if (selMarquee) selTeardownMarquee();
        if (selDrag) { selTeardownDrag(); selDrag = null; }
        selActive = false;
        const btn = $('btnSelectionTool');
        if (btn) btn.classList.remove('active');
        previewArea.classList.remove('sel-active');
        hideSelectionOverlay();
        selHoverIndex = null;
        // Keep the local set: it is the transform-box mirror of the shared object selection and
        // is reused by compatible tools until the user explicitly deselects or replaces it.
    };

    // Called by other tools to enforce a single active canvas tool.
    window.deactivateSelectionTool = () => { if (selActive) selDeactivate(); };
    window.isSelectionToolActive = () => selActive;

    // Toolbar button handler. Activating turns other canvas tools off (one active tool at a time).
    window.toggleSelectionTool = (btn) => {
        if (selActive) return;
        window.deactivateDirectSelectionTool?.();
        window.deactivateHandTool?.();
        window.deactivateArtboardTool?.();
        window.deactivateShapeTool?.();
        window.deactivatePenTool?.();
        window.deactivateScissorsTool?.();
        selActive = true;
        (btn || $('btnSelectionTool'))?.classList.add('active');
        previewArea.classList.add('sel-active');
        // Adopt the shared canvas selection (e.g. left by the Direct Selection tool) so the
        // current object(s) stay selected across a tool switch (Illustrator-style). Membership is
        // unchanged, so the persisted group angle survives (setEditSelectionSet early-outs).
        selSelection.clear();
        if (editSelectedIndices.size) {
            const adopt = [...editSelectedIndices].filter(idx => !lockedLayers.has(String(idx)) && selFindShapeByIndex(idx));
            if (adopt.length) {
                adopt.forEach(idx => selSelection.add(idx));
                if (adopt.length !== editSelectedIndices.size) {
                    window.setEditSelectionSet?.(adopt);
                    window.setLayerSelectionSet?.(adopt);
                }
                redrawSelectionOverlay();
            }
        }
    };

    // --- Transform gestures: move (drag the shape) / scale (drag a handle) / rotate (outside handles) ----
    // All gesture math is in artboard (viewBox) user units -- the same space getSelectionGeom uses --
    // and is folded into the shape's own transform by the shared engine in properties.js
    // (window.applySelectionRootMatrix), so the canvas and the Properties panel never disagree.

    // Body cursor-lock class per handle key (the pointer is captured during a scale, so the cursor
    // must be forced on <body> rather than left to the handle element).
    const SEL_CURSOR_CLASS = { nw: 'sel-cur-nwse', se: 'sel-cur-nwse', ne: 'sel-cur-nesw', sw: 'sel-cur-nesw', n: 'sel-cur-ns', s: 'sel-cur-ns', w: 'sel-cur-ew', e: 'sel-cur-ew' };
    const SEL_ROTATE_CURSOR_CLASS = 'sel-cur-rotate';

    // Pointer position -> artboard (viewBox) user units, from the live preview svg's on-screen rect +
    // viewBox. Stable during a drag: changing a shape's transform doesn't move the svg element's box.
    const selPointerRoot = (clientX, clientY) => {
        const svg = selPreviewSvg();
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

    // Keep the shared transform engine pointed at our canvas selection, so the Properties panel
    // reflects only what's picked on the canvas with the Selection tool. setEditSelectionSet
    // early-outs on identical membership, so this is free at gesture start.
    const selSyncSelection = () => {
        if (selSelection.size) window.setEditSelectionSet?.([...selSelection]);
    };

    // Per-member gesture snapshots (transform, plus geometry for scale drags) for Esc-cancel.
    const selSnapshotMembers = (withGeom) =>
        [...selSelection].map(idx => {
            const globalShape = globalOptimizedSvg ? globalOptimizedSvg.querySelector(`[data-pf-index="${idx}"]`) : null;
            return {
                idx,
                startTransform: globalShape ? globalShape.getAttribute('transform') : null,
                geomSnapshot: (withGeom && globalShape) ? window.snapshotShapeGeometry?.(globalShape) : null
            };
        });

    const selStartCapture = (e) => {
        try { previewArea.setPointerCapture(e.pointerId); } catch (_) {}
        previewArea.addEventListener('pointermove', selOnDragMove);
        previewArea.addEventListener('pointerup', selOnDragEnd);
        previewArea.addEventListener('pointercancel', selOnDragEnd);
    };

    const selTeardownDrag = () => {
        if (selDragRaf) { cancelAnimationFrame(selDragRaf); selDragRaf = 0; }
        selDragPending = null;
        if (selDrag) {
            try { previewArea.releasePointerCapture(selDrag.pointerId); } catch (_) {}
            if (selDrag.cursorClass) document.body.classList.remove(selDrag.cursorClass);
            if (selDrag.cursorClass === SEL_ROTATE_CURSOR_CLASS) document.body.style.removeProperty('--sel-rotate-cursor');
        }
        previewArea.removeEventListener('pointermove', selOnDragMove);
        previewArea.removeEventListener('pointerup', selOnDragEnd);
        previewArea.removeEventListener('pointercancel', selOnDragEnd);
        window.endSnapGesture?.();
    };

    // Axis-aligned key points of the selection's root-space bounds (corners, edge mids, center)
    // handed to the snap engine during a move drag (docs/snapping.md).
    const selSnapKeyPoints = () => {
        let quad = null;
        if (selSelection.size > 1) {
            quad = selGroupQuadRoot();
        } else {
            const g = window.getSelectionGeom ? window.getSelectionGeom() : null;
            if (g && g.previewShape) quad = selBoxFromMatrix(g.previewShape, g.P.multiply(g.own));
        }
        if (!quad) return null;
        const minX = Math.min(quad.tl.x, quad.tr.x, quad.br.x, quad.bl.x);
        const maxX = Math.max(quad.tl.x, quad.tr.x, quad.br.x, quad.bl.x);
        const minY = Math.min(quad.tl.y, quad.tr.y, quad.br.y, quad.bl.y);
        const maxY = Math.max(quad.tl.y, quad.tr.y, quad.br.y, quad.bl.y);
        const midX = (minX + maxX) / 2, midY = (minY + maxY) / 2;
        return [
            { x: minX, y: minY }, { x: midX, y: minY }, { x: maxX, y: minY },
            { x: minX, y: midY }, { x: midX, y: midY }, { x: maxX, y: midY },
            { x: minX, y: maxY }, { x: midX, y: maxY }, { x: maxX, y: maxY }
        ];
    };

    const selPointAngle = (p, cx, cy) => Math.atan2(p.y - cy, p.x - cx) * 180 / Math.PI;

    const selAngleDelta = (next, prev) => {
        let d = next - prev;
        while (d > 180) d -= 360;
        while (d < -180) d += 360;
        return d;
    };

    const selApplyDragFrame = () => {
        selDragRaf = 0;
        if (!selDrag || !selDrag.moved || !selDragPending) return;
        const root = selPointerRoot(selDragPending.x, selDragPending.y);
        if (!root) return;

        if (selDrag.mode === 'move') {
            // Total-delta based: the raw pointer travel from the gesture start is snapped as a
            // whole, then only the not-yet-applied part is folded in -- so the snapped landing
            // position is exact (no incremental drift) and releasing the snap springs back.
            let dx = root.x - selDrag.startX, dy = root.y - selDrag.startY;
            if (selDrag.shift) {
                // Shift constrains the move to the nearest 45-degree direction (constraint wins
                // over snapping, Illustrator-style); releasing Shift springs back to the pointer.
                const c = constrainVec45(dx, dy);
                dx = c.x; dy = c.y;
            } else if (selDrag.snapPoints) {
                const snapped = window.snapRootDelta?.(selDrag.snapPoints, dx, dy);
                if (snapped) { dx = snapped.dx; dy = snapped.dy; }
            }
            const incX = dx - selDrag.appliedX, incY = dy - selDrag.appliedY;
            if (incX === 0 && incY === 0) return;
            if (window.applySelectionRootMatrix(new DOMMatrix().translate(incX, incY), true)) {
                selDrag.appliedX = dx; selDrag.appliedY = dy;
                window.refreshElementProperties?.();
            }
            return;
        }

        if (selDrag.mode === 'rotate') {
            // Raw rotation accumulates continuously; with Shift the rotation stays smooth but
            // STICKS to the nearest 45-degree detent while the pointer angle is within the
            // stick tolerance (releasing Shift springs back to the raw pointer angle).
            const nextAngle = selPointAngle(root, selDrag.cx, selDrag.cy);
            selDrag.rawRot += selAngleDelta(nextAngle, selDrag.lastAngle);
            selDrag.lastAngle = nextAngle;
            let desired = selDrag.rawRot;
            if (selDrag.shift) {
                const nearest = Math.round(selDrag.rawRot / 45) * 45;
                if (Math.abs(selDrag.rawRot - nearest) <= SEL_ROTATE_STICK_DEG) desired = nearest;
            }
            const delta = desired - selDrag.appliedRot;
            if (Math.abs(delta) < 1e-6) return;
            const M = new DOMMatrix().translate(selDrag.cx, selDrag.cy).rotate(delta).translate(-selDrag.cx, -selDrag.cy);
            if (window.applySelectionRootMatrix(M, true)) {
                selDrag.appliedRot = desired;
                window.addSelectionRotationDelta?.(delta);
                selSetRotateCursor(selDrag.handleKey);
                window.refreshElementProperties?.();
            }
            return;
        }

        // scale: target = pointer + grab offset, kept under the cursor. Scaling happens in the
        // selected shape's oriented-bbox basis, so the handles keep Illustrator-style direction
        // after rotation. Crossing the anchor flips the sign (mirror). Shift constrains the scale
        // to the original proportions; Alt (handled by selRebaselineScale) scales from the center.
        let tx = root.x + selDrag.offX, ty = root.y + selDrag.offY;
        if (selDrag.snapAxes) {
            const sp = window.snapRootPoint?.({ x: tx, y: ty }, { axes: selDrag.snapAxes });
            if (sp) { tx = sp.x; ty = sp.y; }
        }
        const coord = selBasisCoord(selDrag.basisInv, { x: selDrag.ax, y: selDrag.ay }, { x: tx, y: ty });
        const clampCoord = (v) => Math.abs(v) < 1e-4 ? (v < 0 ? -1e-4 : 1e-4) : v;
        let sx = 1, sy = 1;
        let nextX = null, nextY = null, nextPassive = null;
        if (selDrag.scaleX && selDrag.scaleY) {
            if (Math.abs(selDrag.lastCoordX) < 1e-6 || Math.abs(selDrag.lastCoordY) < 1e-6) return;
            nextX = clampCoord(coord.x);
            nextY = clampCoord(coord.y);
            if (selDrag.shift && Math.abs(selDrag.startCoordX) > 1e-6 && Math.abs(selDrag.startCoordY) > 1e-6) {
                // Proportional: the dominant axis' total factor drives both axes; per-axis signs
                // are preserved so mirror-on-crossing still works. Totals are measured from the
                // gesture baseline, so releasing Shift springs back to the free pointer scale.
                const tX = nextX / selDrag.startCoordX, tY = nextY / selDrag.startCoordY;
                const m = Math.max(Math.abs(tX), Math.abs(tY)) || 1e-4;
                nextX = clampCoord(selDrag.startCoordX * m * (tX < 0 ? -1 : 1));
                nextY = clampCoord(selDrag.startCoordY * m * (tY < 0 ? -1 : 1));
            }
            sx = nextX / selDrag.lastCoordX;
            sy = nextY / selDrag.lastCoordY;
        } else if (selDrag.scaleX) {
            if (Math.abs(selDrag.lastCoordX) < 1e-6) return;
            nextX = clampCoord(coord.x);
            sx = nextX / selDrag.lastCoordX;
            // Shift on an edge handle scales the passive axis by the same total factor
            // (proportional, never mirrored); releasing Shift springs the passive axis back.
            nextPassive = (selDrag.shift && Math.abs(selDrag.startCoordX) > 1e-6) ? Math.abs(nextX / selDrag.startCoordX) : 1;
            sy = nextPassive / (selDrag.passiveTotal || 1);
        } else if (selDrag.scaleY) {
            if (Math.abs(selDrag.lastCoordY) < 1e-6) return;
            nextY = clampCoord(coord.y);
            sy = nextY / selDrag.lastCoordY;
            nextPassive = (selDrag.shift && Math.abs(selDrag.startCoordY) > 1e-6) ? Math.abs(nextY / selDrag.startCoordY) : 1;
            sx = nextPassive / (selDrag.passiveTotal || 1);
        }
        if (!Number.isFinite(sx) || !Number.isFinite(sy)) return;

        const M = new DOMMatrix()
            .translate(selDrag.ax, selDrag.ay)
            .multiply(selDrag.basis)
            .scale(sx, sy)
            .multiply(selDrag.basisInv)
            .translate(-selDrag.ax, -selDrag.ay);
        if (window.applyScaleGesture(M, true)) {        // bake into geometry -> stroke stays uniform
            if (nextX != null) selDrag.lastCoordX = nextX;
            if (nextY != null) selDrag.lastCoordY = nextY;
            if (nextPassive != null) selDrag.passiveTotal = nextPassive;
            window.refreshElementProperties?.();
        }
    };

    // Re-anchor an in-progress scale drag when Alt toggles (opposite handle <-> box center):
    // recompute the CURRENT box, re-derive the anchor + baseline coords from it, and restart the
    // proportional baseline from the shape's current state so the incremental math stays exact.
    const selRebaselineScale = () => {
        const d = selDrag;
        if (!d || d.mode !== 'scale') return;
        let box;
        if (selSelection.size > 1) {
            box = selGroupQuadRoot();
        } else {
            const g = window.getSelectionGeom ? window.getSelectionGeom() : null;
            if (g && g.previewShape) box = selBoxFromMatrix(g.previewShape, g.P.multiply(g.own));
        }
        if (!box) return;
        const hp = selHandlePoints(box);
        const dragPoint = hp[d.handleKey];
        const anchor = d.alt ? box.center : hp[SEL_OPPOSITE_HANDLE[d.handleKey]];
        if (!dragPoint || !anchor) return;
        const sc = selBasisCoord(d.basisInv, anchor, dragPoint);
        if (Math.abs(sc.x) < 1e-6 && Math.abs(sc.y) < 1e-6) return;
        d.ax = anchor.x; d.ay = anchor.y;
        d.lastCoordX = sc.x; d.lastCoordY = sc.y;
        d.startCoordX = sc.x; d.startCoordY = sc.y;
        d.passiveTotal = 1;
        if (selDragPending) {
            const r = selPointerRoot(selDragPending.x, selDragPending.y);
            if (r) { d.offX = dragPoint.x - r.x; d.offY = dragPoint.y - r.y; }
        }
    };

    // Alt during a move drag duplicates the selection (Illustrator-style): the clones take over
    // the drag while the originals return to their pre-drag transforms and stay put. Works at the
    // drag threshold (Alt held before dragging) or mid-drag (Alt pressed while moving); latched
    // for the rest of the gesture. The clone insert is deferred-commit, so the release's single
    // renderOutput(false) records the duplicate + move as ONE history entry.
    const selDuplicateForMove = () => {
        const d = selDrag;
        if (!d || d.mode !== 'move' || d.duplicated || !selSelection.size || !globalOptimizedSvg || !window.duplicateSelectedLayer) return;
        const prior = [...selSelection];
        const newIdx = window.duplicateSelectedLayer(true);
        if (!newIdx || !newIdx.length) return;
        // Clones carry the current (possibly already-moved) transforms; the originals go back.
        (d.snapshots || []).forEach(s => {
            const orig = globalOptimizedSvg.querySelector(`[data-pf-index="${s.idx}"]`);
            if (!orig) return;
            if (s.startTransform != null) orig.setAttribute('transform', s.startTransform);
            else orig.removeAttribute('transform');
        });
        d.duplicated = true;
        d.preDup = prior;
        selSetSelection(newIdx.map(String));
        d.snapshots = selSnapshotMembers(false);
        renderOutput(true);                     // clones into the preview before the next frame
    };

    // Live modifier state for the active gesture (Shift = constrain/proportional, Alt = center
    // scale / duplicate). Fed from every pointer event AND from keydown/keyup so pressing or
    // releasing a modifier without moving the pointer takes effect immediately.
    const selSetDragModifiers = (shift, alt) => {
        const d = selDrag;
        if (!d) return;
        d.shift = shift;
        if (alt !== d.alt) {
            d.alt = alt;
            if (d.moved) {
                if (d.mode === 'scale') selRebaselineScale();
                else if (d.mode === 'move' && alt) selDuplicateForMove();
            }
        }
        if (d.moved && selDragPending && !selDragRaf) selDragRaf = requestAnimationFrame(selApplyDragFrame);
    };

    const selOnDragMove = (e) => {
        if (!selDrag || e.pointerId !== selDrag.pointerId) return;
        selSetDragModifiers(e.shiftKey, e.altKey);
        if (!selDrag.moved) {
            if (Math.abs(e.clientX - selDrag.downX) < SEL_DRAG_THRESHOLD && Math.abs(e.clientY - selDrag.downY) < SEL_DRAG_THRESHOLD) return;
            selDrag.moved = true;
            if (selDrag.cursorClass) document.body.classList.add(selDrag.cursorClass);
            if (selDrag.mode === 'move') {                  // rebaseline so the first delta starts from here (no jump)
                if (selDrag.alt) selDuplicateForMove();     // duplicate first: the clones drive the drag + snap
                const r = selPointerRoot(e.clientX, e.clientY);
                if (r) { selDrag.startX = r.x; selDrag.startY = r.y; }
                selDrag.appliedX = 0; selDrag.appliedY = 0;
                selDrag.snapPoints = selSnapKeyPoints();
                window.beginSnapGesture?.({ exclude: [...selSelection] });
            } else if (selDrag.mode === 'scale') {
                window.beginSnapGesture?.({ exclude: [...selSelection] });
            } else if (selDrag.mode === 'rotate') {
                const r = selPointerRoot(e.clientX, e.clientY);
                if (r) selDrag.lastAngle = selPointAngle(r, selDrag.cx, selDrag.cy);
                selSetRotateCursor(selDrag.handleKey);
            }
            redrawSelectionOverlay();                       // hide chrome (move) / drop handles (scale) immediately
        }
        selDragPending = { x: e.clientX, y: e.clientY };
        if (!selDragRaf) selDragRaf = requestAnimationFrame(selApplyDragFrame);
    };

    const selOnDragEnd = (e) => {
        if (!selDrag || (e && e.pointerId !== selDrag.pointerId)) return;
        const moved = selDrag.moved;
        const mode = selDrag.mode;
        const collapseTo = selDrag.collapseTo;
        const duplicated = selDrag.duplicated;
        selTeardownDrag();
        selDrag = null;
        if (moved) {
            if (duplicated) window.setHistoryLabel?.('Duplicate', 'layers-duplicate');   // clone + move = one entry
            else window.setHistoryLabel?.(mode === 'rotate' ? 'Rotate' : mode === 'scale' ? 'Scale' : 'Move', mode === 'rotate' ? 'angle' : 'selection-tool');
            renderOutput(false);   // commit: flush export; tail restores full chrome + refreshes fields
        }
        // Plain click (no drag) on a member of a multi-selection collapses to just that object (AI-style).
        else if (collapseTo != null) selSetSelection([collapseTo], collapseTo);
        else redrawSelectionOverlay();    // it was a click (selection already handled on pointerdown)
    };

    const selCancelDrag = () => {
        if (!selDrag) return;
        if (selDrag.duplicated) {
            // The originals were already restored when the duplicate happened; dropping the
            // clones returns the document to its last committed state, so the renderOutput(false)
            // below dedupes in history (no entry).
            const preDup = selDrag.preDup || [];
            selSelection.forEach(idx => { globalOptimizedSvg?.querySelector(`[data-pf-index="${idx}"]`)?.remove(); });
            buildLayersPanel();
            selSetSelection(preDup);
            selTeardownDrag();
            selDrag = null;
            renderOutput(false);
            window.updateAllScrollbars?.();
            return;
        }
        (selDrag.snapshots || []).forEach(s => {
            const globalShape = globalOptimizedSvg ? globalOptimizedSvg.querySelector(`[data-pf-index="${s.idx}"]`) : null;
            if (!globalShape) return;
            if (s.startTransform != null) globalShape.setAttribute('transform', s.startTransform);
            else globalShape.removeAttribute('transform');
            // A scale drag bakes into geometry; restore the pristine geometry/stroke snapshot too.
            if (s.geomSnapshot) window.restoreShapeGeometry?.(globalShape, s.geomSnapshot);
        });
        // Rewind the stored angle by delta so the group angle AND each member's stored angle revert.
        if (selDrag.mode === 'rotate' && typeof selDrag.startRotation === 'number') {
            window.addSelectionRotationDelta?.(selDrag.startRotation - (window.getSelectionRotation?.() || 0));
        }
        selTeardownDrag();
        selDrag = null;
        renderOutput(false);              // restore the shape(s) + full chrome
    };

    const selBeginMove = (e, collapseTo) => {
        selSyncSelection();
        const root = selPointerRoot(e.clientX, e.clientY);
        if (!root) return;
        selDrag = {
            mode: 'move', pointerId: e.pointerId, moved: false,
            downX: e.clientX, downY: e.clientY, startX: root.x, startY: root.y,
            appliedX: 0, appliedY: 0, snapPoints: null,
            snapshots: selSnapshotMembers(false),
            collapseTo: collapseTo != null ? collapseTo : null,
            cursorClass: null,
            shift: e.shiftKey, alt: e.altKey, duplicated: false, preDup: null
        };
        selStartCapture(e);
    };

    const selBeginRotate = (key, e) => {
        selSyncSelection();
        let cx, cy;
        if (selSelection.size > 1) {
            const quad = selGroupQuadRoot();
            if (!quad) return;
            cx = quad.center.x; cy = quad.center.y;
        } else {
            const g = window.getSelectionGeom ? window.getSelectionGeom() : null;
            if (!g || !g.previewShape) return;
            cx = g.rootBBox.minX + g.rootBBox.w / 2;
            cy = g.rootBBox.minY + g.rootBBox.h / 2;
        }
        const root = selPointerRoot(e.clientX, e.clientY);
        if (!root) return;
        selSetRotateCursor(key);
        selDrag = {
            mode: 'rotate', pointerId: e.pointerId, moved: false,
            handleKey: key, downX: e.clientX, downY: e.clientY,
            cx, cy, lastAngle: selPointAngle(root, cx, cy),
            rawRot: 0, appliedRot: 0,
            snapshots: selSnapshotMembers(false),
            startRotation: window.getSelectionRotation?.() || 0,
            cursorClass: SEL_ROTATE_CURSOR_CLASS,
            shift: e.shiftKey, alt: e.altKey
        };
        selStartCapture(e);
    };

    const selBeginScale = (key, e) => {
        selSyncSelection();
        let box;
        if (selSelection.size > 1) {
            box = selGroupQuadRoot();
        } else {
            const g = window.getSelectionGeom ? window.getSelectionGeom() : null;
            if (!g || !g.previewShape) return;
            box = selBoxFromMatrix(g.previewShape, g.P.multiply(g.own));
        }
        const spec = SEL_SCALE_AXIS[key];
        const oppKey = SEL_OPPOSITE_HANDLE[key];
        if (!box || !spec || !oppKey) return;
        const basisData = selBasisFromBox(box);
        if (!basisData) return;
        const hp = selHandlePoints(box);
        // Alt scales from the box center instead of the opposite handle (Illustrator-style);
        // toggling Alt mid-drag re-anchors through selRebaselineScale.
        const anchor = e.altKey ? box.center : hp[oppKey], dragPoint = hp[key];
        if (!anchor || !dragPoint) return;
        const startCoord = selBasisCoord(basisData.basisInv, anchor, dragPoint);
        const root = selPointerRoot(e.clientX, e.clientY);
        if (!root) return;
        // Snap the dragged handle point: both axes for corner handles; edge handles only along
        // their own axis, and only while the box is axis-aligned (rotated frames skip snapping).
        const axisAligned = Math.abs(basisData.basis.b) < 1e-4 && Math.abs(basisData.basis.c) < 1e-4;
        const snapAxes = (spec.sx && spec.sy) ? { x: true, y: true }
            : axisAligned ? { x: spec.sx, y: spec.sy } : null;
        selDrag = {
            mode: 'scale', pointerId: e.pointerId, moved: false, handleKey: key,
            downX: e.clientX, downY: e.clientY, snapAxes,
            ax: anchor.x, ay: anchor.y, scaleX: spec.sx, scaleY: spec.sy,
            basis: basisData.basis, basisInv: basisData.basisInv,
            lastCoordX: startCoord.x, lastCoordY: startCoord.y,
            startCoordX: startCoord.x, startCoordY: startCoord.y, passiveTotal: 1,
            offX: dragPoint.x - root.x, offY: dragPoint.y - root.y,   // keep the grabbed point under the cursor
            snapshots: selSnapshotMembers(true),   // scaling bakes geometry -> snapshot for Esc-cancel
            cursorClass: SEL_CURSOR_CLASS[key] || null,
            shift: e.shiftKey, alt: e.altKey
        };
        selStartCapture(e);
    };

    // --- Marquee (rubber-band) selection ------------------------------------------------------
    // A press on empty canvas starts a marquee instead of an immediate deselect. Dragging past the
    // threshold rubber-bands a rectangle (drawn by redrawSelectionOverlay); on release every
    // editable shape whose projected bounding box the rectangle touches is collected, and the set
    // is applied by modifier: plain = replace, Shift = add, Shift+Ctrl = subtract (Illustrator-
    // style). A press that never passes the threshold is a click (plain = deselect all; a modified
    // click keeps the selection). The marquee never snaps.

    const selMarqueeBlockedTarget = (el) =>
        !!(el && el.closest && el.closest('.canvas-statusbar, .canvas-ruler, .ruler-corner'));

    const selTeardownMarquee = () => {
        if (!selMarquee) return;
        try { previewArea.releasePointerCapture(selMarquee.pointerId); } catch (_) {}
        previewArea.removeEventListener('pointermove', selOnMarqueeMove);
        previewArea.removeEventListener('pointerup', selOnMarqueeEnd);
        previewArea.removeEventListener('pointercancel', selOnMarqueeEnd);
        selMarquee = null;
    };

    // Convex-polygon overlap (SAT); touching counts as a hit. rectPts is the axis-aligned marquee,
    // quadPts a shape's (possibly rotated) projected bbox -- both [tl, tr, br, bl] in screen px.
    const selPolyOverlap = (rectPts, quadPts) => {
        for (const poly of [rectPts, quadPts]) {
            for (let i = 0; i < poly.length; i++) {
                const a = poly[i], b = poly[(i + 1) % poly.length];
                const nx = -(b.y - a.y), ny = (b.x - a.x);   // edge normal
                if (nx === 0 && ny === 0) continue;
                let minA = Infinity, maxA = -Infinity, minB = Infinity, maxB = -Infinity;
                for (const p of rectPts) { const d = p.x * nx + p.y * ny; if (d < minA) minA = d; if (d > maxA) maxA = d; }
                for (const p of quadPts) { const d = p.x * nx + p.y * ny; if (d < minB) minB = d; if (d > maxB) maxB = d; }
                if (maxA < minB || maxB < minA) return false;   // separating axis found -> no overlap
            }
        }
        return true;
    };

    // Crisp cool-white hairline over a soft dark casing, projected from the marquee's artboard-space
    // start/current points (so a zoom/pan mid-drag re-projects it correctly).
    const selDrawMarquee = (screenMatrix) => {
        const a = screenMatrix.transformPoint(new DOMPoint(selMarquee.startRoot.x, selMarquee.startRoot.y));
        const b = screenMatrix.transformPoint(new DOMPoint(selMarquee.curRoot.x, selMarquee.curRoot.y));
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
            selectionOverlay.appendChild(r);
        };
        mk(SEL_MARQUEE_CASING, SEL_MARQUEE_CASING_W, false);   // soft dark casing underneath
        mk(SEL_MARQUEE_LINE, SEL_MARQUEE_LINE_W, true);        // crisp cool-white line on top
    };

    // On release: collect every editable shape the rectangle touches, then apply it by modifier.
    const selApplyMarquee = (m) => {
        const svg = selPreviewSvg();
        const screenMatrix = selScreenMatrix();
        if (!svg || !screenMatrix) { redrawSelectionOverlay(); return; }
        const a = screenMatrix.transformPoint(new DOMPoint(m.startRoot.x, m.startRoot.y));
        const b = screenMatrix.transformPoint(new DOMPoint(m.curRoot.x, m.curRoot.y));
        const minX = Math.min(a.x, b.x), maxX = Math.max(a.x, b.x);
        const minY = Math.min(a.y, b.y), maxY = Math.max(a.y, b.y);
        const rectPts = [{ x: minX, y: minY }, { x: maxX, y: minY }, { x: maxX, y: maxY }, { x: minX, y: maxY }];

        const hits = [];
        getEditableLayerShapes(svg).forEach(shape => {
            const idx = shape.getAttribute('data-pf-index');
            if (idx == null) return;
            const box = selBoxFromMatrix(shape, selFullMatrix(shape, svg, screenMatrix));
            if (box && selPolyOverlap(rectPts, [box.tl, box.tr, box.br, box.bl])) hits.push(String(idx));
        });

        let final;
        if (m.subtract) {
            const drop = new Set(hits);
            final = [...selSelection].filter(idx => !drop.has(idx));
        } else if (m.add) {
            final = [...new Set([...selSelection, ...hits])];
        } else {
            final = hits;
        }
        selSetSelection(final);
    };

    const selOnMarqueeMove = (e) => {
        if (!selMarquee || e.pointerId !== selMarquee.pointerId) return;
        if (!selMarquee.moved) {
            if (Math.abs(e.clientX - selMarquee.downX) < SEL_DRAG_THRESHOLD && Math.abs(e.clientY - selMarquee.downY) < SEL_DRAG_THRESHOLD) return;
            selMarquee.moved = true;
            selHoverIndex = null;                    // no hover trace while marqueeing
        }
        const root = selPointerRoot(e.clientX, e.clientY);
        if (root) selMarquee.curRoot = root;
        queueSelectionOverlaySync();
    };

    const selOnMarqueeEnd = (e) => {
        if (!selMarquee || (e && e.pointerId !== selMarquee.pointerId)) return;
        if (e && selMarquee.moved) {
            const root = selPointerRoot(e.clientX, e.clientY);
            if (root) selMarquee.curRoot = root;
        }
        const m = selMarquee;
        selTeardownMarquee();
        if (!m.moved) {
            // Click on empty canvas: plain click deselects; a modified click keeps the selection.
            if (!m.add && !m.subtract) selSetSelection([]);
            else redrawSelectionOverlay();
            return;
        }
        selApplyMarquee(m);
    };

    const selBeginMarquee = (e) => {
        const root = selPointerRoot(e.clientX, e.clientY);
        if (!root) return;
        selMarquee = {
            pointerId: e.pointerId, downX: e.clientX, downY: e.clientY,
            startRoot: root, curRoot: root, moved: false,
            add: e.shiftKey && !e.ctrlKey, subtract: e.shiftKey && e.ctrlKey
        };
        try { previewArea.setPointerCapture(e.pointerId); } catch (_) {}
        previewArea.addEventListener('pointermove', selOnMarqueeMove);
        previewArea.addEventListener('pointerup', selOnMarqueeEnd);
        previewArea.addEventListener('pointercancel', selOnMarqueeEnd);
    };

    // Hover: trace whatever shape sits under the cursor; rebuild only when the shape changes.
    previewArea.addEventListener('pointermove', (e) => {
        if (window.isGuideDragActive?.()) return;
        if (!selActive || selDrag || selMarquee || window.isHandToolTemporaryPan?.()) return;
        const shape = selShapeFromTarget(e.target);
        const idx = shape ? shape.getAttribute('data-pf-index') : null;
        if (idx === selHoverIndex) return;
        selHoverIndex = idx;
        // No hover outline over empty canvas / handles, or over an already-selected shape.
        if (!shape || selSelection.has(idx)) { removeHoverOutline(); return; }
        redrawSelectionOverlay();
    });

    // Press routing: a handle starts a resize, the painted shape starts a move (after selecting it),
    // empty canvas deselects. A 3px threshold (in the drag handlers) separates a click from a drag.
    // Hit-testing is native: a filled shape catches presses anywhere inside or on its path; a
    // stroke-only shape only on its path (SVG visiblePainted) -- exactly the move rule, for free.
    previewArea.addEventListener('pointerdown', (e) => {
        if (window.isGuideDragActive?.()) return;
        const passiveTransform = selPassiveTransformEnabled();
        if ((!selActive && !passiveTransform) || e.button !== 0 || selDrag || selMarquee) return;
        if (window.isHandToolTemporaryPan?.()) return;      // Space / middle-drag pan owns the press

        const rotateEl = (e.target && e.target.closest) ? e.target.closest('.sel-rotate-zone') : null;
        if (rotateEl) {
            if (!selSelection.size) return;
            const key = rotateEl.getAttribute('data-h');
            if (key) {
                e.preventDefault();
                if (passiveTransform) e.stopImmediatePropagation();
                selBeginRotate(key, e);
            }
            return;
        }

        const handleEl = (e.target && e.target.closest) ? e.target.closest('.sel-handle') : null;
        if (handleEl) {
            if (!selSelection.size) return;
            const key = handleEl.getAttribute('data-h');
            if (key) {
                e.preventDefault();
                if (passiveTransform) e.stopImmediatePropagation();
                selBeginScale(key, e);
            }
            return;
        }

        // A Shape tool owns all non-handle presses so the same pointer cannot also select/move.
        if (passiveTransform) return;

        const shape = selShapeFromTarget(e.target);

        if (!shape) {
            // Empty canvas: start a marquee (plain = replace, Shift = add, Shift+Ctrl = subtract).
            // The selection change lands on release; a press with no drag falls back to a click
            // (plain click clears). Never start a marquee from the status bar / rulers.
            if (!selMarqueeBlockedTarget(e.target)) { e.preventDefault(); selBeginMarquee(e); }
            return;
        }

        const idx = shape.getAttribute('data-pf-index');

        // Shift+click toggles membership (Illustrator-style); dragging continues only while selected.
        if (e.shiftKey) {
            e.preventDefault();
            if (selHoverIndex === idx) selHoverIndex = null;
            selToggleSelection(idx);
            if (selSelection.has(idx)) selBeginMove(e);
            return;
        }

        if (!selSelection.has(idx)) {
            if (selHoverIndex === idx) selHoverIndex = null;   // selection chrome already covers it
            selSetSelection([idx], idx);
            e.preventDefault();
            selBeginMove(e);        // armed; only actually moves once the pointer passes the threshold
            return;
        }

        // Already a member: a drag moves the whole group; a plain click (no drag) on a multi
        // member collapses the selection to just that object on release (AI-style).
        e.preventDefault();
        selBeginMove(e, selSelection.size > 1 ? idx : null);
    });

    // --- Arrow-key nudges (1px / Shift 10px / Ctrl+Shift 0.1px, artboard units) --------------
    // Each press applies a deferred translate through the shared engine; the commit (one history
    // entry labeled "Nudge" for the whole burst) lands on arrow keyup or after a short idle, so
    // holding a key repeat-nudges without flooding the undo stack.
    const SEL_ARROW = {
        ArrowLeft: { dx: -1, dy: 0 }, ArrowRight: { dx: 1, dy: 0 },
        ArrowUp: { dx: 0, dy: -1 }, ArrowDown: { dx: 0, dy: 1 }
    };
    const SEL_NUDGE_COMMIT_MS = 500;
    let selNudgeTimer = 0, selNudgePending = false;
    const selCommitNudge = () => {
        if (selNudgeTimer) { clearTimeout(selNudgeTimer); selNudgeTimer = 0; }
        if (!selNudgePending) return;
        selNudgePending = false;
        window.setHistoryLabel?.('Nudge', 'selection-tool');
        renderOutput(false);
    };

    // V selects the Selection tool (Illustrator) -- inert in text fields / eyedropper / no artboard.
    // Escape cancels an in-progress drag (revert to the pre-drag transforms); with a multi
    // selection it clears the selection (tool stays on). Ctrl+A selects every visible
    // object -- skipped while a text field has focus so native select-all survives. Shift/Alt
    // feed the live gesture modifiers; Delete/Backspace delete the selection; arrows nudge.
    document.addEventListener('keydown', (e) => {
        if ((e.key === 'v' || e.key === 'V') && !e.ctrlKey && !e.altKey && !e.metaKey && !e.repeat
            && !selActive && globalOptimizedSvg && !isTextInputFocused() && !isEyedropperMode) {
            e.preventDefault();
            window.toggleSelectionTool();
            return;
        }
        if (!selActive) return;
        if (e.key === 'Escape' && isTextInputFocused()) return;
        if (selDrag && (e.key === 'Shift' || e.key === 'Alt')) {
            if (e.key === 'Alt') e.preventDefault();      // keep the browser menu from grabbing focus
            selSetDragModifiers(e.key === 'Shift' ? true : selDrag.shift, e.key === 'Alt' ? true : selDrag.alt);
            return;
        }
        if (e.key === 'Escape') {
            if (selMarquee) { e.preventDefault(); selTeardownMarquee(); redrawSelectionOverlay(); return; }
            if (selDrag) { e.preventDefault(); selCancelDrag(); return; }
            if (selSelection.size && !isEyedropperMode) { e.preventDefault(); selClearSelection(); }
            return;
        }
        if ((e.key === 'a' || e.key === 'A') && e.ctrlKey && !e.altKey && !e.repeat && !isTextInputFocused()) {
            const svg = selPreviewSvg();
            if (!svg) return;
            e.preventDefault();
            const all = getEditableLayerShapes(svg).map(s => s.getAttribute('data-pf-index')).filter(i => i != null);
            if (all.length) selSetSelection(all);
            return;
        }
        if (selDrag || selMarquee || !selSelection.size || isTextInputFocused()) return;
        if (e.key === 'Delete' || e.key === 'Backspace') {
            e.preventDefault();
            selCommitNudge();                     // flush a pending nudge before the delete commits
            window.deleteSelectedLayer?.();       // canvas selection mirrors the panel selection
            return;
        }
        const arrow = SEL_ARROW[e.key];
        if (arrow && !e.altKey && !e.metaKey) {
            if (e.ctrlKey && !e.shiftKey) return;                 // plain Ctrl+arrow is unclaimed
            e.preventDefault();
            const step = e.ctrlKey ? 0.1 : e.shiftKey ? 10 : 1;   // Ctrl+Shift = fine 0.1px
            if (window.applySelectionRootMatrix(new DOMMatrix().translate(arrow.dx * step, arrow.dy * step), true)) {
                selNudgePending = true;
                window.refreshElementProperties?.();
                if (selNudgeTimer) clearTimeout(selNudgeTimer);
                selNudgeTimer = setTimeout(selCommitNudge, SEL_NUDGE_COMMIT_MS);
            }
        }
    });

    // Keyup: commit a nudge burst; release a held gesture modifier without pointer movement.
    document.addEventListener('keyup', (e) => {
        if (SEL_ARROW[e.key]) { selCommitNudge(); return; }
        if (selDrag && (e.key === 'Shift' || e.key === 'Alt')) {
            if (e.key === 'Alt') e.preventDefault();
            selSetDragModifiers(e.key === 'Shift' ? false : selDrag.shift, e.key === 'Alt' ? false : selDrag.alt);
        }
    });

    window.addEventListener('blur', selCommitNudge);

})();
