/** Page snapshots used for overwrite protection and persisted draft verification. */
export async function readExistingDraft(page) {
    return page.evaluate(`
(() => {
  const visible = el => !!el && el.offsetParent !== null;
  const titleEl = [...document.querySelectorAll('textarea')].find(el => visible(el) && (el.placeholder || '').includes('请输入文章标题'));
  const editor = [...document.querySelectorAll('[contenteditable]')].find(el => visible(el));
  return { title: titleEl ? titleEl.value.trim() : '', bodyLength: editor ? editor.innerText.trim().length : 0 };
})()
`);
}

/** Read back what the platform restored after a reload; this is the only proof a draft exists. */
export async function readRestoredDraft(page) {
    const state = await page.evaluate(`
(() => {
  const visible = el => !!el && el.offsetParent !== null;
  const titleEl = [...document.querySelectorAll('textarea')].find(el => visible(el) && (el.placeholder || '').includes('请输入文章标题'));
  const editor = [...document.querySelectorAll('[contenteditable]')].find(el => visible(el));
  const covers = [...document.querySelectorAll('.article-cover-images img, .article-cover img')].filter(el => el.naturalWidth > 0);
  return {
    title: titleEl ? titleEl.value : '',
    body: editor ? editor.innerText : '',
    coverCount: covers.length,
    url: location.href,
  };
})()
`);
    return state ?? {};
}
