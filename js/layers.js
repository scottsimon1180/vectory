/* fileName: layers.js */

// Reads a gradient referenced by url(#id) from the live/original SVG into { type, angle, stops }.
// Layer density is a panel preference, independent of the imported document.
const LP_SIZE_KEY = 'pf_layersSize';
const layersPanel = document.getElementById('layersPanel');
const layersSizeToggle = document.getElementById('layersSizeToggle');
let layersSize = 'large';

try { if (localStorage.getItem(LP_SIZE_KEY) === 'small') layersSize = 'small'; } catch (_) {}

const applyLayersSize = () => {
    const isSmall = layersSize === 'small';
    layersPanel.classList.toggle('is-small', isSmall);
    layersSizeToggle.innerHTML = `<svg class="icon-svg" aria-hidden="true"><use href="#icon-${isSmall ? 'large' : 'small'}"></use></svg>`;
    layersSizeToggle.setAttribute('aria-label', `Switch to ${isSmall ? 'large' : 'small'} layers`);
    requestAnimationFrame(() => window.updateAllScrollbars?.());
};

applyLayersSize();

layersSizeToggle.addEventListener('click', () => {
    layersSize = layersSize === 'small' ? 'large' : 'small';
    applyLayersSize();
    try { localStorage.setItem(LP_SIZE_KEY, layersSize); } catch (_) {}
});

let __lpSwatchGradSeq = 0;

