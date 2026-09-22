/* ============================================================
   全局状态：学习进度 / 笔记 / 书签 / 高亮 / 偏好
   持久化到 localStorage

   数据按登录用户隔离：存储键为
     agent-learning-platform:u:<用户名>:v1
   未登录时为 agent-learning-platform:public:v1（正常情况下不会被写入，
   因为应用在登录前不会启动）。

   同时兼容本站早期版本的单一存储键 agent-learning-platform:v1，
   登录后可以一键把那份旧数据迁移到当前账号名下。
   ============================================================ */

const KEY_PREFIX = 'agent-learning-platform';
const LEGACY_KEY = `${KEY_PREFIX}:v1`;

/** 由命名空间拼出存储键 */
function keyOf(ns) { return `${KEY_PREFIX}:${ns}:v1`; }

let namespace = 'public';
let STORAGE_KEY = keyOf(namespace);

const DEFAULTS = {
  theme: 'auto',          // auto | light | dark
  path: 'all',            // 当前阅读路径
  progress: {},           // chapterId -> { state, pct, scroll, at }
  notes: [],              // { id, chapterId, anchor, quote, body, at }
  bookmarks: [],          // { id, chapterId, anchor, quote, at }
  highlights: [],         // { id, chapterId, anchor, quote, prefix, suffix, index, at }
  collapsed: {},          // moduleId -> 是否折叠
  recent: [],             // 最近阅读的 chapterId 列表
  lastChapter: null,
  sidebarOpen: false,
  lastSeenVersion: null,  // 上次查看更新日志时的版本号，用于提示「有新版本」
  reader: {               // 阅读设置
    scale: 'md',          // sm | md | lg | xl        正文字号
    leading: 'normal',    // tight | normal | loose   行距
    width: 'normal',      // narrow | normal | wide   版心宽度
    font: 'sans'          // sans | serif             正文字体
  }
};

let state = loadState();
const listeners = new Set();

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return structuredClone(DEFAULTS);
    const parsed = JSON.parse(raw);
    return {
      ...structuredClone(DEFAULTS),
      ...parsed,
      progress: parsed.progress || {},
      notes: parsed.notes || [],
      bookmarks: parsed.bookmarks || [],
      highlights: parsed.highlights || [],
      collapsed: parsed.collapsed || {},
      recent: parsed.recent || []
    };
  } catch (e) {
    console.warn('[store] 读取本地数据失败，使用默认值', e);
    return structuredClone(DEFAULTS);
  }
}

let saveTimer = null;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) {
      console.warn('[store] 保存失败（可能超出配额）', e);
    }
  }, 120);
}

export function getState() { return state; }

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit() { listeners.forEach((fn) => { try { fn(state); } catch (e) { console.error(e); } }); }

export function setState(patch, { silent = false } = {}) {
  const next = typeof patch === 'function' ? patch(state) : patch;
  state = { ...state, ...next };
  persist();
  if (!silent) emit();
  return state;
}

/* ---------------- 主题 ---------------- */
export function resolvedTheme() {
  if (state.theme === 'auto') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return state.theme;
}

export function applyTheme() {
  const t = resolvedTheme();
  document.documentElement.setAttribute('data-theme', t);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', t === 'dark' ? '#0e0f16' : '#5b5bd6');
  return t;
}

export function cycleTheme() {
  const order = ['auto', 'light', 'dark'];
  const idx = order.indexOf(state.theme);
  const next = order[(idx + 1) % order.length];
  setState({ theme: next });
  applyTheme();
  return next;
}

/* ---------------- 阅读路径 ---------------- */
export function setPath(pathId) { setState({ path: pathId }); }

/* ---------------- 学习进度 ---------------- */
export function getProgress(chapterId) {
  return state.progress[chapterId] || { state: 'none', pct: 0, scroll: 0, at: 0 };
}

export function markReading(chapterId, pct = 0) {
  const cur = getProgress(chapterId);
  if (cur.state === 'done') return cur;
  const next = { ...cur, state: 'reading', pct: Math.max(cur.pct, Math.round(pct)), at: Date.now() };
  setState({ progress: { ...state.progress, [chapterId]: next } }, { silent: true });
  return next;
}

export function saveScroll(chapterId, scroll) {
  const cur = getProgress(chapterId);
  setState({ progress: { ...state.progress, [chapterId]: { ...cur, scroll } } }, { silent: true });
}

export function markDone(chapterId, done = true) {
  const cur = getProgress(chapterId);
  const next = { ...cur, state: done ? 'done' : 'reading', pct: done ? 100 : cur.pct, at: Date.now() };
  setState({ progress: { ...state.progress, [chapterId]: next } });
  return next;
}

export function toggleDone(chapterId) {
  const cur = getProgress(chapterId);
  return markDone(chapterId, cur.state !== 'done');
}

export function pushRecent(chapterId) {
  const recent = [chapterId, ...state.recent.filter((id) => id !== chapterId)].slice(0, 8);
  setState({ recent, lastChapter: chapterId }, { silent: true });
}

export function resetProgress() {
  setState({ progress: {}, recent: [], lastChapter: null });
}

