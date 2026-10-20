import { cli, Strategy } from '@sovovs/bycli/registry';
import { runToutiaoVideoStats } from './_video-stats.js';
export { runToutiaoVideoStats } from './_video-stats.js';

export const videoStatsCommand=cli({site:'toutiao',name:'video-stats',access:'read',description:'获取今日头条视频统计数据',domain:'mp.toutiao.com',strategy:Strategy.UI,browser:true,args:[{name:'video',type:'string',required:true,positional:true,help:'视频 URL、ID 或标题'}],columns:['found','title','status','impressions','views','likes','comments','text'],func:(page,kwargs)=>runToutiaoVideoStats(page,kwargs)});
