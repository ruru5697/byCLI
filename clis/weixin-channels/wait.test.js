import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { log } from '@sovovs/bycli/logger';
import { publishWait, videoObservation } from './_shared/wait.js';
import { savedDraftId } from './_shared/draft.js';

let now;
beforeEach(() => {
  now = 1000; vi.spyOn(Date, 'now').mockImplementation(() => now);
  vi.spyOn(log, 'info').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('Channels wait budgets', () => {
  it('reports the last known stage while a browser call is pending and stops heartbeats on cleanup', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const wait = publishWait(900, { heartbeat: true });
    await wait.stage('video-file-selection');
    expect(log.info).toHaveBeenCalledTimes(1);
    now += 15000; await vi.advanceTimersByTimeAsync(15000);
    expect(log.info).toHaveBeenCalledTimes(2);
    expect(log.info.mock.calls[1][0]).toContain('video-file-selection');
    wait.close(); now += 15000; await vi.advanceTimersByTimeAsync(15000);
    expect(log.info).toHaveBeenCalledTimes(2);
  });
  it('stops unchanged observations at the idle limit even with 900s available', async () => {
    const updates = [], wait = publishWait(900, { onUpdate: async s => updates.push(s) });
    const stage = await wait.stage('crop-response', 5);
    await stage.observe({ cropping: true }); now += 5000;
    await expect(stage.observe({ cropping: true })).rejects.toMatchObject({ code: 'TIMEOUT', hint: expect.stringContaining('cropping') });
    expect(updates.at(-1)).toMatchObject({ stage: 'crop-response', idle_seconds: 5, observation: { cropping: true } });
  });
  it('does not reset idle time for repeated A/B states or observation-only timestamps', async () => {
    const stage = await publishWait(900).stage('preview', 5);
    for (let second = 0; second < 6; second++) {
      now = 1000 + second * 1000;
      await stage.observe({ heartbeat: now }, { loaded: second % 2 === 0 });
    }
    now = 7000;
    await expect(stage.observe({ heartbeat: now }, { loaded: true })).rejects.toThrow('no progress');
  });
  it('allows actual progress past 60s, emits heartbeats, then stops when progress ceases', async () => {
    const stage = await publishWait(900).stage('upload', 60);
    for (let percent = 0; percent <= 100; percent += 10) {
      now = 1000 + percent * 1000; await stage.observe({ percent });
    }
    expect(log.info.mock.calls.length).toBeGreaterThan(5);
    now += 60000; await expect(stage.observe({ percent: 100 })).rejects.toThrow('no progress');
  });
  it('shares the total deadline across stage transitions even with continuous progress', async () => {
    const wait = publishWait(10);
    await wait.stage('upload'); now += 9000;
    const stage = await wait.stage('cover'); await stage.observe({ ready: false });
    now += 1000;
    await expect(stage.observe({ ready: true })).rejects.toThrow('Weixin Channels operation');
    expect(wait.deadline).toBe(11000);
  });
  it('bounds a missing draft receipt without draining or replaying the save', async () => {
    const page = { evaluate: vi.fn(async () => false), readNetworkCapture: vi.fn(),
      wait: async seconds => { now += seconds * 1000; } };
    await expect(savedDraftId(page, now, 900)).rejects.toThrow('draft-save-receipt: no progress');
    expect(now).toBe(31000); expect(page.readNetworkCapture).not.toHaveBeenCalled();
  });
  it('excludes content and source URLs from video diagnostics', () => {
    expect(videoObservation({ description: 'private text', url: 'https://example.com/?token=secret',
      videos: [{ ready_state: 1, src: 'private-blob' }], processing: 'uploading', progress_percent: 25 })).toEqual({
      ready: false, ai_selected: false, cover_pending: false, editors_count: 0,
      processing: 'uploading', progress_percent: 25, video_ready_state: 1,
    });
  });
});
