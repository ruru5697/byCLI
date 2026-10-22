import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { exportCookiesToNetscape, formatCookieHeader, httpDownload, resolveRedirectUrl } from './index.js';

const servers: http.Server[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(servers.map((server) => new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  })));
  servers.length = 0;
  for (const dir of tempDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  tempDirs.length = 0;
});

async function startServer(handler: http.RequestListener, hostname = '127.0.0.1'): Promise<string> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, hostname, resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to start test server');
  }
  return `http://${hostname}:${address.port}`;
}

// Windows Defender can briefly lock newly-written .tmp files, causing EPERM.
// Retry once to handle this flakiness.
describe('download helpers', { retry: process.platform === 'win32' ? 2 : 0 }, () => {
  it('resolves relative redirects against the original URL', () => {
    expect(resolveRedirectUrl('https://example.com/a/file', '/cdn/file.bin')).toBe('https://example.com/cdn/file.bin');
    expect(resolveRedirectUrl('https://example.com/a/file', '../next')).toBe('https://example.com/next');
  });

  it('formats browser cookies into a Cookie header', () => {
    expect(formatCookieHeader([
      { name: 'sid', value: 'abc', domain: 'example.com' },
      { name: 'ct0', value: 'def', domain: 'example.com' },
    ])).toBe('sid=abc; ct0=def');
  });

  it('fails after exceeding the redirect limit', async () => {
    const baseUrl = await startServer((_req, res) => {
      res.statusCode = 302;
      res.setHeader('Location', '/loop');
      res.end();
    });

    const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bycli-dl-'));
    tempDirs.push(tempDir);
    const destPath = path.join(tempDir, 'file.txt');
    const result = await httpDownload(`${baseUrl}/loop`, destPath, { maxRedirects: 2 });

    expect(result).toEqual({
      success: false,
      size: 0,
      error: 'Too many redirects (> 2)',
    });
    expect(fs.existsSync(destPath)).toBe(false);
  });

  it('does not forward cookies across cross-domain redirects', async () => {
    let forwardedCookie: string | undefined;
    const targetUrl = await startServer((req, res) => {
      forwardedCookie = req.headers.cookie;
      res.statusCode = 200;
      res.end('ok');
    }, 'localhost');

    const redirectUrl = await startServer((_req, res) => {
      res.statusCode = 302;
      res.setHeader('Location', targetUrl);
      res.end();
    });

    const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bycli-dl-'));
    tempDirs.push(tempDir);
    const destPath = path.join(tempDir, 'redirect.txt');
    const result = await httpDownload(`${redirectUrl}/start`, destPath, { cookies: 'sid=abc' });

    expect(result).toEqual({ success: true, size: 2 });
    expect(forwardedCookie).toBeUndefined();
    expect(fs.readFileSync(destPath, 'utf8')).toBe('ok');
  });

  it('does not forward cookie headers across cross-domain redirects', async () => {
    let forwardedCookie: string | undefined;
    const targetUrl = await startServer((req, res) => {
      forwardedCookie = req.headers.cookie;
      res.statusCode = 200;
      res.end('ok');
    }, 'localhost');

    const redirectUrl = await startServer((_req, res) => {
      res.statusCode = 302;
      res.setHeader('Location', targetUrl);
      res.end();
    });

    const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bycli-dl-'));
    tempDirs.push(tempDir);
    const destPath = path.join(tempDir, 'redirect-header.txt');
    const result = await httpDownload(`${redirectUrl}/start`, destPath, {
      headers: { Cookie: 'sid=header-cookie' },
    });

    expect(result).toEqual({ success: true, size: 2 });
    expect(forwardedCookie).toBeUndefined();
    expect(fs.readFileSync(destPath, 'utf8')).toBe('ok');
  });

  it('keeps legacy document downloads while media validation rejects the same response', async () => {
    const baseUrl = await startServer((_req, res) => {
      res.setHeader('Content-Type', 'text/html');
      res.end('<html>document</html>');
    });
    const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bycli-dl-'));
    tempDirs.push(tempDir);
    const legacyPath = path.join(tempDir, 'page.html');
    const mediaPath = path.join(tempDir, 'video.mp4');
    expect(await httpDownload(baseUrl, legacyPath)).toMatchObject({ success: true, size: 21 });
    expect(fs.readFileSync(legacyPath, 'utf8')).toBe('<html>document</html>');
    expect(await httpDownload(baseUrl, mediaPath, { validateMedia: true })).toMatchObject({ success: false, size: 0 });
    expect(fs.existsSync(mediaPath)).toBe(false);
    expect(fs.existsSync(mediaPath + '.tmp')).toBe(false);
  });

  it.each([
    ['application/vnd.apple.mpegurl', '#EXTM3U\n#EXTINF:1,\nvideo.ts'],
    ['video/mp4', '#EXTM3U\nvideo.ts'],
    ['application/dash+xml', '<MPD></MPD>'],
  ])('rejects a playlist served as %s without replacing the destination', async (type, body) => {
    const baseUrl = await startServer((_req, res) => { res.setHeader('Content-Type', type); res.end(body); });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bycli-playlist-')); tempDirs.push(dir);
    const dest = path.join(dir, 'saved.mp4'); fs.writeFileSync(dest, 'previous');
    const result = await httpDownload(baseUrl, dest, { validateMedia: true });
    expect(result).toMatchObject({ success: false, error: expect.stringContaining('playlist') });
    expect(fs.readFileSync(dest, 'utf8')).toBe('previous');
    expect(fs.readdirSync(dir)).toEqual(['saved.mp4']);
  });

  it('times out after headers while streaming, cleans up and preserves the old destination', async () => {
    const baseUrl = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'video/mp4' }); res.write('prefix');
      const timer = setTimeout(() => res.end('late body'), 1000);
      res.on('close', () => clearTimeout(timer));
    });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bycli-timeout-')); tempDirs.push(dir);
    const dest = path.join(dir, 'saved.mp4'); fs.writeFileSync(dest, 'previous');
    const start = Date.now();
    expect(await httpDownload(baseUrl, dest, { timeout: 100 })).toMatchObject({ success: false, error: 'Download timed out after 100ms' });
    expect(Date.now() - start).toBeLessThan(900);
    expect(fs.readFileSync(dest, 'utf8')).toBe('previous');
    expect(fs.readdirSync(dir)).toEqual(['saved.mp4']);
  });

  it('uses a single deadline across redirects', async () => {
    const baseUrl = await startServer((req, res) => {
      const timer = setTimeout(() => { res.writeHead(302, { Location: '/' + (Number(req.url?.slice(1) || 0) + 1) }); res.end(); }, 70);
      res.on('close', () => clearTimeout(timer));
    });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bycli-deadline-')); tempDirs.push(dir);
    expect(await httpDownload(baseUrl, path.join(dir, 'out'), { timeout: 180 })).toMatchObject({ success: false, error: 'Download timed out after 180ms' });
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('rejects a truncated transfer and cleans up its partial file', async () => {
    const baseUrl = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Length': '1000' }); res.write('partial');
      setTimeout(() => res.destroy(), 20);
    });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bycli-truncated-')); tempDirs.push(dir);
    expect(await httpDownload(baseUrl, path.join(dir, 'out'))).toMatchObject({ success: false });
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('rejects a fake MP4 even when its content type looks valid', async () => {
    const baseUrl = await startServer((_req, res) => { res.setHeader('Content-Type', 'video/mp4'); res.end('not a video'); });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bycli-mp4-')); tempDirs.push(dir);
    expect(await httpDownload(baseUrl, path.join(dir, 'out.mp4'), { expectedMedia: 'mp4' })).toMatchObject({ success: false });
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('does not let a concurrent failed transfer remove a successful file', async () => {
    const baseUrl = await startServer((req, res) => {
      if (req.url === '/good') { res.end('valid data'); return; }
      res.setHeader('Content-Type', 'video/mp4'); res.write('prefix');
      const timer = setTimeout(() => res.end('not an mp4'), 100);
      res.on('close', () => clearTimeout(timer));
    });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bycli-concurrent-')); tempDirs.push(dir);
    const dest = path.join(dir, 'saved.mp4');
    const [failed, good] = await Promise.all([
      httpDownload(baseUrl + '/bad', dest, { expectedMedia: 'mp4' }),
      httpDownload(baseUrl + '/good', dest),
    ]);
    expect(failed.success).toBe(false); expect(good.success).toBe(true);
    expect(fs.readFileSync(dest, 'utf8')).toBe('valid data');
    expect(fs.readdirSync(dir)).toEqual(['saved.mp4']);
  });

  it('strips authorization on a different origin even when the hostname is the same', async () => {
    let authorization: string | undefined;
    const target = await startServer((req, res) => { authorization = req.headers.authorization; res.end('ok'); });
    const source = await startServer((_req, res) => { res.writeHead(302, { Location: target }); res.end(); });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bycli-origin-')); tempDirs.push(dir);
    expect(await httpDownload(source, path.join(dir, 'out'), { headers: { Authorization: 'Bearer synthetic' } })).toMatchObject({ success: true });
    expect(authorization).toBeUndefined();
  });

  it('bypasses proxy settings for loopback downloads', async () => {
    vi.stubEnv('HTTP_PROXY', 'http://127.0.0.1:9');

    const baseUrl = await startServer((_req, res) => {
      res.statusCode = 200;
      res.end('ok');
    });

    const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bycli-dl-'));
    tempDirs.push(tempDir);
    const destPath = path.join(tempDir, 'loopback.txt');
    const result = await httpDownload(`${baseUrl}/ok`, destPath);

    expect(result).toEqual({ success: true, size: 2 });
    expect(fs.readFileSync(destPath, 'utf8')).toBe('ok');
  });

  it.skipIf(process.platform === 'win32')('writes the Netscape cookie file with 0o600 owner-only permissions', async () => {
    const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bycli-dl-'));
    tempDirs.push(tempDir);
    const cookiesPath = path.join(tempDir, 'cookies.txt');

    exportCookiesToNetscape([
      { name: 'sid', value: 'secret', domain: 'example.com' },
    ], cookiesPath);

    const mode = fs.statSync(cookiesPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it.skipIf(process.platform === 'win32')('tightens an existing Netscape cookie file before rewriting it', async () => {
    const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bycli-dl-'));
    tempDirs.push(tempDir);
    const cookiesPath = path.join(tempDir, 'cookies.txt');
    fs.writeFileSync(cookiesPath, 'stale-cookie', { mode: 0o644 });

    exportCookiesToNetscape([
      { name: 'sid', value: 'secret', domain: 'example.com' },
    ], cookiesPath);

    const mode = fs.statSync(cookiesPath).mode & 0o777;
    expect(mode).toBe(0o600);
    expect(fs.readFileSync(cookiesPath, 'utf8')).toContain('sid\tsecret');
  });
});
