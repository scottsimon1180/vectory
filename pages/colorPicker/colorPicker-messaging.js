/* fileName: colorPicker-messaging.js */

function broadcastState() {
    const rects = [];
    if (document.getElementById('cpModalOverlay').style.display !== 'none') {
        const r = cpModal.getBoundingClientRect();
        rects.push({ left: r.left, right: r.right, top: r.top, bottom: r.bottom });
    }
    if (contextMenu.classList.contains('active')) {
        const r = contextMenu.getBoundingClientRect();
        rects.push({ left: r.left, right: r.right, top: r.top, bottom: r.bottom });
    }
    const body = document.body;
    const isDragging = !!(body && body.classList && body.classList.contains('is-dragging')) || isDraggingModal;
    window.parent.postMessage({ action: 'cpState', rects, isDragging }, '*');
}

function observeBodyClass() {
    broadcastState();
}
if (document.body && document.body.nodeType === 1) observeBodyClass();
else document.addEventListener('DOMContentLoaded', observeBodyClass, { once: true });

window.addEventListener('pointermove', e => {
    window.parent.postMessage({ action: 'mouseMove', x: e.clientX, y: e.clientY }, '*');
});

window.addEventListener('message', (event) => {
    if (!event.data) return;
    if (event.data.action === 'open') {
        openCustomPicker(event.data.data, event.data.isGradient, event.data.opacity, event.data.resetPosition);
    } else if (event.data.action === 'eyedropperPicked' && isEyedropperActive) {
        Object.assign(cpState, hexToHsb(event.data.hex));
        if (cpFillMode === 'gradient') {
            gradStops[activeStopIdx].hex = event.data.hex;
            renderGradRows();
        }
        renderPicker(false, false);
        toggleEyedropper();
    } else if (event.data.action === 'eyedropperToggle') {
        isEyedropperActive = event.data.state;
        document.getElementById('cpEyedropperBtn').classList.toggle('active', isEyedropperActive);
        document.body.classList.toggle('is-eyedropper-active', isEyedropperActive);
    }
});

// --- Eyedropper toggle, Escape key, and open/confirm/close lifecycle ---

function toggleEyedropper() {
    isEyedropperActive = !isEyedropperActive;
    const btn = document.getElementById('cpEyedropperBtn');
    btn.classList.toggle('active', isEyedropperActive);
    document.body.classList.toggle('is-eyedropper-active', isEyedropperActive);
    window.parent.postMessage({ action: 'eyedropperToggle', state: isEyedropperActive }, '*');
}

document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        if (document.getElementById('cpDegOverlay').style.display === 'flex') {
            cancelDegOverlay();
        } else if (isEyedropperActive) {
            toggleEyedropper();
        }
    }
});

function closeCustomPicker() {
    if (isEyedropperActive) toggleEyedropper();
    hideContextMenu();
    closeDegOverlay();
    rememberModalPosition();

    cpModal.style.animation = 'cpModalOut 0.1s ease-in forwards';

    setTimeout(() => {
        document.getElementById('cpModalOverlay').style.display = 'none';
        cpModal.style.animation = '';
        window.parent.postMessage({ action: 'cancel' }, '*');
        broadcastState();
    }, 100);
}

function confirmCustomPicker() {
    if (isEyedropperActive) toggleEyedropper();
    hideContextMenu();
    closeDegOverlay();
    rememberModalPosition();

    const confirmMsg = cpFillMode === 'gradient'
        ? { action: 'confirm', isGradient: true, gradientData: { type: gradType, angle: getSendAngle(), stops: gradStops.map(s => hex8(s.hex, s.op)) }, hex: getHex() }
        : { action: 'confirm', isGradient: false, hex: getHex(), opacity: cpAlpha };

    cpModal.style.animation = 'cpModalOut 0.1s ease-in forwards';

    setTimeout(() => {
        document.getElementById('cpModalOverlay').style.display = 'none';
        cpModal.style.animation = '';
        window.parent.postMessage(confirmMsg, '*');
        broadcastState();
    }, 100);
}

function openCustomPicker(initialData, isGradient, opacity, resetPosition) {
    lastSentHex = null; lastSentAlpha = null;
    cpAlpha = (typeof opacity === 'number') ? opacity : 100;
    if (resetPosition) resetModalPositionMemory();
    if (isEyedropperActive) toggleEyedropper();
    closeDegOverlay();
    
    if (isGradient && typeof initialData === 'object' && initialData !== null) {
        gradType = initialData.type || 'linear';
        let incomingAngle = Number(initialData.angle);
        if (!Number.isFinite(incomingAngle)) incomingAngle = 0;
        if (gradType === 'linear') {
            gradAngle = normalizeAngleDeg(incomingAngle + 180);
        } else {
            gradAngle = normalizeAngleDeg(incomingAngle);
        }
        let arr = Array.isArray(initialData.stops) ? initialData.stops : ['#ff3b30', '#007aff'];
        gradStops = normalizeGradientStops(arr);
        activeStopIdx = 0;
        cpAlpha = gradStops[activeStopIdx].op;
        updateAngleUI();
        document.getElementById('tbGradType').innerHTML = gradType === 'linear' ? SVG_LINEAR : SVG_ANGULAR;
        Object.assign(cpState, hexToHsb(gradStops[activeStopIdx].hex));
    } else if (isGradient) {
        gradType = 'linear';
        gradAngle = 0;
        gradStops = normalizeGradientStops(['#ff3b30', '#007aff']);
        activeStopIdx = 0;
        cpAlpha = gradStops[activeStopIdx].op;
        updateAngleUI();
        document.getElementById('tbGradType').innerHTML = SVG_LINEAR;
        Object.assign(cpState, hexToHsb(gradStops[activeStopIdx].hex));
    } else {
        let h = (typeof initialData === 'string' && !initialData.includes('url')) ? initialData : '#000000';
        const parsed = parseColorStr(h);
        Object.assign(cpState, hexToHsb(parsed.hex));
        if (typeof opacity !== 'number' || (cpAlpha === 100 && parsed.op < 100)) cpAlpha = parsed.op;
    }

    setFillMode(isGradient ? 'gradient' : 'solid'); 
    setPickerMode('wheel'); setSliderTab('hsb');       
    document.getElementById('cpModalOverlay').style.display = 'flex';
    applyModalPositionMemory();
    renderPicker(true, false);
    requestAnimationFrame(broadcastState);
}
