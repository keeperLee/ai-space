#!/usr/bin/env node
/* ============================================================
   浏览器交互回归测试（零依赖，通过 CDP 驱动真实点击）
   用法：node scripts/e2e.mjs --base http://127.0.0.1:5173
   ------------------------------------------------------------
   退出码：0 通过 / 1 断言失败 / 2 环境无可用浏览器（调用方可跳过）
   可用 CHROME_PATH 指定浏览器可执行文件路径。

   覆盖的回归点：
   ⓪ 未登录时不得泄露任何学习内容；错误密码不得放行
   ① 点击右侧「本篇目录」应就地滚动，不能跳回首页
   ② 目录链接必须是完整路由，保证中键 / 复制链接可用
   ③ 直接打开带锚点的深链接应正确定位
   ④ 点击正文标题旁的 # 锚点应就地滚动
   ⑤ 阅读设置即时生效并持久化（存储键必须带用户命名空间）
   ⑥ 用户管理：列表、注册、未发布提示、丢弃本机改动
   ⑦ 学习数据按账号隔离，互不串扰

   使用 E2E_USER / E2E_PASS 指定已经初始化的专用测试账号。
      它只在临时的浏览器 profile 里操作，不会修改仓库里的用户名单。
   ============================================================ */

import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const argBase = process.argv.indexOf('--base');
const BASE = (argBase > -1 ? process.argv[argBase + 1] : null) || process.env.E2E_BASE || 'http://127.0.0.1:5173';
const CHAPTER = (process.argv.indexOf('--chapter') > -1 ? process.argv[process.argv.indexOf('--chapter') + 1] : null) || 'c06';
const PORT = 9333 + (process.pid % 500);

const USE_COLOR = !process.env.NO_COLOR && process.stdout.isTTY !== false;
const paint = (s, c) => (USE_COLOR ? `${c}${s}\u001b[0m` : s);
const C = { red: '\u001b[31m', green: '\u001b[32m', yellow: '\u001b[33m', dim: '\u001b[2m', bold: '\u001b[1m' };

const ok = (b) => (b ? paint('✓', C.green) : paint('✗', C.red));

/* ---------------- 定位浏览器 ---------------- */
const CANDIDATES = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
].filter(Boolean);

const BROWSER = CANDIDATES.find((p) => existsSync(p));
if (!BROWSER) {
  console.log(paint('\n  未找到 Chrome / Chromium / Edge，跳过浏览器交互测试。', C.yellow));
  console.log(paint('  如需运行，请设置环境变量 CHROME_PATH 指向浏览器可执行文件。\n', C.dim));
  process.exit(2);
}

// 全局 WebSocket 自 Node 22 起才提供；低版本直接跳过，避免硬失败
if (typeof WebSocket === 'undefined') {
  console.log(paint(`\n  当前 Node ${process.version} 不提供全局 WebSocket（需要 Node ≥ 22），跳过浏览器交互测试。`, C.yellow));
  console.log(paint('  可升级 Node 后重试；其余检查不受影响。\n', C.dim));
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(BROWSER, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--disable-dev-shm-usage', '--no-sandbox',
  '--remote-debugging-port=' + PORT,
  '--user-data-dir=' + join(tmpdir(), 'agent-e2e-' + process.pid),
  '--window-size=1440,900',
  'about:blank'
], { stdio: 'ignore' });

let failed = 0;
function check(pass, label, detail = '') {
  if (!pass) failed++;
  console.log(`  ${ok(pass)} ${label}${detail ? paint('  ' + detail, C.dim) : ''}`);
}

/* 等待 DevTools 就绪 */
let targets = null;
for (let i = 0; i < 60; i++) {
  try {
    targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    if (targets.some((t) => t.type === 'page')) break;
  } catch (_) { /* 端口还没起来 */ }
  await sleep(250);
}
const page = targets?.find((t) => t.type === 'page');
if (!page) {
  chrome.kill();
  console.log(paint('\n  DevTools 端口未能就绪，跳过浏览器交互测试。', C.yellow));
  console.log(paint('  可尝试设置 CHROME_PATH 指定浏览器，或确认浏览器支持 --headless=new。\n', C.dim));
  process.exit(2);
}

