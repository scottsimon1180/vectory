/* fileName: colorPicker-sliders.js */

function buildSlidersDOM() {
    const topContainer = document.getElementById('cpTopSlidersContainer'), rgbContainer = document.getElementById('cpRgbSlidersContainer'), opContainer = document.getElementById('cpOpacitySliderContainer');
    topContainer.innerHTML = ''; rgbContainer.innerHTML = ''; opContainer.innerHTML = '';
    activeTopSliders = {}; activeRgbSliders = {}; activeAlphaSlider = {};
    
    const buildRow = (id, label, min, max, callback, containerDOM, targetObj, isAlpha = false) => {
        const row = document.createElement('div'); row.className = 'cp-slider-row';
        const lbl = document.createElement('div'); lbl.className = 'cp-slider-lbl'; lbl.textContent = label;
        const rng = document.createElement('input'); rng.type = 'range'; rng.className = 'cp-slider-inp' + (isAlpha ? ' cp-alpha-track' : ''); rng.min = min; rng.max = max; rng.step = 'any';
        const num = document.createElement('input'); num.type = 'number'; num.className = 'cp-num-inp'; num.min = min; num.max = max;
        setupAppLikeInput(num); targetObj[id] = { rng, num };

        rng.addEventListener('pointerdown', () => document.body.classList.add('is-dragging'));
        rng.addEventListener('pointerup', () => document.body.classList.remove('is-dragging'));
        rng.addEventListener('pointercancel', () => document.body.classList.remove('is-dragging'));

        const sync = (v, isNumInput, isScrubbing = false) => { 
            let valFloat = Math.min(max, Math.max(min, isNaN(parseFloat(v)) ? 0 : parseFloat(v))); 
            if (isNumInput) rng.value = valFloat; else num.value = Math.round(valFloat);
            callback(valFloat); renderPicker(false, isScrubbing); 
        };
        
        rng.addEventListener('input', (e) => sync(e.target.value, false, true));
        rng.addEventListener('change', (e) => sync(e.target.value, false, false));
        num.addEventListener('input', (e) => sync(e.target.value, true, true));
        num.addEventListener('change', (e) => sync(e.target.value, true, false));

        row.addEventListener('wheel', (e) => {
            e.preventDefault();
            let val = isNaN(parseFloat(num.value)) ? 0 : parseFloat(num.value);
            val += (Math.abs(e.deltaX) > Math.abs(e.deltaY) ? Math.sign(e.deltaX) : -Math.sign(e.deltaY)) * (e.shiftKey ? 10 : 1);
            sync(val, true, false);
        }, { passive: false });

        row.appendChild(lbl); row.appendChild(rng); row.appendChild(num); containerDOM.appendChild(row);
    };

    if (cpTab === 'hsb') {
        buildRow('h', 'H', 0, 360, (v) => { cpState.h = v; }, topContainer, activeTopSliders);
        buildRow('s', 'S', 0, 100, (v) => { cpState.s = v; }, topContainer, activeTopSliders);
        buildRow('b', 'B', 0, 100, (v) => { cpState.b = v; }, topContainer, activeTopSliders);
    } else if (cpTab === 'hsl') {
        buildRow('h', 'H', 0, 360, (v) => { let c = hsbToHsl(cpState.h, cpState.s, cpState.b); Object.assign(cpState, hslToHsb(v, c.s, c.l, cpState.h, cpState.s)); }, topContainer, activeTopSliders);
        buildRow('s', 'S', 0, 100, (v) => { let c = hsbToHsl(cpState.h, cpState.s, cpState.b); Object.assign(cpState, hslToHsb(c.h, v, c.l, cpState.h, cpState.s)); }, topContainer, activeTopSliders);
        buildRow('l', 'L', 0, 100, (v) => { let c = hsbToHsl(cpState.h, cpState.s, cpState.b); Object.assign(cpState, hslToHsb(c.h, c.s, v, cpState.h, cpState.s)); }, topContainer, activeTopSliders);
    }
    buildRow('r', 'R', 0, 255, (v) => { let c = hsbToRgb(cpState.h, cpState.s, cpState.b); Object.assign(cpState, rgbToHsb(v, c.g, c.b, cpState.h, cpState.s)); }, rgbContainer, activeRgbSliders);
    buildRow('g', 'G', 0, 255, (v) => { let c = hsbToRgb(cpState.h, cpState.s, cpState.b); Object.assign(cpState, rgbToHsb(c.r, v, c.b, cpState.h, cpState.s)); }, rgbContainer, activeRgbSliders);
    buildRow('b', 'B', 0, 255, (v) => { let c = hsbToRgb(cpState.h, cpState.s, cpState.b); Object.assign(cpState, rgbToHsb(c.r, c.g, v, cpState.h, cpState.s)); }, rgbContainer, activeRgbSliders);
    buildRow('a', 'A', 0, 100, (v) => { cpAlpha = v; }, opContainer, activeAlphaSlider, true);
}

