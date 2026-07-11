/* fileName: colorPicker-render.js */

// --- Highly Optimized rAF Render Pipeline ---
function renderPicker(rebuildSliders = false, isScrubbing = false) {
    if (renderRaf) cancelAnimationFrame(renderRaf);
    renderRaf = requestAnimationFrame(() => performRender(rebuildSliders, isScrubbing));
}

function performRender(rebuildSliders, isScrubbing) {
    updateVisuals(); updateCursors(); updateFooter();
    if (rebuildSliders) buildSlidersDOM();
    updateSlidersUI();

    const currentHex = getHex();

    if (cpFillMode === 'gradient') {
        gradStops[activeStopIdx].hex = currentHex;
        gradStops[activeStopIdx].op = cpAlpha;
        const rows = document.getElementById('gradColorsList').children;
        if (rows[activeStopIdx]) {
            const stop = gradStops[activeStopIdx];
            rows[activeStopIdx].querySelector('.cp-grad-swatch').style.backgroundColor = hexToRgbaStr(stop.hex, stop.op);
        }
        updateGradPreview();
        if (currentHex !== lastSentHex || cpAlpha !== lastSentAlpha || isScrubbing) {
            lastSentHex = currentHex; lastSentAlpha = cpAlpha;
            performGradientUpdate(isScrubbing);
        }
    } else {
        if (currentHex !== lastSentHex || cpAlpha !== lastSentAlpha || isScrubbing) {
            lastSentHex = currentHex; lastSentAlpha = cpAlpha;
            window.parent.postMessage({ action: 'update', hex: currentHex, opacity: cpAlpha, isScrubbing: isScrubbing }, '*');
        }
    }
}

function updateVisuals() {
    if (cpMode === 'spectrum') {
        cpMainArea.className = 'cp-main-bg mode-spectrum';
        cpTrackArea.className = 'cp-track-bg mode-spectrum';
        cpMainArea.style.background = `linear-gradient(to top, #000, rgba(0,0,0,0)), linear-gradient(to right, #fff, rgba(255,255,255,0)), hsl(${cpState.h}, 100%, 50%)`;
        cpMainDarken.style.opacity = 0;
        cpTrackArea.style.background = '';
    } else {
        cpMainArea.className = 'cp-main-bg mode-wheel';
        cpTrackArea.className = 'cp-track-bg mode-wheel';
        cpMainArea.style.background = '';
        cpMainDarken.style.opacity = 1 - (cpState.b / 100);

        const pureRgb = hsbToRgb(cpState.h, cpState.s, 100);
        cpTrackArea.style.background = `linear-gradient(to bottom, rgb(${pureRgb.r},${pureRgb.g},${pureRgb.b}), #000)`;
    }
}

function updateCursors() {
    const c1 = document.getElementById('cpMainCursor'), c2 = document.getElementById('cpTrackCursor');
    const w1 = 200, h1 = 200, h2 = 200;

    if (cpMode === 'spectrum') {
        c1.style.left = `${(cpState.s/100)*w1}px`; c1.style.top = `${h1 - (cpState.b/100)*h1}px`;
        c2.style.top = `${(cpState.h/360)*h2}px`;
    } else {
        let a = (cpState.h - 90) * (Math.PI/180), r = (cpState.s/100) * (w1/2);
        c1.style.left = `${(w1/2) + Math.cos(a)*r}px`; c1.style.top = `${(w1/2) + Math.sin(a)*r}px`;
        c2.style.top = `${(1 - cpState.b/100)*h2}px`;
    }
}

function updateFooter() {
    const hex = getHex();
    document.getElementById('cpSwatchNew').style.backgroundColor = hex;
    if (document.activeElement !== document.getElementById('cpHexInput')) {
        document.getElementById('cpHexInput').value = hex.replace('#', '');
    }
}

function setupAppLikeInput(inp) {
    let isFirstType = false;
    inp.addEventListener('focus', function() { this.classList.add('app-input-grey'); isFirstType = true; setTimeout(() => this.select(), 0); });
    inp.addEventListener('keydown', function(e) { if (isFirstType && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) { this.value = ''; this.classList.remove('app-input-grey'); isFirstType = false; }});
    inp.addEventListener('input', function() { this.classList.remove('app-input-grey'); isFirstType = false; });
    inp.addEventListener('blur', function() { this.classList.remove('app-input-grey'); isFirstType = false; window.getSelection().removeAllRanges(); });
}

setupAppLikeInput(document.getElementById('cpHexInput'));
document.getElementById('cpHexInput').addEventListener('change', (e) => {
    let val = e.target.value.replace('#', '');
    if (/^[0-9A-Fa-f]{3}$/.test(val)) val = val.split('').map(c=>c+c).join('');
    if (/^[0-9A-Fa-f]{6}$/.test(val)) {
        Object.assign(cpState, hexToHsb('#'+val));
        renderPicker(false, false);
    } else {
        e.target.value = getHex().replace('#', '');
    }
});
