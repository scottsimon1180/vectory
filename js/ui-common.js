/* fileName: ui-common.js */

// ==========================================

// Centralized Popup Engine

// ==========================================

let strokeDropdown = $('strokeDropdownWrap');



if (!strokeDropdown) {

    strokeDropdown = document.createElement('div');

    strokeDropdown.className = 'stroke-dropdown';

    strokeDropdown.id = 'strokeDropdownWrap';

    document.body.appendChild(strokeDropdown);



    document.addEventListener('pointerdown', e => {

        if (strokeDropdown.style.display === 'block' && !strokeDropdown.contains(e.target) && !e.target.closest('.cp-stroke-dd-btn')) {

            strokeDropdown.style.display = 'none';

        }

    });

}



// ==========================================

// Reusable Custom Scrollbar Engine

// ==========================================

const initCustomScroll = (contentEl, wrapEl, opts = {}) => {

    if (!contentEl || !wrapEl) return () => {};

    const track = wrapEl.querySelector('.custom-scroll-track');

    const thumb = wrapEl.querySelector('.custom-scroll-thumb');

    if (!track || !thumb) return () => {};



    let scrollTimeout, isDraggingScroll = false, scrollStartY = 0, scrollStartTop = 0;
    let scrollAnimFrame = 0, scrollTargetTop = 0, dragFrame = 0, dragTargetTop = 0;
    const trackEndInset = opts.endInset || 0;



    const hasScrollableOverflow = () => contentEl.scrollHeight > contentEl.clientHeight + 1 && contentEl.clientHeight > 0;



    const shouldSmoothScroll = () => {

        return !!opts.smooth && !(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

    };



    const maxScrollTop = () => Math.max(0, contentEl.scrollHeight - contentEl.clientHeight);



    const clampScrollTop = (top) => Math.max(0, Math.min(maxScrollTop(), top));



    const stopSmoothScroll = () => {

        if (scrollAnimFrame) cancelAnimationFrame(scrollAnimFrame);

        scrollAnimFrame = 0;

        scrollTargetTop = contentEl.scrollTop;

    };



    const animateScrollTo = (top, smooth) => {

        const nextTop = clampScrollTop(top);

        if (!smooth || !shouldSmoothScroll()) {

            stopSmoothScroll();

            contentEl.scrollTop = nextTop;

            updateScroll();

            return;

        }

        scrollTargetTop = nextTop;

        if (scrollAnimFrame) return;

        const tick = () => {

            const delta = scrollTargetTop - contentEl.scrollTop;

            if (Math.abs(delta) <= 2) {

                contentEl.scrollTop = scrollTargetTop;

                scrollAnimFrame = 0;

                updateScroll();

                return;

            }

            contentEl.scrollTop += delta * 0.28;

            updateScroll();

            scrollAnimFrame = requestAnimationFrame(tick);

        };

        scrollAnimFrame = requestAnimationFrame(tick);

    };



    const setScrollableState = (canScroll) => {

        track.classList.toggle('is-scrollable', canScroll);

        track.style.pointerEvents = canScroll ? 'auto' : 'none';

        if (canScroll) {

            thumb.style.opacity = '';

            return;

        }

        clearTimeout(scrollTimeout);

        stopSmoothScroll();

        track.classList.remove('is-active', 'is-hovered');

        thumb.style.opacity = '';

        thumb.style.height = '0px';

        thumb.style.transform = 'translateY(0)';

    };



    const updateScroll = () => {

        const sh = contentEl.scrollHeight, ch = contentEl.clientHeight, th = track.clientHeight;

        const canScroll = sh > ch + 1 && ch > 0 && th > 0;

        setScrollableState(canScroll);

        if (!canScroll) return;

        const ratio = ch / sh;

        const thumbLaneH = Math.max(1, th - (trackEndInset * 2));

        const minThumbH = Math.min(36, thumbLaneH);

        const thumbH = Math.min(thumbLaneH, Math.max(minThumbH, thumbLaneH * ratio));

        thumb.style.height = `${thumbH}px`;

        const maxScroll = sh - ch;

        const maxThumbY = Math.max(0, thumbLaneH - thumbH); 

        const thumbY = trackEndInset + (maxScroll > 0 ? (contentEl.scrollTop / maxScroll) * maxThumbY : 0);

        thumb.style.transform = `translateY(${thumbY}px)`;

    };



    const showScroll = () => {

        if (!hasScrollableOverflow()) return;

        track.classList.add('is-active');

        clearTimeout(scrollTimeout);

        scrollTimeout = setTimeout(() => {

            if (!isDraggingScroll && !track.classList.contains('is-hovered')) {

                track.classList.remove('is-active');

            }

        }, 800);

    };



    contentEl.addEventListener('scroll', () => { 

        if (!scrollAnimFrame && !isDraggingScroll) scrollTargetTop = contentEl.scrollTop;

        updateScroll(); 

        showScroll();

        strokeDropdown.style.display = 'none';

    }, { passive: true });

    const scrollResizeObserver = new ResizeObserver(updateScroll);

    scrollResizeObserver.observe(contentEl);

    scrollResizeObserver.observe(wrapEl);



    wrapEl.addEventListener('wheel', (e) => {

        if (!hasScrollableOverflow()) return;

        let deltaY = e.deltaY;

        if (e.deltaMode === 1) deltaY *= 16;

        else if (e.deltaMode === 2) deltaY *= contentEl.clientHeight;

        if (!deltaY) return;

        const originTop = scrollAnimFrame ? scrollTargetTop : contentEl.scrollTop;

        const nextTop = clampScrollTop(originTop + deltaY);

        if (nextTop === originTop) return;

        animateScrollTo(nextTop, true);

        showScroll();

        e.preventDefault();

    }, { passive: false });



    track.addEventListener('pointerenter', () => {

        if (hasScrollableOverflow()) track.classList.add('is-hovered');

    });

    

    track.addEventListener('pointerleave', () => {

        track.classList.remove('is-hovered');

        showScroll();

    });



    track.addEventListener('pointerdown', (e) => {

        if (e.target === thumb || !hasScrollableOverflow()) return;

        const thumbRect = thumb.getBoundingClientRect();

        const direction = e.clientY < thumbRect.top ? -1 : 1;

        const originTop = scrollAnimFrame ? scrollTargetTop : contentEl.scrollTop;

        animateScrollTo(originTop + direction * contentEl.clientHeight * 0.85, true);

        showScroll();

        e.preventDefault();

    });



    thumb.addEventListener('pointerdown', (e) => {

        stopSmoothScroll();

        isDraggingScroll = true; scrollStartY = e.clientY; scrollStartTop = contentEl.scrollTop;

        dragTargetTop = scrollStartTop;

        track.classList.add('is-active');

        thumb.setPointerCapture(e.pointerId);

        document.body.classList.add('is-dragging');

        e.preventDefault();

    });



    thumb.addEventListener('pointermove', (e) => {

        if (!isDraggingScroll) return;

        const sh = contentEl.scrollHeight, ch = contentEl.clientHeight, th = track.clientHeight;

        const maxScroll = sh - ch;

        const maxThumbY = Math.max(1, th - (parseFloat(thumb.style.height) || 0) - (trackEndInset * 2));

        const deltaY = e.clientY - scrollStartY;

        const scrollDelta = (deltaY / maxThumbY) * maxScroll;

        dragTargetTop = clampScrollTop(scrollStartTop + scrollDelta);

        if (dragFrame) return;

        dragFrame = requestAnimationFrame(() => {

            dragFrame = 0;

            contentEl.scrollTop = dragTargetTop;

            updateScroll();

        });

    });



    const stopScrollDrag = (e) => {

        if (!isDraggingScroll) return;

        isDraggingScroll = false;

        if (dragFrame) {

            cancelAnimationFrame(dragFrame);

            dragFrame = 0;

            contentEl.scrollTop = dragTargetTop;

            updateScroll();

        }

        scrollTargetTop = contentEl.scrollTop;

        try { thumb.releasePointerCapture(e.pointerId); } catch(err) {}

        document.body.classList.remove('is-dragging');

        track.classList.remove('is-active');

        showScroll();

    };

    

    window.addEventListener('pointerup', stopScrollDrag);

    window.addEventListener('pointercancel', stopScrollDrag);



    return updateScroll;

};



const mainPanelScrollOptions = { smooth: true, endInset: 14 };

const updateLayersScroll = initCustomScroll(layersList, layersWrap, mainPanelScrollOptions);

const updateImportScroll = initCustomScroll(inputStr, $('importWrap'), mainPanelScrollOptions);

const updateExportScroll = initCustomScroll(outputStr, $('exportWrap'), mainPanelScrollOptions);

const updatePropertiesScroll = initCustomScroll($('propertiesScroll'), $('propertiesWrap'), mainPanelScrollOptions);



window.updateAllScrollbars = () => {

    updateLayersScroll();

    updateImportScroll();

    updateExportScroll();

    updatePropertiesScroll();

};



// ==========================================

// Workspace Resizer (top group <-> bottom group)

// ==========================================

(() => {

    const resizer = $('wsResizer');

    const wrapper = document.querySelector('.layout-wrapper');

    if (!resizer || !wrapper) return;



    // The app header is outside this wrapper, so the top workspace can collapse completely.
    const WS_MIN_TOP = 0, WS_KEY = 'pf_wsSplit';

    let isResizing = false, startY = 0, startTopH = 0, total = 0, currentF = 0, rafId = 0, pendingY = 0;



    // The bottom group's floor is dynamic: each I/O panel may shrink only until the top of

    // its text field (#importWrap / #exportWrap, or #pngExportWrap in PNG mode) would hide --

    // i.e. the header + controls strip stays. That height varies with control wrapping and

    // export mode, so measure it from the live layout (the taller of the two panels wins).

    let wsMinBottom = 120;

    const computeBottomMin = () => {

        let m = 0;

        document.querySelectorAll('.io-grid > .panel').forEach(panel => {

            const pTop = panel.getBoundingClientRect().top;

            panel.querySelectorAll('.textarea-wrap, .png-framed-wrap').forEach(f => {

                if (f.offsetParent === null) return;   // skip the hidden (inactive) export field

                const off = f.getBoundingClientRect().top - pTop;

                if (off > m) m = off;

            });

        });

        return m > 0 ? Math.ceil(m) + 12 : 0;          // + the panel's bottom padding so the field top stays in view

    };



    // Condensed floor: dragging past the two-row floor merges the controls strip into the
    // header row (.io-condensed on .io-grid), so each panel bottoms out at a single row --
    // the tallest control + the panel's 12px top/bottom padding.

    let wsOneRowMin = 54, wsCondensed = false;

    const computeOneRowMin = () => {

        let m = 0;

        document.querySelectorAll('.io-grid > .panel > .controls > *').forEach(el => {

            if (el.offsetHeight > m) m = el.offsetHeight;

        });

        return m > 0 ? m + 24 : 54;

    };

    // The merge offsets depend on live label/control sizes. All reads use offset* layout
    // geometry (and a text Range for the label), which ignores the merge transforms -- so a
    // measurement taken mid-animation, or while already condensed, is still exact.

    const measureCondenseVars = () => {

        document.querySelectorAll('.io-grid > .panel').forEach(panel => {

            const row = panel.querySelector(':scope > .panel-header-row') || panel.querySelector(':scope > .panel-header');

            const ctl = panel.querySelector(':scope > .controls');

            if (!row || !ctl) return;

            let ctlH = 0;

            for (const child of ctl.children) ctlH = Math.max(ctlH, child.offsetHeight);

            panel.style.setProperty('--io-row-dy', ((ctlH - row.offsetHeight) / 2).toFixed(1) + 'px');   // header drops to the merged row's center

            panel.style.setProperty('--io-ctl-dy', (row.offsetTop - ctl.offsetTop) + 'px');              // controls rise onto the header row

            const label = panel.querySelector('.panel-header');

            if (label) {

                // The import header is a block h3 whose box spans the whole panel -- measure the text itself.

                const range = document.createRange();

                range.selectNodeContents(label);

                panel.style.setProperty('--io-ctl-pl', Math.ceil(range.getBoundingClientRect().width + 12) + 'px');

            }

            const radios = panel.querySelector('.export-format-toggle');

            if (radios) panel.style.setProperty('--io-ctl-pr', (radios.offsetWidth + 12) + 'px');

        });

    };

    const setCondensed = (on) => {

        if (on === wsCondensed) return;

        wsCondensed = on;

        bottomEl.classList.toggle('io-condensed', on);

        const copyBtn = $('btnCopyExport');

        if (copyBtn && !copyBtn.classList.contains('btn-success')) {      // mid-"Copied!" flashes restore the right label themselves

            const span = copyBtn.querySelector('span');

            if (span) span.textContent = on ? 'Copy Code' : 'Copy to Clipboard';

        }

    };



    const refreshBottomMin = () => {

        const min = computeBottomMin();

        if (min > 0) wsMinBottom = min;

        wsOneRowMin = computeOneRowMin();

        measureCondenseVars();

        if (!isResizing) wrapper.style.setProperty('--ws-bottom-min', (wsCondensed ? wsOneRowMin : wsMinBottom) + 'px');

    };

    // The min-height floor isn't transitioned, so raising it back to the two-row value while
    // the flex ease is still running would pop the grid taller. Restore it just after the ease.

    let wsFloorTimer = 0;

    const scheduleFloorRestore = () => {

        clearTimeout(wsFloorTimer);

        wsFloorTimer = setTimeout(() => {

            if (!isResizing) wrapper.style.setProperty('--ws-bottom-min', (wsCondensed ? wsOneRowMin : wsMinBottom) + 'px');

        }, 300);

    };



    const topEl = wrapper.querySelector('.panel');

    const bottomEl = wrapper.querySelector('.io-grid');



    // f = top group's share of the flexible height (0..1). Drives both flex-grow vars.

    const applySplit = (f) => {

        document.documentElement.classList.toggle('ws-top-collapsed', f <= WS_MIN_TOP);

        wrapper.style.setProperty('--ws-top', f);

        wrapper.style.setProperty('--ws-bottom', 1 - f);

    };



    // Restore persisted split. The before-paint head script in index.html already set --ws-top/
    // --ws-bottom on documentElement (so the first paint is correct with no flash); this mirrors
    // those values onto the wrapper inline style so drag/reset stay consistent with the rest here.

    const saved = parseFloat(localStorage.getItem(WS_KEY));

    if (saved >= 0 && saved < 1) applySplit(saved);



    refreshBottomMin();



    // A split saved while condensed asks for less than the two-row floor -- re-enter the
    // condensed state before first paint (min-height would otherwise clamp the grid taller)
    // and re-pin the split exactly shut for this window size.

    if (saved >= 0 && saved < 1) {

        const flexH = topEl.getBoundingClientRect().height + bottomEl.getBoundingClientRect().height;

        if ((1 - saved) * flexH < wsMinBottom - 2) {

            setCondensed(true);

            wrapper.style.setProperty('--ws-bottom-min', wsOneRowMin + 'px');

            if (flexH > WS_MIN_TOP + wsOneRowMin) applySplit((flexH - wsOneRowMin) / flexH);

        }

    }



    // Control rows can re-wrap when the window width changes, moving where the fields start.
    // A condensed dock stays pinned shut through window/fullscreen changes: the flex shares
    // scale with the window, so re-derive the split and commit it without the ease.

    let wsResizeRaf = 0;

    window.addEventListener('resize', () => {

        if (wsResizeRaf) return;

        wsResizeRaf = requestAnimationFrame(() => {

            wsResizeRaf = 0;

            if (isResizing) return;

            refreshBottomMin();

            if (!wsCondensed) return;

            const flexH = topEl.getBoundingClientRect().height + bottomEl.getBoundingClientRect().height;

            if (flexH <= WS_MIN_TOP + wsOneRowMin) return;

            const f = (flexH - wsOneRowMin) / flexH;

            wrapper.classList.add('is-resizing');

            applySplit(f);

            void bottomEl.offsetHeight;                      // commit transition-free

            wrapper.classList.remove('is-resizing');

            localStorage.setItem(WS_KEY, f);

        });

    });



    const commitFrame = () => {

        rafId = 0;

        const newTop = Math.max(WS_MIN_TOP, Math.min(total - wsOneRowMin, startTopH + (pendingY - startY)));

        currentF = newTop / total;

        applySplit(currentF);

        // Crossing the two-row floor merges the controls into the header row (and back).
        // The 8px hysteresis band keeps pointer jitter from flapping the state.

        const bottomH = total - newTop;

        if (!wsCondensed && bottomH < wsMinBottom - 8) setCondensed(true);

        else if (wsCondensed && bottomH > wsMinBottom + 8) setCondensed(false);

    };



    resizer.addEventListener('pointerdown', (e) => {

        refreshBottomMin();                                  // measure the field-start floor for the current layout/mode

        const topH = topEl.getBoundingClientRect().height;

        const total0 = topH + bottomEl.getBoundingClientRect().height;

        if (total0 <= WS_MIN_TOP + wsOneRowMin) return;   // not enough room to resize

        isResizing = true;

        startY = e.clientY; startTopH = topH; total = total0; currentF = topH / total0;

        isWorkspaceResizing = true;                          // canvas refits transition-free while dragging

        wrapper.classList.add('is-resizing');

        // Re-anchor the shares to the measured layout and free the floor to the one-row value
        // for the whole drag -- commitFrame's clamp owns the limit, so the height tracks the
        // pointer 1:1 with no stick-then-jump when the min-height would otherwise swap mid-drag.

        applySplit(currentF);

        wrapper.style.setProperty('--ws-bottom-min', wsOneRowMin + 'px');

        resizer.classList.add('is-active');

        document.body.classList.add('is-resizing-ws');

        resizer.setPointerCapture(e.pointerId);

    });



    resizer.addEventListener('pointermove', (e) => {

        if (!isResizing) return;

        pendingY = e.clientY;

        if (!rafId) rafId = requestAnimationFrame(commitFrame);

    });



    const stopResize = (e) => {

        if (!isResizing) return;

        isResizing = false;

        if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }

        isWorkspaceResizing = false;

        wrapper.classList.remove('is-resizing');

        resizer.classList.remove('is-active');

        document.body.classList.remove('is-resizing-ws');

        try { resizer.releasePointerCapture(e.pointerId); } catch (err) {}

        // A release between the two floors settles to the nearest one (the flex-grow
        // transition is live again here), so the panels never rest half-merged.

        if (total > 0) {

            const bottomH = total - currentF * total;

            if (bottomH > wsOneRowMin + 1 && bottomH < wsMinBottom - 1) {

                if (bottomH < (wsOneRowMin + wsMinBottom) / 2) { setCondensed(true); currentF = (total - wsOneRowMin) / total; }

                else { setCondensed(false); currentF = (total - wsMinBottom) / total; }

                applySplit(currentF);

            }

            // Released just above the two-row floor with the hysteresis band still merged:
            // the height already fits two rows, so only the rows need to part.

            else if (wsCondensed && bottomH >= wsMinBottom - 1) setCondensed(false);

        }

        scheduleFloorRestore();

        localStorage.setItem(WS_KEY, currentF);

    };



    window.addEventListener('pointerup', stopResize);

    window.addEventListener('pointercancel', stopResize);



    // Reset Workspace button + divider double-click -> default split (CSS-default 1 / 0.85),

    // animated by the flex-grow transition since .is-resizing is absent.

    window.resetWorkspace = () => {

        setCondensed(false);

        scheduleFloorRestore();

        // Reveal at the current zero share first so removing the split can animate it open.
        const wasTopCollapsed = document.documentElement.classList.contains('ws-top-collapsed');
        document.documentElement.classList.remove('ws-top-collapsed');
        if (wasTopCollapsed) void topEl.offsetHeight;

        wrapper.style.removeProperty('--ws-top');

        wrapper.style.removeProperty('--ws-bottom');

        // Also clear the before-paint values the head script set on documentElement, otherwise the

        // panels would inherit the saved split from :root instead of falling back to the default.

        document.documentElement.style.removeProperty('--ws-top');

        document.documentElement.style.removeProperty('--ws-bottom');

        localStorage.removeItem(WS_KEY);

    };

})();
