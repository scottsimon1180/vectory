/* fileName: preview-renderer.js */

const applyCurrentColorToStops = (svgNode) => {
    svgNode.querySelectorAll('stop').forEach(stop => {
        let col = stop.getAttribute('stop-color');
        if (col && col !== 'none') {
            if (col.startsWith('rgba')) {
                let parts = col.match(/rgba\([^,]+,[^,]+,[^,]+,\s*([^)]+)\)/);
                if (parts && parts[1]) {
                    let alpha = parseFloat(parts[1]);
                    let currentOp = stop.getAttribute('stop-opacity');
                    stop.setAttribute('stop-opacity', currentOp ? (parseFloat(currentOp) * alpha).toString() : alpha.toString());
                }
            } else if (col.length === 9 && col.startsWith('#')) {
                let alpha = parseInt(col.slice(7, 9), 16) / 255;
                let currentOp = stop.getAttribute('stop-opacity');
                stop.setAttribute('stop-opacity', currentOp ? (parseFloat(currentOp) * alpha).toString() : alpha.toFixed(2));
            }
            stop.setAttribute('stop-color', 'currentColor');
        }
    });
};

const applyCurrentColorToSvg = (svgNode) => {
    applyCurrentColorToStops(svgNode);

    svgNode.querySelectorAll('path, circle, rect, polygon, polyline, ellipse, line').forEach(s => {
        if (s.closest('mask, clipPath')) return;   // stroke-alignment defs must keep their black/white paints
        const f = s.getAttribute('fill'), st = s.getAttribute('stroke');
        if (f && f !== 'none' && !f.startsWith('url')) s.setAttribute('fill', 'currentColor');
        if (st && st !== 'none' && !st.startsWith('url')) s.setAttribute('stroke', 'currentColor');
    });
};

/* ---- Stroke alignment (Align Stroke inner/outer) -------------------------------------------- */
// SVG has no stroke-alignment property. Shapes carry the intent as data-stroke-align="inner|outer"
// on the model (written by the Properties stroke rows, js/properties.js; absent = center). Every
// render consumes the attribute on the working clone (it never reaches export) and fakes the
// alignment: inner -> stroke-width doubled + a clip-path of the shape's own geometry (the outer
// half clips away); outer -> the stroke moves to a ghost copy inserted after the shape (no
// data-pf-index, so tools/snapping ignore it) with doubled width and a mask blanking the interior,
// while the fill stays on the original. The element's own transform maps its clip-path/mask too,
// so the geometry copies stay in local space with no transform. bboxFor supplies a local-space
// geometry bbox for the mask region (renderOutput measures the just-injected preview shape; the
// PNG builder borrows the live preview twin -- see buildExportSvgElement in export.js).

// Inner/outer alignment needs closed geometry (Illustrator greys these for open paths). A <path>
// counts when every subpath ends with an explicit Z.
const isStrokeAlignableShape = (shape) => {
    const tag = (shape.tagName || '').toLowerCase();
    if (tag === 'rect' || tag === 'circle' || tag === 'ellipse' || tag === 'polygon') return true;
    if (tag !== 'path') return false;
    const subs = (shape.getAttribute('d') || '').split(/[Mm]/).filter(s => s.trim());
    return subs.length > 0 && subs.every(s => /[Zz][\s,]*$/.test(s));
};

const STROKE_ALIGN_GEOM_ATTRS = ['d', 'points', 'x', 'y', 'width', 'height', 'rx', 'ry', 'cx', 'cy', 'r'];

