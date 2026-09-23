import * as auth from './auth.js';
import { ACCESS } from './access.js';
import { initLogin, dismissBoot } from './login.js';

/* 服务器在未登录时会把请求重定向到 /?next=...，这里把它送回原目标 */
function followNext() {
  const next = new URLSearchParams(location.search).get('next');
  if (!next) return false;
  const target = new URL(next, location.href);
  if (target.origin !== location.origin) return false;
  if (target.pathname !== '/learning.html' && !target.pathname.startsWith('/projects/')) return false;
  location.replace(target.href);
  return true;
}

async function renderProjects() {
  const { projects } = await import('../../content/projects.js');

  const grid = document.querySelector('#projects');
  document.querySelector('#projectCount').textContent = `${projects.length} 个可访问项目`;
  for (const project of projects) {
    const card = document.createElement('a');
    card.className = 'project-card';
    const url = new URL(project.href, document.baseURI);
    if (!['http:', 'https:'].includes(url.protocol)) continue;
    card.href = url.href;
    // 指向站外的项目（例如源码仓库）在新标签页打开，别把门户顶掉
    const isExternal = url.origin !== location.origin;
    if (isExternal) {
      card.target = '_blank';
      card.rel = 'noopener noreferrer';
    }
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
    action.textContent = project.action || (isExternal ? '在新标签页打开 ↗' : '进入项目 ↗');
    card.append(mark, category, title, description, tags, action);
    grid.append(card);
  }

  // 兼容之前收藏的课程首页与章节链接。
  if (location.hash.startsWith('#/')) {
    location.replace(new URL(`projects/agent-learning/learning.html${location.hash}`, location.href));
  }
}

async function boot() {
  /* ---------- 公开访问：不校验登录，直接进门户 ----------
     这是 GitHub Pages 等静态托管下唯一可行的形态：
     没有服务端就没有 /api/session，只能把访客直接放行。 */
  if (ACCESS.open) {
    document.documentElement.classList.add('open-access');
    if (!ACCESS.showAccountUI) document.documentElement.classList.add('no-account-ui');
    dismissBoot();
    if (followNext()) return;
    await renderProjects();
    return;
  }

  /* ---------- 登录门禁 ---------- */
  const login = initLogin();
  try {
    await auth.initialize();
  } catch (e) {
    login.showGate();
    document.querySelector('#loginError').textContent = e.message;
    document.querySelector('#loginError').hidden = false;
    document.querySelector('#loginSubmit').disabled = true;
    return;
  }
  if (!auth.currentUser()) { login.showGate(); return; }
  if (followNext()) return;

  dismissBoot();
  document.querySelector('#portalUser').textContent = auth.currentUser().displayName;
  document.querySelector('#portalLogout').addEventListener('click', async () => {
    const result = await auth.logout();
    if (result.ok) location.reload(); else alert(result.error);
  });
  await renderProjects();
}

boot();
