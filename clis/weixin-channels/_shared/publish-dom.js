// UI observations from 2026-10-19. Local regression-tested, not live acceptance.
export function inspectPublishPage(action, operationId, expectedAi) {
  const roots = [];
  function visit(root) {
    roots.push(root);
    for (const el of root.querySelectorAll('*')) if (el.shadowRoot) visit(el.shadowRoot);
  }
  visit(document);
  const displayed = (el, checkOpacity) => {
    for (let n = el; n; n = n.parentElement || n.getRootNode()?.host) {
      const s = getComputedStyle(n);
      if (n.hidden || n.getAttribute('aria-hidden') === 'true' || s.display === 'none' || s.visibility === 'hidden' || (checkOpacity && s.opacity === '0')) return false;
    }
    return true;
  };
  const visible = el => displayed(el, true);
  if (location.origin !== 'https://channels.weixin.qq.com') return { error: 'wrong_origin' };
  if (/\/login(?:\/|$)/.test(location.pathname)) return { error: 'login_required' };
  const inputs = roots.flatMap(r => [...r.querySelectorAll('input[type="file"]')])
    .filter(x => /video/i.test(x.getAttribute('accept') || ''));
  if (location.pathname !== '/platform/post/create') return { error: 'wrong_editor_path', path: location.pathname };
  if (inputs.length === 0) return { error: 'editor_loading' };
  if (inputs.length !== 1) return { error: 'ambiguous_video_input' };
  const root = inputs[0].getRootNode();
  const elements = [...root.querySelectorAll('*')].filter(visible);
  const leaf = text => elements.filter(x => x.children.length === 0 && x.textContent.trim() === text);
  const text = elements.filter(x => x.children.length === 0).map(x => x.textContent.trim()).join('\n');
  const blocked = /验证码|安全验证|管理员本人验证|扫码验证|不能发表视频|不是.*管理员|上传失败|处理失败/.test(text)
    || elements.some(x => x.matches('[role="dialog"], .weui-dialog') && /同意|条款|协议/.test(x.textContent));
  const editors = elements.filter(x => x.matches('[contenteditable="true"],[contenteditable=""],[contenteditable="plaintext-only"]'));
  const videos = [...root.querySelectorAll('video')];
  const stores = [...root.querySelectorAll('.post-edit-wrap')].map(n => n.__vue__?.$props?.postStore).filter(Boolean);
  const draftIds = stores.flatMap(s => [s.defaultValue?.objectId, s.tempPost?.objectId]).filter(x => typeof x === 'string' && /^export\/[\w-]+$/.test(x));
  const draftId = draftIds.length === 2 && draftIds[0] === draftIds[1] ? draftIds[0] : null;
  const ready = videos.some(x => x.readyState >= 1 && Number.isFinite(x.duration) && x.duration > 0)
    && !/上传中|转码中|处理中|上传失败|处理失败/.test(text);
  const labels = leaf('视频标注');
  const control = labels.length === 1 ? labels[0].parentElement.nextElementSibling : null;
  // Only the selected, rendered label counts; a hidden menu option is not proof.
  const expected = expectedAi === 'yes' ? '含AI生成内容' : '无需标注';
  const choices = control ? [...control.querySelectorAll('*')].filter(x => visible(x) && x.children.length === 0) : [];
  const aiSelected = choices.some(x => x.textContent.trim() === expected)
    && !choices.some(x => x.textContent.trim() === '选择视频标注');
  const publishButtons = elements.filter(x => x.matches('button') && x.textContent.trim() === '发表');
  const coverPending = /封面生成中|生成中/.test(text);
  const enabledPublish = publishButtons.filter(x => !x.disabled && x.getAttribute('aria-disabled') !== 'true' && !/disabled/.test(x.className));
  const canSubmit = ready && aiSelected && editors.length === 1 && !coverPending && enabledPublish.length === 1;
  const processing = /上传中/.test(text) ? 'uploading' : /转码中/.test(text) ? 'transcoding' : /处理中/.test(text) ? 'processing' : null;
  const progressValues = elements.filter(e => e.matches('progress,[role="progressbar"]')).map(e => {
    if (e.matches('progress')) return e.hasAttribute('value') ? e.value / e.max * 100 : null;
    if (!e.hasAttribute('aria-valuenow')) return null;
    const value = Number(e.getAttribute('aria-valuenow')), min = Number(e.getAttribute('aria-valuemin') ?? 0);
    const max = Number(e.getAttribute('aria-valuemax') ?? 100);
    return Number.isFinite(value) && max > min ? (value - min) / (max - min) * 100 : null;
  }).filter(n => n !== null && n >= 0 && n <= 100);
  const mark = (el, name) => {
    for (const old of root.querySelectorAll('[data-bycli-channels-action]')) {
      if (old.getAttribute('data-bycli-channels-action') === name) old.removeAttribute('data-bycli-channels-action');
    }
    el.setAttribute('data-bycli-channels-action', name); return `[data-bycli-channels-action="${name}"]`;
  };
  let selector = null;
  if (!blocked && action === 'input') selector = mark(inputs[0], 'input');
  if (!blocked && action === 'editor' && editors.length === 1) selector = mark(editors[0], 'editor');
  if (!blocked && action === 'ai') {
    // Never click a legal/originality agreement or arbitrary text on the page.
    const options = control ? leaf(expected).filter(x => control.contains(x)) : [];
    const placeholders = control ? leaf('选择视频标注').filter(x => control.contains(x)) : [];
    const menuOpening = control && [...control.querySelectorAll('*')].some(x => x.children.length === 0 && x.textContent.trim() === expected && displayed(x, false));
    if (!aiSelected && options.length === 1) selector = mark(options[0], 'ai');
    else if (!aiSelected && !menuOpening && placeholders.length === 1) selector = mark(placeholders[0], 'ai');
  }
  if (!blocked && action === 'submit' && canSubmit) {
    selector = mark(enabledPublish[0], 'submit');
  }
  if (!blocked && action === 'save-draft' && ready && editors.length === 1) {
    const buttons = elements.filter(x => x.matches('button') && x.textContent.trim() === '保存草稿'
      && !x.disabled && x.getAttribute('aria-disabled') !== 'true' && !/disabled/.test(x.className));
    if (buttons.length === 1) selector = mark(buttons[0], 'save-draft');
  }
  if (action === 'bind') document.documentElement.setAttribute('data-bycli-channels-operation', operationId);
  return {
    url: location.href, operation_id: document.documentElement.getAttribute('data-bycli-channels-operation'), draft_id: draftId,
    blocked, ready, description: editors.length === 1 ? editors[0].innerText || editors[0].textContent : null,
    ai_selected: aiSelected, selector, success: /发表成功|发布成功|提交成功/.test(text),
    input_files: [...(inputs[0].files || [])].map(f => ({ name: f.name, size: f.size })),
    editors_count: editors.length,
    videos: videos.map(v => ({ ready_state: v.readyState, duration: Number.isFinite(v.duration) ? v.duration : null })),
    cover_pending: coverPending,
    processing, progress_percent: progressValues.length === 1 ? Math.floor(progressValues[0]) : null,
    can_submit: canSubmit,
    publish_buttons: publishButtons.map(b => ({ disabled: b.disabled, aria_disabled: b.getAttribute('aria-disabled'), classes: b.className })),
  };
}

