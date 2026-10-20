/** Export a Weibo long article (or long-text post) as Markdown/JSON. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { cli, Strategy } from '@sovovs/bycli/registry';
import { ArgumentError, CommandExecutionError, EmptyResultError } from '@sovovs/bycli/errors';
import { normalizeWeiboTarget, unwrapEvaluateResult } from './utils.js';

const DIRECT_ARTICLE_RE = /\/ttarticle\/(?:p\/show|x\/m\/show)(?:\/|$)/i;

function normalizeArticleUrl(value) {
    const input = String(value || '').trim();
    if (!input) return null;
    if (isDirectArticleUrl(input)) {
        try {
            const url = new URL(input);
            if (/^\/ttarticle\/x\/m\/show(?:\/|$)/i.test(url.pathname)) {
                const hashId = url.hash.match(/^#\/?id=([^&]+)/i)?.[1];
                const id = url.searchParams.get('id') || hashId;
                url.pathname = '/ttarticle/p/show';
                url.hash = '';
                url.search = id ? `?id=${encodeURIComponent(id)}` : '';
            }
            return url.href;
        } catch { /* fall through */ }
    }
    if (/^sinaweibo:\/\//i.test(input)) {
        try {
            const embedded = new URL(input).searchParams.get('url');
            if (embedded && isDirectArticleUrl(embedded)) return normalizeArticleUrl(embedded);
        } catch { /* fall through */ }
    }
    return null;
}

function isDirectArticleUrl(value) {
    const input = String(value || '').trim();
    if (!input) return false;
    try {
        const url = new URL(input);
        return /^https?:$/i.test(url.protocol)
            && /(^|\.)weibo\.(?:com|cn)$/i.test(url.hostname)
            && DIRECT_ARTICLE_RE.test(url.pathname);
    } catch {
        return false;
    }
}

/**
 * A shared status is not the article itself. Weibo puts the canonical long
 * article URL in page_info.page_url (field names vary between desktop builds),
 * so resolve that URL before falling back to the status text.
 */
function articleUrlFromStatus(status) {
    const pageInfo = status?.page_info || {};
    const candidates = [
        pageInfo.page_url,
        pageInfo.pageUrl,
        pageInfo.url,
        status?.article_url,
        status?.articleUrl,
    ];
    for (const candidate of candidates) {
        const normalized = normalizeArticleUrl(candidate);
        if (normalized) return normalized;
    }
    for (const entry of status?.url_struct || []) {
        const normalized = normalizeArticleUrl(entry?.long_url || entry?.h5_target_url || entry?.ori_url);
        if (normalized) return normalized;
    }
    return null;
}

