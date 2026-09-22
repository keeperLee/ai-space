/* ============================================================
   标注系统：文本高亮 / 笔记 / 书签
   跨刷新恢复策略：引文 + 上下文前缀后缀 + 出现序号（对 DOM 变更更鲁棒）
   ============================================================ */

import * as store from './store.js';
import { $, $$, el, esc, toast, uid, timeAgo, copyText } from './ui.js';

const CAT = () => window.CATALOG;

/* ---------------- 文本映射 ---------------- */
function buildMap(container) {
  const nodes = [];
  let full = '';
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = walker.nextNode())) {
    nodes.push({ node: n, start: full.length, end: full.length + n.data.length });
    full += n.data;
  }
  return { nodes, full };
}

function rangeFromOffsets(nodes, start, end) {
  let sNode = null, sOff = 0, eNode = null, eOff = 0;
  for (const it of nodes) {
    if (!sNode && start >= it.start && start <= it.end) { sNode = it.node; sOff = start - it.start; }
    if (end >= it.start && end <= it.end) { eNode = it.node; eOff = end - it.start; break; }
  }
  if (!sNode || !eNode) return null;
  try {
    const r = document.createRange();
    r.setStart(sNode, sOff);
    r.setEnd(eNode, eOff);
    return r;
  } catch (_) {
    return null;
  }
}

function wrapRange(range, container, id, cls) {
  const { nodes } = buildMap(container);
  const targets = [];
  for (const it of nodes) {
    if (!range.intersectsNode(it.node)) continue;
    const pe = it.node.parentElement;
    if (!pe) continue;
    if (pe.closest('.demo') || pe.closest('button') || pe.closest('.code-head') || pe.closest('mark')) continue;
    let start = 0, end = it.node.data.length;
    if (it.node === range.startContainer) start = range.startOffset;
    if (it.node === range.endContainer) end = range.endOffset;
    if (start >= end) continue;
    targets.push({ node: it.node, start, end });
  }
  targets.forEach((t) => {
    const r = document.createRange();
    r.setStart(t.node, t.start);
    r.setEnd(t.node, t.end);
    const mark = document.createElement('mark');
    mark.className = cls;
    mark.dataset.hl = id;
    try { r.surroundContents(mark); } catch (_) { /* 结构性边界，忽略 */ }
  });
  return targets.length;
}

function anchorOf(container, node) {
  const heads = Array.from(container.querySelectorAll('h2, h3, h4'));
  let anchor = '';
  for (const h of heads) {
    if (h.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING) anchor = h.id;
    else break;
  }
  return anchor;
}

/* ---------------- 捕获选区 ---------------- */
export function captureSelection(container) {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
  const range = sel.getRangeAt(0);
  if (!container.contains(range.commonAncestorContainer)) return null;
  const quote = sel.toString();
  if (!quote || quote.replace(/\s+/g, '').length < 2) return null;

  const pre = document.createRange();
  pre.selectNodeContents(container);
  try { pre.setEnd(range.startContainer, range.startOffset); } catch (_) { return null; }
  const before = pre.toString();

  const post = document.createRange();
  post.selectNodeContents(container);
  try { post.setStart(range.endContainer, range.endOffset); } catch (_) { return null; }
  const after = post.toString();

  let index = 0;
  let pos = before.indexOf(quote);
  while (pos >= 0) { index++; pos = before.indexOf(quote, pos + 1); }

  return {
    quote,
    prefix: before.slice(-28),
    suffix: after.slice(0, 28),
    index,
    anchor: anchorOf(container, range.startContainer)
  };
}

/* ---------------- 恢复高亮 ---------------- */
export function applyHighlights(chapterId, container) {
  const list = store.highlightsOf(chapterId);
  list.forEach((h) => {
    const { nodes, full } = buildMap(container);
    const q = h.quote;
    if (!q) return;
    let pos = -1;
    if (h.prefix) {
      const target = h.prefix + q + (h.suffix || '');
      const i = full.indexOf(target);
      if (i >= 0) pos = i + h.prefix.length;
    }
    if (pos < 0) {
      let from = 0, count = 0;
      for (;;) {
        const i = full.indexOf(q, from);
        if (i < 0) break;
        if (count === (h.index || 0)) { pos = i; break; }
        count++;
        from = i + 1;
      }
    }
    if (pos < 0) return;
    const range = rangeFromOffsets(nodes, pos, pos + q.length);
    if (range) wrapRange(range, container, h.id, 'user-hl');
  });
}

