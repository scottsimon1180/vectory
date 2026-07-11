/* fileName: export.js */

window.copyOutput = btn => {

    if (!outputStr.value || btn.classList.contains('btn-success')) return;

    const span = btn.querySelector('span'), trigger = () => {

        btn.style.width = btn.offsetWidth + 'px';

        btn.classList.add('btn-success');

        outputStr.classList.add('ring-green');



        if (span) span.textContent = 'Copied!';

        setTimeout(() => {

            btn.classList.remove('btn-success');

            outputStr.classList.remove('ring-green');

            if (span) span.textContent = document.querySelector('.io-grid.io-condensed') ? 'Copy Code' : 'Copy to Clipboard';

            btn.style.width = '';

        }, 2000);

    };

    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(outputStr.value).then(trigger).catch(fallback); else fallback();

    function fallback() {

        outputStr.focus(); outputStr.select(); outputStr.setSelectionRange(0, 999999);

        try { if (document.execCommand('copy')) trigger(); } catch (e) { console.error(e); }

        window.getSelection().removeAllRanges(); outputStr.blur();

    }

};



// ==========================================

// Export Formats & Logic

// ==========================================



let pngAspectRatio = 1;

const formatViewBoxNumber = val => Number((Number.isFinite(val) ? val : 0).toFixed(4));

const getSvgArtboardBox = (svgNode) => {

    let abX = 0, abY = 0, abW = 0, abH = 0;

    const vb = svgNode.getAttribute('viewBox') || svgNode.getAttribute('viewbox');

    if (vb) {

        const p = vb.trim().split(/[\s,]+/);

        if (p.length === 4) {

            abX = parseFloat(p[0]) || 0;

            abY = parseFloat(p[1]) || 0;

            abW = parseFloat(p[2]) || 0;

            abH = parseFloat(p[3]) || 0;

        } else {

            abW = parseFloat(p[0]) || 0;

            abH = parseFloat(p[1]) || 0;

        }

    }

    if (!abW || !abH) {

        abW = parseFloat(svgNode.getAttribute('width')) || 128;

        abH = parseFloat(svgNode.getAttribute('height')) || 128;

    }

    return { x: abX, y: abY, width: abW || 128, height: abH || 128 };

};

const getLiveInkBounds = () => {

    try {

        const liveSvg = previewArea.querySelector(PREVIEW_SVG_SELECTOR);

        const inkNode = liveSvg && (liveSvg.querySelector('g#ink-wrapper') || liveSvg);

        if (!inkNode) return null;

        const bbox = inkNode.getBBox();

        return { x: bbox.x || 0, y: bbox.y || 0, width: bbox.width || 0, height: bbox.height || 0 };

    } catch (err) {

        return null;

    }

};



window.setPngBg = (bgData) => {

    currentPngBg = bgData;

    const isCustom = (bgData !== 'transparent' && bgData !== '#000000' && bgData !== '#ffffff');

    

    document.querySelectorAll('.bg-preset-btn').forEach(btn => {

        btn.classList.toggle('active', btn.dataset.bg === bgData || (btn.id === 'btnCustomPngBg' && isCustom));

    });

    

    const center = $('customPngBgCenter');

    if (isCustom) {

        if (typeof bgData === 'string') {

            center.style.background = bgData;

        } else {

            if (bgData.type === 'linear') {

                let stops = bgData.stops.map((c, i) => `${c} ${(i / (bgData.stops.length - 1)) * 100}%`).join(', ');

                center.style.background = `linear-gradient(${bgData.angle}deg, ${stops})`;

            } else {

                let stops = bgData.stops.map((c, i) => `${c} ${(i / (bgData.stops.length - 1)) * 100}%`).join(', ');

                center.style.background = `radial-gradient(circle at center, ${stops})`;

            }

        }

        center.classList.add('has-color');

    } else {

        center.classList.remove('has-color');

    }

    

    updatePngPreview();

};



window.openPngBgPicker = () => {

    let startData = (currentPngBg !== 'transparent') ? currentPngBg : '#007aff';

    let isGrad = typeof startData === 'object' && startData !== null;

    window.openCustomPicker(startData, true, (newCol, scrub, isGradFlag) => {

        setPngBg(newCol);

    });

};



window.syncPngDimensions = () => {

    if (!globalOptimizedSvg) return;

    

    const holdRes = $('pngHoldRes').checked;

    const isClipped = $('pngClipBounds').checked;

    

    const artboard = getSvgArtboardBox(globalOptimizedSvg);

    const inkBounds = isClipped ? getLiveInkBounds() : null;

    let targetW = inkBounds ? inkBounds.width : artboard.width;

    let targetH = inkBounds ? inkBounds.height : artboard.height;

    

    targetW = targetW || 512; targetH = targetH || 512;

    pngAspectRatio = targetW / targetH;

    

    // Do not auto-update fields if "Hold Resolution" is enabled

    if (holdRes) {

        let savedW = localStorage.getItem('pf_pngHoldW');

        let savedH = localStorage.getItem('pf_pngHoldH');

        if (savedW && savedH) {

            $('pngW').value = savedW;

            $('pngH').value = savedH;

        }

        updatePngPreview();

        return; 

    }

    

    $('pngW').value = Math.round(targetW);

    $('pngH').value = Math.round(targetH);

    updatePngPreview();

};



