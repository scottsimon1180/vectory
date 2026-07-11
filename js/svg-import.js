/* fileName: svg-import.js */

const resetUI = () => {

    layersList.innerHTML = '<div style="font-size:11px;color:var(--text-secondary);text-align:center;margin-top:30px;">Import SVG to view layers</div>';

    previewArea.querySelector(PREVIEW_SVG_SELECTOR)?.remove();
    window.hideArtboardOverlay?.();

    viewScale = 1; viewPanX = 0; viewPanY = 0;
    window.clearViewFitMode?.();

    const _statusBar = $('canvasStatusBar'); if (_statusBar) _statusBar.hidden = true;

    outputStr.value = ''; globalOptimizedSvg = globalOriginalSvg = null;
    hiddenLayers.clear(); lockedLayers.clear();   // UI-only layer state resets with the document
    window.clearRulersGuidesState?.();

    window.resetHistory?.();

    window.clearSelectionToolLock?.();
    window.clearDirectSelectionToolLock?.();
    window.clearArtboardToolState?.();
    window.clearPenToolState?.();
    window.syncShapeToolButtons?.();

    if(strokeDropdown) strokeDropdown.style.display = 'none';

    syncDeleteLayerBtn();

    window.refreshAppearancePanel?.();

    window.refreshLayerThumbnails?.();

    window.updateAllScrollbars();

    window.refreshElementProperties?.();

};



let processTimeout;

// Condensed-mode one-line import field (between Paste and Clear). It mirrors #inputStr both
// ways: typing here feeds the same debounced processSVG, and processSVG() syncs it back so
// file/clipboard/clear updates show up. The full textarea is the source of truth.

const importMiniInput = $('importMiniInput');

// While the I/O panels are condensed the textarea is hidden, so route the Paste-code focus
// and the import feedback rings to whichever field is actually visible.

const activeImportField = () => (importMiniInput && document.querySelector('.io-grid.io-condensed')) ? importMiniInput : inputStr;

inputStr.addEventListener('input', () => {

    clearTimeout(processTimeout);

    processTimeout = setTimeout(() => { window.processSVG(); }, 300);

});

if (importMiniInput) importMiniInput.addEventListener('input', () => {

    inputStr.value = importMiniInput.value;

    clearTimeout(processTimeout);

    processTimeout = setTimeout(() => { window.processSVG(); }, 300);

});



const decodeSvgBytes = async (buffer) => {

    let bytes = new Uint8Array(buffer);

    // Gzipped .svgz: inflate natively before decoding.

    if (bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b && typeof DecompressionStream !== 'undefined') {

        try {

            const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));

            bytes = new Uint8Array(await new Response(stream).arrayBuffer());

        } catch (e) {}

    }

    // Byte-order marks pin the encoding.

    if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return new TextDecoder('utf-8').decode(bytes.subarray(3));

    if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));

    if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));

    // Otherwise honor an explicit XML encoding declaration, defaulting to UTF-8.

    const head = new TextDecoder('iso-8859-1').decode(bytes.subarray(0, 200));

    const encMatch = head.match(/encoding=["']([^"']+)["']/i);

    if (encMatch) {

        try { return new TextDecoder(encMatch[1].toLowerCase()).decode(bytes); } catch (e) {}

    }

    return new TextDecoder('utf-8').decode(bytes);

};


const RASTER_IMPORT_MIME_BY_EXT = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    bmp: 'image/bmp'
};

const getImportFileExt = (file) => {
    const name = String((file && file.name) || '');
    const match = name.match(/\.([^.\\\/]+)$/);
    return match ? match[1].toLowerCase() : '';
};

const getRasterImportMime = (file) => {
    if (!file) return '';

    const type = String(file.type || '').toLowerCase();
    if (type === 'image/png' || type === 'image/jpeg' || type === 'image/webp' || type === 'image/bmp') return type;
    if (type === 'image/jpg') return 'image/jpeg';
    if (type === 'image/x-ms-bmp') return 'image/bmp';

    return RASTER_IMPORT_MIME_BY_EXT[getImportFileExt(file)] || '';
};

const isSupportedRasterFile = (file) => !!getRasterImportMime(file);

