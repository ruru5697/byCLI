import { cli, Strategy } from '@sovovs/bycli/registry';
import { ArgumentError, CommandExecutionError } from '@sovovs/bycli/errors';
import { emptySearchResults, requireBoundedInteger, requireSearchQuery, runBrowserStep } from '../_shared/search-adapter.js';

const TYPES = ['all', 'blog', 'download', 'course']; const SORTS = ['relevance', 'latest', 'hot']; const TIMES = ['day', 'week', 'month', 'year'];
const RESULT_SELECTOR = '.search-result-info, .search-result, #app .result-list-panel .list-item';

export function buildSearchUrl({ keyword, limit = 10, page = 1, contentType = 'all', sort, time }) {
  const url = new URL('https://so.csdn.net/so/search'); url.searchParams.set('q', keyword); url.searchParams.set('p', String(page)); url.searchParams.set('t', contentType); url.searchParams.set('size', String(limit));
  if (sort) url.searchParams.set('sort', sort); if (time) url.searchParams.set('time', time); return url.toString();
}

function extractItems(selector) {
  const items = []; const seen = new Set();
  for (const card of document.querySelectorAll(selector)) {
    const anchor = card.querySelector('.card-title a[href], h3 a[href], h4 a[href]');
    if (!anchor || !/^https?:/i.test(anchor.href)) continue;
    const url = new URL(anchor.href);
    // A CSDN blog article is identified by its path, not search tracking fields.
    if (url.hostname === 'blog.csdn.net' && /^\/[^/]+\/article\/details\/\d+\/?$/.test(url.pathname)) { url.search = ''; url.hash = ''; }
    if (seen.has(url.href)) continue;
    const title = (anchor.textContent || '').trim(); if (!title) continue;
    seen.add(url.href); const time = card.querySelector('time');
    const date = (card.querySelector('.ctx-meta')?.textContent || '').match(/\b\d{4}-\d{2}-\d{2}\b/)?.[0];
    items.push({ rank: items.length + 1, title, url: url.href, snippet: (card.querySelector('.card-digest, .search-result-desc, p')?.textContent || '').trim(), displayUrl: url.hostname + url.pathname, source: 'csdn', resultType: url.hostname === 'blog.csdn.net' && /\/article\/details\//.test(url.pathname) ? 'article' : null, author: (card.querySelector('.meta-author, .author, .user-name')?.textContent || '').trim() || null, publishedAt: time?.getAttribute('datetime') || date || null, score: null, extra: {} });
  }
  const clone = document.body?.cloneNode(true); clone?.querySelectorAll('script, style, template').forEach(e => e.remove());
  const text = document.body?.innerText || clone?.textContent || '';
  // A header's 登录 link is not a login wall, including on an empty result page.
  const blocked = !items.length && /请登录后(?:搜索|继续|查看)|登录后才能(?:搜索|继续|查看)|访问异常|请完成.{0,12}验证|sign in to (?:continue|search)/i.test(text);
  const noResults = /(?:未找到|没有找到|暂无)[^。！？\n]{0,50}(?:结果|内容)/.test(text);
  return { blocked, noResults, items };
}

export const command = cli({
  site: 'csdn', name: 'search', access: 'read', description: 'Search CSDN', domain: 'so.csdn.net', strategy: Strategy.PUBLIC, browser: true,
  args: [{ name: 'keyword', positional: true, required: true, help: 'Search query' }, { name: 'limit', type: 'int', default: 10, help: 'Number of results (1-50)' }, { name: 'page', type: 'int', default: 1, help: 'Result page number' }, { name: 'content-type', help: 'Content type: all, blog, download, course' }, { name: 'sort', help: 'Sort order: relevance, latest, hot' }, { name: 'time', help: 'Time range: day, week, month, year' }],
  columns: ['rank', 'title', 'url', 'snippet', 'displayUrl', 'source', 'resultType', 'author', 'publishedAt', 'score', 'extra'],
  func: async (page, kwargs) => {
    const keyword = requireSearchQuery(kwargs.keyword); const limit = requireBoundedInteger(kwargs.limit, 10, 1, 50, '--limit'); const pageNumber = requireBoundedInteger(kwargs.page, 1, 1, 100, '--page'); const contentType = kwargs['content-type'] ?? kwargs.contentType ?? 'all';
    if (!TYPES.includes(String(contentType))) throw new ArgumentError(`--content-type must be one of: ${TYPES.join(', ')}`); if (kwargs.sort && !SORTS.includes(String(kwargs.sort))) throw new ArgumentError(`--sort must be one of: ${SORTS.join(', ')}`); if (kwargs.time && !TIMES.includes(String(kwargs.time))) throw new ArgumentError(`--time must be one of: ${TIMES.join(', ')}`);
    await runBrowserStep('CSDN search navigation', () => page.goto(buildSearchUrl({ keyword, limit, page: pageNumber, contentType, sort: kwargs.sort, time: kwargs.time }))); await page.wait({ selector: RESULT_SELECTOR, timeout: 8 }).catch(() => page.wait(2).catch(() => {}));
    const data = await runBrowserStep('CSDN search extraction', () => page.evaluate(`(${extractItems.toString()})(${JSON.stringify(RESULT_SELECTOR)})`)); if (data?.blocked) throw new CommandExecutionError('CSDN search requires login or was blocked', 'Open CSDN in the browser, complete any prompt, and retry.');
    if (!data?.items?.length) { if (data?.noResults) throw emptySearchResults('CSDN', keyword); throw new CommandExecutionError('CSDN search result structure was not recognized or did not finish loading', 'Retain the search page structure for adapter diagnosis; no empty result or login failure was inferred.'); }
    return data.items.slice(0, limit).map((item, index) => ({ ...item, rank: (pageNumber - 1) * limit + index + 1 }));
  },
});

export const __test__ = { command, buildSearchUrl };
