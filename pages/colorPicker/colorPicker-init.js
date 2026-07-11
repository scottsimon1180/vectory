/* fileName: colorPicker-init.js */

const isIPadOS = (/iPad/i.test(navigator.userAgent)) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
if (isIPadOS) document.body.classList.add('is-ipad-os');

document.getElementById('tbGradType').innerHTML = SVG_LINEAR;

initPresets();
renderSavedBank(); 
