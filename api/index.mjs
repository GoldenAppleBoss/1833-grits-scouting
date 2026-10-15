import { handlePortal } from '../lib/portal.mjs';
import { handleScouting } from '../lib/scouting.mjs';
import { json, html, escape } from '../lib/http.mjs';
export default async function handler(req,res){
  try {
    const url=new URL(req.url,'http://localhost');
    if(url.pathname==='/scouting'||url.pathname.startsWith('/scouting/'))return await handleScouting(req,res,url);
    return await handlePortal(req,res,url);
  }catch(error){
    const status=error.statusCode||503,message=error.statusCode?error.message:'The service is temporarily unavailable. Please try again.';
    if(!error.statusCode)console.error('Request failed:',error.code||error.name);
    if(res.headersSent){res.end();return;}
    const path=new URL(req.url,'http://localhost').pathname;
    if(path.startsWith('/api/')||path.includes('/api/'))return json(res,status,{error:message});
    return html(res,status,`<!doctype html><meta name="viewport" content="width=device-width"><h1>${escape(message)}</h1><p><a href="/">Your account</a></p>`);
  }
}
