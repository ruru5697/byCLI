import { describe, expect, it } from 'vitest';
import { getRegistry } from '@sovovs/bycli/registry';
import './image-publish.js';

describe('weibo image-publish', () => {
  it('registers a dry-run command separate from legacy publish', async () => {
    const command = getRegistry().get('weibo/image-publish');
    const rows = await command.func(null, { text: '测试图文', images: 'a.jpg' });
    expect(rows[0]).toMatchObject({ status: 'dry-run', text: '测试图文' });
  });
});