function buildArticleDownloadScript(lookup, directUrl = null) {
    return `
      (async () => {
        const lookup = ${JSON.stringify(lookup)};
        const directUrl = ${JSON.stringify(directUrl)};
        const isArticleUrl = (value) => {
          try {
            const url = new URL(value, location.href);
            return /^https?:$/i.test(url.protocol)
              && /(^|\\.)weibo\\.(?:com|cn)$/i.test(url.hostname)
              && /\\/ttarticle\\/(?:p\\/show|x\\/m\\/show)(?:\\/|$)/i.test(url.pathname);
          } catch { return false; }
        };
        const normalizeArticleUrl = (value) => {
          const input = String(value || '').trim();
          if (isArticleUrl(input)) {
            const normalized = new URL(input, location.href);
            if (/^\\/ttarticle\\/x\\/m\\/show(?:\\/|$)/i.test(normalized.pathname)) {
              const hashId = normalized.hash.match(/^#\\/?id=([^&]+)/i)?.[1];
              const id = normalized.searchParams.get('id') || hashId;
              normalized.pathname = '/ttarticle/p/show';
              normalized.hash = '';
              normalized.search = id ? '?id=' + encodeURIComponent(id) : '';
            }
            return normalized.href;
          }
          if (/^sinaweibo:\\/\\//i.test(input)) {
            try {
              const embedded = new URL(input).searchParams.get('url');
              if (embedded && isArticleUrl(embedded)) return normalizeArticleUrl(embedded);
            } catch {}
          }
          return null;
        };
        const textFromNode = (node) => {
          const root = node.cloneNode(true);
          root.querySelectorAll('script,style,noscript,iframe').forEach((el) => el.remove());
          root.querySelectorAll('br').forEach((el) => el.replaceWith(document.createTextNode('\\n')));
          root.querySelectorAll('p,h1,h2,h3,h4,h5,h6,li,blockquote,pre,tr,hr').forEach((el) => el.appendChild(document.createTextNode('\\n')));
          return String(root.textContent || '')
            .replace(/\\u00a0/g, ' ')
            .replace(/\\r/g, '')
            .replace(/[ \\t]+\\n/g, '\\n')
            .replace(/\\n{3,}/g, '\\n\\n')
            .trim();
        };
        const parseArticle = (html, sourceUrl, fallback = {}) => {
          const doc = new DOMParser().parseFromString(html, 'text/html');
          const bodyNode = doc.querySelector('[node-type="contentBody"], .WB_editor_iframe_new, .article-content, article');
          if (!bodyNode) return null;
          const text = textFromNode(bodyNode);
          if (!text) return null;
          const pick = (selectors) => {
            for (const selector of selectors) {
              const value = doc.querySelector(selector)?.textContent?.trim();
              if (value) return value;
            }
            return '';
          };
          const user = fallback.user || {};
          return {
            id: String(fallback.idstr || fallback.id || ''),
            mblogid: String(fallback.mblogid || ''),
            url: fallback.statusUrl || sourceUrl,
            article_url: sourceUrl,
            title: pick(['[node-type="articleTitle"]', '.main_editor .title', 'meta[property="og:title"]']) || String(doc.title || '').trim(),
            author: pick(['.authorinfo .author1 em', '.authorinfo a[href*="/u/"]', 'meta[name="author"]']) || String(user.screen_name || ''),
            author_uid: String(user.idstr || user.id || ''),
            created_at: pick(['.authorinfo .time', 'time[datetime]']) || String(fallback.created_at || ''),
            text,
            is_article: true,
            image_urls: [...bodyNode.querySelectorAll('img[src]')].map((img) => img.src).filter(Boolean),
          };
        };
        const fetchArticle = async (url, fallback = {}) => {
          const normalizedUrl = normalizeArticleUrl(url);
          if (!normalizedUrl) return null;
          const response = await fetch(normalizedUrl, { credentials: 'include' });
          if (!response.ok) return null;
          return parseArticle(await response.text(), normalizedUrl, fallback);
        };
        const findArticleUrl = (value, depth = 0, seen = new Set()) => {
          if (depth > 8 || value == null) return null;
          if (typeof value === 'string') return normalizeArticleUrl(value);
          if (typeof value !== 'object' || seen.has(value)) return null;
          seen.add(value);
          for (const child of Object.values(value)) {
            const found = findArticleUrl(child, depth + 1, seen);
            if (found) return found;
          }
          return null;
        };

        if (directUrl) {
          return { article_url: normalizeArticleUrl(directUrl), is_article: true };
        }

        const resp = await fetch('/ajax/statuses/show?id=' + encodeURIComponent(lookup), { credentials: 'include' });
        if (resp.status === 401 || resp.status === 403) return { auth: true };
        if (!resp.ok) return { error: 'HTTP ' + resp.status };
        const status = await resp.json();
        if (!status.ok && !status.idstr && !status.id) return { missing: true };
        const user = status.user || {};
        const idValue = String(status.idstr || status.id || lookup);
        const mblogid = String(status.mblogid || '');
        const statusUrl = 'https://weibo.com/' + String(user.id || '') + '/' + mblogid;
        const pageInfo = status.page_info || {};
        const pageUrl = findArticleUrl(status);
        if (pageUrl) {
          const article = await fetchArticle(pageUrl, { ...status, idstr: idValue, mblogid, statusUrl });
          if (article) return article;
        }
        let text = status.text_raw || String(status.text || '').replace(/<[^>]+>/g, '').trim();
        const isArticle = Boolean(status.isLongText || status.is_long_text || pageInfo.type === 'article' || pageInfo.object_type === 'article' || pageUrl);
        if (status.isLongText || status.is_long_text) {
          try {
            const longResp = await fetch('/ajax/statuses/longtext?id=' + encodeURIComponent(idValue), { credentials: 'include' });
            if (longResp.ok) {
              const longData = await longResp.json();
              const longText = longData.data?.longTextContent || longData.longTextContent;
              if (longText) text = String(longText).replace(/<[^>]+>/g, '').trim();
            }
          } catch {}
        }
        return {
          id: idValue,
          mblogid,
          url: statusUrl,
          title: String(pageInfo.page_title || pageInfo.title || '').trim() || (isArticle ? String(text).split(/\\n/)[0].slice(0, 80) : ''),
          author: String(user.screen_name || ''),
          author_uid: String(user.idstr || user.id || ''),
          created_at: String(status.created_at || ''),
          text,
          article_url: pageUrl || null,
          is_article: isArticle,
        };
      })()
    `;
}

