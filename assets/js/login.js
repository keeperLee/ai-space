/* ============================================================
   登录门禁 / 账号菜单 / 账号设置
   ------------------------------------------------------------
   门禁的作用是「未登录时看不到任何学习内容」，所以它必须
   在应用首次渲染之前就决定是否放行（见 app.js 的 boot）。

   再次说明：这是访问控制，不是安全边界。界面上有一处固定
   说明，不会让人误以为它提供了真正的防护。
   ============================================================ */

import * as auth from './auth.js';
import * as store from './store.js';
import { $, esc, toast } from './ui.js';

let handlers = { onLogout: null };
let wired = false;

/* ============================================================
   启动占位
   ============================================================ */
export function dismissBoot() {
  document.documentElement.classList.remove('auth-pending');
  const loader = document.getElementById('bootLoader');
  if (loader) loader.remove();
}

/* ============================================================
   登录门禁
   ============================================================ */
function showError(msg) {
  const box = $('#loginError');
  if (!box) return;
  box.textContent = msg || '';
  box.hidden = !msg;
}

function setBusy(busy) {
  const btn = $('#loginSubmit');
  if (!btn) return;
  btn.disabled = !!busy;
  btn.textContent = busy ? '正在验证…' : (auth.needsSetup() ? '设置密码并启用' : '登录');
}

async function onLoginSubmit(e) {
  e.preventDefault();
  const username = $('#loginUser').value.trim();
  const password = $('#loginPass').value;
  const remember = $('#loginRemember').checked;

  if (!username || !password) {
    showError('请填写登录名和密码');
    return;
  }

  showError('');
  setBusy(true);

  let res;
  try {
    if (auth.needsSetup()) {
      if(password !== $('#setupConfirm').value) { setBusy(false); showError('两次密码不一致'); return; }
      res = await auth.setupAdmin(password);
      if(res.ok) res = await auth.login('admin', password, { remember });
    } else res = await auth.login(username, password, { remember });
  } catch (err) {
    setBusy(false);
    showError(`登录过程出错：${err.message}`);
    return;
  }

  if (!res.ok) {
    setBusy(false);
    showError(res.error);
    $('#loginPass').value = '';
    $('#loginPass').focus();
    return;
  }

  // 登录成功：整页重载。这样 store / 搜索索引 / 标注系统 / 事件绑定
  // 全部以「新用户的命名空间」重新初始化，不存在残留状态。
  location.reload();
}

function showGate() {
  dismissBoot();
  document.body.classList.add('is-locked');
  const gate = $('#authGate');
  if (!gate) return;
  gate.hidden = false;
  if(auth.needsSetup()) {
    gate.querySelector('h1').textContent='初始化管理员';
    $('#loginUser').value='admin'; $('#loginUser').readOnly=true;
    $('#loginPass').autocomplete='new-password';
    $('#loginSubmit').textContent='设置密码并启用';
    if(!$('#setupConfirm')) {
      const label=document.createElement('label'); label.className='field';
      label.innerHTML='<span>确认管理员密码</span><input id="setupConfirm" type="password" autocomplete="new-password" required minlength="8" maxlength="128">';
      $('#loginSubmit').before(label);
    }
  }
  const input = $('#loginUser');
  if (input) setTimeout(() => input.focus(), 60);
}

function hideGate() {
  document.body.classList.remove('is-locked');
  const gate = $('#authGate');
  if (gate) gate.hidden = true;
}

/* ============================================================
   顶栏账号入口
   ============================================================ */
function initialsOf(user) {
  const name = (user && (user.displayName || user.username)) || '?';
  return name.trim().slice(0, 1).toUpperCase();
}

export function refreshUserMenu() {
  const user = auth.currentUser();
  const btn = $('#userBtn');
  if (!btn || !user) return;

  const avatar = $('#userAvatar');
  if (avatar) avatar.textContent = initialsOf(user);

  // 管理员且存在未发布改动时，在头像上点一个小圆点
  const pending = auth.pendingChanges();
  const dot = $('#userPendingDot');
  if (dot) dot.hidden = !(user.role === 'admin' && pending.dirty);

  btn.title = `${user.displayName}（@${user.username}）`;
}