const isSupportedSvgFile = (file) => {

    if (!file) return false;

    return /\.svgz?$/i.test(file.name || '') || file.type === 'image/svg+xml';

};



const rejectImportFile = () => {

    const field = activeImportField();

    field.classList.add('ring-yellow');

    setTimeout(() => field.classList.remove('ring-yellow'), 1000);

};



const rejectLayerImportFile = (targetBtn) => {

    const btn = targetBtn || btnImportLayer;

    if (!btn) { rejectImportFile(); return; }

    btn.classList.add('btn-yellow');

    setTimeout(() => btn.classList.remove('btn-yellow'), 1000);

};



const readFileAsArrayBuffer = (file) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = ev => resolve(ev.target.result);
    reader.onerror = reject;
    reader.readAsArrayBuffer(file);
});

const readSvgFileText = async (file) => {
    const buffer = await readFileAsArrayBuffer(file);

    try {
        return await decodeSvgBytes(buffer);
    } catch (err) {
        return new TextDecoder('utf-8').decode(buffer);
    }
};

const loadSvgFile = (file) => {

    if (!isSupportedSvgFile(file)) { rejectImportFile(); return; }

    readSvgFileText(file).then(text => {
        inputStr.value = text;
        window.processSVG();
    }).catch(() => rejectImportFile());

};

const escapeSvgAttr = (value) =>
    String(value || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const readFileAsDataUrl = (file) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = ev => resolve(String(ev.target.result || ''));
    reader.onerror = reject;
    reader.readAsDataURL(file);
});

const readImageNaturalSize = (src) => new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
        const width = img.naturalWidth || img.width;
        const height = img.naturalHeight || img.height;
        if (width > 0 && height > 0) resolve({ width, height });
        else reject(new Error('Raster image has no intrinsic size.'));
    };
    img.onerror = reject;
    img.src = src;
});

const addRasterNameParam = (dataUrl, mime, fileName) => {
    const comma = dataUrl.indexOf(',');
    if (comma < 0) return dataUrl;

    const name = encodeURIComponent(fileName || 'Image');
    const payload = dataUrl.slice(comma + 1);

    return `data:${mime};name=${name};base64,${payload}`;
};

const buildRasterSvgWrapper = async (file) => {
    const mime = getRasterImportMime(file);
    const rawDataUrl = await readFileAsDataUrl(file);
    const href = addRasterNameParam(rawDataUrl, mime, file.name);
    const size = await readImageNaturalSize(href);

    return `<svg xmlns="http://www.w3.org/2000/svg" width="${size.width}" height="${size.height}" viewBox="0 0 ${size.width} ${size.height}"><image href="${escapeSvgAttr(href)}" x="0" y="0" width="${size.width}" height="${size.height}" preserveAspectRatio="none"/></svg>`;
};

const loadRasterFile = async (file) => {
    if (!isSupportedRasterFile(file)) { rejectImportFile(); return; }

    try {
        inputStr.value = await buildRasterSvgWrapper(file);
        window.processSVG();
    } catch (err) {
        rejectImportFile();
    }
};

const loadImportFile = (file) => {
    if (isSupportedSvgFile(file)) { loadSvgFile(file); return; }
    if (isSupportedRasterFile(file)) { loadRasterFile(file); return; }

    rejectImportFile();
};



fileInput.addEventListener('change', e => {

    const file = e.target.files[0]; if (!file) return;

    loadImportFile(file); e.target.value = '';

});



const setImportDropActive = (active) => inputStr.classList.toggle('ring-blue', !!active);

['dragenter', 'dragover'].forEach(type => inputStr.addEventListener(type, e => {

    if (!e.dataTransfer || !Array.from(e.dataTransfer.items || []).some(item => item.kind === 'file')) return;

    e.preventDefault();

    e.dataTransfer.dropEffect = 'copy';

    setImportDropActive(true);

}));

['dragleave', 'drop'].forEach(type => inputStr.addEventListener(type, e => {

    if (!e.dataTransfer) return;

    e.preventDefault();

    setImportDropActive(false);

}));

inputStr.addEventListener('drop', e => {

    const file = e.dataTransfer.files[0];

    if (file) loadImportFile(file);

});