const readGradData = (gradRef) => {

    const m = String(gradRef || '').match(/url\(['"]?#([^)'"]+)['"]?\)/);

    if (!m || !m[1]) return null;

    const g = (globalOptimizedSvg && globalOptimizedSvg.querySelector(`#${m[1]}`)) ||
              (globalOriginalSvg && globalOriginalSvg.querySelector(`#${m[1]}`));

    if (!g) return null;

    const isRadial = g.tagName.toLowerCase() === 'radialgradient';

    let angle = 0;

    if (!isRadial) {

        const t = g.getAttribute('gradientTransform');

        if (t) { const r = t.match(/rotate\(\s*([-0-9.]+)/); if (r) angle = parseFloat(r[1]) || 0; }

    }

    const stops = [];

    g.querySelectorAll('stop').forEach(s => {

        let raw = s.getAttribute('offset'), off = 0;

        if (raw != null) { off = parseFloat(raw) || 0; if (raw.indexOf('%') === -1 && off <= 1) off *= 100; }

        stops.push({ offset: off, color: s.getAttribute('stop-color') || '#000' });

    });

    return stops.length ? { type: isRadial ? 'radial' : 'linear', angle, stops } : null;

};

// Sentinel for a multi-selection whose members disagree on a paint value.
const AP_MIXED = '__ap-mixed__';

// Paints the launch-picker swatch: solid fill = filled square, solid stroke = hollow outlined square,
// gradients are painted (filled / outlined) via an inline SVG. Hairlines keep it visible on any color.
// The Paint Panel adds two more states: 'none' (white + red slash) and AP_MIXED ('?'), both
// rendered purely by the .lp-none / .lp-mixed classes in css/style.css.
const renderPickerSwatch = (wrap, activeHex, isStroke, gradData) => {

    if (!wrap) return;

    wrap.classList.remove('lp-none', 'lp-mixed');

    if (activeHex === 'none') { wrap.innerHTML = ''; wrap.classList.add('lp-none'); return; }

    if (activeHex === AP_MIXED) { wrap.innerHTML = ''; wrap.classList.add('lp-mixed'); return; }

    const isGrad = (activeHex && activeHex.includes('url')) || !!gradData;

    if (!isGrad) {

        const kind = isStroke ? 'stroke' : 'fill';

        let sw = wrap.querySelector('.lp-swatch');

        if (!sw || sw.getAttribute('data-kind') !== kind) {

            wrap.innerHTML = '';

            sw = createEl('div', `lp-swatch lp-swatch-${kind}`);

            sw.setAttribute('data-kind', kind);

            wrap.appendChild(sw);

        }

        if (isStroke) sw.style.borderColor = activeHex;

        else sw.style.backgroundColor = activeHex;

        return;

    }

    const gd = gradData || readGradData(activeHex);

    if (!gd) { wrap.innerHTML = ''; return; }

    const gid = `lp-sw-grad-${++__lpSwatchGradSeq}`;

    const stopsStr = gd.stops.map(s => `<stop offset="${s.offset}%" stop-color="${s.color}"/>`).join('');

    let def;

    if (gd.type === 'radial') {

        def = `<radialGradient id="${gid}" cx="0.5" cy="0.5" r="0.5">${stopsStr}</radialGradient>`;

    } else {

        const rot = gd.angle ? ` gradientTransform="rotate(${gd.angle} 0.5 0.5)"` : '';

        def = `<linearGradient id="${gid}" x1="0.5" y1="1" x2="0.5" y2="0"${rot}>${stopsStr}</linearGradient>`;

    }

    let shapes;

    if (isStroke) {

        shapes = `<rect x="2" y="2" width="16" height="16" fill="none" stroke="url(#${gid})" stroke-width="4"/>`
               + `<rect x="5" y="5" width="10" height="10" fill="none" stroke="#1a1a1e" stroke-width="2"/>`;

    } else {

        shapes = `<rect x="0" y="0" width="20" height="20" fill="url(#${gid})"/>`;

    }

    wrap.innerHTML = `<svg class="lp-swatch-svg" viewBox="0 0 20 20" preserveAspectRatio="none"><defs>${def}</defs>${shapes}</svg>`;

};



// Inline layer rename: double-clicking the title label swaps it for a pre-selected text field; commits on
// blur/Enter, cancels on Escape. The name is written to the live element id.
const commitLayerRename = (shape, rawValue, index) => {

    const fallback = resolveLayerDefaultName(shape, index);

    const currentId = shape.getAttribute('id');

    const v = String(rawValue).trim();

    shape.removeAttribute('data-pf-label');

    let finalName;

    if (v === '' || (!currentId && v === fallback)) {

        shape.removeAttribute('id');

        finalName = fallback;

    } else {

        const id = ensureUniqueSvgId(globalOptimizedSvg, sanitizeSvgId(v), shape);

        if (!id) { shape.removeAttribute('id'); finalName = fallback; }

        else { shape.setAttribute('id', id); finalName = id; }

    }

    window.setHistoryLabel?.('Rename Layer', 'text-tool');

    renderOutput(false);

    return finalName;

};



const beginRename = (titleEl, shape, index) => {

    if (titleEl.querySelector('input')) return;

    const fallback = resolveLayerName(shape, index);

    const startVal = (shape.getAttribute('data-pf-label') || shape.getAttribute('id') || '').trim();

    const input = createEl('input', 'layer-title-input', { type: 'text', value: startVal || fallback, spellcheck: false });

    titleEl.textContent = '';

    titleEl.appendChild(input);

    requestAnimationFrame(() => { input.focus(); input.select(); });

    let done = false;

    const finish = (commit) => {

        if (done) return; done = true;

        const name = commit ? commitLayerRename(shape, input.value, index) : fallback;

        titleEl.textContent = '';

        titleEl.appendChild(createEl('span', 'layer-title-label', { textContent: name }));

        titleEl.classList.add('rename-flash');

        setTimeout(() => titleEl.classList.remove('rename-flash'), 450);

    };

    input.addEventListener('blur', () => finish(true));

    input.addEventListener('keydown', (e) => {

        if (e.key === 'Enter') { e.preventDefault(); input.blur(); }

        else if (e.key === 'Escape') { e.preventDefault(); done = true; titleEl.textContent = fallback; }

    });

};



// --- Layer (panel) selection -------------------------------------------------
// Header (.layer-title-row) clicks mark a layer card as selected. This is the
// PANEL selection ONLY -- the blue card highlight + the reorder/delete target. It
// deliberately does NOT drive the Properties panel; that's the Selection tool's
// edit selection (editSelectedIndex, properties.js). selectedLayerIndex tracks the
// card's data-pf-index. Document-level wiring lives in app-init.js.
window.selectLayer = (pfIndex, event) => {

    if (pfIndex == null) return;

    const idx = String(pfIndex);

    if (event && event.ctrlKey && event.shiftKey && lastClickedLayerIndex != null) {

        const cards = Array.from(layersList.querySelectorAll('.layer-item'));

        const anchorPos = cards.findIndex(c => c.getAttribute('data-pf-index') === lastClickedLayerIndex);

        const targetPos = cards.findIndex(c => c.getAttribute('data-pf-index') === idx);

        if (anchorPos !== -1 && targetPos !== -1) {

            const from = Math.min(anchorPos, targetPos), to = Math.max(anchorPos, targetPos);

            for (let i = from; i <= to; i++) { const pf = cards[i].getAttribute('data-pf-index'); if (pf != null) selectedLayerIndex.add(pf); }

        }

    } else if (event && event.shiftKey && lastClickedLayerIndex != null) {

        const cards = Array.from(layersList.querySelectorAll('.layer-item'));

        const anchorPos = cards.findIndex(c => c.getAttribute('data-pf-index') === lastClickedLayerIndex);

        const targetPos = cards.findIndex(c => c.getAttribute('data-pf-index') === idx);

        if (anchorPos !== -1 && targetPos !== -1) {

            selectedLayerIndex.clear();

            const from = Math.min(anchorPos, targetPos), to = Math.max(anchorPos, targetPos);

            for (let i = from; i <= to; i++) { const pf = cards[i].getAttribute('data-pf-index'); if (pf != null) selectedLayerIndex.add(pf); }

        }

    } else if (event && event.ctrlKey) {

        if (selectedLayerIndex.has(idx)) selectedLayerIndex.delete(idx);

        else selectedLayerIndex.add(idx);

        lastClickedLayerIndex = idx;

    } else {

        selectedLayerIndex.clear();

        selectedLayerIndex.add(idx);

        lastClickedLayerIndex = idx;

    }

    layersList.querySelectorAll('.layer-item').forEach(item => {

        item.classList.toggle('is-selected', selectedLayerIndex.has(item.getAttribute('data-pf-index')));

    });

    syncDeleteLayerBtn();

    window.refreshPaintPanel?.();

};

window.clearLayerSelection = () => {

    if (selectedLayerIndex.size === 0) return;

    selectedLayerIndex.clear();

    lastClickedLayerIndex = null;

    layersList.querySelectorAll('.layer-item.is-selected').forEach(item => item.classList.remove('is-selected'));

    syncDeleteLayerBtn();

    window.refreshPaintPanel?.();

};

// Canvas -> panel mirror: replace the panel selection with the given indices and repaint the
// card highlights (no scrolling, no click event). Used by the canvas tools' multi-selection.
window.setLayerSelectionSet = (indices) => {

    selectedLayerIndex.clear();

    (indices || []).forEach(idx => { if (idx != null && !lockedLayers.has(String(idx))) selectedLayerIndex.add(String(idx)); });

    lastClickedLayerIndex = selectedLayerIndex.size ? [...selectedLayerIndex][selectedLayerIndex.size - 1] : null;

    layersList.querySelectorAll('.layer-item').forEach(item => {

        item.classList.toggle('is-selected', selectedLayerIndex.has(item.getAttribute('data-pf-index')));

    });

    syncDeleteLayerBtn();

    window.refreshPaintPanel?.();

};



// --- Delete selected layer ---------------------------------------------------
// The header trash button removes the selected shape from the model and re-renders.
// data-pf-index is a stable per-shape attribute (never renumbered), so deleting one
// element leaves every other card, lock, and selection valid.
const LP_LIST_GAP = 5;   // matches .layers-list gap:5px (absorbed by the card's exit margin)

// Keep layer header actions visible but greyed until they can act.
const syncDeleteLayerBtn = () => {

    const hasDocument = !!globalOptimizedSvg;

    if (btnImportLayer) btnImportLayer.disabled = !hasDocument;
    if (btnPasteLayer) btnPasteLayer.disabled = !hasDocument;

    [btnDuplicateLayer, btnDeleteLayer].forEach(btn => {

        if (!btn) return;

        btn.disabled = ![...selectedLayerIndex].some(idx => !lockedLayers.has(idx));

    });

};

const getNextLayerPfIndex = () => {

    let max = -1;

    globalOptimizedSvg.querySelectorAll('[data-pf-index]').forEach(el => {

        const n = parseInt(el.getAttribute('data-pf-index'), 10);

        if (!isNaN(n)) max = Math.max(max, n);

    });

    return String(max + 1);

};

// Exposed so the Shape tools (js/shape-tools.js) allocate the next index without duplicating this.
window.getNextLayerPfIndex = getNextLayerPfIndex;

const getLayerCopyBaseName = (name) => {

    const clean = String(name || '').trim();

    return clean.replace(/-copy(?:[\s_-]+\d+)?$/i, '').trim() || clean || 'Layer';

};

const getDuplicateLayerLabel = (sourceLabel) => {

    const base = getLayerCopyBaseName(sourceLabel);

    const takenLabels = new Set();

    const takenIds = new Set();

    globalOptimizedSvg.querySelectorAll('[id], [data-pf-label]').forEach(el => {

        const label = el.getAttribute('data-pf-label');

        const id = el.getAttribute('id');

        if (label && label.trim()) takenLabels.add(label.trim().toLowerCase());

        if (id && id.trim()) takenIds.add(id.trim());

    });

    let n = 1, label;

    do {

        label = `${base}-copy${n > 1 ? ` ${n}` : ''}`;

        n++;

    } while (takenLabels.has(label.toLowerCase()) || takenIds.has(sanitizeSvgId(label)));

    return label;

};

// deferCommit=true (Selection tool Alt-drag duplicate) skips the history label + committed
// render + card animation so the caller's gesture can commit the clone and its move as ONE
// history entry. Returns the new data-pf-index list (null when nothing was duplicated).
window.duplicateSelectedLayer = (deferCommit = false) => {

    if (selectedLayerIndex.size === 0 || !globalOptimizedSvg) return null;

    const indices = new Set(selectedLayerIndex);

    const priorEditIndex = editSelectedIndex;

    const priorEditSet = new Set(editSelectedIndices);

    const allShapes = Array.from(globalOptimizedSvg.querySelectorAll('[data-pf-index]'));

    const toClone = allShapes.filter(s => {
        const idx = s.getAttribute('data-pf-index');
        return indices.has(idx) && !lockedLayers.has(idx);
    });

    if (!toClone.length) { window.clearLayerSelection(); return null; }

    const newIndices = [];

    toClone.forEach(shape => {

        const card = layersList.querySelector(`.layer-item[data-pf-index="${shape.getAttribute('data-pf-index')}"]`);

        const titleEl = card && card.querySelector('.layer-title');

        const sourceLabel = (titleEl && titleEl.textContent.trim()) || resolveLayerName(shape, 0);

        const clone = shape.cloneNode(true);

        const nextIndex = getNextLayerPfIndex();

        const copyLabel = getDuplicateLayerLabel(sourceLabel);

        const copyId = ensureUniqueSvgId(globalOptimizedSvg, sanitizeSvgId(copyLabel), clone);

        clone.setAttribute('data-pf-index', nextIndex);

        clone.setAttribute('data-pf-label', copyLabel);

        if (copyId) clone.setAttribute('id', copyId);

        else clone.removeAttribute('id');

        shape.parentNode.insertBefore(clone, shape.nextSibling);

        newIndices.push(nextIndex);

    });

    buildLayersPanel();

    // Restore the canvas edit selection (buildLayersPanel cleared it), filtered to survivors and
    // keeping the scalar/Set invariant: scalar non-null iff exactly one object is selected.
    priorEditSet.forEach(idx => {

        if (globalOptimizedSvg.querySelector(`[data-pf-index="${idx}"]`)) editSelectedIndices.add(idx);

    });

    if (editSelectedIndices.size === 1) editSelectedIndex = [...editSelectedIndices][0];

    else if (editSelectedIndices.size === 0 && priorEditIndex != null && globalOptimizedSvg.querySelector(`[data-pf-index="${priorEditIndex}"]`)) {

        editSelectedIndex = priorEditIndex;

        editSelectedIndices.add(priorEditIndex);

    }

    selectedLayerIndex.clear();

    newIndices.forEach(idx => selectedLayerIndex.add(idx));

    lastClickedLayerIndex = newIndices[newIndices.length - 1];

    layersList.querySelectorAll('.layer-item').forEach(item => {

        item.classList.toggle('is-selected', selectedLayerIndex.has(item.getAttribute('data-pf-index')));

    });

    syncDeleteLayerBtn();

    if (!deferCommit) {

        window.setHistoryLabel?.('Duplicate Layer', 'layers-duplicate');

        renderOutput(false);

        newIndices.forEach(idx => {

            insertLayerCardAnimated(layersList.querySelector(`.layer-item[data-pf-index="${idx}"]`));

        });

    }

    window.updateAllScrollbars();

    return newIndices;

};

// Collapse the card to nothing (height + opacity, with a negative margin to eat the flex
// gap) so the cards below slide up by one slot, then drop the node. Mirrors the drag-drop
// commit's transitionend + timeout fallback; reduced motion removes it instantly.
const removeLayerCardAnimated = (card) => {

    const finalize = () => {

        card.remove();

        if (!layersList.querySelector('.layer-item')) {

            layersList.innerHTML = '<div style="font-size:11px;color:var(--text-secondary);text-align:center;margin-top:30px;">No editable layers found.</div>';

        }

        syncDeleteLayerBtn();

        window.updateAllScrollbars();

    };

    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) { finalize(); return; }

    card.style.height = card.offsetHeight + 'px';

    card.classList.add('is-deleting');

    void card.offsetHeight;   // reflow so the height transition has a start value

    card.style.height = '0px';

    card.style.opacity = '0';

    card.style.marginBottom = `-${LP_LIST_GAP}px`;

    let done = false;

    const finish = () => { if (done) return; done = true; card.removeEventListener('transitionend', onEnd); finalize(); };

    const onEnd = (e) => { if (e.propertyName === 'height') finish(); };

    card.addEventListener('transitionend', onEnd);

    setTimeout(finish, 360);   // fallback if transitionend is missed

};