function openUserMenu() {
  const menu = $('#userMenu');
  const btn = $('#userBtn');
  if (!menu || !btn) return;

  const user = auth.currentUser();
  if (!user) return;

  const pending = auth.pendingChanges();
  const isAdmin = user.role === 'admin';
  const expiry = auth.sessionExpiryText();

  menu.innerHTML = `
    <div class="um-head">
      <div class="um-avatar">${esc(initialsOf(user))}</div>
      <div class="um-id">
        <b>${esc(user.displayName)}</b>
        <small>@${esc(user.username)} · ${esc(auth.ROLE_LABEL[user.role] || user.role)}</small>
      </div>
    </div>
    <hr />
    <button class="um-item" data-um="account"><span class="um-ico">⚙</span>账号设置</button>
    ${isAdmin ? `<button class="um-item" data-um="admin"><span class="um-ico">👥</span>用户管理${pending.dirty ? ` <span class="tag tag-off">${pending.count} 项待发布</span>` : ''}</button>` : ''}
    ${!isAdmin ? '<button class="um-item" data-um="security"><span class="um-ico">🔒</span>关于本平台的安全边界</button>' : ''}
    <hr />
    <button class="um-item is-danger" data-um="logout"><span class="um-ico">⏻</span>退出登录</button>
    <div class="um-foot">会话${esc(expiry)} · 学习数据按账号隔离</div>
  `;
  menu.hidden = false;

  // 定位到头像下方、右对齐；空间不足时自动收回视口内
  const r = btn.getBoundingClientRect();
  const mw = menu.offsetWidth;
  const left = Math.min(Math.max(8, r.right - mw), window.innerWidth - mw - 8);
  menu.style.top = `${r.bottom + 8}px`;
  menu.style.left = `${left}px`;
}

function closeUserMenu() {
  const menu = $('#userMenu');
  if (menu) menu.hidden = true;
}

function onUserMenuClick(e) {
  const item = e.target.closest('[data-um]');
  if (!item) return;
  const act = item.dataset.um;
  closeUserMenu();

  if (act === 'account') openAccount();
  else if (act === 'admin') handlers.onOpenAdmin && handlers.onOpenAdmin();
  else if (act === 'security') showSecurityNotice();
  else if (act === 'logout') doLogout();
}

async function doLogout() {
  if (!window.confirm('确定要退出登录吗？\n\n本机的学习数据会保留，下次登录同一账号仍可继续。')) return;
  await auth.logout();
  location.reload();
}

function showSecurityNotice() { window.alert('账号信息保存在服务器 SQLite 数据库，密码仅存加盐哈希。学习进度和笔记仍保存在当前浏览器。'); }

/* ============================================================
   账号设置
   ============================================================ */
function pwMeterHTML(id) {
  // 初始 data-score 为空：未输入时四条都保持中性灰，不要先亮一条红的说「很弱」
  return `<div class="pw-meter" id="${id}" data-score="">
    <div class="pw-bars"><i></i><i></i><i></i><i></i></div>
    <div class="pw-label">强度：<b>—</b></div>
  </div>`;
}

function updatePwMeter(meterId, password) {
  const meter = document.getElementById(meterId);
  if (!meter) return;
  const s = auth.passwordStrength(password);
  const has = String(password || '').length > 0;
  meter.dataset.score = has ? String(s.score) : '';
  const label = meter.querySelector('.pw-label');
  if (label) {
    label.innerHTML = has
      ? `强度：<b>${esc(s.label)}</b>${s.hints.length ? ` · 建议：${esc(s.hints.slice(0, 2).join('、'))}` : ''}`
      : '强度：<b>—</b>';
  }
}

export function openAccount() {
  const user = auth.currentUser();
  if (!user) return;

  const overlay = $('#accountOverlay');
  const body = $('#accountBody');
  if (!overlay || !body) return;

  const legacy = store.legacyInfo();
  const canMigrate = legacy && store.isCurrentEmpty();

  body.innerHTML = `
    <div class="admin-note is-clean">
      <span class="an-ico">ℹ️</span>
      <div>
        <b>@${esc(user.username)}</b> · ${esc(auth.ROLE_LABEL[user.role] || user.role)}
        ${user.mustChangePassword ? '<br /><span style="color:var(--warn)">这是初始密码，建议立即修改。</span>' : ''}
        <br />本账号的学习进度、笔记与书签独立存储，不会与其他账号混在一起。
      </div>
    </div>

    <h4 style="margin:4px 0 12px;font-size:14px">个人资料</h4>
    <label class="field">
      <span>显示名</span>
      <input type="text" id="acDisplay" value="${esc(user.displayName)}" maxlength="24" />
    </label>
    <label class="field">
      <span>备注</span>
      <input type="text" id="acNote" value="${esc(user.note || '')}" maxlength="60" placeholder="可选" />
    </label>
    <div class="admin-form-actions">
      <button class="btn btn-sm btn-primary" type="button" data-ac="save-profile">保存资料</button>
    </div>

    <h4 style="margin:22px 0 12px;font-size:14px">修改密码</h4>
    <div class="form-msg" id="acPwMsg" hidden></div>
    <label class="field">
      <span>当前密码</span>
      <input type="password" id="acOldPw" autocomplete="current-password" />
    </label>
    <label class="field">
      <span>新密码</span>
      <input type="password" id="acNewPw" autocomplete="new-password" />
      ${pwMeterHTML('acPwMeter')}
      <span class="hint">至少 ${auth.MIN_PASSWORD} 位。修改后立即生效，所有设备需要重新登录。</span>
    </label>
    <label class="field">
      <span>确认新密码</span>
      <input type="password" id="acNewPw2" autocomplete="new-password" />
    </label>
    <div class="admin-form-actions">
      <button class="btn btn-sm btn-primary" type="button" data-ac="change-pw">修改密码</button>
    </div>

    ${canMigrate ? `
    <h4 style="margin:22px 0 12px;font-size:14px">本机旧数据</h4>
    <div class="admin-note">
      <span class="an-ico">📦</span>
      <div>
        检测到本机存在启用账号功能之前的数据：<b>${legacy.chapters}</b> 章进度、
        <b>${legacy.notes}</b> 条笔记、<b>${legacy.bookmarks}</b> 个书签、<b>${legacy.highlights}</b> 处标注。
        可以把它们归到当前账号名下。
        <div class="admin-note-actions">
          <button class="btn btn-sm" type="button" data-ac="migrate">迁移到我的账号</button>
        </div>
      </div>
    </div>` : ''}
  `;

  body.addEventListener('input', onAccountInput);
  body.addEventListener('click', onAccountClick);

  overlay.hidden = false;
  document.body.classList.add('no-scroll');
}