window.focusAndSelectSVG = (btn) => {

    const field = activeImportField();

    field.focus();

    if (field.value.trim().length > 0) field.setSelectionRange(0, field.value.length);

    btn.classList.add('btn-blue'); field.classList.add('ring-blue');

    setTimeout(() => { btn.classList.remove('btn-blue'); field.classList.remove('ring-blue'); }, 1000);

};



window.clearSVG = (btn) => {

    inputStr.value = ''; window.processSVG();

    const field = activeImportField();

    btn.classList.add('btn-yellow'); field.classList.add('ring-yellow');

    setTimeout(() => { btn.classList.remove('btn-yellow'); field.classList.remove('ring-yellow'); }, 1000);

};



const ensureInkWrapper = (svgNode) => {

    let wrapper = svgNode.querySelector(':scope > g#ink-wrapper');

    if (!wrapper) {

        wrapper = document.createElementNS("http://www.w3.org/2000/svg", "g");

        wrapper.id = 'ink-wrapper';

        const children = Array.from(svgNode.childNodes);

        children.forEach(child => {

            if (child.nodeType === 1) {

                const tag = child.tagName.toLowerCase();

                if (!['defs', 'style', 'title', 'desc'].includes(tag)) wrapper.appendChild(child);

            } else if (child.nodeType === 3 && child.textContent.trim() !== '') {

                wrapper.appendChild(child);

            }

        });

        svgNode.appendChild(wrapper);

    }

    return wrapper;

};



// --- Import element/attribute policy --------------------------------------------------------
// The optimizer is permissive: it keeps every renderable element and attribute, stripping only a
// small denylist. SVG_DROP_TAGS are non-visual / unsafe (never rendered). SVG_REBUILD_TAGS are the
// elements the app normalizes + edits (rebuilt via createElementNS, with path-precision + class
// inlining); every other renderable element (text, <filter>/fe*, foreignObject, image, nested svg,
// …) is passed through verbatim so it no longer silently vanishes. SVG_PRES_ATTRS is the set of
// presentation properties inlined from <style>/class onto rebuilt nodes.
const SVG_DROP_TAGS = new Set(['script', 'style', 'metadata', 'title', 'desc']);

const SVG_REBUILD_TAGS = new Set(['svg', 'path', 'circle', 'rect', 'polygon', 'polyline', 'ellipse', 'line', 'defs', 'g', 'lineargradient', 'radialgradient', 'stop', 'clippath', 'mask', 'use', 'symbol', 'pattern', 'marker', 'a', 'switch']);

const SVG_PRES_ATTRS = new Set(['fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit', 'stroke-dasharray', 'stroke-dashoffset', 'stroke-opacity', 'opacity', 'color', 'stop-color', 'stop-opacity', 'clip-path', 'clip-rule', 'mask', 'filter', 'paint-order', 'vector-effect', 'display', 'visibility', 'overflow', 'marker', 'marker-start', 'marker-mid', 'marker-end', 'flood-color', 'flood-opacity', 'lighting-color', 'color-interpolation', 'color-interpolation-filters', 'shape-rendering', 'text-rendering', 'image-rendering', 'mix-blend-mode', 'isolation', 'font', 'font-family', 'font-size', 'font-size-adjust', 'font-stretch', 'font-style', 'font-variant', 'font-weight', 'letter-spacing', 'word-spacing', 'text-anchor', 'text-decoration', 'dominant-baseline', 'alignment-baseline', 'baseline-shift', 'direction', 'writing-mode', 'unicode-bidi', 'cursor', 'pointer-events']);



const parseSvgRootFromCode = (rawCode) => {
    const parsedDoc = new DOMParser().parseFromString(rawCode, "image/svg+xml");

    let oldSvg = parsedDoc.querySelector('svg');

    if (!oldSvg || parsedDoc.querySelector('parsererror')) {

        const htmlSvg = new DOMParser().parseFromString(rawCode, "text/html").querySelector('svg');

        if (htmlSvg) oldSvg = htmlSvg;

    }

    return oldSvg || null;

};