function buildArticlePageExtractScript(fallback = {}) {
    return `
      (() => {
        const textFromNode = (node) => {
          const root = node.cloneNode(true);
          root.querySelectorAll('script,style,noscript,iframe').forEach((el) => el.remove());
          root.querySelectorAll('br').forEach((el) => el.replaceWith(document.createTextNode('\\n')));
          root.querySelectorAll('p,h1,h2,h3,h4,h5,h6,li,blockquote,pre,tr,hr').forEach((el) => el.appendChild(document.createTextNode('\\n')));
          return String(root.textContent || '')
            .replace(/\\u00a0/g, ' ')
            .replace(/\\r/g, '')
            .replace(/[ \\t]+\\n/g, '\\n')
            .replace(/\\n{3,}/g, '\\n\\n')
            .trim();
        };
        const nodes = [...document.querySelectorAll('#article_content,[node-type="contentBody"],.WB_editor_iframe_new,.article-content,article')]
          .sort((a, b) => (b.innerText?.length || b.textContent?.length || 0) - (a.innerText?.length || a.textContent?.length || 0));
        const bodyNode = nodes[0];
        if (!bodyNode) return { error: 'article_body_not_loaded' };
        const text = textFromNode(bodyNode);
        if (!text || text.length < 100) return { error: 'article_body_not_loaded' };
        const pick = (selectors) => {
          for (const selector of selectors) {
            const value = document.querySelector(selector)?.textContent?.trim();
            if (value) return value;
          }
          return '';
        };
        return {
          ...${JSON.stringify(fallback)},
          url: ${JSON.stringify(fallback.url || null)} || location.href,
          article_url: location.href,
          title: pick(['[node-type="articleTitle"]', '.main_editor .title', 'meta[property="og:title"]']) || ${JSON.stringify(fallback.title || '')},
          author: pick(['.authorinfo .author1 em', '.authorinfo a[href*="/u/"]', 'meta[name="author"]']) || ${JSON.stringify(fallback.author || '')},
          created_at: pick(['.authorinfo .time', 'time[datetime]']) || ${JSON.stringify(fallback.created_at || '')},
          text,
          is_article: true,
          image_urls: [...bodyNode.querySelectorAll('img[src]')].map((img) => img.src).filter(Boolean),
        };
      })()
    `;
}

function safeName(value) {
    return String(value || 'weibo-article')
        .replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')
        .trim().slice(0, 120) || 'weibo-article';
}

