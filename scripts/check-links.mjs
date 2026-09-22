#!/usr/bin/env node
/* ============================================================
   外链可用性检查（需要网络，不参与默认 CI）
   用法：node scripts/check-links.mjs [--strict]
   ------------------------------------------------------------
   扫描 projects/agent-learning/content/chapters/*.md 与 README.md 中的外部链接，
   并发发起 GET 请求（跟随重定向），报告失效链接。
   --strict：把「疑似反爬（403/429）」也视为失败
   ============================================================ */

import { readFileSync, readdirSync, existsSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const P = (...s) => join(ROOT, ...s);
const STRICT = process.argv.includes('--strict');
const CONCURRENCY = 6;
const TIMEOUT_MS = 15000;

const USE_COLOR = !process.env.NO_COLOR && process.stdout.isTTY !== false;
const paint = (s, c) => (USE_COLOR ? `${c}${s}\u001b[0m` : s);
const C = { red: '\u001b[31m', green: '\u001b[32m', yellow: '\u001b[33m', dim: '\u001b[2m', bold: '\u001b[1m' };

/* ---------------- 收集链接 ---------------- */
const SOURCES = [
  ...readdirSync(P('projects/agent-learning/content/chapters')).filter((f) => f.endsWith('.md')).map((f) => `projects/agent-learning/content/chapters/${f}`),
  'README.md',
  'index.html'
].filter((f) => existsSync(P(f)));

/** url -> Set(出现位置) */
const links = new Map();
const URL_RE = /\bhttps?:\/\/[^\s)\]<>"'`，。；、）】]+/g;

for (const file of SOURCES) {
  const text = readFileSync(P(file), 'utf8');
  for (const m of text.matchAll(URL_RE)) {
    const url = m[0].replace(/[.,;:）】]+$/, '');
    // 站点自身地址不需要检查（本地预览时也不通）
    if (/keeperlee\.github\.io/.test(url)) continue;
    if (/localhost|127\.0\.0\.1/.test(url)) continue;
    if (/example\.(com|org)/.test(url)) continue;
    // XML 命名空间不是可访问的链接（如 svg 的 xmlns）
    if (/^http:\/\/www\.w3\.org\//.test(url)) continue;
    if (!links.has(url)) links.set(url, new Set());
    links.get(url).add(file);
  }
}

const all = [...links.keys()].sort();
console.log('');
console.log(paint(`  外链检查 · 共 ${all.length} 个唯一链接（来自 ${SOURCES.length} 个文件）`, C.bold));
console.log(paint('  ' + '─'.repeat(58), C.dim));
console.log('');

/* ---------------- 检查 ---------------- */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

async function check(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    let res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: ctrl.signal,
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
      }
    });
    // 少数站点对 HEAD 友好、对 GET 限流；这里不做二次尝试，只如实记录
    return { url, status: res.status, final: res.url };
  } catch (err) {
    return { url, status: 0, error: err.name === 'AbortError' ? '超时' : String(err.message || err) };
  } finally {
    clearTimeout(timer);
  }
}

const results = [];
let cursor = 0;
async function worker() {
  while (cursor < all.length) {
    const url = all[cursor++];
    const r = await check(url);
    results.push(r);
    const files = [...links.get(url)].join(', ');
    const cls = r.status >= 200 && r.status < 400 ? C.green
      : r.status === 403 || r.status === 429 ? C.yellow : C.red;
    const mark = r.status >= 200 && r.status < 400 ? '✓'
      : r.status === 403 || r.status === 429 ? '!' : '✗';
    console.log(`  ${paint(mark, cls)} ${String(r.status || r.error).padEnd(6)} ${url}`);
    if (mark !== '✓') console.log(paint(`      ↑ ${files}`, C.dim));
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, worker));

/* ---------------- 汇总 ---------------- */
const okList = results.filter((r) => r.status >= 200 && r.status < 400);
const blockList = results.filter((r) => r.status === 403 || r.status === 429);
const badList = results.filter((r) => !(r.status >= 200 && r.status < 400) && r.status !== 403 && r.status !== 429);

console.log('');
console.log(`  通过 ${paint(String(okList.length), C.green)} · 疑似反爬 ${paint(String(blockList.length), C.yellow)} · 失效 ${paint(String(badList.length), C.red)}`);
console.log('');

if (badList.length) {
  console.log(paint('  失效链接：', C.red));
  for (const b of badList) console.log(`    ${b.url}  (${b.status || b.error})  ← ${[...links.get(b.url)].join(', ')}`);
  console.log('');
}

const failed = badList.length + (STRICT ? blockList.length : 0);
if (failed) {
  console.log(paint(`  存在 ${failed} 个需要处理的链接。`, C.red));
  console.log('');
  process.exit(1);
}
console.log(paint('  所有外链均可用。', C.green));
console.log('');