const optimizeSvgRoot = (oldSvg) => {



    // Scale-aware path-data precision: keep 2 decimals for normal artboards

    // (>= ~10 units) and add precision for small/normalized coordinate spaces.

    let dDim = 0;

    const dVbAttr = oldSvg.getAttribute("viewBox") || oldSvg.getAttribute("viewbox");

    if (dVbAttr) { const dp = dVbAttr.trim().split(/[\s,]+/); dDim = Math.max(parseFloat(dp[2]) || 0, parseFloat(dp[3]) || 0); }

    if (!dDim) dDim = Math.max(parseFloat(oldSvg.getAttribute("width")) || 0, parseFloat(oldSvg.getAttribute("height")) || 0);

    // Working precision is kept generous (>= the max export-decimals setting) so the live data never
    // loses geometry the user may later choose to export; final quantization happens at export time
    // (renderOutput -> svgExportPrecision). Trailing zeros are stripped, so a low-precision source
    // stays compact -- a 2-decimal coord rounded at 6 decimals is still emitted as 2 decimals.
    const dPrecision = dDim > 0 ? Math.max(6, Math.ceil(3 - Math.log10(dDim))) : 6;



    const classStyles = {};

    oldSvg.querySelectorAll('style').forEach(tag => {

        let match; const regex = /([^\{]+)\{([^}]+)\}/g;

        while ((match = regex.exec(tag.textContent)) !== null) {

            const selectors = match[1].split(',');

            const rules = match[2].trim();

            selectors.forEach(sel => {

                const cleanSel = sel.trim().replace('.', '');

                if (cleanSel) classStyles[cleanSel] = rules;

            });

        }

    });



    const normalizePresentationValue = val => {

        const clean = String(val || '').trim();

        return /^currentcolou?r$/i.test(clean) || /^currentcollor$/i.test(clean) ? '#000000' : clean;

    };



    // Fold matched class rules into an inline style attribute and strip script / editor cruft on a
    // cloned (pass-through) subtree, so preserved-but-not-rebuilt elements (text, <filter>,
    // foreignObject, …) keep their class-driven paint even though the <style> element is dropped.
    const sanitizeClonedEl = (n) => {

        if (n.nodeType !== 1) return;

        if (n.hasAttribute('class')) {

            let injected = '';

            n.getAttribute('class').split(/\s+/).forEach(cls => { if (classStyles[cls]) injected += classStyles[cls] + ';'; });

            if (injected) { const existing = n.getAttribute('style'); n.setAttribute('style', injected + (existing || '')); }

            n.removeAttribute('class');

        }

        Array.from(n.attributes).forEach(a => {

            const nm = a.name.toLowerCase();

            if (/^on/.test(nm) || /^(inkscape|sodipodi):/.test(nm) || /^xmlns:(inkscape|sodipodi|dc|cc|rdf)\b/.test(nm)) n.removeAttribute(a.name);

        });

        Array.from(n.childNodes).forEach(sanitizeClonedEl);

    };

    // Bring a renderable element the app does not itself normalize across verbatim (namespaces
    // intact, via importNode) instead of dropping it.
    const passThroughNode = (node) => {

        const clone = document.importNode(node, true);

        sanitizeClonedEl(clone);

        return clone;

    };

    const optimizeNode = node => {

        if (node.nodeType !== 1) return null;

        const originalTagName = node.tagName;

        const tagName = originalTagName.toLowerCase();

        

        // Drop only non-visual / unsafe elements (and editor-namespace nodes) outright.
        if (SVG_DROP_TAGS.has(tagName) || /^(inkscape|sodipodi):/.test(tagName)) return null;

        // Preserve everything renderable the app doesn't itself normalize (text, <filter>,
        // foreignObject, image, nested svg, …) verbatim so it keeps rendering / exporting.
        if (!SVG_REBUILD_TAGS.has(tagName)) return passThroughNode(node);



        const newNode = document.createElementNS("http://www.w3.org/2000/svg", originalTagName);

        if (tagName === 'svg') newNode.setAttribute("xmlns", "http://www.w3.org/2000/svg");



        // Element + attribute policy is module-level now (SVG_REBUILD_TAGS / SVG_PRES_ATTRS):
        // keep every renderable attribute except a small non-visual / unsafe denylist.



        let styles = node.hasAttribute('style') ? node.getAttribute('style') + ";" : "";

        if (node.hasAttribute('class')) node.getAttribute('class').split(/\s+/).forEach(cls => { if (classStyles[cls]) styles += classStyles[cls] + ";"; });



        styles.split(';').forEach(decl => {

            if (!decl.includes(':')) return;

            const [k, v] = decl.split(':').map(s => s.trim());

            if (SVG_PRES_ATTRS.has(k.toLowerCase()) && !newNode.hasAttribute(k.toLowerCase())) newNode.setAttribute(k.toLowerCase(), normalizePresentationValue(v));

        });



        Array.from(node.attributes).forEach(attr => {

            const name = attr.name.toLowerCase(); let val = attr.value.trim();

            if (name === 'class' || name === 'style') return;

            // Strip event handlers + editor-namespace cruft; keep every other attribute verbatim.
            if (/^on/.test(name) || /^(inkscape|sodipodi):/.test(name) || /^xmlns:(inkscape|sodipodi|dc|cc|rdf)\b/.test(name)) return;

            if (name === 'd') {

                newNode.setAttribute(attr.name, roundPathData(val, dPrecision));

                return;

            }

            // svg width/height are re-derived from the viewBox below — don't copy the originals.
            if (tagName === 'svg' && (name === 'width' || name === 'height')) return;

            // A class/inline-style value set above outranks a presentation attribute (CSS cascade).
            if (SVG_PRES_ATTRS.has(name) && newNode.hasAttribute(name)) return;

            newNode.setAttribute(attr.name, normalizePresentationValue(val));

        });



        if (!newNode.hasAttribute('id') && node.hasAttribute('xml:id')) {

            const xmlId = sanitizeSvgId(node.getAttribute('xml:id'));

            if (xmlId) newNode.setAttribute('id', xmlId);

        }



        if (['path', 'circle', 'rect', 'polygon', 'polyline', 'ellipse', 'line'].includes(tagName) && !newNode.hasAttribute('fill') && !newNode.hasAttribute('stroke')) {

            newNode.setAttribute('fill', '#000000');

            newNode.setAttribute('data-pf-default-fill', 'true');

        }

        Array.from(node.childNodes).forEach(child => { const opt = optimizeNode(child); if (opt) newNode.appendChild(opt); });

        return newNode;

    };



    const optimizedSvg = optimizeNode(oldSvg);

    

    let vb = optimizedSvg.getAttribute("viewBox");

    if (!vb && oldSvg.getAttribute("width")) {

        vb = `0 0 ${parseFloat(oldSvg.getAttribute("width"))} ${parseFloat(oldSvg.getAttribute("height"))}`;

        optimizedSvg.setAttribute("viewBox", vb);

    }

    if (vb) {

        const p = vb.trim().split(/[\s,]+/);

        optimizedSvg.setAttribute("width", Number(parseFloat(p.length === 4 ? p[2] : p[0]).toFixed(2)));

        optimizedSvg.setAttribute("height", Number(parseFloat(p.length === 4 ? p[3] : p[1]).toFixed(2)));

    }

    

    ensureInkWrapper(optimizedSvg);

    return optimizedSvg;

};



