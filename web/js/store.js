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
  maxFps: 60,
  maxBitrateKbps: 0,        // 0 = host maximum (adaptive)
  resolution: 'native',     // native | 1080 | 720 | device
  audio: true,
  stats: false,
  renderer: 'auto',         // auto | video | canvas
  pointerSpeed: 1.0,
  naturalScroll: true,
};

export function loadPrefs(hostId) {
  const all = read(PREFS_KEY, {});
  return { ...DEFAULT_PREFS, ...(all.global || {}), ...(hostId ? all[hostId] || {} : {}) };
}

export function savePrefs(hostId, patch) {
  const all = read(PREFS_KEY, {});
  all[hostId] = { ...(all[hostId] || {}), ...patch };
  write(PREFS_KEY, all);
}