const expandStrokeAlignment = (root, bboxFor) => {
    const marked = root.querySelectorAll('[data-stroke-align]');
    if (!marked.length) return;
    const createSvgEl = (tag) => document.createElementNS('http://www.w3.org/2000/svg', tag);
    let defs = null, uid = 0;
    marked.forEach(shape => {
        const align = shape.getAttribute('data-stroke-align');
        shape.removeAttribute('data-stroke-align');                    // internal flag -- never exported
        if (align !== 'inner' && align !== 'outer') return;
        const stroke = shape.getAttribute('stroke');
        if (!stroke || stroke === 'none') return;
        if (shape.hasAttribute('clip-path') || shape.hasAttribute('mask')) return;   // don't fight an imported clip/mask
        if (!isStrokeAlignableShape(shape)) return;                    // open geometry keeps a center stroke
        let wAttr = shape.getAttribute('stroke-width');
        for (let a = shape.parentNode; wAttr == null && a && a !== root.parentNode; a = a.parentNode) wAttr = a.getAttribute('stroke-width');
        const w = wAttr == null ? 1 : parseFloat(wAttr);
        if (!Number.isFinite(w) || w <= 0) return;
        const geo = createSvgEl(shape.tagName.toLowerCase());          // geometry-only copy, local space
        STROKE_ALIGN_GEOM_ATTRS.forEach(a => { if (shape.hasAttribute(a)) geo.setAttribute(a, shape.getAttribute(a)); });
        if (!defs) { defs = createSvgEl('defs'); root.insertBefore(defs, root.firstChild); }
        const id = `sa-${align}-${uid++}`;
        const evenOdd = shape.getAttribute('fill-rule') === 'evenodd';
        if (align === 'inner') {
            const cp = createSvgEl('clipPath');
            cp.setAttribute('id', id);
            if (evenOdd) geo.setAttribute('clip-rule', 'evenodd');
            cp.appendChild(geo);
            defs.appendChild(cp);
            shape.setAttribute('stroke-width', String(2 * w));
            shape.setAttribute('clip-path', `url(#${id})`);
        } else {
            const bb = bboxFor(shape);
            if (!bb) return;
            const pad = 4 * w + 2;                                     // covers miter spikes (limit 4) + projecting caps
            const R = (n) => String(+n.toFixed(2));
            const mask = createSvgEl('mask');
            mask.setAttribute('id', id);
            mask.setAttribute('maskUnits', 'userSpaceOnUse');
            mask.setAttribute('x', R(bb.x - pad)); mask.setAttribute('y', R(bb.y - pad));
            mask.setAttribute('width', R(bb.width + 2 * pad)); mask.setAttribute('height', R(bb.height + 2 * pad));
            const bg = createSvgEl('rect');
            bg.setAttribute('x', R(bb.x - pad)); bg.setAttribute('y', R(bb.y - pad));
            bg.setAttribute('width', R(bb.width + 2 * pad)); bg.setAttribute('height', R(bb.height + 2 * pad));
            bg.setAttribute('fill', '#fff');
            geo.setAttribute('fill', '#000');                          // interior blanks the inner half of the doubled stroke
            if (evenOdd) geo.setAttribute('fill-rule', 'evenodd');
            mask.appendChild(bg); mask.appendChild(geo);
            defs.appendChild(mask);
            const ghost = shape.cloneNode(false);                      // same geometry/transform/stroke context
            ['id', 'data-pf-index', 'data-pf-label', 'data-pf-default-fill'].forEach(a => ghost.removeAttribute(a));
            ghost.setAttribute('fill', 'none');
            ghost.setAttribute('stroke-width', String(2 * w));
            ghost.setAttribute('mask', `url(#${id})`);
            shape.setAttribute('stroke', 'none');                      // the fill stays on the original
            shape.after(ghost);
        }
    });
};

const formatSvgExportString = (svgString) => {
    let depth = 0;
    return svgString.replace(/></g, '>\n<').split('\n').map(line => {
        const t = line.trim();
        if (!t) return '';
        if (/^<\/[^>]+>/.test(t)) depth = Math.max(depth - 1, 0);
        const out = `${'  '.repeat(depth)}${t}`;
        if (/^<[^!?/][^>]*[^/]?>$/.test(t)) depth++;
        return out;
    }).filter(Boolean).join('\n');
};

const serializeSvgExport = (svgNode) => {
    const svgString = new XMLSerializer().serializeToString(svgNode);
    return minifySvgExport ? svgString.replace(/>\s+</g, '><').trim() : formatSvgExportString(svgString);
};

// Per-shape coordinate attributes quantized to the export precision (alongside path `d` / `points`).
// The root svg's own width/height/viewBox is not a member of these tags, so the artboard is untouched.
const EXPORT_GEOM_ATTRS = { rect: ['x', 'y', 'width', 'height', 'rx', 'ry'], circle: ['cx', 'cy', 'r'], ellipse: ['cx', 'cy', 'rx', 'ry'], line: ['x1', 'y1', 'x2', 'y2'] };