function updateSlidersUI() {
    const setVal = (inp, val) => { if (document.activeElement !== inp) inp.value = val; };
    if (cpTab === 'hsb' && activeTopSliders.h) {
        setVal(activeTopSliders.h.rng, cpState.h); setVal(activeTopSliders.h.num, Math.round(cpState.h));
        setVal(activeTopSliders.s.rng, cpState.s); setVal(activeTopSliders.s.num, Math.round(cpState.s));
        setVal(activeTopSliders.b.rng, cpState.b); setVal(activeTopSliders.b.num, Math.round(cpState.b));
        
        activeTopSliders.h.rng.style.setProperty('--slider-bg', 'linear-gradient(to right, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)');
        activeTopSliders.s.rng.style.setProperty('--slider-bg', `linear-gradient(to right, ${rgbToHex(hsbToRgb(cpState.h,0,cpState.b).r, hsbToRgb(cpState.h,0,cpState.b).g, hsbToRgb(cpState.h,0,cpState.b).b)}, ${rgbToHex(hsbToRgb(cpState.h,100,cpState.b).r, hsbToRgb(cpState.h,100,cpState.b).g, hsbToRgb(cpState.h,100,cpState.b).b)})`);
        activeTopSliders.b.rng.style.setProperty('--slider-bg', `linear-gradient(to right, #000, ${rgbToHex(hsbToRgb(cpState.h,cpState.s,100).r, hsbToRgb(cpState.h,cpState.s,100).g, hsbToRgb(cpState.h,cpState.s,100).b)})`);
    } else if (cpTab === 'hsl' && activeTopSliders.h) {
        let c = hsbToHsl(cpState.h, cpState.s, cpState.b);
        setVal(activeTopSliders.h.rng, c.h); setVal(activeTopSliders.h.num, Math.round(c.h));
        setVal(activeTopSliders.s.rng, c.s); setVal(activeTopSliders.s.num, Math.round(c.s));
        setVal(activeTopSliders.l.rng, c.l); setVal(activeTopSliders.l.num, Math.round(c.l));
        
        let hInt = Math.round(c.h), sInt = Math.round(c.s), lInt = Math.round(c.l);
        activeTopSliders.h.rng.style.setProperty('--slider-bg', 'linear-gradient(to right, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)');
        activeTopSliders.s.rng.style.setProperty('--slider-bg', `linear-gradient(to right, hsl(${hInt}, 0%, ${lInt}%), hsl(${hInt}, 100%, ${lInt}%))`);
        activeTopSliders.l.rng.style.setProperty('--slider-bg', `linear-gradient(to right, #000, hsl(${hInt}, ${sInt}%, 50%), #fff)`);
    }
    if (activeRgbSliders.r) {
        let c = hsbToRgb(cpState.h, cpState.s, cpState.b);
        setVal(activeRgbSliders.r.rng, c.r); setVal(activeRgbSliders.r.num, Math.round(c.r));
        setVal(activeRgbSliders.g.rng, c.g); setVal(activeRgbSliders.g.num, Math.round(c.g));
        setVal(activeRgbSliders.b.rng, c.b); setVal(activeRgbSliders.b.num, Math.round(c.b));
        
        let rInt = Math.round(c.r), gInt = Math.round(c.g), bInt = Math.round(c.b);
        activeRgbSliders.r.rng.style.setProperty('--slider-bg', `linear-gradient(to right, rgb(0,${gInt},${bInt}), rgb(255,${gInt},${bInt}))`);
        activeRgbSliders.g.rng.style.setProperty('--slider-bg', `linear-gradient(to right, rgb(${rInt},0,${bInt}), rgb(${rInt},255,${bInt}))`);
        activeRgbSliders.b.rng.style.setProperty('--slider-bg', `linear-gradient(to right, rgb(${rInt},${gInt},0), rgb(${rInt},${gInt},255))`);
    }
    if (activeAlphaSlider.a) {
        setVal(activeAlphaSlider.a.rng, cpAlpha); setVal(activeAlphaSlider.a.num, Math.round(cpAlpha));
        let c = hsbToRgb(cpState.h, cpState.s, cpState.b);
        activeAlphaSlider.a.rng.style.setProperty('--alpha-grad', `linear-gradient(to right, rgba(${c.r},${c.g},${c.b},0), rgba(${c.r},${c.g},${c.b},1))`);
    }
}

