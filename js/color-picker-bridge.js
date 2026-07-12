/* fileName: color-picker-bridge.js */

window.openCustomPicker = (initialData, isGradient, callback, opacity) => {

    cpActiveCallback = callback; cpInitialData = initialData; cpInitialOpacity = opacity;

    cpIframe.style.pointerEvents = 'auto';

    cpIframe.contentWindow.postMessage({ action: 'open', data: initialData, isGradient: isGradient, opacity: opacity, resetPosition: cpShouldResetPosition }, '*');
    cpShouldResetPosition = false;

};



// ==========================================

// Dynamic Click-Through Tracking Engine

// ==========================================

const checkIframePointer = (x, y) => {

    if (!cpActiveCallback && !isEyedropperMode && cpRects.length === 0) return;

    

    if (cpIsDragging) {

        cpIframe.style.pointerEvents = 'auto';

        return;

    }

    

    let isOverModal = false;

    for (let i = 0; i < cpRects.length; i++) {

        let r = cpRects[i];

        if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {

            isOverModal = true; break;

        }

    }

    

    cpIframe.style.pointerEvents = isOverModal ? 'auto' : 'none';

};



window.addEventListener('pointermove', e => {

    lastMouseX = e.clientX; lastMouseY = e.clientY;

    checkIframePointer(lastMouseX, lastMouseY);

});



// ==========================================

// Eyedropper Communication Engine

// ==========================================

window.addEventListener('message', e => {

    if (e.source !== cpIframe.contentWindow || !e.data?.action) return;

    const { action, hex, isGradient, gradientData, isScrubbing, state, rects, isDragging, x, y, opacity } = e.data;

    

    if (action === 'cpState') {

        cpRects = rects || [];

        cpIsDragging = !!isDragging;

        checkIframePointer(lastMouseX, lastMouseY);

    } else if (action === 'mouseMove') {

        lastMouseX = x; lastMouseY = y;

        checkIframePointer(lastMouseX, lastMouseY);

    } else if (action === 'update' && cpActiveCallback) {

        cpActiveCallback(isGradient ? gradientData : hex, isScrubbing, isGradient, opacity);

    } else if (action === 'confirm' || action === 'cancel') {

        if (action === 'confirm' && cpActiveCallback) {

            cpActiveCallback(isGradient ? gradientData : hex, false, isGradient, opacity);

        } else if (cpActiveCallback) {

            const wasGrad = cpInitialData && (typeof cpInitialData === 'object' || String(cpInitialData).includes('url'));

            cpActiveCallback(cpInitialData, false, wasGrad, cpInitialOpacity);

        }

        cpIframe.style.pointerEvents = 'none'; cpActiveCallback = cpInitialData = cpInitialOpacity = null;

        isEyedropperMode = false;

        document.body.classList.remove('is-eyedropper-active');

        cpRects = [];

    } else if (action === 'eyedropperToggle') {

        isEyedropperMode = state;

        if (state) {

            document.body.classList.add('is-eyedropper-active');

        } else {

            document.body.classList.remove('is-eyedropper-active');

        }

    }

});



document.addEventListener('keydown', (e) => {

    if (e.key === 'Escape' && isEyedropperMode) {

        isEyedropperMode = false;

        document.body.classList.remove('is-eyedropper-active');

        cpIframe.contentWindow.postMessage({ action: 'eyedropperToggle', state: false }, '*');

    }

});



previewArea.addEventListener('pointerdown', (e) => {

    // If neither eyedropper nor color picker is active, do nothing

    if (!isEyedropperMode && !cpActiveCallback) return;

    

    const target = e.target;

    const tagName = target.tagName.toLowerCase();

    const isValidShape = ['path', 'circle', 'rect', 'polygon', 'polyline', 'ellipse', 'line'].includes(tagName);



    if (isEyedropperMode) {

        e.preventDefault();

        e.stopPropagation();

        

        if (isValidShape) {

            let color = target.getAttribute('fill');

            if (!color || color === 'none') color = target.getAttribute('stroke');

            

            if (color && color !== 'none' && !color.includes('url')) {

                const hexColor = colorToHex(color);

                cpIframe.contentWindow.postMessage({ action: 'eyedropperPicked', hex: hexColor }, '*');

            } else {

                cpIframe.contentWindow.postMessage({ action: 'eyedropperToggle', state: false }, '*');

            }

        } else {

            // Abort dropper if clicked on empty canvas area

            cpIframe.contentWindow.postMessage({ action: 'eyedropperToggle', state: false }, '*');

        }

        

        isEyedropperMode = false;

        document.body.classList.remove('is-eyedropper-active');

        return;

    }



    // Direct color picker switching when open: clicking a shape retargets the picker to
    // that layer through the Paint Panel -- the layer becomes the panel selection and
    // the picker relaunches on its fill (or stroke, when the shape has no fill).

    if (cpActiveCallback && isValidShape) {

        e.preventDefault();

        e.stopPropagation();



        const indexStr = target.getAttribute('data-pf-index');

        if (indexStr !== null) {

            const targetItem = layersList.querySelector(`.layer-item[data-pf-index="${indexStr}"]`);



            if (targetItem) {

                let editStroke = false;

                let color = target.getAttribute('fill');



                if (!color || color === 'none') {

                    color = target.getAttribute('stroke');

                    if (color && color !== 'none') editStroke = true;

                }



                // Scroll the layers list to show the selected layer

                targetItem.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

                // Add a brief highlight effect to the layer item

                targetItem.style.transition = 'background-color 0.2s';

                targetItem.style.backgroundColor = 'var(--bg-hover)';

                setTimeout(() => { targetItem.style.backgroundColor = ''; }, 300);



                window.setLayerSelectionSet?.([indexStr]);

                window.paintOpenPicker?.(editStroke ? 'stroke' : 'fill');

            }

        }

    }

}, { capture: true });