window.processSVG = () => {

    const rawCode = inputStr.value.trim();

    // Keep the condensed-mode mini field in step with programmatic textarea changes (file load,
    // clear, raster wrap). Guarded so it never resets the caret while the user types into it.

    if (importMiniInput && importMiniInput.value !== inputStr.value) importMiniInput.value = inputStr.value;

    if (!rawCode) return resetUI();

    const oldSvg = parseSvgRootFromCode(rawCode);

    if (!oldSvg) { resetUI(); return; }

    globalOptimizedSvg = optimizeSvgRoot(oldSvg);



    // Fresh document: data-pf-index restarts at 0, so the UI-only hide/lock sets (keyed by index)
    // must reset too, or a new layer 0 would inherit an old layer 0's hidden/locked state.
    hiddenLayers.clear(); lockedLayers.clear();

    getEditableLayerShapes(globalOptimizedSvg).forEach((s, idx) => {

        s.setAttribute('data-pf-index', idx);

    });

    

    globalOriginalSvg = globalOptimizedSvg.cloneNode(true);
    cpShouldResetPosition = true;

    window.clearSelectionToolLock?.();
    window.clearDirectSelectionToolLock?.();
    window.clearArtboardToolState?.();
    window.clearPenToolState?.();
    window.clearRulersGuidesState?.();

    // New document: wipe undo/redo; the renderOutput() below pushes it as the history baseline.
    window.resetHistory?.();

    buildLayersPanel();

    renderOutput();

    const statusBar = $('canvasStatusBar'); if (statusBar) statusBar.hidden = false;

    fitToCanvas(false);

    syncPngDimensions();

    window.syncShapeToolButtons?.();

};



