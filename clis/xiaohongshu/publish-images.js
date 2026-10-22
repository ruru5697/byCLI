import {cli,Strategy} from '@sovovs/bycli/registry';
import {imageJobAction} from '../_shared/video-submit.js';
import {makeImageAdapter} from '../_shared/image-site-submit.js';
import {prepareImages} from '../_shared/image-prepare.js';
import {imageSnapshot,assertImageChecks,prepareXhsImages} from './_image-prepare.js';
export {IMAGE_PUBLISH_URL,imageSnapshot,assertImageChecks,prepareXhsImages} from './_image-prepare.js';
export const command=cli({
    site:'xiaohongshu',name:'publish-images',access:'write',
    description:'准备小红书图文，复核后以确认码单次提交，查询发布回执与精确作品状态',
    domain:'creator.xiaohongshu.com',strategy:Strategy.COOKIE,navigateBefore:false,siteSession:'persistent',
    args:[
        {name:'input',help:'Path to ordered image JSON manifest'},
        {name:'prepare',type:'bool',default:false},
        {name:'review',help:'Review prepared image job UUID; issue a 30-minute confirmation token'},
        {name:'submit',help:'Submit image job exactly once, after explicit human approval'},
        {name:'confirm',help:'Exact token returned by --review'},
        {name:'status',help:'Query image job UUID and exact platform content ID'},
        {name:'timeout',type:'int',default:300}
    ],
    columns:['status','job_id','submitted','title','image_count','account','content_id','content_type','public_url','confirmation','expires_at','receipt_status','identity_source','query_status','query_reason','report','preview'],
    func:(page,kwargs)=>{
        if(kwargs.prepare&&!kwargs.review&&!kwargs.submit&&!kwargs.status&&!kwargs.confirm&&kwargs.input)return prepareImages(page,kwargs,prepareXhsImages);
        return imageJobAction(page,kwargs,makeImageAdapter(imageSnapshot,assertImageChecks));
    }
});