// Reverse of removeLayerCardAnimated: a freshly inserted card grows from nothing (height +
// opacity, with the same negative margin eating the flex gap) so the cards below slide down to
// open a slot for it. Inline styles are cleared on the commit's transitionend + timeout fallback;
// reduced motion shows it instantly.
const insertLayerCardAnimated = (card) => {

    if (!card) return;

    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const target = card.offsetHeight;

    if (!target) return;

    card.style.height = '0px';

    card.style.opacity = '0';

    card.style.marginBottom = `-${LP_LIST_GAP}px`;

    card.classList.add('is-inserting');

    void card.offsetHeight;   // reflow so the height transition has a start value

    card.style.height = target + 'px';

    card.style.opacity = '1';

    card.style.marginBottom = '';

    const finalize = () => {

        card.classList.remove('is-inserting');

        card.style.height = '';

        card.style.opacity = '';

        card.style.marginBottom = '';

        window.updateAllScrollbars();

    };

    let done = false;

    const finish = () => { if (done) return; done = true; card.removeEventListener('transitionend', onEnd); finalize(); };

    const onEnd = (e) => { if (e.propertyName === 'height') finish(); };

    card.addEventListener('transitionend', onEnd);

    setTimeout(finish, 360);   // fallback if transitionend is missed

};

// Remove the selected shape from globalOptimizedSvg, tidy the model (empty groups + orphaned
// generated gradients), clear the selection, re-render, and animate the card out.
window.deleteSelectedLayer = () => {

    if (selectedLayerIndex.size === 0 || !globalOptimizedSvg) return;

    const indices = new Set(selectedLayerIndex);

    const entries = [];

    indices.forEach(idx => {

        const shape = globalOptimizedSvg.querySelector(`[data-pf-index="${idx}"]`);

        const card = layersList.querySelector(`.layer-item[data-pf-index="${idx}"]`);

        if (shape && !lockedLayers.has(idx)) entries.push({ idx, shape, card });

    });

    if (!entries.length) { window.clearLayerSelection(); return; }

    entries.forEach(e => e.shape.remove());

    const wrapper = globalOptimizedSvg.querySelector(':scope > g#ink-wrapper') || globalOptimizedSvg;

    wrapper.querySelectorAll('g').forEach(g => { if (g.id !== 'ink-wrapper' && !g.children.length) g.remove(); });

    const usedIds = new Set();

    globalOptimizedSvg.querySelectorAll('*').forEach(el => {

        ['fill', 'stroke'].forEach(a => {

            const v = el.getAttribute(a);

            if (v && v.includes('url(#')) { const m = v.match(/url\(['"]?#([^)'"]+)['"]?\)/); if (m) usedIds.add(m[1]); }

        });

    });

    const defs = globalOptimizedSvg.querySelector('defs');

    if (defs) {

        Array.from(defs.children).forEach(c => { if (c.id && c.id.startsWith('pf-grad-') && !usedIds.has(c.id)) c.remove(); });

        if (!defs.children.length) defs.remove();

    }

    window.clearLayerSelection();

    if (indices.has(editSelectedIndex) || [...editSelectedIndices].some(idx => indices.has(idx))) window.clearEditSelection();

    window.setHistoryLabel?.('Delete Layer', 'trash');

    renderOutput(false);

    const cards = entries.map(e => e.card).filter(Boolean);

    if (!cards.length) { syncDeleteLayerBtn(); window.updateAllScrollbars(); return; }

    cards.forEach(card => removeLayerCardAnimated(card));

};



const buildLayersPanel = () => {

    layersList.innerHTML = '';

    selectedLayerIndex.clear();

    lastClickedLayerIndex = null;

    editSelectedIndex = null;

    editSelectedIndices.clear();

    if (!globalOptimizedSvg) { syncDeleteLayerBtn(); window.refreshPaintPanel?.(); window.updateAllScrollbars(); return; }

    

    // --- Orphaned Gradient Cleanup ---

    const usedIds = new Set();

    globalOptimizedSvg.querySelectorAll('*').forEach(el => {

        const f = el.getAttribute('fill'), s = el.getAttribute('stroke');

        if (f && f.includes('url(#')) { const m = f.match(/url\(['"]?#([^)'"]+)['"]?\)/); if (m) usedIds.add(m[1]); }

        if (s && s.includes('url(#')) { const m = s.match(/url\(['"]?#([^)'"]+)['"]?\)/); if (m) usedIds.add(m[1]); }

    });

    const defs = globalOptimizedSvg.querySelector('defs');

    if (defs) {

        Array.from(defs.children).forEach(c => {

            if (c.id && c.id.startsWith('pf-grad-') && !usedIds.has(c.id)) c.remove();

        });

        if (!defs.children.length) defs.remove();

    }

    // ---------------------------------

    

    // SVG paints later elements on top; show those first to match layer-panel stacking.
    const shapes = getEditableLayerShapes(globalOptimizedSvg).reverse();

    if (!shapes.length) {

        layersList.innerHTML = '<div style="font-size:11px;color:var(--text-secondary);text-align:center;margin-top:30px;">No editable layers found.</div>';

        syncDeleteLayerBtn();

        window.refreshPaintPanel?.();

        window.updateAllScrollbars();

        return;

    }



    // Missing fill on a vector shape would paint black per the SVG default; the editor's
    // model is explicit, so stamp the state the app actually means: no fill attribute = no fill.
    shapes.forEach(shape => {

        if (!isRasterLayerShape(shape) && !shape.hasAttribute('fill')) shape.setAttribute('fill', 'none');

    });



    const eyeIconHtml = (hidden) => `<svg class="icon-svg"><use href="#icon-eye${hidden ? '-hidden' : ''}" xlink:href="#icon-eye${hidden ? '-hidden' : ''}"></use></svg>`;

    const lockIconHtml = (locked) => `<svg class="icon-svg"><use href="#icon-layers-${locked ? 'lock' : 'unlock'}" xlink:href="#icon-layers-${locked ? 'lock' : 'unlock'}"></use></svg>`;

    // One compact card per layer -- thumbnail | name | lock | eye -- for vector and raster
    // layers alike. Hide (eye) and lock are UI-only, tracked in hiddenLayers/lockedLayers
    // (app-state) keyed by data-pf-index; both stay live regardless of each other. Hidden
    // shapes are dropped from the render/export clones; locked shapes get pointer-events:none
    // in the preview so no canvas tool can touch them; panel selection and reordering remain available. Fill
    // and stroke are edited in the Paint Panel (below in this file), never on the card.
    const createLayerCard = (shape, i) => {

        const idxStr = String(shape.getAttribute('data-pf-index'));

        const titleEl = createEl('div', 'layer-title', {}, [

            createEl('span', 'layer-title-label', { textContent: resolveLayerName(shape, i) })

        ]);

        titleEl.ondblclick = e => {

            if (!lockedLayers.has(idxStr) && e.target.closest('.layer-title-label')) beginRename(titleEl, shape, i);

        };

        let thumb;

        if (isRasterLayerShape(shape)) {

            const thumbImg = createEl('img', 'layer-thumb-img', { src: getRasterImageHref(shape), alt: '', decoding: 'async', loading: 'lazy' });

            thumb = createEl('div', 'layer-thumb', {}, [thumbImg]);

        } else {

            thumb = createEl('div', 'layer-thumb');   // svg content injected by refreshLayerThumbnails

        }

        const isHidden = hiddenLayers.has(idxStr);

        const isLocked = lockedLayers.has(idxStr);

        let layerItem = null;

        const eye = createEl('div', `layer-toggle layer-eye ${isHidden ? 'hidden-state' : ''}`, {
            title: isHidden ? 'Show layer' : 'Hide layer',
            innerHTML: eyeIconHtml(isHidden)
        });

        eye.onclick = (e) => {

            e.stopPropagation();

            const hide = !hiddenLayers.has(idxStr);

            const targets = selectedLayerIndex.has(idxStr) && selectedLayerIndex.size > 1
                ? [...selectedLayerIndex]
                : [idxStr];

            targets.forEach(targetIdx => {
                if (hide) hiddenLayers.add(targetIdx); else hiddenLayers.delete(targetIdx);

                const card = layersList.querySelector(`.layer-item[data-pf-index="${targetIdx}"]`);
                const targetEye = card?.querySelector('.layer-eye');

                card?.classList.toggle('is-layer-hidden', hide);
                targetEye?.classList.toggle('hidden-state', hide);

                if (targetEye) {
                    targetEye.title = hide ? 'Show layer' : 'Hide layer';
                    targetEye.innerHTML = eyeIconHtml(hide);
                }
            });

            renderOutput(false);   // model unchanged -> no history entry; preview + export follow the set

        };

        const lock = createEl('div', `layer-toggle layer-lock ${isLocked ? 'locked-state' : ''}`, {
            title: isLocked ? 'Unlock layer' : 'Lock layer',
            innerHTML: lockIconHtml(isLocked)
        });

        lock.onclick = (e) => {

            e.stopPropagation();

            const locking = !lockedLayers.has(idxStr);

            const targets = selectedLayerIndex.has(idxStr) && selectedLayerIndex.size > 1
                ? [...selectedLayerIndex]
                : [idxStr];

            targets.forEach(targetIdx => {
                if (locking) lockedLayers.add(targetIdx); else lockedLayers.delete(targetIdx);

                const card = layersList.querySelector(`.layer-item[data-pf-index="${targetIdx}"]`);
                const targetLock = card?.querySelector('.layer-lock');

                card?.classList.toggle('is-locked', locking);
                targetLock?.classList.toggle('locked-state', locking);

                if (targetLock) {
                    targetLock.title = locking ? 'Unlock layer' : 'Lock layer';
                    targetLock.innerHTML = lockIconHtml(locking);
                }
            });

            // Locked rows remain selected in the panel so a group can be unlocked together, but
            // any canvas edit selection must still be cleared because locked art is not editable.
            if (locking && targets.some(targetIdx => editSelectedIndex === targetIdx || editSelectedIndices.has(targetIdx))) {
                window.clearEditSelection?.();
                window.clearSelectionToolLock?.();
            }

            renderOutput(false);   // model unchanged -> no history entry; refreshes preview pointer-events

        };

        layerItem = createEl('div', `layer-item${isHidden ? ' is-layer-hidden' : ''}${isLocked ? ' is-locked' : ''}`, {}, [

            createEl('div', 'layer-title-row', {}, [thumb, titleEl, lock, eye])

        ]);

        layerItem.setAttribute('data-pf-index', idxStr);

        return layerItem;

    };



    shapes.forEach((shape, i) => layersList.appendChild(createLayerCard(shape, i)));



    syncDeleteLayerBtn();

    window.refreshPaintPanel?.();

    window.refreshLayerThumbnails?.();

    requestAnimationFrame(window.updateAllScrollbars);

};



