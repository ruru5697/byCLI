import { cli, Strategy } from '@sovovs/bycli/registry';
import { ArgumentError, CommandExecutionError, ConfigError, EmptyResultError } from '@sovovs/bycli/errors';
import { readKnowledgeBaseFromChrome } from './native-client.js';

export const IMA_STATUS_COLUMNS = [
    'knowledgeBaseId', 'knowledgeBase', 'title', 'mediaId', 'mediaState',
    'mediaAuditStatus', 'accessStatus', 'parseProgress', 'parseErrInfo',
    'updateTime', 'url',
];

export async function runImaStatus(page, kwargs, read = (query) => readKnowledgeBaseFromChrome(page, query)) {
    const query = String(kwargs?.knowledgeBase ?? '').trim();
    if (!query) throw new ArgumentError('knowledge-base name or ID is required');
    let envelope;
    try { envelope = await read(query); } catch (error) {
        if (error?.code === 'IMA_CHROME_AUTH_REQUIRED') {
            throw new ConfigError(error.message, 'Open https://ima.qq.com/wikis in Chrome, sign in, then retry.');
        }
        throw new CommandExecutionError(error?.message || String(error));
    }
    if (!envelope?.ok) {
        if (envelope?.code === 'KNOWLEDGE_NOT_FOUND') throw new EmptyResultError('ima status', envelope.message || query);
        throw new CommandExecutionError(envelope?.message || 'ima status failed');
    }
    if (!Array.isArray(envelope.items) || envelope.items.length === 0) {
        throw new EmptyResultError('ima status', `Knowledge base "${query}" contains no items`);
    }
    return envelope.items.map((item) => Object.fromEntries(IMA_STATUS_COLUMNS.map((key) => [key, item?.[key] ?? null])));
}

export const statusCommand = cli({
    site: 'ima', name: 'status', access: 'read', description: '查询 IMA 知识库内容状态',
    domain: 'ima.qq.com', strategy: Strategy.COOKIE, browser: true, navigateBefore: false,
    args: [{ name: 'knowledgeBase', type: 'string', required: true, positional: true, help: '知识库名称或 ID' }],
    columns: IMA_STATUS_COLUMNS,
    func: (page, kwargs) => runImaStatus(page, kwargs),
});
