/* fileName: colorPicker-state.js */

const cpModal = document.getElementById('cpModalContainer');
const contextMenu = document.getElementById('cpContextMenu');

let cpFillMode = 'solid'; // 'solid' or 'gradient'
let gradRightTab = 'sliders'; // 'sliders', 'wheel', 'spectrum'

// Gradient State
let gradType = 'linear'; // 'linear' or 'angular'
let gradAngle = 0;
let gradStops = []; // Array of { hex: '#rrggbb', op: 100 }
let activeStopIdx = 0;
let deleteTargetType = null; // 'bank' or 'gradStop'

let isEyedropperActive = false;
let cpLastModalPosition = null;

let cpMode = 'wheel', cpTab = 'hsb', cpState = { h: 0, s: 100, b: 100 };
let cpAlpha = 100;
let deleteTargetIndex = null, renderRaf = null, lastSentHex = null, lastSentAlpha = null;
let activeTopSliders = {}, activeRgbSliders = {}, activeAlphaSlider = {};

const cpMainWrap = document.getElementById('cpMainWrap');
const cpMainArea = document.getElementById('cpMainArea');
const cpMainDarken = document.getElementById('cpMainDarken');
const cpTrackArea = document.getElementById('cpTrackArea');