// ==========================================



// ============================================================================
// Layer drag-to-reorder (z-order)
// ----------------------------------------------------------------------------
// Pointer-driven reordering of the layer cards. Dragging a card to a new slot
// rewrites the shape paint order inside #ink-wrapper, which renderOutput() then
// reflects in both the preview and the serialized export. Cards are uniform
// height; the dragged card lifts and follows the pointer while the others slide
// to open a gap, then the lifted card settles into place (Illustrator-style).
// ============================================================================

// Parse an SVG transform attribute into a DOMMatrix. Guarded so a malformed
// value degrades to identity rather than throwing during a reorder commit.
const svgTransformToMatrix = (str) => {

    let m = new DOMMatrix();

    if (!str) return m;

    try {

        const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g;

        let t;

        while ((t = re.exec(str)) !== null) {

            const fn = t[1];

            const a = t[2].split(/[\s,]+/).map(parseFloat).filter(n => !isNaN(n));

            if (fn === 'matrix' && a.length === 6) m = m.multiply(new DOMMatrix([a[0], a[1], a[2], a[3], a[4], a[5]]));

            else if (fn === 'translate') m = m.translate(a[0] || 0, a[1] || 0);

            else if (fn === 'scale') m = m.scale(a.length ? a[0] : 1, a.length > 1 ? a[1] : (a.length ? a[0] : 1));

            else if (fn === 'rotate') m = a.length >= 3 ? m.translate(a[1], a[2]).rotate(a[0]).translate(-a[1], -a[2]) : m.rotate(a[0] || 0);

            else if (fn === 'skewX') m = m.skewX(a[0] || 0);

            else if (fn === 'skewY') m = m.skewY(a[0] || 0);

        }

    } catch (_) { return new DOMMatrix(); }

    return m;

};

// Product of every ancestor transform from node's parent up to (not incl) stopAncestor.
const cumulativeAncestorMatrix = (node, stopAncestor) => {

    const chain = [];

    let el = node.parentNode;

    while (el && el !== stopAncestor && el.nodeType === 1) { chain.unshift(el); el = el.parentNode; }

    let m = new DOMMatrix();

    chain.forEach(a => { const tr = a.getAttribute && a.getAttribute('transform'); if (tr) m = m.multiply(svgTransformToMatrix(tr)); });

    return m;

};

const matrixToString = (m) => {

    const r = n => { const v = Math.abs(n) < 1e-6 ? 0 : +n.toFixed(6); return String(v); };

    return `matrix(${r(m.a)},${r(m.b)},${r(m.c)},${r(m.d)},${r(m.e)},${r(m.f)})`;

};

const INHERITED_LAYER_ATTRS = ['fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit', 'fill-rule', 'clip-rule', 'fill-opacity', 'stroke-opacity'];

const fmtLayerNumber = (n) => {

    const v = Math.max(0, Math.min(1, n));

    return String(+v.toFixed(4));

};

const ancestorList = (node, stopAncestor) => {

    const list = [];

    let el = node.parentNode;

    while (el && el !== stopAncestor && el.nodeType === 1) { list.push(el); el = el.parentNode; }

    return list;

};

const bakeAncestorPaintContext = (shape, wrapper) => {

    const ancestors = ancestorList(shape, wrapper);

    if (!ancestors.length) return;

    INHERITED_LAYER_ATTRS.forEach(attr => {

        const owner = ancestors.find(a => a.hasAttribute && a.hasAttribute(attr));

        const isGeneratedFill = attr === 'fill' && shape.getAttribute('data-pf-default-fill') === 'true';

        if (shape.hasAttribute(attr) && !isGeneratedFill) return;

        if (owner) {

            shape.setAttribute(attr, owner.getAttribute(attr));

            if (attr === 'fill') shape.removeAttribute('data-pf-default-fill');

        }

    });

    let opacityProduct = 1;

    ancestors.forEach(a => {

        if (!a.hasAttribute || !a.hasAttribute('opacity')) return;

        const v = parseFloat(a.getAttribute('opacity'));

        if (!isNaN(v)) opacityProduct *= v;

    });

    if (Math.abs(opacityProduct - 1) < 1e-6) return;

    const ownOpacity = parseFloat(shape.getAttribute('opacity'));

    const finalOpacity = (isNaN(ownOpacity) ? 1 : ownOpacity) * opacityProduct;

    shape.setAttribute('opacity', fmtLayerNumber(finalOpacity));

};

// Rewrite shape paint order to match the panel card order (top card = top of stack
// = last child). Each shape is appended at #ink-wrapper level; if it sat under a
// transformed/styled ancestor, that context is baked onto the shape so its
// on-canvas appearance is preserved. Emptied groups are pruned.
const reorderShapesToCardOrder = (cards) => {

    if (!globalOptimizedSvg) return;

    const wrapper = globalOptimizedSvg.querySelector(':scope > g#ink-wrapper') || globalOptimizedSvg;

    const orderedShapes = [];

    // Panel is reversed relative to DOM paint order: walk bottom card -> top card.
    for (let i = cards.length - 1; i >= 0; i--) {

        const pfIndex = cards[i].getAttribute('data-pf-index');

        if (pfIndex === null) continue;

        const shape = globalOptimizedSvg.querySelector(`[data-pf-index="${pfIndex}"]`);

        if (!shape || !isEditableLayerShape(shape, wrapper)) throw new Error('Layer reorder shape lookup failed.');

        orderedShapes.push(shape);

    }

    orderedShapes.forEach(shape => {

        if (shape.parentNode !== wrapper) {

            bakeAncestorPaintContext(shape, wrapper);

            const anc = cumulativeAncestorMatrix(shape, wrapper);

            if (!anc.isIdentity) {

                const own = shape.getAttribute('transform');

                const full = own ? anc.multiply(svgTransformToMatrix(own)) : anc;

                if (full.isIdentity) shape.removeAttribute('transform');

                else shape.setAttribute('transform', matrixToString(full));

            }

        }

        wrapper.appendChild(shape);

    });

    // Prune groups left empty by the moves (kept appearance-neutral by the bake).
    wrapper.querySelectorAll('g').forEach(g => { if (g.id !== 'ink-wrapper' && !g.children.length) g.remove(); });

};