/* ---------------- CDP 客户端 ---------------- */
const ws = new WebSocket(page.webSocketDebuggerUrl);
let seq = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
};
const send = (method, params = {}) => new Promise((res) => {
  const id = ++seq;
  pending.set(id, res);
  ws.send(JSON.stringify({ id, method, params }));
});
await new Promise((r) => { ws.onopen = r; });
await send('Runtime.enable');
await send('Page.enable');

async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  const ex = r.result?.exceptionDetails;
  if (ex) throw new Error(ex.exception?.description || ex.text || '页面脚本执行失败');
  return r.result?.result?.value;
}

async function goto(url, waitMs = 1500) {
  await send('Page.navigate', { url });
  await sleep(waitMs);
}

/* ---------------- 登录辅助 ----------------
   登录状态存在 localStorage，而每次测试都用全新的 user-data-dir，
   所以每个场景开始前都需要先登录。 */
const ADMIN_USER = process.env.E2E_USER || 'admin';
const ADMIN_PASS = process.env.E2E_PASS;
if(!ADMIN_PASS) throw new Error('请通过 E2E_PASS 提供专用测试账号密码');

/** 提交登录表单（不等待结果） */
async function fillLogin(username, password) {
  return JSON.parse(await evaluate(`(() => {
    const form = document.getElementById('loginForm');
    if (!form) return JSON.stringify({ error: '页面上找不到登录表单' });
    const gate = document.getElementById('authGate');
    document.getElementById('loginUser').value = ${JSON.stringify(username)};
    document.getElementById('loginPass').value = ${JSON.stringify(password)};
    document.getElementById('loginRemember').checked = true;
    form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    return JSON.stringify({ hadGate: !!gate && !gate.hidden });
  })()`));
}

/** 等待登录后的整页重载完成、应用外壳出现 */
async function waitForApp(timeoutMs = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const s = JSON.parse(await evaluate(`(() => {
      const gate = document.getElementById('authGate');
      const topbar = document.querySelector('.topbar');
      const view = document.getElementById('viewRoot');
      return JSON.stringify({
        // 用计算样式而不是 hidden 属性：曾出现过 .auth-gate 的 display:flex
        // 盖过 [hidden]{display:none}，属性是 hidden 但实际仍然盖在页面上
        gateVisible: !!gate && getComputedStyle(gate).display !== 'none',
        // 首页与章节页都算就绪：顶栏可见 且 主内容区已渲染
        appReady: !!topbar && getComputedStyle(topbar).display !== 'none'
          && !!view && view.children.length > 0,
        loader: !!document.getElementById('bootLoader')
      });
    })()`));
    if (s.appReady && !s.gateVisible && !s.loader) return true;
    await sleep(200);
  }
  return false;
}

async function login(username, password) {
  await fillLogin(username, password);
  return waitForApp();
}

/** 关掉 confirm / alert / prompt，否则无头浏览器会卡在对话框上 */
async function stubDialogs() {
  await evaluate(`(() => {
    window.confirm = () => true;
    window.alert = () => {};
    window.prompt = (msg, def) => (def === undefined ? 'Xx-Reset-Pass-2026' : def);
    return 'ok';
  })()`);
}

const WAIT_ARTICLE = `
  for (let i = 0; i < 80 && !document.querySelector('.article-body'); i++) await sleep(100);
`;

console.log('');
console.log(paint(`  浏览器交互回归测试 · ${BASE} · 章节 ${CHAPTER}`, C.bold));
console.log(paint('  ' + '─'.repeat(58), C.dim));

