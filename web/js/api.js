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