window.initLayerDnD = (() => {

    let inited = false;

    return () => {

        if (inited || !layersList) return;

        inited = true;

        const THRESHOLD = 4;        // px before a press becomes a drag
        const EDGE = 36;            // auto-scroll trigger zone at list edges
        const MAX_SCROLL = 16;      // max auto-scroll px/frame

        let cand = null;            // { item, startX, startY, pointerId }
        let dragging = false, dropping = false;
        let items = [], dragItem = null, originalIndex = 0, currentTarget = 0, step = 0;
        let startContentY = 0, lastClientY = 0, rafId = 0;

        const applyShifts = () => {

            for (let j = 0; j < items.length; j++) {

                const it = items[j];

                if (it === dragItem) continue;

                it.classList.add('is-drag-shift');

                let ty = 0;

                if (currentTarget > originalIndex && j > originalIndex && j <= currentTarget) ty = -step;

                else if (currentTarget < originalIndex && j < originalIndex && j >= currentTarget) ty = step;

                it.style.transform = ty ? `translateY(${ty}px)` : '';

            }

        };

        const frame = () => {

            if (!dragging) return;

            const listRect = layersList.getBoundingClientRect();

            let spd = 0;

            if (lastClientY < listRect.top + EDGE) spd = -Math.ceil(((listRect.top + EDGE - lastClientY) / EDGE) * MAX_SCROLL);

            else if (lastClientY > listRect.bottom - EDGE) spd = Math.ceil(((lastClientY - (listRect.bottom - EDGE)) / EDGE) * MAX_SCROLL);

            if (spd) { layersList.scrollTop += spd; if (window.updateAllScrollbars) window.updateAllScrollbars(); }

            const contentY = lastClientY - listRect.top + layersList.scrollTop;

            const rawDy = contentY - startContentY;
            const firstItem = items[0];
            const lastItem = items[items.length - 1];
            const minDy = firstItem.offsetTop - dragItem.offsetTop;
            const maxDy = lastItem.offsetTop + lastItem.offsetHeight - dragItem.offsetTop - dragItem.offsetHeight;
            const dy = Math.max(minDy, Math.min(maxDy, rawDy));

            dragItem.style.transform = `translateY(${dy}px) scale(1.015)`;

            let target = originalIndex + Math.round(dy / step);

            target = Math.max(0, Math.min(items.length - 1, target));

            if (target !== currentTarget) { currentTarget = target; applyShifts(); }

            rafId = requestAnimationFrame(frame);

        };

        const cleanup = () => {

            items.forEach(it => {

                it.classList.remove('is-drag-shift', 'is-drag-source');

                it.style.transition = 'none';

                it.style.transform = '';

                it.style.boxShadow = '';

                it.style.zIndex = '';

            });

            void layersList.offsetHeight;            // flush so the cleared state is the baseline

            items.forEach(it => { it.style.transition = ''; });

            document.body.classList.remove('is-reordering-layers');

            layersList.classList.remove('is-reordering');

        };

        function stopPointerListeners() {

            window.removeEventListener('pointermove', onPointerMove);

            window.removeEventListener('pointerup', onPointerUp);

            window.removeEventListener('pointercancel', onPointerCancel);

            if (dragItem) dragItem.removeEventListener('lostpointercapture', onPointerLost);

        }

        function cancelDrag() {

            stopPointerListeners();

            if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }

            if (dragging || dropping) cleanup();

            dragging = false; dropping = false; cand = null;

        }

        const commitDrop = () => {

            let moved = currentTarget !== originalIndex;

            if (moved) {

                const newOrder = items.slice();

                newOrder.splice(originalIndex, 1);

                newOrder.splice(currentTarget, 0, dragItem);

                try {

                    reorderShapesToCardOrder(newOrder);

                    newOrder.forEach(c => layersList.appendChild(c));   // reorder cards (state preserved)

                } catch (err) {

                    moved = false;

                    console.warn('Layer reorder failed; panel order was left unchanged.', err);

                }

            }

            cleanup();

            dragging = false; dropping = false; cand = null;

            if (moved) { window.setHistoryLabel?.('Reorder Layer', 'layers-twirl'); renderOutput(false); }

            if (window.updateAllScrollbars) window.updateAllScrollbars();

        };

        const onPointerMove = (e) => {

            if (!cand) return;

            lastClientY = e.clientY;

            if (!dragging) {

                if (Math.abs(e.clientY - cand.startY) < THRESHOLD && Math.abs(e.clientX - cand.startX) < THRESHOLD) return;

                startDrag(e);

            }

        };

        const onPointerUp = () => {

            stopPointerListeners();

            if (!dragging) { cand = null; return; }    // it was a click/double-click, not a drag

            cancelAnimationFrame(rafId);

            dropping = true;

            const finalDy = (currentTarget - originalIndex) * step;

            dragItem.style.transition = 'transform 0.22s cubic-bezier(0.2, 0.8, 0.2, 1)';

            dragItem.style.transform = `translateY(${finalDy}px) scale(1)`;

            let done = false;

            const finish = () => { if (done) return; done = true; commitDrop(); };

            const onEnd = (ev) => { if (ev.propertyName === 'transform') { dragItem.removeEventListener('transitionend', onEnd); finish(); } };

            dragItem.addEventListener('transitionend', onEnd);

            setTimeout(finish, 320);                   // fallback if transitionend is missed

        };

        function onPointerCancel() { cancelDrag(); }

        function onPointerLost() { if (!dropping) cancelDrag(); }

        function startDrag(e) {

            dragging = true; dropping = false;

            items = Array.from(layersList.querySelectorAll('.layer-item'));

            dragItem = cand.item;

            originalIndex = items.indexOf(dragItem);

            const listRect = layersList.getBoundingClientRect();

            step = items.length > 1 ? Math.abs(items[1].offsetTop - items[0].offsetTop) : (dragItem.offsetHeight + LP_LIST_GAP);

            startContentY = cand.startY - listRect.top + layersList.scrollTop;

            currentTarget = originalIndex;

            dragItem.classList.add('is-drag-source');

            dragItem.style.transition = 'none';

            document.body.classList.add('is-reordering-layers');

            layersList.classList.add('is-reordering');

            try { dragItem.setPointerCapture(cand.pointerId); } catch (_) {}

            dragItem.addEventListener('lostpointercapture', onPointerLost);

            lastClientY = e.clientY;

            rafId = requestAnimationFrame(frame);

        }

        layersList.addEventListener('pointerdown', (e) => {

            if (e.button !== 0 || dropping) return;

            const header = e.target.closest('.layer-title-row');

            if (!header || e.target.closest('.layer-title-input, .layer-toggle')) return;

            const item = header.closest('.layer-item');

            if (!item) return;

            cand = { item, startX: e.clientX, startY: e.clientY, pointerId: e.pointerId };

            window.addEventListener('pointermove', onPointerMove);

            window.addEventListener('pointerup', onPointerUp);

            window.addEventListener('pointercancel', onPointerCancel);

        });

    };

})();

// Drag on any empty part between the Layers header and footer to draw an
// Illustrator-style marquee. Every card the rectangle touches is selected.
window.initLayerMarquee = (() => {

    let inited = false;

    return () => {

        const panel = document.getElementById('layersPanel');
        const header = panel?.querySelector('.panel-header-flex');
        const footer = panel?.querySelector('.layers-toolbar');

        if (inited || !panel || !header || !footer || !layersList) return;

        inited = true;

        const THRESHOLD = 3;
        let cand = null, marquee = null, dragging = false, marqueeRaf = 0;
        let pendingX = 0, pendingY = 0;

        const stop = () => {

            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
            window.removeEventListener('pointercancel', onUp);

            if (marqueeRaf) cancelAnimationFrame(marqueeRaf);
            if (marquee) marquee.remove();

            cand = null; marquee = null; dragging = false; marqueeRaf = 0;

        };

        const paintSelection = (clientX, clientY) => {

            const left = Math.min(cand.startX, clientX);
            const top = Math.min(cand.startY, clientY);
            const right = Math.max(cand.startX, clientX);
            const bottom = Math.max(cand.startY, clientY);
            const panelRect = panel.getBoundingClientRect();
            const bodyTop = header.getBoundingClientRect().bottom;
            const bodyBottom = footer.getBoundingClientRect().top;
            const drawLeft = Math.max(panelRect.left, Math.min(panelRect.right, left));
            const drawTop = Math.max(bodyTop, Math.min(bodyBottom, top));
            const drawRight = Math.max(panelRect.left, Math.min(panelRect.right, right));
            const drawBottom = Math.max(bodyTop, Math.min(bodyBottom, bottom));

            marquee.style.left = `${drawLeft - panelRect.left}px`;
            marquee.style.top = `${drawTop - panelRect.top}px`;
            marquee.style.width = `${drawRight - drawLeft}px`;
            marquee.style.height = `${drawBottom - drawTop}px`;

            const nextSelection = new Set();

            layersList.querySelectorAll('.layer-item').forEach(item => {

                const r = item.getBoundingClientRect();
                const intersects = r.right >= left && r.left <= right && r.bottom >= top && r.top <= bottom;
                const idx = item.getAttribute('data-pf-index');

                if (intersects && idx != null) nextSelection.add(idx);

            });

            const changed = nextSelection.size !== selectedLayerIndex.size ||
                [...nextSelection].some(idx => !selectedLayerIndex.has(idx));

            if (!changed) return;

            selectedLayerIndex.clear();
            nextSelection.forEach(idx => selectedLayerIndex.add(idx));

            layersList.querySelectorAll('.layer-item').forEach(item => {

                item.classList.toggle('is-selected', selectedLayerIndex.has(item.getAttribute('data-pf-index')));

            });

            syncDeleteLayerBtn();
            window.refreshPaintPanel?.();

        };

        function onMove(e) {

            if (!cand || e.pointerId !== cand.pointerId) return;

            if (!dragging) {

                if (Math.abs(e.clientX - cand.startX) < THRESHOLD && Math.abs(e.clientY - cand.startY) < THRESHOLD) return;

                dragging = true;
                marquee = createEl('div', 'layers-marquee');
                panel.appendChild(marquee);
                document.body.classList.add('is-marquee-selecting-layers');

            }

            e.preventDefault();
            pendingX = e.clientX;
            pendingY = e.clientY;

            if (!marqueeRaf) marqueeRaf = requestAnimationFrame(() => {

                marqueeRaf = 0;
                if (dragging && cand) paintSelection(pendingX, pendingY);

            });

        }

        function onUp(e) {

            if (!cand || e.pointerId !== cand.pointerId) return;

            if (dragging && marqueeRaf) {

                cancelAnimationFrame(marqueeRaf);
                marqueeRaf = 0;
                paintSelection(pendingX, pendingY);

            }

            document.body.classList.remove('is-marquee-selecting-layers');
            stop();

        }

        panel.addEventListener('pointerdown', (e) => {

            if (e.button !== 0 || e.target.closest('.panel-header-flex, .layers-toolbar, .layer-item, .custom-scroll-thumb')) return;

            e.stopPropagation();

            cand = {
                startX: e.clientX,
                startY: e.clientY,
                pointerId: e.pointerId
            };

            window.addEventListener('pointermove', onMove, { passive: false });
            window.addEventListener('pointerup', onUp);
            window.addEventListener('pointercancel', onUp);

        });

    };

})();


