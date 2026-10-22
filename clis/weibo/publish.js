/**
 * Weibo publish — post a new Weibo update via browser UI automation.
 *
 * Flow:
 *   1. Navigate to weibo.com and wait for the feed
 *   2. Check login state (getSelfUid)
 *   3. Click "发微博" button to open the inline compose editor
 *   4. Wait for textarea editor to appear
 *   5. Fill text content via CDP type
 *   6. Optionally upload images via CDP setFileInput
 *   7. Click the publish button
 *   8. Poll for success/failure feedback
 *
 * Usage:
 *   bycli weibo publish "Hello from byCLI! #bycli"  # publishes immediately
 *   bycli weibo publish "Check this out" --images /path/a.jpg,/path/b.jpg
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { cli, Strategy } from '@sovovs/bycli/registry';
import { ArgumentError, AuthRequiredError, CommandExecutionError } from '@sovovs/bycli/errors';
import { getSelfUid } from './utils.js';

const MAX_IMAGES = 9;
const UPLOAD_POLL_MS = 1500;
const UPLOAD_TIMEOUT_MS = 90_000;
const COMPOSE_POLL_MS = 300;
const COMPOSE_TIMEOUT_MS = 10_000;
const SUBMIT_POLL_MS = 500;
const SUBMIT_TIMEOUT_MS = 20_000;
const SUPPORTED_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);
const SUPPORTED_VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.m4v', '.webm']);

// Weibo PC UI selectors. The CSS-module hash drifts on every frontend
// rebuild (#1602), so match on the stable placeholder text and keep the
// legacy hash as a last-resort fallback. Callers pick the LAST visible
// match because the compose modal renders on top of the home-feed strip.
const TEXTAREA_SELECTORS = [
    'textarea[placeholder*="有什么新鲜事"]',
    'textarea[placeholder*="新鲜事"]',
    'textarea._input_13iqr_8',
];
const FILE_INPUT_SELECTOR = 'input[type="file"][class*="_file_"]';
const VIDEO_FILE_INPUT_SELECTOR = 'input[type="file"][accept*="video"]';

/**
 * Weibo opens the dedicated video uploader in a new tab. Browser Bridge keeps
 * the original composer as the active page unless we explicitly select the
 * new target, so discover the newest /upload/channel tab after clicking the
 * video entry point.
 */
async function selectVideoUploadTab(page) {
    if (typeof page.tabs !== 'function' || typeof page.selectTab !== 'function') return;
    for (let attempt = 0; attempt < 20; attempt++) {
        const tabs = await page.tabs();
        if (Array.isArray(tabs)) {
            const candidates = tabs.filter(tab => {
                if (!tab || typeof tab !== 'object') return false;
                const value = tab;
                const url = String(value.url ?? value.href ?? value.currentUrl ?? '');
                const title = String(value.title ?? '');
                return url.includes('/upload/channel') || title.includes('视频发布');
            });
            const target = candidates[candidates.length - 1];
            if (target && typeof target === 'object') {
                const value = target;
                const pageId = value.page ?? value.id ?? value.targetId ?? value.identity;
                if (typeof pageId === 'string' || typeof pageId === 'number') {
                    await page.selectTab(pageId);
                    await page.wait({ time: 1 });
                    return;
                }
            }
        }
        await page.wait({ time: 0.5 });
    }
}

/** Open Weibo's dedicated video uploader from the composer, then select the
 * newly-created tab. Some Weibo builds open it in a tab; others navigate the
 * current tab, so both paths are handled before falling back to direct URL. */
async function openVideoUpload(page) {
    const before = typeof page.tabs === 'function' ? await page.tabs() : [];
    let opened = false;
    try {
        await nativeClickVisible(
            page,
            'button, a, [role="button"], div, span',
            'data-bycli-weibo-video-entry',
            'el => /^(视频|发视频|上传视频|视频投稿)$/.test((el.innerText || el.textContent || "").trim())',
            'Could not find Weibo video upload entry',
        );
        opened = true;
    } catch {
        // Older layouts do not expose a labelled entry in the quick composer.
    }
    if (opened) {
        for (let i = 0; i < 20; i++) {
            await page.wait({ time: 0.5 });
            await selectVideoUploadTab(page);
            const current = typeof page.tabs === 'function' ? await page.tabs() : [];
            if (Array.isArray(current) && current.length > (Array.isArray(before) ? before.length : 0)) return;
        }
    }
    if (typeof page.newTab === 'function' && typeof page.selectTab === 'function') {
        const created = await page.newTab('https://weibo.com/upload/channel');
        if (created) {
            await page.selectTab(created);
            await page.wait({ time: 1.5 });
            return;
        }
    }
    await page.goto('https://weibo.com/upload/channel', { waitUntil: 'load', settleMs: 1500 });
    await page.wait({ time: 1.5 });
}

