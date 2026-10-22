/**
 * Download utilities: HTTP downloads, yt-dlp wrapper, format conversion.
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { validateMp4File } from './media-validation.js';
export { validateMp4File } from './media-validation.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Readable, Transform } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { pipeline } from 'node:stream/promises';
import { URL } from 'node:url';
import type { ProgressBar } from './progress.js';
import { isBinaryInstalled } from '../external.js';
import type { BrowserCookie } from '../types.js';
import { getErrorMessage } from '../errors.js';
import { fetchWithNodeNetwork } from '../node-network.js';
import { log } from '../logger.js';

export type { BrowserCookie } from '../types.js';

export interface DownloadOptions {
  cookies?: string;
  headers?: Record<string, string>;
  timeout?: number;
  onProgress?: (received: number, total: number) => void;
  maxRedirects?: number;
  /** Reject empty or document responses before replacing the destination. Opt-in for media callers. */
  validateMedia?: boolean;
  /** Require a complete MP4 container with a video track. */
  expectedMedia?: 'mp4';
}

export interface YtdlpOptions {
  cookies?: string;
  cookiesFile?: string;
  format?: string;
  extraArgs?: string[];
  onProgress?: (percent: number) => void;
}

/** Check if yt-dlp is available in PATH. */
export function checkYtdlp(): boolean {
  return isBinaryInstalled('yt-dlp');
}

/** Domains that host video content and can be downloaded via yt-dlp. */
const VIDEO_PLATFORM_DOMAINS = [
  'youtube.com', 'youtu.be', 'bilibili.com', 'twitter.com',
  'x.com', 'tiktok.com', 'vimeo.com', 'twitch.tv',
];

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.ico', '.bmp', '.avif']);
const VIDEO_EXTENSIONS = new Set(['.mp4', '.webm', '.avi', '.mov', '.mkv', '.flv', '.m3u8', '.ts']);
const DOC_EXTENSIONS = new Set(['.html', '.htm', '.json', '.xml', '.txt', '.md', '.markdown']);

/**
 * Detect content type from URL and optional headers.
 */
export function detectContentType(url: string, contentType?: string): 'image' | 'video' | 'document' | 'binary' {
  if (contentType) {
    if (contentType.startsWith('image/')) return 'image';
    if (contentType.startsWith('video/')) return 'video';
    if (contentType.startsWith('text/') || contentType.includes('json') || contentType.includes('xml')) return 'document';
  }

  const urlLower = url.toLowerCase();
  const ext = path.extname(new URL(url).pathname).toLowerCase();

  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  if (VIDEO_EXTENSIONS.has(ext)) return 'video';
  if (VIDEO_PLATFORM_DOMAINS.some(d => urlLower.includes(d))) return 'video';
  if (DOC_EXTENSIONS.has(ext)) return 'document';
  return 'binary';
}

/**
 * Check if URL requires yt-dlp for download.
 */
export function requiresYtdlp(url: string): boolean {
  const urlLower = url.toLowerCase();
  return VIDEO_PLATFORM_DOMAINS.some(d => urlLower.includes(d));
}

/**
 * HTTP download with progress callback.
 */