const SVG_NS = "http://www.w3.org/2000/svg";

const formatImportNumber = (value) => roundCoordValue(value, 6);

const getImportSvgBounds = (svgNode) => {
    if (!svgNode) return null;

    const vb = svgNode.getAttribute('viewBox') || svgNode.getAttribute('viewbox');

    if (vb) {

        const p = vb.trim().split(/[\s,]+/).map(parseFloat);

        if (p.length === 4 && p.every(n => !isNaN(n)) && p[2] > 0 && p[3] > 0) return { x: p[0], y: p[1], width: p[2], height: p[3] };

    }

    const width = parseFloat(svgNode.getAttribute('width'));

    const height = parseFloat(svgNode.getAttribute('height'));

    return (width > 0 && height > 0) ? { x: 0, y: 0, width, height } : null;

};

const measureImportGroupBounds = (group, sourceSvg) => {
    if (!group || !group.childNodes.length || !document.body) return null;

    const probe = document.createElementNS(SVG_NS, 'svg');

    const sourceBounds = getImportSvgBounds(sourceSvg);

    if (sourceBounds) probe.setAttribute('viewBox', `${sourceBounds.x} ${sourceBounds.y} ${sourceBounds.width} ${sourceBounds.height}`);

    probe.setAttribute('xmlns', SVG_NS);

    Object.assign(probe.style, {
        position: 'absolute',
        left: '-10000px',
        top: '-10000px',
        width: '0',
        height: '0',
        overflow: 'hidden',
        visibility: 'hidden'
    });

    const defs = sourceSvg.querySelector(':scope > defs');

    if (defs) probe.appendChild(defs.cloneNode(true));

    const clone = group.cloneNode(true);

    probe.appendChild(clone);

    document.body.appendChild(probe);

    try {

        const bb = clone.getBBox();

        if (bb && (bb.width > 0 || bb.height > 0)) return { x: bb.x, y: bb.y, width: bb.width, height: bb.height };

    } catch (err) {

        return null;

    } finally {

        probe.remove();

    }

    return null;

};

const centerImportGroupOnArtboard = (group, sourceSvg) => {
    const artboard = getImportSvgBounds(globalOptimizedSvg);

    const bounds = measureImportGroupBounds(group, sourceSvg) || getImportSvgBounds(sourceSvg);

    if (!artboard || !bounds) return;

    const dx = (artboard.x + artboard.width / 2) - (bounds.x + bounds.width / 2);

    const dy = (artboard.y + artboard.height / 2) - (bounds.y + bounds.height / 2);

    if (!isFinite(dx) || !isFinite(dy) || (Math.abs(dx) < 1e-6 && Math.abs(dy) < 1e-6)) return;

    group.setAttribute('transform', `translate(${formatImportNumber(dx)} ${formatImportNumber(dy)})`);

};

const getTakenSvgIds = () => {
    const ids = new Set(['ink-wrapper']);

    if (globalOptimizedSvg) globalOptimizedSvg.querySelectorAll('[id]').forEach(el => ids.add(el.getAttribute('id')));

    return ids;

};

const makeUniqueImportedId = (oldId, takenIds) => {
    const base = sanitizeSvgId(oldId) || 'imported-id';

    let candidate = base, n = 2;

    while (takenIds.has(candidate)) candidate = `${base}-${n++}`;

    takenIds.add(candidate);

    return candidate;

};

