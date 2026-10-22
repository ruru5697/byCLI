/**
 * Shared Weibo utilities — uid extraction.
 */
import { ArgumentError, AuthRequiredError, CommandExecutionError } from '@sovovs/bycli/errors';
/**
 * `page.evaluate` may return either the raw IIFE value or a
 * `{ session, data }` envelope depending on the browser-bridge version.
 * Adapter code that inspected the payload directly (e.g. `Array.isArray`,
 * truthiness checks on uid strings) silently received the envelope wrapper
 * instead of the inner value. This helper normalizes both shapes so callers
 * can keep their existing checks unchanged.
 */
export function unwrapEvaluateResult(payload) {
    if (payload && !Array.isArray(payload) && typeof payload === 'object' && 'session' in payload && 'data' in payload) {
        return payload.data;
    }
    return payload;
}
export function requireArrayEvaluateResult(payload, label) {
    if (!Array.isArray(payload)) {
        if (payload && typeof payload === 'object' && 'error' in payload) {
            throw new CommandExecutionError(`${label}: ${String(payload.error)}`);
        }
        throw new CommandExecutionError(`${label} returned malformed extraction payload`);
    }
    return payload;
}
export function requireObjectEvaluateResult(payload, label) {
    if (!payload || Array.isArray(payload) || typeof payload !== 'object') {
        throw new CommandExecutionError(`${label} returned malformed extraction payload`);
    }
    return payload;
}

/**
 * Normalize the identifiers users commonly copy from Weibo.
 *
 * The status endpoints accept either a numeric idstr or a mblogid, while
 * browser output usually contains a full /<uid>/<mblogid> URL. Keeping this
 * parser in one place prevents each adapter from silently treating a URL as
 * an opaque id and returning a misleading empty result.
 */
export function normalizeWeiboTarget(raw) {
    const input = String(raw ?? '').trim();
    if (!input) throw new ArgumentError('Weibo post ID or URL is required');

    if (/^\d+$/.test(input)) {
        return { input, id: input, mblogid: null, url: null };
    }
    // Short ids copied from the Weibo UI (for example Rnvl93WBe) are
    // valid mblogids even when the user does not provide the surrounding URL.
    if (/^[A-Za-z0-9]+$/.test(input)) {
        return { input, id: null, mblogid: input, url: null };
    }

    let parsed;
    try {
        parsed = new URL(input.includes('://') ? input : `https://${input}`);
    } catch {
        throw new ArgumentError(`Invalid Weibo post ID or URL: ${input}`);
    }
    const host = parsed.hostname.toLowerCase();
    if (!/(^|\.)weibo\.(com|cn)$/.test(host)) {
        throw new ArgumentError('Weibo URL must use weibo.com or weibo.cn');
    }

    const parts = parsed.pathname.split('/').filter(Boolean);
    const candidate = parts[0] === 'detail' || parts[0] === 'status'
        ? parts[1]
        : parts.length >= 2 && /^\d+$/.test(parts[0])
            ? parts[1]
            : parsed.searchParams.get('id') || parsed.searchParams.get('mblogid');
    if (!candidate || !/^[A-Za-z0-9]+$/.test(candidate)) {
        throw new ArgumentError(`Could not find a Weibo post ID in: ${input}`);
    }
    return {
        input,
        id: /^\d+$/.test(candidate) ? candidate : null,
        mblogid: /^\d+$/.test(candidate) ? null : candidate,
        url: parsed.toString(),
    };
}
/** Get the currently logged-in user's uid from Vue store or config API. */
export async function getSelfUid(page) {
    const uid = unwrapEvaluateResult(await page.evaluate(`
    (() => {
      const app = document.querySelector('#app')?.__vue_app__;
      const store = app?.config?.globalProperties?.$store;
      const uid = store?.state?.config?.config?.uid;
      if (uid) return String(uid);
      return null;
    })()
  `));
    if (uid)
        return uid;
    // Fallback: config API
    const config = unwrapEvaluateResult(await page.evaluate(`
    (async () => {
      const resp = await fetch('/ajax/config/get_config', {credentials: 'include'});
      if (!resp.ok) return null;
      const data = await resp.json();
      return data.ok && data.data?.uid ? String(data.data.uid) : null;
    })()
  `));
    if (config)
        return config;
    throw new AuthRequiredError('weibo.com');
}