export function renderWeiboArticleMarkdown(article) {
    const lines = [
        `# ${article.title || '微博文章'}`,
        '',
        article.author ? `- 作者：${article.author}` : null,
        article.created_at ? `- 发布时间：${article.created_at}` : null,
        article.url ? `- 原文：${article.url}` : null,
        '',
    ].filter(Boolean);
    return `${lines.join('\n')}${article.text ? `\n${article.text.trim()}\n` : '\n'}`;
}

export async function runWeiboArticleDownload(page, kwargs, deps = {}) {
    const target = normalizeWeiboTarget(kwargs?.id ?? kwargs?.article ?? kwargs?.url);
    const outputDir = path.resolve(String(kwargs?.output || './weibo-downloads'));
    const format = String(kwargs?.outputFormat || kwargs?.['output-format'] || 'md').toLowerCase();
    if (!['md', 'json'].includes(format)) throw new ArgumentError('--output-format must be md or json');
    await page.goto('https://weibo.com');
    await page.wait(2);
    const lookup = target.id || target.mblogid;
    const directUrl = isDirectArticleUrl(target.url) ? target.url : null;
    let article = unwrapEvaluateResult(await page.evaluate(buildArticleDownloadScript(lookup, directUrl)));
    if (article?.auth) throw new CommandExecutionError('Weibo login is required to download an article');
    if (article?.missing) throw new EmptyResultError('weibo article download', `Post ${lookup} was not found`);
    if (article?.error) throw new CommandExecutionError(`weibo article download: ${article.error}`);
    if (!article?.is_article) throw new ArgumentError('The supplied post is not a Weibo long article; use weibo post or video-download instead.');
    if (article.article_url) {
        await page.goto(article.article_url, { waitUntil: 'load', settleMs: 1500 });
        let extracted = null;
        for (let attempt = 0; attempt < 12; attempt++) {
            await page.wait(1);
            extracted = unwrapEvaluateResult(await page.evaluate(buildArticlePageExtractScript(article)));
            if (extracted?.text && extracted.text.length > String(article.text || '').length) break;
        }
        if (!extracted?.text || extracted.text.length < 100) {
            throw new CommandExecutionError(
                'weibo article download: article body did not load',
                'The share post was resolved, but the long-article body was not rendered. Reopen the article URL in the logged-in browser and retry.',
            );
        }
        article = extracted;
    }
    if (!article.text) throw new EmptyResultError('weibo article download', 'The article body was empty');

    await fs.mkdir(outputDir, { recursive: true });
    const ext = format === 'json' ? 'json' : 'md';
    const filePath = path.join(outputDir, `${safeName(article.title || article.mblogid || article.id)}.${ext}`);
    const content = format === 'json'
        ? JSON.stringify({ ...article, sourceUrl: target.url || article.article_url || article.url }, null, 2)
        : renderWeiboArticleMarkdown(article);
    await fs.writeFile(filePath, content, 'utf8');
    return [{ id: article.id, mblogid: article.mblogid, url: article.url, title: article.title || null, format, path: filePath, bytes: Buffer.byteLength(content) }];
}

cli({
    site: 'weibo', name: 'article-download', access: 'read', description: 'Download a Weibo long article as Markdown or JSON',
    domain: 'weibo.com', strategy: Strategy.COOKIE, browser: true,
    args: [
        { name: 'id', type: 'string', required: true, positional: true, help: 'Weibo article ID, mblogid, or URL' },
        { name: 'output', type: 'string', default: './weibo-downloads', help: 'Output directory' },
        { name: 'output-format', type: 'string', default: 'md', help: 'md or json' },
    ],
    columns: ['id', 'mblogid', 'url', 'title', 'format', 'path', 'bytes'],
    func: (page, kwargs) => runWeiboArticleDownload(page, kwargs),
});

export const __test__ = { safeName, renderWeiboArticleMarkdown, runWeiboArticleDownload, isDirectArticleUrl, normalizeArticleUrl, articleUrlFromStatus, buildArticleDownloadScript, buildArticlePageExtractScript };
