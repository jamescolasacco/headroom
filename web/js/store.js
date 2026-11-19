// Address book + preferences. localStorage is per-origin and (on iOS) per home-screen app; every
// access is wrapped because private modes can throw.

const HOSTS_KEY = 'headroom.hosts.v1';
const PREFS_KEY = 'headroom.prefs.v1';

function read(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v ? JSON.parse(v) : fallback;
  } catch { return fallback; }
}

function write(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
}

export function loadHosts() { return read(HOSTS_KEY, []); }

export function saveHosts(hosts) { write(HOSTS_KEY, hosts); }

export function upsertHost(host) {
  const hosts = loadHosts();
  const i = hosts.findIndex(h => (host.id && h.id === host.id) || h.url === host.url);
  if (i >= 0) hosts[i] = { ...hosts[i], ...host };
  else hosts.push(host);
  saveHosts(hosts);
  return host;
}

export function removeHost(id) { saveHosts(loadHosts().filter(h => h.id !== id)); }

export function getHost(id) { return loadHosts().find(h => h.id === id); }

export function touchHost(id, patch) {
  const hosts = loadHosts();
  const h = hosts.find(x => x.id === id);
  if (!h) return;
  Object.assign(h, patch);
  saveHosts(hosts);
}

/** Session preferences, stored per host with global defaults. */
export const DEFAULT_PREFS = {
  inputMode: 'auto',        // auto | trackpad | touch
  keyboardProfile: 'auto',  // auto | mac | pc | cmdctrl
  scaling: 'fit',           // fit | actual | fill
  maxFps: 15,               // a quarter of 60's frames to send; the hosts sharpen the picture once it stops moving
  maxBitrateKbps: 0,        // 0 = host maximum (adaptive)
  resolution: 'auto',       // auto (as big as it's shown here: see Session._autoSize) | native | 1440 | 1080 | 720
  audio: true,
  stats: false,
  renderer: 'auto',         // auto | video | canvas
  pointerSpeed: 1.0,
  naturalScroll: true,
  typingHidden: false,      // what you type on a phone's keyboard shows as dots above the keys (saved for every computer)
};

// 15 frames a second became the default (version 2). Frame rates saved before then are let go once, so everyone
// starts there; one picked after that stays.
const PREFS_VERSION_KEY = 'headroom.prefs.version';
function migratePrefs() {
  try {
    if (Number(localStorage.getItem(PREFS_VERSION_KEY) || 1) >= 2) return;
    const all = read(PREFS_KEY, {});
    for (const k of Object.keys(all)) if (all[k] && typeof all[k] === 'object') delete all[k].maxFps;
    write(PREFS_KEY, all);
    localStorage.setItem(PREFS_VERSION_KEY, '2');
  } catch { }
}

export function loadPrefs(hostId) {
  migratePrefs();
  const all = read(PREFS_KEY, {});
  return { ...DEFAULT_PREFS, ...(all.global || {}), ...(hostId ? all[hostId] || {} : {}) };
}

export function savePrefs(hostId, patch) {
  const all = read(PREFS_KEY, {});
  all[hostId] = { ...(all[hostId] || {}), ...patch };
  write(PREFS_KEY, all);
}
