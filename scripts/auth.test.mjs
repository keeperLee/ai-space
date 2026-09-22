import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';

test('SQLite authentication lifecycle and HTTP isolation',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'portal-auth-'));
 const socket=createServer();socket.listen(0,'127.0.0.1');await once(socket,'listening');const port=socket.address().port;await new Promise(r=>socket.close(r));
 const base=`http://127.0.0.1:${port}`;let child;
 async function start(){child=spawn(process.execPath,['scripts/serve.mjs'],{env:{...process.env,HOST:'127.0.0.1',PORT:String(port),PUBLIC_ORIGIN:'',DB_PATH:join(dir,'test.sqlite')},stdio:['ignore','pipe','pipe']});await Promise.race([once(child.stdout,'data'),once(child,'exit').then(()=>{throw Error('server stopped');})]);}
 async function stop(){const exited=once(child,'exit');child.kill();await exited;}
 async function call(path,body,cookie='',origin=base){const r=await fetch(base+'/api/'+path,{method:body===undefined?'GET':'POST',headers:{Cookie:cookie,...(body===undefined?{}:{Origin:origin,'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,data:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0],headers:r.headers};}
 const pass=randomBytes(24).toString('hex'), memberPass=randomBytes(24).toString('hex');
 try {
  await start();
  assert.equal((await call('session')).data.needsSetup,true);
  const redirect=await fetch(base+'/projects/agent-learning/learning.html',{redirect:'manual'});
  assert.equal(redirect.status,302);assert.match(redirect.headers.get('location'),/^\/\?next=/);
  assert.equal((await fetch(base+'/content/projects.js')).status,401);
  assert.equal((await fetch(base+'/projects/example.html',{redirect:'manual'})).status,302);
  assert.equal((await call('login',{username:'admin',password:''})).status,401);
  assert.equal((await call('setup',{password:pass},'','https://other.example')).status,403);
  assert.equal((await call('setup',{password:''})).status,400);
  const setup=await Promise.all([call('setup',{password:pass}),call('setup',{password:pass})]);
  assert.deepEqual(setup.map(x=>x.status).sort(),[200,409]);
  assert.equal((await call('session')).data.needsSetup,false);
  assert.equal((await call('login',{username:'admin',password:'bad'})).status,401);
  assert.equal((await call('users')).status,403);
  assert.equal((await fetch(base+'/projects/agent-learning/content/chapters/c01.md',{redirect:'manual'})).status,302);
  for(const p of ['/data/app.sqlite','/.git/config','/.env','/server/auth.mjs','/content/users.js','/scripts/serve.mjs'])assert.equal((await fetch(base+p)).status,404,p);
  const login=await call('login',{username:'admin',password:pass,remember:true});assert.equal(login.status,200);assert.match(login.headers.get('set-cookie'),/HttpOnly/);let admin=login.cookie;
  const nestedSession=await fetch(base+'/projects/agent-learning/api/session',{headers:{Cookie:admin}});
  assert.equal((await nestedSession.json()).user.username,'admin');
  for(const path of ['/', '/projects/agent-learning/learning.html', '/content/projects.js']) assert.equal((await fetch(base+path,{headers:{Cookie:admin},redirect:'manual'})).status,200);
  const portal=await (await fetch(base+'/')).text();assert.match(portal,/id="loginForm"/);
  assert.equal((await fetch(base+'/projects/agent-learning/content/chapters/c01.md',{headers:{Cookie:admin}})).status,200);
  const list=await call('users',undefined,admin);assert.equal(list.data.users.length,1);assert.equal(JSON.stringify(list.data).includes('password'),false);
  assert.equal((await call('users/create',{username:'student',displayName:'Student',password:memberPass,role:'member'},admin)).status,200);
  let member=(await call('login',{username:'student',password:memberPass})).cookie;
  assert.equal((await call('users',undefined,member)).status,403);
  assert.equal((await call('users/create',{username:'hacker',displayName:'Hacker',password:pass,role:'admin'},member)).status,403);
  assert.equal((await call('profile',{username:'admin',displayName:'Attack'},member)).status,403);
  assert.equal((await call('users/remove',{username:'admin'},admin)).status,400);
  await stop();await start();
  assert.equal((await call('session',undefined,admin)).data.user.username,'admin');
  assert.equal((await call('setup',{password:pass})).status,409);
  assert.equal((await call('users',undefined,admin)).data.users.length,2);
  await call('users/active',{username:'student',active:false},admin);
  assert.equal((await call('session',undefined,member)).data.user,null);
  assert.equal((await call('login',{username:'student',password:memberPass})).status,401);
  await call('users/active',{username:'student',active:true},admin);
  member=(await call('login',{username:'student',password:memberPass})).cookie;
  const newPass=randomBytes(24).toString('hex');await call('users/reset',{username:'student',password:newPass},admin);
  assert.equal((await call('session',undefined,member)).data.user,null);
  assert.equal((await call('login',{username:'student',password:newPass})).status,200);
  assert.equal((await call('password',{oldPassword:'incorrect',newPassword:newPass},admin)).status,400);
  assert.equal((await call('password',{oldPassword:pass,newPassword:newPass},admin)).status,200);
  assert.equal((await call('session',undefined,admin)).data.user,null);
  admin=(await call('login',{username:'admin',password:newPass})).cookie;
  await call('logout',{},admin);assert.equal((await call('session',undefined,admin)).data.user,null);
  assert.equal((await fetch(base+'/projects/agent-learning/learning.html',{headers:{Cookie:admin},redirect:'manual'})).status,302);
 }finally{if(child?.exitCode===null)await stop();await rm(dir,{recursive:true,force:true});}
});
