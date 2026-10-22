import { describe, expect, it, vi } from 'vitest';
import { ArgumentError, CommandExecutionError } from '@sovovs/bycli/errors';
import { runWeiboComments } from './comments.js';

describe('Weibo comments validation and endpoint failures', () => {
  it.each([0, -1, 101, 1.5, 'bad'])('rejects invalid limit %s before opening Chrome', async limit => {
    const page = { goto: vi.fn() };
    await expect(runWeiboComments(page, { id: '123', limit })).rejects.toBeInstanceOf(ArgumentError);
    expect(page.goto).not.toHaveBeenCalled();
  });
  it('throws a typed error when the browser reports an API failure', async () => {
    const page = { goto: vi.fn(), wait: vi.fn(), evaluate: vi.fn().mockResolvedValue({ error: 'API error: unavailable' }) };
    await expect(runWeiboComments(page, { id: '123' })).rejects.toBeInstanceOf(CommandExecutionError);
  });
});
