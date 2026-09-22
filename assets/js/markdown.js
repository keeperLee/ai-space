/* ============================================================
   Markdown 渲染器（面向阅读场景的轻量实现）
   支持：标题/段落/列表(嵌套/任务)/表格/引用/分割线/代码块/
        行内样式/图片/自定义容器 ::: callout | demo | diagram | figure
   ============================================================ */

import { esc, slugify } from './ui.js';
import { highlightCode, parseHlSpec } from './highlight.js';
import { getDiagram } from './diagrams.js';

/* ---------------- 行内渲染 ---------------- */
export function inline(text) {
  const codes = [];
  let s = String(text);

  // 保护行内代码
  s = s.replace(/``([^`]+)``|`([^`]+)`/g, (m, a, b) => {
    codes.push(a ?? b);
    return `\u0000C${codes.length - 1}\u0000`;
  });

  s = esc(s);

  // 图片
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g,
    (m, alt, src) => `<img class="inline-img" src="${src}" alt="${alt}" loading="lazy" />`);

  // 链接（外链新窗口打开）
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label, href) => {
    const ext = /^https?:\/\//i.test(href);
    return `<a href="${href}"${ext ? ' target="_blank" rel="noopener noreferrer"' : ''}>${label}</a>`;
  });

  // 加粗 / 斜体 / 删除线 / 高亮
  s = s.replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  s = s.replace(/==([^=]+)==/g, '<mark class="hl-key">$1</mark>');

  // 键盘按键
  s = s.replace(/\[\[([^\]]+)\]\]/g, '<kbd class="kbd">$1</kbd>');

  // 还原行内代码
  s = s.replace(/\u0000C(\d+)\u0000/g, (m, i) => `<code>${esc(codes[+i])}</code>`);

  return s;
}

/* ---------------- 代码块 ---------------- */
function parseFenceInfo(info) {
  const titleM = String(info).match(/title="([^"]*)"/);
  const hlM = String(info).match(/\{([^}]*)\}/);
  const clean = String(info).replace(/title="[^"]*"/, '').replace(/\{[^}]*\}/, '').trim();
  const lang = (clean.split(/\s+/)[0] || '').toLowerCase();
  return { lang, title: titleM ? titleM[1] : '', hl: parseHlSpec(hlM ? hlM[1] : '') };
}

function renderCode(code, lang, title, hlLines) {
  const body = highlightCode(code, lang, hlLines);
  const langLabel = lang || 'text';
  return `<div class="code-block">
  <div class="code-head">
    <span class="code-dots" aria-hidden="true"><i></i><i></i><i></i></span>
    ${title ? `<span class="code-file">${esc(title)}</span>` : ''}
    <span class="code-lang">${esc(langLabel)}</span>
    <button class="code-copy" type="button" data-copy>复制</button>
  </div>
  <pre><code class="lang-${esc(langLabel)}">${body}</code></pre>
</div>`;
}

/* ---------------- 列表 ---------------- */
function buildList(items, start, indent) {
  const lis = [];
  let i = start;
  while (i < items.length && items[i].indent >= indent) {
    const it = items[i];
    if (it.indent > indent) {
      const sub = buildList(items, i, it.indent);
      if (lis.length) lis[lis.length - 1] = lis[lis.length - 1].replace(/<\/li>$/, `${sub.html}</li>`);
      else lis.push(`<li>${sub.html}</li>`);
      i = sub.next;
      continue;
    }
    let body = inline(it.text);
    // 任务列表
    if (/^\[[ xX]\]\s?/.test(it.text)) {
      const checked = /^\[[xX]\]/.test(it.text);
      body = inline(it.text.replace(/^\[[ xX]\]\s?/, ''));
      body = `<span class="task${checked ? ' is-checked' : ''}">${checked ? '☑' : '☐'}</span>${body}`;
    }
    i++;
    if (i < items.length && items[i].indent > indent) {
      const sub = buildList(items, i, items[i].indent);
      body += sub.html;
      i = sub.next;
    }
    lis.push(`<li>${body}</li>`);
  }
  const type = items[start].ordered ? 'ol' : 'ul';
  return { html: `<${type}>${lis.join('')}</${type}>`, next: i };
}

