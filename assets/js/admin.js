import * as auth from './auth.js';
import { $, esc, toast, copyText } from './ui.js';
import { refreshUserMenu } from './login.js';

let opened = false;

/* ============================================================
   工具
   ============================================================ */
function initials(user) {
  return String(user.displayName || user.username).trim().slice(0, 1).toUpperCase();
}

function downloadFile(filename, content, mime = 'text/javascript;charset=utf-8') {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

/* ============================================================
   渲染
   ============================================================ */
export async function renderAdmin() {
  const me = auth.currentUser();
  const body = $('#adminBody');
  if (!body) return;
  if (!me || me.role !== 'admin') {
    body.innerHTML = '<div class="admin-empty">没有访问权限</div>';
    return;
  }

  let users;
  try { users = await auth.loadUsers(); } catch (e) { body.textContent=e.message; return; }
  const pending = auth.pendingChanges();
  const activeCount = users.filter((u) => u.active).length;
  const adminCount = users.filter((u) => u.role === 'admin' && u.active).length;

  const sub = $('#adminSub');
  if (sub) sub.textContent = `${users.length} 个账号 · ${adminCount} 个管理员 · ${activeCount} 个启用`;

  body.innerHTML = `
    ${pendingHTML(pending)}
    ${toolbarHTML(pending)}
    ${registerFormHTML()}
    ${users.length ? tableHTML(users, me) : '<div class="admin-empty">还没有任何账号</div>'}
    ${boundaryHTML()}
  `;

  bindOnce(body);
}

function pendingHTML() { return '<div class="admin-note is-clean">账号信息来自服务器数据库，修改后立即生效，无需导出或提交。</div>'; }
function toolbarHTML() { return '<div class="admin-toolbar"><button class="btn btn-sm btn-primary" data-adm="toggle-form">注册新用户</button></div>'; }

function registerFormHTML() {
  return `<div class="admin-form" id="adminForm" hidden>
    <h4>注册新用户</h4>
    <div class="form-msg" id="adminFormMsg" hidden></div>
    <div class="field-row">
      <label class="field">
        <span>登录名 *</span>
        <input type="text" id="nuUser" placeholder="小写字母 / 数字 / 下划线" maxlength="24" autocomplete="off" />
        <span class="hint">3~24 位，注册后不可修改</span>
      </label>
      <label class="field">
        <span>显示名 *</span>
        <input type="text" id="nuName" placeholder="张三" maxlength="24" autocomplete="off" />
      </label>
    </div>
    <label class="field">
      <span>初始密码 *</span>
      <input type="password" id="nuPw" placeholder="至少 ${auth.MIN_PASSWORD} 位" autocomplete="off" />
      <div class="pw-meter" id="nuPwMeter" data-score="">
        <div class="pw-bars"><i></i><i></i><i></i><i></i></div>
        <div class="pw-label">强度：<b>—</b></div>
      </div>
      <span class="hint">系统只保存加盐哈希，不保存明文，创建后无法找回，只能重置。</span>
    </label>
    <div class="field-row">
      <label class="field">
        <span>角色</span>
        <select id="nuRole">
          <option value="member">普通用户 —— 只能学习</option>
          <option value="admin">管理员 —— 可管理用户</option>
        </select>
      </label>
      <label class="field">
        <span>备注</span>
        <input type="text" id="nuNote" placeholder="可选，例如部门或用途" maxlength="60" autocomplete="off" />
      </label>
    </div>
    <div class="admin-form-actions">
      <button class="btn btn-sm btn-primary" type="button" data-adm="create">创建账号</button>
      <button class="btn btn-sm btn-ghost" type="button" data-adm="cancel-form">取消</button>
    </div>
  </div>`;
}

function tableHTML(users, me) {
  return `<table class="admin-table">
    <thead>
      <tr>
        <th>账号</th>
        <th>角色</th>
        <th>状态</th>
        <th>创建</th>
        <th style="text-align:right">操作</th>
      </tr>
    </thead>
    <tbody>
      ${users.map((u) => userRow(u, me)).join('')}
    </tbody>
  </table>`;
}

function userRow(u, me) {
  const isSelf = u.username === me.username;
  const canRemove = !isSelf;

  return `<tr class="${u.active ? '' : 'is-off'}">
    <td data-th="账号">
      <div class="who">
        <span class="av">${esc(initials(u))}</span>
        <span>
          <b>${esc(u.displayName)}</b>
          <small>@${esc(u.username)}${isSelf ? ' · 你自己' : ''}${u.note ? ` · ${esc(u.note)}` : ''}</small>
        </span>
      </div>
    </td>
    <td data-th="角色">
      <span class="tag ${u.role === 'admin' ? 'tag-admin' : 'tag-member'}">${esc(auth.ROLE_LABEL[u.role] || u.role)}</span>
    </td>
    <td data-th="状态">
      <span class="tag ${u.active ? 'tag-on' : 'tag-off'}">${u.active ? '启用' : '已停用'}</span>
      ${u.mustChangePassword ? '<span class="tag tag-self" style="margin-left:4px">初始密码</span>' : ''}
    </td>
    <td data-th="创建" class="muted-cell">
      ${esc(u.createdAt || '—')}<br />
      <span style="font-size:11.5px">by ${esc(u.createdBy || '—')}</span>
    </td>
    <td data-th="操作">
      <div class="row-act">
        <button class="btn btn-sm" type="button" data-adm="toggle-active" data-user="${esc(u.username)}"${isSelf && u.active ? ' disabled title="不能停用自己正在使用的账号"' : ''}>
          ${u.active ? '停用' : '启用'}
        </button>
        <button class="btn btn-sm" type="button" data-adm="toggle-role" data-user="${esc(u.username)}"${isSelf && u.role === 'admin' ? ' disabled title="不能取消自己的管理员权限"' : ''}>
          ${u.role === 'admin' ? '取消管理员' : '设为管理员'}
        </button>
        <button class="btn btn-sm" type="button" data-adm="reset-pw" data-user="${esc(u.username)}">重置密码</button>
        ${canRemove ? `<button class="btn btn-sm btn-ghost" type="button" data-adm="remove" data-user="${esc(u.username)}">删除</button>` : ''}
      </div>
    </td>
  </tr>`;
}

function boundaryHTML() { return '<p class="hint">密码仅保存加盐哈希。重置密码或停用用户会立即使已有会话失效。</p>'; }

function formMsg(text, kind = 'is-error') {
  const box = $('#adminFormMsg');
  if (!box) return;
  box.className = `form-msg ${kind}`;
  box.textContent = text;
  box.hidden = !text;
}

function updateSelectMeter() {
  const meter = $('#nuPwMeter');
  const input = $('#nuPw');
  if (!meter || !input) return;
  const s = auth.passwordStrength(input.value);
  const has = input.value.length > 0;
  meter.dataset.score = has ? String(s.score) : '';
  const label = meter.querySelector('.pw-label');
  if (label) {
    label.innerHTML = has
      ? `强度：<b>${esc(s.label)}</b>${s.hints.length ? ` · 建议：${esc(s.hints.slice(0, 2).join('、'))}` : ''}`
      : '强度：<b>—</b>';
  }
}

/* ============================================================
   事件
   ============================================================ */
function bindOnce(body) {
  // 每次渲染都会重建 DOM，这里只绑定一次委托
  if (body.dataset.bound === '1') return;
  body.dataset.bound = '1';

  body.addEventListener('input', (e) => {
    if (e.target.id === 'nuPw') updateSelectMeter();
  });

  body.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-adm]');
    if (!btn) return;
    const act = btn.dataset.adm;
    const username = btn.dataset.user;

    try {
      await handleAction(act, username, btn);
    } catch (err) {
      toast(`操作失败：${err.message}`);
    }
  });
}

