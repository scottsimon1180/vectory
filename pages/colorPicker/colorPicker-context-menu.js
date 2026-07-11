/* fileName: colorPicker-context-menu.js */

function showContextMenu(element, index, type) {
    deleteTargetIndex = index;
    deleteTargetType = type;
    const rect = element.getBoundingClientRect();
    contextMenu.style.display = 'flex';
    
    requestAnimationFrame(() => {
        const menuRect = contextMenu.getBoundingClientRect();
        let posX = rect.left + (rect.width / 2) - (menuRect.width / 2);
        let posY = rect.top - menuRect.height - 8;
        if (posY < 10) posY = rect.bottom + 8;
        posX = Math.max(8, Math.min(posX, window.innerWidth - menuRect.width - 8));
        posY = Math.max(8, Math.min(posY, window.innerHeight - menuRect.height - 8));
        contextMenu.style.left = posX + 'px';
        contextMenu.style.top = posY + 'px';
        contextMenu.classList.add('active');
        broadcastState();
    });
}

function hideContextMenu() {
    if (!contextMenu.classList.contains('active')) return;
    contextMenu.classList.remove('active');
    setTimeout(() => { if(!contextMenu.classList.contains('active')) contextMenu.style.display = 'none'; }, 150); 
    broadcastState();
}

document.addEventListener('pointerdown', (e) => {
    if (contextMenu.classList.contains('active') && !contextMenu.contains(e.target)) hideContextMenu();
});

function executeDelete() {
    if (deleteTargetIndex !== null) {
        if (deleteTargetType === 'bank') {
            savedBank.splice(deleteTargetIndex, 1);
            try { localStorage.setItem('pixelForgeSavedColors', JSON.stringify(savedBank)); } catch(e){}
            renderSavedBank();
        } else if (deleteTargetType === 'gradStop') {
            gradStops.splice(deleteTargetIndex, 1);
            if (activeStopIdx >= gradStops.length) activeStopIdx = gradStops.length - 1;
            cpAlpha = gradStops[activeStopIdx].op;
            renderGradRows();
            performGradientUpdate(false);
            Object.assign(cpState, hexToHsb(gradStops[activeStopIdx].hex));
            renderPicker(true, false);
        }
        hideContextMenu(); 
        deleteTargetIndex = null; 
    }
}
