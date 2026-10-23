import {CliError} from '@sovovs/bycli/errors';
export function editorType(url){
 try{const u=new URL(url);if(u.origin!=='https://mp.sohu.com')return null;return {addvideo:'video',addatlas:'gallery',addarticle:'article'}[u.pathname.match(/^\/mpfe\/v4\/contentManagement\/news\/(addvideo|addatlas|addarticle)$/)?.[1]]||null}catch{return null}
}
export function editorInUse(tab){
 return new CliError('EDITOR_IN_USE',`Retained Sohu ${editorType(tab.url)||'content'} editor: ${tab.page}`,
  `Inspect: bycli sohu editor; open: bycli sohu editor --open ${tab.page}; discard and close: bycli sohu editor --close ${tab.page} --discard`);
}