// Round every exported coordinate (path/points data + basic-shape geometry) to `prec` decimals.
// The working SVG keeps generous precision (see processSVG), so this is the single place export
// precision is set; presentation attrs (stroke-width, opacity, ...) are deliberately left untouched.
const applyExportPrecision = (root, prec) => {
    root.querySelectorAll('path[d]').forEach(el => el.setAttribute('d', roundPathData(el.getAttribute('d'), prec)));
    root.querySelectorAll('[points]').forEach(el => el.setAttribute('points', roundPathData(el.getAttribute('points'), prec)));
    for (const tag in EXPORT_GEOM_ATTRS) {
        const attrs = EXPORT_GEOM_ATTRS[tag];
        root.querySelectorAll(tag).forEach(el => attrs.forEach(a => { if (el.hasAttribute(a)) el.setAttribute(a, roundCoordValue(el.getAttribute(a), prec)); }));
    }
};

/* ---- Canvas view (zoom + pan) -------------------------------------------- */

const ZOOM_MIN = 0.05, ZOOM_MAX = 64;
const ZOOM_STOPS = [.05, .125, .25, .5, .75, 1, 1.5, 2, 3, 4, 6, 8, 12, 16, 32, 64];
const FIT_PAD = 24, WHEEL_FACTOR = 0.0015, VIEW_TRANSITION_MS = 180;
const clampZoom = (s) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, s));
const ARTBOARD_OVERLAY_BORDER_PX = 2;
let artboardOverlayRaf = 0;
let viewFitMode = false;

window.isViewFitMode = () => viewFitMode;
window.clearViewFitMode = () => { viewFitMode = false; };

const updateZoomReadout = () => {
    const el = $('csZoomValue');
    if (el) el.textContent = `${Math.round(viewScale * 100)}%`;
};

const updateArtboardDimsReadout = () => {
    const el = $('csArtboardDims');
    if (!el) return;
    const box = window.getArtboardDisplayValues?.();
    const fmt = (n) => {
        const v = Number((Number.isFinite(n) ? n : 0).toFixed(2));
        return Object.is(v, -0) ? 0 : v;
    };
    if (!box) { el.textContent = '0 x 0 px'; return; }
    el.textContent = `${fmt(box.width)} x ${fmt(box.height)} px`;
};

const hideArtboardOverlay = () => {
    if (artboardOverlayRaf) { cancelAnimationFrame(artboardOverlayRaf); artboardOverlayRaf = 0; }
    if (!artboardOverlay) return;
    artboardOverlay.hidden = true;
    artboardOverlay.style.transition = 'none';
    artboardOverlay.style.left = artboardOverlay.style.top = '';
    artboardOverlay.style.width = artboardOverlay.style.height = '';
    window.clearArtboardToolOverlay?.();
    updateArtboardDimsReadout();
};

window.hideArtboardOverlay = hideArtboardOverlay;

const syncArtboardOverlay = (animate = false) => {
    const svg = previewArea.querySelector(PREVIEW_SVG_SELECTOR);
    if (!artboardOverlay || !svg || !globalOptimizedSvg) { hideArtboardOverlay(); return; }

    const inset = ARTBOARD_OVERLAY_BORDER_PX / 2;
    const wasHidden = artboardOverlay.hidden;
    const nw = parseFloat(svg.dataset.nativeW) || 128;
    const nh = parseFloat(svg.dataset.nativeH) || 128;
    const areaRect = previewArea.getBoundingClientRect();
    const areaStyle = getComputedStyle(previewArea);
    const areaW = areaRect.width - (parseFloat(areaStyle.borderLeftWidth) || 0) - (parseFloat(areaStyle.borderRightWidth) || 0);
    const areaH = areaRect.height - (parseFloat(areaStyle.borderTopWidth) || 0) - (parseFloat(areaStyle.borderBottomWidth) || 0);
    const renderedW = nw * viewScale;
    const renderedH = nh * viewScale;

    artboardOverlay.hidden = false;
    artboardOverlay.style.transition = (animate && !wasHidden)
        ? `left ${VIEW_TRANSITION_MS / 1000}s cubic-bezier(0.2, 0.8, 0.2, 1), top ${VIEW_TRANSITION_MS / 1000}s cubic-bezier(0.2, 0.8, 0.2, 1), width ${VIEW_TRANSITION_MS / 1000}s cubic-bezier(0.2, 0.8, 0.2, 1), height ${VIEW_TRANSITION_MS / 1000}s cubic-bezier(0.2, 0.8, 0.2, 1)`
        : 'none';
    artboardOverlay.style.left = `${(areaW - renderedW) / 2 + viewPanX - inset}px`;
    artboardOverlay.style.top = `${(areaH - renderedH) / 2 + viewPanY - inset}px`;
    artboardOverlay.style.width = `${renderedW + ARTBOARD_OVERLAY_BORDER_PX}px`;
    artboardOverlay.style.height = `${renderedH + ARTBOARD_OVERLAY_BORDER_PX}px`;
    window.syncArtboardToolOverlay?.();
};