window.toggleSvgUseCurrentColor = isChecked => {

    useCurrentColorExport = !!isChecked;

    if (globalOptimizedSvg) renderOutput(false);

};



window.toggleSvgMinify = isChecked => {

    minifySvgExport = !!isChecked;

    if (globalOptimizedSvg) renderOutput(false);

};



window.toggleSvgResponsive = isChecked => {

    responsiveSvgExport = !!isChecked;

    if (globalOptimizedSvg) renderOutput(false);

};



window.setSvgExportPrecision = v => {

    let n = parseInt(v, 10);

    if (!Number.isFinite(n)) n = 3;

    n = Math.max(0, Math.min(6, n));

    svgExportPrecision = n;

    const inp = document.getElementById('svgDecimals');

    if (inp && +inp.value !== n) inp.value = n;   // reflect a clamped value back into the field

    if (globalOptimizedSvg) renderOutput(false);

};



window.toggleExportFormat = () => {

    const format = document.querySelector('input[name="exportFormat"]:checked').value;

    const btnCopy = $('btnCopyExport');

    const btnSave = $('btnSaveExport');

    const saveSpan = btnSave.querySelector('span');

    const outStrWrap = $('exportWrap');

    const pngWrap = $('pngExportWrap');

    const svgUseCurrentColorWrap = $('svgUseCurrentColorWrap');

    const svgMinifyWrap = $('svgMinifyWrap');

    const svgResponsiveWrap = $('svgResponsiveWrap');

    const svgDecimalsWrap = $('svgDecimalsWrap');



    if (format === 'png') {

        btnCopy.style.display = 'none';

        outStrWrap.style.display = 'none';

        pngWrap.style.display = 'flex';

        if (svgUseCurrentColorWrap) svgUseCurrentColorWrap.style.display = 'none';

        if (svgMinifyWrap) svgMinifyWrap.style.display = 'none';

        if (svgResponsiveWrap) svgResponsiveWrap.style.display = 'none';

        if (svgDecimalsWrap) svgDecimalsWrap.style.display = 'none';

        saveSpan.textContent = 'Save PNG';

        syncPngDimensions();

        updatePngPreview();

    } else {

        btnCopy.style.display = 'flex';

        outStrWrap.style.display = 'flex';

        pngWrap.style.display = 'none';

        if (svgUseCurrentColorWrap) svgUseCurrentColorWrap.style.display = 'flex';

        if (svgMinifyWrap) svgMinifyWrap.style.display = 'flex';

        if (svgResponsiveWrap) svgResponsiveWrap.style.display = 'flex';

        if (svgDecimalsWrap) svgDecimalsWrap.style.display = 'flex';

        saveSpan.textContent = 'Save .svg';

        if (globalOptimizedSvg) renderOutput(false);

    }

};



window.handlePngDimChange = (axis) => {

    const wInp = $('pngW');

    const hInp = $('pngH');

    let w = parseFloat(wInp.value);

    let h = parseFloat(hInp.value);

    

    if (axis === 'w' && !isNaN(w) && w > 0) {

        hInp.value = Math.round(w / pngAspectRatio);

    } else if (axis === 'h' && !isNaN(h) && h > 0) {

        wInp.value = Math.round(h * pngAspectRatio);

    }

    

    if ($('pngHoldRes').checked) {

        localStorage.setItem('pf_pngHoldW', $('pngW').value);

        localStorage.setItem('pf_pngHoldH', $('pngH').value);

    }

    

    updatePngPreview();

};



window.handlePngHoldToggle = (isChecked) => {

    localStorage.setItem('pf_pngHoldRes', isChecked ? 'true' : 'false');

    if (isChecked) {

        localStorage.setItem('pf_pngHoldW', $('pngW').value);

        localStorage.setItem('pf_pngHoldH', $('pngH').value);

    } else {

        syncPngDimensions();

    }

};



window.handlePngClipToggle = (isClipped) => {

    syncPngDimensions();

};



window.executeExport = () => {

    const format = document.querySelector('input[name="exportFormat"]:checked').value;

    if (format === 'svg') window.downloadSVG();

    else window.downloadPNG();

};



