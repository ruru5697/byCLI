import { cli, Strategy } from '@sovovs/bycli/registry';
import { videoJobAction } from '../_shared/video-submit.js';
import { makeVideoAdapter } from '../_shared/video-site-submit.js';
import { CliError } from '@sovovs/bycli/errors';
import { prepareVideo, waitFor, clickText, fillVerified } from '../_shared/video-prepare.js';

export const VIDEO_PUBLISH_URL = 'https://creator.xiaohongshu.com/publish/publish?from=menu_left&target=video';

export function xhsPreparedSnapshot() {
    const host = document.querySelector('xhs-publish-btn');
    const visible = e => !!e && e.getBoundingClientRect().width > 0;
    const videos = [...document.querySelectorAll('video')];
    const editor = document.querySelector('.tiptap.ProseMirror');
    const paragraphs = editor?.children.length > 0 && [...editor.children].every(n => n.tagName === 'P');
    const cover = document.querySelector('.cover--row > .default, .cover--column > .default');
    return {
        title: document.querySelector('input[placeholder="填写标题会有更多赞哦"]')?.value,
        body: (paragraphs ? [...editor.children].map(n => n.textContent).join('\n') : editor?.innerText)?.trim(),
        duration: videos.find(e => Number.isFinite(e.duration) && e.duration > 0)?.duration || null,
        videoReady: videos.some(e => e.readyState >= 2 && e.duration > 0),
        customCoverPresent: !!cover?.style.backgroundImage,
        coverAspectRatio: cover ? getComputedStyle(cover).aspectRatio : null,
        coverDialogClosed: ![...document.querySelectorAll('.d-modal')].some(visible),
        titleEditorVisible: visible(document.querySelector('input[placeholder="填写标题会有更多赞哦"]')),
        publishEnabled: !!host && host.getAttribute('submit-disabled') === 'false' && host.getAttribute('submit-loading') !== 'true',
        visibilityPublic: [...document.querySelectorAll('*')].some(e => e.children.length === 0 && e.textContent.trim() === '公开可见' && visible(e)),
        // Only selected text in the content-settings control; exclude open dropdown options.
        declarationLabels: [...document.querySelectorAll('.d-select')].filter(visible).map(e => e.innerText.trim()),
        warnings: document.body.innerText.includes('视频分辨率较低') ? ['Site recommends uploading at least 1080P'] : [],
    };
}

export async function waitForXhsCoverReplacement(page, oldCover) {
    return waitFor(page, `(() => {
        const image = document.querySelector('.cover--row > .default, .cover--column > .default')?.style.backgroundImage || '';
        return !!image && image !== ${JSON.stringify(oldCover)};
    })()`, 'custom cover replacement');
}

