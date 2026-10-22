import { CommandExecutionError, TimeoutError } from '@sovovs/bycli/errors';
import { sameDescription } from './description.js';

const SAVE_PATH = '/micro/content/cgi-bin/mmfinderassistant-bin/post/post_draft';

export function draftReceipt(entry, started) {
  let url, body;
  try { url = new URL(entry.url); body = JSON.parse(entry.responsePreview); } catch { return null; }
  if (url.origin !== 'https://channels.weixin.qq.com' || url.pathname !== SAVE_PATH
    || entry.method !== 'POST' || entry.responseStatus !== 201 || entry.responseBodyTruncated
    || !Number.isFinite(Number(entry.timestamp)) || Number(entry.timestamp) < started
    || body.errCode !== 0 || !/^export\/[\w-]+$/.test(body.data?.objectId || '')) return null;
  return body.data.objectId;
}

// Do not drain capture until the native iframe request has completed: reading
// a pending CDP entry consumes it before its response body becomes available.
export function draftSaveCompleteScript(started) {
  return `(() => {
    const frames = [window, ...[...document.querySelectorAll('iframe')].map(f => f.contentWindow)];
    return frames.some(w => { try {
      return w.location.origin === 'https://channels.weixin.qq.com' && w.performance.getEntriesByType('resource').some(e => {
        const u = new URL(e.name);
        return u.origin === 'https://channels.weixin.qq.com' && u.pathname === ${JSON.stringify(SAVE_PATH)}
          && w.performance.timeOrigin + e.startTime >= ${JSON.stringify(started)} && e.responseEnd > 0;
      });
    } catch { return false; } });
  })()`;
}

export async function savedDraftId(page, started, timeout, wait) {
  const deadline = wait?.deadline ?? Date.now() + timeout * 1000;
  const stage = await wait?.stage('draft-save-receipt');
  while (Date.now() < deadline) {
    await stage?.observe({ receipt: 'pending' });
    if (await page.evaluate(draftSaveCompleteScript(started))) {
      await page.wait(0.25);
      const ids = new Set((await page.readNetworkCapture()).map(e => draftReceipt(e, started)).filter(Boolean));
      if (ids.size === 1) return [...ids][0];
      throw new CommandExecutionError('Native draft save did not return one exact successful receipt; inspect the draft box, never save again automatically');
    }
    await page.wait(0.5);
  }
  throw new TimeoutError('Platform draft save receipt', timeout, 'Original editor retained; inspect the draft box without saving again');
}

export function savedDraftScript(id, description) {
  return `(() => {
    if (location.origin !== 'https://channels.weixin.qq.com' || location.pathname !== '/platform/post/draftListManager') return {error:'wrong_draft_box'};
    const roots = [document];
    for (let i=0;i<roots.length;i++) for (const el of roots[i].querySelectorAll('*')) if (el.shadowRoot) roots.push(el.shadowRoot);
    const cards = roots.flatMap(r => [...r.querySelectorAll('.post-draft-item')]).filter(e => e.__vue__?.$props?.post?.objectId === ${JSON.stringify(id)});
    if (cards.length !== 1) return {matches:cards.length};
    const card = cards[0], post = card.__vue__.$props.post;
    if (!(${sameDescription.toString()})(post.desc?.description, ${JSON.stringify(description)})) return {error:'draft_content_changed'};
    const controls = [...card.querySelectorAll('.icon-edit')];
    if (controls.length !== 1) return {error:'ambiguous_draft_editor'};
    controls[0].setAttribute('data-bycli-channels-draft-edit','true');
    return {matches:1, id:post.objectId, selector:'[data-bycli-channels-draft-edit="true"]'};
  })()`;
}

export async function openSavedDraft(page, op, timeout, wait) {
  // Use the platform's exact card edit control rather than constructing an
  // undocumented editor URL or inferring a draft from its title.
  await page.goto(`https://channels.weixin.qq.com/platform/post/draftListManager?bycli_draft=${encodeURIComponent(op.operation_id)}`, { stealth: false });
  const deadline = wait?.deadline ?? Date.now() + timeout * 1000;
  const stage = await wait?.stage('draft-box');
  while (Date.now() < deadline) {
    const state = await page.evaluate(savedDraftScript(op.source_draft_id, op.description));
    await stage?.observe({ matches: state?.matches ?? 0, error: state?.error ?? null });
    if (state?.error) throw new CommandExecutionError(`Saved draft could not be verified: ${state.error}`);
    if (state?.matches === 1 && state.selector) {
      await page.focusWindow?.(); await page.click(state.selector); return;
    }
    await page.wait(0.5);
  }
  throw new TimeoutError('Exact saved draft in platform draft box', timeout);
}
