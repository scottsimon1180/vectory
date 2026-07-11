/* fileName: new-artboard.js */

/* New Artboard dialog: lets the user start a blank document without importing an SVG.
   Building reuses the import pipeline -- a minimal blank <svg> string is fed through
   window.processSVG(), so layers/render/fit/PNG-sizing/shape-tool enabling all run as
   if a file was pasted. Self-contained IIFE wired at load (like the canvas tool files). */
(() => {

    const overlay = document.getElementById('newArtboardOverlay');
    if (!overlay) return;

    const wInput     = document.getElementById('naWidth');
    const hInput     = document.getElementById('naHeight');
    const preview    = document.getElementById('naPreview');
    const previewDims = document.getElementById('naPreviewDims');
    const presets    = document.getElementById('naPresets');
    const footer     = document.getElementById('naFooter');
    const confirmBox = document.getElementById('naConfirm');
    const createBtn  = document.getElementById('naCreateBtn');
    const trigger    = document.getElementById('btnNewArtboard');
    const constrainBtn = document.getElementById('naConstrain');

    const MIN = 1, MAX = 10000, PREVIEW_MAX = 132;

    // Constrain-proportions link: when on, editing one dimension scales the other to hold naRatio.
    let naLinked = false, naRatio = 1;
    const syncLinked = (src) => {
        if (!naLinked || !naRatio) return;
        if (src === 'w') {
            const w = parseFloat(wInput.value);
            if (isFinite(w) && w > 0) hInput.value = Math.min(MAX, Math.max(MIN, Math.round(w / naRatio)));
        } else {
            const h = parseFloat(hInput.value);
            if (isFinite(h) && h > 0) wInput.value = Math.min(MAX, Math.max(MIN, Math.round(h * naRatio)));
        }
    };

    const clampVal = (v) => {
        const n = Math.round(parseFloat(v));
        if (!isFinite(n)) return null;
        return Math.min(MAX, Math.max(MIN, n));
    };

    const currentDims = () => ({ w: clampVal(wInput.value), h: clampVal(hInput.value) });

    // Live proportional preview rect + dims caption; disables Create on invalid input.
    const updatePreview = () => {
        const { w, h } = currentDims();
        if (!w || !h) {
            preview.style.width = preview.style.height = '0px';
            previewDims.textContent = '—';
            createBtn.disabled = true;
            return;
        }
        createBtn.disabled = false;
        let pw, ph;
        if (w >= h) { pw = PREVIEW_MAX; ph = PREVIEW_MAX * (h / w); }
        else { ph = PREVIEW_MAX; pw = PREVIEW_MAX * (w / h); }
        preview.style.width = `${pw}px`;
        preview.style.height = `${ph}px`;
        previewDims.textContent = `${w} × ${h}`;
        presets.querySelectorAll('.na-preset').forEach(btn => {
            btn.classList.toggle('active', (+btn.dataset.w === w && +btn.dataset.h === h));
        });
    };

    const resetConfirm = () => {
        if (confirmBox) confirmBox.hidden = true;
        if (footer) footer.hidden = false;
    };

    window.openNewArtboard = () => {
        resetConfirm();
        overlay.hidden = false;
        updatePreview();
        requestAnimationFrame(() => { wInput.focus(); wInput.select(); });
    };

    window.closeNewArtboard = () => {
        if (overlay.hidden) return;
        overlay.hidden = true;
        resetConfirm();
        if (trigger) trigger.focus();
    };

    // Feed a blank artboard through the import pipeline.
    const buildBlankArtboard = (w, h) => {
        if (!w || !h) return;
        inputStr.value = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}"></svg>`;
        window.setHistoryLabel?.('New Artboard', 'plus');
        window.processSVG();
        window.closeNewArtboard();
    };

    // Fixed-size shortcut: intentionally skips both the dialog and loaded-artwork warning.
    window.createQuickArtboard = () => buildBlankArtboard(1024, 1024);

    // Create: when artwork is already loaded, ask to confirm before discarding it.
    window.confirmNewArtboard = () => {
        const { w, h } = currentDims();
        if (!w || !h) return;
        if (globalOptimizedSvg) {
            if (footer) footer.hidden = true;
            if (confirmBox) confirmBox.hidden = false;
            return;
        }
        buildBlankArtboard(w, h);
    };

    window.commitNewArtboard = () => {
        const { w, h } = currentDims();
        buildBlankArtboard(w, h);
    };
    window.cancelReplaceArtboard = () => resetConfirm();

    wInput.addEventListener('input', () => { syncLinked('w'); updatePreview(); });
    hInput.addEventListener('input', () => { syncLinked('h'); updatePreview(); });
    [wInput, hInput].forEach(inp => {
        inp.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); window.confirmNewArtboard(); }
        });
    });

    if (constrainBtn) {
        constrainBtn.addEventListener('click', () => {
            naLinked = !naLinked;
            constrainBtn.setAttribute('aria-pressed', naLinked ? 'true' : 'false');
            if (naLinked) {
                const { w, h } = currentDims();
                if (w && h) naRatio = w / h;
            }
        });
    }

    presets.addEventListener('click', (e) => {
        const btn = e.target.closest('.na-preset');
        if (!btn) return;
        wInput.value = btn.dataset.w;
        hInput.value = btn.dataset.h;
        if (naLinked) naRatio = (+btn.dataset.w) / (+btn.dataset.h);
        updatePreview();
    });

    overlay.addEventListener('pointerdown', (e) => { if (e.target === overlay) window.closeNewArtboard(); });

    // Modal Escape: handled in the capture phase so an open dialog swallows Escape before the
    // canvas tools' / eyedropper's document listeners can act on it. Backs out of the confirm
    // step first, otherwise closes. Other keys (e.g. Enter) propagate normally to the inputs.
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape' || overlay.hidden) return;
        e.stopImmediatePropagation();
        e.preventDefault();
        if (confirmBox && !confirmBox.hidden) { resetConfirm(); return; }
        window.closeNewArtboard();
    }, true);

})();
