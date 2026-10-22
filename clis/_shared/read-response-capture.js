import {CliError} from '@sovovs/bycli/errors';
/** Non-draining observer for read-only responses; bodies remain in page memory only. */
export async function startReadCapture(page,fragment) {
    await page.evaluate(`(()=>{
        const state=window.__bycliReadCapture ||= {fragment:'',entries:[]};state.fragment=${JSON.stringify(fragment)};state.entries=[];
        if(state.installed)return;state.installed=true;
        const store=(url,method,status,body)=>{if(!String(url).includes(state.fragment))return;state.entries.push({url:new URL(url,location.href).href,method:method.toUpperCase(),responseStatus:status,responsePreview:body,responseBodyTruncated:false});if(state.entries.length>50)state.entries.shift();};
        const nativeFetch=window.fetch;
        window.fetch=async function(...args){const request=args[0],url=typeof request==='string'?request:request?.url||String(request),method=args[1]?.method||request?.method||'GET';const r=await nativeFetch.apply(this,args);if(String(url).includes(state.fragment))r.clone().text().then(body=>store(url,method,r.status,body)).catch(()=>{});return r;};
        const open=XMLHttpRequest.prototype.open,send=XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.open=function(method,url,...args){this.__bycliRead={method,url};return open.call(this,method,url,...args);};
        XMLHttpRequest.prototype.send=function(...args){this.addEventListener('load',()=>{const info=this.__bycliRead;if(info&&String(info.url).includes(state.fragment))try{store(info.url,info.method,this.status,this.responseText);}catch{}},{once:true});return send.apply(this,args);};
    })()`);
}
export async function waitReadCapture(page,parse,timeoutMs=12000) {
    const deadline=Date.now()+timeoutMs;
    do {
        const entries=await page.evaluate('window.__bycliReadCapture?.entries || []');
        if(!Array.isArray(entries))throw new CliError('CAPTURE_UNAVAILABLE','Read-only response observer unavailable');
        const results=entries.map(parse).filter(Boolean);
        if(results.length)return results;
        await page.wait({time:0.5});
    } while(Date.now()<deadline);
    return [];
}