export async function httpDownload(
  url: string,
  destPath: string,
  options: DownloadOptions = {},
  redirectCount = 0,
): Promise<{ success: boolean; size: number; error?: string }> {
  const { timeout = 30000, onProgress, maxRedirects = 10 } = options;
  let requestHeaders: Record<string, string> = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
    ...options.headers,
    ...(options.cookies ? { Cookie: options.cookies } : {}),
  };
  // A distinct sibling file prevents concurrent jobs from deleting each other's work.
  const tempPath = `${destPath}.${randomUUID()}.tmp`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  let response: Response | undefined;
  try {
    let currentUrl = url;
    for (let redirects = redirectCount; ; redirects++) {
      const parsed = new URL(currentUrl);
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Unsupported download protocol');
      response = await fetchWithNodeNetwork(currentUrl, {
        headers: requestHeaders, signal: controller.signal, redirect: 'manual',
      });
      if (response.status < 300 || response.status >= 400) break;
      const location = response.headers.get('location');
      if (!location) break;
      await response.body?.cancel();
      if (redirects >= maxRedirects) throw new Error(`Too many redirects (> ${maxRedirects})`);
      const nextUrl = new URL(location, currentUrl);
      if (parsed.origin !== nextUrl.origin) {
        requestHeaders = Object.fromEntries(Object.entries(requestHeaders).filter(([key]) =>
          !['cookie', 'authorization', 'proxy-authorization'].includes(key.toLowerCase())));
      }
      currentUrl = nextUrl.toString();
    }
    if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
    if (!response.body) throw new Error('Empty response body');
    const totalSize = Number(response.headers.get('content-length')) || 0;
    const validateMedia = options.validateMedia || options.expectedMedia;
    const contentType = (response.headers.get('content-type') || '').toLowerCase();
    if (validateMedia && /mpegurl|dash\+xml/.test(contentType)) {
      throw new Error('Unsupported media playlist (HLS/DASH); expected a direct media file');
    }
    let received = 0;
    let prefix = Buffer.alloc(0);
    const progressStream = new Transform({
      transform(chunk, _encoding, callback) {
        received += chunk.length;
        if (validateMedia && prefix.length < 512) {
          prefix = Buffer.concat([prefix, Buffer.from(chunk).subarray(0, 512 - prefix.length)]);
          const text = prefix.toString('utf8').trimStart();
          if (/^#EXTM3U/i.test(text) || /<(?:\w+:)?MPD(?:\s|>)/i.test(text)) {
            callback(new Error('Unsupported media playlist (HLS/DASH); expected a direct media file'));
            return;
          }
        }
        try { onProgress?.(received, totalSize); callback(null, chunk); }
        catch (err) { callback(err as Error); }
      },
    });
    await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
    await pipeline(
      Readable.fromWeb(response.body as unknown as WebReadableStream),
      progressStream,
      fs.createWriteStream(tempPath, { flags: 'wx' }),
      { signal: controller.signal },
    );
    if (validateMedia) {
      if (received === 0) throw new Error('Empty media response');
      const textPrefix = prefix.toString('utf8').trimStart();
      if (/^(text\/|application\/(json|xml|xhtml))/.test(contentType)
          || /^(?:<!doctype\s+html|<html|<head|<body|<script|<\?xml|\{|\[)/i.test(textPrefix)) {
        throw new Error('Expected media but received a document response');
      }
    }
    // Content-Encoding may make the decompressed body differ from Content-Length.
    if (totalSize && !response.headers.get('content-encoding') && totalSize !== received) {
      throw new Error('Incomplete download: Content-Length mismatch');
    }
    if (options.expectedMedia === 'mp4') await validateMp4File(tempPath, controller.signal);
    controller.signal.throwIfAborted();
    await fs.promises.rename(tempPath, destPath);
    return { success: true, size: received };
  } catch (err) {
    return { success: false, size: 0, error: controller.signal.aborted
      ? `Download timed out after ${timeout}ms` : getErrorMessage(err) };
  } finally {
    clearTimeout(timer);
    if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {});
    await fs.promises.rm(tempPath, { force: true }).catch(() => {});
  }
}

export function resolveRedirectUrl(currentUrl: string, location: string): string {
  return new URL(location, currentUrl).toString();
}

/**
 * Export cookies to Netscape format for yt-dlp.
 */
export function exportCookiesToNetscape(
  cookies: BrowserCookie[],
  filePath: string,
): void {
  const lines = [
    '# Netscape HTTP Cookie File',
    '# https://curl.se/docs/http-cookies.html',
    '# This is a generated file!  Do not edit.',
    '',
  ];

  for (const cookie of cookies) {
    const domain = cookie.domain.startsWith('.') ? cookie.domain : `.${cookie.domain}`;
    const includeSubdomains = 'TRUE';
    const cookiePath = cookie.path || '/';
    const secure = cookie.secure ? 'TRUE' : 'FALSE';
    const expiry = typeof cookie.expirationDate === 'number' && cookie.expirationDate > 0
      ? Math.floor(cookie.expirationDate)
      : Math.floor(Date.now() / 1000) + 86400 * 365; // fallback: 1 year from now
    const safeName = cookie.name.replace(/[\t\n\r]/g, '');
    const safeValue = cookie.value.replace(/[\t\n\r]/g, '');
    lines.push(`${domain}\t${includeSubdomains}\t${cookiePath}\t${secure}\t${expiry}\t${safeName}\t${safeValue}`);
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  // 0o600: file holds live session cookies, must be owner-only. fchmod before
  // writing also tightens a pre-existing broad file before new secrets land.
  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC, 0o600);
    fs.fchmodSync(fd, 0o600);
    fs.writeFileSync(fd, lines.join('\n'), 'utf8');
  } finally {
    if (fd !== undefined) {
      fs.closeSync(fd);
    }
  }
}

export function formatCookieHeader(cookies: BrowserCookie[]): string {
  return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
}

/**
 * Download video using yt-dlp.
 */
