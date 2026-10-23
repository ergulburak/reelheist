// Replaces DevTools detector libraries (disable-devtool, devtools-detector) with no-ops,
// so the page keeps working and does not redirect when DevTools opens.
(function () {
  var noop = function () {};
  var falsy = function () { return false; };
  window.devtoolsDetector = {
    addListener: noop, removeListener: noop, launch: noop, stop: noop,
    isLaunch: falsy, setDetectDelay: noop, crashBrowserCurrentTab: noop, crashBrowser: noop,
  };
  var dd = function () { return { success: false, reason: 'disabled' }; };
  dd.isRunning = false;
  dd.isSuspend = true;
  dd.version = '0.0.0';
  dd.md5 = function () { return ''; };
  dd.isDevToolOpened = falsy;
  dd.close = noop;
  dd.DetectorType = {};
  window.DisableDevtool = dd;
})();