const queueArtboardOverlaySync = () => {
    if (artboardOverlayRaf) return;
        artboardOverlayRaf = requestAnimationFrame(() => {
        artboardOverlayRaf = 0;
        if (viewFitMode) { window.fitToCanvas(false); return; }
        syncArtboardOverlay(false);
        window.syncSelectionOverlay?.(false);
        window.syncDirectSelectionOverlay?.(false);
        window.syncShapeToolOverlay?.();
        window.syncPenToolOverlay?.();
        window.syncScissorsToolOverlay?.(false);
        window.syncSnapOverlay?.();
        window.syncRulersAndGuides?.();
    });
};

if (window.ResizeObserver) {
    const artboardOverlayResizeObserver = new ResizeObserver(queueArtboardOverlaySync);
    artboardOverlayResizeObserver.observe(previewArea);
}
window.addEventListener('resize', queueArtboardOverlaySync);

const applyView = (animate = false) => {
    const svg = previewArea.querySelector(PREVIEW_SVG_SELECTOR);
    if (!svg) { hideArtboardOverlay(); window.clearSelectionOverlay?.(); window.clearDirectSelectionOverlay?.(); window.clearPenToolOverlay?.(); window.clearScissorsToolOverlay?.(); window.syncRulersAndGuides?.(); return; }
    viewScale = clampZoom(viewScale);
    svg.style.transition = animate ? `transform ${VIEW_TRANSITION_MS / 1000}s cubic-bezier(0.2, 0.8, 0.2, 1)` : 'none';
    svg.style.transform = `translate(${viewPanX}px, ${viewPanY}px) scale(${viewScale})`;
    syncArtboardOverlay(animate);
    window.syncSelectionOverlay?.(animate);
    window.syncDirectSelectionOverlay?.(animate);
    window.syncShapeToolOverlay?.();
    window.syncPenToolOverlay?.();
    window.syncScissorsToolOverlay?.(animate);
    window.syncSnapOverlay?.();
    window.syncRulersAndGuides?.();
    updateZoomReadout();
    updateArtboardDimsReadout();
};

// Zoom to `nextScale`. An `anchor` ({x,y} offset from the box centre) is kept fixed
// under the zoom (scroll-wheel); pass null to keep the canvas centre fixed (+/- & typed %).
const setZoom = (nextScale, anchor, animate = false) => {
    nextScale = clampZoom(nextScale);
    viewFitMode = false;
    if (anchor) {
        const k = nextScale / viewScale;
        viewPanX = anchor.x - k * (anchor.x - viewPanX);
        viewPanY = anchor.y - k * (anchor.y - viewPanY);
    }
    viewScale = nextScale;
    applyView(animate);
};

window.fitToCanvas = (animate = false) => {
    const svg = previewArea.querySelector(PREVIEW_SVG_SELECTOR);
    if (!svg) return;
    const nw = parseFloat(svg.dataset.nativeW) || 128, nh = parseFloat(svg.dataset.nativeH) || 128;
    const bar = $('canvasStatusBar');
    const statusH = (bar && !bar.hidden) ? bar.offsetHeight : 0;
    const rulerOffset = window.getRulerFitOffset?.() || 0;
    const availW = previewArea.clientWidth - rulerOffset - 2 * FIT_PAD;
    const availH = previewArea.clientHeight - statusH - rulerOffset - 2 * FIT_PAD;
    if (availW <= 0 || availH <= 0) return;
    viewFitMode = true;
    viewScale = clampZoom(Math.min(availW / nw, availH / nh));
    viewPanX = rulerOffset / 2;
    viewPanY = rulerOffset / 2 - statusH / 2;
    applyView(animate);
};

