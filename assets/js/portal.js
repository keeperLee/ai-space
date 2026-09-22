import * as auth from './auth.js';
import { initLogin, dismissBoot } from './login.js';

async function boot() {
  const login=initLogin();
  try { await auth.initialize(); } catch(e) {
    login.showGate();
    document.querySelector('#loginError').textContent=e.message;
    document.querySelector('#loginError').hidden=false;
    document.querySelector('#loginSubmit').disabled=true;
    return;
  }
  if(!auth.currentUser()) { login.showGate(); return; }
  const next=new URLSearchParams(location.search).get('next');
  if(next) {
    const target=new URL(next,location.href);
    if(target.origin===location.origin && (target.pathname==='/learning.html'||target.pathname.startsWith('/projects/'))) { location.replace(target.href); return; }
  }
  dismissBoot();
  document.querySelector('#portalUser').textContent=auth.currentUser().displayName;
  document.querySelector('#portalLogout').addEventListener('click',async()=>{
    const result=await auth.logout();
    if(result.ok) location.reload(); else alert(result.error);
  });
  const {projects}=await import('../../content/projects.js');

const grid = document.querySelector('#projects');
document.querySelector('#projectCount').textContent = `${projects.length} 个可访问项目`;
for (const project of projects) {
  const card = document.createElement('a');
  card.className = 'project-card';
  const url = new URL(project.href, document.baseURI);
  if (!['http:', 'https:'].includes(url.protocol)) continue;
  card.href = url.href;
  const mark = document.createElement('div');
  mark.className = 'project-mark';
  mark.textContent = project.icon || project.title.slice(0, 1);
  const category = document.createElement('span');
  category.className = 'category';
  category.textContent = project.category;
  const title = document.createElement('h3');
  title.textContent = project.title;
  const description = document.createElement('p');
  description.textContent = project.description;
  const tags = document.createElement('div');
  tags.className = 'tags';
  for (const text of project.tags || []) {
    const tag = document.createElement('span');
    tag.textContent = text;
    tags.append(tag);
  }
  const action = document.createElement('div');
  action.className = 'card-action';
  action.textContent = '进入项目 ↗';
  card.append(mark, category, title, description, tags, action);
  grid.append(card);
}

// 兼容之前收藏的课程首页与章节链接。
if (location.hash.startsWith('#/')) {
  location.replace(new URL(`projects/agent-learning/learning.html${location.hash}`, location.href));
}

}
boot();