// Save a Blob to disk. Uses the File System Access API (native "Save As" Explorer
// dialog with location + filename) when available, falling back to a normal download.
async function saveBlobToFile(blob, suggestedName, description, mime, ext) {

    if (window.isSecureContext && window.showSaveFilePicker) {

        try {

            const handle = await window.showSaveFilePicker({

                suggestedName,

                types: [{ description, accept: { [mime]: [ext] } }]

            });

            const writable = await handle.createWritable();

            await writable.write(blob);

            await writable.close();

            return;

        } catch (e) {

            if (e.name === 'AbortError') return; // user cancelled

            // fall through to anchor download on any other failure

        }

    }

    const a = document.createElement('a');

    const url = URL.createObjectURL(blob);

    a.href = url;

    a.download = suggestedName; document.body.appendChild(a); a.click(); a.remove();

    URL.revokeObjectURL(url);

}



window.downloadSVG = async () => {

    if (!outputStr.value) return;

    const blob = new Blob([outputStr.value], { type: 'image/svg+xml;charset=utf-8' });

    await saveBlobToFile(blob, 'icon_optimized.svg', 'SVG image', 'image/svg+xml', '.svg');

};



function buildExportSvgElement(w, h, clip) {

    if (!globalOptimizedSvg) return null;

    const clone = globalOptimizedSvg.cloneNode(true);

    // Hidden layers (eye off, tracked in hiddenLayers by data-pf-index) are never exported --
    // removed before the stroke-alignment expansion below so no ghost copies are generated for
    // them either. Locked layers export normally (locked != hidden).

    if (hiddenLayers.size) clone.querySelectorAll('[data-pf-index]').forEach(el => { if (hiddenLayers.has(el.getAttribute('data-pf-index'))) el.remove(); });



    // PNG/raster export always uses the editable color SVG, regardless of the SVG export currentColor checkbox.



    // Expand Align Stroke inner/outer (data-stroke-align) exactly like renderOutput does, so the

    // raster matches the canvas; mask-region bboxes are borrowed from the live preview twin (same

    // geometry -- this clone is never in the DOM, so it can't getBBox itself).

    const saPreviewSvg = previewArea.querySelector(PREVIEW_SVG_SELECTOR);

    expandStrokeAlignment(clone, (s) => {

        const idx = s.getAttribute('data-pf-index');

        const twin = (idx != null && saPreviewSvg) ? saPreviewSvg.querySelector(`[data-pf-index="${idx}"]`) : null;

        try { return twin ? twin.getBBox() : null; } catch (_) { return null; }

    });



    clone.querySelectorAll(SVG_VECTOR_LAYER_SHAPE_SELECTOR).forEach(s => {

        s.removeAttribute('data-pf-index');
        s.removeAttribute('data-pf-label');

        const f = s.getAttribute('fill'), st = s.getAttribute('stroke');

        if ((!f || f === 'none') && (!st || st === 'none')) return s.remove();


    });

    clone.querySelectorAll('image').forEach(img => {

        img.removeAttribute('data-pf-index');
        img.removeAttribute('data-pf-label');

    });



    const usedIdsExport = new Set();

    clone.querySelectorAll('*').forEach(el => {

        const f = el.getAttribute('fill'), s = el.getAttribute('stroke');

        if (f && f.includes('url(#')) { const m = f.match(/url\(['"]?#([^)'"]+)['"]?\)/); if (m) usedIdsExport.add(m[1]); }

        if (s && s.includes('url(#')) { const m = s.match(/url\(['"]?#([^)'"]+)['"]?\)/); if (m) usedIdsExport.add(m[1]); }

    });

    const cloneDefs = clone.querySelector('defs');

    if (cloneDefs) {

        Array.from(cloneDefs.children).forEach(c => {

            if (c.id && c.id.startsWith('pf-grad-') && !usedIdsExport.has(c.id)) c.remove();

        });

    }



    const emps = clone.querySelectorAll('g, defs');

    for (let i = emps.length - 1; i >= 0; i--) if (!emps[i].children.length) emps[i].remove();

    

    const artboard = getSvgArtboardBox(globalOptimizedSvg);

    let inkBounds = getLiveInkBounds();

    if (!inkBounds || inkBounds.width <= 0 || inkBounds.height <= 0) inkBounds = artboard;



    if (clip) {

        clone.setAttribute('viewBox', `${formatViewBoxNumber(inkBounds.x)} ${formatViewBoxNumber(inkBounds.y)} ${formatViewBoxNumber(inkBounds.width)} ${formatViewBoxNumber(inkBounds.height)}`);

    } else {

        clone.setAttribute('viewBox', `${formatViewBoxNumber(artboard.x)} ${formatViewBoxNumber(artboard.y)} ${formatViewBoxNumber(artboard.width)} ${formatViewBoxNumber(artboard.height)}`);

    }

    

    clone.setAttribute('width', w);

    clone.setAttribute('height', h);

    

    // Inject Native PNG Background rendering layer

    if (currentPngBg !== 'transparent') {

        let defs = clone.querySelector('defs');

        if (!defs) {

            defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");

            clone.insertBefore(defs, clone.firstChild);

        }

        

        let bgRect = document.createElementNS("http://www.w3.org/2000/svg", "rect");

        

        let vbStr = clone.getAttribute('viewBox');

        if (vbStr) {

            let p = vbStr.trim().split(/[\s,]+/);

            bgRect.setAttribute('x', p[0] || '0');

            bgRect.setAttribute('y', p[1] || '0');

            bgRect.setAttribute('width', p[2] || '100%');

            bgRect.setAttribute('height', p[3] || '100%');

        } else {

            bgRect.setAttribute('x', '0');

            bgRect.setAttribute('y', '0');

            bgRect.setAttribute('width', '100%');

            bgRect.setAttribute('height', '100%');

        }



        if (typeof currentPngBg === 'string') {

            bgRect.setAttribute('fill', currentPngBg);

        } else {

            let gradId = 'pf-png-bg-grad';

            let gradEl = document.createElementNS("http://www.w3.org/2000/svg", currentPngBg.type === 'linear' ? "linearGradient" : "radialGradient");

            gradEl.setAttribute('id', gradId);

            

            if (currentPngBg.type === 'linear') {

                gradEl.setAttribute('x1', '0.5'); gradEl.setAttribute('y1', '1');

                gradEl.setAttribute('x2', '0.5'); gradEl.setAttribute('y2', '0');

                if (currentPngBg.angle !== 0) gradEl.setAttribute('gradientTransform', `rotate(${currentPngBg.angle}, 0.5, 0.5)`);

            } else {

                gradEl.setAttribute('cx', '0.5'); gradEl.setAttribute('cy', '0.5'); gradEl.setAttribute('r', '0.5');

            }

            

            let stopsHtml = '';

            const n = currentPngBg.stops.length;

            currentPngBg.stops.forEach((stopCol, i) => {

                let offset = n === 1 ? 0 : (i / (n - 1)) * 100;

                stopsHtml += `<stop offset="${offset}%" stop-color="${stopCol}" />`;

            });

            gradEl.innerHTML = stopsHtml;

            defs.appendChild(gradEl);

            bgRect.setAttribute('fill', `url(#${gradId})`);

        }

        

        clone.insertBefore(bgRect, defs.nextSibling);

    }

    

    return clone;

}



