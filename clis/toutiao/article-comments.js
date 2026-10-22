import { cli, Strategy } from '@sovovs/bycli/registry';
import { ArgumentError, AuthRequiredError, EmptyResultError } from '@sovovs/bycli/errors';

export async function runToutiaoArticleComments(page, kwargs) {
  const query = String(kwargs?.article ?? '').trim();
  if (!query) throw new ArgumentError('article URL, ID, or title is required');
  await page.goto('https://mp.toutiao.com/profile_v4/manage/content/all?enter_from=left_menu');
  await page.wait({ time: 4 });
  const result = await page.evaluate(`(() => {
    const query = ${JSON.stringify(query)};
    const body = document.body.innerText || '';
    if (/登录|立即登录/.test(body) && !/作品管理/.test(body)) return { auth: false };
    const title = [...document.querySelectorAll('*')].find(x => (x.innerText || '').trim() === query);
    if (!title) return { found: false };
    const card = title.parentElement?.parentElement;
    const action = [...(card?.querySelectorAll('span') || [])].find(x => (x.innerText || '').trim() === '查看评论');
    if (action) action.click();
    return { found: true };
  })()`);
  if (result?.auth === false) throw new AuthRequiredError('mp.toutiao.com');
  if (!result?.found) throw new EmptyResultError('toutiao article-comments', `No article matched: ${query}`);
  await page.wait({ time: 3 });
  const comments = await page.evaluate(`(() => {
    const text = document.body.innerText || '';
    const marker = text.lastIndexOf('共 ');
    const tail = marker >= 0 ? text.slice(marker) : text.slice(-1200);
    const count = tail.match(/共\s*([\d,]+)\s*条评论/)?.[1] ?? '0';
    const empty = /暂无评论/.test(tail);
    return { commentCount: count, comments: [], empty, raw: tail.slice(0, 1200) };
  })()`);
  return [{ article: query, commentCount: comments.commentCount, comments: comments.comments, empty: comments.empty, raw: comments.raw }];
}

export const articleCommentsCommand = cli({ site:'toutiao', name:'article-comments', access:'read', description:'采集今日头条文章评论', domain:'mp.toutiao.com', strategy:Strategy.UI, browser:true, args:[{name:'article',type:'string',required:true,positional:true,help:'文章 URL、ID 或标题'}], columns:['article','commentCount','comments','empty','raw'], func:(page,kwargs)=>runToutiaoArticleComments(page,kwargs) });
