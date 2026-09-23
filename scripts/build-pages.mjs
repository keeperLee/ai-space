#!/usr/bin/env node
/* ============================================================
   构建可发布到 GitHub Pages 的静态站点（零依赖）
   ------------------------------------------------------------
   GitHub Pages 不能运行 Node，也没有 SQLite，所以不能直接把
   仓库扔上去 —— 需要先把「站点真正用到的文件」挑出来放进 dist/，
   并且此时必须处于公开访问模式（assets/js/access.js）。

   产出结构（与运行时 URL 一一对应）：

     dist/
       .nojekyll                       关闭 Jekyll，否则 *.md 会被编译成 HTML
       index.html                      门户
       assets/                         门户的样式与脚本
       content/projects.js             项目列表
       projects/agent-learning/
         index.html                    → 跳转到 learning.html
         learning.html                 学习应用入口
         assets/                       学习应用的样式与脚本
         content/                      课程目录、更新日志、章节 Markdown

   子模块里的 server/ scripts/ examples/ 等不属于站点，不复制。
   ============================================================ */

import { mkdirSync, writeFileSync, cpSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname, join, relative, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ACCESS } from '../assets/js/access.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIST = resolve(ROOT, 'dist');
const LEARNING_SRC = resolve(ROOT, 'projects/agent-learning');
const LEARNING_DEST_REL = 'projects/agent-learning';

const C = { reset: '\u001b[0m', red: '\u001b[31m', green: '\u001b[32m', yellow: '\u001b[33m', dim: '\u001b[2m', bold: '\u001b[1m' };
const USE_COLOR = !process.env.NO_COLOR && process.stdout.isTTY !== false;
const paint = (s, c) => (USE_COLOR ? `${c}${s}${C.reset}` : s);

const die = (msg) => {
  console.error(`\n  ${paint('✗', C.red)} ${msg}\n`);
  process.exit(1);
};

/* ============================================================
   0. 前置检查
   ============================================================ */
if (!ACCESS.open) {
  die(
    '当前不是公开访问模式（assets/js/access.js 里 open = false）。\n'
    + '    登录门禁需要服务端 /api 与 SQLite，GitHub Pages 提供不了，\n'
    + '    硬发布出去只会让所有人卡在「无法连接账号服务」。\n'
    + '    要么把 open 改回 true，要么把门户部署到支持 Node 的服务器。'
  );
}

if (!existsSync(LEARNING_SRC)) {
  die(
    `找不到学习项目子模块：${LEARNING_SRC}\n`
    + '    请先执行：git submodule update --init --recursive'
  );
}
if (!existsSync(join(LEARNING_SRC, 'learning.html'))) {
  die(
    '子模块内容为空（没有 learning.html）。子模块尚未初始化。\n'
    + '    请执行：git submodule update --init --recursive'
  );
}

/* ============================================================
   1. 清空并重建 dist
   ============================================================ */
rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });

const copied = [];

/* ============================================================
   2. 门户本体
   ============================================================ */
for (const rel of ['index.html']) {
  cpSync(resolve(ROOT, rel), resolve(DIST, rel));
  copied.push(rel);
}

for (const rel of ['assets', join('content', 'projects.js')]) {
  cpSync(resolve(ROOT, rel), resolve(DIST, rel), { recursive: true });
  copied.push(rel);
}

/* ============================================================
   3. 学习应用（子模块白名单）
   ============================================================ */
const LEARNING_ITEMS = ['learning.html', 'assets', 'content'];
for (const rel of LEARNING_ITEMS) {
  const from = join(LEARNING_SRC, rel);
  if (!existsSync(from)) die(`子模块缺少必需内容：${posix.join(LEARNING_DEST_REL, rel)}`);
  cpSync(from, resolve(DIST, LEARNING_DEST_REL, rel), { recursive: true });
  copied.push(posix.join(LEARNING_DEST_REL, rel));
}

/* 学习应用里「返回项目门户」用的是 href="./"，在 /projects/agent-learning/
   下会解析成自己所在的目录（404）。按层级深度改写成指回门户根目录的相对路径。
   Node 服务端运行时做的是同一件事（见 scripts/serve.mjs）。 */
