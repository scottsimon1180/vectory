/* fileName: colorPicker-gradient.js */

// --- Gradient Logic ---

function setGradRightTab(tab) {
    gradRightTab = tab;
    document.getElementById('btnGradSliders').classList.toggle('active', tab === 'sliders');
    document.getElementById('btnGradWheel').classList.toggle('active', tab === 'wheel');
    document.getElementById('btnGradSpectrum').classList.toggle('active', tab === 'spectrum');

    const canvasRow = document.getElementById('cpCanvasRow');
    const rightTarget = document.getElementById('cpRightCanvasTarget');

    if (tab === 'sliders') {
        document.getElementById('cpSlidersArea').style.display = 'block';
        rightTarget.style.display = 'none';
        canvasRow.style.display = 'none';
        setSliderTab('hsb');
    } else {
        document.getElementById('cpSlidersArea').style.display = 'none';
        rightTarget.style.display = 'flex';
        rightTarget.appendChild(canvasRow);
        canvasRow.style.display = 'flex';
        setPickerMode(tab);
    }
}

function stopLabel(i, n) {
    if (gradType === 'angular') {
        if (n === 2) return i === 0 ? "1 (Inner)" : "2 (Outer)";
        if (n === 3) return i === 0 ? "1 (Inner)" : (i === 1 ? "2 (Middle)" : "3 (Outer)");
        if (i === 0) return "1 (Inner)";
        if (i === n - 1) return `${n} (Outer)`;
        return `${i + 1}`;
    } else {
        if (n === 2) return i === 0 ? "1 (Top)" : "2 (Bottom)";
        if (n === 3) return i === 0 ? "1 (Top)" : (i === 1 ? "2 (Middle)" : "3 (Bottom)");
        if (i === 0) return "1 (Top)";
        if (i === n - 1) return `${n} (Bottom)`;
        return `${i + 1}`;
    }
}

function normalizeAngleDeg(raw) {
    let a = Number(raw); if (!Number.isFinite(a)) a = 0;
    if (a === 360 || a === -360) return 0;
    a = a % 360; if (a === 0) return 0;
    a = Math.trunc(a);
    if (a > 359) a = 359; if (a < -359) a = -359;
    return a;
}

function updateAngleUI() {
    const degree = '\u00B0';
    document.getElementById('gradAngleDisplay').textContent = `${gradAngle}${degree}`;
    document.getElementById('gradAngleRotator').style.transform = `rotate(${gradAngle}deg)`;
    document.getElementById('degBigRotator').style.transform = `rotate(${gradAngle}deg)`;
    document.getElementById('degAngleInput').value = `${gradAngle}${degree}`;
}

function setAngleDeg(deg) {
    gradAngle = normalizeAngleDeg(deg);
    updateAngleUI();
    performGradientUpdate(false);
}

document.getElementById('tbGradType').addEventListener('click', () => {
    gradType = (gradType === 'linear') ? 'angular' : 'linear';
    document.getElementById('tbGradType').innerHTML = gradType === 'linear' ? SVG_LINEAR : SVG_ANGULAR;
    renderGradRows();
    performGradientUpdate(false);
});

const degOverlay = document.getElementById('cpDegOverlay');
let degAngleOnOpen = 0;
document.getElementById('tbGradAngle').addEventListener('click', () => {
    degAngleOnOpen = gradAngle;
    document.getElementById('degAngleInput').value = `${gradAngle}\u00B0`;
    degOverlay.style.display = 'flex';
});

function cancelDegOverlay() {
    setAngleDeg(degAngleOnOpen);
    degOverlay.style.display = 'none';
}
document.getElementById('degCancelBtn').addEventListener('click', cancelDegOverlay);

function closeDegOverlay() {
    if (degOverlay.style.display !== 'flex') { degOverlay.style.display = 'none'; return; }
    const raw = document.getElementById('degAngleInput').value.replace(/\u00B0/g, '');
    setAngleDeg(raw);
    degOverlay.style.display = 'none';
}