async function handleAction(act, username, btn) {
  switch (act) {
    case 'toggle-form': {
      const form = $('#adminForm');
      if (!form) return;
      form.hidden = !form.hidden;
      if (!form.hidden) {
        formMsg('');
        $('#nuUser').value = '';
        $('#nuName').value = '';
        $('#nuPw').value = '';
        $('#nuNote').value = '';
        $('#nuRole').value = 'member';
        updateSelectMeter();
        setTimeout(() => $('#nuUser').focus(), 50);
      }
      return;
    }

    case 'cancel-form':
      $('#adminForm').hidden = true;
      return;

    case 'create': {
      const payload = {
        username: $('#nuUser').value,
        displayName: $('#nuName').value,
        password: $('#nuPw').value,
        role: $('#nuRole').value,
        note: $('#nuNote').value
      };
      btn.disabled = true;
      const res = await auth.createUser(payload);
      btn.disabled = false;

      if (!res.ok) { formMsg(res.error); return; }

      formMsg(`账号「${res.user.username}」已创建。`
        + `账号已保存到数据库，可以在其他设备登录。`, 'is-warn');
      $('#adminForm').hidden = true;
      afterChange();
      toast(`已创建 ${res.user.username}`);
      return;
    }

    case 'toggle-active': {
      const u = auth.findUser(username);
      if (!u) return;
      const next = !u.active;
      if (!next && !window.confirm(`停用「${u.displayName}（@${username}）」后该账号将无法登录，确定吗？`)) return;
      const res = await auth.setUserActive(username, next);
      if (!res.ok) { toast(res.error); return; }
      afterChange();
      toast(next ? '账号已启用' : '账号已停用');
      return;
    }

    case 'toggle-role': {
      const u = auth.findUser(username);
      if (!u) return;
      const next = u.role === 'admin' ? 'member' : 'admin';
      if (next === 'member' && !window.confirm(`取消「${u.displayName}」的管理员权限？`)) return;
      const res = await auth.setUserRole(username, next);
      if (!res.ok) { toast(res.error); return; }
      afterChange();
      toast(next === 'admin' ? '已设为管理员' : '已取消管理员权限');
      return;
    }

    case 'reset-pw': {
      const u = auth.findUser(username);
      if (!u) return;
      const pw = window.prompt(`为「${u.displayName}（@${username}）」设置新密码（至少 ${auth.MIN_PASSWORD} 位）：`, '');
      if (pw === null) return;
      const res = await auth.resetPassword(username, pw);
      if (!res.ok) { toast(res.error); return; }
      afterChange();
      toast(`已重置 ${username} 的密码`);
      return;
    }

    case 'remove': {
      const u = auth.findUser(username);
      if (!u) return;
      if (!window.confirm(`确定删除「${u.displayName}（@${username}）」吗？\n\n该账号将无法登录。已产生的学习数据仍保留在本机浏览器中。`)) return;
      const res = await auth.removeUser(username);
      if (!res.ok) { toast(res.error); return; }
      afterChange();
      toast('账号已删除');
      return;
    }

    default:
      return;
  }
}

function afterChange() {
  renderAdmin();
  refreshUserMenu();
}

/* ============================================================
   开关
   ============================================================ */
export function openAdmin() {
  const me = auth.currentUser();
  if (!me || me.role !== 'admin') {
    toast('只有管理员可以访问用户管理');
    return;
  }
  const overlay = $('#adminOverlay');
  if (!overlay) return;
  renderAdmin();
  overlay.hidden = false;
  document.body.classList.add('no-scroll');
  opened = true;
}

export function closeAdmin() {
  const overlay = $('#adminOverlay');
  if (!overlay) return;
  overlay.hidden = true;
  document.body.classList.remove('no-scroll');
  opened = false;
}

export function isAdminOpen() { return opened; }

export function initAdmin() {
  const overlay = $('#adminOverlay');
  if (!overlay) return;
  overlay.addEventListener('click', (e) => {
    if (e.target.closest('[data-close]')) closeAdmin();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && opened) closeAdmin();
  });
}
