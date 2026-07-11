/* fileName: hand-tool.js */

// Canvas Hand Tool. When active, left-drag pans the preview. Middle-drag always
// gives a temporary hand-pan override, then returns to the previously selected tool.

(() => {

    let handActive = false;
    let handPanning = false;
    let handTemporary = false;
    let handPointerId = null;
    let handLastX = 0, handLastY = 0;

    const isStatusBarTarget = (el) => el && el.closest && el.closest('.canvas-statusbar');

    const handStartPan = (e, temporary) => {
        if (handPanning || !globalOptimizedSvg || isStatusBarTarget(e.target)) return;
        e.preventDefault();
        handPanning = true;
        handTemporary = !!temporary;
        handPointerId = e.pointerId;
        handLastX = e.clientX;
        handLastY = e.clientY;
        if (handTemporary) {
            window.clearSelectionToolHover?.();
            window.clearScissorsToolHover?.();
        }
        try { previewArea.setPointerCapture(e.pointerId); } catch (_) {}
        document.body.classList.add('is-panning');
    };

    const handEndPan = (e) => {
        if (!handPanning) return;
        if (e && e.pointerId != null && e.pointerId !== handPointerId) return;
        const pointerId = handPointerId;
        handPanning = false;
        handTemporary = false;
        handPointerId = null;
        try { previewArea.releasePointerCapture(pointerId); } catch (_) {}
        document.body.classList.remove('is-panning');
    };

    const handDeactivate = () => {
        handEndPan();
        handActive = false;
        const btn = $('btnHandTool');
        if (btn) btn.classList.remove('active');
        previewArea.classList.remove('hand-active');
    };

    window.deactivateHandTool = () => { if (handActive) handDeactivate(); };
    window.isHandToolPanning = () => handPanning;
    window.isHandToolTemporaryPan = () => handPanning && handTemporary;

    window.toggleHandTool = (btn) => {
        if (handActive) { handDeactivate(); return; }
        window.deactivateSelectionTool?.();
        window.deactivateDirectSelectionTool?.();
        window.deactivateArtboardTool?.();
        window.deactivateShapeTool?.();
        window.deactivatePenTool?.();
        window.deactivateScissorsTool?.();
        handActive = true;
        (btn || $('btnHandTool'))?.classList.add('active');
        previewArea.classList.add('hand-active');
    };

    previewArea.addEventListener('mousedown', (e) => {
        if (e.button === 1 && !isStatusBarTarget(e.target)) e.preventDefault();
    });

    previewArea.addEventListener('pointerdown', (e) => {
        if (window.isGuideDragActive?.()) return;
        if (e.button === 1) { handStartPan(e, true); return; }
        if (handActive && e.button === 0) handStartPan(e, false);
    });

    previewArea.addEventListener('pointermove', (e) => {
        if (window.isGuideDragActive?.()) return;
        if (!handPanning || e.pointerId !== handPointerId) return;
        viewPanX += e.clientX - handLastX;
        viewPanY += e.clientY - handLastY;
        handLastX = e.clientX;
        handLastY = e.clientY;
        window.clearViewFitMode?.();
        applyView(false);
    });

    previewArea.addEventListener('pointerup', handEndPan);
    previewArea.addEventListener('pointercancel', handEndPan);
    previewArea.addEventListener('lostpointercapture', handEndPan);

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && handActive && !isEyedropperMode) handDeactivate();
    });

})();