/* ---------------- 笔记 ---------------- */
export function addNote({ chapterId, anchor, quote, body }) {
  const note = { id: `note_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, chapterId, anchor, quote, body, at: Date.now() };
  setState({ notes: [note, ...state.notes] });
  return note;
}

export function updateNote(id, body) {
  setState({ notes: state.notes.map((n) => (n.id === id ? { ...n, body, at: Date.now() } : n)) });
}

export function removeNote(id) {
  setState({ notes: state.notes.filter((n) => n.id !== id) });
}

export function notesOf(chapterId) {
  return state.notes.filter((n) => n.chapterId === chapterId);
}

/* ---------------- 书签 ---------------- */
export function isBookmarked(chapterId, quote = '') {
  return state.bookmarks.some((b) => b.chapterId === chapterId && b.quote === quote);
}

export function toggleBookmark({ chapterId, anchor, quote = '' }) {
  const exist = state.bookmarks.find((b) => b.chapterId === chapterId && b.quote === quote);
  if (exist) {
    setState({ bookmarks: state.bookmarks.filter((b) => b.id !== exist.id) });
    return false;
  }
  const mark = { id: `bm_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, chapterId, anchor, quote, at: Date.now() };
  setState({ bookmarks: [mark, ...state.bookmarks] });
  return true;
}

export function removeBookmark(id) {
  setState({ bookmarks: state.bookmarks.filter((b) => b.id !== id) });
}

/* ---------------- 高亮标注 ---------------- */
export function addHighlight(data) {
  const hl = { id: `hl_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, at: Date.now(), ...data };
  setState({ highlights: [hl, ...state.highlights] });
  return hl;
}

export function removeHighlight(id) {
  setState({ highlights: state.highlights.filter((h) => h.id !== id) });
}

export function highlightsOf(chapterId) {
  return state.highlights.filter((h) => h.chapterId === chapterId);
}

/* ---------------- 模块折叠 ---------------- */
export function toggleCollapsed(moduleId) {
  setState({ collapsed: { ...state.collapsed, [moduleId]: !state.collapsed[moduleId] } });
}

/* ---------------- 阅读设置 ---------------- */
export function setReaderOption(key, value) {
  setState({ reader: { ...state.reader, [key]: value } });
}

export function resetReader() {
  setState({ reader: { ...DEFAULTS.reader } });
}

/* ---------------- 更新日志 ---------------- */
export function getLastSeenVersion() { return state.lastSeenVersion; }

export function setLastSeenVersion(version) {
  if (state.lastSeenVersion === version) return;
  setState({ lastSeenVersion: version });
}

/* ---------------- 导出 / 导入 ---------------- */
export function exportData() {
  return JSON.stringify(
    { progress: state.progress, notes: state.notes, bookmarks: state.bookmarks, highlights: state.highlights, exportedAt: new Date().toISOString() },
    null, 2
  );
}

export function importData(json) {
  const data = JSON.parse(json);
  setState({
    progress: data.progress || state.progress,
    notes: data.notes || state.notes,
    bookmarks: data.bookmarks || state.bookmarks,
    highlights: data.highlights || state.highlights
  });
}

/* ---------------- 按用户隔离 ---------------- */

export function getNamespace() { return namespace; }

/**
 * 切换数据命名空间并重新载入。
 * 登录成功后由 app.js 调用，必须在首次渲染之前完成。
 */
export function setNamespace(ns) {
  const next = ns || 'public';
  if (next === namespace) return state;
  namespace = next;
  STORAGE_KEY = keyOf(namespace);
  state = loadState();
  emit();
  return state;
}

/** 本机是否存在旧版本（未分用户）的数据 */
export function legacyInfo() {
  let raw = null;
  try { raw = localStorage.getItem(LEGACY_KEY); } catch (_) { return null; }
  if (!raw) return null;
  try {
    const p = JSON.parse(raw);
    const count = Object.keys(p.progress || {}).length;
    return {
      chapters: count,
      notes: (p.notes || []).length,
      bookmarks: (p.bookmarks || []).length,
      highlights: (p.highlights || []).length
    };
  } catch (_) { return null; }
}

/** 当前账号是否还没有任何学习数据 */
export function isCurrentEmpty() {
  return Object.keys(state.progress).length === 0
    && state.notes.length === 0
    && state.bookmarks.length === 0;
}

/**
 * 把旧版本数据迁移到当前账号名下。
 * 只补齐当前为空的部分，不覆盖已有数据；迁移后删除旧键，
 * 避免同一台机器上后续登录的账号再次被提示。
 */
export function migrateLegacyData() {
  let raw = null;
  try { raw = localStorage.getItem(LEGACY_KEY); } catch (_) { return { ok: false, reason: 'unavailable' }; }
  if (!raw) return { ok: false, reason: 'none' };

  let parsed;
  try { parsed = JSON.parse(raw); } catch (_) { return { ok: false, reason: 'corrupt' }; }

  const nonEmpty = (a) => Array.isArray(a) && a.length > 0;
  const next = {};
  if (Object.keys(state.progress).length === 0 && parsed.progress) next.progress = parsed.progress;
  if (state.notes.length === 0 && nonEmpty(parsed.notes)) next.notes = parsed.notes;
  if (state.bookmarks.length === 0 && nonEmpty(parsed.bookmarks)) next.bookmarks = parsed.bookmarks;
  if (state.highlights.length === 0 && nonEmpty(parsed.highlights)) next.highlights = parsed.highlights;
  if (parsed.lastChapter && !state.lastChapter) next.lastChapter = parsed.lastChapter;
  if (parsed.recent && state.recent.length === 0) next.recent = parsed.recent;

  setState(next);
  try { localStorage.removeItem(LEGACY_KEY); } catch (_) { /* ignore */ }
  return { ok: true };
}