export async function ytdlpDownload(
  url: string,
  destPath: string,
  options: YtdlpOptions = {},
): Promise<{ success: boolean; size: number; error?: string }> {
  const { cookiesFile, format = 'best', extraArgs = [], onProgress } = options;

  if (!checkYtdlp()) {
    return { success: false, size: 0, error: 'yt-dlp not installed. Install with: pip install yt-dlp' };
  }

  return new Promise((resolve) => {
    const dir = path.dirname(destPath);
    fs.mkdirSync(dir, { recursive: true });

    // Build yt-dlp arguments
    const args = [
      url,
      '-o', destPath,
      '-f', format,
      '--no-playlist',
      '--progress',
    ];

    if (cookiesFile) {
      if (fs.existsSync(cookiesFile)) {
        args.push('--cookies', cookiesFile);
      } else {
        log.warn(`[download] Cookies file not found: ${cookiesFile}, falling back to browser cookies`);
        args.push('--cookies-from-browser', 'chrome');
      }
    } else {
      // Try to use browser cookies
      args.push('--cookies-from-browser', 'chrome');
    }

    args.push(...extraArgs);

    const proc = spawn('yt-dlp', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let lastPercent = 0;
    let errorOutput = '';

    proc.stderr.on('data', (data: Buffer) => {
      const line = data.toString();
      errorOutput += line;

      // Parse progress from yt-dlp output
      const match = line.match(/(\d+\.?\d*)%/);
      if (match && onProgress) {
        const percent = parseFloat(match[1]);
        if (percent > lastPercent) {
          lastPercent = percent;
          onProgress(percent);
        }
      }
    });

    proc.stdout.on('data', (data: Buffer) => {
      const line = data.toString();
      const match = line.match(/(\d+\.?\d*)%/);
      if (match && onProgress) {
        const percent = parseFloat(match[1]);
        if (percent > lastPercent) {
          lastPercent = percent;
          onProgress(percent);
        }
      }
    });

    proc.on('close', (code) => {
      if (code === 0 && fs.existsSync(destPath)) {
        const stats = fs.statSync(destPath);
        resolve({ success: true, size: stats.size });
      } else {
        // Check for common yt-dlp output patterns
        const patterns = fs.readdirSync(dir).filter(f => f.startsWith(path.basename(destPath, path.extname(destPath))));
        if (patterns.length > 0) {
          const actualFile = path.join(dir, patterns[0]);
          const stats = fs.statSync(actualFile);
          resolve({ success: true, size: stats.size });
        } else {
          resolve({ success: false, size: 0, error: errorOutput.slice(0, 200) || `Exit code ${code}` });
        }
      }
    });

    proc.on('error', (err) => {
      resolve({ success: false, size: 0, error: err.message });
    });
  });
}

/**
 * Save document content to file.
 */
export async function saveDocument(
  content: string,
  destPath: string,
  format: 'json' | 'markdown' | 'html' | 'text' = 'markdown',
  metadata?: Record<string, unknown>,
): Promise<{ success: boolean; size: number; error?: string }> {
  try {
    const dir = path.dirname(destPath);
    fs.mkdirSync(dir, { recursive: true });

    let output: string;

    if (format === 'json') {
      output = JSON.stringify({ ...metadata, content }, null, 2);
    } else if (format === 'markdown') {
      // Add frontmatter if metadata exists
      const frontmatter = metadata ? `---\n${Object.entries(metadata).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('\n')}\n---\n\n` : '';
      output = frontmatter + content;
    } else {
      output = content;
    }

    fs.writeFileSync(destPath, output, 'utf-8');
    return { success: true, size: Buffer.byteLength(output, 'utf-8') };
  } catch (err) {
    return { success: false, size: 0, error: getErrorMessage(err) };
  }
}

/**
 * Sanitize filename by removing invalid characters.
 */
export function sanitizeFilename(name: string, maxLength: number = 200): string {
  return name
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_') // Remove invalid chars
    .replace(/\s+/g, '_') // Replace spaces with underscores
    .replace(/_+/g, '_') // Collapse multiple underscores
    .replace(/^_|_$/g, '') // Trim underscores
    .slice(0, maxLength);
}

/**
 * Generate filename from URL if not provided.
 */
export function generateFilename(url: string, index: number, extension?: string): string {
  try {
    const parsedUrl = new URL(url);
    const pathname = parsedUrl.pathname;
    const basename = path.basename(pathname);

    if (basename && basename !== '/' && basename.includes('.')) {
      return sanitizeFilename(basename);
    }

    // Generate from hostname and index
    const ext = extension || detectExtension(url);
    const hostname = parsedUrl.hostname.replace(/^www\./, '');
    return sanitizeFilename(`${hostname}_${index + 1}${ext}`);
  } catch {
    const ext = extension || '.bin';
    return `download_${index + 1}${ext}`;
  }
}

/**
 * Detect file extension from URL.
 */
function detectExtension(url: string): string {
  const type = detectContentType(url);
  switch (type) {
    case 'image': return '.jpg';
    case 'video': return '.mp4';
    case 'document': return '.md';
    default: return '.bin';
  }
}

/**
 * Get temp directory for cookie files.
 */
export function getTempDir(): string {
  return path.join(os.tmpdir(), 'bycli-download');
}
