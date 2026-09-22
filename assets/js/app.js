/* ============================================================
   应用入口：路由 / 视图 / 导航 / 阅读进度
   ============================================================ */

import * as store from './store.js';
import * as auth from './auth.js';
import { $, $$, esc, toast, throttle, copyText } from './ui.js';
import { renderMarkdown } from './markdown.js';
import { mountDemos } from './demos.js';
import { loadChapter } from './content.js';
import { initSearch, buildIndex } from './search.js';
import { initAnnotate, applyHighlights } from './annotate.js';
import { initLogin, dismissBoot } from './login.js';
import { initAdmin, openAdmin } from './admin.js';

const CAT = window.CATALOG;
const TAG_LABEL = { basic: '基础', mid: '核心', adv: '架构', lab: '实验', ref: '参考' };

let currentChapterId = null;
let currentToc = [];
let tocObserverLock = false;

/* ============================================================
   路由
   ============================================================ */
/** decodeURIComponent 在遇到非法转义序列时会抛错，这里做一次兜底 */
function safeDecode(s) {
  try { return decodeURIComponent(s); } catch (_) { return String(s); }
}

function parseRoute() {
  const raw = safeDecode(location.hash.replace(/^#/, ''));
  // 不以 "/" 开头的 hash 是「页内锚点」（如 #为什么），不属于路由。
  // 若把它当成路由解析，会被误判为首页并触发整页重渲染。
  if (raw && !raw.startsWith('/')) return { name: 'anchor', anchor: raw };
  const [pathPart, anchor] = raw.split('#');
  const seg = (pathPart || '/').split('/').filter(Boolean);
  if (seg[0] === 'chapter' && seg[1]) return { name: 'chapter', id: seg[1], anchor: anchor || '' };
  return { name: 'home', anchor: anchor || '' };
}

function navigate(chapterId, anchor = '') {
  const hash = chapterId ? `#/chapter/${chapterId}${anchor ? `#${encodeURIComponent(anchor)}` : ''}` : '#/';
  if (location.hash === hash) { route(); return; }
  location.hash = hash;
}

/* ============================================================
   侧边栏
   ============================================================ */
function visibleIds() {
  const p = CAT.paths.find((x) => x.id === store.getState().path);
  return p && p.chapters ? new Set(p.chapters) : null;
}

function renderPathSwitch() {
  const cur = store.getState().path;
  $('#pathSwitch').innerHTML = CAT.paths
    .map((p) => `<button type="button" data-path="${p.id}" class="${p.id === cur ? 'is-active' : ''}" title="${esc(p.desc)}">${esc(p.name)}</button>`)
    .join('');
}

function renderSidebarProgress() {
  const ids = visibleIds();
  const list = CAT.allChapters.filter((c) => !ids || ids.has(c.id));
  const done = list.filter((c) => store.getProgress(c.id).state === 'done').length;
  const pct = list.length ? Math.round((done / list.length) * 100) : 0;
  const path = CAT.paths.find((p) => p.id === store.getState().path);
  $('#sidebarProgress').innerHTML = `
    <div class="sp-head"><span>${esc(path ? path.name : '')}路径 · ${list.length} 章</span><b>${pct}%</b></div>
    <div class="sp-track"><i style="width:${pct}%"></i></div>`;
}

function renderChapterNav() {
  const ids = visibleIds();
  const collapsed = store.getState().collapsed;
  const html = CAT.modules.map((m) => {
    const chapters = m.chapters.filter((c) => !ids || ids.has(c.id));
    if (!chapters.length) return '';
    const done = chapters.filter((c) => store.getProgress(c.id).state === 'done').length;
    return `<div class="nav-module" data-collapsed="${collapsed[m.id] ? 'true' : 'false'}">
      <button class="nav-module-head" type="button" data-toggle="${m.id}">
        <span class="chev"><svg viewBox="0 0 24 24" width="12" height="12" fill="none"><path d="m6 9 6 6 6-6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
        <span>${esc(m.name)}</span>
        <span class="nm-count">${done}/${chapters.length}</span>
      </button>
      <div class="nav-items">
        ${chapters.map((c) => {
          const p = store.getProgress(c.id);
          const dot = p.state === 'done' ? 'dot-done' : p.state === 'reading' ? 'dot-reading' : 'dot-none';
          return `<a class="nav-item ${c.id === currentChapterId ? 'is-active' : ''}" href="#/chapter/${c.id}" title="${esc(c.summary)}">
            <i class="dot ${dot}"></i>
            <span class="n-title">${esc(c.title)}</span>
            <span class="n-tag t-${c.tag}">${TAG_LABEL[c.tag] || ''}</span>
          </a>`;
        }).join('')}
      </div>
    </div>`;
  }).join('');
  $('#chapterNav').innerHTML = html;
}

function refreshNav() {
  renderSidebarProgress();
  renderChapterNav();
}

/* ============================================================
   首页
   ============================================================ */
function chapterCard(c) {
  const p = store.getProgress(c.id);
  const badge = p.state === 'done' ? '<span class="pill pill-ok">已完成</span>'
    : p.state === 'reading' ? `<span class="pill pill-warn">读至 ${p.pct}%</span>`
      : `<span class="pill">${c.minutes} 分钟</span>`;
  return `<a class="card" href="#/chapter/${c.id}">
    <div class="card-icon">${esc((TAG_LABEL[c.tag] || '章')[0])}</div>
    <h3>${esc(c.title)} ${badge}</h3>
    <p>${esc(c.summary)}</p>
    <div class="card-meta"><span>${esc(c.moduleName)}</span></div>
  </a>`;
}

function renderHome() {
  currentChapterId = null;
  currentToc = [];
  const layout = $('#layout');
  layout.classList.add('no-toc');
  $('#toc').hidden = true;
  $('.main').classList.add('is-home');
  refreshNav();

  const all = CAT.allChapters;
  const doneCount = all.filter((c) => store.getProgress(c.id).state === 'done').length;
  const pct = Math.round((doneCount / all.length) * 100);
  const last = store.getState().lastChapter;
  const lastC = last ? CAT.byId[last] : null;
  const nextUndone = all.find((c) => store.getProgress(c.id).state !== 'done') || all[0];
  const path = CAT.paths.find((p) => p.id === store.getState().path) || CAT.paths[0];

  const resume = lastC
    ? `<div class="resume">
        <div class="rs-icon">▶</div>
        <div class="rs-body">
          <div class="rs-kicker">继续学习</div>
          <div class="rs-title">${esc(lastC.title)}</div>
          <div class="rs-sub">${esc(lastC.moduleName)} · 上次读到 ${store.getProgress(last).pct || 0}%</div>
        </div>
        <a class="btn btn-primary btn-sm" href="#/chapter/${last}">继续阅读</a>
      </div>`
    : '';

  $('#viewRoot').innerHTML = `
  <section class="hero">
    <span class="hero-kicker">🤖 Agent 系统化学习平台</span>
    <h1>从「调用模型」到<br /><em>构建会思考、会动手的 Agent</em></h1>
    <p>四条主线贯穿完整知识体系：基础概念 → 核心原理 → 架构设计 → 实战案例。每章配有结构示意图、可运行代码与交互式演示，并支持进度跟踪、笔记标注与分级阅读。</p>
    <div class="hero-actions">
      <a class="btn btn-primary" href="#/chapter/${resume ? last : nextUndone.id}">${resume ? '继续上次阅读' : '开始学习第一课'}</a>
      <button class="btn" type="button" data-open-search>🔍 搜索知识点 <kbd class="kbd">Ctrl K</kbd></button>
      <button class="btn btn-ghost" type="button" data-open-notes>📝 我的笔记</button>
    </div>
  </section>

  ${resume}

  <div class="stat-row" style="margin-top:22px">
    <div class="stat"><b>${all.length}</b><span>结构化章节</span></div>
    <div class="stat"><b>8</b><span>交互式演示</span></div>
    <div class="stat"><b>${doneCount}</b><span>已完成 · ${pct}%</span></div>
    <div class="stat"><b>4</b><span>分级学习路径</span></div>
  </div>

  <div class="section-head">
    <h2>选择你的阅读路径</h2>
    <span class="sub">路径为递进关系，可随时切换</span>
  </div>
  <div class="grid grid-4">
    ${CAT.paths.map((p) => {
      const list = p.chapters ? all.filter((c) => p.chapters.includes(c.id)) : all;
      const d = list.filter((c) => store.getProgress(c.id).state === 'done').length;
      const pp = list.length ? Math.round((d / list.length) * 100) : 0;
      const target = list.find((c) => store.getProgress(c.id).state !== 'done') || list[0];
      return `<div class="path-card ${p.id === path.id ? 'is-active' : ''}">
        <div class="pc-top"><span class="pc-emoji">${p.emoji}</span><span class="pill ${p.id === path.id ? 'pill-accent' : ''}">${esc(p.level)}</span></div>
        <h3>${esc(p.name)}路径</h3>
        <p>${esc(p.desc)}</p>
        <div class="pc-bar"><i style="width:${pp}%"></i></div>
        <div class="pc-foot">
          <span>${d}/${list.length} 章 · ${pp}%</span>
          <span style="display:flex;gap:6px">
            <button class="btn btn-sm" type="button" data-set-path="${p.id}">设为当前</button>
            <a class="btn btn-sm btn-primary" href="#/chapter/${target.id}">开始</a>
          </span>
        </div>
      </div>`;
    }).join('')}
  </div>

  <div class="section-head">
    <h2>学习路线图</h2>
    <span class="sub">建议按顺序推进，每完成一模块再做下一模块</span>
  </div>
  <div class="card" style="padding:22px 24px">
    <div class="roadmap">
      ${CAT.modules.map((m, i) => {
        const d = m.chapters.filter((c) => store.getProgress(c.id).state === 'done').length;
        const cur = d > 0 && d < m.chapters.length;
        const cls = d === m.chapters.length ? 'is-done' : cur ? 'is-current' : '';
        return `<div class="rm-step ${cls}">
          <div class="rm-rail"><div class="rm-dot">${d === m.chapters.length ? '✓' : i + 1}</div><div class="rm-line"></div></div>
          <div class="rm-body">
            <h4>${esc(m.name)}</h4>
            <p>${esc(m.desc)} · 已完成 ${d}/${m.chapters.length}</p>
            <div class="rm-chips">
              ${m.chapters.map((c) => `<span class="rm-chip ${store.getProgress(c.id).state === 'done' ? 'is-done' : ''}" data-goto="${c.id}">${store.getProgress(c.id).state === 'done' ? '✓ ' : ''}${esc(c.title)}</span>`).join('')}
            </div>
          </div>
        </div>`;
      }).join('')}
    </div>
  </div>

  <div class="section-head">
    <h2>全部章节</h2>
    <span class="sub">共 ${all.length} 章</span>
  </div>
  ${CAT.modules.map((m) => `
    <div style="margin-bottom:26px">
      <h3 style="font-size:14px;color:var(--text-3);font-weight:700;letter-spacing:.04em;margin:0 0 12px">${esc(m.name)}</h3>
      <div class="grid grid-3">${m.chapters.map(chapterCard).join('')}</div>
    </div>`).join('')}

  ${store.getState().recent.length ? `
  <div class="section-head"><h2>最近阅读</h2></div>
  <div class="grid grid-3">
    ${store.getState().recent.slice(0, 3).map((id) => CAT.byId[id] ? chapterCard({ ...CAT.byId[id] }) : '').join('')}
  </div>` : ''}
  `;

  window.scrollTo(0, 0);
  $('#readingProgress span').style.width = '0%';

  $('#viewRoot').querySelectorAll('[data-goto]').forEach((n) => {
    n.addEventListener('click', () => navigate(n.dataset.goto));
  });
}

/* ============================================================
   章节视图
   ============================================================ */
function skeleton() {
  return `<div class="article">
    <div style="height:14px;width:180px;background:var(--surface-3);border-radius:5px;margin-bottom:18px"></div>
    <div style="height:30px;width:66%;background:var(--surface-3);border-radius:7px;margin-bottom:26px"></div>
    ${Array.from({ length: 7 }).map((_, i) => `<div style="height:14px;width:${88 - i * 4}%;background:var(--surface-2);border-radius:5px;margin-bottom:12px"></div>`).join('')}
    <p class="muted" style="margin-top:26px;font-size:13px">正在加载章节内容…</p>
  </div>`;
}

async function renderChapter(id, anchor) {
  const meta = CAT.byId[id];
  if (!meta) {
    $('#viewRoot').innerHTML = `<div class="empty"><div class="em-ico">🤔</div><p>找不到章节「${esc(id)}」</p><small>可能链接已失效，<a href="#/">返回首页</a></small></div>`;
    return;
  }
  currentChapterId = id;
  $('#layout').classList.remove('no-toc');
  $('#toc').hidden = false;
  $('.main').classList.remove('is-home');
  $('#viewRoot').innerHTML = skeleton();
  refreshNav();

  let md;
  try {
    md = await loadChapter(id);
  } catch (err) {
    $('#viewRoot').innerHTML = `<div class="empty"><div class="em-ico">⚠️</div><p>章节内容加载失败</p><small style="display:block;max-width:52ch;margin:8px auto 0;line-height:1.7">${esc(err.message)}</small></div>`;
    return;
  }

  // 去掉正文首行的 H1（标题已由文章头部呈现，避免重复）
  const body = md.replace(/^\s*#\s+[^\n]*\r?\n/, '');
  const { html, toc } = renderMarkdown(body);
  currentToc = toc;
  const all = CAT.allChapters;
  const idx = all.findIndex((c) => c.id === id);
  const prev = all[idx - 1];
  const next = all[idx + 1];
  const p = store.getProgress(id);
  const isMarked = store.isBookmarked(id, '');

  $('#viewRoot').innerHTML = `
  <article class="article">
    <header class="article-header">
      <div class="article-crumb">${esc(meta.moduleName)}</div>
      <h1>${esc(meta.title)}</h1>
      <p class="article-lede">${esc(meta.summary)}</p>
      <div class="article-meta">
        <span class="n-tag t-${meta.tag}">${TAG_LABEL[meta.tag]}</span>
        <span>⏱ 约 ${meta.minutes} 分钟</span>
        <span>·</span>
        <span>第 ${idx + 1} / ${all.length} 章</span>
        <span>·</span>
        <span title="本章内容的信息基准时间">更新于 ${esc(meta.updated)}</span>
        ${p.state === 'done' ? '<span class="pill pill-ok">已完成</span>' : p.pct ? `<span class="pill pill-warn">进度 ${p.pct}%</span>` : ''}
      </div>
      <div class="article-actions">
        <button class="btn btn-sm ${isMarked ? 'is-on' : ''}" type="button" data-bookmark>${isMarked ? '★ 已收藏' : '☆ 收藏本章'}</button>
        <button class="btn btn-sm" type="button" data-copy-link>🔗 复制链接</button>
        <button class="btn btn-sm" type="button" data-mark-done>${p.state === 'done' ? '↺ 取消完成' : '✓ 标记完成'}</button>
      </div>
    </header>
    <div class="article-body" id="articleBody">${volatilityNotice(meta)}${html}</div>
    <footer class="article-footer">
      <div class="af-done">
        <button class="btn ${p.state === 'done' ? '' : 'btn-primary'}" type="button" data-mark-done>${p.state === 'done' ? '↺ 取消「已完成」' : '✓ 我已完成本章'}</button>
        <span class="muted" style="font-size:12.5px">完成后会计入学习进度</span>
      </div>
      <nav class="article-nav">
        ${prev ? `<a class="an-prev" href="#/chapter/${prev.id}"><small>上一章</small><span>${esc(prev.title)}</span></a>` : '<span></span>'}
        ${next ? `<a class="an-next" href="#/chapter/${next.id}"><small>下一章</small><span>${esc(next.title)}</span></a>` : '<span></span>'}
      </nav>
    </footer>
  </article>`;

  // 交互演示
  mountDemos($('#articleBody'));

  // 高亮恢复
  applyHighlights(id, $('#articleBody'));

  // 目录
  renderToc(toc);

  // 阅读进度记录
  store.pushRecent(id);
  store.markReading(id, 0);
  refreshNav();
  refreshBadges();

  // 滚动到锚点或顶部
  if (anchor) {
    // 深链接首次定位：立即跳转（不用平滑动画），并在演示组件挂载后校正一次
    const jump = () => scrollToAnchor(anchor, false, false);
    jump();
    setTimeout(jump, 80);
    setTimeout(() => { if (document.getElementById(anchor)) jump(); }, 360);
  } else if (p.scroll && p.state !== 'done') {
    setTimeout(() => window.scrollTo({ top: p.scroll }), 40);
  } else {
    window.scrollTo(0, 0);
  }
  updateReadingProgress();
}

/** 快速变化的章节自动加一条时效提醒（由 catalog 的 volatile 字段驱动） */
function volatilityNotice(meta) {
  if (!meta.volatile) return '';
  return `<div class="callout warn" style="margin:0 0 26px">
  <span class="co-icon" aria-hidden="true">⏳</span>
  <div class="co-body"><div class="co-title">本章包含快速变化的内容</div>
  模型能力、框架与价格可能在数月内变化。本章的信息基准时间为 <b>${esc(meta.updated)}</b>，
  阅读时请留意时效，关键结论建议以官方文档为准。</div>
</div>`;
}

function renderToc(toc) {
  if (!toc.length) {
    $('#tocInner').innerHTML = '<p class="toc-title">本篇目录</p><p class="muted" style="font-size:12.5px">本章暂无小节目录</p>';
    return;
  }
  // 目录链接写成完整路由（#/chapter/cXX#anchor），这样中键 / 复制链接 / 新标签页
  // 打开的地址都是正确的；普通点击则由全局锚点处理器就地滚动，不触发重渲染。
  $('#tocInner').innerHTML = `<p class="toc-title">本篇目录</p>` +
    toc.map((t) => `<a class="lv${t.level}" href="#/chapter/${currentChapterId}#${encodeURIComponent(t.id)}" data-anchor="${esc(t.id)}">${esc(t.text)}</a>`).join('');
}

/**
 * 滚动到指定锚点
 * @param {string} id 元素 id
 * @param {boolean} updateHash 是否把地址栏更新为 #/chapter/xxx#锚点
 * @param {boolean} smooth 是否平滑滚动（深链接首次定位应为 false）
 */
function scrollToAnchor(id, updateHash = true, smooth = true) {
  const node = document.getElementById(id);
  if (!node) return;
  const top = node.getBoundingClientRect().top + window.scrollY - 78;
  window.scrollTo({ top, behavior: smooth ? 'smooth' : 'auto' });
  if (updateHash && currentChapterId) {
    history.replaceState(null, '', `#/chapter/${currentChapterId}#${encodeURIComponent(id)}`);
  }
}

function flashAnchor(id) {
  const node = document.getElementById(id);
  if (!node) return;
  node.classList.add('is-flash');
  setTimeout(() => node.classList.remove('is-flash'), 1600);
}

/* ============================================================
   阅读进度 / 目录高亮
   ============================================================ */
const updateReadingProgress = throttle(() => {
  const bar = $('#readingProgress span');
  const article = $('.article');
  if (!article) { if (bar) bar.style.width = '0%'; return; }

  const scrollTop = window.scrollY;
  const viewH = window.innerHeight;
  const artTop = article.offsetTop;
  const artH = article.offsetHeight;
  const readable = Math.max(1, artH - viewH * 0.6);
  const pct = Math.max(0, Math.min(100, Math.round(((scrollTop - artTop + viewH * 0.4) / readable) * 100)));
  if (bar) bar.style.width = `${pct}%`;

  if (currentChapterId) {
    store.saveScroll(currentChapterId, scrollTop);
    const prevState = store.getProgress(currentChapterId).state;
    store.markReading(currentChapterId, pct);
    if (prevState === 'none') refreshNav();
    if (pct >= 93 && prevState !== 'done') {
      store.markDone(currentChapterId, true);
      refreshNav();
      refreshBadges();
      const btn = $('.af-done [data-mark-done]');
      if (btn) { btn.classList.remove('btn-primary'); btn.textContent = '↺ 取消「已完成」'; }
      const headBtn = $('.article-actions [data-mark-done]');
      if (headBtn) headBtn.textContent = '↺ 取消完成';
      toast('已自动标记本章为「已完成」');
    }
    // 左侧进度更新
    renderSidebarProgress();
  }

  // 目录高亮
  if (currentToc.length) {
    let active = '';
    for (const t of currentToc) {
      const node = document.getElementById(t.id);
      if (!node) continue;
      if (node.getBoundingClientRect().top < 110) active = t.id;
      else break;
    }
    $$('#tocInner a').forEach((a) => a.classList.toggle('is-active', a.dataset.anchor === active));
  }
}, 120);

/* ============================================================
   徽标 / 按钮状态
   ============================================================ */
function refreshBadges() {
  const st = store.getState();
  const n = st.notes.length + st.bookmarks.length;
  const badge = $('#notesBadge');
  badge.hidden = n === 0;
  badge.textContent = n > 99 ? '99+' : String(n);
}

function refreshBookmarkBtn() {
  const btn = $('.article-actions [data-bookmark]');
  if (!btn || !currentChapterId) return;
  const marked = store.isBookmarked(currentChapterId, '');
  btn.classList.toggle('is-on', marked);
  btn.textContent = marked ? '★ 已收藏' : '☆ 收藏本章';
}

/* ============================================================
   阅读设置（字号 / 行距 / 版心 / 字体）
   ============================================================ */
const READER_OPTS = {
  scale: {
    label: '正文字号',
    values: [['sm', '小', 15], ['md', '中', 16.2], ['lg', '大', 17.6], ['xl', '特大', 19]],
    fallback: 1
  },
  leading: {
    label: '行距',
    values: [['tight', '紧凑', 1.7], ['normal', '标准', 1.86], ['loose', '宽松', 2.05]],
    fallback: 1
  },
  width: {
    label: '版心宽度',
    values: [['narrow', '窄', 680], ['normal', '标准', 780], ['wide', '宽', 920]],
    fallback: 1
  },
  font: {
    label: '正文字体',
    values: [['sans', '无衬线', 'sans'], ['serif', '衬线', 'serif']],
    fallback: 0
  }
};

const READER_VARS = { scale: '--reader-fs', leading: '--reader-lh', width: '--reader-max' };

function applyReader() {
  const pref = store.getState().reader || {};
  const root = document.documentElement;
  for (const key of ['scale', 'leading', 'width']) {
    const cfg = READER_OPTS[key];
    const hit = cfg.values.find((v) => v[0] === pref[key]) || cfg.values[cfg.fallback];
    const unit = key === 'leading' ? '' : 'px';
    root.style.setProperty(READER_VARS[key], `${hit[2]}${unit}`);
  }
  const font = READER_OPTS.font.values.find((v) => v[0] === pref.font) || READER_OPTS.font.values[0];
  root.dataset.readerFont = font[2];
}

function renderReaderPanel() {
  const pref = store.getState().reader || {};
  $('#readerBody').innerHTML = Object.entries(READER_OPTS).map(([key, cfg]) => `
    <div class="rp-row">
      <span class="rp-label">${esc(cfg.label)}</span>
      <div class="rp-opts">
        ${cfg.values.map(([value, label]) =>
    `<button type="button" data-rk="${key}" data-rv="${value}" class="${pref[key] === value ? 'is-on' : ''}">${esc(label)}</button>`).join('')}
      </div>
    </div>`).join('');
}

function openReader() {
  renderReaderPanel();
  $('#readerPanel').hidden = false;
  $('#readerScrim').hidden = false;
  $('#readerBtn').setAttribute('aria-expanded', 'true');
}

function closeReader() {
  $('#readerPanel').hidden = true;
  $('#readerScrim').hidden = true;
  $('#readerBtn').setAttribute('aria-expanded', 'false');
}

/* ============================================================
   更新日志
   ============================================================ */
const CHANGELOG = window.CHANGELOG || null;
const LEVEL_LABEL = { major: '主版本', minor: '功能更新', patch: '修复' };

/** 更新日志文本支持 `反引号` 行内代码 */
function fmtClText(text) {
  return esc(String(text)).replace(/`([^`]+)`/g, '<code>$1</code>');
}

function hasUnseenVersion() {
  return !!CHANGELOG && store.getLastSeenVersion() !== CHANGELOG.current;
}

function updateVersionUI() {
  if (!CHANGELOG) {
    $('#changelogToggle').hidden = true;
    $('#sidebarChangelog').hidden = true;
    return;
  }
  const unseen = hasUnseenVersion();
  const label = `v${CHANGELOG.current}`;
  $('#versionText').textContent = label;
  $('#sidebarVersion').textContent = label;
  $('#versionDot').hidden = !unseen;
  $('#sidebarVersionDot').hidden = !unseen;
  $('#changelogToggle').title = unseen
    ? `有新版本 ${label}，点击查看更新日志`
    : '查看更新日志';
}

function renderChangelog() {
  const entries = CHANGELOG.entries || [];
  const types = CHANGELOG.types || {};
  $('#clCurrent').textContent = `v${CHANGELOG.current}`;
  $('#clSub').textContent = `共 ${entries.length} 个版本 · 最近更新 ${entries[0] ? entries[0].date : '—'}`;

  $('#changelogBody').innerHTML = `<div class="cl-list">${entries.map((entry, i) => `
    <div class="cl-item ${i === 0 ? 'is-latest' : ''}">
      <div class="cl-row">
        <span class="cl-ver">v${esc(entry.version)}</span>
        <span class="cl-level ${esc(entry.level || 'patch')}">${esc(LEVEL_LABEL[entry.level] || '更新')}</span>
        ${i === 0 ? '<span class="cl-latest">当前版本</span>' : ''}
        <span class="cl-date">${esc(entry.date)}</span>
      </div>
      <div class="cl-item-title">${fmtClText(entry.title)}</div>
      <ul class="cl-items">
        ${(entry.items || []).map((it) => {
          const meta = types[it.type] || { label: it.type, cls: 't-chore' };
          return `<li><span class="cl-tag ${esc(meta.cls)}">${esc(meta.label)}</span><span>${fmtClText(it.text)}</span></li>`;
        }).join('')}
      </ul>
    </div>`).join('')}</div>`;
}

function openChangelog() {
  if (!CHANGELOG) return;
  renderChangelog();
  $('#changelogOverlay').hidden = false;
  document.body.classList.add('no-scroll');
  $('#changelogBody').scrollTop = 0;
  store.setLastSeenVersion(CHANGELOG.current);
  updateVersionUI();
}

function closeChangelog() {
  $('#changelogOverlay').hidden = true;
  document.body.classList.remove('no-scroll');
}

/* ============================================================
   路由分发
   ============================================================ */
function route() {
  const r = parseRoute();
  if (r.name === 'chapter') renderChapter(r.id, r.anchor);
  else renderHome();
}

/* ============================================================
   全局事件
   ============================================================ */
function bindGlobalEvents(annotate, search) {
  // 路径切换
  $('#pathSwitch').addEventListener('click', (e) => {
    const b = e.target.closest('[data-path]');
    if (!b) return;
    store.setPath(b.dataset.path);
    renderPathSwitch();
    refreshNav();
    if (!currentChapterId) renderHome();
  });

  // 模块折叠 / 章节跳转由链接原生处理
  $('#chapterNav').addEventListener('click', (e) => {
    const t = e.target.closest('[data-toggle]');
    if (t) { store.toggleCollapsed(t.dataset.toggle); renderChapterNav(); return; }
    if (e.target.closest('.nav-item')) {
      document.body.classList.remove('nav-open');
      $('#menuToggle').setAttribute('aria-expanded', 'false');
    }
  });

  // 移动端抽屉
  $('#menuToggle').addEventListener('click', () => {
    const open = document.body.classList.toggle('nav-open');
    $('#menuToggle').setAttribute('aria-expanded', String(open));
  });
  $('#sidebarScrim').addEventListener('click', () => {
    document.body.classList.remove('nav-open');
    $('#menuToggle').setAttribute('aria-expanded', 'false');
  });

  // 主题
  $('#themeToggle').addEventListener('click', () => {
    const t = store.cycleTheme();
    toast(t === 'auto' ? '主题：跟随系统' : t === 'dark' ? '主题：深色' : '主题：浅色');
  });
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (store.getState().theme === 'auto') store.applyTheme();
  });

  // 更新日志入口（顶栏版本号 / 侧边栏底部）
  $('#changelogToggle').addEventListener('click', openChangelog);
  $('#sidebarChangelog').addEventListener('click', () => {
    document.body.classList.remove('nav-open');
    $('#menuToggle').setAttribute('aria-expanded', 'false');
    openChangelog();
  });
  $('#changelogOverlay').addEventListener('click', (e) => {
    if (e.target.closest('[data-close]')) closeChangelog();
  });

  // 阅读设置
  $('#readerBtn').addEventListener('click', () => openReader());
  $('#readerScrim').addEventListener('click', closeReader);
  $('[data-reader-close]').addEventListener('click', closeReader);
  $('[data-reader-reset]').addEventListener('click', () => {
    store.resetReader();
    applyReader();
    renderReaderPanel();
    toast('已恢复默认阅读设置');
  });
  $('#readerBody').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-rk]');
    if (!btn) return;
    store.setReaderOption(btn.dataset.rk, btn.dataset.rv);   // 立即生效并持久化
    applyReader();
    renderReaderPanel();
  });

  // 内容区：锚点、收藏、完成、代码复制
  $('#viewRoot').addEventListener('click', async (e) => {
    const copyBtn = e.target.closest('[data-copy]');
    if (copyBtn) {
      const block = copyBtn.closest('.code-block');
      const code = block?.querySelector('code')?.innerText ?? '';
      const ok = await copyText(code);
      copyBtn.textContent = ok ? '已复制' : '复制失败';
      copyBtn.classList.toggle('is-done', ok);
      setTimeout(() => { copyBtn.textContent = '复制'; copyBtn.classList.remove('is-done'); }, 1600);
      return;
    }

    if (e.target.closest('[data-open-search]')) { search.open(); return; }
    if (e.target.closest('[data-open-notes]')) { annotate.openDrawer('notes'); return; }

    const setPath = e.target.closest('[data-set-path]');
    if (setPath) {
      store.setPath(setPath.dataset.setPath);
      renderPathSwitch();
      refreshNav();
      renderHome();
      toast('已切换阅读路径');
      return;
    }

    if (e.target.closest('[data-bookmark]')) {
      const on = store.toggleBookmark({ chapterId: currentChapterId, anchor: '', quote: '' });
      refreshBookmarkBtn();
      refreshBadges();
      annotate.renderDrawer();
      toast(on ? '已加入书签' : '已取消书签');
      return;
    }

    if (e.target.closest('[data-copy-link]')) {
      const url = `${location.origin}${location.pathname}#/chapter/${currentChapterId}`;
      const ok = await copyText(url);
      toast(ok ? '章节链接已复制' : '复制失败');
      return;
    }

    const mark = e.target.closest('[data-mark-done]');
    if (mark) {
      const next = store.toggleDone(currentChapterId);
      refreshNav();
      refreshBadges();
      annotate.renderDrawer();
      $$('[data-mark-done]').forEach((b) => {
        if (b.closest('.af-done')) {
          b.textContent = next.state === 'done' ? '↺ 取消「已完成」' : '✓ 我已完成本章';
          b.classList.toggle('btn-primary', next.state !== 'done');
        } else {
          b.textContent = next.state === 'done' ? '↺ 取消完成' : '✓ 标记完成';
        }
      });
      toast(next.state === 'done' ? '已标记为完成' : '已取消完成标记');
    }
  });

  /* ---------- 页内锚点：统一在 document 层拦截 ----------
     覆盖三处来源：右侧「本篇目录」、正文标题的 # 锚点、Markdown 里的 [文字](#锚点)。
     右侧目录在 #viewRoot 之外，所以必须挂在 document 上才能拦到。 */
  document.addEventListener('click', (e) => {
    if (!(e.target instanceof Element)) return;
    const link = e.target.closest('a[href^="#"]');
    if (!link) return;
    const href = link.getAttribute('href');
    if (!href || href === '#/') return;              // 首页链接交给路由

    // 情况一：完整路由 + 锚点（#/chapter/c06#锚点）
    const m = href.match(/^#\/chapter\/([^#]+)(?:#(.+))?$/);
    if (m) {
      const cid = m[1];
      const anchor = m[2] ? safeDecode(m[2]) : '';
      if (anchor && cid === currentChapterId) {
        // 指向当前章节：就地滚动即可（支持重复点击同一目录项）
        e.preventDefault();
        scrollToAnchor(anchor);
        flashAnchor(anchor);
      }
      return;                                        // 其它路由交给 hashchange
    }

    // 情况二：纯页内锚点 #锚点
    if (!href.startsWith('#/')) {
      e.preventDefault();
      const id = link.dataset.anchor || safeDecode(href.slice(1));
      if (id) scrollToAnchor(id);
    }
  });

  // 滚动
  window.addEventListener('scroll', updateReadingProgress, { passive: true });
  window.addEventListener('resize', updateReadingProgress);

  // 快捷键
  document.addEventListener('keydown', (e) => {
    const tag = (e.target.tagName || '').toLowerCase();
    const typing = tag === 'input' || tag === 'textarea' || e.target.isContentEditable;
    if (typing) return;
    if (e.key === 'Escape') {
      document.body.classList.remove('nav-open');
      annotate.hideBar();
      closeChangelog();
      closeReader();
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'n' && currentChapterId) {
      const all = CAT.allChapters;
      const i = all.findIndex((c) => c.id === currentChapterId);
      if (all[i + 1]) navigate(all[i + 1].id);
    } else if (e.key === 'p' && currentChapterId) {
      const all = CAT.allChapters;
      const i = all.findIndex((c) => c.id === currentChapterId);
      if (all[i - 1]) navigate(all[i - 1].id);
    }
  });

  $('#notesOverlay').addEventListener('click', (e) => {
    if (e.target.closest('[data-close]')) annotate.closeDrawer();
  });
}