// ============================================================================
// Paint Panel (Fill / Stroke / Weight)
// ----------------------------------------------------------------------------
// The single place layer paint is edited, Illustrator-style: every control acts on
// every vector shape in the panel selection (selectedLayerIndex -- which the canvas
// tools mirror into), or on the DRAWING DEFAULTS used by the Shape/Pen tools when
// nothing is selected. Markup is static in index.html (#paintPanel); all
// behavior lives here. See docs/paint-panel.md.
// ============================================================================

const AP_PRESET_COLORS = ['#000000', '#FF0000', '#00FF00', '#0000FF', '#FFFFFF', '#FFFF00', '#00FFFF', '#FF00FF'];

const apEls = {
    panel: $('paintPanel'),
    rows: $('paintRows'),
    fill: { swatch: $('apFillSwatch'), none: $('apFillNone'), hex: $('apFillHex'), presets: $('apFillPresets') },
    stroke: { swatch: $('apStrokeSwatch'), none: $('apStrokeNone'), hex: $('apStrokeHex'), presets: $('apStrokePresets') },
    weightMount: $('apWeightMount')
};

let apUpdateRaf = null;

let apGradIds = { fill: null, stroke: null };   // per-row dedicated pf-grad id for the current picker session

let apLastPaint = { fill: null, stroke: null }; // last non-none paint per row, restored by the None toggle

const apWeightInputs = [];



// The shapes the panel edits right now. 'defaults' = nothing selected (edit the drawing
// defaults); 'inert' = only raster layers selected (nothing paintable); 'disabled' = no doc.
const apTargets = () => {

    if (!globalOptimizedSvg) return { mode: 'disabled', shapes: [] };

    if (selectedLayerIndex.size === 0) return { mode: 'defaults', shapes: [] };

    const shapes = [];

    selectedLayerIndex.forEach(idx => {

        const s = globalOptimizedSvg.querySelector(`[data-pf-index="${idx}"]`);

        if (s && !lockedLayers.has(String(idx)) && !isRasterLayerShape(s)) shapes.push(s);

    });

    return shapes.length ? { mode: 'selection', shapes } : { mode: 'inert', shapes: [] };

};

// Common paint across the targets: 'none' | '#RRGGBB' | 'url(#id)' | AP_MIXED.
const apReadCommon = (shapes, attrKey) => {

    let val;

    for (const s of shapes) {

        let v = s.getAttribute(attrKey);

        if (!v || v === 'none') v = 'none';

        else if (!v.includes('url')) v = colorToHex(v).toUpperCase();

        if (val === undefined) val = v;

        else if (val !== v) return AP_MIXED;

    }

    return val === undefined ? 'none' : val;

};

const apReadCommonWidth = (shapes) => {

    let val;

    for (const s of shapes) {

        const v = parseFloat(s.getAttribute('stroke-width'));

        const n = isNaN(v) ? 1 : v;   // the SVG default stroke-width

        if (val === undefined) val = n;

        else if (Math.abs(val - n) > 1e-6) return AP_MIXED;

    }

    return val === undefined ? AP_MIXED : val;

};

// Drop a generated pf-grad-* def once nothing references it anymore.
const apRemoveGradientIfUnused = (gradRef) => {

    const match = String(gradRef || '').match(/url\(['"]?#([^)'"]+)['"]?\)/);

    if (!match || !match[1] || !match[1].startsWith('pf-grad-')) return;

    const gradId = match[1];

    const stillUsed = Array.from(globalOptimizedSvg.querySelectorAll('*')).some(el => {

        const f = el.getAttribute('fill'), s = el.getAttribute('stroke');

        return (f && f.includes(`url(#${gradId})`)) || (s && s.includes(`url(#${gradId})`));

    });

    if (stillUsed) return;

    const gradEl = globalOptimizedSvg.querySelector(`#${gradId}`);

    if (gradEl) {

        const defs = gradEl.parentNode;

        gradEl.remove();

        if (defs && defs.tagName && defs.tagName.toLowerCase() === 'defs' && !defs.children.length) defs.remove();

    }

};

// Materialize a picker gradient object into a row-dedicated def shared by the whole selection.
const apMaterializeGradient = (attrKey, val) => {

    let defs = globalOptimizedSvg.querySelector('defs');

    if (!defs) {

        defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');

        globalOptimizedSvg.insertBefore(defs, globalOptimizedSvg.firstChild);

    }

    if (!apGradIds[attrKey]) apGradIds[attrKey] = `pf-grad-${Math.random().toString(36).substr(2, 9)}`;

    const gid = apGradIds[attrKey];

    let gradEl = defs.querySelector(`#${gid}`);

    const targetTag = val.type === 'linear' ? 'linearGradient' : 'radialGradient';

    if (gradEl && gradEl.tagName.toLowerCase() !== targetTag.toLowerCase()) { gradEl.remove(); gradEl = null; }

    if (!gradEl) {

        gradEl = document.createElementNS('http://www.w3.org/2000/svg', targetTag);

        gradEl.setAttribute('id', gid);

        defs.appendChild(gradEl);

    }

    if (val.type === 'linear') {

        gradEl.setAttribute('x1', '0.5'); gradEl.setAttribute('y1', '1');

        gradEl.setAttribute('x2', '0.5'); gradEl.setAttribute('y2', '0');

        if (val.angle !== 0) gradEl.setAttribute('gradientTransform', `rotate(${val.angle}, 0.5, 0.5)`);

        else gradEl.removeAttribute('gradientTransform');

    } else {

        gradEl.setAttribute('cx', '0.5'); gradEl.setAttribute('cy', '0.5'); gradEl.setAttribute('r', '0.5');

        gradEl.removeAttribute('gradientTransform');

    }

    let stopsHtml = '';

    const n = val.stops.length;

    val.stops.forEach((stopCol, i) => {

        const offset = n === 1 ? 0 : (i / (n - 1)) * 100;

        stopsHtml += `<stop offset="${offset}%" stop-color="${stopCol}" />`;

    });

    gradEl.innerHTML = stopsHtml;

    return `url(#${gid})`;

};

// The one write path for fill/stroke edits (swatch picker, none button, hex field, presets).
// With no selection it retargets the drawing defaults (solid colors only -- a gradient
// coerces to its first stop). `op` is the picker's opacity slider (fill/stroke-opacity).
const applyPaintToTargets = (attrKey, val, scrub, isGradFlag, op) => {

    const isStroke = attrKey === 'stroke';

    const t = apTargets();

    if (t.mode === 'disabled' || t.mode === 'inert') return;

    if (t.mode === 'defaults') {

        let hex = null;

        if (isGradFlag && typeof val === 'object' && val !== null) hex = colorToHex((val.stops && val.stops[0]) || '#000000').toUpperCase();

        else if (typeof val === 'string') hex = val === 'none' ? 'none' : (val.includes('url') ? null : val.toUpperCase());

        if (hex !== null) { if (isStroke) apDrawStroke = hex; else apDrawFill = hex; }

        apPaintRows();

        return;

    }

    const nodes = t.shapes;

    const prevVals = nodes.map(n => n.getAttribute(attrKey));

    let activeVal;

    if (isGradFlag && typeof val === 'object' && val !== null) activeVal = apMaterializeGradient(attrKey, val);

    else if (typeof val === 'string') activeVal = val === 'none' ? 'none' : (val.includes('url') ? val : val.toUpperCase());

    else return;

    nodes.forEach(n => {

        n.setAttribute(attrKey, activeVal);

        if (attrKey === 'fill') n.removeAttribute('data-pf-default-fill');

        if (isStroke && activeVal !== 'none' && (!n.hasAttribute('stroke-width') || parseFloat(n.getAttribute('stroke-width')) === 0)) n.setAttribute('stroke-width', '1');

    });

    if (typeof op === 'number') {

        const v = Math.min(100, Math.max(0, op));

        nodes.forEach(n => {

            if (v >= 100) n.removeAttribute(`${attrKey}-opacity`);

            else { let f = (v / 100).toFixed(2).replace(/\.?0+$/, ''); n.setAttribute(`${attrKey}-opacity`, f === '' ? '0' : f); }

        });

    }

    if (!activeVal.includes('url')) prevVals.forEach(pv => { if (pv && pv.includes('url')) apRemoveGradientIfUnused(pv); });

    apPaintRows();

    if (scrub) {

        if (apUpdateRaf) cancelAnimationFrame(apUpdateRaf);

        apUpdateRaf = requestAnimationFrame(() => renderOutput(true));

    } else {

        window.setHistoryLabel?.(typeof op === 'number' ? 'Set Opacity' : (isStroke ? 'Set Stroke' : 'Set Fill'), typeof op === 'number' ? 'slider-horizontal' : 'swatch');

        renderOutput(false);

    }

};

