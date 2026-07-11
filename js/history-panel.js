/* fileName: history-panel.js */

// --- Floating History panel ------------------------------------------------------------------
// A repositionable, height-resizable visualization of the undo/redo stack owned by js/history.js.
// The panel is pure UI: it never touches globalOptimizedSvg and is never exported or itself
// undoable. It reads the stack through window.getHistoryState(), navigates through
// window.undoHistory / redoHistory / jumpHistory, and is refreshed by window.renderHistoryPanel()
// (called from history.js's updateHistoryButtons on every stack change). Open state, position, and
// height persist in localStorage (pf_ keys). Width is fixed to the properties-panel width in CSS.
// See docs/history.md.

(() => {
    const panel = document.getElementById('historyPanel');
    const toggleBtn = document.getElementById('btnToggleHistory');
    const list = document.getElementById('historyList');
    const bar = document.getElementById('historyPanelBar');
    const grip = document.getElementById('historyPanelResize');
    const undoBtn = document.getElementById('historyUndo');
    const redoBtn = document.getElementById('historyRedo');
    if (!panel || !toggleBtn || !list) return;

    const POS_KEY = 'pf_historyPanelPos';
    const H_KEY = 'pf_historyPanelH';
    const OPEN_KEY = 'pf_historyPanelOpen';
    const MIN_H = 140, DEFAULT_H = 300, MARGIN = 6;

    const applyPos = (x, y) => { panel.style.left = x + 'px'; panel.style.top = y + 'px'; };
    const savePos = () => { try { localStorage.setItem(POS_KEY, JSON.stringify({ x: parseFloat(panel.style.left) || 0, y: parseFloat(panel.style.top) || 0 })); } catch (e) {} };
    const saveH = () => { try { localStorage.setItem(H_KEY, String(panel.offsetHeight)); } catch (e) {} };

    // Keep the panel fully on screen; a missing/invalid saved position lands it at the canvas top-right.
    const clampIntoView = () => {
        const w = panel.offsetWidth, h = panel.offsetHeight;
        const maxX = Math.max(MARGIN, window.innerWidth - w - MARGIN);
        const maxY = Math.max(MARGIN, window.innerHeight - h - MARGIN);
        let x = parseFloat(panel.style.left), y = parseFloat(panel.style.top);
        if (!isFinite(x)) x = maxX;
        if (!isFinite(y)) y = 64;
        applyPos(Math.max(MARGIN, Math.min(x, maxX)), Math.max(MARGIN, Math.min(y, maxY)));
    };

    // ---- open / close -------------------------------------------------------------------------
    const setOpen = (open, persist = true) => {
        panel.hidden = !open;
        toggleBtn.classList.toggle('is-checked', open);
        toggleBtn.setAttribute('aria-pressed', open ? 'true' : 'false');
        if (persist) { try { localStorage.setItem(OPEN_KEY, open ? '1' : '0'); } catch (e) {} }
        if (open) { clampIntoView(); window.renderHistoryPanel(); }
    };
    toggleBtn.addEventListener('click', () => setOpen(panel.hidden));

    // ---- list render --------------------------------------------------------------------------
    window.renderHistoryPanel = () => {
        if (panel.hidden) return;
        const st = window.getHistoryState && window.getHistoryState();
        if (!st) return;
        const { entries, index } = st;
        const frag = document.createDocumentFragment();
        entries.forEach((entry, i) => {
            const row = document.createElement('div');
            row.className = 'history-entry' + (i === index ? ' is-current' : '') + (i > index ? ' is-future' : '');
            // innerHTML (not createElement('svg')) so the <svg>/<use> parse into the SVG namespace and
            // resolve the sprite. entry.icon is a controlled id; the label is set via textContent.
            row.innerHTML = `<svg class="icon-svg history-entry__icon"><use href="#icon-${entry.icon}" xlink:href="#icon-${entry.icon}"></use></svg><span class="history-entry__label"></span>`;
            row.querySelector('.history-entry__label').textContent = entry.label;
            row.addEventListener('click', () => window.jumpHistory && window.jumpHistory(i));
            frag.appendChild(row);
        });
        list.replaceChildren(frag);
        if (undoBtn) undoBtn.disabled = index <= 0;
        if (redoBtn) redoBtn.disabled = index >= entries.length - 1;
        const active = list.querySelector('.history-entry.is-current');
        if (active) active.scrollIntoView({ block: 'nearest' });
    };

    if (undoBtn) undoBtn.addEventListener('click', () => window.undoHistory && window.undoHistory());
    if (redoBtn) redoBtn.addEventListener('click', () => window.redoHistory && window.redoHistory());
    const closeBtn = document.getElementById('historyClose');
    if (closeBtn) closeBtn.addEventListener('click', () => setOpen(false));

    // ---- drag to reposition (title bar) -------------------------------------------------------
    let drag = null;
    bar.addEventListener('pointerdown', (e) => {
        if (e.button !== 0 || e.target.closest('button')) return;
        drag = { dx: e.clientX - panel.offsetLeft, dy: e.clientY - panel.offsetTop, id: e.pointerId };
        bar.setPointerCapture(e.pointerId);
        document.body.classList.add('is-hist-dragging');
        e.preventDefault();
    });
    bar.addEventListener('pointermove', (e) => {
        if (!drag || e.pointerId !== drag.id) return;
        const maxX = window.innerWidth - panel.offsetWidth - MARGIN;
        const maxY = window.innerHeight - panel.offsetHeight - MARGIN;
        applyPos(Math.max(MARGIN, Math.min(e.clientX - drag.dx, maxX)), Math.max(MARGIN, Math.min(e.clientY - drag.dy, maxY)));
    });
    const endDrag = (e) => { if (!drag || e.pointerId !== drag.id) return; drag = null; document.body.classList.remove('is-hist-dragging'); savePos(); };
    bar.addEventListener('pointerup', endDrag);
    bar.addEventListener('pointercancel', endDrag);

    // ---- resize height only (bottom grip) -----------------------------------------------------
    let rs = null;
    grip.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        rs = { startY: e.clientY, startH: panel.offsetHeight, id: e.pointerId };
        grip.setPointerCapture(e.pointerId);
        document.body.classList.add('is-hist-resizing');
        e.preventDefault();
    });
    grip.addEventListener('pointermove', (e) => {
        if (!rs || e.pointerId !== rs.id) return;
        const maxH = window.innerHeight - panel.offsetTop - MARGIN;
        panel.style.height = Math.max(MIN_H, Math.min(rs.startH + (e.clientY - rs.startY), maxH)) + 'px';
    });
    const endRs = (e) => { if (!rs || e.pointerId !== rs.id) return; rs = null; document.body.classList.remove('is-hist-resizing'); saveH(); };
    grip.addEventListener('pointerup', endRs);
    grip.addEventListener('pointercancel', endRs);

    // Reposition on viewport resize so the panel can never strand off screen.
    window.addEventListener('resize', () => { if (!panel.hidden) clampIntoView(); });

    // ---- restore persisted state --------------------------------------------------------------
    const savedH = parseFloat(localStorage.getItem(H_KEY));
    panel.style.height = (savedH >= MIN_H ? savedH : DEFAULT_H) + 'px';
    try {
        const p = JSON.parse(localStorage.getItem(POS_KEY));
        if (p && isFinite(p.x) && isFinite(p.y)) applyPos(p.x, p.y);
    } catch (e) {}
    if (localStorage.getItem(OPEN_KEY) === '1') setOpen(true, false);
})();
