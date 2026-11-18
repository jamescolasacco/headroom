// Every computer has its own light: the colour its screen glows in Headroom. The website, the session toolbar and
// the computer's own Headroom Server window all pick it from the computer's id (FNV-1a), so it never changes and
// is the same everywhere. The colours themselves are in app.css ([data-light]).
export const LIGHTS = 5;

/** The light (0…LIGHTS-1) of the computer with this id (its host id; a name will do when there's no id). */
export function lightOf(key) {
  let h = 0x811c9dc5;
  for (const ch of String(key || '')) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % LIGHTS;
}
