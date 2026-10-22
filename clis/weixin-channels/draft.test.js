import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { draftReceipt, savedDraftId, savedDraftScript } from './_shared/draft.js';

const receipt = () => ({ url: 'https://channels.weixin.qq.com/micro/content/cgi-bin/mmfinderassistant-bin/post/post_draft',
  method: 'POST', responseStatus: 201, timestamp: 100, responsePreview: JSON.stringify({ errCode: 0, data: { objectId: 'export/exact_draft' } }) });

describe('Channels native platform draft identity', () => {
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
  it('selects only the exact saved card and rejects changed content', () => {
    const dom = new JSDOM('<div class="post-draft-item"><span class="icon-edit"></span></div>',
      { url: 'https://channels.weixin.qq.com/platform/post/draftListManager', runScripts: 'outside-only' });
    const card = dom.window.document.querySelector('.post-draft-item');
    card.__vue__ = { $props: { post: { objectId: 'export/exact_draft', desc: { description: 'saved text' } } } };
    expect(dom.window.eval(savedDraftScript('export/exact_draft', 'saved text'))).toMatchObject({ matches: 1, id: 'export/exact_draft' });
    expect(dom.window.eval(savedDraftScript('export/other', 'saved text'))).toMatchObject({ matches: 0 });
    card.__vue__.$props.post.desc.description = 'saved text\n';
    expect(dom.window.eval(savedDraftScript('export/exact_draft', 'saved text'))).toMatchObject({ matches: 1 });
    card.__vue__.$props.post.desc.description = 'saved text ';
    expect(dom.window.eval(savedDraftScript('export/exact_draft', 'saved text'))).toMatchObject({ error: 'draft_content_changed' });
    expect(dom.window.eval(savedDraftScript('export/exact_draft', 'changed'))).toMatchObject({ error: 'draft_content_changed' });
    dom.window.close();
  });
});
