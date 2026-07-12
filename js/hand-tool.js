/* fileName: hand-tool.js */

// Canvas Hand Tool. When active, left-drag pans the preview. Middle-drag always
// gives a temporary hand-pan override, then returns to the previously selected tool.
// Holding Space (Illustrator-style) arms the same temporary override for left-drag:
// while held, the other tools stand down (they see isHandToolTemporaryPan() true) and
// left-drag pans; releasing Space returns control to the active tool.

(() => {

    let handActive = false;
    let handPanning = false;
    let handTemporary = false;
    let handPointerId = null;
    let handLastX = 0, handLastY = 0;
    let spaceArmed = false;         // Space held -> temporary hand-pan (like middle-drag)

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
        window.syncScissorsToolOverlay?.();
    };

    const handDeactivate = () => {
        handEndPan();
        handActive = false;
        const btn = $('btnHandTool');
        if (btn) btn.classList.remove('active');
        previewArea.classList.remove('hand-active');
        window.refreshSelectionOverlay?.();
    };

    window.deactivateHandTool = () => { if (handActive) handDeactivate(); };
    window.isHandToolPanning = () => handPanning;
    // True while a temporary pan owns the canvas: an active middle/Space-drag pan, or Space armed
    // (pan pending). The other tools' hover + pointerdown handlers check this and stand down.
    window.isHandToolTemporaryPan = () => (handPanning && handTemporary) || spaceArmed;

    window.toggleHandTool = (btn) => {
        if (handActive) return;
        window.deactivateSelectionTool?.();
        window.deactivateDirectSelectionTool?.();
        window.deactivateArtboardTool?.();
        window.deactivateShapeTool?.();
        window.deactivatePenTool?.();
        window.deactivateScissorsTool?.();
        handActive = true;
        (btn || $('btnHandTool'))?.classList.add('active');
        previewArea.classList.add('hand-active');
        window.refreshSelectionOverlay?.();
    };

    previewArea.addEventListener('mousedown', (e) => {
        if (e.button === 1 && !isStatusBarTarget(e.target)) e.preventDefault();
    });

    previewArea.addEventListener('pointerdown', (e) => {
        if (window.isGuideDragActive?.()) return;
        if (e.button === 1) { handStartPan(e, true); return; }
        if (spaceArmed && e.button === 0) { handStartPan(e, true); return; }
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
        // Space (hold) arms the temporary hand-pan from any tool (Illustrator-style). Inert in
        // text fields (typing spaces), with no artboard, or in eyedropper mode. The grab cursor
        // comes from .space-pan on #previewArea; an in-flight pan keeps running if Space lifts
        // mid-drag (control returns to the tool on pointer release).
        if (e.key === ' ' && !spaceArmed && !e.repeat && globalOptimizedSvg && !isTextInputFocused() && !isEyedropperMode) {
            e.preventDefault();
            spaceArmed = true;
            previewArea.classList.add('space-pan');
            window.clearSelectionToolHover?.();
            window.clearScissorsToolHover?.();
        }
    });

    const disarmSpacePan = () => {
        if (!spaceArmed) return;
        spaceArmed = false;
        previewArea.classList.remove('space-pan');
    };

    document.addEventListener('keyup', (e) => { if (e.key === ' ') disarmSpacePan(); });
    window.addEventListener('blur', disarmSpacePan);

})();
