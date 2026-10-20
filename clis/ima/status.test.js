import { describe, expect, it } from 'vitest';
import { getRegistry } from '@sovovs/bycli/registry';
import { ArgumentError, EmptyResultError } from '@sovovs/bycli/errors';
import { runImaStatus } from './status.js';
import './status.js';

describe('ima status', () => {
    it('registers the status command', () => {
        expect(getRegistry().get('ima/status')?.columns).toContain('mediaAuditStatus');
    });

    it('projects item lifecycle fields', async () => {
        const result = await runImaStatus({}, { knowledgeBase: 'kb' }, async () => ({
            ok: true,
            items: [{ knowledgeBaseId: 'k1', knowledgeBase: 'kb', title: 'doc', mediaId: 'm1', mediaState: 1, mediaAuditStatus: 2, accessStatus: 1, parseProgress: 100, updateTime: 'now', url: 'https://ima.qq.com/doc' }],
        }));
        expect(result[0]).toMatchObject({ knowledgeBaseId: 'k1', mediaState: 1, parseProgress: 100 });
        expect(result[0]).toHaveProperty('parseErrInfo', null);
    });

    it('rejects empty queries and empty result sets', async () => {
        await expect(runImaStatus({}, {}, async () => ({ ok: true, items: [] }))).rejects.toBeInstanceOf(ArgumentError);
        await expect(runImaStatus({}, { knowledgeBase: 'kb' }, async () => ({ ok: true, items: [] }))).rejects.toBeInstanceOf(EmptyResultError);
    });
});
