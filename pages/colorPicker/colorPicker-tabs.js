/* fileName: colorPicker-tabs.js */

function setFillMode(mode) {
    const modeChanged = cpFillMode !== mode;
    cpFillMode = mode;
    if (modeChanged) {
        lastSentHex = null;
        lastSentAlpha = null;
    }
    document.getElementById('btnModeSolid').classList.toggle('active', mode === 'solid');
    document.getElementById('btnModeGradient').classList.toggle('active', mode === 'gradient');

    ['cpOpacityDivider','cpOpacityLabel','cpOpacitySliderContainer'].forEach(id => {
        const el = document.getElementById(id); if (el) el.style.display = '';
    });

    const canvasRow = document.getElementById('cpCanvasRow');
    const leftPanel = document.getElementById('cpLeftPanel');
    const presets = document.getElementById('cpPresetsGrid');
    const gradEditor = document.getElementById('gradientEditorArea');

    // Solid mode shows the full 6-row preset palette; gradient mode condenses to 2 rows.
    presets.classList.toggle('cp-condensed', mode === 'gradient');

    if (mode === 'solid') {
        if (degOverlay) degOverlay.style.display = 'none';
        document.getElementById('solidLeftTabs').style.display = 'flex';
        gradEditor.style.display = 'none';

        document.getElementById('solidRightTabs').style.display = 'flex';
        document.getElementById('gradientRightTabs').style.display = 'none';

        document.getElementById('cpSlidersArea').style.display = 'block';
        document.getElementById('cpRightCanvasTarget').style.display = 'none';

        leftPanel.insertBefore(canvasRow, presets);
        canvasRow.style.display = 'flex';

        setPickerMode(cpMode);
        setSliderTab(cpTab);

        Object.assign(cpState, hexToHsb(getHex()));
        renderPicker(true, false);
    } else {
        document.getElementById('solidLeftTabs').style.display = 'none';
        gradEditor.style.display = 'flex';

        document.getElementById('solidRightTabs').style.display = 'none';
        document.getElementById('gradientRightTabs').style.display = 'flex';

        // Seed a default gradient when none exists yet (e.g. switching solid -> gradient on a fresh picker).
        if (!Array.isArray(gradStops) || gradStops.length < 2) {
            const baseHex = getHex();
            const baseOp = Math.max(0, Math.min(100, cpAlpha));
            gradStops = [{ hex: baseHex, op: baseOp }, { hex: baseHex, op: 0 }];
            activeStopIdx = 0;
            gradType = 'linear';
            gradAngle = 0;
            updateAngleUI();
            document.getElementById('tbGradType').innerHTML = SVG_LINEAR;
        }
        if (activeStopIdx >= gradStops.length) activeStopIdx = 0;

        setGradRightTab(gradRightTab);

        cpAlpha = gradStops[activeStopIdx].op;
        renderGradRows();
        Object.assign(cpState, hexToHsb(gradStops[activeStopIdx].hex));
        renderPicker(true, false);
    }
}

function setPickerMode(mode) {
    cpMode = mode;
    if (cpFillMode === 'gradient' && mode !== 'sliders') gradRightTab = mode;

    document.getElementById('btnModeSpectrum').classList.toggle('active', mode === 'spectrum');
    document.getElementById('btnModeWheel').classList.toggle('active', mode === 'wheel');

    if (cpFillMode === 'gradient' && gradRightTab !== 'sliders') {
        document.getElementById('btnGradWheel').classList.toggle('active', mode === 'wheel');
        document.getElementById('btnGradSpectrum').classList.toggle('active', mode === 'spectrum');
    }

    if (mode === 'wheel') {
        cpMainWrap.style.borderRadius = '50%';
        cpMainWrap.style.boxShadow = 'none';
    } else {
        cpMainWrap.style.borderRadius = '4px';
        cpMainWrap.style.boxShadow = 'inset 0 0 0 1px rgba(0,0,0,0.2)';
    }
    renderPicker(false, false);
}

function setSliderTab(tab) {
    cpTab = tab;
    document.getElementById('btnTabHSB').classList.toggle('active', tab === 'hsb');
    document.getElementById('btnTabHSL').classList.toggle('active', tab === 'hsl');
    renderPicker(true, false);
}
