import { createServer } from 'node:http';
import { readFile, realpath } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAuth } from '../server/auth.mjs';
import { ACCESS } from '../assets/js/access.js';
const OPEN=ACCESS.open;
const ROOT=fileURLToPath(new URL('..',import.meta.url));
const HOST=process.env.HOST||'127.0.0.1', PORT=Number(process.env.PORT||process.argv[2]||5173);
const auth=createAuth(resolve(process.env.DB_PATH||resolve(ROOT,'data/app.sqlite')));
const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.md':'text/markdown','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.woff2':'font/woff2'};
const server=createServer(async(req,res)=>{
  res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','same-origin');res.setHeader('X-Frame-Options','DENY');
  const json=(status,obj)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(obj));};
  try {
    const expected=process.env.PUBLIC_ORIGIN||`http://${HOST}:${PORT}`;
    if(req.headers.host!==new URL(expected).host) return json(403,{ok:false,error:'Host 不受信任'});
    let path=decodeURIComponent(new URL(req.url,expected).pathname);
    // 子项目共享门户后端，不启动第二套账号数据库。
    if(path.startsWith('/projects/agent-learning/api/'))path=path.replace('/projects/agent-learning/api/','/api/');
    if(path.startsWith('/api/')) {
      let body={};
      if(req.method==='POST') {
        if(req.headers.origin!==expected || req.headers['content-type']!=='application/json')return json(403,{ok:false,error:'请求来源不受信任'});
        let raw='';for await(const chunk of req){raw+=chunk;if(Buffer.byteLength(raw)>16384)return json(413,{ok:false,error:'请求过大'});}body=JSON.parse(raw||'{}');
        if(!body||typeof body!=='object'||Array.isArray(body))return json(400,{ok:false,error:'请求格式不正确'});
      }
      return json(200,await auth.handle(req,res,path,body));
    }
    if(path==='/learning.html') {res.writeHead(302,{Location:'/projects/agent-learning/learning.html'});res.end();return;}
    // 门禁统一受 assets/js/access.js 的开关控制。
    // 公开访问时不拦截，静态托管（GitHub Pages）本来也没有这一层。
    if(!OPEN) {
      if(path.startsWith('/projects/')&&!auth.session(req)) {
        res.writeHead(302,{Location:`/?next=${encodeURIComponent(path)}`});res.end();return;
      }
      if(path==='/content/projects.js'&&!auth.session(req))return json(401,{error:'请先登录'});
    }
    if(!['GET','HEAD'].includes(req.method))return json(405,{error:'Method not allowed'});
    const allowed=/^\/projects\/[a-zA-Z0-9_/-]+\.(html|js|css|svg|png|jpg|json|woff2|md)$/.test(path)||path==='/'||path==='/index.html'||path==='/learning.html'||/^\/assets\/[a-zA-Z0-9_./-]+$/.test(path)||['/content/projects.js','/content/catalog.js','/content/changelog.js'].includes(path)||/^\/content\/chapters\/c\d+\.md$/.test(path);
    if(!allowed||path.split('/').some(s=>s.startsWith('.')))return json(404,{error:'Not found'});
    if(!OPEN&&path.startsWith('/content/chapters/')&&!auth.session(req))return json(401,{error:'请先登录'});
    const requested=resolve(ROOT,'.'+(path==='/'?'/index.html':path));
    const file=await realpath(requested);
    if(file!==requested)return json(404,{error:'Not found'});
    if(!file.startsWith(ROOT+sep)&&!file.startsWith(ROOT.endsWith(sep)?ROOT:ROOT+sep))return json(404,{error:'Not found'});
    let data=await readFile(file);
    if(path==='/projects/agent-learning/learning.html')data=Buffer.from(data.toString().replaceAll('href="./"','href="/"'));
    res.writeHead(200,{'Content-Type':`${mime[extname(file)]||'application/octet-stream'}; charset=utf-8`});res.end(req.method==='HEAD'?undefined:data);
  }catch(e){json(e.status|| (e.code==='ENOENT'?404:400),{ok:false,error:e.status?e.message:'请求失败'});}
});
server.listen(PORT,HOST,()=>console.log(`项目门户：http://${HOST}:${PORT}/`+(OPEN?'（公开访问，不需要登录）':'（SQLite 认证；首次请在门户初始化 admin）')));
