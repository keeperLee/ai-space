export { ROLES, ROLE_LABEL, MIN_PASSWORD, normalizeUsername, validateUsername, validateDisplayName, validatePassword, passwordStrength } from './userdir.js';
let user=null, setup=false, users=[];
export async function request(action,body) {
  try {
    const res=await fetch(new URL(`../../api/${action}`,import.meta.url),{method:body===undefined?'GET':'POST',credentials:'same-origin',headers:body===undefined?{}:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
    return await res.json();
  } catch {return {ok:false,error:'无法连接账号服务。请使用 Node 服务访问，GitHub Pages 不支持数据库登录。'};}
}
export async function initialize(){const r=await request('session');if(!r.ok)throw new Error(r.error);user=r.user;setup=r.needsSetup;try { for(const s of [localStorage,sessionStorage]){s.removeItem('agent-learning-platform:session:v1');s.removeItem('agent-learning-platform:users-override:v1');} } catch {}}
export const needsSetup=()=>setup;
export const setupAdmin=password=>request('setup',{password});
export const currentUser=()=>user;
export const isAdmin=()=>user?.role==='admin';
export const isLoggedIn=()=>!!user;
export const namespaceOf=(u=user)=>u?`u:${u.username}`:'public';
export const pendingChanges=()=>({dirty:false,count:0});
export const syncIfClean=()=>{};
export const sessionExpiryText=()=>user?.expiresAt?`有效至 ${new Date(user.expiresAt).toLocaleString()}`:'';
export const login=(username,password,opts={})=>request('login',{username,password,...opts});
export const logout=()=>request('logout',{});
export const changeOwnPassword=(oldPassword,newPassword)=>request('password',{oldPassword,newPassword});
export async function updateProfile(username,fields){const r=await request('profile',{username,...fields});if(r.ok&&username===user?.username)user={...user,...fields};return r;}
export async function loadUsers(){const r=await request('users');if(!r.ok)throw new Error(r.error);users=r.users;return users;}
export const listUsers=()=>users;
export const findUser=name=>users.find(u=>u.username===name);
export const createUser=body=>request('users/create',body);
export const setUserActive=(username,active)=>request('users/active',{username,active});
export const setUserRole=(username,role)=>request('users/role',{username,role});
export const removeUser=username=>request('users/remove',{username});
export const resetPassword=(username,password)=>request('users/reset',{username,password});