/**
 * Mark one visible control and click it through byCLI's native click path.
 * Weibo's composer occasionally ignores a synthetic DOM click after a file
 * upload; the native path dispatches the full mouse event chain instead.
 */
async function nativeClickVisible(page, selector, marker, predicateSource, message) {
    const result = await page.evaluate(`
        ((args) => {
            const visible = el => !!el && el.offsetParent !== null && !el.disabled;
            const predicate = args.predicateSource ? Function('el', 'return (' + args.predicateSource + ')(el)') : () => true;
            const nodes = Array.from(document.querySelectorAll(args.selector));
            let selected = null;
            for (const el of nodes) {
                if (!visible(el) || !predicate(el)) continue;
                if (selected) selected.removeAttribute(args.marker);
                el.setAttribute(args.marker, '1');
                selected = el;
            }
            if (selected) return { ok: true };
            return { ok: false, message: args.message };
        })(${JSON.stringify({ selector, marker, predicateSource, message: message || 'Could not find clickable control' })})
    `);
    if (!result?.ok) throw new CommandExecutionError(result?.message || 'Could not find clickable control');
    // Prefer the Page transport's direct native click. This avoids a second
    // selector resolution after Weibo re-renders the dual composer. Test
    // doubles do not expose either nativeClick or click, so their evaluate
    // queue already models the click result.
    if (typeof page.nativeClick === 'function') {
        const rect = await page.evaluate(`
            (() => {
                const el = document.querySelector('[${marker}="1"]');
                if (!el) return null;
                const r = el.getBoundingClientRect();
                return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), w: r.width, h: r.height };
            })()
        `);
        if (!rect || rect.w <= 0 || rect.h <= 0) throw new CommandExecutionError('Could not measure clickable control');
        await page.nativeClick(rect.x, rect.y);
    } else if (typeof page.click === 'function') {
        await page.click(`[${marker}="1"]`);
    }
}

function validateText(text) {
    const t = String(text ?? '').trim();
    if (!t) throw new ArgumentError('weibo publish text cannot be empty');
    if (t.length > 2000) throw new ArgumentError('weibo publish text exceeds 2000 characters');
    return t;
}

function validateImagePaths(raw) {
    if (!raw) return [];
    const paths = raw.split(',').map(s => s.trim()).filter(Boolean);
    if (paths.length > MAX_IMAGES) {
        throw new ArgumentError(`Too many images: ${paths.length} (max ${MAX_IMAGES})`);
    }
    return paths.map(p => {
        const absPath = path.resolve(p);
        const ext = path.extname(absPath).toLowerCase();
        if (!SUPPORTED_EXTENSIONS.has(ext)) {
            throw new ArgumentError(`Unsupported image format "${ext}". Supported: jpg, png, gif, webp`);
        }
        const stat = fs.statSync(absPath, { throwIfNoEntry: false });
        if (!stat || !stat.isFile()) {
            throw new ArgumentError(`Not a valid file: ${absPath}`);
        }
        return absPath;
    });
}

function validateVideoPath(raw) {
    if (!raw) return null;
    const absPath = path.resolve(String(raw).trim());
    const ext = path.extname(absPath).toLowerCase();
    if (!SUPPORTED_VIDEO_EXTENSIONS.has(ext)) {
        throw new ArgumentError(`Unsupported video format "${ext}". Supported: mp4, mov, m4v, webm`);
    }
    const stat = fs.statSync(absPath, { throwIfNoEntry: false });
    if (!stat || !stat.isFile()) throw new ArgumentError(`Not a valid video file: ${absPath}`);
    return absPath;
}

