/* fileName: app-init.js */

document.addEventListener('DOMContentLoaded', () => {

    const appVersion = window.VERSION == null ? '' : String(window.VERSION).trim();
    const appVersionDetails = window.VERSION_DETAILS || {};

    document.querySelectorAll('[data-app-version]').forEach((el) => {

        const appVersionText = el.querySelector('[data-app-version-text]');

        if (appVersionText) {

            appVersionText.textContent = appVersion;

        } else {

            el.textContent = appVersion;

        }

        el.hidden = !appVersion;

    });

    document.querySelectorAll('[data-version-detail]').forEach((el) => {

        const detailKey = el.getAttribute('data-version-detail');

        el.textContent = appVersionDetails[detailKey] || appVersion;

    });

    const versionTrigger = $('appVersion');
    const versionOverlay = $('versionOverlay');
    const versionCloseBtn = $('versionCloseBtn');
    const versionDialog = $('versionDialog');

    const closeVersionDialog = (returnFocus = true) => {

        if (!versionOverlay || versionOverlay.hidden) return;

        versionOverlay.hidden = true;

        if (versionTrigger) versionTrigger.setAttribute('aria-expanded', 'false');

        if (returnFocus && versionTrigger) versionTrigger.focus();

    };

    const openVersionDialog = () => {

        if (!versionOverlay || !versionTrigger || !appVersion) return;

        versionOverlay.hidden = false;

        versionTrigger.setAttribute('aria-expanded', 'true');

        if (versionCloseBtn) versionCloseBtn.focus();

    };

    if (versionTrigger && versionOverlay && versionDialog) {

        versionTrigger.addEventListener('click', openVersionDialog);

        if (versionCloseBtn) versionCloseBtn.addEventListener('click', () => closeVersionDialog());

        versionOverlay.addEventListener('pointerdown', (e) => {

            if (e.target === versionOverlay) closeVersionDialog();

        });

        document.addEventListener('keydown', (e) => {

            if (e.key === 'Escape') closeVersionDialog(false);

        });

    }

    const aboutTrigger = $('btnAbout');
    const aboutOverlay = $('aboutOverlay');
    const aboutDialog = $('aboutDialog');
    const aboutCloseBtn = $('aboutCloseBtn');
    const aboutDismissBtn = $('aboutDismissBtn');

    const closeAboutDialog = (returnFocus = true) => {

        if (!aboutOverlay || aboutOverlay.hidden) return;

        aboutOverlay.hidden = true;

        if (aboutTrigger) aboutTrigger.setAttribute('aria-expanded', 'false');

        if (returnFocus && aboutTrigger) aboutTrigger.focus();

    };

    const openAboutDialog = () => {

        if (!aboutOverlay || !aboutTrigger) return;

        aboutOverlay.hidden = false;

        aboutTrigger.setAttribute('aria-expanded', 'true');

        if (aboutCloseBtn) aboutCloseBtn.focus();

    };

    if (aboutTrigger && aboutOverlay && aboutDialog) {

        aboutTrigger.addEventListener('click', openAboutDialog);

        if (aboutCloseBtn) aboutCloseBtn.addEventListener('click', () => closeAboutDialog());

        if (aboutDismissBtn) aboutDismissBtn.addEventListener('click', () => closeAboutDialog());

        aboutOverlay.addEventListener('pointerdown', (e) => {

            if (e.target === aboutOverlay) closeAboutDialog();

        });

    }

    const svgUseCurrentColor = $('svgUseCurrentColor');

    if (svgUseCurrentColor) {

        svgUseCurrentColor.checked = false;

        useCurrentColorExport = false;

    }

    const svgMinify = $('svgMinify');

    if (svgMinify) {

        svgMinify.checked = false;

        minifySvgExport = false;

    }

    const svgResponsive = $('svgResponsive');

    if (svgResponsive) {

        svgResponsive.checked = false;

        responsiveSvgExport = false;

    }

    const svgDecimals = $('svgDecimals');

    if (svgDecimals) {

        svgDecimals.value = 3;

        svgExportPrecision = 3;

    }

    

    if (localStorage.getItem('pf_pngHoldRes') === 'true') {

        const holdCb = $('pngHoldRes');

        if (holdCb) holdCb.checked = true;

    }

    // Layer selection: clicking a layer row selects that card. Selection persists while
    // interacting inside any layer card, the canvas preview, the Appearance panel and its
    // stroke-preset dropdown (their controls ACT on the current selection, so pressing one
    // must not clear it first), the layers scrollbar, or the layers toolbar (same reason:
    // Delete/Duplicate act on the selection); clicking anywhere else clears it.
    document.addEventListener('pointerdown', (e) => {

        const header = e.target.closest('.layer-title-row');

        if (header) {

            // Only the eye and an in-progress rename field act without selecting; everywhere
            // else on the row (where the grab cursor shows) still selects / drags the card.
            if (e.target.closest('.layer-toggle, .layer-title-input')) return;

            const item = header.closest('.layer-item');

            if (item) window.selectLayer(item.getAttribute('data-pf-index'), e);

            return;

        }

        if (e.target.closest('.layer-item') || e.target.closest('.preview-box') || e.target.closest('.panel-properties') || e.target.closest('.panel-appearance') || e.target.closest('.stroke-dropdown') || e.target.closest('.panel-layers .custom-scroll-track') || e.target.closest('.panel-resizer') || e.target.closest('.layers-toolbar')) return;

        window.clearLayerSelection();

    });

    // Layer drag-to-reorder (z-order) — delegated pointer handling on the layers list.
    if (window.initLayerDnD) window.initLayerDnD();

});