export async function prepareXhsVideo(page, manifest, stage) {
    await stage('opening_editor');
    await page.goto(VIDEO_PUBLISH_URL);
    await page.focusWindow();
    if (await page.evaluate(`!!document.querySelector('input[placeholder="填写标题会有更多赞哦"]')`)) throw new CliError('EXISTING_EDITOR', 'An existing video editor is open; inspect it and close its tab before preparing a new job');
    await waitFor(page, `!!document.querySelector('input.upload-input')`, 'logged-in video uploader', 30000);
    await stage('uploading_video');
    await page.setFileInput([manifest.video], 'input.upload-input');
    await waitFor(page, `!!document.querySelector('input[placeholder="填写标题会有更多赞哦"]') && [...document.querySelectorAll('video')].some(v => v.readyState >= 2 && v.duration > 0)`, 'uploaded video preview', 180000);
    await stage('uploading_cover');
    const oldCover = await page.evaluate(`document.querySelector('.cover--row > .default, .cover--column > .default')?.style.backgroundImage || ''`);
    // The initial empty cover is replaced by an edit entry once the first frame is ready.
    await waitFor(page, `!!document.querySelector('.cover-edit-entry,.upload-cover')`, 'cover editor');
    const selector = await page.evaluate(`document.querySelector('.cover-edit-entry') ? '.cover-edit-entry' : '.upload-cover'`);
    await page.click(selector);
    await clickText(page, '上传封面', '.d-modal');
    await waitFor(page, `!!document.querySelector('input[type=file][accept*="image"]')`, 'cover input');
    await page.setFileInput([manifest.cover], 'input[type=file][accept*="image"]');
    await waitFor(page, `[...document.querySelectorAll('.d-modal [class*=crop] img')].some(e=>e.naturalWidth>0)`, 'cover image decode');
    if (manifest.coverRatio) await clickText(page, manifest.coverRatio, '.d-modal');
    await page.click('.d-modal .btn-confirm');
    await waitFor(page, `![...document.querySelectorAll('.d-modal')].some(e => e.getBoundingClientRect().width > 0)`, 'cover confirmation');
    const coverChanged = await waitForXhsCoverReplacement(page, oldCover);
    await stage('filling_fields');
    await fillVerified(page, 'input[placeholder="填写标题会有更多赞哦"]', manifest.title);
    await fillVerified(page, '.tiptap.ProseMirror', manifest.body);
    // Blur the editor so hashtag suggestions cannot cover the settings control.
    await page.click('input[placeholder="填写标题会有更多赞哦"]');
    if (manifest.declaration !== 'none') {
        await clickText(page, '添加内容类型声明');
        await waitFor(page, `Array.from(document.querySelectorAll('*')).some(e => e.children.length === 0 && e.textContent.trim() === ${JSON.stringify(manifest.declaration)} && e.getBoundingClientRect().width > 0)`, 'content declaration options', 10000);
        await clickText(page, manifest.declaration);
    }
    await stage('verifying_required_fields');
    const checks = await waitFor(page, `(() => {const s=(${xhsPreparedSnapshot.toString()})();return s.publishEnabled && s.visibilityPublic && s.coverDialogClosed ? s : false})()`, 'ready editor');
    const norm = s => (s || '').replace(/\r\n/g, '\n').trim();
    if (checks.title !== manifest.title || norm(checks.body) !== norm(manifest.body)) throw new CliError('FIELD_MISMATCH', 'Title or body changed after preparation');
    const declarations = checks.declarationLabels.join(' ');
    if (manifest.declaration === 'none' ? !declarations.includes('添加内容类型声明') : !declarations.includes(manifest.declaration)) throw new CliError('DECLARATION_MISMATCH', 'Content declaration was not verified');
    if (!checks.videoReady || !checks.customCoverPresent || !checks.titleEditorVisible) throw new CliError('EDITOR_NOT_READY', 'Video or cover was not ready');
    if (manifest.coverRatio && manifest.coverRatio !== '原始') {
        const [a, b = '1'] = (checks.coverAspectRatio || '').split('/');
        const [x, y] = manifest.coverRatio.split(':').map(Number);
        if (Math.abs(Number(a) / Number(b) - x / y) > 0.02 || !Number.isFinite(Number(a) / Number(b))) throw new CliError('COVER_RATIO_MISMATCH', 'Cover ratio did not match the requested crop');
    }
    return { ...checks, coverChanged, declaration: manifest.declaration, finalPublishClicked: false };
}

export const command = cli({
    site: 'xiaohongshu', name: 'publish-video', access: 'write',
    description: '准备小红书视频笔记：上传视频封面、填写字段，确认后提交并查询回执与状态',
    domain: 'creator.xiaohongshu.com', strategy: Strategy.COOKIE, navigateBefore: false, siteSession: 'persistent',
    args: [
        { name: 'input', help: 'Path to video preparation JSON manifest' },
        { name: 'review', help: 'Review local job UUID and issue a 30-minute confirmation token' },
        { name: 'submit', help: 'Submit reviewed job UUID exactly once, after human approval' },
        { name: 'confirm', help: 'Exact token returned by --review' },
        { name: 'status', help: 'Query local job UUID and exact platform content ID' },
        { name: 'timeout', type: 'int', default: 300, help: 'Overall preparation timeout in seconds' },
        { name: 'prepare', type: 'bool', default: false, help: 'Prepare only; requires --input' },
    ],
    columns: ['status', 'job_id', 'submitted', 'account', 'content_id', 'confirmation', 'query_status', 'report', 'preview'],
    func: (page, kwargs) => {
        if (kwargs.prepare && !kwargs.review && !kwargs.submit && !kwargs.status && !kwargs.confirm && kwargs.input) return prepareVideo(page, kwargs, 'xiaohongshu', prepareXhsVideo, makeVideoAdapter('xiaohongshu', xhsPreparedSnapshot).inspect);
        return videoJobAction(page, kwargs, 'xiaohongshu', makeVideoAdapter('xiaohongshu', xhsPreparedSnapshot));
    },
});
