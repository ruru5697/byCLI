/** Keep downloaded title stems within filesystem byte limits, including CJK. */
export function outputFilenameStem(value, fallback, maxBytes = 180) {
  const clean = String(value || fallback).replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim() || fallback;
  let stem = '';
  let bytes = 0;
  for (const character of clean) {
    const size = Buffer.byteLength(character, 'utf8');
    if (bytes + size > maxBytes) break;
    stem += character;
    bytes += size;
  }
  return stem || fallback;
}
