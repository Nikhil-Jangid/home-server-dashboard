// Classic (non-module) script: sets the default theme before first paint. Themes last one visit, so
// nothing is read from storage; js/themes.js switches it after load.
document.documentElement.setAttribute('data-theme', 'midnight');
