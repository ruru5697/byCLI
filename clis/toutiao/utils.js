/**
 * Shared helpers for the toutiao adapter.
 */
import { ArgumentError } from '@sovovs/bycli/errors';

const ARTICLES_MIN_PAGE = 1;
const ARTICLES_MAX_PAGE = 4;
const HOT_MIN_LIMIT = 1;
const HOT_MAX_LIMIT = 50;
const SEARCH_MIN_LIMIT = 1;
const SEARCH_MAX_LIMIT = 50;
const SEARCH_TYPES = ['synthesis', 'information', 'video', 'atlas', 'user', 'xiaoshipin', 'weitoutiao', 'music'];

export function parseArticlesPage(raw, fallback = 1) {
    if (raw === undefined || raw === null || raw === '') return fallback;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
        throw new ArgumentError(`--page must be an integer between ${ARTICLES_MIN_PAGE} and ${ARTICLES_MAX_PAGE}, got ${JSON.stringify(raw)}`);
    }
    if (parsed < ARTICLES_MIN_PAGE || parsed > ARTICLES_MAX_PAGE) {
        throw new ArgumentError(`--page must be between ${ARTICLES_MIN_PAGE} and ${ARTICLES_MAX_PAGE}, got ${parsed}`);
    }
    return parsed;
}

export function parseHotLimit(raw, fallback = 30) {
    if (raw === undefined || raw === null || raw === '') return fallback;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
        throw new ArgumentError(`--limit must be an integer between ${HOT_MIN_LIMIT} and ${HOT_MAX_LIMIT}, got ${JSON.stringify(raw)}`);
    }
    if (parsed < HOT_MIN_LIMIT || parsed > HOT_MAX_LIMIT) {
        throw new ArgumentError(`--limit must be between ${HOT_MIN_LIMIT} and ${HOT_MAX_LIMIT}, got ${parsed}`);
    }
    return parsed;
}

export function parseSearchLimit(raw, fallback = 20) {
    if (raw === undefined || raw === null || raw === '') return fallback;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
        throw new ArgumentError(`--limit must be an integer between ${SEARCH_MIN_LIMIT} and ${SEARCH_MAX_LIMIT}, got ${JSON.stringify(raw)}`);
    }
    if (parsed < SEARCH_MIN_LIMIT || parsed > SEARCH_MAX_LIMIT) {
        throw new ArgumentError(`--limit must be between ${SEARCH_MIN_LIMIT} and ${SEARCH_MAX_LIMIT}, got ${parsed}`);
    }
    return parsed;
}

export function parseSearchType(raw, fallback = 'synthesis') {
    if (raw === undefined || raw === null || raw === '') return fallback;
    const value = String(raw).trim();
    if (!SEARCH_TYPES.includes(value)) {
        throw new ArgumentError(`--type must be one of ${SEARCH_TYPES.join(', ')}, got ${JSON.stringify(raw)}`);
    }
    return value;
}

const NON_TITLE_LINES = new Set([
    '展现', '阅读', '点赞', '评论',
    '查看数据', '查看评论', '修改', '更多', '首发',
    '已发布', '定时发布', '定时发布中', '由文章生成', '审核中',
    '来自抖音', '自动同步', '全部', '文章', '视频', '微头条', '小视频', '音频', '合集', '草稿箱',
]);

const STATS_RE = /展现\s*([\d,]+)\s*阅读\s*([\d,]+)\s*点赞\s*([\d,]+)\s*评论\s*([\d,]*)/;

const ARTICLE_DATE_RE = /^(?:\d{2}-\d{2}|\d{4}-\d{2}-\d{2})\s+\d{2}:\d{2}$/;
const ARTICLE_TIME_RE = /^\d{2}:\d{2}$/;
const ARTICLE_STATUS = new Set(['已发布', '定时发布中', '审核中', '由文章生成', '未通过', '仅我可见']);
const ARTICLE_ACTIONS = new Set(['查看数据', '查看评论', '修改', '更多', '设为公开', '删除作品']);

function normalizeArticleLine(line) {
    return String(line || '').trim().replace(/^[-•]\s*/, '').trim();
}