window.updatePngPreview = () => {

    if (!globalOptimizedSvg || document.querySelector('input[name="exportFormat"]:checked').value !== 'png') return;

    

    const clip = $('pngClipBounds').checked;

    

    // Fixed massive size to ensure preview scales purely via CSS max-width/max-height

    let previewW = 1000;

    let previewH = 1000 / pngAspectRatio;

    if (pngAspectRatio < 1) {

        previewH = 1000;

        previewW = 1000 * pngAspectRatio;

    }

    

    const clone = buildExportSvgElement(previewW, previewH, clip);

    if (!clone) return;

    

    const svgString = new XMLSerializer().serializeToString(clone);

    const blob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' });

    const URL = window.URL || window.webkitURL || window;

    const blobURL = URL.createObjectURL(blob);

    

    const img = $('pngPreviewImg');

    img.onload = () => URL.revokeObjectURL(blobURL);

    img.onerror = () => URL.revokeObjectURL(blobURL);

    img.src = blobURL;

    

    if (currentPngBg === 'transparent') {

        img.classList.add('checkerboard-bg');

    } else {

        img.classList.remove('checkerboard-bg');

    }

};



window.downloadPNG = () => {

    const w = parseFloat($('pngW').value) || 1024;

    const h = parseFloat($('pngH').value) || 1024;

    const clip = $('pngClipBounds').checked;

    

    const clone = buildExportSvgElement(w, h, clip);

    if (!clone) return;

    

    const svgString = new XMLSerializer().serializeToString(clone);

    const blob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' });

    const URL = window.URL || window.webkitURL || window;

    const blobURL = URL.createObjectURL(blob);

    

    const img = new Image();

    img.onerror = () => { URL.revokeObjectURL(blobURL); console.error('PNG export failed: could not rasterize SVG.'); };

    img.onload = () => {

        const canvas = document.createElement('canvas');

        canvas.width = w;

        canvas.height = h;

        const ctx = canvas.getContext('2d');

        

        ctx.drawImage(img, 0, 0, w, h);

        URL.revokeObjectURL(blobURL);



        canvas.toBlob(pngBlob => {

            if (!pngBlob) return;

            saveBlobToFile(pngBlob, 'icon_optimized.png', 'PNG image', 'image/png', '.png');

        }, 'image/png', 1.0);

    };

    img.src = blobURL;

};



// ==========================================

