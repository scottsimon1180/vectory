/* fileName: colorPicker-saved-colors.js */

let savedBank = [];
try {
    const stored = localStorage.getItem('pixelForgeSavedColors');
    if (stored) savedBank = JSON.parse(stored);
} catch (e) { console.warn("LocalStorage blocked."); }

function renderSavedBank() {
    const grid = document.getElementById('cpBankGrid'); grid.innerHTML = '';
    for (let i = 0; i < 14; i++) {
        const swatch = document.createElement('div');
        if (i < savedBank.length) {
            const hex = savedBank[i];
            swatch.className = 'cp-bank-swatch filled'; swatch.style.backgroundColor = hex;

            let pressTimer, isDragging = false, longPressed = false;

            swatch.onclick = () => {
                if (longPressed) { longPressed = false; return; }
                Object.assign(cpState, hexToHsb(hex));

                if (cpFillMode === 'gradient') {
                    gradStops[activeStopIdx].hex = hex;
                    renderGradRows();
                }
                renderPicker(false, false);
            };
            swatch.oncontextmenu = (e) => { e.preventDefault(); showContextMenu(swatch, i, 'bank'); };

            const startPress = (e) => {
                if (e.touches && e.touches.length > 1) return;
                isDragging = false;
                pressTimer = window.setTimeout(() => { longPressed = true; showContextMenu(swatch, i, 'bank'); }, 500);
            };
            const cancelPress = () => { if(pressTimer) clearTimeout(pressTimer); };
            const markDrag = () => { isDragging = true; cancelPress(); };

            swatch.addEventListener('pointerdown', startPress, { passive: true });
            swatch.addEventListener('pointerup', cancelPress);
            swatch.addEventListener('pointermove', markDrag, { passive: true });
            swatch.addEventListener('pointercancel', cancelPress);

        } else { swatch.className = 'cp-bank-swatch empty'; }
        grid.appendChild(swatch);
    }
}

function addCurrentColorToBank() {
    const currentHex = getHex();
    savedBank = savedBank.filter(hex => hex !== currentHex);
    savedBank.unshift(currentHex);
    if (savedBank.length > 14) savedBank.pop();
    try { localStorage.setItem('pixelForgeSavedColors', JSON.stringify(savedBank)); } catch(e){}
    renderSavedBank();
}

function initPresets() {
    const grid = document.getElementById('cpPresetsGrid');
    // Row 1 (brights) and Row 6 (grayscale) show in both solid & gradient modes.
    // Rows 2-5 (shades) are tagged 'cp-preset-extra' and only show in solid mode.
    const colors = [
        '#ff0000', '#ff8000', '#ffff00', '#80ff00', '#00ff00', '#00ff80', '#00ffff', '#0080ff', '#0000ff', '#8000ff', '#ff00ff', '#ff0080',
        '#cc0000', '#cc6600', '#cccc00', '#66cc00', '#00cc00', '#00cc66', '#00cccc', '#0066cc', '#0000cc', '#6600cc', '#cc00cc', '#cc0066',
        '#990000', '#994d00', '#999900', '#4d9900', '#009900', '#00994d', '#009999', '#004d99', '#000099', '#4d0099', '#990099', '#99004d',
        '#660000', '#663300', '#666600', '#336600', '#006600', '#006633', '#006666', '#003366', '#000066', '#330066', '#660066', '#660033',
        '#330000', '#331a00', '#333300', '#1a3300', '#003300', '#00331a', '#003333', '#001a33', '#000033', '#1a0033', '#330033', '#33001a',
        '#000000', '#333333', '#474747', '#5c5c5c', '#707070', '#858585', '#999999', '#adadad', '#c2c2c2', '#d6d6d6', '#ebebeb', '#ffffff'
    ];
    colors.forEach((hex, i) => {
        const swatch = document.createElement('div');
        swatch.className = 'cp-preset-swatch'; swatch.style.backgroundColor = hex;
        if (i >= 12 && i < 60) swatch.classList.add('cp-preset-extra');
        swatch.onclick = () => {
            Object.assign(cpState, hexToHsb(hex));
            if (cpFillMode === 'gradient') {
                gradStops[activeStopIdx].hex = hex;
                renderGradRows();
            }
            renderPicker(false, false);
        };
        grid.appendChild(swatch);
    });
}
