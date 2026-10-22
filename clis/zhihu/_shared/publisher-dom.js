// UI contracts observed on 2026-10-19. No private framework state or HTTP writes.
export function publisherDOM(kind, action, operationId, ai, questionId = '', category = '', original = 'no') {
    const clean = value => String(value || '').replace(/\r\n?/g, '\n').replace(/\u00a0/g, ' ').replace(/[\u200b\ufeff]/g, '').trim();
    const visible = node => {
        for (let n = node; n; n = n.parentElement) {
            const s = getComputedStyle(n);
            if (n.hidden || n.getAttribute('aria-hidden') === 'true' || s.display === 'none' || s.visibility === 'hidden') return false;
        }
        return true;
    };
    if (/^\/(signin|signup|account\/unhuman)(\/|$)/.test(location.pathname)) return { error: 'auth' };
    const article = kind === 'article', answer = kind === 'answer';
    const valid = article ? location.origin === 'https://zhuanlan.zhihu.com' && /^\/(write|p\/\d+\/edit)\/?$/.test(location.pathname)
        : location.origin === 'https://www.zhihu.com' && (answer ? new RegExp('^/question/' + questionId + '(?:/answer/\\d+)?/?$').test(location.pathname) : location.pathname === '/upload-video');
    if (!valid) return { error: 'wrong_editor', url: location.href };
    let root = document.querySelector('main');
    if (answer) {
        const forms = [...document.querySelectorAll('form.AnswerForm')].filter(visible);
        if (forms.length !== 1) return { error: 'editor_loading' };
        root = forms[0].closest('#js-answerAddCard, #AnswerFormPortalContainer') || forms[0];
    }
    if (!root) return { error: 'editor_loading' };
    const editors = [...root.querySelectorAll('.public-DraftEditor-content[contenteditable="true"]')].filter(visible);
    const titles = answer ? [] : [...root.querySelectorAll(article ? 'textarea[placeholder^="请输入标题"]' : 'textarea[name="title"]')].filter(visible);
    const buttons = [...root.querySelectorAll('button')].filter(visible);
    const text = clean(root.innerText || root.textContent);
    const blocked = /验证码|安全验证|操作过于频繁|上传失败|处理失败/.test(text) || [...document.querySelectorAll('[role="dialog"]')].some(n => visible(n) && /协议|条款|同意/.test(n.textContent));
    const editor = editors.length === 1 ? editors[0] : null;
    const blocks = editor ? [...editor.querySelectorAll('[data-block="true"]')].filter(n => !n.closest('figure')) : [];
    const body = editor ? clean(blocks.length ? blocks.map(n => n.textContent).join('\n') : editor.innerText || editor.textContent) : null;
    const images = editor ? [...editor.querySelectorAll('img')] : [];
    const imageKeys = images.map(n => { try { return new URL(n.src).pathname.match(/v2-[a-f0-9]+/i)?.[0] || new URL(n.src).pathname; } catch { return ''; } });
    const coverImages = [...root.querySelectorAll('img[alt="封面图"]')];
    const coverKey = coverImages.length === 1 && coverImages[0].complete && coverImages[0].naturalWidth > 0 ? (new URL(coverImages[0].src).pathname.match(/v2-[a-f0-9]+/i)?.[0] || new URL(coverImages[0].src).pathname) : null;
    const imageReady = images.every(n => n.complete && n.naturalWidth > 0);
    const tips = [...root.querySelectorAll('.DraftStatusTip')].filter(visible);
    const saving = !!root.querySelector('.ZDI--CloudUpArrow24') || [...root.querySelectorAll('div,span')].some(n => !editor?.contains(n) && visible(n) && clean(n.textContent) === '草稿保存中');
    const saveState = tips.some(n => /失败/.test(n.textContent)) ? 'failed' : saving || tips.some(n => /保存中/.test(n.textContent)) ? 'saving'
        : tips.length === 1 && /草稿/.test(tips[0].textContent) ? 'saved' : tips.length === 0 ? 'not_shown' : 'unknown';
    const saved = saveState === 'saved';
    const labels = [...root.querySelectorAll('label, div')].filter(n => (n.tagName === 'LABEL' || n.children.length === 0) && clean(n.textContent) === (kind === 'video' ? '视频标记' : '创作声明'));
    let declaration = null;
    if (labels.length === 1) {
        for (let n = labels[0].parentElement; n && root.contains(n); n = n.parentElement) {
            const controls = [...n.querySelectorAll('button[aria-haspopup]')].filter(visible);
            if (controls.length === 1) { declaration = controls[0]; break; }
            if (controls.length > 1) break;
        }
    }
    const expected = kind === 'video' ? (ai === 'yes' ? '含 AI 生成内容' : '内容无需标注') : (ai === 'yes' ? '包含 AI 辅助创作 作者对内容负责' : '无声明');
    const aiSelected = declaration && clean(declaration.textContent) === expected;
    const files = [...root.querySelectorAll('input[type="file"]')];
    const publishLabel = article ? '发布' : answer ? '发布回答' : '发布视频';
    const submit = buttons.filter(n => clean(n.textContent) === publishLabel && !n.disabled && n.getAttribute('aria-disabled') !== 'true');
    const ready = !!editor && (answer || titles.length === 1) && (kind !== 'video' || /上传成功/.test(text)) && !/上传中|转码中|处理中/.test(text);
    const mark = (nodes, key) => {
        if (nodes.length !== 1) return null;
        const value = operationId + ':' + key;
        for (const old of document.querySelectorAll('[data-bycli-zhihu-action]')) if (old.getAttribute('data-bycli-zhihu-action') === value) old.removeAttribute('data-bycli-zhihu-action');
        nodes[0].setAttribute('data-bycli-zhihu-action', value);
        return `[data-bycli-zhihu-action="${value}"]`;
    };
    let selector = null;
    if (!blocked && action === 'title') selector = mark(titles, action);
    if (!blocked && action === 'body' && editor) selector = mark([editor], action);
    if (!blocked && action === 'images') selector = mark(files.filter(n => (n.accept || '').startsWith('image/webp')), action);
    if (!blocked && ['cover', 'reset-cover'].includes(action)) {
        const covers = files.filter(n => /^\.jpeg,\s*\.jpg,\s*\.png$/.test(n.accept || ''));
        if (action === 'reset-cover' && covers.length === 1) covers[0].value = '';
        selector = mark(covers, 'cover');
    }
    if (!blocked && action === 'upload') selector = mark(files.filter(n => /\.mp4/.test(n.accept || '')), action);
    const videoItems = [...root.querySelectorAll('.VideoUploadForm-item')];
    const item = name => videoItems.filter(n => [...n.querySelectorAll('.VideoUploadForm-itemTitle')].some(x => clean(x.textContent) === name));
    const categories = item('所属领域').flatMap(n => [...n.querySelectorAll('button[role="combobox"]')]);
    const originals = item('原创视频').flatMap(n => [...n.querySelectorAll('input[type="checkbox"]')]);
    const categorySelected = categories.length === 1 && clean(categories[0].textContent) === category;
    const originalSelected = originals.length === 1 && originals[0].checked === (original === 'yes');
    if (!blocked && action === 'original' && !originalSelected && originals.length === 1) selector = mark(originals, action);
    if (!blocked && action === 'category' && !categorySelected && categories.length === 1) {
        const trigger = categories[0];
        if (trigger.getAttribute('aria-expanded') !== 'true') selector = mark([trigger], action);
        else {
            const menu = document.getElementById(trigger.id.replace(/-toggle$/, '-content'));
            selector = mark(menu ? [...menu.querySelectorAll('[role="option"]')].filter(n => visible(n) && clean(n.textContent) === category) : [], action);
        }
    }
    if (!blocked && action === 'ai' && kind === 'video' && !aiSelected) {
        const modals = [...document.querySelectorAll('.VideoUploadForm-videoTypeModalContent')].filter(visible);
        if (modals.length === 1) {
            const options = [...modals[0].querySelectorAll('[role="button"]')].filter(visible);
            const chosen = options.filter(n => n.querySelector('.ZDI--CheckFill24'));
            const desired = options.filter(n => clean(n.textContent) === expected);
            if (chosen.length === 1 && clean(chosen[0].textContent) === expected) selector = mark([...modals[0].querySelectorAll('button')].filter(n => clean(n.textContent) === '确认'), action);
            else if (desired.length === 1 && !desired[0].querySelector('.ZDI--CheckFill24')) selector = mark(desired, action);
        } else if (!modals.length) selector = mark([...root.querySelectorAll('button[aria-label="选择视频标记"]')].filter(visible), action);
    }
    if (!blocked && action === 'ai' && kind !== 'video' && declaration && !aiSelected) {
        if (declaration.getAttribute('aria-expanded') !== 'true') selector = mark([declaration], action);
        else {
            const menuId = declaration.getAttribute('aria-controls') || declaration.id.replace(/-toggle$/, '-content');
            const menu = menuId ? document.getElementById(menuId) : null;
            selector = mark(menu ? [...menu.querySelectorAll('[role="option"]')].filter(n => visible(n) && clean(n.textContent) === expected) : [], action);
        }
    }
    const success = [...document.querySelectorAll('div,span,h1,h2,h3')].some(n => visible(n) && !n.closest('.public-DraftEditor-content') && clean(n.textContent) === '发布成功');
    const modalOpen = [...document.querySelectorAll('[role="dialog"], [aria-modal="true"], .VideoUploadForm-videoTypeModalContent')].some(visible);
    if (!blocked && !success && !modalOpen && action === 'submit' && ready && aiSelected && (kind !== 'video' || categorySelected && originalSelected)) selector = mark(submit, action);
    if (action === 'bind') document.documentElement.setAttribute('data-bycli-zhihu-operation', operationId);
    const articleId = article ? location.pathname.match(/^\/p\/(\d+)\/edit/)?.[1] : null;
    const videoDraftId = kind === 'video' ? new URL(location.href).searchParams.get('id') : null;
    const answerId = answer ? location.pathname.match(/\/answer\/(\d+)/)?.[1] : null;
    const detailLinks = [...document.querySelectorAll('a[href]')].filter(n => visible(n) && clean(n.textContent) === '查看详情').map(n => n.href);
    return { url: location.href, operation_id: document.documentElement.getAttribute('data-bycli-zhihu-operation'),
        ready, blocked, title: titles.length === 1 ? titles[0].value : null, body, image_count: images.length, images_ready: imageReady,
        category_selected: categorySelected, original_selected: originalSelected, image_keys: imageKeys, cover_key: coverKey, save_state: saveState, saved, ai_selected: !!aiSelected, ai_label: clean(declaration?.textContent), selector,
        draft_id: articleId || videoDraftId || null, answer_id: answerId || null,
        success, detail_links: detailLinks,
        // A selected file is not proof that an uploaded cover persisted.
        cover_selected: files.some(n => /^\.jpeg,\s*\.jpg,\s*\.png$/.test(n.accept || '') && n.files?.length),
    };
}
export const publisherScript = (kind, action, op) => `(${publisherDOM.toString()})(${[kind, action, op.operation_id, op.ai_generated, op.question_id || '', op.category || '', op.original || 'no'].map(x => JSON.stringify(x)).join(',')})`;