function bindPointerDrag(el, callback, commitCallback) {
    let isDragging = false;
    const handleEvent = (e) => {
        const rect = el.getBoundingClientRect();
        callback(e.clientX - rect.left, e.clientY - rect.top, rect.width, rect.height);
    };
    el.addEventListener('pointerdown', (e) => { document.body.classList.add('is-dragging'); el.setPointerCapture(e.pointerId); isDragging = true; handleEvent(e); });
    el.addEventListener('pointermove', (e) => { if (isDragging) handleEvent(e); });
    const stop = (e) => {
        if (!isDragging) return;
        document.body.classList.remove('is-dragging');
        isDragging = false;
        try { el.releasePointerCapture(e.pointerId); } catch (_) {}
        if (commitCallback) commitCallback();
    };
    el.addEventListener('pointerup', stop);
    el.addEventListener('pointercancel', stop);
}

bindPointerDrag(document.getElementById('cpMainWrap'), (x, y, w, h) => {
    x = Math.max(0, Math.min(w, x)); y = Math.max(0, Math.min(h, y));
    if (cpMode === 'spectrum') {
        cpState.s = (x / w) * 100; cpState.b = 100 - (y / h) * 100;
    } else {
        let cx = w/2, cy = h/2, cr = w/2;
        let dx = x - cx, dy = y - cy, a = Math.atan2(dy, dx) * (180/Math.PI) + 90;
        if (a < 0) a += 360;
        cpState.h = a; cpState.s = Math.min(100, (Math.sqrt(dx*dx + dy*dy) / cr) * 100);
    }
    renderPicker(false, true);
}, () => renderPicker(false, false));

bindPointerDrag(document.getElementById('cpTrackWrap'), (x, y, w, h) => {
    let pct = (Math.max(0, Math.min(h, y)) / h) * 100;
    if (cpMode === 'spectrum') cpState.h = (pct/100)*360; else cpState.b = 100 - pct;
    renderPicker(false, true);
}, () => renderPicker(false, false));

document.getElementById('cpTrackWrap').addEventListener('wheel', (e) => {
    e.preventDefault();
    let delta = Math.sign(e.deltaY) || Math.sign(e.deltaX);
    if (delta === 0) return;
    let step = e.shiftKey ? 10 : 1;
    
    if (cpMode === 'spectrum') {
        cpState.h = Math.max(0, Math.min(360, cpState.h + (delta * step * 3.6)));
    } else {
        cpState.b = Math.max(0, Math.min(100, cpState.b - (delta * step)));
    }
    renderPicker(false, false);
}, { passive: false });