export function publishScript(action, id, ai) {
  return `(${inspectPublishPage.toString()})(${JSON.stringify(action)},${JSON.stringify(id)},${JSON.stringify(ai)})`;
}

// Read only the local preview blob, never a signed remote media URL. Explicit
// recovery can prove file identity even when Chrome has lost the input/marker.
export async function previewFingerprintDOM() {
  if (location.origin !== 'https://channels.weixin.qq.com' || location.pathname !== '/platform/post/create') return { error: 'wrong_editor' };
  const roots = [document];
  for (let i = 0; i < roots.length; i++) for (const el of roots[i].querySelectorAll('*')) if (el.shadowRoot) roots.push(el.shadowRoot);
  const inputs = roots.flatMap(r => [...r.querySelectorAll('input[type="file"]')]).filter(n => /video/i.test(n.accept));
  if (inputs.length !== 1) return { error: 'ambiguous_video_input' };
  const urls = [...new Set([...inputs[0].getRootNode().querySelectorAll('video')].filter(v => v.readyState >= 1)
    .map(v => v.currentSrc || v.src).filter(url => url.startsWith('blob:https://channels.weixin.qq.com/')))];
  if (urls.length !== 1) return { error: 'unique_local_preview_required' };
  try {
    const response = await fetch(urls[0]);
    if (!response.ok) return { error: 'preview_unreadable' };
    const blob = await response.blob();
    if (!blob.size || blob.size > 256 * 1024 * 1024) return { error: 'preview_hash_size_limit_256MiB' };
    const hash = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
    return { sha256: [...new Uint8Array(hash)].map(x => x.toString(16).padStart(2, '0')).join(''), bytes: blob.size };
  } catch { return { error: 'preview_unreadable' }; }
}