function isMetadataOnlyLine(value) {
    let remainder = value;
    for (const token of [
        ...ARTICLE_STATUS,
        '来自抖音', '自动同步',
        ...ARTICLE_ACTIONS,
    ]) {
        remainder = remainder.split(token).join('');
    }
    return remainder.replace(/[\s|·•：:：]/g, '') === '';
}

function extractArticleStats(lines) {
    const stats = { '展现': null, '阅读': null, '点赞': null, '评论': null };
    let found = false;
    for (const rawLine of lines) {
        const line = normalizeArticleLine(rawLine);
        const combined = line.match(STATS_RE);
        if (combined) {
            stats['展现'] = combined[1];
            stats['阅读'] = combined[2];
            stats['点赞'] = combined[3];
            stats['评论'] = combined[4] || '0';
            found = true;
            continue;
        }
        const metrics = [
            ['展现', /展现\s*([\d,]+)/],
            ['阅读', /(?:阅读|播放)\s*([\d,]+)/],
            ['点赞', /点赞\s*([\d,]+)/],
            ['评论', /评论\s*([\d,]+)/],
        ];
        for (const [name, pattern] of metrics) {
            const match = line.match(pattern);
            if (match) {
                stats[name] = match[1];
                found = true;
            }
        }
    }
    return found ? stats : null;
}

function isArticleTitleCandidate(line) {
    const value = normalizeArticleLine(line);
    if (!value || value.length >= 160 || /^\d+$/.test(value)) return false;
    if (ARTICLE_DATE_RE.test(value) || ARTICLE_TIME_RE.test(value)) return false;
    if (NON_TITLE_LINES.has(value) || ARTICLE_STATUS.has(value) || ARTICLE_ACTIONS.has(value)) return false;
    if (isMetadataOnlyLine(value)) return false;
    if (/^(?:展现|阅读|播放|点赞|评论|收藏|转发)\s*[\d,]+/.test(value)) return false;
    return true;
}

/**
 * Extract creator-backend article rows from both legacy and current rendered text.
 *
 * Older pages place `MM-DD HH:MM` before the title. The current creator page
 * places a full `YYYY-MM-DD HH:MM` publish date after the title/status/stats
 * block, and emits each metric on a separate line (for example `播放 387`).
 */
export function parseToutiaoArticlesText(text) {
    const lines = String(text || '').split('\n').map(normalizeArticleLine).filter(Boolean);
    const anchors = lines
        .map((line, index) => ({ line, index }))
        .filter(({ line }) => ARTICLE_DATE_RE.test(line));
    const results = [];

    for (let anchorIndex = 0; anchorIndex < anchors.length; anchorIndex++) {
        const { line: date, index } = anchors[anchorIndex];
        const nextIndex = anchors[anchorIndex + 1]?.index ?? lines.length;
        const blockStart = anchorIndex === 0 ? 0 : anchors[anchorIndex - 1].index + 1;
        const block = lines.slice(blockStart, nextIndex);
        let title = null;

        for (let cursor = index - 1; cursor >= Math.max(blockStart, index - 14); cursor--) {
            if (isArticleTitleCandidate(lines[cursor])) {
                title = lines[cursor];
                break;
            }
        }
        if (!title) continue;

        const status = block
            .flatMap((value) => [...ARTICLE_STATUS].filter((candidate) => value.includes(candidate)))
            .sort((a, b) => b.length - a.length)[0] || null;
        const stats = extractArticleStats(block);
        results.push({
            title,
            date,
            status,
            ...(stats || { '展现': null, '阅读': null, '点赞': null, '评论': null }),
        });
    }

    return results;
}

function trimOrNull(v) {
    const s = String(v ?? '').trim();
    return s ? s : null;
}

function pickImage(item) {
    const url = item?.Image?.url;
    if (typeof url === 'string' && url) return url;
    const firstFromList = Array.isArray(item?.Image?.url_list)
        ? item.Image.url_list
            .map((entry) => typeof entry === 'string' ? entry : entry?.url)
            .find((u) => typeof u === 'string' && u)
        : null;
    return firstFromList || null;
}