/* ---------------- 表格 ---------------- */
function renderTable(rows) {
  const head = rows[0];
  const body = rows.slice(1);
  const align = rows.align || [];
  const th = head.map((c, i) => `<th${align[i] ? ` style="text-align:${align[i]}"` : ''}>${inline(c)}</th>`).join('');
  const tb = body.map((r) => `<tr>${r.map((c, i) => `<td${align[i] ? ` style="text-align:${align[i]}"` : ''}>${inline(c)}</td>`).join('')}</tr>`).join('');
  return `<div class="table-wrap"><table class="data"><thead><tr>${th}</tr></thead><tbody>${tb}</tbody></table></div>`;
}

const splitRow = (line) => line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());

/* ---------------- 自定义容器 ---------------- */
const CALLOUT_META = {
  tip: { icon: '💡', title: '小技巧' },
  info: { icon: 'ℹ️', title: '说明' },
  warn: { icon: '⚠️', title: '注意' },
  danger: { icon: '🚫', title: '风险提示' },
  key: { icon: '🔑', title: '核心要点' },
  quote: { icon: '❝', title: '' }
};

/* ---------------- 主渲染 ---------------- */
export function renderMarkdown(src) {
  const lines = String(src).replace(/\r\n?/g, '\n').split('\n');
  const toc = [];
  const slugCount = new Map();
  const out = [];
  let i = 0;

  const makeId = (text) => {
    const base = slugify(text);
    const n = (slugCount.get(base) || 0) + 1;
    slugCount.set(base, n);
    return n > 1 ? `${base}-${n}` : base;
  };

  const isBlank = (l) => /^\s*$/.test(l);

  while (i < lines.length) {
    const line = lines[i];

    /* --- 空行 --- */
    if (isBlank(line)) { i++; continue; }

    /* --- 代码块 --- */
    const fence = line.match(/^```(.*)$/);
    if (fence) {
      const info = parseFenceInfo(fence[1]);
      const buf = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) { buf.push(lines[i]); i++; }
      i++; // 跳过结束 ```
      out.push(renderCode(buf.join('\n'), info.lang, info.title, info.hl));
      continue;
    }

    /* --- ::: 容器 --- */
    const container = line.match(/^:::\s*([a-zA-Z][\w-]*)\s*(.*)$/);
    if (container && container[1] !== '') {
      const type = container[1].toLowerCase();
      const rest = container[2].trim();
      const buf = [];
      i++;
      let depth = 1;
      while (i < lines.length) {
        if (/^:::\s*[a-zA-Z]/.test(lines[i])) depth++;
        else if (/^:::\s*$/.test(lines[i])) { depth--; if (depth === 0) { i++; break; } }
        buf.push(lines[i]);
        i++;
      }
      const inner = buf.join('\n');

      if (type === 'demo') {
        out.push(`<div class="demo-mount" data-demo="${esc(rest.split(/\s+/)[0] || '')}"></div>`);
        continue;
      }
      if (type === 'diagram') {
        const nameM = rest.match(/^([\w-]+)/);
        const capM = rest.match(/caption="([^"]*)"/);
        const svg = getDiagram(nameM ? nameM[1] : '');
        out.push(`<div class="diagram">${svg}${capM ? `<div class="diagram-cap">${inline(capM[1])}</div>` : ''}</div>`);
        continue;
      }
      if (type === 'figure') {
        const srcM = rest.match(/src="([^"]*)"/);
        const capM = rest.match(/caption="([^"]*)"/);
        out.push(`<figure class="fig"><div class="fig-frame"><img src="${srcM ? srcM[1] : ''}" alt="${capM ? capM[1] : ''}" loading="lazy" /></div>${capM ? `<figcaption>${inline(capM[1])}</figcaption>` : ''}</figure>`);
        continue;
      }
      if (type === 'columns') {
        const parts = inner.split(/^---\s*$/m).map((p) => renderMarkdown(p).html).join('');
        out.push(`<div class="fig-grid">${parts}</div>`);
        continue;
      }
      if (CALLOUT_META[type]) {
        const meta = CALLOUT_META[type];
        const title = rest || meta.title;
        out.push(`<div class="callout ${type}">
  <span class="co-icon" aria-hidden="true">${meta.icon}</span>
  <div class="co-body">${title ? `<div class="co-title">${inline(title)}</div>` : ''}${renderMarkdown(inner).html}</div>
</div>`);
        continue;
      }
      // 未知容器 → 原样渲染内容
      out.push(renderMarkdown(inner).html);
      continue;
    }

    /* --- 标题 --- */
    const head = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (head) {
      const level = head[1].length;
      const text = head[2];
      const id = makeId(text);
      out.push(`<h${level} id="${id}"><a class="anchor" href="#${id}" aria-hidden="true">#</a>${inline(text)}</h${level}>`);
      if (level >= 2 && level <= 4) toc.push({ id, text: text.replace(/[*`_]/g, ''), level });
      i++;
      continue;
    }

    /* --- 分割线 --- */
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { out.push('<hr />'); i++; continue; }

    /* --- 表格 --- */
    if (/\|/.test(line) && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1]) && /-/.test(lines[i + 1])) {
      const rows = [splitRow(line)];
      const aligns = splitRow(lines[i + 1]).map((c) => {
        const l = c.startsWith(':'), r = c.endsWith(':');
        return l && r ? 'center' : r ? 'right' : l ? 'left' : '';
      });
      i += 2;
      while (i < lines.length && /\|/.test(lines[i]) && !isBlank(lines[i])) { rows.push(splitRow(lines[i])); i++; }
      rows.align = aligns;
      out.push(renderTable(rows));
      continue;
    }

    /* --- 引用 --- */
    if (/^\s*>/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) { buf.push(lines[i].replace(/^\s*>\s?/, '')); i++; }
      out.push(`<blockquote>${renderMarkdown(buf.join('\n')).html}</blockquote>`);
      continue;
    }

    /* --- 列表 --- */
    const listM = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
    if (listM) {
      const items = [];
      while (i < lines.length) {
        const m = lines[i].match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
        if (!m) {
          // 列表项内的续行
          if (items.length && !isBlank(lines[i]) && /^\s{2,}/.test(lines[i])) {
            items[items.length - 1].text += ' ' + lines[i].trim();
            i++;
            continue;
          }
          break;
        }
        items.push({
          indent: m[1].replace(/\t/g, '  ').length,
          ordered: /\d/.test(m[2]),
          text: m[3]
        });
        i++;
      }
      out.push(buildList(items, 0, items[0].indent).html);
      continue;
    }

    /* --- 原始 HTML 块 --- */
    if (/^\s*<(div|table|figure|svg|section|iframe|details|p|ul|ol|img)\b/i.test(line)) {
      const buf = [];
      while (i < lines.length && !isBlank(lines[i])) { buf.push(lines[i]); i++; }
      out.push(buf.join('\n'));
      continue;
    }

    /* --- 段落 --- */
    const buf = [line];
    i++;
    while (i < lines.length && !isBlank(lines[i]) &&
      !/^(#{1,6})\s/.test(lines[i]) &&
      !/^```/.test(lines[i]) &&
      !/^:::/.test(lines[i]) &&
      !/^\s*>/.test(lines[i]) &&
      !/^(\s*)([-*+]|\d+[.)])\s+/.test(lines[i]) &&
      !/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(lines[i])) {
      buf.push(lines[i]);
      i++;
    }
    out.push(`<p>${inline(buf.join(' '))}</p>`);
  }

  return { html: out.join('\n'), toc };
}

/* ---------------- 纯文本提取（用于搜索索引） ---------------- */
export function toPlainText(md) {
  return String(md)
    .replace(/```[\s\S]*?```/g, (m) => ' ' + m.replace(/```[^\n]*/g, ' ') + ' ')
    .replace(/^:::\s*[a-zA-Z][\w-]*.*$/gm, ' ')
    .replace(/^:::\s*$/gm, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1 ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1 ')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[*_`~>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
