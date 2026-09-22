/* ============================================================
   轻量语法高亮（无外部依赖）
   支持逐行着色 + 跨行字符串/注释状态（Python 三引号、C 风格块注释）
   ============================================================ */

const KEYWORDS = {
  python: 'False|None|True|and|as|assert|async|await|break|class|continue|def|del|elif|else|except|finally|for|from|global|if|import|in|is|lambda|nonlocal|not|or|pass|raise|return|try|while|with|yield|self',
  javascript: 'const|let|var|function|return|if|else|for|while|do|break|continue|new|class|extends|super|this|import|export|from|default|async|await|try|catch|finally|throw|typeof|instanceof|in|of|delete|void|yield|static|get|set|null|undefined|true|false',
  typescript: 'const|let|var|function|return|if|else|for|while|do|break|continue|new|class|extends|implements|interface|type|enum|namespace|super|this|import|export|from|default|async|await|try|catch|finally|throw|typeof|instanceof|in|of|keyof|readonly|public|private|protected|static|as|is|null|undefined|true|false|void|never|any|unknown|string|number|boolean',
  json: 'true|false|null',
  bash: 'if|then|else|elif|fi|for|while|do|done|case|esac|function|return|export|local|echo|cd|source|set|curl|pip|npm|python|git|cat|grep|mkdir|run|in|of',
  yaml: 'true|false|null|yes|no|on|off',
  sql: 'SELECT|FROM|WHERE|JOIN|LEFT|RIGHT|INNER|OUTER|ON|GROUP|BY|ORDER|HAVING|LIMIT|INSERT|INTO|VALUES|UPDATE|SET|DELETE|CREATE|TABLE|INDEX|AS|AND|OR|NOT|NULL|DISTINCT|COUNT|SUM|AVG|MAX|MIN|WITH|UNION|CASE|WHEN|THEN|ELSE|END',
  go: 'package|import|func|return|if|else|for|range|var|const|type|struct|interface|map|chan|go|defer|select|switch|case|default|break|continue|nil|true|false|make|new',
  java: 'public|private|protected|class|interface|enum|extends|implements|static|final|void|new|return|if|else|for|while|do|switch|case|default|break|continue|try|catch|finally|throw|throws|import|package|null|true|false|this|super'
};

const STRING_RE = {
  default: '"(?:\\\\.|[^"\\\\\\n])*"|\'(?:\\\\.|[^\'\\\\\\n])*\'|`(?:\\\\.|[^`\\\\])*`',
  python: '"""(?:[\\s\\S]*?)"""|\'\'\'(?:[\\s\\S]*?)\'\'\'|"(?:\\\\.|[^"\\\\\\n])*"|\'(?:\\\\.|[^\'\\\\\\n])*\'',
  sql: "'(?:[^']|'')*'|\"(?:[^\"]|\"\")*\""
};

const COMMENT_RE = {
  default: '\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/',
  python: '#[^\\n]*',
  bash: '#[^\\n]*',
  yaml: '#[^\\n]*',
  sql: '--[^\\n]*',
  json: ''
};

