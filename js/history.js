/* fileName: history.js */

// --- Undo / Redo history ---------------------------------------------------------------------
// Snapshot-based document history. Every committed (non-scrubbing) renderOutput() funnels through
// commitHistoryEntry(), which serializes globalOptimizedSvg and pushes an entry only when the
// document actually changed. Because every document mutation must already end in a
// renderOutput(false) commit, any current or future tool is history-enabled with no per-tool
// integration. View state (zoom/pan), tool choice, and export options live outside
// globalOptimizedSvg, so they never create entries. Full behavior notes: docs/history.md.

const HISTORY_LIMIT = 100;

let historyStack = [];       // { svg: string, sel: { panel: [], lastClicked, edit: [] } }
let historyIndex = -1;       // historyStack[historyIndex] mirrors the current document
let historyRestoring = false;
let historyPointerDepth = 0; // >0 while any pointer is down -- undo/redo mid-gesture is unsafe
let pendingHistoryLabel = null; // { label, icon } hint for the next committed entry; consumed on commit

const historySerializer = new XMLSerializer();

const updateHistoryButtons = () => {
    const u = $('btnUndo'), r = $('btnRedo');
    if (u) u.disabled = historyIndex <= 0;
    if (r) r.disabled = historyIndex >= historyStack.length - 1;
    window.renderHistoryPanel?.();   // keep the floating History panel in sync on every stack change
};

// Operations tag their upcoming commit with a human label + icon (bare id, e.g. 'pen-tool') right
// before the committing renderOutput(false); commitHistoryEntry consumes it. Untagged commits fall
// back to the active canvas tool, then a generic default. Icons are ids from js/ICONS (linked).js.
window.setHistoryLabel = (label, icon) => { pendingHistoryLabel = { label, icon }; };

const activeToolHistoryMeta = () => {
    const c = previewArea && previewArea.classList;
    if (!c) return null;
    if (c.contains('pen-active')) return { label: 'Pen', icon: 'pen-tool' };
    if (c.contains('dsel-active')) return { label: 'Edit Path', icon: 'direct-selection' };
    if (c.contains('sel-active')) return { label: 'Transform', icon: 'selection-tool' };
    if (c.contains('artboard-active')) return { label: 'Resize Artboard', icon: 'artboard-tool' };
    if (c.contains('shape-active')) return { label: 'Draw Shape', icon: 'rect-tool' };
    return null;
};

// Selection at commit time (object level: layer-panel cards + canvas edit selection). Direct
// Selection anchor-level state is deliberately not recorded -- it caches per-anchor models that
// cannot survive a document swap.
const captureHistorySelection = () => ({
    panel: [...selectedLayerIndex],
    lastClicked: lastClickedLayerIndex,
    edit: editSelectedIndices.size ? [...editSelectedIndices]
        : (editSelectedIndex != null ? [String(editSelectedIndex)] : [])
});

window.commitHistoryEntry = () => {
    if (!globalOptimizedSvg || historyRestoring) return;
    const svg = historySerializer.serializeToString(globalOptimizedSvg);
    const hint = pendingHistoryLabel; pendingHistoryLabel = null; // consume on every committed render
    if (historyIndex >= 0 && historyStack[historyIndex].svg === svg) return;
    const baseline = historyIndex < 0;
    const meta = hint || activeToolHistoryMeta() ||
        (baseline ? { label: 'Open', icon: 'folder' } : { label: 'Edit', icon: 'selection-tool' });
    historyStack.length = historyIndex + 1; // a new change discards the redo tail
    historyStack.push({ svg, sel: captureHistorySelection(), label: meta.label, icon: meta.icon });
    if (historyStack.length > HISTORY_LIMIT) historyStack.shift();
    historyIndex = historyStack.length - 1;
    updateHistoryButtons();
};

