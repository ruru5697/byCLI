import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { draftReceipt, savedDraftId, savedDraftScript } from './_shared/draft.js';

const receipt = () => ({ url: 'https://channels.weixin.qq.com/micro/content/cgi-bin/mmfinderassistant-bin/post/post_draft',
  method: 'POST', responseStatus: 201, timestamp: 100, responsePreview: JSON.stringify({ errCode: 0, data: { objectId: 'export/exact_draft' } }) });

describe('Channels native platform draft identity', () => {
  it('reads the exact CDP receipt after native save replaced the editor document with the draft box', async () => {
    const dom = new JSDOM('', { url: 'https://channels.weixin.qq.com/platform/post/draftListManager', runScripts: 'outside-only' });
    const page = { evaluate: async script => dom.window.eval(script), wait: async () => {}, readNetworkCapture: async () => [receipt()] };
    expect(await savedDraftId(page, 100, 1)).toBe('export/exact_draft'); dom.window.close();
  });
  it('does not treat draft-box navigation alone as a successful save', async () => {
    const dom = new JSDOM('', { url: 'https://channels.weixin.qq.com/platform/post/draftListManager', runScripts: 'outside-only' });
    const page = { evaluate: async script => dom.window.eval(script), wait: async () => {}, readNetworkCapture: async () => [] };
    await expect(savedDraftId(page, 100, 1)).rejects.toThrow('one exact successful receipt'); dom.window.close();
  });
  it('accepts the observed save response without inferring an ID from the title', () => {
    expect(draftReceipt(receipt(), 100)).toBe('export/exact_draft');
  });
  it.each([
    { timestamp: 99 }, { responseStatus: 500 }, { responseBodyTruncated: true },
    { url: 'https://example.com/micro/content/cgi-bin/mmfinderassistant-bin/post/post_draft' },
    { responsePreview: '{"errCode":1,"data":{"objectId":"export/not_saved"}}' },
    { responsePreview: '{"errCode":0,"data":{"objectId":123}}' },
  ])('rejects stale, failed or unrelated receipt %j', fields => {
    expect(draftReceipt({ ...receipt(), ...fields }, 100)).toBeNull();
  });
  it('waits for completion before draining capture and refuses ambiguous receipts', async () => {
    let polls = 0, drains = 0;
    const page = { evaluate: async () => ++polls > 1, wait: async () => {}, readNetworkCapture: async () => {
      drains++; expect(polls).toBe(2); return [receipt(), { ...receipt(), responsePreview: '{"errCode":0,"data":{"objectId":"export/other"}}' }];
    } };
    await expect(savedDraftId(page, 100, 1)).rejects.toThrow('one exact'); expect(drains).toBe(1);
  });
  it.each([
    ['saved text\n', 'saved text', true],
    ['saved text\n', 'saved text\n\n', true],
    ['saved text\u00a0\n', 'saved text', true],
    [' saved text\n', 'saved text', false],
    ['saved\ntext\n', 'saved text', false],
    ['changed text\n', 'saved text', false],
  ])('ignores only trailing rich-text whitespace for %j against %j', (stored, expected, matches) => {
    const dom = new JSDOM('<div class="post-draft-item"><span class="icon-edit"></span></div>',
      { url: 'https://channels.weixin.qq.com/platform/post/draftListManager', runScripts: 'outside-only' });
    dom.window.document.querySelector('.post-draft-item').__vue__ = {
      $props: { post: { objectId: 'export/exact_draft', desc: { description: stored } } },
    };
    const state = dom.window.eval(savedDraftScript('export/exact_draft', expected));
    expect(state).toMatchObject(matches ? { matches: 1, id: 'export/exact_draft' } : { error: 'draft_content_changed' });
    dom.window.close();
  });
  it('selects only the exact saved card and rejects changed content', () => {
    const dom = new JSDOM('<div class="post-draft-item"><span class="icon-edit"></span></div>',
      { url: 'https://channels.weixin.qq.com/platform/post/draftListManager', runScripts: 'outside-only' });
    const card = dom.window.document.querySelector('.post-draft-item');
    card.__vue__ = { $props: { post: { objectId: 'export/exact_draft', desc: { description: 'saved text' } } } };
    expect(dom.window.eval(savedDraftScript('export/exact_draft', 'saved text'))).toMatchObject({ matches: 1, id: 'export/exact_draft' });
    expect(dom.window.eval(savedDraftScript('export/other', 'saved text'))).toMatchObject({ matches: 0 });
    expect(dom.window.eval(savedDraftScript('export/exact_draft', 'changed'))).toMatchObject({ error: 'draft_content_changed' });
    dom.window.close();
  });
});