// Extract picker passData ({ type, angle, stops[] }) from an existing url(#grad) paint.
const apGradPassData = (gradRef) => {

    const m = String(gradRef || '').match(/url\(['"]?#([^)'"]+)['"]?\)/);

    const gradEl = m && m[1] ? (globalOptimizedSvg.querySelector(`#${m[1]}`) || (globalOriginalSvg && globalOriginalSvg.querySelector(`#${m[1]}`))) : null;

    if (!gradEl) return null;

    const type = gradEl.tagName.toLowerCase() === 'radialgradient' ? 'angular' : 'linear';

    let angle = 0;

    if (type === 'linear') {

        const transform = gradEl.getAttribute('gradientTransform');

        if (transform && transform.includes('rotate')) {

            const match = transform.match(/rotate\(([-0-9.]+)/);

            if (match) angle = parseFloat(match[1]);

        }

    }

    const stops = [];

    gradEl.querySelectorAll('stop').forEach(s => {

        let c = s.getAttribute('stop-color');

        if (c && c !== 'none' && c !== 'currentColor') {

            let col = colorToHex(c);

            const so = s.getAttribute('stop-opacity');

            if (so !== null) {

                const a = parseFloat(so);

                if (!isNaN(a) && a < 1) {

                    const mm = col.match(/rgba?\(([^)]+)\)/);

                    if (mm) { const p = mm[1].split(',').map(parseFloat); col = `rgba(${p[0]}, ${p[1]}, ${p[2]}, ${(isNaN(p[3]) ? 1 : p[3]) * a})`; }

                    else { col = `rgba(${parseInt(col.slice(1, 3), 16)}, ${parseInt(col.slice(3, 5), 16)}, ${parseInt(col.slice(5, 7), 16)}, ${a})`; }

                }

            }

            stops.push(col);

        }

    });

    return stops.length >= 2 ? { type, angle, stops } : null;

};

// Launch the shared color picker for one row; live/confirm/cancel all funnel into
// applyPaintToTargets. Also the entry point the color-picker bridge retargets when a
// canvas shape is clicked while the picker is open.
const apOpenPicker = (attrKey) => {

    const t = apTargets();

    if (t.mode === 'disabled' || t.mode === 'inert') return;

    const isStroke = attrKey === 'stroke';

    let cur, opPct = 100;

    if (t.mode === 'defaults') {

        cur = isStroke ? apDrawStroke : apDrawFill;

    } else {

        cur = apReadCommon(t.shapes, attrKey);

        const opAttr = t.shapes[0].getAttribute(`${attrKey}-opacity`);

        opPct = opAttr !== null ? Math.round(parseFloat(opAttr) * 100) : 100;

        if (isNaN(opPct)) opPct = 100;

    }

    let isGrad = typeof cur === 'string' && cur.includes('url');

    let passData = cur;

    if (isGrad) {

        passData = apGradPassData(cur);

        if (!passData) { passData = '#000000'; isGrad = false; }

    } else if (cur === 'none' || cur === AP_MIXED) passData = '#000000';

    apGradIds[attrKey] = null;   // a fresh picker session materializes into a fresh def

    window.openCustomPicker(passData, isGrad, (newCol, scrub, isGradFlag, op) => applyPaintToTargets(attrKey, newCol, scrub, isGradFlag, op), opPct);

};

window.paintOpenPicker = apOpenPicker;



// --- Stroke weight field (stepper / value / pt / preset dropdown) -------------

const AP_STROKE_PRESETS = [0.25, 0.5, 0.75, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 14, 16, 18, 20, 40, 60, 80, 100];

const apGetStrokeStep = (cur, e) => {

    if (e && e.ctrlKey) return 0.1;

    if (e && e.shiftKey) return 10;

    return cur < 1 ? 0.25 : 1;

};

// Write a stroke width to the targets (or the drawing default). Setting a width never
// revives a 'none' stroke -- the attribute simply waits until a stroke color returns.
const applyStrokeWidthToTargets = (v, scrub, source) => {

    const t = apTargets();

    if (t.mode === 'disabled' || t.mode === 'inert') return;

    const width = Math.max(0, v);

    const disp = Number(width.toFixed(4));

    apWeightInputs.forEach(inp => { if (inp !== source) inp.value = disp; });

    if (t.mode === 'defaults') { apDrawStrokeWidth = width; return; }

    if (!scrub) window.setHistoryLabel?.('Stroke Width', 'slider-horizontal');

    t.shapes.forEach(n => n.setAttribute('stroke-width', width));

    if (apUpdateRaf) cancelAnimationFrame(apUpdateRaf);

    apUpdateRaf = requestAnimationFrame(() => renderOutput(scrub));

};

const apMakeWeightField = () => {

    const chevronUp = `<svg viewBox="0 0 10 6"><path d="M1 5L5 1L9 5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

    const chevronDown = `<svg viewBox="0 0 10 6"><path d="M1 1L5 5L9 1" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

    const commitStrokeVal = (val) => { applyStrokeWidthToTargets(Math.max(0, val), false); };

    const inp = createEl('input', 'cp-size-input', { type: 'text', value: '', spellcheck: false,

        oninput: e => {

            let raw = e.target.value.replace(/[^0-9.]/g, '');

            let dotIdx = raw.indexOf('.');

            if (dotIdx !== -1) { raw = raw.slice(0, dotIdx + 1) + raw.slice(dotIdx + 1).replace(/\./g, ''); raw = raw.slice(0, dotIdx + 5); }

            if (raw !== e.target.value) e.target.value = raw;

            if (raw === '' || raw === '.') return;

            let parsed = parseFloat(raw); if (isNaN(parsed)) return;

            applyStrokeWidthToTargets(Math.max(0, parsed), true, inp);

        },

        onblur: e => {

            let parsed = parseFloat(e.target.value);

            // A blank blur restores the display (a mixed selection shows an empty field --
            // leaving it must not stamp a width onto every member).
            if (isNaN(parsed) || e.target.value.trim() === '') { apPaintRows(); return; }

            let v = Math.max(0, parsed);

            e.target.value = Number(v.toFixed(4));

            applyStrokeWidthToTargets(v, false);

        },

        onkeydown: e => {

            if (e.key === 'Enter') { e.preventDefault(); inp.blur(); return; }

            if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {

                e.preventDefault();

                let cur = parseFloat(inp.value) || 0;

                let step = apGetStrokeStep(cur, e);

                let v = Math.max(0, e.key === 'ArrowUp' ? cur + step : cur - step);

                applyStrokeWidthToTargets(v, false);

            }

        }

    });

    apWeightInputs.push(inp);

    const stepUp = createEl('div', 'cp-step-btn', { innerHTML: chevronUp, onclick: e => { e.stopPropagation(); let cur = parseFloat(inp.value) || 0; commitStrokeVal(cur + apGetStrokeStep(cur, e)); } });

    const stepDown = createEl('div', 'cp-step-btn', { innerHTML: chevronDown, onclick: e => { e.stopPropagation(); let cur = parseFloat(inp.value) || 0; commitStrokeVal(cur - apGetStrokeStep(cur, e)); } });

    const stepper = createEl('div', 'cp-stepper', {}, [stepUp, stepDown]);

    let group;

    const ddBtn = createEl('div', 'cp-stroke-dd-btn', {

        title: 'Stroke Presets',

        innerHTML: chevronDown,

        onclick: e => {

            e.stopPropagation();

            if (strokeDropdown.style.display === 'block' && strokeDropdown._ownerInput === inp) {

                strokeDropdown.style.display = 'none'; return;

            }

            strokeDropdown._ownerInput = inp;

            strokeDropdown.innerHTML = '';

            AP_STROKE_PRESETS.forEach(p => {

                strokeDropdown.appendChild(createEl('div', 'stroke-dd-item', { textContent: `${p} pt`, onclick: () => { commitStrokeVal(p); strokeDropdown.style.display = 'none'; } }));

            });

            const rect = group.getBoundingClientRect();

            strokeDropdown.style.display = 'block';

            strokeDropdown.style.minWidth = `${rect.width}px`;

            strokeDropdown.style.left = `${rect.left}px`;

            strokeDropdown.style.top = `${rect.bottom + 4}px`;

            const ddRect = strokeDropdown.getBoundingClientRect();

            if (ddRect.bottom > window.innerHeight - 8) {

                strokeDropdown.style.top = `${Math.max(8, rect.top - ddRect.height - 4)}px`;

            }

            if (ddRect.right > window.innerWidth - 8) {

                strokeDropdown.style.left = `${Math.max(8, window.innerWidth - 8 - ddRect.width)}px`;

            }

        }

    });

    group = createEl('div', 'cp-input-group cp-stroke-field', {}, [stepper, inp, createEl('span', 'cp-unit', { textContent: 'pt' }), ddBtn]);

    return group;

};



// --- Painting the panel from the current targets -------------------------------

const apPaintRow = (attrKey, value) => {

    const els = attrKey === 'stroke' ? apEls.stroke : apEls.fill;

    let gradData = null;

    if (typeof value === 'string' && value.includes('url')) gradData = readGradData(value);

    renderPickerSwatch(els.swatch, value, attrKey === 'stroke', gradData);

    if (els.none) {

        els.none.classList.toggle('active', value === 'none');

        els.none.setAttribute('aria-pressed', value === 'none' ? 'true' : 'false');

    }

    if (els.hex && document.activeElement !== els.hex) {

        els.hex.value = (typeof value === 'string' && !value.includes('url') && value !== 'none' && value !== AP_MIXED) ? value.replace('#', '') : '';

        els.hex.placeholder = value === AP_MIXED ? '?' : '';

    }

};

