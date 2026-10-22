import { open } from 'node:fs/promises';

/** Bounded, seek-based ISO BMFF validation; never load the video into memory. */
export async function validateMp4File(filename: string, signal?: AbortSignal): Promise<void> {
  const file = await open(filename, 'r');
  try {
    const length = (await file.stat()).size;
    let boxCount = 0;
    type Box = { type: string; start: number; end: number };
    async function boxes(start: number, end: number): Promise<Box[]> {
      const result: Box[] = [];
      while (start < end) {
        signal?.throwIfAborted();
        if (++boxCount > 100000 || end - start < 8) throw new Error('Invalid MP4 box layout');
        const header = Buffer.alloc(16);
        const { bytesRead } = await file.read(header, 0, Math.min(16, end - start), start);
        if (bytesRead < 8) throw new Error('Truncated MP4 header');
        let size = header.readUInt32BE(0);
        let headerSize = 8;
        if (size === 1) {
          if (bytesRead < 16) throw new Error('Truncated MP4 extended header');
          const extended = header.readBigUInt64BE(8);
          if (extended > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Invalid MP4 box size');
          size = Number(extended); headerSize = 16;
        } else if (size === 0) size = end - start;
        if (size < headerSize || size > end - start) throw new Error('Truncated or invalid MP4 box');
        result.push({ type: header.toString('ascii', 4, 8), start: start + headerSize, end: start + size });
        start += size;
      }
      return result;
    }
    const top = await boxes(0, length);
    const moov = top.find(b => b.type === 'moov');
    if (!top.some(b => b.type === 'ftyp' && b.end - b.start >= 8)
        || !top.some(b => b.type === 'mdat' && b.end > b.start) || !moov) {
      throw new Error('Expected a complete MP4 container (ftyp/moov/mdat)');
    }
    for (const track of (await boxes(moov.start, moov.end)).filter(b => b.type === 'trak')) {
      for (const mdia of (await boxes(track.start, track.end)).filter(b => b.type === 'mdia')) {
        const handler = (await boxes(mdia.start, mdia.end)).find(b => b.type === 'hdlr');
        if (handler && handler.end - handler.start >= 12) {
          const type = Buffer.alloc(4);
          await file.read(type, 0, 4, handler.start + 8);
          if (type.toString('ascii') === 'vide') return;
        }
      }
    }
    throw new Error('MP4 has no video track');
  } finally { await file.close(); }
}
