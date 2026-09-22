/* ============================================================
   全局搜索：全文索引 + 命令面板
   ============================================================ */

import { $, $$, esc, slugify } from './ui.js';
import { toPlainText } from './markdown.js';
import { loadChapter } from './content.js';

const CAT = () => window.CATALOG;

let INDEX = null;
let building = null;

/* ---------------- 索引构建 ---------------- */
function splitSections(md) {
  const lines = md.split('\n');
  const secs = [];
  let cur = { anchor: '', title: '', buf: [] };
  let inFence = false;
  for (const line of lines) {
    if (/^```/.test(line)) inFence = !inFence;
    const m = !inFence && line.match(/^(#{2,4})\s+(.+?)\s*#*\s*$/);
    if (m) {
      secs.push(cur);
      cur = { anchor: slugify(m[2].replace(/[*`_]/g, '')), title: m[2], buf: [] };
    } else {
      cur.buf.push(line);
    }
  }
  secs.push(cur);
  return secs.filter((s) => s.title || s.buf.join('').trim());
}

export async function buildIndex(onProgress) {
  if (INDEX) return INDEX;
  if (building) return building;
  building = (async () => {
    const chapters = CAT().allChapters;
    const docs = [];
    let n = 0;
    for (const c of chapters) {
      try {
        const md = await loadChapter(c.id);
        const sections = splitSections(md);
        const secs = sections.map((s) => {
          const text = toPlainText(s.buf.join('\n'));
          return {
            anchor: s.anchor,
            title: (s.title || c.title).replace(/[*`_]/g, ''),
            text
          };
        }).filter((s) => s.text.length > 8);
        docs.push({ id: c.id, title: c.title, moduleId: c.moduleId, moduleName: c.moduleName, tag: c.tag, summary: c.summary, secs });
      } catch (err) {
        console.warn('[search] 索引章节失败', c.id, err);
      }
      n++;
      if (onProgress) onProgress(n, chapters.length);
    }
    INDEX = docs;
    return INDEX;
  })();
  return building;
}

/* ---------------- 查询 ---------------- */
const CJK = /[\u4e00-\u9fa5]/;

function tokenize(q) {
  const raw = q.trim().toLowerCase();
  if (!raw) return [];
  const terms = new Map(); // term -> weight
  raw.split(/[\s,，。、；;：:/|]+/).filter(Boolean).forEach((t) => {
    if (t.length <= 1) return;
    terms.set(t, 1);
    if (CJK.test(t)) {
      for (let i = 0; i < t.length - 1; i++) {
        const bg = t.slice(i, i + 2);
        if (!terms.has(bg)) terms.set(bg, 0.35);
      }
    }
  });
  return Array.from(terms.entries()).map(([term, weight]) => ({ term, weight }));
}

function escapedReg(term) {
  return term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function highlightSnippet(text, terms) {
  let out = esc(text);
  const sorted = [...terms].sort((a, b) => b.length - a.length);
  for (const t of sorted) {
    out = out.replace(new RegExp(escapedReg(esc(t)), 'gi'), (m) => `\u0000${m}\u0001`);
  }
  out = out.replace(/\u0000/g, '<mark class="hl">').replace(/\u0001/g, '</mark>');
  return out;
}

export function searchDocs(query, docs, filter) {
  const terms = tokenize(query);
  const termList = terms.map((t) => t.term);
  if (!terms.length) return { items: [], terms: termList };
  const phrase = query.trim().toLowerCase();
  const pool = (!filter || filter === 'all') ? docs : docs.filter((d) => d.moduleId === filter);
  const perChapter = new Map();

  for (const d of pool) {
    const titleLower = d.title.toLowerCase();
    for (const sec of d.secs) {
      const lower = sec.text.toLowerCase();
      const secTitleLower = (sec.title || '').toLowerCase();
      let score = 0;
      let firstPos = -1;
      for (const { term, weight } of terms) {
        let count = 0, from = 0;
        for (;;) {
          const i = lower.indexOf(term, from);
          if (i < 0) break;
          if (firstPos < 0 || i < firstPos) firstPos = i;
          count++;
          from = i + term.length;
          if (count > 12) break;
        }
        if (count) score += Math.min(count, 6) * weight;
        if (titleLower.includes(term) || secTitleLower.includes(term)) score += 3.4 * weight;
      }
      if (phrase.length > 2 && lower.includes(phrase)) score += 4;
      if (score <= 0) continue;
      const list = perChapter.get(d.id) || [];
      list.push({ doc: d, sec, score, firstPos: firstPos < 0 ? 0 : firstPos });
      perChapter.set(d.id, list);
    }
  }

  // 每章只保留得分最高的 2 个片段，避免单章刷屏
  const merged = [];
  for (const [, list] of perChapter) {
    list.sort((a, b) => b.score - a.score);
    list.slice(0, 2).forEach((r, i) => merged.push({ ...r, score: r.score * (i === 0 ? 1 : 0.55) }));
  }
  merged.sort((a, b) => b.score - a.score);
  return { items: merged.slice(0, 40), terms: termList };
}

/* ---------------- 面板 ---------------- */
export function initSearch(ctx) {
  const overlay = $('#searchOverlay');
  const input = $('#searchInput');
  const resultsEl = $('#searchResults');
  const filtersEl = $('#searchFilters');
  let filter = 'all';
  let cursor = 0;
  let items = [];
  let currentTerms = [];
  let opened = false;

  filtersEl.innerHTML = [{ id: 'all', name: '全部' }, ...CAT().modules.map((m) => ({ id: m.id, name: m.name.replace(/^第.*?·\s*/, '') }))]
    .map((f) => `<button class="chip ${f.id === 'all' ? 'is-on' : ''}" data-f="${f.id}" type="button">${esc(f.name)}</button>`).join('');

  function renderEmpty(msg, sub = '') {
    resultsEl.innerHTML = `<div class="empty"><div class="em-ico">🔍</div><p>${esc(msg)}</p>${sub ? `<small>${esc(sub)}</small>` : ''}</div>`;
  }

  async function ensureIndex() {
    if (INDEX) return;
    renderEmpty('正在建立全文索引…', '首次搜索需要读取全部章节内容，请稍候');
    await buildIndex((n, total) => {
      resultsEl.innerHTML = `<div class="empty"><div class="em-ico">⏳</div><p>正在建立全文索引 ${n}/${total}</p></div>`;
    });
  }

  function groupBy(items) {
    const groups = new Map();
    items.forEach((it) => {
      const key = it.doc.moduleName;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(it);
    });
    return groups;
  }

  function render() {
    if (!items.length) {
      const q = input.value.trim();
      if (!q) {
        renderEmpty('输入关键词开始搜索', '支持中文分词、代码标识符与章节标题；快捷键 Ctrl/⌘ + K');
      } else {
        renderEmpty(`没有找到与「${q}」匹配的内容`, '试试更换关键词，或切换到「全部」范围');
      }
      return;
    }
    let flatIdx = -1;
    const groups = groupBy(items);
    let html = '';
    for (const [mod, list] of groups) {
      html += `<div class="sr-group"><div class="sr-group-title">${esc(mod)}</div>`;
      for (const it of list) {
        flatIdx++;
        const text = it.sec.text || '';
        const start = Math.max(0, it.firstPos - 55);
        const snippetRaw = (start > 0 ? '…' : '') + text.slice(start, start + 130) + (start + 130 < text.length ? '…' : '');
        html += `<div class="sr-item ${flatIdx === cursor ? 'is-cursor' : ''}" data-i="${flatIdx}">
          <span class="sr-ico">${esc(it.doc.moduleName.replace(/^第(.)部分.*/, '第$1部').slice(0, 2))}</span>
          <span class="sr-main">
            <span class="sr-h">${esc(it.doc.title)}${it.sec.title && it.sec.title !== it.doc.title ? ` <span class="muted" style="font-weight:500;font-size:12px">› ${esc(it.sec.title)}</span>` : ''}</span>
            <span class="sr-snip">${highlightSnippet(snippetRaw, currentTerms)}</span>
            <span class="sr-path">${esc(it.doc.moduleName)}${it.sec.anchor ? ` · #${esc(it.sec.anchor)}` : ''}</span>
          </span>
        </div>`;
      }
      html += '</div>';
    }
    resultsEl.innerHTML = html;
    const node = resultsEl.querySelector('.sr-item.is-cursor');
    if (node) node.scrollIntoView({ block: 'nearest' });
  }

  async function run() {
    await ensureIndex();
    const query = input.value;
    if (!query.trim()) { items = []; cursor = 0; render(); return; }
    const res = searchDocs(query, INDEX, filter);
    items = res.items;
    currentTerms = res.terms;
    cursor = 0;
    render();
  }

  function open() {
    overlay.hidden = false;
    document.body.classList.add('no-scroll');
    opened = true;
    input.value = '';
    items = [];
    cursor = 0;
    render();
    setTimeout(() => input.focus(), 30);
    run();
  }

  function close() {
    overlay.hidden = true;
    opened = false;
    document.body.classList.remove('no-scroll');
  }

  let timer = null;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(run, 140);
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); cursor = Math.min(items.length - 1, cursor + 1); render(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); cursor = Math.max(0, cursor - 1); render(); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const it = items[cursor];
      if (it) { close(); ctx.navigate(it.doc.id, it.sec.anchor); }
    } else if (e.key === 'Escape') { close(); }
  });

  filtersEl.addEventListener('click', (e) => {
    const b = e.target.closest('[data-f]');
    if (!b) return;
    filter = b.dataset.f;
    $$('.chip', filtersEl).forEach((c) => c.classList.toggle('is-on', c.dataset.f === filter));
    run();
  });

  resultsEl.addEventListener('click', (e) => {
    const it = e.target.closest('.sr-item');
    if (!it) return;
    const data = items[+it.dataset.i];
    if (!data) return;
    close();
    ctx.navigate(data.doc.id, data.sec.anchor);
  });

  overlay.addEventListener('click', (e) => {
    if (e.target.closest('[data-close]')) close();
  });

  $('#searchTrigger').addEventListener('click', () => open());

  document.addEventListener('keydown', (e) => {
    const isK = (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k';
    if (isK) { e.preventDefault(); opened ? close() : open(); return; }
    if (e.key === 'Escape' && opened) close();
    // 「/」快速搜索（不在输入框内时）
    if (e.key === '/' && !opened) {
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      e.preventDefault();
      open();
    }
  });

  return { open, close, isOpen: () => opened };
}
