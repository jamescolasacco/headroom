// Feature/platform detection. Never trust the UA for features (Safari 26 freezes it); only use it for
// keyboard conventions (Mac vs PC), where there's no feature to detect.

const ua = navigator.userAgent;
const touchPoints = navigator.maxTouchPoints || 0;

/** iPadOS in desktop mode reports "Macintosh"; touch points give it away. */
export const isIPad = /iPad/.test(ua) || (/Macintosh/.test(ua) && touchPoints > 1);
export const isIPhone = /iPhone|iPod/.test(ua);
export const isIOS = isIPad || isIPhone;
export const isAndroid = /Android/.test(ua);
export const isMac = !isIOS && /Macintosh|Mac OS X/.test(ua);
export const isWindows = /Windows/.test(ua);
/** Apple keyboard conventions (Cmd key). */
export const isApple = isMac || isIOS;
export const isWebKit = isIOS || (/AppleWebKit/.test(ua) && !/Chrome|Chromium|Edg\//.test(ua));
export const isTouchPrimary = matchMedia('(pointer: coarse)').matches || isIOS || isAndroid;
export const isStandalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
export const hasKeyboardLock = !!(navigator.keyboard && navigator.keyboard.lock);
export const hasWebCodecs = typeof VideoDecoder !== 'undefined';
export const hasAudioDecoder = typeof AudioDecoder !== 'undefined';
export const secure = window.isSecureContext;

/**
 * Message bridge to a native shell: WebView2 on Windows (chrome.webview), WKWebView on macOS
 * (webkit.messageHandlers.headroom, with replies dispatched as 'headroom-native' events). Null in a browser.
 */
export const bridge = (() => {
  const wv2 = window.chrome?.webview;
  if (wv2) {
    return {
      post: msg => wv2.postMessage(msg),
      on: handler => {
        const fn = e => handler(e.data);
        wv2.addEventListener('message', fn);
        return () => wv2.removeEventListener('message', fn);
      },
    };
  }
  const wk = window.webkit?.messageHandlers?.headroom;
  if (wk) {
    return {
      post: msg => wk.postMessage(msg),
      on: handler => {
        const fn = e => handler(e.detail);
        window.addEventListener('headroom-native', fn);
        return () => window.removeEventListener('headroom-native', fn);
      },
    };
  }
  return null;
})();

/** Running inside Headroom Viewer (Windows WebView2 or Mac WKWebView shell serving the bundled client). */
export const nativeViewer = !!bridge && location.hostname === 'app.headroom.local';

export function postNative(msg) {
  if (nativeViewer) bridge.post(msg);
}

export function onNative(handler) {
  if (!nativeViewer) return () => { };
  return bridge.on(handler);
}

export function deviceLabel() {
  if (isIPad) return 'iPad';
  if (isIPhone) return 'iPhone';
  if (isAndroid) return 'Android';
  if (isMac) return 'Mac';
  if (isWindows) return 'Windows PC';
  return 'Browser';
}

export function platformId() {
  if (isIPad) return 'ipados';
  if (isIPhone) return 'ios';
  if (isAndroid) return 'android';
  if (isMac) return 'macos';
  if (isWindows) return 'windows';
  return 'other';
}

export function canFullscreen() {
  const el = document.documentElement;
  return !!(el.requestFullscreen || el.webkitRequestFullscreen) && !isIPhone && !isStandalone;
}