cli({
    site: 'weibo',
    name: 'publish',
    access: 'write',
    description: 'Publish a new Weibo post immediately',
    domain: 'weibo.com',
    strategy: Strategy.UI,
    browser: true,
    args: [
        {
            name: 'text',
            type: 'string',
            required: true,
            positional: true,
            help: 'Weibo text content (max 2000 chars)',
        },
        {
            name: 'images',
            type: 'string',
            required: false,
            help: `Image paths, comma-separated, max ${MAX_IMAGES} (jpg/png/gif/webp)`,
        },
        {
            name: 'video',
            type: 'string',
            required: false,
            help: 'Video path (mp4/mov/m4v/webm), mutually exclusive with --images',
        },
    ],
    columns: ['status', 'message', 'text'],
    func: async (page, kwargs) => {
        if (!page) throw new CommandExecutionError('Browser session required for weibo publish');

        const text = validateText(kwargs.text);
        const absPaths = validateImagePaths(kwargs.images);
        const absVideo = validateVideoPath(kwargs.video);
        if (absPaths.length > 0 && absVideo) {
            throw new ArgumentError('weibo publish --images and --video are mutually exclusive');
        }

        // Step 1: Navigate to weibo.com and wait for feed to load
        await page.goto('https://weibo.com', { waitUntil: 'load', settleMs: 2000 });
        await page.wait({ time: 2 });

        // Step 2: Check login
        let selfUid;
        try {
            selfUid = await getSelfUid(page);
        } catch (err) {
            if (err instanceof AuthRequiredError) throw err;
            throw new CommandExecutionError('Not logged into Weibo. Please login at weibo.com in your Chrome browser.');
        }

        // Step 3: Click "发微博" button to open inline compose editor.  Keep
        // an already-open quick composer (for example, after an upload has
        // completed while a command was reconnecting) so the command can
        // finish the existing draft instead of uploading a duplicate.
        const composeAlreadyOpen = typeof page.nativeClick === 'function'
            ? await page.evaluate(`
                (() => {
                    const body = document.body?.innerText || '';
                    const tail = body.slice(-1200);
                    const editors = Array.from(document.querySelectorAll('textarea'))
                        .filter(el => el.offsetParent !== null);
                    return editors.length >= 1 && tail.includes('请进行内容声明（必填）');
                })()
            `)
            : false;
        if (!composeAlreadyOpen) {
            await nativeClickVisible(
                page,
                'button[title="发微博"], button[title="写微博"]',
                'data-bycli-weibo-open',
                'el => true',
                'Could not find 发微博 button',
            );
        }

        // Step 4: Wait for the textarea editor to appear (visible, not just in DOM)
        let editorFound = false;
        let editorIndex = 0;
        for (let i = 0; i < Math.ceil(COMPOSE_TIMEOUT_MS / COMPOSE_POLL_MS); i++) {
            const result = await page.evaluate(`
                (selectors => {
                    // Pick the LAST visible match across all selectors so
                    // the modal (rendered on top of the home-feed strip)
                    // wins over earlier matches. See TEXTAREA_SELECTORS.
                    let last = null;
                    let lastIndex = -1;
                    for (const sel of selectors) {
                        const matches = Array.from(document.querySelectorAll(sel));
                        for (let j = 0; j < matches.length; j++) {
                            const t = matches[j];
                            if (t.offsetParent !== null) { last = t; lastIndex = j; }
                        }
                    }
                    if (!last) return { found: false };
                    return { found: true, visible: true, rectTop: last.getBoundingClientRect().top, index: lastIndex };
                })(${JSON.stringify(TEXTAREA_SELECTORS)})
            `);
            if (result?.found && result.visible && result.rectTop >= 0) {
                editorFound = true;
                editorIndex = Number.isInteger(result.index) ? result.index : 0;
                break;
            }
            await page.wait({ time: COMPOSE_POLL_MS / 1000 });
        }
        if (!editorFound) {
            throw new CommandExecutionError('Weibo compose editor did not appear');
        }

        // Step 5: Upload media before text to avoid editor reset.
        if (absVideo) {
            // A previous invocation may have left the completed video in the
            // quick composer. Reuse that preview and only perform the missing
            // declaration/text/submit steps.
            const existingVideoPreview = typeof page.nativeClick === 'function'
                ? await page.evaluate(`
                    (() => {
                        const tail = (document.body?.innerText || '').slice(-1200);
                        return tail.includes('请进行内容声明（必填）');
                    })()
                `)
                : false;
            let videoReady = existingVideoPreview ? { ok: true } : null;
            if (!existingVideoPreview) {
                await openVideoUpload(page);
                const videoInputSelector = '[data-bycli-weibo-video-input="1"]';
                const videoInputFound = await page.evaluate(`
                    (() => {
                        let selected = null;
                        for (const input of document.querySelectorAll(${JSON.stringify(VIDEO_FILE_INPUT_SELECTOR)})) {
                            // File inputs are intentionally visually hidden; use
                            // DOM order to select the modal's last input instead.
                            if (input.disabled) continue;
                            if (selected) selected.removeAttribute('data-bycli-weibo-video-input');
                            input.setAttribute('data-bycli-weibo-video-input', '1');
                            selected = input;
                        }
                        return !!selected;
                    })()
                `);
                if (!videoInputFound) throw new CommandExecutionError('Could not find video file input on Weibo compose page. UI may have changed.');
                if (typeof page.uploadFiles === 'function') {
                    await page.uploadFiles(videoInputSelector, [absVideo]);
                } else {
                    await page.setFileInput([absVideo], VIDEO_FILE_INPUT_SELECTOR);
                }
                if (typeof page.uploadFiles !== 'function' && typeof page.nativeClick === 'function') {
                    await page.evaluate(`
                        (() => {
                            const el = document.querySelector(${JSON.stringify(videoInputSelector)});
                            if (!el) return false;
                            el.dispatchEvent(new Event('input', { bubbles: true }));
                            el.dispatchEvent(new Event('change', { bubbles: true }));
                            return true;
                        })()
                    `);
                }
                for (let i = 0; i < Math.ceil(UPLOAD_TIMEOUT_MS / UPLOAD_POLL_MS); i++) {
                    await page.wait({ time: UPLOAD_POLL_MS / 1000 });
                    videoReady = await page.evaluate(`
                        (() => {
                            const body = document.body?.innerText || '';
                            const tail = body.slice(-1200);
                            const progress = document.querySelector('[class*="progress"], [class*="uploading"]');
                            const progressRect = progress?.getBoundingClientRect?.();
                            if (progress && progress.offsetParent !== null && progressRect && progressRect.width > 1 && progressRect.height > 1) return null;
                            if (tail.includes('请进行内容声明（必填）')) return { ok: true };
                            return null;
                        })()
                    `);
                    if (videoReady?.ok) break;
                }
                if (!videoReady?.ok) {
                    // A few Browser Bridge builds serialize evaluateWithArgs
                    // values differently while the upload component re-renders.
                    // Re-check the visible modal signal without arguments before
                    // declaring the upload failed.
                    const fallbackReady = await page.evaluate(`
                        (() => {
                            const tail = (document.body?.innerText || '').slice(-1200);
                            return tail.includes('请进行内容声明（必填）');
                        })()
                    `);
                    if (fallbackReady === true) videoReady = { ok: true };
                }
            }
            if (!videoReady?.ok) throw new CommandExecutionError('Video upload did not complete before timeout');

            // Only mark the post as AI-generated when the caller asks. Opening
            // the required declaration and picking 含AI生成内容 is not the default.
            const declareAi = kwargs?.['ai-generated'] === true || kwargs?.['ai-generated'] === 'true' || kwargs?.aiGenerated === true;
            if (declareAi && typeof page.nativeClick === 'function') {
                const declaration = await page.evaluate(`
                    (() => Array.from(document.querySelectorAll('*')).some(el =>
                        el.offsetParent !== null && (el.innerText || '').trim() === '请进行内容声明（必填）'))
                `);
                if (declaration) {
                    await nativeClickVisible(
                        page,
                        'button, [role="button"], div, span',
                        'data-bycli-weibo-declaration',
                        'el => (el.innerText || el.textContent || "").trim() === "请进行内容声明（必填）"',
                        'Could not open video content declaration',
                    );
                }
                const aiVisible = await page.evaluate(`
                    (() => Array.from(document.querySelectorAll('button, [role="button"]')).some(el =>
                        el.offsetParent !== null && (el.innerText || el.textContent || '').trim() === '含AI生成内容'))
                `);
                if (aiVisible) {
                    await nativeClickVisible(
                        page,
                        'button, [role="button"]',
                        'data-bycli-weibo-ai-declaration',
                        'el => (el.innerText || el.textContent || "").trim() === "含AI生成内容"',
                        'Could not select AI content declaration',
                    );
                    await nativeClickVisible(
                        page,
                        'button, [role="button"]',
                        'data-bycli-weibo-declaration-confirm',
                        'el => (el.innerText || el.textContent || "").trim() === "确定"',
                        'Could not confirm content declaration',
                    );
                }
            }
        } else if (absPaths.length > 0) {
            if (!page.setFileInput) {
                throw new CommandExecutionError('Browser extension does not support file upload. Please update the extension.');
            }

            // Find the file input
            const imageInputSelector = '[data-bycli-weibo-image-input="1"]';
            const fileInputFound = await page.evaluate(`
                (() => {
                    let selected = null;
                    for (const input of document.querySelectorAll(${JSON.stringify(FILE_INPUT_SELECTOR)})) {
                        if (input.disabled) continue;
                        if (selected) selected.removeAttribute('data-bycli-weibo-image-input');
                        input.setAttribute('data-bycli-weibo-image-input', '1');
                        selected = input;
                    }
                    return !!selected;
                })()
            `);
            if (!fileInputFound) {
                throw new CommandExecutionError('Could not find image file input on Weibo compose page. UI may have changed.');
            }

            if (typeof page.uploadFiles === 'function') {
                await page.uploadFiles(imageInputSelector, absPaths);
            } else {
                await page.setFileInput(absPaths, FILE_INPUT_SELECTOR);
            }
            if (typeof page.uploadFiles !== 'function' && typeof page.nativeClick === 'function') {
                await page.evaluate(`
                    (() => {
                        const el = document.querySelector(${JSON.stringify(imageInputSelector)});
                        if (!el) return false;
                        el.dispatchEvent(new Event('input', { bubbles: true }));
                        el.dispatchEvent(new Event('change', { bubbles: true }));
                        return true;
                    })()
                `);
            }

            // Wait for upload to complete
            let uploadResult = null;
            for (let i = 0; i < Math.ceil(UPLOAD_TIMEOUT_MS / UPLOAD_POLL_MS); i++) {
                await page.wait({ time: UPLOAD_POLL_MS / 1000 });
                uploadResult = await page.evaluateWithArgs(`
                    (() => {
                        const expectedCount = expected;
                        const uploading = document.querySelector('[class*="upload"], [class*="progress"]');
                        if (uploading && uploading.offsetParent !== null) return null;
                        const pics = document.querySelectorAll('img[class*="pic"], [class*="imgItem"], [class*="picture"] img');
                        if (pics.length >= expectedCount) return { ok: true, count: pics.length };
                        return null;
                    })()
                `, { expected: absPaths.length });
                if (uploadResult !== null) break;
            }

            if (!uploadResult?.ok) {
                throw new CommandExecutionError(uploadResult?.message ?? 'Image upload did not complete before timeout');
            }
        }

        // Step 6: Insert text using native DOM setter (preserves Weibo internal state)
        // IMPORTANT: Using nativeSetter preserves the textarea's reactive/internal state.
        // Direct ta.value= assignment bypasses Weibo's Vue reactivity and causes "undefined" content.
        let insertResult;
        if (typeof page.typeText === 'function') {
            const editorSelector = '[data-bycli-weibo-editor="1"]';
            const editorMarked = await page.evaluate(`
                (() => {
                    let selected = null;
                    for (const sel of ${JSON.stringify(TEXTAREA_SELECTORS)}) {
                        for (const ta of document.querySelectorAll(sel)) {
                            if (ta.offsetParent !== null) {
                                if (selected) selected.removeAttribute('data-bycli-weibo-editor');
                                ta.setAttribute('data-bycli-weibo-editor', '1');
                                selected = ta;
                            }
                        }
                    }
                    return !!selected;
                })()
            `);
            if (!editorMarked) throw new CommandExecutionError('Weibo compose editor is not visible');
            await page.typeText(editorSelector, text);
            insertResult = { ok: true, valueLength: text.length };
        } else {
            insertResult = await page.evaluateWithArgs(`
            ((selectors) => {
                let ta = null;
                for (const sel of selectors) {
                    for (const t of document.querySelectorAll(sel)) {
                        if (t.offsetParent !== null) ta = t;
                    }
                }
                if (!ta) return { ok: false, message: 'textarea not visible' };
                ta.focus();
                const nativeSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
                if (nativeSetter) {
                    nativeSetter.call(ta, textContent);
                } else {
                    ta.value = textContent;
                }
                ta.dispatchEvent(new Event('input', { bubbles: true }));
                ta.dispatchEvent(new Event('change', { bubbles: true }));
                return { ok: true, valueLength: ta.value.length };
            })(${JSON.stringify(TEXTAREA_SELECTORS)})
        `, { textContent: text });
        }

        if (!insertResult?.ok) {
            throw new CommandExecutionError(insertResult?.message ?? 'Could not insert text.');
        }


        // Step 7: Click the send button inside the compose editor
        // Try 发送 first (compose editor's submit), then 发布 (fallback)
        await page.wait({ time: 0.5 });
        await nativeClickVisible(
            page,
            'button, [role="button"]',
            'data-bycli-weibo-submit',
            'el => ["发送", "发布"].includes((el.innerText || el.textContent || "").trim())',
            'Could not find send button',
        );

        // Step 8: Wait for success/failure result
        // Use page.evaluate (not evaluateWithArgs): the IIFE doesn't reference
        // any outer args, and evaluateWithArgs would re-declare its const
        // bindings each loop iteration in the same page context, throwing
        // "Identifier already declared" after the first iteration.
        let finalResult = null;
        for (let i = 0; i < Math.ceil(SUBMIT_TIMEOUT_MS / SUBMIT_POLL_MS); i++) {
            await page.wait({ time: SUBMIT_POLL_MS / 1000 });
            finalResult = await page.evaluate(`
                (() => {
                    const successMarkers = ['发布成功', '已发布', '发送成功'];
                    const errorMarkers = ['发布失败', '发送失败', '内容违规', '请稍后再试', '频繁'];
                    for (const el of document.querySelectorAll('*')) {
                        if (el.children.length > 3) continue;
                        const txt = (el.innerText || '').trim();
                        if (!txt || txt.length > 100) continue;
                        for (const m of successMarkers) {
                            if (txt.includes(m) && (txt.includes('成功') || txt.includes('微博'))) {
                                return { ok: true, message: txt };
                            }
                        }
                        for (const m of errorMarkers) {
                            if (txt.includes(m)) {
                                return { ok: false, message: txt };
                            }
                        }
                    }
                    return null;
                })()
            `);
            if (finalResult !== null) break;
        }

        // Some Weibo builds do not render a toast at all. Confirm the side
        // effect from the account page before reporting an unknown result.
        if (!finalResult) {
            const needle = text.replace(/\s+/g, ' ').trim().slice(0, 80);
            await page.goto(`https://weibo.com/u/${encodeURIComponent(selfUid)}`, { waitUntil: 'load', settleMs: 1500 });
            for (let i = 0; i < 8; i++) {
                const profileResult = await page.evaluateWithArgs(`
                    (() => {
                        const body = (document.body?.innerText || '').replace(/\\s+/g, ' ');
                        return body.includes(needle);
                    })()
                `, { needle });
                if (profileResult === true) {
                    finalResult = { ok: true, message: 'Published successfully (verified on profile)' };
                    break;
                }
                await page.wait({ time: 1 });
            }
        }

        if (!finalResult) {
            throw new CommandExecutionError('Publish button clicked but result was unclear. Check Weibo manually.');
        }

        if (!finalResult.ok) {
            throw new CommandExecutionError(finalResult.message || 'Weibo publish failed');
        }

        return [{
            status: 'success',
            message: finalResult.message || 'Published successfully',
            text,
        }];
    },
});

export const __test__ = {
    validateText,
    validateImagePaths,
    validateVideoPath,
};