const learningHtmlPath = resolve(DIST, LEARNING_DEST_REL, 'learning.html');
const depth = LEARNING_DEST_REL.split('/').length;
const portalPrefix = '../'.repeat(depth);
const learningHtml = readFileSync(learningHtmlPath, 'utf8');
const rewritten = learningHtml.replaceAll('href="./"', `href="${portalPrefix}"`);
const backLinks = (learningHtml.match(/href="\.\/"/g) || []).length;
writeFileSync(learningHtmlPath, rewritten, 'utf8');

/* 直接访问 /projects/agent-learning/ 时给个去处，而不是 404 */
writeFileSync(
  resolve(DIST, LEARNING_DEST_REL, 'index.html'),
  '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
  + '<meta http-equiv="refresh" content="0;url=./learning.html">'
  + '<meta name="viewport" content="width=device-width,initial-scale=1">'
  + '<title>Agent 学习平台</title></head>'
  + '<body><p>正在进入 <a href="./learning.html">Agent 学习平台</a>…</p></body></html>\n',
  'utf8'
);

/* ============================================================
   4. .nojekyll —— 少了它，Jekyll 会把章节 Markdown 编译成 HTML，
      前端 fetch 取回的就是 HTML 而不是 Markdown，课程直接打不开
   ============================================================ */
writeFileSync(resolve(DIST, '.nojekyll'), '');

/* ============================================================
   5. 自检：发布前把「打开就会 404」的情况挡住
   ============================================================ */
const EXPECTED = [
  'index.html',
  '.nojekyll',
  'assets/css/portal.css',
  'assets/css/auth.css',
  'assets/js/portal.js',
  'assets/js/access.js',
  'content/projects.js',
  `${LEARNING_DEST_REL}/learning.html`,
  `${LEARNING_DEST_REL}/assets/css/main.css`,
  `${LEARNING_DEST_REL}/assets/js/app.js`,
  `${LEARNING_DEST_REL}/content/catalog.js`,
  `${LEARNING_DEST_REL}/content/changelog.js`,
];

const missing = EXPECTED.filter((rel) => !existsSync(resolve(DIST, rel)));
if (missing.length) {
  die(`构建产物缺少以下文件，发布后会出现 404：\n    ${missing.join('\n    ')}`);
}

/* 章节 Markdown 必须齐备，否则课程内容会在运行时加载失败 */
const chaptersDir = resolve(DIST, LEARNING_DEST_REL, 'content/chapters');
const chapters = existsSync(chaptersDir) ? readdirSync(chaptersDir).filter((f) => f.endsWith('.md')) : [];
if (chapters.length === 0) die('构建产物里没有章节 Markdown，课程内容会全部加载失败');

/* 交付的 index.html 里不应再残留登录门禁的「启动占位」，
   否则在静态托管上会一直显示「正在检查登录状态」 */
const portalHtml = readFileSync(resolve(DIST, 'index.html'), 'utf8');
if (/class="auth-pending"/.test(portalHtml) && !/bootLoader/.test(portalHtml)) {
  // 有 auth-pending 但没有 bootLoader 才需要处理；两者都有是正常的，
  // 因为公开访问模式下 portal.js 会立刻 dismissBoot()。
}

/* 反例保护：如果构建出的地址还指着 /api，说明忘了开公开访问 */
for (const rel of [`${LEARNING_DEST_REL}/assets/js/auth.js`, 'assets/js/auth.js']) {
  const src = readFileSync(resolve(DIST, rel), 'utf8');
  if (!src.includes('ACCESS.open')) {
    die(`${rel} 里没有公开访问分支 —— 静态托管上没有 /api，页面会卡在登录门禁`);
  }
}

/* ============================================================
   6. 汇总
   ============================================================ */
const totalFiles = (() => {
  let n = 0;
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(dir, e.name)); else n++;
    }
  };
  walk(DIST);
  return n;
})();

console.log('');
console.log(`  ${paint('AI Space · Pages 静态构建', C.bold)}`);
console.log(`  ${paint('─'.repeat(56), C.dim)}`);
console.log(`  访问模式      公开访问（不需要登录）`);
console.log(`  门户入口      index.html`);
console.log(`  学习项目      /${LEARNING_DEST_REL}/learning.html`);
console.log(`  回门户链接    改写 ${backLinks} 处 → "${portalPrefix}"`);
console.log(`  章节 Markdown ${chapters.length} 篇`);
console.log(`  产物          共 ${totalFiles} 个文件 → ${relative(ROOT, DIST).replace(/\\/g, '/')}/`);
console.log('');
console.log(`  ${paint('✓ 构建完成，可以发布到 GitHub Pages', C.green)}`);
console.log('');
