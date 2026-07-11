/* fileName: artboard-tool.js */

// Canvas Artboard Tool. When active, the existing artboard overlay becomes editable:
// dragging an edge handle resizes the SVG viewBox, and the Properties panel edits width/height.

(() => {

    const AB_MIN_SIZE = 1;
    const AB_DP = 4;
    const AB_HANDLES = ['n', 'e', 's', 'w', 'nw', 'ne', 'se', 'sw'];
    const AB_CURSOR_CLASS = {
        n: 'ab-cur-ns', s: 'ab-cur-ns', e: 'ab-cur-ew', w: 'ab-cur-ew',
        nw: 'ab-cur-nwse', se: 'ab-cur-nwse', ne: 'ab-cur-nesw', sw: 'ab-cur-nesw'
    };

    let abActive = false;
    let abDrag = null;
    let abDragRaf = 0;
    let abDragPending = null;
    // Pre-gesture artboard box captured on the first scrubbing Width/Height field frame, so the
    // content-scale factor + proportional constrain stay relative to the original size (a scrub
    // mutates the viewBox every frame). Cleared on commit.
    let abFieldGesture = null;

    const abFmt = (n) => {
        const v = Math.abs(n) < 1e-8 ? 0 : Number((Number.isFinite(n) ? n : 0).toFixed(AB_DP));
        return String(v);
    };

    const abReadBox = (svgNode = globalOptimizedSvg) => {
        if (!svgNode) return null;

        let x = 0, y = 0, width = 0, height = 0;
        const vb = svgNode.getAttribute('viewBox') || svgNode.getAttribute('viewbox');

        if (vb) {
            const p = vb.trim().split(/[\s,]+/).map(parseFloat);
            if (p.length === 4) {
                x = Number.isFinite(p[0]) ? p[0] : 0;
                y = Number.isFinite(p[1]) ? p[1] : 0;
                width = Number.isFinite(p[2]) ? p[2] : 0;
                height = Number.isFinite(p[3]) ? p[3] : 0;
            } else if (p.length >= 2) {
                width = Number.isFinite(p[0]) ? p[0] : 0;
                height = Number.isFinite(p[1]) ? p[1] : 0;
            }
        }

        if (width <= 0) width = parseFloat(svgNode.getAttribute('width')) || 128;
        if (height <= 0) height = parseFloat(svgNode.getAttribute('height')) || 128;

        return {
            x,
            y,
            width: Math.max(AB_MIN_SIZE, width),
            height: Math.max(AB_MIN_SIZE, height)
        };
    };

    // Write the viewBox / width / height only (no render) so callers that also scale the contents
    // can batch a single render (via previewScaleAllContent / commitScaleAllContent).
    const abSetBoxAttrs = (box) => {
        if (!globalOptimizedSvg || !box) return false;

        const next = {
            x: Number.isFinite(box.x) ? box.x : 0,
            y: Number.isFinite(box.y) ? box.y : 0,
            width: Math.max(AB_MIN_SIZE, Number.isFinite(box.width) ? box.width : AB_MIN_SIZE),
            height: Math.max(AB_MIN_SIZE, Number.isFinite(box.height) ? box.height : AB_MIN_SIZE)
        };

        globalOptimizedSvg.removeAttribute('viewbox');
        globalOptimizedSvg.setAttribute('viewBox', `${abFmt(next.x)} ${abFmt(next.y)} ${abFmt(next.width)} ${abFmt(next.height)}`);
        globalOptimizedSvg.setAttribute('width', abFmt(next.width));
        globalOptimizedSvg.setAttribute('height', abFmt(next.height));
        return true;
    };

    const abWriteBox = (box, isScrubbing = false) => {
        if (!abSetBoxAttrs(box)) return false;
        renderOutput(isScrubbing);
        if (!isScrubbing) window.syncPngDimensions?.();
        return true;
    };

    // Ref-point factors [hx, vy] (fraction across the box); shared with the Properties panel.
    const abRefFactors = () => window.getActiveRefFactors?.() || [0, 0];

    // Content-scale anchor (content coords) for a resize by handle key: the edge that stays fixed.
    const abResizeAnchor = (key, start) => ({
        ax: key.includes('w') ? start.x + start.width : start.x,
        ay: key.includes('n') ? start.y + start.height : start.y
    });

    const abClearHandles = () => {
        if (!artboardOverlay) return;
        artboardOverlay.querySelectorAll('.artboard-handle').forEach(h => h.remove());
    };

    const abEnsureHandles = () => {
        if (!artboardOverlay) return;
        if (window.isGuideDragActive?.()) {
            abClearHandles();
            artboardOverlay.classList.remove('artboard-tool-active');
            return;
        }

        const isEditable = abActive && !!globalOptimizedSvg && !artboardOverlay.hidden;
        artboardOverlay.classList.toggle('artboard-tool-active', isEditable);

        if (!isEditable) {
            abClearHandles();
            return;
        }

        AB_HANDLES.forEach(key => {
            if (artboardOverlay.querySelector(`.artboard-handle-${key}`)) return;
            const h = document.createElement('div');
            h.className = `artboard-handle artboard-handle-${key}`;
            h.setAttribute('data-ab-handle', key);
            h.setAttribute('aria-hidden', 'true');
            artboardOverlay.appendChild(h);
        });
    };

    window.syncArtboardToolOverlay = abEnsureHandles;

    window.clearArtboardToolOverlay = () => {
        abClearHandles();
        if (artboardOverlay) artboardOverlay.classList.remove('artboard-tool-active');
    };

    const abCleanupDrag = () => {
        if (abDragRaf) { cancelAnimationFrame(abDragRaf); abDragRaf = 0; }
        abDragPending = null;
        if (abDrag) {
            try { previewArea.releasePointerCapture(abDrag.pointerId); } catch (_) {}
            if (abDrag.cursorClass) document.body.classList.remove(abDrag.cursorClass);
        }
        previewArea.removeEventListener('pointermove', abOnDragMove);
        previewArea.removeEventListener('pointerup', abOnDragEnd);
        previewArea.removeEventListener('pointercancel', abOnDragEnd);
    };

    const abBoxFromDrag = (clientX, clientY) => {
        if (!abDrag) return null;

        const start = abDrag.startBox;
        const scale = Math.max(0.0001, abDrag.startScale || viewScale || 1);
        const dx = (clientX - abDrag.downX) / scale;
        const dy = (clientY - abDrag.downY) / scale;
        const next = { x: start.x, y: start.y, width: start.width, height: start.height };

        // Reposition (move): shift the viewBox origin; the frame is kept under the pointer via pan.
        if (abDrag.mode === 'move') {
            next.x = start.x + dx;
            next.y = start.y + dy;
            return next;
        }

        // Resize: a handle key may combine a horizontal (e/w) and a vertical (n/s) part (corners).
        const key = abDrag.key;
        if (key.includes('e')) {
            next.width = Math.max(AB_MIN_SIZE, start.width + dx);
        } else if (key.includes('w')) {
            next.width = Math.max(AB_MIN_SIZE, start.width - dx);
            next.x = start.x + (start.width - next.width);
        }
        if (key.includes('s')) {
            next.height = Math.max(AB_MIN_SIZE, start.height + dy);
        } else if (key.includes('n')) {
            next.height = Math.max(AB_MIN_SIZE, start.height - dy);
            next.y = start.y + (start.height - next.height);
        }

        return next;
    };

    const abApplyDragFrame = () => {
        abDragRaf = 0;
        if (!abDrag || !abDragPending) return false;

        const next = abBoxFromDrag(abDragPending.x, abDragPending.y);
        if (!next) return false;

        // Reposition: the frame follows the pointer in screen px while the contents stay fixed
        // (viewBox origin shift + matching pan cancel out for the artwork).
        if (abDrag.mode === 'move') {
            viewPanX = abDrag.startPanX + (abDragPending.x - abDrag.downX);
            viewPanY = abDrag.startPanY + (abDragPending.y - abDrag.downY);
            abDrag.moved = true;
            abWriteBox(next, true);
            window.refreshElementProperties?.();
            return true;
        }

        // Resize: pan so the fixed edge/corner stays put on screen (flex-centered box grows both ways).
        const key = abDrag.key;
        const dw = next.width - abDrag.startBox.width;
        const dh = next.height - abDrag.startBox.height;
        if (key.includes('e')) viewPanX = abDrag.startPanX + dw * abDrag.startScale / 2;
        else if (key.includes('w')) viewPanX = abDrag.startPanX - dw * abDrag.startScale / 2;
        else viewPanX = abDrag.startPanX;
        if (key.includes('s')) viewPanY = abDrag.startPanY + dh * abDrag.startScale / 2;
        else if (key.includes('n')) viewPanY = abDrag.startPanY - dh * abDrag.startScale / 2;
        else viewPanY = abDrag.startPanY;

        abDrag.moved = true;

        // "Scale contents with artboard": live-preview the whole artwork via one temporary wrapper
        // transform (baked on release); otherwise just resize the frame.
        if (abDrag.scaleContents) {
            const start = abDrag.startBox;
            const sx = start.width > 1e-6 ? next.width / start.width : 1;
            const sy = start.height > 1e-6 ? next.height / start.height : 1;
            const { ax, ay } = abResizeAnchor(key, start);
            abDrag.lastScale = { ax, ay, sx, sy };
            abSetBoxAttrs(next);
            window.previewScaleAllContent?.(ax, ay, sx, sy);   // renders (isScrubbing)
        } else {
            abWriteBox(next, true);
        }
        window.refreshElementProperties?.();
        return true;
    };

    const abOnDragMove = (e) => {
        if (!abDrag || e.pointerId !== abDrag.pointerId) return;
        abDragPending = { x: e.clientX, y: e.clientY };
        if (!abDragRaf) abDragRaf = requestAnimationFrame(abApplyDragFrame);
    };

    const abCommitDrag = () => {
        if (!abDrag) return;
        if (abDragRaf) { cancelAnimationFrame(abDragRaf); abDragRaf = 0; }
        if (abDragPending) abApplyDragFrame();
        const moved = abDrag.moved;
        const scale = (abDrag.scaleContents && moved) ? abDrag.lastScale : null;
        abCleanupDrag();
        abDrag = null;
        if (moved) {
            // Bake the previewed content scale into geometry (renders inside); else a plain commit render.
            if (scale) window.commitScaleAllContent?.(scale.ax, scale.ay, scale.sx, scale.sy);
            else { window.setHistoryLabel?.('Resize Artboard', 'artboard-tool'); renderOutput(false); }
            window.syncPngDimensions?.();
        }
    };

    function abOnDragEnd(e) {
        if (!abDrag || (e && e.pointerId !== abDrag.pointerId)) return;
        abCommitDrag();
    }

    const abCancelDrag = () => {
        if (!abDrag) return;
        const start = abDrag.startBox;
        const hadContentPreview = abDrag.scaleContents && abDrag.moved;
        viewPanX = abDrag.startPanX;
        viewPanY = abDrag.startPanY;
        abCleanupDrag();
        abDrag = null;
        if (hadContentPreview) window.clearContentScalePreview?.();   // drop the temporary wrapper transform
        abWriteBox(start, false);
        window.refreshElementProperties?.();
    };

    const abBeginDrag = (e, opts) => {
        const box = abReadBox();
        if (!box) return;

        e.preventDefault();
        e.stopPropagation();

        abDrag = {
            mode: opts.mode,
            key: opts.key || '',
            pointerId: e.pointerId,
            downX: e.clientX,
            downY: e.clientY,
            startBox: box,
            startPanX: viewPanX,
            startPanY: viewPanY,
            startScale: viewScale,
            moved: false,
            scaleContents: opts.mode === 'resize' && !!scaleContentsWithArtboard,
            lastScale: null,
            cursorClass: opts.cursorClass
        };

        if (abDrag.cursorClass) document.body.classList.add(abDrag.cursorClass);
        try { previewArea.setPointerCapture(e.pointerId); } catch (_) {}
        previewArea.addEventListener('pointermove', abOnDragMove);
        previewArea.addEventListener('pointerup', abOnDragEnd);
        previewArea.addEventListener('pointercancel', abOnDragEnd);
    };

    const abBeginResize = (key, e) => abBeginDrag(e, { mode: 'resize', key, cursorClass: AB_CURSOR_CLASS[key] });
    const abBeginMove = (e) => abBeginDrag(e, { mode: 'move', cursorClass: 'ab-cur-move' });

    if (artboardOverlay) {
        artboardOverlay.addEventListener('pointerdown', (e) => {
            if (window.isGuideDragActive?.()) return;
            if (!abActive || e.button !== 0 || abDrag) return;
            const h = e.target && e.target.closest ? e.target.closest('.artboard-handle') : null;
            if (h) {
                const key = h.getAttribute('data-ab-handle');
                if (AB_HANDLES.includes(key)) abBeginResize(key, e);
            } else {
                abBeginMove(e);   // press the frame interior -> reposition the artboard
            }
        });
    }

    const abDeactivate = () => {
        if (abDrag) abCommitDrag();
        abActive = false;
        const btn = $('btnArtboardTool');
        if (btn) btn.classList.remove('active');
        previewArea.classList.remove('artboard-active');
        abEnsureHandles();
        window.refreshElementProperties?.();
    };

    window.deactivateArtboardTool = () => { if (abActive) abDeactivate(); };
    window.isArtboardToolActive = () => abActive;

    window.clearArtboardToolState = () => {
        if (abDrag) {
            abCleanupDrag();
            abDrag = null;
        }
        abFieldGesture = null;
        abEnsureHandles();
        window.refreshElementProperties?.();
    };

    window.toggleArtboardTool = (btn) => {
        if (abActive) { abDeactivate(); return; }
        window.deactivateSelectionTool?.();
        window.deactivateDirectSelectionTool?.();
        window.deactivateHandTool?.();
        window.deactivateShapeTool?.();
        window.deactivatePenTool?.();
        window.deactivateScissorsTool?.();
        window.clearLayerSelection?.();
        window.clearEditSelection?.();
        abActive = true;
        (btn || $('btnArtboardTool'))?.classList.add('active');
        previewArea.classList.add('artboard-active');
        abEnsureHandles();
        window.refreshElementProperties?.();
    };

    // X/Y read the reference-point anchor (like the element mode), not always the top-left corner.
    window.getArtboardDisplayValues = () => {
        const box = abReadBox();
        if (!box) return null;
        const [hx, vy] = abRefFactors();
        return { x: box.x + hx * box.width, y: box.y + vy * box.height, width: box.width, height: box.height };
    };

    window.applyArtboardPropertyEdit = (field, value, isScrubbing = false) => {
        const box = abReadBox();
        const v = parseFloat(value);
        if (!box || !Number.isFinite(v)) { if (!isScrubbing) abFieldGesture = null; return false; }
        const [hx, vy] = abRefFactors();
        const next = { x: box.x, y: box.y, width: box.width, height: box.height };

        // X / Y reposition the artboard so the reference anchor lands on `v` (box.width/height don't
        // drift during an X/Y scrub, so `box` is a stable baseline here). Contents stay fixed on
        // screen -> pan compensates the viewBox-origin shift.
        if (field === 'x') {
            if (!isScrubbing) abFieldGesture = null;
            next.x = v - hx * box.width;
            viewPanX += (next.x - box.x) * viewScale;
            return abWriteBox(next, isScrubbing);
        }
        if (field === 'y') {
            if (!isScrubbing) abFieldGesture = null;
            next.y = v - vy * box.height;
            viewPanY += (next.y - box.y) * viewScale;
            return abWriteBox(next, isScrubbing);
        }

        if (field !== 'width' && field !== 'height') { if (!isScrubbing) abFieldGesture = null; return false; }
        if (v < AB_MIN_SIZE) { if (!isScrubbing) abFieldGesture = null; return false; }

        // Width / Height: `next` dimensions (incl. the proportional-constrain partner) and the content
        // anchor/scale are computed from the pre-gesture `base`, while the incremental origin + pan
        // deltas use the current `box` -- keeping the reference anchor fixed on screen across the scrub.
        if (isScrubbing && !abFieldGesture) abFieldGesture = { x: box.x, y: box.y, width: box.width, height: box.height };
        const base = abFieldGesture || box;
        const constrain = !!(window.getPropConstrain?.());
        if (field === 'width') {
            next.width = v;
            if (constrain && base.height > 1e-6) next.height = base.height * (v / base.width);
        } else {
            next.height = v;
            if (constrain && base.width > 1e-6) next.width = base.width * (v / base.height);
        }

        const dw = next.width - box.width;
        const dh = next.height - box.height;
        next.x = box.x - hx * dw;
        next.y = box.y - vy * dh;
        viewPanX += (0.5 - hx) * dw * viewScale;
        viewPanY += (0.5 - vy) * dh * viewScale;

        let ok;
        if (scaleContentsWithArtboard) {
            const sx = base.width > 1e-6 ? next.width / base.width : 1;
            const sy = base.height > 1e-6 ? next.height / base.height : 1;
            const ax = base.x + hx * base.width, ay = base.y + vy * base.height;
            abSetBoxAttrs(next);
            if (isScrubbing) { window.previewScaleAllContent?.(ax, ay, sx, sy); ok = true; }
            else { window.commitScaleAllContent?.(ax, ay, sx, sy); window.syncPngDimensions?.(); ok = true; }
        } else {
            ok = abWriteBox(next, isScrubbing);
        }
        if (!isScrubbing) abFieldGesture = null;
        return ok;
    };

    // Align the artboard onto its contents (move only; artwork stays put). Measures the live preview
    // ink-wrapper bbox (content coords) and repositions the frame to the requested edge/center.
    window.alignArtboardToContent = (mode) => {
        const box = abReadBox();
        if (!box) return false;
        const svg = previewArea.querySelector(PREVIEW_SVG_SELECTOR);
        const wrap = svg && svg.querySelector('#ink-wrapper');
        if (!wrap) return false;
        let bb;
        try { bb = wrap.getBBox(); } catch (_) { return false; }
        if (!(bb.width > 0) && !(bb.height > 0)) return false;

        const next = { x: box.x, y: box.y, width: box.width, height: box.height };
        if (mode === 'left') next.x = bb.x;
        else if (mode === 'hcenter') next.x = bb.x + bb.width / 2 - box.width / 2;
        else if (mode === 'right') next.x = bb.x + bb.width - box.width;
        else if (mode === 'top') next.y = bb.y;
        else if (mode === 'vcenter') next.y = bb.y + bb.height / 2 - box.height / 2;
        else if (mode === 'bottom') next.y = bb.y + bb.height - box.height;
        else return false;

        const dx = next.x - box.x, dy = next.y - box.y;
        if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9) return false;
        viewPanX += dx * viewScale;   // contents fixed on screen (reposition)
        viewPanY += dy * viewScale;
        const ok = abWriteBox(next, false);
        window.refreshElementProperties?.();
        return ok;
    };

    document.addEventListener('keydown', (e) => {
        // Shift+O selects the Artboard tool (Illustrator) -- inert in text fields / eyedropper / no artboard.
        if ((e.key === 'o' || e.key === 'O') && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey && !e.repeat
            && !abActive && globalOptimizedSvg && !isTextInputFocused() && !isEyedropperMode) {
            e.preventDefault();
            window.toggleArtboardTool();
            return;
        }
        if (e.key !== 'Escape' || !abActive) return;
        if (abDrag) { e.preventDefault(); abCancelDrag(); return; }
        if (!isEyedropperMode) abDeactivate();
    });

})();
