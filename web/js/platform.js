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