const apSetWeightDisplay = (v) => {

    apWeightInputs.forEach(inp => { if (document.activeElement !== inp) inp.value = v; });

};

const apPaintRows = () => {

    const t = apTargets();

    if (apEls.rows) apEls.rows.classList.toggle('is-inert', t.mode === 'inert');

    if (t.mode === 'inert') return;   // greyed; keep the last painted values under the wash

    if (t.mode === 'selection') {

        apPaintRow('fill', apReadCommon(t.shapes, 'fill'));

        apPaintRow('stroke', apReadCommon(t.shapes, 'stroke'));

        const wv = apReadCommonWidth(t.shapes);

        apSetWeightDisplay(wv === AP_MIXED ? '' : Number(wv.toFixed(4)));

        return;

    }

    // defaults / disabled: show what the next drawn shape will use

    apPaintRow('fill', apDrawFill);

    apPaintRow('stroke', apDrawStroke);

    if (apDrawStrokeWidth != null) apSetWeightDisplay(Number(Number(apDrawStrokeWidth).toFixed(4)));

    else apSetWeightDisplay(globalOptimizedSvg && window.getShapeToolDefaultStrokeWidth ? window.getShapeToolDefaultStrokeWidth() : 1);

};

const refreshPaintPanel = () => {

    if (!apEls.panel) return;

    apEls.panel.classList.toggle('is-disabled', !globalOptimizedSvg);

    apPaintRows();

};

window.refreshPaintPanel = refreshPaintPanel;

// The Shape/Pen tools stamp these onto every new shape ('auto' weight = the
// artboard-relative default from js/shape-tools.js).
window.getDrawingDefaults = () => ({

    fill: apDrawFill,

    stroke: apDrawStroke,

    strokeWidth: apDrawStrokeWidth != null ? String(Number(Number(apDrawStrokeWidth).toFixed(4))) : (window.getShapeToolDefaultStrokeWidth ? window.getShapeToolDefaultStrokeWidth() : '1')

});



// The None button is a toggle (like the old visibility eye): click once to set the paint
// to none, click again to restore the last color. The value swapped out is remembered per
// row so it survives the round trip; a stale/absent memory falls back to black.
const apToggleNone = (attrKey) => {

    const t = apTargets();

    if (t.mode === 'disabled' || t.mode === 'inert') return;

    const cur = t.mode === 'defaults' ? (attrKey === 'stroke' ? apDrawStroke : apDrawFill) : apReadCommon(t.shapes, attrKey);

    if (cur === 'none') {

        let restore = apLastPaint[attrKey];

        if (!restore || restore === 'none' || restore === AP_MIXED) restore = '#000000';

        else if (restore.includes('url')) {

            const m = restore.match(/url\(['"]?#([^)'"]+)['"]?\)/);

            if (!m || !globalOptimizedSvg.querySelector(`#${m[1]}`)) restore = '#000000';

        }

        applyPaintToTargets(attrKey, restore, false, false);

    } else {

        if (cur !== AP_MIXED) apLastPaint[attrKey] = cur;

        applyPaintToTargets(attrKey, 'none', false, false);

    }

};



// --- One-time wiring ------------------------------------------------------------

(() => {

    if (!apEls.panel) return;

    ['fill', 'stroke'].forEach(attrKey => {

        const els = attrKey === 'stroke' ? apEls.stroke : apEls.fill;

        if (els.swatch) els.swatch.onclick = () => apOpenPicker(attrKey);

        if (els.none) els.none.onclick = () => apToggleNone(attrKey);

        if (els.hex) {

            els.hex.onchange = e => {

                let v = e.target.value.trim().replace(/[^0-9A-Fa-f]/g, '');

                if (v.length === 3) v = v.split('').map(c => c + c).join('');

                if (v.length === 6) applyPaintToTargets(attrKey, '#' + v, false, false);

                else apPaintRows();

            };

            els.hex.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); els.hex.blur(); } };

        }

        if (els.presets) AP_PRESET_COLORS.forEach(c => {

            els.presets.appendChild(createEl('div', 'preset-swatch', { title: c, style: { backgroundColor: c }, onclick: () => applyPaintToTargets(attrKey, c, false, false) }));

        });

    });

    if (apEls.weightMount) apEls.weightMount.appendChild(apMakeWeightField());

    refreshPaintPanel();

})();



// ============================================================================
// Layer thumbnails
// ----------------------------------------------------------------------------
// Shape-only mini previews inside each card's .layer-thumb. The bounding box is
// measured from the LIVE preview twin (rendered, so getBBox is valid) and cached,
// so a hidden layer -- pruned from the preview -- keeps its last known framing
// while its art stays visible in the panel. Refreshed on committed renders only
// (never during scrubs) and painted straight from the model shape's attributes.
// ============================================================================

let apThumbBoxes = {};   // pf-index -> { x, y, w, h } in artboard space, stroke pad included

const apThumbNum = (n) => String(+n.toFixed(3));

const refreshLayerThumbnails = () => {

    if (!globalOptimizedSvg) { apThumbBoxes = {}; return; }

    const previewSvg = previewArea.querySelector(PREVIEW_SVG_SELECTOR);

    layersList.querySelectorAll('.layer-item').forEach(card => {

        const idx = card.getAttribute('data-pf-index');

        if (idx == null) return;

        const shape = globalOptimizedSvg.querySelector(`[data-pf-index="${idx}"]`);

        if (!shape || isRasterLayerShape(shape)) return;

        const thumbEl = card.querySelector('.layer-thumb');

        if (!thumbEl) return;

        const twin = previewSvg ? previewSvg.querySelector(`[data-pf-index="${idx}"]`) : null;

        if (twin) {

            try {

                const bb = twin.getBBox();

                const own = twin.getAttribute('transform');

                const M0 = cumulativeAncestorMatrix(twin, previewSvg);

                const M = own ? M0.multiply(svgTransformToMatrix(own)) : M0;

                let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

                [[bb.x, bb.y], [bb.x + bb.width, bb.y], [bb.x, bb.y + bb.height], [bb.x + bb.width, bb.y + bb.height]].forEach(([x, y]) => {

                    const p = M.transformPoint(new DOMPoint(x, y));

                    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;

                    if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;

                });

                const stroke = shape.getAttribute('stroke');

                const sw = (stroke && stroke !== 'none') ? (parseFloat(shape.getAttribute('stroke-width')) || 1) : 0;

                const pad = sw / 2 + Math.max(maxX - minX, maxY - minY) * 0.06 + 0.5;

                const box = { x: minX - pad, y: minY - pad, w: (maxX - minX) + 2 * pad, h: (maxY - minY) + 2 * pad };

                if (box.w > 0 && box.h > 0 && isFinite(box.w) && isFinite(box.h)) apThumbBoxes[idx] = box;

            } catch (_) {}

        }

        let box = apThumbBoxes[idx];

        if (!box) {   // never measured (invisible since load): frame the artboard instead

            const vb = (globalOptimizedSvg.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(parseFloat);

            box = (vb.length === 4 && vb.every(n => !isNaN(n))) ? { x: vb[0], y: vb[1], w: vb[2], h: vb[3] } : { x: 0, y: 0, w: 128, h: 128 };

        }

        const clone = shape.cloneNode(true);

        ['id', 'data-pf-index', 'data-pf-label', 'data-pf-default-fill', 'data-hidden-layer', 'data-stroke-align'].forEach(a => clone.removeAttribute(a));

        const anc = cumulativeAncestorMatrix(shape, globalOptimizedSvg);

        const own = shape.getAttribute('transform');

        const full = own ? anc.multiply(svgTransformToMatrix(own)) : anc;

        if (full.isIdentity) clone.removeAttribute('transform');

        else clone.setAttribute('transform', matrixToString(full));

        const svgEl = document.createElementNS('http://www.w3.org/2000/svg', 'svg');

        svgEl.setAttribute('class', 'layer-thumb-svg');

        svgEl.setAttribute('viewBox', `${apThumbNum(box.x)} ${apThumbNum(box.y)} ${apThumbNum(box.w)} ${apThumbNum(box.h)}`);

        svgEl.setAttribute('aria-hidden', 'true');

        // Gradient paints reference defs by id; copy them in under thumb-unique ids so
        // every thumbnail stays self-contained (duplicate ids across thumbs would clash).

        let defsEl = null;

        ['fill', 'stroke'].forEach(a => {

            const v = clone.getAttribute(a);

            const m = v && v.match(/url\(['"]?#([^)'"]+)['"]?\)/);

            if (!m || !m[1]) return;

            const src = globalOptimizedSvg.querySelector(`#${m[1]}`);

            if (!src) return;

            if (!defsEl) { defsEl = document.createElementNS('http://www.w3.org/2000/svg', 'defs'); svgEl.appendChild(defsEl); }

            const copy = src.cloneNode(true);

            const nid = `lpt-${idx}-${a}-${m[1]}`;

            copy.setAttribute('id', nid);

            defsEl.appendChild(copy);

            clone.setAttribute(a, `url(#${nid})`);

        });

        svgEl.appendChild(clone);

        thumbEl.replaceChildren(svgEl);

    });

};

window.refreshLayerThumbnails = refreshLayerThumbnails;
