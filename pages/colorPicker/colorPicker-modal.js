/* fileName: colorPicker-modal.js */

const cpHeader = document.querySelector('.cp-modal-header');
let isDraggingModal = false, dragStartX, dragStartY, modalStartLeft, modalStartTop;

const clampModalPosition = (left, top) => {
    const maxL = Math.max(0, window.innerWidth - cpModal.offsetWidth);
    const maxT = Math.max(0, window.innerHeight - cpModal.offsetHeight);
    return {
        left: Math.max(0, Math.min(left, maxL)),
        top: Math.max(0, Math.min(top, maxT))
    };
};

const setModalPosition = (left, top) => {
    const pos = clampModalPosition(left, top);
    cpModal.style.position = 'absolute';
    cpModal.style.left = pos.left + 'px';
    cpModal.style.top = pos.top + 'px';
    cpModal.style.margin = '0';
    return pos;
};

const centerModalOnOpen = () => {
    cpModal.style.position = '';
    cpModal.style.left = '';
    cpModal.style.top = '';
    cpModal.style.margin = '';
};

const resetModalPositionMemory = () => {
    cpLastModalPosition = null;
};

const applyModalPositionMemory = () => {
    if (!cpLastModalPosition) {
        centerModalOnOpen();
        return;
    }
    cpLastModalPosition = setModalPosition(cpLastModalPosition.left, cpLastModalPosition.top);
};

const rememberModalPosition = () => {
    const rect = cpModal.getBoundingClientRect();
    cpLastModalPosition = clampModalPosition(rect.left, rect.top);
};

cpHeader.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.cp-modal-close') || e.target.closest('.cp-fill-mode-bar')) return;
    isDraggingModal = true;
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    
    const rect = cpModal.getBoundingClientRect();
    cpLastModalPosition = setModalPosition(rect.left, rect.top);
    
    modalStartLeft = rect.left;
    modalStartTop = rect.top;
    cpHeader.setPointerCapture(e.pointerId);
    broadcastState();
});

cpHeader.addEventListener('pointermove', (e) => {
    if (!isDraggingModal) return;
    let newL = modalStartLeft + (e.clientX - dragStartX);
    let newT = modalStartTop + (e.clientY - dragStartY);

    cpLastModalPosition = setModalPosition(newL, newT);
    broadcastState();
});

const stopModalDrag = (e) => {
    if (isDraggingModal) {
        isDraggingModal = false;
        rememberModalPosition();
        cpHeader.releasePointerCapture(e.pointerId);
        broadcastState();
    }
};
cpHeader.addEventListener('pointerup', stopModalDrag);
cpHeader.addEventListener('pointercancel', stopModalDrag);

window.addEventListener('resize', () => {
    if (document.getElementById('cpModalOverlay').style.display === 'none') return;
    if (cpModal.style.position !== 'absolute') return;
    const rect = cpModal.getBoundingClientRect();
    cpLastModalPosition = setModalPosition(rect.left, rect.top);
    broadcastState();
});
