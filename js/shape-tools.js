/* fileName: shape-tools.js */

// Canvas Shape Tools: Rectangle, Ellipse, Triangle, Line segment (Illustrator-style). One tool is
// active at a time; click-drag draws the shape, and releasing commits it as a new TOP layer
// painted with the current drawing defaults (window.getDrawingDefaults, js/layers.js -- set in
// the Paint Panel while nothing is selected; the app default is no fill + black stroke).
// A click with no drag does nothing. The tools share one IIFE -- they differ only in which
// element they create + its label.
//
// Like the other canvas tools, hit-testing is free (the pointer-events:none overlays mean the
// pointer reaches #previewArea), and the live drag preview is a green hairline drawn into a
// dedicated screen-space overlay svg (#shapeToolOverlay) -- never into globalOptimizedSvg, so
// nothing leaks into export. Only on release does it touch the model (append to #ink-wrapper +
// buildLayersPanel + renderOutput). Reuses getNextLayerPfIndex / buildLayersPanel / selectLayer
// and mirrors the pointer->artboard + screen-projection math from selection-tool.js.

(() => {

    let shapeTool = null;       // 'rect' | 'ellipse' | 'line' | null  (the active tool)
    let shapeDrag = null;       // { type, startArt, curArt, downX, downY, moved, pointerId } while drawing
    let shapeRaf = 0;

    const SHAPE_DRAG_THRESHOLD = 3;     // px of travel before a press becomes a drag (vs a click)
    const SHAPE_GREEN = '#00E676';
    const SHAPE_W = '1.5';              // screen px -- constant-thickness rubber-band chrome
    const SVGNS = 'http://www.w3.org/2000/svg';

    const TOOL_BTN = { rect: 'btnRectTool', ellipse: 'btnEllipseTool', triangle: 'btnTriangleTool', line: 'btnLineTool' };
    const SHAPE_SHORTCUT = { r: 'rect', e: 'ellipse', l: 'line' };
    // Every canvas tool button (selection/direct/hand/artboard/pen/shapes/scissors). All are
    // greyed until an artboard is loaded, and one must always be active while it is (see syncShapeToolButtons).
    const ALL_TOOL_BTN = ['btnSelectionTool', 'btnDirectSelectionTool', 'btnHandTool', 'btnArtboardTool', 'btnPenTool', ...Object.values(TOOL_BTN), 'btnScissorsTool'];
    const SHAPE_LABEL = { rect: 'Rectangle', ellipse: 'Ellipse', triangle: 'Triangle', line: 'Line' };

    const shapeOverlay = $('shapeToolOverlay');
    const shapePreviewSvg = () => previewArea.querySelector(PREVIEW_SVG_SELECTOR);
    const isStatusBarTarget = (el) => el && el.closest && el.closest('.canvas-statusbar');

    const round2 = (n) => { const v = +n.toFixed(2); return Object.is(v, -0) ? 0 : v; };
    const formatStrokeWidth = (n) => String(round2(Math.max(1, n)));

    const getDefaultStrokeWidth = () => {
        if (!globalOptimizedSvg) return '1';

        let w = 0, h = 0;
        const vb = globalOptimizedSvg.getAttribute('viewBox') || globalOptimizedSvg.getAttribute('viewbox');
        if (vb) {
            const p = vb.trim().split(/[\s,]+/);
            if (p.length === 4) {
                w = parseFloat(p[2]) || 0;
                h = parseFloat(p[3]) || 0;
            }
        }

        if (!w || !h) {
            w = parseFloat(globalOptimizedSvg.getAttribute('width')) || w;
            h = parseFloat(globalOptimizedSvg.getAttribute('height')) || h;
        }

        const base = Math.min(w || 25, h || 25);
        return formatStrokeWidth(base / 25);
    };

    // Exposed so the Pen tool (js/pen-tool.js) gives new paths the same artboard-relative
    // default stroke weight without duplicating this.
    window.getShapeToolDefaultStrokeWidth = getDefaultStrokeWidth;

    // Pointer position -> artboard (viewBox) user units, from the live preview svg's on-screen
    // rect + viewBox (mirrors selection-tool.js selPointerRoot).
    const pointerToArtboard = (clientX, clientY) => {
        const svg = shapePreviewSvg();
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

    // Projection matrix: viewBox-root coords -> #shapeToolOverlay screen px (and size the overlay).
    // Mirrors selection-tool.js selScreenMatrix.
    const getShapeScreenMatrix = () => {
        const svg = shapePreviewSvg();
        if (!svg || !shapeOverlay) return null;

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

        shapeOverlay.setAttribute('viewBox', `0 0 ${areaW} ${areaH}`);
        shapeOverlay.setAttribute('width', areaW);
        shapeOverlay.setAttribute('height', areaH);

        return new DOMMatrix()
            .translate(svgRect.left - areaRect.left - areaBorderL, svgRect.top - areaRect.top - areaBorderT)
            .scale(svgRect.width / vbW, svgRect.height / vbH)
            .translate(-vbX, -vbY);
    };

    const hideOverlay = () => {
        if (!shapeOverlay) return;
        if (shapeOverlay.hasAttribute('hidden') && !shapeOverlay.children.length) return;
        shapeOverlay.replaceChildren();
        shapeOverlay.toggleAttribute('hidden', true);
    };

    // Effective draw points for the in-progress drag after the keyboard modifiers (Illustrator-
    // style): Shift constrains proportions (square / circle / equilateral triangle; a line snaps
    // to the nearest 45 degrees), Alt draws from the center (the press point becomes the middle).
    // Both preview and commit derive from these, so what you see is exactly what lands.
    const shapeEffectivePoints = (drag) => {
        let S = drag.startArt, C = drag.curArt;
        if (drag.shift) {
            const dx = C.x - S.x, dy = C.y - S.y;
            let ex = dx, ey = dy;
            if (drag.type === 'line') {
                const c = constrainVec45(dx, dy);
                ex = c.x; ey = c.y;
            } else if (drag.type === 'triangle') {
                // Equilateral: height = width * sqrt(3)/2; the dominant drag axis drives.
                const K = Math.sqrt(3) / 2;
                let w = Math.abs(dx), h = Math.abs(dy);
                if (w * K >= h) h = w * K; else w = h / K;
                ex = (dx < 0 ? -1 : 1) * w;
                ey = (dy < 0 ? -1 : 1) * h;
            } else {
                const m = Math.max(Math.abs(dx), Math.abs(dy));
                ex = (dx < 0 ? -1 : 1) * m;
                ey = (dy < 0 ? -1 : 1) * m;
            }
            C = { x: S.x + ex, y: S.y + ey };
        }
        if (drag.alt) S = { x: 2 * S.x - C.x, y: 2 * S.y - C.y };
        return { S, C };
    };

    // Track the current pointer point: raw while Shift-constrained (the constraint wins over
    // point snapping), snapped otherwise. rawCur is kept so a mid-drag modifier change can
    // recompute without pointer movement.
    const shapeUpdateCur = (drag, raw) => {
        drag.rawCur = raw;
        if (drag.shift) { drag.curArt = raw; return; }
        const sp = window.snapRootPoint?.(raw);
        drag.curArt = sp || raw;
    };

    // Green hairline rubber-band for the in-progress drag, drawn directly in overlay px
    // (start + current projected through the screen matrix) so the stroke is a constant screen px.
    const drawPreview = () => {
        if (!shapeDrag || !shapeDrag.moved) { hideOverlay(); return; }
        const M = getShapeScreenMatrix();
        if (!M) { hideOverlay(); return; }

        const eff = shapeEffectivePoints(shapeDrag);
        const a = M.transformPoint(new DOMPoint(eff.S.x, eff.S.y));
        const b = M.transformPoint(new DOMPoint(eff.C.x, eff.C.y));

        let el;
        if (shapeDrag.type === 'line') {
            el = document.createElementNS(SVGNS, 'line');
            el.setAttribute('x1', a.x); el.setAttribute('y1', a.y);
            el.setAttribute('x2', b.x); el.setAttribute('y2', b.y);
        } else if (shapeDrag.type === 'rect') {
            el = document.createElementNS(SVGNS, 'rect');
            el.setAttribute('x', Math.min(a.x, b.x)); el.setAttribute('y', Math.min(a.y, b.y));
            el.setAttribute('width', Math.abs(b.x - a.x)); el.setAttribute('height', Math.abs(b.y - a.y));
        } else if (shapeDrag.type === 'triangle') {
            el = document.createElementNS(SVGNS, 'polygon');
            const minX = Math.min(a.x, b.x), maxX = Math.max(a.x, b.x);
            const minY = Math.min(a.y, b.y), maxY = Math.max(a.y, b.y);
            el.setAttribute('points', `${(minX + maxX) / 2},${minY} ${minX},${maxY} ${maxX},${maxY}`);
        } else {
            el = document.createElementNS(SVGNS, 'ellipse');
            el.setAttribute('cx', (a.x + b.x) / 2); el.setAttribute('cy', (a.y + b.y) / 2);
            el.setAttribute('rx', Math.abs(b.x - a.x) / 2); el.setAttribute('ry', Math.abs(b.y - a.y) / 2);
        }
        el.setAttribute('fill', 'none');
        el.setAttribute('stroke', SHAPE_GREEN);
        el.setAttribute('stroke-width', SHAPE_W);
        el.setAttribute('stroke-linecap', 'round');
        el.setAttribute('stroke-linejoin', 'round');
        el.setAttribute('pointer-events', 'none');

        const children = [el];

        // Shift-constraint hints (dashed green hairlines): a corner-to-corner diagonal marks a
        // square, a centered plus marks a circle, a vertical midline marks the perfect triangle.
        if (shapeDrag.shift && shapeDrag.type !== 'line') {
            const mkHint = (x1, y1, x2, y2) => {
                const l = document.createElementNS(SVGNS, 'line');
                l.setAttribute('x1', x1); l.setAttribute('y1', y1);
                l.setAttribute('x2', x2); l.setAttribute('y2', y2);
                l.setAttribute('stroke', SHAPE_GREEN);
                l.setAttribute('stroke-width', '1');
                l.setAttribute('stroke-dasharray', '4 3');
                l.setAttribute('pointer-events', 'none');
                return l;
            };
            const minX = Math.min(a.x, b.x), maxX = Math.max(a.x, b.x);
            const minY = Math.min(a.y, b.y), maxY = Math.max(a.y, b.y);
            const midX = (minX + maxX) / 2, midY = (minY + maxY) / 2;
            if (shapeDrag.type === 'rect') {
                children.push(mkHint(a.x, a.y, b.x, b.y));
            } else if (shapeDrag.type === 'ellipse') {
                children.push(mkHint(minX, midY, maxX, midY), mkHint(midX, minY, midX, maxY));
            } else if (shapeDrag.type === 'triangle') {
                children.push(mkHint(midX, minY, midX, maxY));
            }
        }

        shapeOverlay.replaceChildren(...children);
        shapeOverlay.toggleAttribute('hidden', false);
    };

    const queueDraw = () => {
        if (shapeRaf) return;
        shapeRaf = requestAnimationFrame(() => { shapeRaf = 0; drawPreview(); });
    };

    // Re-project the band when the view changes mid-drag (zoom/pan); no-op when idle.
    window.syncShapeToolOverlay = () => {
        if (window.isGuideDragActive?.()) { hideOverlay(); return; }
        if (shapeDrag && shapeDrag.moved) drawPreview();
        else hideOverlay();
    };

    // Commit the dragged shape into the model as a new TOP layer (mirrors duplicateSelectedLayer):
    // painted with the drawing defaults, appended last in #ink-wrapper so it's the top card.
    const commitShape = (drag) => {
        if (!drag || !globalOptimizedSvg) return;
        const { type } = drag;
        const { S: startArt, C: curArt } = shapeEffectivePoints(drag);   // Shift/Alt-modified points
        const wrapper = globalOptimizedSvg.querySelector(':scope > g#ink-wrapper') || globalOptimizedSvg;

        const minX = Math.min(startArt.x, curArt.x), minY = Math.min(startArt.y, curArt.y);
        const w = Math.abs(curArt.x - startArt.x), h = Math.abs(curArt.y - startArt.y);
        if (type !== 'line' && (w <= 1e-6 || h <= 1e-6)) return;

        let shape;
        if (type === 'line') {
            shape = document.createElementNS(SVGNS, 'line');
            shape.setAttribute('x1', round2(startArt.x)); shape.setAttribute('y1', round2(startArt.y));
            shape.setAttribute('x2', round2(curArt.x));   shape.setAttribute('y2', round2(curArt.y));
        } else if (type === 'rect') {
            shape = document.createElementNS(SVGNS, 'rect');
            shape.setAttribute('x', round2(minX)); shape.setAttribute('y', round2(minY));
            shape.setAttribute('width', round2(w)); shape.setAttribute('height', round2(h));
        } else if (type === 'triangle') {
            shape = document.createElementNS(SVGNS, 'polygon');
            shape.setAttribute('points', `${round2(minX + w / 2)},${round2(minY)} ${round2(minX)},${round2(minY + h)} ${round2(minX + w)},${round2(minY + h)}`);
        } else {
            shape = document.createElementNS(SVGNS, 'ellipse');
            shape.setAttribute('cx', round2(minX + w / 2)); shape.setAttribute('cy', round2(minY + h / 2));
            shape.setAttribute('rx', round2(w / 2)); shape.setAttribute('ry', round2(h / 2));
        }

        // New shapes take the current drawing defaults (set in the Paint Panel while
        // nothing is selected, js/layers.js). A <line> can't render a fill, so it stays none.
        const d = window.getDrawingDefaults ? window.getDrawingDefaults() : { fill: 'none', stroke: '#000000', strokeWidth: getDefaultStrokeWidth() };
        shape.setAttribute('fill', type === 'line' ? 'none' : d.fill);
        shape.setAttribute('stroke', d.stroke);
        shape.setAttribute('stroke-width', d.strokeWidth);

        const idx = window.getNextLayerPfIndex ? window.getNextLayerPfIndex() : '0';
        shape.setAttribute('data-pf-index', idx);
        shape.setAttribute('data-pf-label', SHAPE_LABEL[type] || 'Shape');

        wrapper.appendChild(shape);

        buildLayersPanel();
        window.selectLayer?.(idx);      // highlight the new top card (panel selection)
        window.setEditSelectionSet?.([idx]);
        window.setHistoryLabel?.('Draw ' + (SHAPE_LABEL[type] || 'Shape'), SHAPE_LABEL[type] === 'Line' ? 'line-tool' : SHAPE_LABEL[type] === 'Ellipse' ? 'ellipse-tool' : SHAPE_LABEL[type] === 'Triangle' ? 'triangle-tool' : 'rect-tool');
        renderOutput(false);
        window.adoptCanvasSelection?.([idx]);
        window.updateAllScrollbars?.();
    };

    // --- Pointer drawing (capture on #previewArea; 3px threshold separates a click from a draw) ---

    const teardownDrag = () => {
        if (shapeRaf) { cancelAnimationFrame(shapeRaf); shapeRaf = 0; }
        if (shapeDrag) { try { previewArea.releasePointerCapture(shapeDrag.pointerId); } catch (_) {} }
        previewArea.removeEventListener('pointermove', onPointerMove);
        previewArea.removeEventListener('pointerup', onPointerUp);
        previewArea.removeEventListener('pointercancel', onPointerCancel);
        window.endSnapGesture?.();
    };

    function onPointerMove(e) {
        if (window.isGuideDragActive?.()) return;
        if (!shapeDrag || e.pointerId !== shapeDrag.pointerId) return;
        shapeDrag.shift = e.shiftKey;
        shapeDrag.alt = e.altKey;
        const cur = pointerToArtboard(e.clientX, e.clientY);
        if (cur) shapeUpdateCur(shapeDrag, cur);
        if (!shapeDrag.moved) {
            if (Math.abs(e.clientX - shapeDrag.downX) < SHAPE_DRAG_THRESHOLD && Math.abs(e.clientY - shapeDrag.downY) < SHAPE_DRAG_THRESHOLD) return;
            shapeDrag.moved = true;
        }
        queueDraw();
    }

    function onPointerUp(e) {
        if (!shapeDrag || (e && e.pointerId !== shapeDrag.pointerId)) return;
        shapeDrag.shift = e.shiftKey;
        shapeDrag.alt = e.altKey;
        const cur = pointerToArtboard(e.clientX, e.clientY);
        if (cur) shapeUpdateCur(shapeDrag, cur);
        const drag = shapeDrag;
        teardownDrag();
        shapeDrag = null;
        hideOverlay();
        if (drag.moved) commitShape(drag);     // a click with no drag commits nothing
    }

    function onPointerCancel(e) {
        if (!shapeDrag || (e && e.pointerId !== shapeDrag.pointerId)) return;
        teardownDrag();
        shapeDrag = null;
        hideOverlay();
    }

    previewArea.addEventListener('pointerdown', (e) => {
        if (window.isGuideDragActive?.()) return;
        if (!shapeTool || e.button !== 0 || shapeDrag) return;
        if (isStatusBarTarget(e.target)) return;
        if (window.isHandToolTemporaryPan?.()) return;
        let startArt = pointerToArtboard(e.clientX, e.clientY);
        if (!startArt) return;
        window.beginSnapGesture?.({});           // freeze snap targets for this draw
        const sp = window.snapRootPoint?.(startArt);
        if (sp) startArt = sp;
        shapeDrag = {
            type: shapeTool, startArt, curArt: startArt, rawCur: startArt,
            downX: e.clientX, downY: e.clientY, moved: false, pointerId: e.pointerId,
            shift: e.shiftKey, alt: e.altKey
        };
        try { previewArea.setPointerCapture(e.pointerId); } catch (_) {}
        previewArea.addEventListener('pointermove', onPointerMove);
        previewArea.addEventListener('pointerup', onPointerUp);
        previewArea.addEventListener('pointercancel', onPointerCancel);
        e.preventDefault();
    });

    // --- Tool activation (one active canvas tool at a time) ---

    const setActiveButton = () => {
        Object.entries(TOOL_BTN).forEach(([t, id]) => {
            const b = $(id);
            if (b) b.classList.toggle('active', shapeTool === t);
        });
    };

    const deactivate = () => {
        if (!shapeTool) return;
        if (shapeDrag) { teardownDrag(); shapeDrag = null; }
        shapeTool = null;
        setActiveButton();
        previewArea.classList.remove('shape-active');
        hideOverlay();
        window.refreshSelectionOverlay?.();
    };

    window.deactivateShapeTool = () => { if (shapeTool) deactivate(); };

    const activate = (type) => {
        if (shapeTool === type) return;
        window.deactivateSelectionTool?.();
        window.deactivateDirectSelectionTool?.();
        window.deactivateHandTool?.();
        window.deactivateArtboardTool?.();
        window.deactivatePenTool?.();
        window.deactivateScissorsTool?.();
        if (shapeDrag) { teardownDrag(); shapeDrag = null; hideOverlay(); }
        shapeTool = type;
        setActiveButton();
        previewArea.classList.add('shape-active');
        window.refreshSelectionOverlay?.();
    };

    window.toggleRectTool = () => activate('rect');
    window.toggleEllipseTool = () => activate('ellipse');
    window.toggleTriangleTool = () => activate('triangle');
    window.toggleLineTool = () => activate('line');

    // All canvas tools need an artboard: every tool button stays disabled/greyed until an SVG is loaded.
    // Called on import (enables) and on reset/clear (disables). Illustrator-style, one tool is ALWAYS
    // active while an artboard is loaded -- on enable, if nothing is active we default to the Selection
    // Tool; on disable, every active tool is turned off.
    window.syncShapeToolButtons = () => {
        const on = !!globalOptimizedSvg;
        ALL_TOOL_BTN.forEach(id => { const b = $(id); if (b) b.disabled = !on; });
        if (!on) {
            if (shapeTool) deactivate();
            window.deactivateSelectionTool?.();
            window.deactivateDirectSelectionTool?.();
            window.deactivateHandTool?.();
            window.deactivateArtboardTool?.();
            window.deactivatePenTool?.();
            window.deactivateScissorsTool?.();
            return;
        }
        const anyActive = ALL_TOOL_BTN.some(id => { const b = $(id); return b && b.classList.contains('active'); });
        if (!anyActive) window.toggleSelectionTool?.();
    };

    // R / E / L select Rectangle / Ellipse / Line (Illustrator) -- inert in text fields /
    // eyedropper / no artboard, and never toggle an already-active shape tool off. Escape cancels
    // an in-progress draw but leaves the Shape tool active. Shift/Alt pressed or released mid-draw retrigger the constraint /
    // from-center preview without needing pointer movement.
    const shapeModifierKey = (e, down) => {
        if (!shapeDrag) return;
        if (e.key === 'Alt') e.preventDefault();      // keep the browser menu from grabbing focus
        if (e.key === 'Shift') shapeDrag.shift = down;
        else if (e.key === 'Alt') shapeDrag.alt = down;
        else return;
        if (shapeDrag.rawCur) shapeUpdateCur(shapeDrag, shapeDrag.rawCur);
        queueDraw();
    };

    document.addEventListener('keydown', (e) => {
        if (shapeDrag && (e.key === 'Shift' || e.key === 'Alt')) { shapeModifierKey(e, true); return; }
        const shortcutTool = !e.ctrlKey && !e.altKey && !e.metaKey && !e.repeat && !isTextInputFocused()
            ? SHAPE_SHORTCUT[e.key.toLowerCase()] : null;
        if (shortcutTool && shortcutTool !== shapeTool && globalOptimizedSvg && !isEyedropperMode) {
            e.preventDefault();
            activate(shortcutTool);
            return;
        }
        if (e.key !== 'Escape' || !shapeTool || isTextInputFocused()) return;
        if (shapeDrag) { e.preventDefault(); teardownDrag(); shapeDrag = null; hideOverlay(); return; }
    });

    document.addEventListener('keyup', (e) => {
        if (shapeDrag && (e.key === 'Shift' || e.key === 'Alt')) shapeModifierKey(e, false);
    });

    window.syncShapeToolButtons();   // initial state (no SVG yet -> disabled)

})();
