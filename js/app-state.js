/* fileName: app-state.js */

const $ = id => document.getElementById(id);
const PREVIEW_SVG_SELECTOR = ':scope > svg:not(.icon-svg):not(.canvas-overlay)';

const cpIframe = $('cpIframe'), fileInput = $('fileInput'), layerFileInput = $('layerFileInput'), inputStr = $('inputStr'), outputStr = $('outputStr');

const previewArea = $('previewArea'), artboardOverlay = $('artboardOverlay'), selectionOverlay = $('selectionOverlay'), directSelectionOverlay = $('directSelectionOverlay'), rulerH = $('rulerH'), rulerV = $('rulerV'), rulerCorner = $('rulerCorner'), guideOverlay = $('guideOverlay'), layersList = $('layersList'), layersWrap = $('layersWrap'), btnImportLayer = $('btnImportLayer'), btnPasteLayer = $('btnPasteLayer'), btnDuplicateLayer = $('btnDuplicateLayer'), btnDeleteLayer = $('btnDeleteLayer');



let cpActiveCallback = null, cpInitialData = null, cpInitialOpacity = null;

let globalOptimizedSvg = null, globalOriginalSvg = null, useCurrentColorExport = false, minifySvgExport = false, responsiveSvgExport = false, svgExportPrecision = 3;

// Illustrator-style scale options (global, default OFF). When false, a scale gesture holds the
// attribute visually fixed (stroke weight / corner radii); when true it scales with the shape.
let scaleStrokesEffects = false, scaleCorners = false;
// Artboard-tool option (default OFF): resizing the artboard also scales its contents to match.
let scaleContentsWithArtboard = false;

let viewScale = 1, viewPanX = 0, viewPanY = 0;

let selectedLayerIndex = new Set();
let lastClickedLayerIndex = null;

// Per-layer visibility + lock, keyed by data-pf-index (string). These are UI-only and live
// OUTSIDE globalOptimizedSvg on purpose: a toggle re-renders but leaves the serialized model
// unchanged, so history dedups it (no entry) and undo/redo can't revert hide/lock. Cleared on
// new document (indices restart); they survive undo/redo restores. See docs/layers-panel.md.
let hiddenLayers = new Set();
let lockedLayers = new Set();

let editSelectedIndex = null;   // Properties/transform-engine selection — driven ONLY by the Selection tool
// Multi-selection mirror of editSelectedIndex. Invariant: editSelectedIndex is non-null iff exactly
// ONE object is selected (and equals that index); with 2+ selected it is null and only this Set is
// populated, so every single-shape consumer becomes a safe no-op under multi.
let editSelectedIndices = new Set();

// Drawing defaults: the fill / stroke / stroke-width new Shape- and Pen-tool shapes are
// born with. Edited in the Appearance panel while nothing is selected (js/layers.js);
// session-only, never persisted. A null width means "auto" -- the artboard-relative
// default from js/shape-tools.js.
let apDrawFill = 'none', apDrawStroke = '#000000', apDrawStrokeWidth = null;

let isEyedropperMode = false;

let isWorkspaceResizing = false;

let cpRects = [], cpIsDragging = false, lastMouseX = 0, lastMouseY = 0;
let cpShouldResetPosition = false;

let currentPngBg = 'transparent';

const ctxHelper = document.createElement('canvas').getContext('2d');

