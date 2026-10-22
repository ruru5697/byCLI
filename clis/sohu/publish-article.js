import {cli,Strategy} from '@sovovs/bycli/registry';
import {prepareSohuContent} from './_content-prepare.js';
import {contentArgs,contentCommand} from './_content-submit.js';
cli({site:'sohu',name:'publish-article',access:'write',description:'准备搜狐号文章：填写纯文本正文与摘要，插入文末图片和封面，人工确认后单次提交、回执与状态查询',domain:'mp.sohu.com',strategy:Strategy.COOKIE,browser:true,navigateBefore:false,siteSession:'persistent',args:contentArgs,columns:['status','job_id','content_type','title','submitted','account','content_id','confirmation','query_status','report','preview'],func:(page,kwargs)=>contentCommand(page,kwargs,'article',prepareSohuContent)});