/* ============================================================
   启动
   ============================================================ */
async function boot() {
  /* ---------- 认证必须先于一切渲染 ----------
     未登录时不渲染任何学习内容、不建立搜索索引、不绑定应用事件。
     界面上只是一张登录卡片，DOM 里没有任何章节信息。 */
  try { await auth.initialize(); } catch (error) {
    initLogin().showGate();
    document.querySelector('#loginError').textContent=error.message;
    document.querySelector('#loginError').hidden=false;
    document.querySelector('#loginSubmit').disabled=true;
    return;
  }
  auth.syncIfClean();     // 本机改动若已与仓库一致就丢弃覆盖层，避免长期遮蔽

  const login = initLogin({ onOpenAdmin: openAdmin });
  initAdmin();

  const user = auth.currentUser();
  if (!user) {
    location.replace(`/?next=${encodeURIComponent(location.pathname + location.hash)}`);
    return;
  }

  // 学习数据按账号隔离，必须在读取任何进度之前切好命名空间
  store.setNamespace(auth.namespaceOf(user));

  dismissBoot();
  login.refreshUserMenu();

  store.applyTheme();
  applyReader();          // 阅读设置要在首次渲染前生效，避免闪一下默认字号
  renderPathSwitch();

  const annotate = initAnnotate({
    currentChapterId: () => currentChapterId,
    navigate,
    refreshSidebar: refreshNav,
    refreshBadges,
    refreshBookmarkBtn
  });

  const search = initSearch({ navigate, flashSection: flashAnchor });

  bindGlobalEvents(annotate, search);
  refreshBadges();
  updateVersionUI();
  route();

  window.addEventListener('hashchange', () => {
    const r = parseRoute();
    // 纯页内锚点不改变视图：交给浏览器原生定位，不要重渲染
    if (r.name === 'anchor') return;
    if (r.anchor && currentChapterId === r.id) {
      scrollToAnchor(r.anchor);
      flashAnchor(r.anchor);
      return;
    }
    route();
  });

  // 预构建搜索索引（空闲时）
  const warm = () => buildIndex().catch(() => {});
  if ('requestIdleCallback' in window) requestIdleCallback(warm, { timeout: 4000 });
  else setTimeout(warm, 2500);

  console.log(`%c Agent 学习平台 v${CAT.version} `, 'background:#5b5bd6;color:#fff;border-radius:3px;padding:2px 6px', `共 ${CAT.allChapters.length} 章`);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
