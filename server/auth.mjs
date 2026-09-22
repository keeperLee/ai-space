import { DatabaseSync } from 'node:sqlite';
import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { validateUsername, validateDisplayName, validatePassword } from '../assets/js/userdir.js';
export function createAuth(filename) {
  mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(filename);
  chmodSync(filename, 0o600);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS users(username TEXT PRIMARY KEY, displayName TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','member')), active INTEGER NOT NULL DEFAULT 1, password TEXT, note TEXT NOT NULL DEFAULT '', createdAt TEXT NOT NULL, createdBy TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, username TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE, expiresAt INTEGER NOT NULL);
    INSERT OR IGNORE INTO users VALUES('admin','管理员','admin',1,NULL,'',datetime('now'),'system');`);
  const get = name => db.prepare('SELECT * FROM users WHERE username=?').get(name);
  const publicUser = u => u ? Object.fromEntries(Object.entries(u).filter(([k]) => k !== 'password').map(([k,v])=>[k,k==='active'?!!v:v])) : null;
  const hash = p => { const salt=randomBytes(16).toString('hex'); return salt+':'+scryptSync(p,salt,64).toString('hex'); };
  const verify = (p,h) => { const [salt,key]=(h||('dummy:'+ '00'.repeat(64))).split(':'); return timingSafeEqual(scryptSync(p,salt,64),Buffer.from(key,'hex')); };
  const digest = t => createHash('sha256').update(t).digest('hex');
  const fail = (msg,code=400) => { throw Object.assign(new Error(msg),{status:code}); };
  const validate = (p,u) => { if(typeof p!=='string') fail('请输入密码'); const e=validatePassword(p,u); if(e)fail(e); };
  const initialized = () => !!get('admin')?.password;
  const session = req => {
    const token=(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('session='))?.slice(8);
    if(!token) return null;
    const row=db.prepare('SELECT u.*, s.expiresAt FROM sessions s JOIN users u ON s.username=u.username WHERE s.token=? AND s.expiresAt>? AND u.active=1').get(digest(token),Date.now());
    return row ? {...publicUser(row), expiresAt:row.expiresAt} : null;
  };
  const attempts=new Map();
  const limit = req => { const now=Date.now(),key=req.socket.remoteAddress; for(const [k,v] of attempts)if(v.until<now)attempts.delete(k); const a=attempts.get(key)||{count:0,until:now+900000};if(++a.count>20)fail('尝试次数过多，请 15 分钟后再试',429);attempts.set(key,a); };
  async function handle(req,res,path,body) {
    const actor=session(req), action=path.slice('/api/'.length);
    if(req.method==='GET' && action==='session') return {ok:true,user:actor,needsSetup:!initialized()};
    if(req.method==='GET' && action==='users') {if(actor?.role!=='admin')fail('需要管理员权限',403);return {ok:true,users:db.prepare('SELECT * FROM users ORDER BY role,username').all().map(publicUser)};}
    if(req.method!=='POST')fail('接口不存在',404);
    if(action==='setup') {
      limit(req);
      if(initialized())fail('管理员已经初始化',409);
      if(process.env.PUBLIC_ORIGIN || !['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress))fail('首次初始化仅允许在服务器本机完成',403);
      validate(body.password,'admin');
      const changed=db.prepare("UPDATE users SET password=? WHERE username='admin' AND password IS NULL").run(hash(body.password));
      if(!changed.changes)fail('管理员已经初始化',409);
      return {ok:true};
    }
    if(action==='login') {
      limit(req);
      if(typeof body.password!=='string'||body.password.length>128)fail('用户名或密码不正确',401);
      const u=get(String(body.username||'').trim().toLowerCase());
      const valid=verify(body.password,u?.password);
      if(!u?.password||!u.active||!valid)fail('用户名或密码不正确',401);
      const token=randomBytes(32).toString('hex'),ttl=body.remember?604800000:43200000;
      db.prepare('DELETE FROM sessions WHERE expiresAt<=?').run(Date.now());
      db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(digest(token),u.username,Date.now()+ttl);
      res.setHeader('Set-Cookie',`session=${token}; HttpOnly; SameSite=Strict; Path=/${body.remember?`; Max-Age=${ttl/1000}`:''}${process.env.PUBLIC_ORIGIN?.startsWith('https:')?'; Secure':''}`);
      return {ok:true,user:publicUser(u)};
    }
    if(!actor)fail('请先登录',401);
    if(action==='logout') { const token=(req.headers.cookie||'').match(/(?:^|;\s*)session=([^;]+)/)?.[1];if(token)db.prepare('DELETE FROM sessions WHERE token=?').run(digest(token));res.setHeader('Set-Cookie','session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');return {ok:true}; }
    if(action==='password') {
      if(typeof body.oldPassword!=='string'||body.oldPassword.length>128||!verify(body.oldPassword,get(actor.username).password))fail('当前密码不正确');
      validate(body.newPassword,actor.username);
      db.prepare('UPDATE users SET password=? WHERE username=?').run(hash(body.newPassword),actor.username);
      db.prepare('DELETE FROM sessions WHERE username=?').run(actor.username);return {ok:true};
    }
    if(action==='profile') {
      if(body.username!==actor.username && actor.role!=='admin')fail('没有权限',403);
      const error=validateDisplayName(body.displayName);if(error)fail(error);
      db.prepare('UPDATE users SET displayName=?,note=? WHERE username=?').run(body.displayName,String(body.note||'').slice(0,60),body.username);return {ok:true};
    }
    if(actor.role!=='admin')fail('需要管理员权限',403);
    const username=String(body.username||'').trim().toLowerCase();
    if(action==='users/create') {
      const e=validateUsername(username)||validateDisplayName(body.displayName);if(e)fail(e);validate(body.password,username);
      if(!['admin','member'].includes(body.role))fail('角色不正确');if(get(username))fail('登录名已存在');
      db.prepare('INSERT INTO users VALUES(?,?,?,1,?,?,?,?)').run(username,body.displayName,body.role,hash(body.password),String(body.note||'').slice(0,60),new Date().toISOString(),actor.username);
      return {ok:true,user:publicUser(get(username))};
    }
    if(!get(username))fail('用户不存在',404);
    if(['users/active','users/role','users/remove'].includes(action)) {
      if(username===actor.username || username==='admin')fail('不能删除、停用或更改初始管理员及自身权限');
      db.prepare('DELETE FROM sessions WHERE username=?').run(username);
    }
    if(action==='users/active') {if(typeof body.active!=='boolean')fail('状态不正确');db.prepare('UPDATE users SET active=? WHERE username=?').run(+body.active,username);}
    else if(action==='users/role') {if(!['admin','member'].includes(body.role))fail('角色不正确');db.prepare('UPDATE users SET role=? WHERE username=?').run(body.role,username);}
    else if(action==='users/remove')db.prepare('DELETE FROM users WHERE username=?').run(username);
    else if(action==='users/reset') {validate(body.password,username);db.prepare('UPDATE users SET password=? WHERE username=?').run(hash(body.password),username);db.prepare('DELETE FROM sessions WHERE username=?').run(username);}
    else fail('接口不存在',404);
    return {ok:true};
  }
  return {handle,session,close:()=>db.close()};
}
