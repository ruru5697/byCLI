import { cli, Strategy } from '@sovovs/bycli/registry';
import { runToutiaoArticleStats } from './_article-stats.js';
export { runToutiaoArticleStats } from './_article-stats.js';

export const articleStatsCommand = cli({ site:'toutiao', name:'article-stats', access:'read', description:'获取今日头条文章统计数据', domain:'mp.toutiao.com', strategy:Strategy.UI, browser:true, args:[{name:'article',type:'string',required:true,positional:true,help:'文章 URL、ID 或标题'}], columns:['found','title','status','impressions','views','likes','comments','text'], func:(page,kwargs)=>runToutiaoArticleStats(page,kwargs) });