document.getElementById('degCloseBtn').addEventListener('click', closeDegOverlay);

degOverlay.querySelectorAll('.preset-btn[data-deg]').forEach(btn => {
    btn.addEventListener('click', () => { setAngleDeg(btn.getAttribute('data-deg')); });
});
document.getElementById('btnHInvert').addEventListener('click', () => { setAngleDeg(-gradAngle); });
document.getElementById('btnVInvert').addEventListener('click', () => { setAngleDeg(180 - gradAngle); });

// --- Draggable angle dial (absolute, Photoshop-style; hold Shift to snap to 15°) ---
const degDialWrap = document.getElementById('degDialWrap');
let dialDragging = false, dialRawDeg = 0;

function applyDialAngle(snap) {
    let deg = snap ? Math.round(dialRawDeg / 15) * 15 : Math.round(dialRawDeg);
    gradAngle = ((deg % 360) + 360) % 360;
    updateAngleUI();
    performGradientUpdate(true);
}
function dialReadAngle(e) {
    const r = degDialWrap.getBoundingClientRect();
    const dx = e.clientX - (r.left + r.width / 2);
    const dy = e.clientY - (r.top + r.height / 2);
    dialRawDeg = Math.atan2(dx, -dy) * (180 / Math.PI); // 0° points up, clockwise positive
}
degDialWrap.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    dialDragging = true;
    document.body.classList.add('is-dragging');
    degDialWrap.classList.add('is-grabbing');
    degDialWrap.setPointerCapture(e.pointerId);
    dialReadAngle(e); applyDialAngle(e.shiftKey);
});
degDialWrap.addEventListener('pointermove', (e) => {
    if (!dialDragging) return;
    dialReadAngle(e); applyDialAngle(e.shiftKey);
});
function endDialDrag(e) {
    if (!dialDragging) return;
    dialDragging = false;
    document.body.classList.remove('is-dragging');
    degDialWrap.classList.remove('is-grabbing');
    try { degDialWrap.releasePointerCapture(e.pointerId); } catch (_) {}
    performGradientUpdate(false);
}
degDialWrap.addEventListener('pointerup', endDialDrag);
degDialWrap.addEventListener('pointercancel', endDialDrag);
// Live snap toggle when Shift is pressed/released mid-drag without moving the pointer
document.addEventListener('keydown', (e) => { if (dialDragging && e.key === 'Shift') applyDialAngle(true); });
document.addEventListener('keyup', (e) => { if (dialDragging && e.key === 'Shift') applyDialAngle(false); });

// --- Scroll-wheel fine-tuning over the dial or the angle input (±1, Shift = ±10) ---
let angleWheelCommit = null;
function angleWheelAdjust(e) {
    e.preventDefault();
    const dir = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? Math.sign(e.deltaX) : -Math.sign(e.deltaY);
    if (!dir) return;
    const step = e.shiftKey ? 10 : 1;
    gradAngle = ((Math.round(gradAngle) + dir * step) % 360 + 360) % 360;
    updateAngleUI();
    performGradientUpdate(true);
    clearTimeout(angleWheelCommit);
    angleWheelCommit = setTimeout(() => performGradientUpdate(false), 150);
}
degDialWrap.addEventListener('wheel', angleWheelAdjust, { passive: false });
document.getElementById('degAngleInput').addEventListener('wheel', angleWheelAdjust, { passive: false });

document.getElementById('degAngleInput').addEventListener('focus', function() { this.value = gradAngle; this.select(); });
document.getElementById('degAngleInput').addEventListener('input', function() {
    gradAngle = normalizeAngleDeg(this.value);
    updateAngleUI(); performGradientUpdate(true);
});
document.getElementById('degAngleInput').addEventListener('blur', (e) => {
    if (e.relatedTarget && degOverlay.contains(e.relatedTarget)) return;
    closeDegOverlay();
});

