/* ============================================================
   内容加载（带缓存）
   ============================================================ */

import { asset } from './ui.js';

const cache = new Map();

export async function loadChapter(id) {
  if (cache.has(id)) return cache.get(id);
  const url = asset(`projects/agent-learning/content/chapters/${id}.md`);
  let res;
  try {
    res = await fetch(url, { cache: 'no-cache' });
  } catch (err) {
    throw new Error(
      location.protocol === 'file:'
        ? '无法读取章节内容：当前以 file:// 方式打开，浏览器禁止本地文件请求。请用本地服务器访问（例如在项目根目录执行 npx serve）。'
        : `网络请求失败：${url}`
    );
  }
  if (!res.ok) throw new Error(`章节文件不存在或不可读（HTTP ${res.status}）：projects/agent-learning/content/chapters/${id}.md`);
  const text = await res.text();
  cache.set(id, text);
  return text;
}

export function isCached(id) { return cache.has(id); }
export function clearCache() { cache.clear(); }
