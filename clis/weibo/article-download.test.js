import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { __test__, runWeiboArticleDownload, renderWeiboArticleMarkdown } from './article-download.js';
import './article-download.js';

describe('weibo article-download', () => {
  it('renders article metadata and body as markdown', () => {
    const output = renderWeiboArticleMarkdown({ title: '测试文章', author: '作者', created_at: 'today', url: 'https://weibo.com/1/A', text: '正文' });
    expect(output).toContain('# 测试文章');
    expect(output).toContain('作者：作者');
    expect(output).toContain('正文');
  });

  it('writes a long article returned by the status endpoint', async () => {
    const output = await fs.mkdtemp(path.join(os.tmpdir(), 'bycli-weibo-article-'));
    const page = { goto: vi.fn(), wait: vi.fn(), evaluate: vi.fn().mockResolvedValue({ session: 'x', data: { id: '1', mblogid: 'A', url: 'https://weibo.com/1/A', title: '文章', author: '作者', created_at: 'today', text: '正文内容', is_article: true } }) };
    const rows = await runWeiboArticleDownload(page, { id: 'A', output });
    expect(rows[0]).toMatchObject({ id: '1', mblogid: 'A', format: 'md', bytes: expect.any(Number) });
    await expect(fs.readFile(rows[0].path, 'utf8')).resolves.toContain('正文内容');
    await fs.rm(output, { recursive: true, force: true });
  });

  it('resolves the canonical article page URL from a shared status', () => {
    expect(__test__.articleUrlFromStatus({ page_info: { page_url: 'https://weibo.com/ttarticle/p/show?id=230940123' } }))
      .toBe('https://weibo.com/ttarticle/p/show?id=230940123');
    expect(__test__.articleUrlFromStatus({
      page_info: { page_url: 'sinaweibo://articlebrowser?url=https%3A%2F%2Fweibo.com%2Fttarticle%2Fp%2Fshow%3Fid%3D230940123' },
    })).toBe('https://weibo.com/ttarticle/p/show?id=230940123');
    expect(__test__.articleUrlFromStatus({
      url_struct: [{ long_url: 'https://weibo.com/ttarticle/p/show?id=230940456' }],
    })).toBe('https://weibo.com/ttarticle/p/show?id=230940456');
    expect(__test__.articleUrlFromStatus({
      page_info: { page_url: 'sinaweibo://articlebrowser?url=https%3A%2F%2Fweibo.com%2Fttarticle%2Fx%2Fm%2Fshow%3Fid%3D230940789' },
    })).toBe('https://weibo.com/ttarticle/p/show?id=230940789');
    expect(__test__.articleUrlFromStatus({
      page_info: { page_url: 'sinaweibo://articlebrowser?url=https%3A%2F%2Fweibo.com%2Fttarticle%2Fx%2Fm%2Fshow%23%2Fid%3D230940789%26_wb_client_%3D1' },
    })).toBe('https://weibo.com/ttarticle/p/show?id=230940789');
    expect(__test__.articleUrlFromStatus({ page_info: { page_url: 'https://weibo.com/7448048573/RnysjAME7' } }))
      .toBeNull();
    expect(__test__.isDirectArticleUrl('https://weibo.com/ttarticle/p/show?id=230940123')).toBe(true);
  });

  it('downloads a direct ttarticle URL without treating its numeric id as a status id', async () => {
    const output = await fs.mkdtemp(path.join(os.tmpdir(), 'bycli-weibo-article-direct-'));
    const fullText = '完整正文内容。'.repeat(30);
    const page = {
      goto: vi.fn(),
      wait: vi.fn(),
      evaluate: vi.fn().mockResolvedValue({
        session: 'x',
        data: {
          id: '',
          mblogid: '',
          url: 'https://weibo.com/ttarticle/p/show?id=230940123',
          article_url: 'https://weibo.com/ttarticle/p/show?id=230940123',
          title: '直达文章',
          author: '作者',
          created_at: 'today',
          text: fullText,
          is_article: true,
        },
      }),
    };
    const rows = await runWeiboArticleDownload(page, {
      id: 'https://weibo.com/ttarticle/p/show?id=230940123',
      output,
    });
    expect(rows[0]).toMatchObject({ title: '直达文章', format: 'md' });
    expect(page.evaluate.mock.calls[0][0]).toContain('https://weibo.com/ttarticle/p/show?id=230940123');
    await expect(fs.readFile(rows[0].path, 'utf8')).resolves.toContain(fullText);
    await fs.rm(output, { recursive: true, force: true });
  });
});
