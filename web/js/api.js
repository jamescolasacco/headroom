// HTTP API helpers (pairing, health checks, file transfer). Bearer tokens go in headers, never URLs.

export function normalizeUrl(input) {
  let s = (input || '').trim();
  if (!s) throw new Error('Enter the computer\'s address.');
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  const u = new URL(s);
  if (u.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) {
    // The plain-HTTP port only serves certificate setup; the app lives on HTTPS.
    u.protocol = 'https:';
    if (u.port === '7080') u.port = '7443';
  }
  // The host serves HTTPS on 7443 (including its Tailscale *.ts.net certificate).
  if (!u.port && u.protocol === 'https:') u.port = '7443';
  return u.origin;
}

async function json(resp) {
  let body = null;
  try { body = await resp.json(); } catch { /* empty */ }
  if (!resp.ok) {
    const err = new Error(body?.message || body?.error || `HTTP ${resp.status}`);
    err.status = resp.status;
    err.body = body;
    throw err;
  }
  return body;
}

export async function getInfo(url, { timeout = 6000 } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    return await json(await fetch(`${url}/api/info`, { signal: ctl.signal, cache: 'no-store' }));
  } catch (e) {
    if (e.name === 'AbortError' || e instanceof TypeError) {
      const err = new Error('Can\'t reach this computer. Check the address, that Headroom is running, and that this device trusts its certificate.');
      err.unreachable = true;
      throw err;
    }
    throw e;
  } finally { clearTimeout(t); }
}

export async function pair(url, { password, code, totp, deviceName }) {
  const resp = await fetch(`${url}/api/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password, code, totp, deviceName }),
  });
  return json(resp);
}

/** Returns 'online' | 'unauthorized' | 'offline'. */
export async function checkHost(host) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 4000);
  try {
    const r = await fetch(`${host.url}/api/me`, { headers: { Authorization: `Bearer ${host.token}` }, signal: ctl.signal, cache: 'no-store' });
    if (r.status === 401) return 'unauthorized';
    return r.ok ? 'online' : 'offline';
  } catch { return 'offline'; } finally { clearTimeout(t); }
}

export async function listFiles(host, path) {
  const r = await fetch(`${host.url}/api/files/list?path=${encodeURIComponent(path || '')}`, {
    headers: { Authorization: `Bearer ${host.token}` }, cache: 'no-store',
  });
  return json(r);
}

/** Upload with progress (fetch has no upload progress). Resolves with the saved path. */
export function uploadFile(host, file, dir, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const q = `dir=${encodeURIComponent(dir || '')}&name=${encodeURIComponent(file.name)}`;
    xhr.open('POST', `${host.url}/api/files/upload?${q}`);
    xhr.setRequestHeader('Authorization', `Bearer ${host.token}`);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = e => e.lengthComputable && onProgress?.(e.loaded / e.total);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try { resolve(JSON.parse(xhr.responseText)); } catch { resolve({}); }
      } else reject(new Error(`Upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error('Upload failed (network)'));
    xhr.send(file);
  });
}
