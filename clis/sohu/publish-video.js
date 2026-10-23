import {resumeCategory} from './_resume.js';
import {selectSohuCategory} from './_category.js';
import { cli, Strategy } from '@sovovs/bycli/registry';
import { digest, videoJobAction } from '../_shared/video-submit.js';
import { liveContext, makeVideoAdapter } from '../_shared/video-site-submit.js';
import { ArgumentError, CliError } from '@sovovs/bycli/errors';
import { prepareVideo, waitFor, clickText, fillVerified } from '../_shared/video-prepare.js';

export const VIDEO_PUBLISH_URL = 'https://mp.sohu.com/mpfe/v4/contentManagement/news/addvideo';
export function sohuPreparedSnapshot() {
    const text = document.body.innerText;
    const visible = e => e.getBoundingClientRect().width > 0;
    const checked = [...document.querySelectorAll('label.el-radio')].filter(e => e.querySelector('input')?.checked).map(e => e.innerText.trim());
    const buttons = [...document.querySelectorAll('*')].filter(e => e.children.length === 0 && e.textContent.trim() === '发布' && visible(e));
    return {
        title: document.querySelector('input.titleErrorInput')?.value,
        body: document.querySelector('textarea.abstract-main-textarea')?.value,
        videoUploaded: text.includes('视频上传成功'),
        videoDuration: text.match(/视频时长[：:]\s*([\d:]+)/)?.[1] || null,
        customCoverPresent: !!document.querySelector('.pic-cover')?.style.backgroundImage,
        category: [...document.querySelectorAll('.channel-select-row .select-text')].map(e => e.innerText.trim()),
        declarations: checked,
        coverDialogClosed: ![...document.querySelectorAll('.select-dialog')].some(visible),
        quota: Number(text.match(/您今天还能发\s*(\d+)\s*篇视频/)?.[1] ?? -1),
        publishControlPresent: buttons.length === 1,
        publishControlDisabled: buttons.some(e => e.closest('[disabled],.disabled,.disable-button')),
    };
}

export async function selectCategory(page, labels) {
    return selectSohuCategory(page, 'video', labels);
}

export async function prepareSohuVideo(page, manifest, stage) {
    await stage('opening_editor');
    await page.goto(VIDEO_PUBLISH_URL);
    await page.focusWindow();
    if (await page.evaluate(`!!document.querySelector('input.titleErrorInput')`)) throw new CliError('EXISTING_EDITOR', 'An existing video editor is open; inspect it and close its tab before preparing a new job');
    await waitFor(page, `!!document.querySelector('input.chunkUploader-input')`, 'logged-in video uploader', 30000);
    await stage('uploading_video');
    await page.setFileInput([manifest.video], 'input.chunkUploader-input');
    await waitFor(page, `document.body.innerText.includes('视频上传成功') && !!document.querySelector('input.titleErrorInput')`, 'completed video upload', 180000);
    await stage('uploading_cover');
    await page.click('.cover-button');
    await waitFor(page, `!!document.querySelector('#new-file')`, 'cover upload dialog');
    await page.setFileInput([manifest.cover], '#new-file');
    await waitFor(page, `document.body.innerText.includes('已选择1张')`, 'one uploaded cover');
    await clickText(page, '确定', '.select-dialog');
    await waitFor(page, `!!document.querySelector('.pic-cover')?.style.backgroundImage && ![...document.querySelectorAll('.select-dialog')].some(e => e.getBoundingClientRect().width>0)`, 'confirmed cover');
    await stage('filling_fields');
    await fillVerified(page, 'input.titleErrorInput', manifest.title);
    await fillVerified(page, 'textarea.abstract-main-textarea', manifest.body);
    const context=await page.evaluate(`(${liveContext.toString()})('sohu')`);
    if(!context.account?.id||!context.uploadIdentity)throw new CliError('ACCOUNT_UNVERIFIED','Cannot bind uploaded video before category selection');
    await stage('selecting_category',{checks:await page.evaluate(`(${sohuPreparedSnapshot.toString()})()`),account:context.account,mediaHash:digest({upload:context.uploadIdentity,cover:context.cover,video:context.video})});
    if(!manifest.category)throw new CliError('CATEGORY_REQUIRED','Video and cover uploaded; inspect the video category options and resume');
    await selectCategory(page, manifest.category);
    await clickText(page, manifest.declaration, 'label.el-radio');
    await stage('verifying_required_fields');
    const checks = await waitFor(page, `(() => {const s=(${sohuPreparedSnapshot.toString()})();return s.quota>0 && s.coverDialogClosed ? s : false})()`, 'video quota and ready editor', 30000);
    if (checks.title !== manifest.title || checks.body !== manifest.body) throw new CliError('FIELD_MISMATCH', 'Title or description changed');
    if (JSON.stringify(checks.category) !== JSON.stringify(manifest.category) || !checks.declarations.includes(manifest.declaration)) throw new CliError('REQUIRED_FIELD_MISMATCH', 'Category or declaration was not verified');
    if (!checks.videoUploaded || !checks.customCoverPresent || !checks.publishControlPresent || checks.publishControlDisabled) throw new CliError('EDITOR_NOT_READY', 'Uploaded video, cover or publish control is not ready');
    return { ...checks, visibility: 'public_platform_default', finalPublishClicked: false };
}

export const command = cli({
    site: 'sohu', name: 'publish-video', access: 'write',
    description: '准备搜狐号视频：上传视频封面、填写必填项，确认后提交并查询回执与状态',
    domain: 'mp.sohu.com', strategy: Strategy.COOKIE, navigateBefore: false, siteSession: 'persistent',
    args: [
        {name:'resume',valueRequired:true,help:'Resume a retained category-selection checkpoint'},
        {name:'category',valueRequired:true,help:'JSON [primary, secondary] for --resume'},
        { name: 'input', help: 'Path to video preparation JSON manifest' },
        { name: 'review', help: 'Review local job UUID and issue a 30-minute confirmation token' },
        { name: 'submit', help: 'Submit reviewed job UUID exactly once, after human approval' },
        { name: 'confirm', help: 'Exact token returned by --review' },
        { name: 'status', help: 'Query local job UUID and exact platform content ID' },
        { name: 'timeout', type: 'int', default: 300, help: 'Overall preparation timeout in seconds' },
        { name: 'prepare', type: 'bool', default: false, help: 'Prepare only; requires --input' },
    ],
    columns: ['recovery', 'status', 'job_id', 'submitted', 'account', 'content_id', 'confirmation', 'query_status', 'report', 'preview'],
    func: (page, kwargs) => {
        if(kwargs.resume)return resumeCategory(page,kwargs,'video',makeVideoAdapter('sohu',sohuPreparedSnapshot),sohuPreparedSnapshot);
        if(kwargs.category)throw new ArgumentError('--category requires --resume');
        if (kwargs.prepare && !kwargs.review && !kwargs.submit && !kwargs.status && !kwargs.confirm && kwargs.input) return prepareVideo(page, kwargs, 'sohu', prepareSohuVideo, makeVideoAdapter('sohu', sohuPreparedSnapshot).inspect);
        return videoJobAction(page, kwargs, 'sohu', makeVideoAdapter('sohu', sohuPreparedSnapshot));
    },
});