window.zoomStep = (dir) => {
    if (!globalOptimizedSvg) return;
    let next;
    if (dir > 0) {
        next = ZOOM_STOPS.find(s => s > viewScale + 1e-4);
        if (next === undefined) next = ZOOM_MAX;
    } else {
        next = ZOOM_MIN;
        for (let i = ZOOM_STOPS.length - 1; i >= 0; i--) { if (ZOOM_STOPS[i] < viewScale - 1e-4) { next = ZOOM_STOPS[i]; break; } }
    }
    setZoom(next, null, true);
};

// Click the percentage -> inline editable field; commits on blur / Enter, reverts on Escape.
window.beginZoomEdit = () => {
    const btn = $('csZoomValue');
    if (!btn || !globalOptimizedSvg || btn.dataset.editing) return;
    btn.dataset.editing = '1';
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'cs-zoom-input';
    input.value = Math.round(viewScale * 100);
    btn.style.display = 'none';
    btn.insertAdjacentElement('afterend', input);
    input.focus();
    input.select();
    const commit = (apply) => {
        if (btn.dataset.editing !== '1') return;
        delete btn.dataset.editing;
        if (apply) {
            const v = parseFloat(input.value);
            if (!isNaN(v)) setZoom(clampZoom(v / 100), null, true);
        }
        input.remove();
        btn.style.display = '';
        updateZoomReadout();
    };
    input.addEventListener('blur', () => commit(true));
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
        else if (e.key === 'Escape') { e.preventDefault(); commit(false); }
    });
};