function parseHot(v) {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Project a row from the public toutiao hot-board API into stable shape.
 */
export function mapHotRow(item, index) {
    if (!item || typeof item !== 'object') return null;
    const groupId = trimOrNull(item.ClusterIdStr || (item.ClusterId != null ? String(item.ClusterId) : null));
    const title = trimOrNull(item.Title);
    if (!title) return null;
    return {
        rank: index + 1,
        group_id: groupId,
        title,
        query: trimOrNull(item.QueryWord) || title,
        hot_value: parseHot(item.HotValue),
        label: trimOrNull(item.Label),
        url: trimOrNull(item.Url),
        image_url: pickImage(item),
    };
}

export const HOT_BOARD_URL = 'https://www.toutiao.com/hot-event/hot-board/?origin=toutiao_pc';
export const TOUTIAO_SEARCH_URL = 'https://www.toutiao.com/search/';

function parseSearchNumber(value) {
    if (value === undefined || value === null || value === '') return null;
    const parsed = Number(String(value).replace(/,/g, ''));
    return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : null;
}

function absoluteSearchUrl(value) {
    const url = trimOrNull(value);
    if (!url) return null;
    try {
        return new URL(url, 'https://www.toutiao.com/').toString();
    } catch {
        return null;
    }
}

function searchImage(item) {
    const candidates = [
        item?.image_url,
        item?.large_image_url,
        item?.other_image_url,
        ...(Array.isArray(item?.image_list) ? item.image_list.map((image) => image?.url || image) : []),
        ...(Array.isArray(item?.detail_image_list) ? item.detail_image_list.map((image) => image?.url || image) : []),
    ];
    return candidates.map(trimOrNull).find(Boolean) || null;
}

function searchRowFromCard(item, index) {
    if (!item || typeof item !== 'object') return null;
    const title = trimOrNull(item.title);
    const url = absoluteSearchUrl(
        item.article_url || item.open_url || item.source_url || item.item_source_url || item?.display?.info?.url,
    );
    if (!title || !url) return null;
    return {
        rank: index + 1,
        title,
        url,
        source: trimOrNull(item.source || item.media_name),
        publish_time: trimOrNull(item.datetime || item.publish_time || item.display_time),
        summary: trimOrNull(item.abstract || item.summary || item?.emphasized?.summary),
        image_url: searchImage(item),
        like_count: parseSearchNumber(item.like_count ?? item.digg_count),
        comment_count: parseSearchNumber(item.comment_count),
        // Preserve the metric identity: other counters are not verified shares.
        share_count: parseSearchNumber(item.share_count),
        read_count: parseSearchNumber(item.read_count),
    };
}

/**
 * Extract search result cards embedded in the public Toutiao search page.
 * The page currently serializes each result as an application/json script.
 */
export function parseToutiaoSearchHtml(html, limit = 20) {
    const source = String(html || '');
    const rows = [];
    const seenUrls = new Set();
    const scriptPattern = /<script\b[^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi;
    let match;
    while ((match = scriptPattern.exec(source))) {
        let payload;
        try {
            payload = JSON.parse(match[1]);
        } catch {
            continue;
        }
        const candidate = payload?.data;
        const row = searchRowFromCard(candidate, rows.length);
        if (!row || seenUrls.has(row.url)) continue;
        seenUrls.add(row.url);
        rows.push(row);
        if (rows.length >= limit) break;
    }
    return rows.map((row, index) => ({ ...row, rank: index + 1 }));
}

export function looksToutiaoAuthWallText(value) {
    const text = String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
    if (!text) return false;
    return /登录|请登录|账号登录|扫码登录|安全验证|验证码|captcha/.test(text) ||
        /\b(login|sign in|captcha|verification required)\b/.test(text) ||
        /mp\.toutiao\.com\/profile_v4\/login/.test(text);
}

export const __test__ = {
    ARTICLES_MIN_PAGE,
    ARTICLES_MAX_PAGE,
    HOT_MIN_LIMIT,
    HOT_MAX_LIMIT,
    SEARCH_MIN_LIMIT,
    SEARCH_MAX_LIMIT,
    SEARCH_TYPES,
};