document.getElementById('btnGradPlus').addEventListener('click', () => {
    if (gradStops.length < 24) {
        gradStops.push({ ...gradStops[gradStops.length - 1] });
        activeStopIdx = gradStops.length - 1;
        cpAlpha = gradStops[activeStopIdx].op;
        renderGradRows();
        performGradientUpdate(false);
        Object.assign(cpState, hexToHsb(gradStops[activeStopIdx].hex));
        renderPicker(true, false);
    }
});

document.getElementById('btnGradTrash').addEventListener('click', () => {
    if (gradStops.length > 2) {
        gradStops.splice(activeStopIdx, 1);
        if (activeStopIdx >= gradStops.length) activeStopIdx = gradStops.length - 1;
        cpAlpha = gradStops[activeStopIdx].op;
        renderGradRows();
        performGradientUpdate(false);
        Object.assign(cpState, hexToHsb(gradStops[activeStopIdx].hex));
        renderPicker(true, false);
    }
});

function setupGradDragHandle(row, handle, startIndex) {
    let isDragging = false;
    let startY = 0;
    let offsetY = 0;
    let placeholder = null;
    let list = document.getElementById('gradColorsList');

    const onPointerMoveDrag = (e) => {
        if (!isDragging || !placeholder) return;
        e.preventDefault();
        row.style.top = (e.clientY - offsetY) + 'px';

        const siblings = Array.from(list.querySelectorAll('.cp-grad-row:not(.is-dragging)'));
        let targetSibling = null;

        for (const sibling of siblings) {
            const rect = sibling.getBoundingClientRect();
            if (e.clientY < (rect.top + rect.height / 2)) { targetSibling = sibling; break; }
        }

        if (targetSibling) { list.insertBefore(placeholder, targetSibling); }
        else { list.appendChild(placeholder); }
    };

    const onPointerUpDrag = () => {
        if (!isDragging) return;
        isDragging = false;

        let newIndex = Array.from(list.children).filter(c => c !== row).indexOf(placeholder);
        if (placeholder && placeholder.parentNode === list) {
            list.insertBefore(row, placeholder);
            placeholder.remove();
        } else {
            list.appendChild(row);
            newIndex = gradStops.length - 1;
        }
        placeholder = null;

        row.classList.remove('is-dragging');
        row.style.position = ''; row.style.top = ''; row.style.left = ''; row.style.width = ''; row.style.margin = '';

        document.removeEventListener('pointermove', onPointerMoveDrag);
        document.removeEventListener('pointerup', onPointerUpDrag);
        document.removeEventListener('pointercancel', onPointerUpDrag);

        // Reorder array logically.
        const movedColor = gradStops.splice(startIndex, 1)[0];
        gradStops.splice(newIndex, 0, movedColor);
        if (activeStopIdx === startIndex) activeStopIdx = newIndex;
        else if (startIndex < activeStopIdx && newIndex >= activeStopIdx) activeStopIdx--;
        else if (startIndex > activeStopIdx && newIndex <= activeStopIdx) activeStopIdx++;

        renderGradRows();
        performGradientUpdate(false);
    };

    handle.addEventListener('pointerdown', (e) => {
        startY = e.clientY;
        isDragging = true;
        const rect = row.getBoundingClientRect();
        offsetY = startY - rect.top;

        placeholder = document.createElement('div');
        placeholder.className = 'cp-grad-row-placeholder';
        placeholder.style.height = rect.height + 'px';
        list.insertBefore(placeholder, row);

        row.style.position = 'fixed';
        row.style.top = rect.top + 'px';
        row.style.left = rect.left + 'px';
        row.style.width = rect.width + 'px';
        row.style.margin = '0';
        row.classList.add('is-dragging');

        document.addEventListener('pointermove', onPointerMoveDrag, { passive: false });
        document.addEventListener('pointerup', onPointerUpDrag);
        document.addEventListener('pointercancel', onPointerUpDrag);
    });
    handle.addEventListener('contextmenu', e => e.preventDefault());
}