const renderOutput = (isScrubbing = false) => {
    if (!globalOptimizedSvg) return;
    const clone = globalOptimizedSvg.cloneNode(true);

    // Hidden layers (eye off, tracked in hiddenLayers by data-pf-index) leave the working clone
    // entirely: preview, hit-testing, snapping, ink bounds, and the export clone below all
    // follow from this one removal. The state is UI-only (not on the model), so a toggle never
    // creates a history entry.
    if (hiddenLayers.size) clone.querySelectorAll('[data-pf-index]').forEach(el => { if (hiddenLayers.has(el.getAttribute('data-pf-index'))) el.remove(); });

    // A shape with no fill AND no stroke paints nothing, but it must stay in the preview so
    // the Selection tool can still hover/grab it (and toggle its paint back on). With no paint
    // the default `visiblePainted` hit-test misses it, so make its whole geometry hit-testable.
    clone.querySelectorAll(SVG_VECTOR_LAYER_SHAPE_SELECTOR).forEach(s => {
        const f = s.getAttribute('fill'), st = s.getAttribute('stroke');
        if ((!f || f === 'none') && (!st || st === 'none')) s.setAttribute('pointer-events', 'all');
    });

    // Locked layers (lockedLayers by data-pf-index) are inert to every canvas tool -- the pointer
    // passes through them -- so they can't be selected/edited on the canvas. They still render and
    // export normally (locked != hidden), and still act as snap targets (geometry, not pointer-events).
    if (lockedLayers.size) clone.querySelectorAll('[data-pf-index]').forEach(el => { if (lockedLayers.has(el.getAttribute('data-pf-index'))) el.setAttribute('pointer-events', 'none'); });

    const emps = clone.querySelectorAll('g, defs');
    for (let i = emps.length - 1; i >= 0; i--) if (!emps[i].children.length) emps[i].remove();

    const vb = clone.getAttribute("viewBox") || clone.getAttribute("viewbox");
    let nw = 128, nh = 128;
    if (vb) {
        const p = vb.trim().split(/[\s,]+/); nw = parseFloat(p.length === 4 ? p[2] : p[0]); nh = parseFloat(p.length === 4 ? p[3] : p[1]);
    }

    clone.dataset.nativeW = nw; clone.dataset.nativeH = nh;

    clone.style.width = `${nw}px`;
    clone.style.height = `${nh}px`;
    clone.style.transition = 'none';
    const oldSvg = previewArea.querySelector(PREVIEW_SVG_SELECTOR);
    if (oldSvg) {
        oldSvg.replaceWith(clone);
    } else {
        previewArea.appendChild(clone);
    }
    // Expand Align Stroke inner/outer now that the clone is rendered (mask regions need getBBox);
    // the export clone below is taken AFTER this, so preview and export always match.
    expandStrokeAlignment(clone, (s) => { try { return s.getBBox(); } catch (_) { return null; } });
    void clone.offsetWidth;
    applyView(false);

    if (!isScrubbing) {
        const exportClone = clone.cloneNode(true);
        if (useCurrentColorExport) applyCurrentColorToSvg(exportClone);
        exportClone.removeAttribute('style');
        exportClone.removeAttribute('data-native-w');
        exportClone.removeAttribute('data-native-h');
        exportClone.querySelectorAll('[data-pf-index]').forEach(el => el.removeAttribute('data-pf-index'));
        exportClone.querySelectorAll('[data-pf-label]').forEach(el => el.removeAttribute('data-pf-label'));
        exportClone.querySelectorAll('[data-pf-default-fill]').forEach(el => el.removeAttribute('data-pf-default-fill'));

        // The no-fill/no-stroke shapes were KEPT in the preview (hit-testing) with a canvas-only
        // pointer-events flag; they paint nothing, so drop them from export and never leak the flag.
        // Locked shapes also carry the canvas-only flag -- strip it from every remaining shape/image.
        exportClone.querySelectorAll(SVG_VECTOR_LAYER_SHAPE_SELECTOR).forEach(s => {
            const f = s.getAttribute('fill'), st = s.getAttribute('stroke');
            if ((!f || f === 'none') && (!st || st === 'none')) return s.remove();
            s.removeAttribute('pointer-events');
        });
        exportClone.querySelectorAll('image').forEach(img => img.removeAttribute('pointer-events'));

        const exportWrapper = exportClone.querySelector('g#ink-wrapper');
        if (exportWrapper) exportWrapper.removeAttribute('id');

        if (responsiveSvgExport) {
            exportClone.removeAttribute('width');
            exportClone.removeAttribute('height');
        }
        applyExportPrecision(exportClone, svgExportPrecision);
        outputStr.value = serializeSvgExport(exportClone);
    }

    if (!isScrubbing && document.querySelector('input[name="exportFormat"]:checked').value === 'png') {
        updatePngPreview();
    }

    // Re-apply the Selection tool's outline + bounding box + handles onto the freshly rebuilt preview svg.
    window.refreshSelectionOverlay?.();

    // And the Direct Selection tool's outline + anchor points + Bezier handles.
    window.refreshDirectSelectionOverlay?.();

    // And the Pen tool's in-progress-path anchors / rubber band (drops state if its shape vanished).
    window.refreshPenToolOverlay?.();

    // And the Scissors tool's hovered outline / anchors / exact cut marker.
    window.refreshScissorsToolOverlay?.();

    // Keep the Properties readout in step with the rebuilt preview (skip slider scrubs --
    // geometry bounds don't change during a color/stroke drag).
    if (!isScrubbing) window.refreshElementProperties?.();

    // Appearance panel + layer thumbnails mirror the committed document (undo/redo, tool
    // edits, pathfinder results, ... all funnel through here). Scrubs skip both.
    if (!isScrubbing) window.refreshAppearancePanel?.();
    if (!isScrubbing) window.refreshLayerThumbnails?.();

    // Every committed render is the app-wide change funnel: offer the document to the undo/redo
    // history (it dedupes, so renders without a document change push nothing). See docs/history.md.
    if (!isScrubbing) window.commitHistoryEntry?.();

    // Committed document changes refresh the snap engine's cached targets (docs/snapping.md).
    if (!isScrubbing) window.invalidateSnapTargets?.();
};

/* ---- Canvas gestures: wheel-to-zoom (cursor-anchored) --------------------- */

let wheelRaf = null, wheelAccum = 1, wheelAnchor = null;
previewArea.addEventListener('wheel', (e) => {
    if (!globalOptimizedSvg) return;
    e.preventDefault();
    const rect = previewArea.getBoundingClientRect();
    wheelAnchor = { x: e.clientX - rect.left - rect.width / 2, y: e.clientY - rect.top - rect.height / 2 };
    let dy = e.deltaY;
    if (e.deltaMode === 1) dy *= 16;                       // lines -> px (Firefox)
    else if (e.deltaMode === 2) dy *= previewArea.clientHeight; // pages -> px
    wheelAccum *= Math.exp(-dy * WHEEL_FACTOR);
    if (wheelRaf) return;
    wheelRaf = requestAnimationFrame(() => {
        wheelRaf = null;
        setZoom(viewScale * wheelAccum, wheelAnchor, false);
        wheelAccum = 1;
    });
}, { passive: false });