// New file loaded (processSVG) or document cleared: wipe the stacks. processSVG's own
// renderOutput() then pushes the fresh document as the baseline entry.
window.resetHistory = () => {
    historyStack = [];
    historyIndex = -1;
    updateHistoryButtons();
};

const restoreHistoryEntry = (entry) => {
    historyRestoring = true;
    const parsed = new DOMParser().parseFromString(entry.svg, 'image/svg+xml').documentElement;
    globalOptimizedSvg = document.importNode(parsed, true);
    // Drop tool chrome that caches geometry of the replaced document (tools stay on). The pen's
    // in-progress path ends cleanly instead of desyncing; Direct Selection loses its anchor
    // highlights but the object-level selection is restored below.
    window.clearPenToolState?.();
    window.clearDirectSelectionToolLock?.();
    if (strokeDropdown) strokeDropdown.style.display = 'none';
    buildLayersPanel();
    const alive = idx => idx != null && !!globalOptimizedSvg.querySelector(`[data-pf-index="${idx}"]`);
    const edit = entry.sel.edit.filter(alive);
    const panel = entry.sel.panel.filter(alive);
    window.setEditSelectionSet?.(edit);
    renderOutput(false);
    window.clearArtboardToolState?.();       // no drag to cancel -- re-syncs handles to the restored viewBox
    window.adoptCanvasSelection?.(edit);     // Selection-tool chrome (no-op while the tool is off)
    window.setLayerSelectionSet?.(panel);    // after adopt -- adopt mirrors edit into the panel
    lastClickedLayerIndex = alive(entry.sel.lastClicked) ? entry.sel.lastClicked : null;
    // Re-anchor the stored string to the live document so the next no-op render still dedupes
    // even if parse -> serialize round-tripping reformats anything.
    entry.svg = historySerializer.serializeToString(globalOptimizedSvg);
    window.syncPngDimensions?.();
    window.updateAllScrollbars();
    historyRestoring = false;
};

window.undoHistory = () => {
    if (historyPointerDepth > 0 || historyIndex <= 0) return;
    historyIndex--;
    restoreHistoryEntry(historyStack[historyIndex]);
    updateHistoryButtons();
};

window.redoHistory = () => {
    if (historyPointerDepth > 0 || historyIndex < 0 || historyIndex >= historyStack.length - 1) return;
    historyIndex++;
    restoreHistoryEntry(historyStack[historyIndex]);
    updateHistoryButtons();
};

// Read-only view for the History panel (js/history-panel.js): the live entry list + current index.
window.getHistoryState = () => ({ entries: historyStack, index: historyIndex });

// Jump straight to any entry (Adobe-style click on a history row). Same pointer-depth guard as
// undo/redo; restores that snapshot and moves the current pointer to it.
window.jumpHistory = (i) => {
    if (historyPointerDepth > 0) return;
    if (i < 0 || i >= historyStack.length || i === historyIndex) return;
    historyIndex = i;
    restoreHistoryEntry(historyStack[historyIndex]);
    updateHistoryButtons();
};

// Ctrl+Z undo / Ctrl+Shift+Z redo (registered in docs/keyboard-shortcuts.md). Stands down inside
// text fields so native input undo keeps working.
document.addEventListener('keydown', (e) => {
    if (!e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key !== 'z' && e.key !== 'Z') return;
    if (isTextInputFocused()) return;
    e.preventDefault();
    if (e.shiftKey) window.redoHistory(); else window.undoHistory();
});

// Undo/redo while a pointer gesture is mid-flight would yank the document out from under the
// active drag; both actions stand down until every pointer is released.
window.addEventListener('pointerdown', () => { historyPointerDepth++; }, true);
window.addEventListener('pointerup', () => { historyPointerDepth = Math.max(0, historyPointerDepth - 1); }, true);
window.addEventListener('pointercancel', () => { historyPointerDepth = Math.max(0, historyPointerDepth - 1); }, true);
window.addEventListener('blur', () => { historyPointerDepth = 0; });
