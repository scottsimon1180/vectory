/* fileName: rulers-guides.js */

// Photoshop/Illustrator-style rulers and guides. All state is canvas UI only: guides are not
// stored in globalOptimizedSvg, never serialize/export, and never enter undo/redo history.
(() => {

    if (!previewArea || !rulerH || !rulerV || !rulerCorner || !guideOverlay) return;

    const RULER_SIZE = 20;
    const RULER_BOUND_SLOP = 2;
    const GUIDE_HIT_PX = 6;
    const GUIDE_DRAG_THRESHOLD = 2;

    const rulerHCtx = rulerH.getContext('2d');
    const rulerVCtx = rulerV.getContext('2d');
    const guideCtx = guideOverlay.getContext('2d');
    if (!rulerHCtx || !rulerVCtx || !guideCtx) return;

    let rulersVisible = true;
    let guidesVisible = true;
    let guides = [];
    let guideIdCounter = 0;
    let selectedGuide = null;
    let draggingGuide = null;
    let guideCreating = false;
    let drawRaf = 0;
    let rulerMouseX = -1;
    let rulerMouseY = -1;

    const btnRulers = $('btnToggleRulers');
    const btnGuides = $('btnToggleGuides');
    const btnClear = $('btnClearGuides');

    const cssVar = (name, fallback) => {
        const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
        return v || fallback;
    };

    const prepareCanvas = (canvas, ctx, cssW, cssH) => {
        const dpr = window.devicePixelRatio || 1;
        const w = Math.max(0, Math.round(cssW));
        const h = Math.max(0, Math.round(cssH));
        const pw = Math.max(0, Math.round(w * dpr));
        const ph = Math.max(0, Math.round(h * dpr));
        if (canvas.width !== pw || canvas.height !== ph) {
            canvas.width = pw;
            canvas.height = ph;
            canvas.style.width = `${w}px`;
            canvas.style.height = `${h}px`;
        }
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        return { w, h };
    };

    const getStatusBarHeight = () => {
        const bar = $('canvasStatusBar');
        return (bar && !bar.hidden) ? bar.offsetHeight : 0;
    };

    const isRulerTarget = (target) => target === rulerH || target === rulerV || target === rulerCorner;

    const isStatusBarTarget = (target) => target && target.closest && target.closest('.canvas-statusbar');

    const canEditExistingGuides = () => guidesVisible && !!window.isSelectionToolActive?.();

    const setRulerBoundCursor = (on) => {
        document.body.classList.toggle('ruler-bound-hover', !!on);
    };

    const pointIsInRulerBounds = (p, m = null) => {
        if (!rulersVisible || !globalOptimizedSvg) return false;
        const areaW = m ? m.areaW : previewArea.clientWidth;
        const areaH = m ? m.areaH : previewArea.clientHeight;
        if (p.x < -RULER_BOUND_SLOP || p.y < -RULER_BOUND_SLOP || p.x > areaW || p.y > areaH) return false;
        const statusTop = areaH - getStatusBarHeight();
        return p.y <= RULER_SIZE + RULER_BOUND_SLOP
            || (p.x <= RULER_SIZE + RULER_BOUND_SLOP && p.y <= statusTop);
    };

    const restoreSuspendedToolOverlays = () => {
        window.refreshSelectionOverlay?.();
        window.refreshDirectSelectionOverlay?.();
        window.syncArtboardToolOverlay?.();
        window.syncShapeToolOverlay?.();
        window.refreshPenToolOverlay?.();
        window.syncScissorsToolOverlay?.();
    };

    const suspendToolOverlaysForGuide = () => {
        window.clearSelectionOverlay?.();
        window.clearDirectSelectionOverlay?.();
        window.clearArtboardToolOverlay?.();
        window.syncShapeToolOverlay?.();
        window.clearPenToolOverlay?.();
        window.clearScissorsToolOverlay?.();
    };

    const beginGuideCreationSuspend = () => {
        if (guideCreating) return;
        guideCreating = true;
        document.body.classList.add('is-guide-creating');
        previewArea.classList.add('guide-dragging');
        suspendToolOverlaysForGuide();
    };

    const endGuideCreationSuspend = () => {
        if (!guideCreating) return;
        guideCreating = false;
        document.body.classList.remove('is-guide-creating');
        previewArea.classList.remove('guide-dragging');
        restoreSuspendedToolOverlays();
    };

    const getViewBoxSize = (svg) => {
        const vb = svg.getAttribute('viewBox') || svg.getAttribute('viewbox');
        if (vb) {
            const p = vb.trim().split(/[\s,]+/);
            if (p.length === 4) {
                return {
                    x: parseFloat(p[0]) || 0,
                    y: parseFloat(p[1]) || 0,
                    w: parseFloat(p[2]) || (parseFloat(svg.dataset.nativeW) || 128),
                    h: parseFloat(p[3]) || (parseFloat(svg.dataset.nativeH) || 128)
                };
            }
        }
        return {
            x: 0,
            y: 0,
            w: parseFloat(svg.dataset.nativeW) || 128,
            h: parseFloat(svg.dataset.nativeH) || 128
        };
    };

    const getMetrics = () => {
        const svg = previewArea.querySelector(PREVIEW_SVG_SELECTOR);
        if (!svg || !globalOptimizedSvg) return null;
        const areaRect = previewArea.getBoundingClientRect();
        const areaStyle = getComputedStyle(previewArea);
        const borderL = parseFloat(areaStyle.borderLeftWidth) || 0;
        const borderT = parseFloat(areaStyle.borderTopWidth) || 0;
        const areaW = previewArea.clientWidth;
        const areaH = previewArea.clientHeight;
        const svgRect = svg.getBoundingClientRect();
        const vb = getViewBoxSize(svg);
        if (areaW <= 0 || areaH <= 0 || vb.w <= 0 || vb.h <= 0 || svgRect.width <= 0 || svgRect.height <= 0) return null;
        return {
            areaW,
            areaH,
            svgX: svgRect.left - areaRect.left - borderL,
            svgY: svgRect.top - areaRect.top - borderT,
            scaleX: svgRect.width / vb.w,
            scaleY: svgRect.height / vb.h
        };
    };

    const clientToPreview = (clientX, clientY) => {
        const rect = previewArea.getBoundingClientRect();
        const style = getComputedStyle(previewArea);
        return {
            x: clientX - rect.left - (parseFloat(style.borderLeftWidth) || 0),
            y: clientY - rect.top - (parseFloat(style.borderTopWidth) || 0)
        };
    };

    const clientToArtboard = (clientX, clientY) => {
        const m = getMetrics();
        if (!m) return null;
        const p = clientToPreview(clientX, clientY);
        return {
            x: (p.x - m.svgX) / m.scaleX,
            y: (p.y - m.svgY) / m.scaleY
        };
    };

    const syncButtons = () => {
        if (btnRulers) {
            btnRulers.classList.toggle('is-checked', rulersVisible);
            btnRulers.setAttribute('aria-pressed', rulersVisible ? 'true' : 'false');
            btnRulers.title = rulersVisible ? 'Hide rulers' : 'Show rulers';
        }
        if (btnGuides) {
            btnGuides.classList.toggle('is-checked', guidesVisible);
            btnGuides.setAttribute('aria-pressed', guidesVisible ? 'true' : 'false');
            btnGuides.title = guidesVisible ? 'Hide guides' : 'Show guides';
        }
    };

    const syncRulerVisibility = () => {
        const show = !!globalOptimizedSvg && rulersVisible;
        rulerH.hidden = !show;
        rulerV.hidden = !show;
        rulerCorner.hidden = !show;
        if (!show) setRulerBoundCursor(false);
    };

    const getRulerInterval = (scale) => {
        const steps = [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000];
        const targetPx = 80;
        for (let i = 0; i < steps.length; i++) {
            if (steps[i] * scale >= targetPx) return steps[i];
        }
        return steps[steps.length - 1];
    };

    const drawRulers = () => {
        syncRulerVisibility();
        if (!rulersVisible || !globalOptimizedSvg) return;

        const m = getMetrics();
        if (!m) return;

        const bg = cssVar('--ruler-bg', '#242428');
        const tick = cssVar('--ruler-tick', 'rgba(242,242,247,0.48)');
        const text = cssVar('--ruler-text', 'rgba(242,242,247,0.68)');
        const accent = cssVar('--accent', '#007aff');
        const statusH = getStatusBarHeight();
        const hW = Math.max(0, m.areaW - RULER_SIZE);
        const vH = Math.max(0, m.areaH - RULER_SIZE - statusH);
        const interval = getRulerInterval(m.scaleX);
        const sub = interval >= 10 ? 10 : interval >= 5 ? 5 : interval >= 2 ? 4 : 2;
        const subSize = interval / sub;

        prepareCanvas(rulerH, rulerHCtx, hW, RULER_SIZE);
        rulerHCtx.clearRect(0, 0, hW, RULER_SIZE);
        rulerHCtx.fillStyle = bg;
        rulerHCtx.fillRect(0, 0, hW, RULER_SIZE);
        rulerHCtx.fillStyle = text;
        rulerHCtx.font = '9px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
        rulerHCtx.textBaseline = 'top';
        rulerHCtx.strokeStyle = tick;
        rulerHCtx.lineWidth = 1;
        rulerHCtx.beginPath();

        const hOffset = m.svgX - RULER_SIZE;
        const xStart = -hOffset / m.scaleX;
        const xEnd = (hW - hOffset) / m.scaleX;
        const firstX = Math.floor(xStart / interval) * interval;
        for (let val = firstX; val <= xEnd; val += subSize) {
            const sx = val * m.scaleX + hOffset;
            if (sx < -1 || sx > hW + 1) continue;
            const rounded = Math.round(val * 1000) / 1000;
            const isMajor = Math.abs(rounded % interval) < 0.001;
            const isHalf = !isMajor && sub >= 4 && Math.abs(rounded % (interval / 2)) < 0.001;
            const tickH = isMajor ? 12 : isHalf ? 8 : 4;
            const x = Math.round(sx) + 0.5;
            rulerHCtx.moveTo(x, RULER_SIZE);
            rulerHCtx.lineTo(x, RULER_SIZE - tickH);
            if (isMajor) {
                rulerHCtx.stroke();
                rulerHCtx.beginPath();
                rulerHCtx.fillStyle = text;
                rulerHCtx.fillText(String(Math.round(rounded)), sx + 2, 2);
            }
        }
        rulerHCtx.stroke();

        if (rulerMouseX >= RULER_SIZE) {
            const ix = Math.round(rulerMouseX - RULER_SIZE) + 0.5;
            rulerHCtx.strokeStyle = accent;
            rulerHCtx.beginPath();
            rulerHCtx.moveTo(ix, 0);
            rulerHCtx.lineTo(ix, RULER_SIZE);
            rulerHCtx.stroke();
        }

        prepareCanvas(rulerV, rulerVCtx, RULER_SIZE, vH);
        rulerVCtx.clearRect(0, 0, RULER_SIZE, vH);
        rulerVCtx.fillStyle = bg;
        rulerVCtx.fillRect(0, 0, RULER_SIZE, vH);
        rulerVCtx.fillStyle = text;
        rulerVCtx.font = '9px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
        rulerVCtx.strokeStyle = tick;
        rulerVCtx.lineWidth = 1;
        rulerVCtx.beginPath();

        const vOffset = m.svgY - RULER_SIZE;
        const yStart = -vOffset / m.scaleY;
        const yEnd = (vH - vOffset) / m.scaleY;
        const firstY = Math.floor(yStart / interval) * interval;
        for (let val = firstY; val <= yEnd; val += subSize) {
            const sy = val * m.scaleY + vOffset;
            if (sy < -1 || sy > vH + 1) continue;
            const rounded = Math.round(val * 1000) / 1000;
            const isMajor = Math.abs(rounded % interval) < 0.001;
            const isHalf = !isMajor && sub >= 4 && Math.abs(rounded % (interval / 2)) < 0.001;
            const tickH = isMajor ? 12 : isHalf ? 8 : 4;
            const y = Math.round(sy) + 0.5;
            rulerVCtx.moveTo(RULER_SIZE, y);
            rulerVCtx.lineTo(RULER_SIZE - tickH, y);
            if (isMajor) {
                rulerVCtx.stroke();
                rulerVCtx.beginPath();
                rulerVCtx.save();
                rulerVCtx.translate(2, sy + 2);
                rulerVCtx.rotate(-Math.PI / 2);
                rulerVCtx.fillStyle = text;
                rulerVCtx.textBaseline = 'top';
                rulerVCtx.fillText(String(Math.round(rounded)), 0, 0);
                rulerVCtx.restore();
            }
        }
        rulerVCtx.stroke();

        if (rulerMouseY >= RULER_SIZE && rulerMouseY <= RULER_SIZE + vH) {
            const iy = Math.round(rulerMouseY - RULER_SIZE) + 0.5;
            rulerVCtx.strokeStyle = accent;
            rulerVCtx.beginPath();
            rulerVCtx.moveTo(0, iy);
            rulerVCtx.lineTo(RULER_SIZE, iy);
            rulerVCtx.stroke();
        }
    };

    const drawGuides = () => {
        const size = prepareCanvas(guideOverlay, guideCtx, previewArea.clientWidth, previewArea.clientHeight);
        guideCtx.clearRect(0, 0, size.w, size.h);

        const m = getMetrics();
        const show = !!m && guidesVisible && guides.length > 0;
        guideOverlay.hidden = !show;
        if (!show) return;

        const normal = cssVar('--guide-color', '#00dcff');
        const selected = cssVar('--guide-selected', '#3167ff');
        guideCtx.lineWidth = 1;
        guideCtx.setLineDash([]);
        guides.forEach(g => {
            const active = g === selectedGuide || (draggingGuide && draggingGuide.guide === g);
            guideCtx.strokeStyle = active ? selected : normal;
            guideCtx.beginPath();
            if (g.axis === 'v') {
                const x = Math.round(m.svgX + g.pos * m.scaleX) + 0.5;
                guideCtx.moveTo(x, 0);
                guideCtx.lineTo(x, size.h);
            } else {
                const y = Math.round(m.svgY + g.pos * m.scaleY) + 0.5;
                guideCtx.moveTo(0, y);
                guideCtx.lineTo(size.w, y);
            }
            guideCtx.stroke();
        });
    };

    const drawAll = () => {
        drawRulers();
        drawGuides();
        syncButtons();
    };

    const queueDraw = () => {
        if (drawRaf) return;
        drawRaf = requestAnimationFrame(() => {
            drawRaf = 0;
            drawAll();
        });
    };

    const clearHoverCursor = () => {
        previewArea.classList.remove('guide-hover-v', 'guide-hover-h');
    };

    const setDragCursor = (axis, on) => {
        document.body.classList.toggle('guide-cur-v', !!on && axis === 'v');
        document.body.classList.toggle('guide-cur-h', !!on && axis === 'h');
    };

    const clearObjectSelectionsForGuide = () => {
        window.adoptCanvasSelection?.([]);
        window.clearDirectSelectionToolLock?.();
        window.clearLayerSelection?.();
        window.clearEditSelection?.();
    };

    const selectGuide = (guide, opts = {}) => {
        selectedGuide = guide;
        if (opts.clearObjects !== false) clearObjectSelectionsForGuide();
        queueDraw();
        window.refreshElementProperties?.();
    };

    const clearGuideSelection = () => {
        if (!selectedGuide) return;
        selectedGuide = null;
        queueDraw();
        window.refreshElementProperties?.();
    };

    const hitTestGuide = (clientX, clientY) => {
        if (!guidesVisible || !guides.length) return null;
        const m = getMetrics();
        if (!m) return null;
        const p = clientToPreview(clientX, clientY);
        if (p.x < 0 || p.y < 0 || p.x > m.areaW || p.y > m.areaH) return null;
        let best = null;
        let bestDist = GUIDE_HIT_PX;
        for (let i = guides.length - 1; i >= 0; i--) {
            const g = guides[i];
            const dist = g.axis === 'v'
                ? Math.abs(p.x - (m.svgX + g.pos * m.scaleX))
                : Math.abs(p.y - (m.svgY + g.pos * m.scaleY));
            if (dist < bestDist) {
                best = g;
                bestDist = dist;
            }
        }
        return best;
    };

    const beginGuideDrag = (guide, event, isNew) => {
        if (isNew) beginGuideCreationSuspend();
        selectGuide(guide, { clearObjects: !isNew });
        window.beginSnapGesture?.({ includeGuides: false });   // guides snap to artwork/artboard, not to each other
        draggingGuide = {
            guide,
            isNew: !!isNew,
            hasMoved: !!isNew,
            pointerId: event.pointerId,
            downX: event.clientX,
            downY: event.clientY,
            startPos: guide.pos
        };
        clearHoverCursor();
        if (!isNew) setDragCursor(guide.axis, true);
        queueDraw();
        window.refreshElementProperties?.();
    };

    const beginGuideDragFromRuler = (axis, event) => {
        if (!rulersVisible || !globalOptimizedSvg || event.button !== 0) return;
        const p = clientToArtboard(event.clientX, event.clientY);
        if (!p) return;
        event.preventDefault();
        event.stopPropagation();
        const guide = {
            id: guideIdCounter++,
            axis,
            pos: axis === 'v' ? p.x : p.y
        };
        guides.push(guide);
        beginGuideDrag(guide, event, true);
        syncButtons();
    };

    const pointIsOnRuler = (p, m) => {
        return pointIsInRulerBounds(p, m);
    };

    const pointIsOnStatusBar = (p, m) => {
        const statusH = getStatusBarHeight();
        return statusH > 0 && p.y >= m.areaH - statusH;
    };

    const shouldDeleteOnRelease = (guide, event) => {
        const m = getMetrics();
        if (!m) return true;
        const p = clientToPreview(event.clientX, event.clientY);
        if (p.x < 0 || p.y < 0 || p.x > m.areaW || p.y > m.areaH) return true;
        return pointIsOnStatusBar(p, m) || pointIsOnRuler(p, m);
    };

    const removeGuide = (guide) => {
        guides = guides.filter(g => g !== guide);
        if (selectedGuide === guide) selectedGuide = null;
        if (draggingGuide && draggingGuide.guide === guide) draggingGuide = null;
        syncButtons();
    };

    const onGuideDragMove = (event) => {
        if (!draggingGuide || event.pointerId !== draggingGuide.pointerId) return;
        event.preventDefault();
        event.stopPropagation();
        const p = clientToArtboard(event.clientX, event.clientY);
        if (!p) return;
        const guide = draggingGuide.guide;
        if (!draggingGuide.hasMoved) {
            const dx = event.clientX - draggingGuide.downX;
            const dy = event.clientY - draggingGuide.downY;
            draggingGuide.hasMoved = Math.hypot(dx, dy) >= GUIDE_DRAG_THRESHOLD;
        }
        if (!draggingGuide.hasMoved) return;
        let pos = guide.axis === 'v' ? p.x : p.y;
        const svgEl = previewArea.querySelector(PREVIEW_SVG_SELECTOR);
        if (svgEl) {
            // Guide positions are viewBox-origin relative; the snap engine works in root coords.
            const vb = getViewBoxSize(svgEl);
            const sp = window.snapRootPoint?.(
                { x: vb.x + (guide.axis === 'v' ? pos : 0), y: vb.y + (guide.axis === 'h' ? pos : 0) },
                { axes: { x: guide.axis === 'v', y: guide.axis === 'h' } }
            );
            if (sp) pos = guide.axis === 'v' ? sp.x - vb.x : sp.y - vb.y;
        }
        guide.pos = pos;
        queueDraw();
        window.refreshElementProperties?.();
    };

    const onGuideDragEnd = (event) => {
        if (!draggingGuide || (event.pointerId != null && event.pointerId !== draggingGuide.pointerId)) return;
        event.preventDefault();
        event.stopPropagation();
        const drag = draggingGuide;
        const guide = drag.guide;
        const keepSelected = !drag.isNew && !drag.hasMoved;
        if (shouldDeleteOnRelease(guide, event)) removeGuide(guide);
        else selectedGuide = keepSelected ? guide : null;
        draggingGuide = null;
        setDragCursor(guide.axis, false);
        if (drag.isNew) endGuideCreationSuspend();
        window.endSnapGesture?.();
        window.invalidateSnapTargets?.();
        queueDraw();
        window.refreshElementProperties?.();
    };

    const onPreviewPointerMove = (event) => {
        const p = clientToPreview(event.clientX, event.clientY);
        rulerMouseX = p.x;
        rulerMouseY = p.y;
        if (rulersVisible) queueDraw();
        const inRulerBounds = pointIsInRulerBounds(p);
        setRulerBoundCursor(inRulerBounds);

        if (draggingGuide) {
            event.preventDefault();
            event.stopImmediatePropagation();
            return;
        }
        if (inRulerBounds || isRulerTarget(event.target)) {
            clearHoverCursor();
            window.clearScissorsToolHover?.();
            event.preventDefault();
            event.stopImmediatePropagation();
            return;
        }
        if (isStatusBarTarget(event.target)) {
            clearHoverCursor();
            return;
        }
        if (window.isHandToolTemporaryPan?.() || !canEditExistingGuides()) {
            clearHoverCursor();
            return;
        }
        const hit = hitTestGuide(event.clientX, event.clientY);
        previewArea.classList.toggle('guide-hover-v', !!hit && hit.axis === 'v');
        previewArea.classList.toggle('guide-hover-h', !!hit && hit.axis === 'h');
    };

    const onPreviewPointerDown = (event) => {
        if (event.button !== 0 || draggingGuide) return;
        if (event.target === rulerH || event.target === rulerV) return;
        const p = clientToPreview(event.clientX, event.clientY);
        if (pointIsInRulerBounds(p)) {
            event.preventDefault();
            event.stopImmediatePropagation();
            return;
        }
        if (event.target === rulerCorner) {
            event.preventDefault();
            event.stopImmediatePropagation();
            return;
        }
        if (isStatusBarTarget(event.target)) return;
        const hit = canEditExistingGuides() ? hitTestGuide(event.clientX, event.clientY) : null;
        if (hit) {
            event.preventDefault();
            event.stopImmediatePropagation();
            beginGuideDrag(hit, event, false);
            return;
        }
        if (selectedGuide) clearGuideSelection();
    };

    const onPreviewPointerLeave = () => {
        rulerMouseX = -1;
        rulerMouseY = -1;
        clearHoverCursor();
        setRulerBoundCursor(false);
        if (rulersVisible) queueDraw();
    };

    const toggleRulers = () => {
        rulersVisible = !rulersVisible;
        syncRulerVisibility();
        syncButtons();
        if (window.isViewFitMode?.()) window.fitToCanvas(true);
        else queueDraw();
    };

    const toggleGuides = () => {
        guidesVisible = !guidesVisible;
        if (!guidesVisible) clearGuideSelection();
        window.invalidateSnapTargets?.();   // hidden guides stop being snap targets
        syncButtons();
        queueDraw();
    };

    const clearGuides = () => {
        const wasCreating = !!draggingGuide?.isNew;
        guides = [];
        guideIdCounter = 0;
        selectedGuide = null;
        draggingGuide = null;
        clearHoverCursor();
        setRulerBoundCursor(false);
        setDragCursor('v', false);
        if (wasCreating) endGuideCreationSuspend();
        window.endSnapGesture?.();
        window.invalidateSnapTargets?.();
        syncButtons();
        queueDraw();
        window.refreshElementProperties?.();
    };

    // Visible guides as snap candidates for js/snapping.js (positions are viewBox-origin
    // relative; the engine adds the viewBox origin itself).
    window.getSnapGuidePositions = () => (guidesVisible ? guides.map(g => ({ axis: g.axis, pos: g.pos })) : []);

    window.getRulerFitOffset = () => (rulersVisible ? RULER_SIZE : 0);
    window.syncRulersAndGuides = queueDraw;
    window.clearRulersGuidesState = clearGuides;
    window.isGuideDragActive = () => guideCreating;
    window.isGuidePropertiesMode = () => !!selectedGuide && guidesVisible;
    window.getGuideDisplayValues = () => {
        if (!selectedGuide || !guidesVisible) return null;
        return {
            axis: selectedGuide.axis,
            x: selectedGuide.axis === 'v' ? selectedGuide.pos : null,
            y: selectedGuide.axis === 'h' ? selectedGuide.pos : null,
            width: null,
            height: null
        };
    };
    window.applyGuidePropertyEdit = (field, value, isScrubbing = false) => {
        if (!selectedGuide || !guidesVisible || !Number.isFinite(value)) return false;
        if (selectedGuide.axis === 'v' && field !== 'x') return false;
        if (selectedGuide.axis === 'h' && field !== 'y') return false;
        selectedGuide.pos = value;
        window.invalidateSnapTargets?.();
        queueDraw();
        if (!isScrubbing) window.refreshElementProperties?.();
        return true;
    };

    if (btnRulers) btnRulers.addEventListener('click', toggleRulers);
    if (btnGuides) btnGuides.addEventListener('click', toggleGuides);
    if (btnClear) btnClear.addEventListener('click', clearGuides);
    const swallowRulerEvent = (event) => {
        event.preventDefault();
        event.stopPropagation();
    };
    rulerH.addEventListener('pointerdown', (event) => beginGuideDragFromRuler('h', event));
    rulerV.addEventListener('pointerdown', (event) => beginGuideDragFromRuler('v', event));
    rulerCorner.addEventListener('pointerdown', swallowRulerEvent);
    previewArea.addEventListener('pointermove', onPreviewPointerMove, true);
    previewArea.addEventListener('pointerdown', onPreviewPointerDown, true);
    previewArea.addEventListener('pointerleave', onPreviewPointerLeave);
    window.addEventListener('pointermove', onGuideDragMove, true);
    window.addEventListener('pointerup', onGuideDragEnd, true);
    window.addEventListener('pointercancel', onGuideDragEnd, true);

    syncButtons();
    queueDraw();

})();
