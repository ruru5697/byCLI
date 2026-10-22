import { describe, expect, it } from 'vitest';
import { outputFilenameStem } from './output-filename.js';

describe('download filename byte limits', () => {
  it.each(['中文标题'.repeat(80), '🙂'.repeat(100), 'a'.repeat(400)])('reserves room for identifiers and extensions', title => {
    const stem = outputFilenameStem(title, 'download');
    expect(Buffer.byteLength(`${stem}-1234567890123456.mp4`)).toBeLessThanOrEqual(255);
    expect(stem).not.toContain('\uFFFD');
  });
  it('removes path separators and falls back for empty titles', () => {
    expect(outputFilenameStem('a/b:c', 'download')).toBe('a_b_c');
    expect(outputFilenameStem('   ', 'download')).toBe('download');
  });
});
