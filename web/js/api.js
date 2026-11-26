// File transfer with a device. Bearer tokens go in headers, never URLs.

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

export async function listFiles(host, path) {
  const r = await fetch(`${host.url}/api/files/list?path=${encodeURIComponent(path || '')}`, {
    headers: { Authorization: `Bearer ${host.token}` }, cache: 'no-store',
  });
  return json(r);
}

/** Why the computer didn't keep an upload, in words (both hosts answer with the same statuses). */
export function uploadError(status, body) {
  if (status === 0) return 'the connection was lost';
  if (status === 401) return 'this session no longer has access';
  if (status === 403) return /transfer/.test(body?.error || '') ? 'file transfer isn\'t allowed' : 'that folder can\'t be written to';
  if (status === 503) return 'Headroom Server is stopped';
  return `the computer answered ${status}`;
}

/**
 * Upload with progress (fetch has no upload progress). Resolves with the saved file's {path, name}; `signal` stops
 * it (an AbortError), and the computer then keeps nothing of it.
 */
export function uploadFile(host, file, dir, onProgress, signal) {
  return new Promise((resolve, reject) => {
    const stopped = () => reject(new DOMException('Upload stopped', 'AbortError'));
    if (signal?.aborted) { stopped(); return; }
    const xhr = new XMLHttpRequest();
    const q = `dir=${encodeURIComponent(dir || '')}&name=${encodeURIComponent(file.name)}`;
    xhr.open('POST', `${host.url}/api/files/upload?${q}`);
    xhr.setRequestHeader('Authorization', `Bearer ${host.token}`);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = e => e.lengthComputable && onProgress?.(e.loaded / e.total);
    const abort = () => xhr.abort();
    signal?.addEventListener('abort', abort, { once: true });
    xhr.onloadend = () => signal?.removeEventListener('abort', abort);
    xhr.onload = () => {
      let body = null;
      try { body = JSON.parse(xhr.responseText); } catch { /* not JSON */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(body || {});
      else reject(new Error(uploadError(xhr.status, body)));
    };
    xhr.onerror = () => reject(new Error(uploadError(0)));
    xhr.onabort = stopped;
    xhr.send(file);
  });
}