function closeAccount() {
  const overlay = $('#accountOverlay');
  if (!overlay) return;
  overlay.hidden = true;
  document.body.classList.remove('no-scroll');
  const body = $('#accountBody');
  if (body) {
    body.removeEventListener('input', onAccountInput);
    body.removeEventListener('click', onAccountClick);
  }
}

function onAccountInput(e) {
  if (e.target.id === 'acNewPw') updatePwMeter('acPwMeter', e.target.value);
}

function accountMsg(text, kind = 'is-error') {
  const box = $('#acPwMsg');
  if (!box) return;
  box.className = `form-msg ${kind}`;
  box.textContent = text;
  box.hidden = !text;
}

async function onAccountClick(e) {
  const btn = e.target.closest('[data-ac]');
  if (!btn) return;
  const act = btn.dataset.ac;

  if (act === 'save-profile') {
    const res = await auth.updateProfile(auth.currentUser().username, {
      displayName: $('#acDisplay').value,
      note: $('#acNote').value
    });
    if (!res.ok) { toast(res.error); return; }
    toast('资料已保存到服务器');
    refreshUserMenu();
    return;
  }

  if (act === 'change-pw') {
    const oldPw = $('#acOldPw').value;
    const n1 = $('#acNewPw').value;
    const n2 = $('#acNewPw2').value;

    if (!oldPw) { accountMsg('请填写当前密码'); return; }
    if (n1 !== n2) { accountMsg('两次输入的新密码不一致'); return; }

    btn.disabled = true;
    const res = await auth.changeOwnPassword(oldPw, n1);
    btn.disabled = false;

    if (!res.ok) { accountMsg(res.error); return; }

    location.reload();
    $('#acOldPw').value = '';
    $('#acNewPw').value = '';
    $('#acNewPw2').value = '';
    updatePwMeter('acPwMeter', '');
    refreshUserMenu();
    return;
  }

  if (act === 'migrate') {
    const r = store.migrateLegacyData();
    if (!r.ok) { toast('没有可迁移的数据'); return; }
    toast('已把本机旧数据迁移到当前账号');
    closeAccount();
    location.reload();
  }
}

/* ============================================================
   初始化
   ============================================================ */
export function initLogin(options = {}) {
  handlers = { ...handlers, ...options };
  if (wired) return api;

  const form = $('#loginForm');
  if (form) form.addEventListener('submit', onLoginSubmit);

  const userBtn = $('#userBtn');
  if (userBtn) {
    userBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const menu = $('#userMenu');
      if (menu && !menu.hidden) closeUserMenu();
      else openUserMenu();
    });
  }

  const menu = $('#userMenu');
  if (menu) menu.addEventListener('click', onUserMenuClick);

  document.addEventListener('click', (e) => {
    if (!(e.target instanceof Element)) return;
    if (e.target.closest('#userMenu') || e.target.closest('#userBtn')) return;
    closeUserMenu();
  });

  const overlay = $('#accountOverlay');
  if (overlay) {
    overlay.addEventListener('click', (e) => {
      if (e.target.closest('[data-close]')) closeAccount();
    });
  }

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    closeUserMenu();
    if (overlay && !overlay.hidden) closeAccount();
  });

  window.addEventListener('resize', closeUserMenu);
  wired = true;
  return api;
}

const api = {
  showGate,
  hideGate,
  refreshUserMenu,
  openAccount,
  closeAccount,
  closeUserMenu
};

export { showGate, hideGate, closeAccount };