/* ============================================================
   初始化
   ============================================================ */
export function initAnnotate(ctx) {
  const bar = $('#selectionBar');
  const notesOverlay = $('#notesOverlay');
  const drawerBody = $('#drawerBody');
  let pending = null;   // 当前选区数据
  let activeTab = 'notes';

  const getArticle = () => $('#articleBody');

  /* ---------- 浮动工具条 ---------- */
  function hideBar() { bar.hidden = true; pending = null; }

  function showBar(rect) {
    bar.hidden = false;
    const w = bar.offsetWidth;
    let left = rect.left + rect.width / 2 - w / 2;
    left = Math.max(8, Math.min(window.innerWidth - w - 8, left));
    let top = rect.top - bar.offsetHeight - 8;
    if (top < 64) top = rect.bottom + 8;
    bar.style.left = `${left}px`;
    bar.style.top = `${top}px`;
  }

  document.addEventListener('mouseup', (e) => {
    if (bar.contains(e.target)) return;
    setTimeout(() => {
      const article = getArticle();
      if (!article) return hideBar();
      const data = captureSelection(article);
      if (!data) { hideBar(); return; }
      pending = data;
      const sel = window.getSelection();
      if (!sel.rangeCount) return hideBar();
      showBar(sel.getRangeAt(0).getBoundingClientRect());
    }, 10);
  });

  document.addEventListener('mousedown', (e) => {
    if (bar.hidden) return;
    if (!bar.contains(e.target)) hideBar();
  });

  window.addEventListener('scroll', () => { if (!bar.hidden) hideBar(); }, { passive: true });

  bar.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn || !pending) return;
    const act = btn.dataset.act;

    if (act === 'copy') {
      const ok = await copyText(pending.quote);
      toast(ok ? '已复制选中内容' : '复制失败');
      hideBar();
      return;
    }

    if (act === 'highlight') {
      const chapterId = ctx.currentChapterId();
      const hl = store.addHighlight({ chapterId, ...pending });
      const sel = window.getSelection();
      if (sel.rangeCount) wrapRange(sel.getRangeAt(0), getArticle(), hl.id, 'user-hl');
      toast('已标记重点，可在「笔记与书签」中查看');
      hideBar();
      return;
    }

    if (act === 'note') {
      const chapterId = ctx.currentChapterId();
      const hl = store.addHighlight({ chapterId, ...pending });
      const sel = window.getSelection();
      if (sel.rangeCount) wrapRange(sel.getRangeAt(0), getArticle(), hl.id, 'user-hl');
      openDrawer('notes');
      const body = window.prompt('为这段内容写一条笔记：', '');
      if (body && body.trim()) {
        store.addNote({ chapterId, anchor: pending.anchor, quote: pending.quote, body: body.trim() });
        toast('笔记已保存');
      } else {
        toast('已标记重点（未填写笔记内容）');
      }
      hideBar();
      renderDrawer();
    }
  });

  /* ---------- 点击已有高亮 ---------- */
  document.addEventListener('click', (e) => {
    const mark = e.target.closest('mark.user-hl');
    if (!mark) return;
    const id = mark.dataset.hl;
    bar.hidden = false;
    bar.innerHTML = `<button class="sel-btn" data-act="goto-note">查看笔记</button><button class="sel-btn sel-hl" data-act="remove-hl">取消标记</button>`;
    const r = mark.getBoundingClientRect();
    let left = Math.max(8, Math.min(window.innerWidth - bar.offsetWidth - 8, r.left + r.width / 2 - bar.offsetWidth / 2));
    bar.style.left = `${left}px`;
    bar.style.top = `${r.top - bar.offsetHeight - 8 < 64 ? r.bottom + 8 : r.top - bar.offsetHeight - 8}px`;

    const handler = (ev) => {
      const act = ev.target.closest('[data-act]')?.dataset.act;
      if (!act) return;
      if (act === 'remove-hl') {
        store.removeHighlight(id);
        mark.replaceWith(document.createTextNode(mark.textContent));
        renderDrawer();
        toast('已取消标记');
      } else {
        openDrawer('notes');
        const note = store.getState().notes.find((n) => n.quote === mark.textContent);
        if (note) setTimeout(() => flashNote(note.id), 60);
      }
      hideBar();
      bar.innerHTML = `<button data-act="highlight" class="sel-btn sel-hl">标记重点</button><button data-act="note" class="sel-btn">写笔记</button><button data-act="copy" class="sel-btn">复制</button>`;
      bar.removeEventListener('click', handler);
    };
    bar.addEventListener('click', handler);
  });

  /* ---------- 抽屉 ---------- */
  function openDrawer(tab = 'notes') {
    activeTab = tab;
    notesOverlay.hidden = false;
    document.body.classList.add('no-scroll');
    renderDrawer();
  }
  function closeDrawer() {
    notesOverlay.hidden = true;
    document.body.classList.remove('no-scroll');
    bar.innerHTML = `<button data-act="highlight" class="sel-btn sel-hl">标记重点</button><button data-act="note" class="sel-btn">写笔记</button><button data-act="copy" class="sel-btn">复制</button>`;
  }

  $('#notesToggle').addEventListener('click', () => openDrawer('notes'));
  notesOverlay.addEventListener('click', (e) => {
    if (e.target.closest('[data-close]')) closeDrawer();
  });
  $('#notesTabs').addEventListener('click', (e) => {
    const t = e.target.closest('[data-tab]');
    if (!t) return;
    activeTab = t.dataset.tab;
    renderDrawer();
  });

  function chapterTitle(id) {
    return CAT()?.byId?.[id]?.title || id;
  }
  function moduleName(id) {
    return CAT()?.byId?.[id]?.moduleName || '';
  }

  function renderDrawer() {
    const st = store.getState();
    $$('#notesTabs .drawer-tab').forEach((b) => b.classList.toggle('is-active', b.dataset.tab === activeTab));
    $('#tabCountNotes').textContent = st.notes.length;
    $('#tabCountMarks').textContent = st.bookmarks.length;

    if (activeTab === 'notes') {
      if (!st.notes.length) {
        drawerBody.innerHTML = `<div class="empty"><div class="em-ico">✍️</div><p>还没有笔记</p><small>在正文中选中文字，点击「写笔记」即可记录</small></div>`;
        return;
      }
      drawerBody.innerHTML = st.notes.map((n) => `
        <div class="mp-item" data-note="${n.id}">
          <div class="mp-h">
            <span class="mp-t" data-goto="${n.chapterId}" data-anchor="${esc(n.anchor || '')}">${esc(chapterTitle(n.chapterId))}</span>
            <button class="mp-del" data-del-note="${n.id}" title="删除笔记">×</button>
          </div>
          ${n.quote ? `<div class="mp-quote" data-goto="${n.chapterId}" data-anchor="${esc(n.anchor || '')}">${esc(n.quote.slice(0, 160))}</div>` : ''}
          <div class="mp-note">${esc(n.body)}</div>
          <div class="mp-meta"><span>${esc(moduleName(n.chapterId))}</span><span>${timeAgo(n.at)}</span></div>
        </div>`).join('');
      return;
    }

    if (activeTab === 'bookmarks') {
      if (!st.bookmarks.length) {
        drawerBody.innerHTML = `<div class="empty"><div class="em-ico">🔖</div><p>还没有书签</p><small>点击文章右上角的书签按钮收藏整章，或选中文字后收藏片段</small></div>`;
        return;
      }
      drawerBody.innerHTML = st.bookmarks.map((b) => `
        <div class="mp-item">
          <div class="mp-h">
            <span class="mp-t" data-goto="${b.chapterId}" data-anchor="${esc(b.anchor || '')}">${esc(chapterTitle(b.chapterId))}</span>
            <button class="mp-del" data-del-bm="${b.id}" title="删除书签">×</button>
          </div>
          ${b.quote ? `<div class="mp-quote" data-goto="${b.chapterId}" data-anchor="${esc(b.anchor || '')}">${esc(b.quote.slice(0, 160))}</div>` : '<div class="mp-quote" data-goto="' + b.chapterId + '">整章书签</div>'}
          <div class="mp-meta"><span>${esc(moduleName(b.chapterId))}</span><span>${timeAgo(b.at)}</span></div>
        </div>`).join('');
      return;
    }

    // 进度
    const chapters = CAT()?.allChapters || [];
    const done = chapters.filter((c) => store.getProgress(c.id).state === 'done').length;
    const reading = chapters.filter((c) => store.getProgress(c.id).state === 'reading').length;
    const pct = chapters.length ? Math.round((done / chapters.length) * 100) : 0;
    drawerBody.innerHTML = `
      <div class="stat-row" style="grid-template-columns:repeat(3,1fr);margin-bottom:16px">
        <div class="stat"><b style="color:var(--ok)">${done}</b><span>已完成章节</span></div>
        <div class="stat"><b style="color:var(--warn)">${reading}</b><span>在读章节</span></div>
        <div class="stat"><b>${pct}%</b><span>完成度</span></div>
      </div>
      <div class="dm-row">
        <button class="btn btn-sm" data-export>导出学习数据</button>
        <button class="btn btn-sm" data-import>导入</button>
        <button class="btn btn-sm btn-ghost" data-reset>清空进度</button>
      </div>
      ${CAT().modules.map((m) => {
        const list = m.chapters.filter((c) => store.getProgress(c.id).state !== 'none');
        return `
        <div class="prog-module">
          <h4>${esc(m.name)} <span>${list.filter((c) => store.getProgress(c.id).state === 'done').length}/${m.chapters.length}</span></h4>
          <div class="prog-list">
            ${m.chapters.map((c) => {
              const p = store.getProgress(c.id);
              const dot = p.state === 'done' ? 'dot-done' : p.state === 'reading' ? 'dot-reading' : 'dot-none';
              return `<div class="prog-row" data-goto="${c.id}"><i class="dot ${dot}"></i><span class="pr-t">${esc(c.title)}</span>${p.pct ? `<span class="muted" style="font-size:11px">${p.pct}%</span>` : ''}</div>`;
            }).join('')}
          </div>
        </div>`;
      }).join('')}`;
  }

  drawerBody.addEventListener('click', (e) => {
    const goto = e.target.closest('[data-goto]');
    if (goto) {
      closeDrawer();
      ctx.navigate(goto.dataset.goto, goto.dataset.anchor || '');
      return;
    }
    const delNote = e.target.closest('[data-del-note]');
    if (delNote) { store.removeNote(delNote.dataset.delNote); renderDrawer(); ctx.refreshBadges(); return; }
    const delBm = e.target.closest('[data-del-bm]');
    if (delBm) { store.removeBookmark(delBm.dataset.delBm); renderDrawer(); ctx.refreshBadges(); ctx.refreshBookmarkBtn(); return; }
    if (e.target.closest('[data-reset]')) {
      if (window.confirm('确定清空所有学习进度吗？（笔记与书签保留）')) {
        store.resetProgress();
        renderDrawer();
        ctx.refreshSidebar();
        toast('进度已清空');
      }
      return;
    }
    if (e.target.closest('[data-export]')) {
      const blob = new Blob([store.exportData()], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `agent-learning-data-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
      toast('学习数据已导出');
      return;
    }
    if (e.target.closest('[data-import]')) {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'application/json';
      input.onchange = async () => {
        const file = input.files?.[0];
        if (!file) return;
        try {
          store.importData(await file.text());
          renderDrawer();
          ctx.refreshSidebar();
          toast('学习数据已导入');
        } catch (err) {
          toast('导入失败：文件格式不正确');
        }
      };
      input.click();
    }
  });

  function flashNote(id) {
    const node = drawerBody.querySelector(`[data-note="${id}"]`);
    if (!node) return openDrawer('notes');
    node.scrollIntoView({ block: 'center', behavior: 'smooth' });
    node.style.transition = 'box-shadow .3s';
    node.style.boxShadow = '0 0 0 3px var(--accent-ring)';
    setTimeout(() => { node.style.boxShadow = ''; }, 1200);
  }

  return { openDrawer, closeDrawer, renderDrawer, hideBar, getPending: () => pending };
}