function renderGradRows() {
    const list = document.getElementById('gradColorsList');
    list.innerHTML = '';
    gradStops.forEach((stopObj, i) => {
        const row = document.createElement('div');
        row.className = 'cp-grad-row' + (i === activeStopIdx ? ' active' : '');

        row.onclick = (e) => {
            if (e.target.closest('.cp-grad-drag')) return;
            activeStopIdx = i;
            cpAlpha = stopObj.op;
            renderGradRows();
            Object.assign(cpState, hexToHsb(stopObj.hex));
            renderPicker(true, false);
        };

        let pressTimer, isDraggingRow = false, longPressed = false;
        row.oncontextmenu = (e) => {
            e.preventDefault();
            if (gradStops.length > 2) showContextMenu(row, i, 'gradStop');
        };
        const startPress = (e) => {
            if (e.touches && e.touches.length > 1) return;
            isDraggingRow = false;
            pressTimer = window.setTimeout(() => {
                longPressed = true;
                if (gradStops.length > 2) showContextMenu(row, i, 'gradStop');
            }, 500);
        };
        const cancelPress = () => { if (pressTimer) clearTimeout(pressTimer); };
        const markDrag = () => { isDraggingRow = true; cancelPress(); };

        row.addEventListener('pointerdown', startPress, { passive: true });
        row.addEventListener('pointerup', cancelPress);
        row.addEventListener('pointermove', markDrag, { passive: true });
        row.addEventListener('pointercancel', cancelPress);

        const drag = document.createElement('div');
        drag.className = 'cp-grad-drag';
        drag.innerHTML = `<svg viewBox="0 0 12 16"><circle cx="3.5" cy="3" r="1.3"/><circle cx="8.5" cy="3" r="1.3"/><circle cx="3.5" cy="8" r="1.3"/><circle cx="8.5" cy="8" r="1.3"/><circle cx="3.5" cy="13" r="1.3"/><circle cx="8.5" cy="13" r="1.3"/></svg>`;

        const swatchWrap = document.createElement('div');
        swatchWrap.className = 'cp-grad-swatch-wrap';
        const swatch = document.createElement('div');
        swatch.className = 'cp-grad-swatch';
        swatch.style.backgroundColor = hexToRgbaStr(stopObj.hex, stopObj.op);
        swatchWrap.appendChild(swatch);

        const lbl = document.createElement('div');
        lbl.className = 'cp-grad-label';
        lbl.textContent = stopLabel(i, gradStops.length);

        row.appendChild(drag);
        row.appendChild(swatchWrap);
        row.appendChild(lbl);
        list.appendChild(row);

        setupGradDragHandle(row, drag, i);
    });

    const countEl = document.getElementById('gradStopCount');
    if (countEl) countEl.textContent = gradStops.length;
    updateGradPreview();
}

function updateGradPreview() {
    const pv = document.getElementById('gradPreviewBar');
    if (!pv) return;
    const n = gradStops.length;
    const parts = gradStops.map((s, i) => {
        const pos = n > 1 ? (i / (n - 1)) * 100 : 0;
        return `${hexToRgbaStr(s.hex, s.op)} ${pos.toFixed(1)}%`;
    });
    pv.style.background = (gradType === 'angular')
        ? `radial-gradient(circle at 50% 50%, ${parts.join(', ')})`
        : `linear-gradient(90deg, ${parts.join(', ')})`;
}

function performGradientUpdate(isScrubbing) {
    const stops8 = gradStops.map(s => hex8(s.hex, s.op));
    window.parent.postMessage({
        action: 'update',
        isGradient: true,
        gradientData: { type: gradType, angle: getSendAngle(), stops: stops8 },
        hex: stops8[0],
        isScrubbing: isScrubbing
    }, '*');
}
