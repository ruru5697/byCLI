import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getRegistry } from '@sovovs/bycli/registry';
import './video-publish.js';

describe('weibo video-publish', () => {
  let video;

  beforeAll(() => {
    video = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bycli-weibo-video-')), 'clip.mp4');
    fs.writeFileSync(video, 'mp4');
  });

  afterAll(() => fs.rmSync(path.dirname(video), { recursive: true, force: true }));

  it('is dry-run by default and checks the video file without a browser', async () => {
    const command = getRegistry().get('weibo/video-publish');
    const rows = await command.func(null, { text: '测试视频', video });
    expect(rows[0]).toMatchObject({ status: 'dry-run', text: '测试视频', video });
  });

  it('rejects a missing or unsupported video before publishing', async () => {
    const command = getRegistry().get('weibo/video-publish');
    await expect(command.func(null, { text: '测试视频', video: 'missing-clip.mp4' })).rejects.toThrow(/Not a valid video file/);
    await expect(command.func(null, { text: '测试视频', video: video.replace(/mp4$/, 'avi') })).rejects.toThrow(/Unsupported video format/);
  });

  it('requires a browser before it can publish', async () => {
    const command = getRegistry().get('weibo/video-publish');
    await expect(command.func(null, { text: '测试视频', video, execute: true })).rejects.toThrow(/Browser session required/);
  });
});