const MULTILINE = {
  python: { start: /("""|''')/, endMap: { '"""': '"""', "'''": "'''" } },
  default: { start: /\/\*/, endMap: { '/*': '*/' } }
};

/** 支持跨行块的语言 */
const HAS_BLOCK = new Set(['python', 'javascript', 'typescript', 'go', 'java', 'sql']);

const LANGS = {
  py: 'python', python: 'python',
  js: 'javascript', javascript: 'javascript', jsx: 'javascript', mjs: 'javascript', node: 'javascript',
  ts: 'typescript', typescript: 'typescript', tsx: 'typescript',
  json: 'json', jsonc: 'json',
  sh: 'bash', shell: 'bash', bash: 'bash', zsh: 'bash', console: 'bash', terminal: 'bash',
  yml: 'yaml', yaml: 'yaml',
  sql: 'sql', go: 'go', golang: 'go', java: 'java',
  text: 'text', plain: 'text', txt: 'text', md: 'text', markdown: 'text'
};

export function normalizeLang(lang) {
  return LANGS[String(lang || '').toLowerCase()] || 'text';
}

function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function buildRegex(L) {
  const parts = [];
  const comment = COMMENT_RE[L] !== undefined ? COMMENT_RE[L] : COMMENT_RE.default;
  if (comment) parts.push(`(${comment})`);
  else parts.push('(\\u0000NEVER\\u0000)');
  parts.push(`(${STRING_RE[L] || STRING_RE.default})`);                       // 2 字符串
  parts.push('(#[A-Fa-f0-9]{3,8}\\b|\\b\\d+\\.?\\d*(?:[eE][-+]?\\d+)?\\b)'); // 3 数字
  parts.push(`\\b(${KEYWORDS[L] || '\\u0000NEVER\\u0000'})\\b`);             // 4 关键字
  parts.push('\\b([A-Za-z_$][\\w$]*)(?=\\s*\\()');                            // 5 函数调用
  parts.push('\\b([A-Z][A-Za-z0-9_]*)\\b');                                   // 6 类名
  return new RegExp(parts.join('|'), 'g');
}

const regexCache = new Map();
function getRegex(L) {
  if (!regexCache.has(L)) regexCache.set(L, buildRegex(L));
  return regexCache.get(L);
}

function tokenizeLine(line, L) {
  if (L === 'text') return esc(line);
  const re = getRegex(L);
  re.lastIndex = 0;
  let out = '';
  let last = 0;
  let m;
  while ((m = re.exec(line)) !== null) {
    if (m.index > last) out += esc(line.slice(last, m.index));
    const text = esc(m[0]);
    let cls = '';
    if (m[1]) cls = 'tk-com';
    else if (m[2]) cls = 'tk-str';
    else if (m[3]) cls = 'tk-num';
    else if (m[4]) cls = 'tk-kw';
    else if (m[5]) cls = 'tk-fn';
    else if (m[6]) cls = 'tk-cls';
    out += cls ? `<span class="${cls}">${text}</span>` : text;
    last = m.index + m[0].length;
    if (m[0].length === 0) re.lastIndex++;
  }
  out += esc(line.slice(last));
  return out;
}

/**
 * 高亮代码并按行输出
 * @param {string} code
 * @param {string} lang
 * @param {Set<number>} hlLines 需要高亮的行号（1 起）
 */
export function highlightCode(code, lang, hlLines = new Set()) {
  const L = normalizeLang(lang);
  const lines = String(code).replace(/\r\n?/g, '\n').replace(/\n+$/, '').split('\n');
  const ml = MULTILINE[L] || MULTILINE.default;
  let carry = null; // 跨行的块注释 / 三引号标记

  return lines.map((line, i) => {
    let html;

    if (carry) {
      const marker = ml.endMap[carry];
      const idx = line.indexOf(marker);
      if (idx === -1) {
        html = `<span class="${carry.startsWith('"""') || carry.startsWith("'''") ? 'tk-str' : 'tk-com'}">${esc(line)}</span>`;
      } else {
        const cls = carry.startsWith('"""') || carry.startsWith("'''") ? 'tk-str' : 'tk-com';
        html = `<span class="${cls}">${esc(line.slice(0, idx + marker.length))}</span>` + tokenizeLine(line.slice(idx + marker.length), L);
        carry = null;
      }
    } else {
      const startMatch = HAS_BLOCK.has(L) ? line.match(ml.start) : null;
      if (startMatch) {
        const startIdx = startMatch.index;
        const marker = startMatch[0];
        const endMarker = ml.endMap[marker];
        const rest = line.slice(startIdx + marker.length);
        const endIdx = rest.indexOf(endMarker);
        if (endIdx === -1) {
          const cls = marker.startsWith('"""') || marker.startsWith("'''") ? 'tk-str' : 'tk-com';
          html = tokenizeLine(line.slice(0, startIdx), L) + `<span class="${cls}">${esc(line.slice(startIdx))}</span>`;
          carry = marker;
        } else {
          html = tokenizeLine(line, L);
        }
      } else {
        html = tokenizeLine(line, L);
      }
    }

    const nn = i + 1;
    const hlClass = hlLines.has(nn) ? ' code-line hl' : ' code-line';
    return `<span class="${hlClass.trim()}" data-line="${nn}">${html || '&nbsp;'}</span>`;
  }).join('\n');
}

/** 解析 ```lang {1,3-5} 中的行号标记 */
export function parseHlSpec(spec) {
  const set = new Set();
  if (!spec) return set;
  String(spec).replace(/[{}]/g, '').split(',').forEach((part) => {
    const seg = part.trim();
    if (!seg) return;
    const m = seg.match(/^(\d+)\s*-\s*(\d+)$/);
    if (m) {
      const a = +m[1], b = +m[2];
      for (let i = Math.min(a, b); i <= Math.max(a, b); i++) set.add(i);
    } else if (/^\d+$/.test(seg)) set.add(+seg);
  });
  return set;
}