try {
  /* ---------- 场景 0：登录门禁 ---------- */
  await goto(`${BASE}/projects/agent-learning/learning.html`, 1800);
  const r0 = JSON.parse(await evaluate(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const out = {};
    const gate = document.getElementById('authGate');
    const topbar = document.querySelector('.topbar');
    out.gateVisible = !!gate && getComputedStyle(gate).display !== 'none';
    out.topbarHidden = !!topbar && getComputedStyle(topbar).display === 'none';
    out.noArticle = !document.querySelector('.article-body');
    out.noHero = !document.querySelector('.hero');
    out.noCatalogDom = !document.querySelector('#chapterNav .nav-module');
    out.loaderGone = !document.getElementById('bootLoader');

    document.getElementById('loginUser').value = ${JSON.stringify(ADMIN_USER)};
    document.getElementById('loginPass').value = 'definitely-wrong-password-2026';
    document.getElementById('loginForm').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    await sleep(1000);

    const errBox = document.getElementById('loginError');
    out.errShown = !!errBox && !errBox.hidden && errBox.textContent.trim().length > 0;
    out.errText = errBox ? errBox.textContent.trim() : '';
    out.stillGate = getComputedStyle(document.getElementById('authGate')).display !== 'none';
    out.stillNoContent = !document.querySelector('.hero') && !document.querySelector('.article-body');
    out.passCleared = document.getElementById('loginPass').value === '';
    return JSON.stringify(out);
  })()`));

  console.log('');
  console.log('  场景 0 · 登录门禁（未登录不得泄露任何内容）');
  check(r0.gateVisible, '未登录时显示登录卡片');
  check(r0.topbarHidden, '顶栏与侧边栏整体隐藏');
  check(r0.noArticle && r0.noHero, 'DOM 中不存在任何学习内容');
  check(r0.noCatalogDom, '章节树未渲染');
  check(r0.loaderGone, '启动占位已移除，不会卡在「正在检查登录状态」');
  check(r0.errShown, '错误密码被拒绝并给出提示', r0.errText.slice(0, 24));
  check(r0.stillGate && r0.stillNoContent, '密码错误后仍停在门禁，未放行');
  check(r0.passCleared, '校验失败后密码输入框已清空');

  /* ---------- 登录，后续场景都在登录态下进行 ---------- */
  const loggedIn = await login(ADMIN_USER, ADMIN_PASS);
  check(loggedIn, '正确密码登录成功，应用外壳已启动');

  const r0b = JSON.parse(await evaluate(`(() => {
    const gate = document.getElementById('authGate');
    const topbar = document.querySelector('.topbar');
    return JSON.stringify({
      gateDisplay: getComputedStyle(gate).display,
      topbarDisplay: getComputedStyle(topbar).display,
      locked: document.body.classList.contains('is-locked'),
      pending: document.documentElement.classList.contains('auth-pending')
    });
  })()`));
  check(r0b.gateDisplay === 'none', '登录后门禁真正从渲染树中移除（非仅设置 hidden 属性）', `display=${r0b.gateDisplay}`);
  check(r0b.topbarDisplay !== 'none' && !r0b.locked && !r0b.pending, '应用外壳已解除锁定并可见');

  /* ---------- 场景 1：点击右侧「本篇目录」 ---------- */
  await goto(`${BASE}/projects/agent-learning/learning.html#/chapter/${CHAPTER}`);
  const r1 = JSON.parse(await evaluate(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    ${WAIT_ARTICLE}
    const out = {};
    const links = [...document.querySelectorAll('#tocInner a')];
    out.tocCount = links.length;
    out.hrefsOk = links.every(a => (a.getAttribute('href') || '').startsWith('#/chapter/'));
    const target = links[Math.min(2, links.length - 1)];
    out.anchor = target?.dataset.anchor || null;
    const el = document.getElementById(out.anchor);
    out.topBefore = el ? Math.round(el.getBoundingClientRect().top) : null;
    target.click();
    await sleep(1400);
    out.topAfter = el ? Math.round(el.getBoundingClientRect().top) : null;
    out.hash = location.hash;
    out.onArticle = !!document.querySelector('.article-body');
    out.onHome = !!document.querySelector('.hero');
    out.active = document.querySelector('#tocInner a.is-active')?.dataset.anchor || null;
    return JSON.stringify(out);
  })()`));

  console.log('');
  console.log('  场景 1 · 点击右侧「本篇目录」');
  check(r1.tocCount > 0, `目录渲染出 ${r1.tocCount} 个条目`);
  check(r1.hrefsOk, '目录链接为完整路由（中键 / 复制链接可用）');
  check(r1.onArticle && !r1.onHome, '点击后仍停留在章节页，未跳回首页', `onArticle=${r1.onArticle} onHome=${r1.onHome}`);
  check(r1.hash.includes('#/chapter/'), '地址栏保持章节路由', r1.hash.slice(0, 60));
  check(r1.topAfter !== null && Math.abs(r1.topAfter - 78) < 8, '目标标题滚动到视口顶部附近', `${r1.topBefore}px → ${r1.topAfter}px`);
  check(r1.active === r1.anchor, '右侧目录高亮同步到当前小节');

  /* ---------- 场景 2：直接打开带锚点的深链接 ---------- */
  const anchorName = r1.anchor;
  await goto(`${BASE}/projects/agent-learning/learning.html#/chapter/${CHAPTER}#${encodeURIComponent(anchorName)}`, 1900);
  const r2 = JSON.parse(await evaluate(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    ${WAIT_ARTICLE}
    await sleep(700);
    const el = document.getElementById(${JSON.stringify(anchorName)});
    const maxScroll = document.documentElement.scrollHeight - window.innerHeight;
    return JSON.stringify({
      onArticle: !!document.querySelector('.article-body'),
      onHome: !!document.querySelector('.hero'),
      top: el ? Math.round(el.getBoundingClientRect().top) : null,
      atBottom: window.scrollY >= maxScroll - 4
    });
  })()`));

  console.log('');
  console.log('  场景 2 · 直接打开带锚点的深链接（模拟复制链接后打开）');
  check(r2.onArticle && !r2.onHome, '渲染的是章节页而非首页');
  check(r2.top !== null && (Math.abs(r2.top - 78) < 8 || r2.atBottom),
    '锚点已定位', `距顶 ${r2.top}px${r2.atBottom ? '（页面已到底）' : ''}`);

  /* ---------- 场景 3：点击正文标题旁的 # 锚点 ---------- */
  await goto(`${BASE}/projects/agent-learning/learning.html#/chapter/${CHAPTER}`);
  const r3 = JSON.parse(await evaluate(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    ${WAIT_ARTICLE}
    const a = document.querySelector('.article-body h2 .anchor');
    const href = a?.getAttribute('href') || null;
    a?.click();
    await sleep(1000);
    return JSON.stringify({
      href,
      onArticle: !!document.querySelector('.article-body'),
      onHome: !!document.querySelector('.hero'),
      hash: location.hash
    });
  })()`));

  console.log('');
  console.log('  场景 3 · 点击正文标题旁的 # 锚点');
  check(r3.href && r3.href.startsWith('#'), '锚点链接已渲染', String(r3.href));
  check(r3.onArticle && !r3.onHome, '点击后仍停留在章节页');
  check(r3.hash.includes('#/chapter/'), '地址栏更新为带锚点的章节路由', r3.hash.slice(0, 60));

  /* ---------- 场景 4：更新日志入口 ---------- */
  await goto(`${BASE}/projects/agent-learning/learning.html#/chapter/${CHAPTER}`);
  const r4 = JSON.parse(await evaluate(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    ${WAIT_ARTICLE}
    const out = {};
    const btn = document.getElementById('changelogToggle');
    out.btnText = btn?.textContent?.trim() || null;
    out.dotBefore = !document.getElementById('versionDot')?.hidden;
    btn.click();
    await sleep(350);
    const ov = document.getElementById('changelogOverlay');
    out.opened = !!ov && !ov.hidden;
    out.versions = [...document.querySelectorAll('#changelogBody .cl-ver')].map(n => n.textContent.trim());
    out.items = document.querySelectorAll('#changelogBody .cl-items li').length;
    out.hasLatest = !!document.querySelector('#changelogBody .cl-item.is-latest');
    out.dotAfter = !document.getElementById('versionDot')?.hidden;
    document.querySelector('#changelogOverlay [data-close]')?.click();
    await sleep(250);
    out.closed = document.getElementById('changelogOverlay').hidden;
    out.stillArticle = !!document.querySelector('.article-body');
    return JSON.stringify(out);
  })()`));

  console.log('');
  console.log('  场景 4 · 更新日志入口（顶栏版本号）');
  check(/^v\d+\.\d+\.\d+$/.test(r4.btnText || ''), '顶栏显示版本号', String(r4.btnText));
  check(r4.dotBefore, '未读时入口带提示点');
  check(r4.opened, '点击后打开更新日志面板');
  check(r4.versions.length >= 2, `面板列出 ${r4.versions.length} 个版本`, r4.versions.slice(0, 3).join(' / '));
  check(r4.items > 0, `共 ${r4.items} 条变更记录`);
  check(r4.hasLatest, '最新版本有标记');
  check(!r4.dotAfter, '打开后提示点消除');
  check(r4.closed, '可正常关闭');
  check(r4.stillArticle, '关闭后仍在原章节，视图未被破坏');

  /* ---------- 场景 5：阅读设置 + 内容时效性标注 ---------- */
  await goto(`${BASE}/projects/agent-learning/learning.html#/chapter/c22`, 1800);   // c22 标记为快速变化章节
  const r5 = JSON.parse(await evaluate(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    ${WAIT_ARTICLE}
    const out = {};
    const body = document.querySelector('.article-body');

    // 时效性标注
    out.hasNotice = !!body.querySelector('.callout.warn');
    out.metaHasUpdated = (document.querySelector('.article-meta')?.textContent || '').includes('更新于');

    // 阅读设置
    const fsBefore = getComputedStyle(body).fontSize;
    document.getElementById('readerBtn').click();
    await sleep(250);
    out.panelOpen = !document.getElementById('readerPanel').hidden;
    out.optionCount = document.querySelectorAll('#readerBody .rp-opts button').length;
    out.groups = document.querySelectorAll('#readerBody .rp-row').length;

    document.querySelector('#readerBody button[data-rk="scale"][data-rv="xl"]').click();
    await sleep(200);
    out.fsBefore = fsBefore;
    out.fsAfter = getComputedStyle(body).fontSize;
    out.fsVar = document.documentElement.style.getPropertyValue('--reader-fs');

    document.querySelector('#readerBody button[data-rk="leading"][data-rv="loose"]').click();
    await sleep(150);
    out.lhVar = document.documentElement.style.getPropertyValue('--reader-lh');

    // 存储键现在带用户命名空间，动态定位而不是写死
    const key = Object.keys(localStorage).find(k => /^agent-learning-platform:u:.+:v1$/.test(k));
    out.storageKey = key || null;
    out.persisted = JSON.parse(localStorage.getItem(key) || '{}')?.reader?.scale || null;
    out.noLegacyKey = !Object.keys(localStorage).includes('agent-learning-platform:v1');

    document.querySelector('[data-reader-reset]').click();
    await sleep(200);
    out.fsAfterReset = getComputedStyle(body).fontSize;

    document.getElementById('readerScrim').click();
    await sleep(200);
    out.panelClosed = document.getElementById('readerPanel').hidden;
    out.stillArticle = !!document.querySelector('.article-body');
    return JSON.stringify(out);
  })()`));

  console.log('');
  console.log('  场景 5 · 阅读设置与内容时效性标注');
  check(r5.hasNotice, '快速变化章节自动插入时效提醒');
  check(r5.metaHasUpdated, '文章头部显示「更新于」基准时间');
  check(r5.panelOpen, '点击 Aa 打开阅读设置面板');
  check(r5.groups === 4, `提供 ${r5.groups} 组设置、${r5.optionCount} 个选项`);
  check(r5.fsAfter !== r5.fsBefore && r5.fsVar.includes('19'), '切换字号立即生效',
    `${r5.fsBefore} → ${r5.fsAfter}`);
  check(r5.lhVar === '2.05', '切换行距立即生效', `--reader-lh = ${r5.lhVar}`);
  check(r5.persisted === 'xl', '设置已持久化到本地');
  check(r5.fsAfterReset === r5.fsBefore, '恢复默认生效', `回到 ${r5.fsAfterReset}`);
  check(r5.panelClosed && r5.stillArticle, '面板可关闭且不影响阅读');
  check(!!r5.storageKey && /:u:.+:v1$/.test(r5.storageKey), '设置写入按用户隔离的存储键', String(r5.storageKey));
  check(r5.noLegacyKey, '未再写入旧版全局存储键');

  /* ---------- 场景 6：用户管理后台 ---------- */
  await goto(`${BASE}/projects/agent-learning/learning.html#/`, 1400);
  const r6 = JSON.parse(await evaluate(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const out = {};
    const rows = () => [...document.querySelectorAll('#adminBody .admin-table tbody tr')];

    document.getElementById('userBtn').click();
    await sleep(260);
    out.menuOpen = !document.getElementById('userMenu').hidden;
    out.menuText = document.getElementById('userMenu').textContent.replace(/\\s+/g, ' ').trim();
    out.hasAccountEntry = !!document.querySelector('#userMenu [data-um="account"]');
    out.hasAdminEntry = !!document.querySelector('#userMenu [data-um="admin"]');

    document.querySelector('#userMenu [data-um="admin"]').click();
    await sleep(480);
    out.opened = !document.getElementById('adminOverlay').hidden;
    out.rowsBefore = rows().length;
    out.hasAdminUser = rows().some(r => r.textContent.includes(${JSON.stringify(ADMIN_USER)}));
    out.adminTag = (document.querySelector('#adminBody .tag-admin')?.textContent || '').trim();
    out.cleanNotice = !!document.querySelector('#adminBody .admin-note.is-clean');

    const register = async () => {
      document.querySelector('#adminBody [data-adm="toggle-form"]').click();
      await sleep(220);
      document.getElementById('nuUser').value = 'e2e_user';
      document.getElementById('nuName').value = '测试用户';
      document.getElementById('nuPw').value = 'E2e-Test-Pass-2026';
      document.querySelector('#adminBody [data-adm="create"]').click();
      await sleep(900);
    };

    await register();
    out.rowsAfter = rows().length;
    out.hasNewUser = rows().some(r => r.textContent.includes('e2e_user'));
    const pend = document.querySelector('#adminBody .admin-note:not(.is-clean)');
    out.pendingNotice = !!pend;
    out.pendingText = pend ? pend.textContent.replace(/\\s+/g, ' ').trim().slice(0, 40) : '';
    out.hasExportBtn = !!document.querySelector('#adminBody [data-adm="export-file"]');
    out.dotVisible = !document.getElementById('userPendingDot').hidden;

    // 丢弃本机改动 → 回到仓库名单
    window.confirm = () => true;
    document.querySelector('#adminBody [data-adm="discard"]').click();
    await sleep(800);
    out.rowsAfterDiscard = rows().length;
    out.cleanAfterDiscard = !!document.querySelector('#adminBody .admin-note.is-clean');
    out.dotAfterDiscard = !document.getElementById('userPendingDot').hidden;

    // 再注册一次，供场景 7 使用
    await register();
    out.rowsFinal = rows().length;

    document.querySelector('#adminOverlay [data-close]').click();
    await sleep(260);
    out.closed = document.getElementById('adminOverlay').hidden;
    return JSON.stringify(out);
  })()`));

  console.log('');
  console.log('  场景 6 · 用户管理后台');
  check(r6.menuOpen, '点击头像打开账号菜单');
  check(r6.menuText.includes(ADMIN_USER), '菜单显示当前账号', r6.menuText.slice(0, 44));
  check(r6.hasAccountEntry && r6.hasAdminEntry, '管理员可见「账号设置」与「用户管理」');
  check(r6.opened, '打开用户管理面板');
  check(r6.rowsBefore >= 1 && r6.hasAdminUser, `列出 ${r6.rowsBefore} 个账号，含初始管理员`);
  check(r6.adminTag === '管理员', '角色标签正确', r6.adminTag);
  check(r6.cleanNotice, '无改动时提示「与仓库一致」');
  check(r6.hasNewUser && r6.rowsAfter === r6.rowsBefore + 1, `注册后新增一行（${r6.rowsBefore} → ${r6.rowsAfter}）`);
  check(r6.pendingNotice && r6.hasExportBtn, '出现「未发布」提示与导出入口', r6.pendingText.slice(0, 26));
  check(r6.dotVisible, '顶栏头像出现未发布提示点');
  check(r6.rowsAfterDiscard === r6.rowsBefore && r6.cleanAfterDiscard, '丢弃本机改动后回到仓库名单');
  check(!r6.dotAfterDiscard, '丢弃后提示点消失');
  check(r6.closed, '面板可正常关闭');

  /* ---------- 场景 7：学习数据按账号隔离 ---------- */
  await goto(`${BASE}/projects/agent-learning/learning.html#/chapter/c01`, 1700);
  const r71 = JSON.parse(await evaluate(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    for (let i = 0; i < 80 && !document.querySelector('.article-body'); i++) await sleep(100);
    document.querySelector('[data-mark-done]').click();
    await sleep(600);
    const k = Object.keys(localStorage).find(k => k.includes(':u:${ADMIN_USER}:'));
    const d = JSON.parse(localStorage.getItem(k) || '{}');
    return JSON.stringify({
      key: k || null,
      c01: (d.progress && d.progress.c01 && d.progress.c01.state) || null
    });
  })()`));

  await stubDialogs();
  await evaluate(`document.getElementById('userBtn').click()`);
  await sleep(260);
  await evaluate(`document.querySelector('#userMenu [data-um="logout"]').click()`);
  await sleep(2400);
  const r72 = JSON.parse(await evaluate(`(() => {
    const gate = document.getElementById('authGate');
    const topbar = document.querySelector('.topbar');
    return JSON.stringify({
      gateVisible: !!gate && getComputedStyle(gate).display !== 'none',
      topbarHidden: !!topbar && getComputedStyle(topbar).display === 'none',
      noContent: !document.querySelector('.article-body') && !document.querySelector('.hero'),
      sessionGone: !Object.keys(localStorage).some(k => k.includes('session'))
    });
  })()`));

  const newUserOk = await login('e2e_user', 'E2e-Test-Pass-2026');

  // 用新账号在「另一章」标记完成，这样两边的进度应当互不相同
  await goto(`${BASE}/projects/agent-learning/learning.html#/chapter/c02`, 1800);
  const r73 = JSON.parse(await evaluate(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    for (let i = 0; i < 80 && !document.querySelector('.article-body'); i++) await sleep(100);
    const doneBtnBefore = !!document.querySelector('[data-mark-done]');
    document.querySelector('[data-mark-done]').click();
    await sleep(900);
    const nk = Object.keys(localStorage).find(k => /:u:e2e_user:v1$/.test(k));
    const lk = Object.keys(localStorage).find(k => /:u:${ADMIN_USER}:v1$/.test(k));
    const nd = nk ? JSON.parse(localStorage.getItem(nk) || '{}') : {};
    const ld = lk ? JSON.parse(localStorage.getItem(lk) || '{}') : {};
    const doneOf = (d) => Object.entries(d.progress || {})
      .filter(([, p]) => p.state === 'done').map(([id]) => id).sort();
    return JSON.stringify({
      doneBtnBefore,
      newKey: nk || null,
      adminKey: lk || null,
      newDoneList: doneOf(nd),
      adminDoneList: doneOf(ld),
      newNotes: (nd.notes || []).length,
      distinctKeys: !!nk && !!lk && nk !== lk
    });
  })()`));

  console.log('');
  console.log('  场景 7 · 学习数据按账号隔离');
  check(!!r71.key && r71.c01 === 'done', '管理员名下已记录完成进度', String(r71.key));
  check(r72.gateVisible && r72.topbarHidden, '退出后回到登录门禁');
  check(r72.noContent, '退出后页面上不再残留学习内容');
  check(r72.sessionGone, '会话已清除');
  check(newUserOk, '新账号可登录（本机改动即时生效，尚未推送到仓库）');
  check(r73.distinctKeys, '两个账号使用各自独立的存储命名空间', `${r73.adminKey} ≠ ${r73.newKey}`);
  check(JSON.stringify(r73.newDoneList) === '["c02"]', '新账号的完成记录只落在自己名下', JSON.stringify(r73.newDoneList));
  check(JSON.stringify(r73.adminDoneList) === '["c01"]', '管理员的数据未被新账号改动', JSON.stringify(r73.adminDoneList));
  check(r73.newNotes === 0, '新账号没有继承管理员的笔记');
} catch (err) {
  failed++;
  console.log('');
  console.log(`  ${paint('✗', C.red)} 测试执行出错：${err.message}`);
}

ws.close();
chrome.kill();

console.log('');
if (failed) {
  console.log(paint(`  ${failed} 项断言失败。`, C.red));
  console.log('');
  process.exit(1);
}
console.log(paint('  全部通过。', C.green));
console.log('');
process.exit(0);