const rewriteImportedIdRefs = (root, idMap) => {
    if (!idMap.size) return;

    const urlRe = /url\(\s*(['"]?)#([^)'"\s]+)\1\s*\)/g;

    root.querySelectorAll('*').forEach(el => {

        Array.from(el.attributes).forEach(attr => {

            let value = attr.value;

            if ((attr.name === 'href' || attr.name === 'xlink:href') && value.charAt(0) === '#') {

                const next = idMap.get(value.slice(1));

                if (next) value = `#${next}`;

            }

            value = value.replace(urlRe, (match, quote, id) => idMap.has(id) ? `url(${quote}#${idMap.get(id)}${quote})` : match);

            if (value !== attr.value) el.setAttribute(attr.name, value);

        });

    });

};

const uniquifyImportedSvgIds = (importedSvg) => {
    const takenIds = getTakenSvgIds();

    const idMap = new Map();

    importedSvg.querySelectorAll('[id]').forEach(el => {

        const oldId = el.getAttribute('id');

        if (!oldId || oldId === 'ink-wrapper') return;

        const nextId = makeUniqueImportedId(oldId, takenIds);

        if (nextId !== oldId) {

            idMap.set(oldId, nextId);

            el.setAttribute('id', nextId);

        }

    });

    rewriteImportedIdRefs(importedSvg, idMap);

};

const mergeImportedDefs = (importedSvg) => {
    const sourceDefs = importedSvg.querySelector(':scope > defs');

    if (!sourceDefs || !sourceDefs.childNodes.length) return;

    let targetDefs = globalOptimizedSvg.querySelector(':scope > defs');

    if (!targetDefs) {

        targetDefs = document.createElementNS(SVG_NS, 'defs');

        globalOptimizedSvg.insertBefore(targetDefs, globalOptimizedSvg.firstChild);

    }

    Array.from(sourceDefs.childNodes).forEach(node => targetDefs.appendChild(node));

};

const getImportFileSvgText = async (file) => {
    if (isSupportedSvgFile(file)) return readSvgFileText(file);

    if (isSupportedRasterFile(file)) return buildRasterSvgWrapper(file);

    throw new Error('Unsupported layer import file.');

};

const appendImportedSvgAsLayers = (importedSvg) => {
    const targetWrapper = ensureInkWrapper(globalOptimizedSvg);

    const sourceWrapper = ensureInkWrapper(importedSvg);

    uniquifyImportedSvgIds(importedSvg);

    const importGroup = document.createElementNS(SVG_NS, 'g');

    Array.from(sourceWrapper.childNodes).forEach(node => {

        if (node.nodeType === 1 || (node.nodeType === 3 && node.textContent.trim() !== '')) importGroup.appendChild(node);

    });

    const importedShapes = Array.from(importGroup.querySelectorAll(SVG_LAYER_SHAPE_SELECTOR)).filter(shape => isEditableLayerShape(shape, importGroup));

    if (!importedShapes.length) return [];

    centerImportGroupOnArtboard(importGroup, importedSvg);

    mergeImportedDefs(importedSvg);

    targetWrapper.appendChild(importGroup);

    const indices = [];

    importedShapes.forEach(shape => {

        const nextIndex = window.getNextLayerPfIndex ? window.getNextLayerPfIndex() : String(globalOptimizedSvg.querySelectorAll('[data-pf-index]').length);

        shape.setAttribute('data-pf-index', nextIndex);

        indices.push(nextIndex);

    });

    return indices;

};

const commitImportedLayerIndices = (addedIndices) => {
    if (!addedIndices.length) return;

    buildLayersPanel();

    window.setLayerSelectionSet?.(addedIndices);

    renderOutput(false);

    window.adoptCanvasSelection?.(addedIndices);

    window.updateAllScrollbars();

};

const importSvgTextAsLayer = (rawCode) => {
    const oldSvg = parseSvgRootFromCode(String(rawCode || '').trim());

    if (!oldSvg) return [];

    const importedSvg = optimizeSvgRoot(oldSvg);

    return appendImportedSvgAsLayers(importedSvg);

};

const getClipboardImageFileName = (mime) => {
    const type = String(mime || '').toLowerCase();

    if (type === 'image/jpeg' || type === 'image/jpg') return 'Clipboard Image.jpg';

    if (type === 'image/webp') return 'Clipboard Image.webp';

    if (type === 'image/bmp' || type === 'image/x-ms-bmp') return 'Clipboard Image.bmp';

    return 'Clipboard Image.png';

};

const clipboardBlobToFile = (blob) => {
    const mime = blob.type || 'image/png';

    const name = getClipboardImageFileName(mime);

    if (typeof File === 'function') return new File([blob], name, { type: mime });

    try { blob.name = name; } catch (_) {}

    return blob;

};

const getClipboardLayerPayload = async () => {
    let readError = null;

    if (navigator.clipboard && navigator.clipboard.read) {

        try {

            const items = await navigator.clipboard.read();

            for (const item of items) {

                for (const type of item.types || []) {

                    if (type === 'image/svg+xml') {

                        const text = await (await item.getType(type)).text();

                        if (parseSvgRootFromCode(text)) return { kind: 'svg', text };

                    }

                }

            }

            for (const item of items) {

                for (const type of item.types || []) {

                    if (type === 'text/plain' || type === 'text/html') {

                        const text = await (await item.getType(type)).text();

                        if (parseSvgRootFromCode(text)) return { kind: 'svg', text };

                    }

                }

            }

            for (const item of items) {

                for (const type of item.types || []) {

                    if (!/^image\//i.test(type) || type === 'image/svg+xml') continue;

                    if (!getRasterImportMime({ type, name: getClipboardImageFileName(type) })) continue;

                    const blob = await item.getType(type);

                    return { kind: 'raster', file: clipboardBlobToFile(blob) };

                }

            }

        } catch (err) {

            readError = err;

        }

    }

    if (navigator.clipboard && navigator.clipboard.readText) {

        try {

            const text = await navigator.clipboard.readText();

            if (parseSvgRootFromCode(text)) return { kind: 'svg', text };

        } catch (err) {

            readError = readError || err;

        }

    }

    if (readError) throw readError;

    return null;

};

const importLayerFiles = async (files) => {
    if (!globalOptimizedSvg || !files.length) return;

    const addedIndices = [];

    let failed = false;

    if (btnImportLayer) btnImportLayer.disabled = true;

    try {

        for (const file of files.slice().reverse()) {

            try {

                const rawCode = await getImportFileSvgText(file);

                const oldSvg = parseSvgRootFromCode(rawCode);

                if (!oldSvg) throw new Error('No SVG root found.');

                const importedSvg = optimizeSvgRoot(oldSvg);

                const indices = appendImportedSvgAsLayers(importedSvg);

                if (!indices.length) throw new Error('No editable layers found.');

                addedIndices.push(...indices);

            } catch (err) {

                failed = true;

            }

        }

        if (addedIndices.length) {

            commitImportedLayerIndices(addedIndices);

        }

    } finally {

        if (btnImportLayer) btnImportLayer.disabled = !globalOptimizedSvg;

    }

    if (failed || !addedIndices.length) rejectLayerImportFile();

};

window.pasteLayerFromClipboard = async () => {
    if (!globalOptimizedSvg || !btnPasteLayer) return;

    let addedIndices = [];

    btnPasteLayer.disabled = true;

    try {

        const payload = await getClipboardLayerPayload();

        if (!payload) throw new Error('No supported clipboard layer content.');

        if (payload.kind === 'svg') {

            addedIndices = importSvgTextAsLayer(payload.text);

        } else if (payload.kind === 'raster') {

            const rawCode = await buildRasterSvgWrapper(payload.file);

            addedIndices = importSvgTextAsLayer(rawCode);

        }

        if (!addedIndices.length) throw new Error('No editable layers found.');

        commitImportedLayerIndices(addedIndices);

    } catch (err) {

        rejectLayerImportFile(btnPasteLayer);

    } finally {

        btnPasteLayer.disabled = !globalOptimizedSvg;

    }

};

window.openLayerImportPicker = () => {
    if (!globalOptimizedSvg || !layerFileInput) return;

    layerFileInput.click();

};

if (layerFileInput) layerFileInput.addEventListener('change', e => {
    const files = Array.from(e.target.files || []);

    if (files.length) importLayerFiles(files);

    e.target.value = '';

});
