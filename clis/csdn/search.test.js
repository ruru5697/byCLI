import { describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';

const { __test__ } = await import('./search.js');
const command = __test__.command;

function pageFromHtml(html) {
  const dom = new JSDOM(html);
  return { goto: vi.fn().mockResolvedValue(undefined), wait: vi.fn().mockResolvedValue(undefined), evaluate: vi.fn(async (source) => Function('document', `return ${source};`)(dom.window.document)) };
}

describe('csdn search', () => {
  it('registers content type and sort filters', () => {
    expect(command).toMatchObject({ site: 'csdn', name: 'search', access: 'read', strategy: 'public', browser: true });
    expect(command.args.map((arg) => arg.name)).toEqual(expect.arrayContaining(['keyword', 'limit', 'page', 'content-type', 'sort', 'time']));
  });

  it('builds a CSDN search URL', () => {
    const url = new URL(__test__.buildSearchUrl({ keyword: 'node cli', limit: 10, page: 2, contentType: 'blog', sort: 'latest', time: 'week' }));
    expect(url.hostname).toBe('so.csdn.net');
    expect(url.searchParams.get('q')).toBe('node cli');
    expect(url.searchParams.get('p')).toBe('2');
    expect(url.searchParams.get('t')).toBe('blog');
  });

  it('normalizes public article results', async () => {
    const page = pageFromHtml(`<div class="search-result-info"><h3><a href="https://blog.csdn.net/alice/article/details/1">Node CLI</a></h3><p class="search-result-desc">A CLI article</p><span class="author">alice</span><time datetime="2026-08-20T10:00:00Z"></time></div>`);
    await expect(command.func(page, { keyword: 'node cli', limit: 10 })).resolves.toEqual([expect.objectContaining({ rank: 1, title: 'Node CLI', author: 'alice', url: 'https://blog.csdn.net/alice/article/details/1', resultType: 'article' })]);
  });

  it('reads the observed result-card-v170 layout despite a header login link', async () => {
    const page = pageFromHtml(`<div id="app"><header><a>登录</a></header><div class="result-list-panel"><div class="list-item isFirst"><div class="result-card-v170"><div class="card-title"><a href="https://blog.csdn.net/alice/article/details/164429468?ops_request_misc=tracking&utm_source=search">如何安装使用deepseek HARNESS</a></div><div class="card-digest">蓝色大肥鱼插件安装说明</div><div class="ctx-meta">2026-08-11 · 浏览 780 · 点赞 7 · 收藏 3 原创</div><a class="meta-author">时光里的沙漏</a><span class="vip-tag">VIP</span></div></div></div></div>`);
    await expect(command.func(page, { keyword: '大肥鱼', 'content-type': 'blog' })).resolves.toEqual([expect.objectContaining({rank:1,title:'如何安装使用deepseek HARNESS',url:'https://blog.csdn.net/alice/article/details/164429468',snippet:'蓝色大肥鱼插件安装说明',author:'时光里的沙漏',publishedAt:'2026-08-11',resultType:'article'})]);
    expect(page.wait).toHaveBeenCalledWith(expect.objectContaining({selector:expect.stringContaining('#app .result-list-panel .list-item')}));
  });

  it('deduplicates tracked links and applies the requested page rank', async () => {
    const page=pageFromHtml(`<div id="app"><div class="result-list-panel">${['one','two'].map(v=>`<div class="list-item"><div class="card-title"><a href="https://blog.csdn.net/alice/article/details/12?utm_source=${v}">Same article</a></div></div>`).join('')}</div></div>`);
    const rows=await command.func(page,{keyword:'test',page:2,limit:5});expect(rows).toHaveLength(1);expect(rows[0]).toMatchObject({rank:6,url:'https://blog.csdn.net/alice/article/details/12'});
  });

  it('does not mistake a header login link or an unknown layout for an auth wall', async () => {
    await expect(command.func(pageFromHtml('<header>登录</header><main>没有找到相关结果</main>'),{keyword:'none'})).rejects.toMatchObject({code:'EMPTY_RESULT'});
    await expect(command.func(pageFromHtml('<header>登录</header><main class="future-layout">Result layout changed</main>'),{keyword:'test'})).rejects.toThrow(/structure was not recognized/);
    await expect(command.func(pageFromHtml('<main>请登录后搜索</main>'),{keyword:'test'})).rejects.toThrow(/requires login/);
  });
});
