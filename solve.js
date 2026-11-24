// Fast reimplementation of makefun-site 1.0.0's build (see README in the kit).
// Dependency-free ES module: run(input) returns the same output tree the
// reference build returns, byte for byte. No imports, no clock, no env, no
// randomness, no file reads: the answer is a function of the input alone.
//
// Speed plan: cached slugify with a char-code fast path, manual (regex-free)
// Markdown block scanning, batched inline escaping, and template codegen
// (part 2) instead of tree-walking with scope chains.

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_RE = /[&<>"']/g;
const ESC_TEST = /[&<>"']/;

function escapeHtml(text) {
  return ESC_TEST.test(text) ? text.replace(ESC_RE, (c) => ESC[c]) : text;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function longDate(date) {
  const y = date.slice(0, 4);
  const m = Number(date.slice(5, 7));
  const d = Number(date.slice(8, 10));
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

// --- slugs -----------------------------------------------------------------

const slugCache = new Map();

function slugify(text) {
  const hit = slugCache.get(text);
  if (hit !== undefined) return hit;
  const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const code = plain.charCodeAt(i);
    let keep = -1;
    if (code >= 65 && code <= 90) keep = code + 32;
    else if ((code >= 97 && code <= 122) || (code >= 48 && code <= 57)) keep = code;
    if (keep === -1) {
      if (out.length > 0) gap = true;
      continue;
    }
    if (gap) {
      out += '-';
      gap = false;
    }
    out += String.fromCharCode(keep);
  }
  if (out.length > 64) {
    out = out.slice(0, 64);
    if (out.charCodeAt(63) === 45) out = out.slice(0, 63);
  }
  const res = out === '' ? 'untitled' : out;
  slugCache.set(text, res);
  return res;
}

function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    const ws = c === 32 || c === 9 || c === 10 || c === 13 || c === 12 || c === 11 || (c >= 128 && /\s/.test(text[i]));
    if (ws) inWord = false;
    else if (!inWord) {
      inWord = true;
      n++;
    }
  }
  return n;
}

// --- front matter ------------------------------------------------------------

const FM_KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const FM_LINE = /^([a-z_]+):(?: (.*))?$/;
const FM_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const FM_NAME = /^[a-z0-9-]+$/;
const FM_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FM_TAG = /^[^"[\]]+$/;

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = FM_DATE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !FM_TAG.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return FM_NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return FM_SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

function parseFrontMatter(text) {
  // Line 1 must be exactly "---"; work on offsets so the (large) body is
  // never split and re-joined: the body is one slice after the close line.
  let nl = text.indexOf('\n');
  const first = nl === -1 ? text : text.slice(0, nl);
  if (first !== '---') return { error: 'no front matter' };
  let pos = nl === -1 ? text.length : nl + 1;
  let closeLine = -1;
  let closeEnd = -1;
  let lineNo = 1;
  while (pos <= text.length) {
    nl = text.indexOf('\n', pos);
    const line = nl === -1 ? text.slice(pos) : text.slice(pos, nl);
    lineNo++;
    if (line === '---') {
      closeLine = lineNo;
      closeEnd = nl === -1 ? text.length : nl + 1;
      break;
    }
    pos = nl === -1 ? text.length + 1 : nl + 1;
  }
  if (closeLine === -1) return { error: 'the front matter is not closed' };
  const data = {};
  pos = first.length + 1;
  for (let i = 2; i < closeLine; i++) {
    nl = text.indexOf('\n', pos);
    const line = nl === -1 ? text.slice(pos) : text.slice(pos, nl);
    pos = nl === -1 ? text.length + 1 : nl + 1;
    let blank = true;
    for (let j = 0; j < line.length; j++) {
      const c = line.charCodeAt(j);
      if (c !== 32 && c !== 9) {
        blank = false;
        break;
      }
    }
    if (blank || line.charCodeAt(0) === 35) continue;
    const m = FM_LINE.exec(line);
    if (!m) return { error: `line ${i} is not "key: value"` };
    const key = m[1];
    const raw = (m[2] ?? '').replace(/[ \t]+$/, '');
    if (FM_KEYS.indexOf(key) === -1) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: closeEnd >= text.length ? '' : text.slice(closeEnd) };
}

// --- Markdown ----------------------------------------------------------------

function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return line.slice(a, b);
}

// Fence open: "```" + lang chars + spaces/tabs only; returns lang or null.
function fenceLang(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let i = 3;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    const ok = (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45;
    if (!ok) break;
    i++;
  }
  const lang = line.slice(3, i);
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return null;
    i++;
  }
  return lang;
}

function fenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function headingOf(line) {
  let n = 0;
  while (n < line.length && line.charCodeAt(n) === 35) n++;
  if (n === 0 || n > 6) return null;
  const c = line.charCodeAt(n);
  if (c !== 32 && c !== 9) return null;
  const text = trimLine(line.slice(n));
  if (text === '') return null;
  return { depth: n, text };
}

function isHr(line) {
  const dash = line.startsWith('---');
  const star = line.startsWith('***');
  if (!dash && !star) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function endsParagraph(line) {
  return isBlank(line) || fenceLang(line) !== null || headingOf(line) !== null || isHr(line);
}

function lex(src) {
  const lines = src.split('\n');
  const tokens = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }
    const lang = fenceLang(line);
    if (lang !== null) {
      const body = [];
      i++;
      while (i < lines.length && !fenceClose(lines[i])) body.push(lines[i++]);
      i++;
      tokens.push({ type: 'code', lang, lines: body });
      continue;
    }
    const heading = headingOf(line);
    if (heading !== null) {
      tokens.push({ type: 'heading', depth: heading.depth, text: heading.text });
      i++;
      continue;
    }
    if (isHr(line)) {
      tokens.push({ type: 'hr' });
      i++;
      continue;
    }
    if (line.charCodeAt(0) === 62) {
      const body = [];
      while (i < lines.length && lines[i].charCodeAt(0) === 62) {
        const l = lines[i++];
        body.push(l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1));
      }
      const kept = [];
      for (const l of body) {
        const t = trimLine(l);
        if (t !== '') kept.push(t);
      }
      tokens.push({ type: 'blockquote', lines: kept });
      continue;
    }
    const isBullet = (line.charCodeAt(0) === 45 || line.charCodeAt(0) === 42) && line.charCodeAt(1) === 32;
    let orderedDigits = -1;
    if (!isBullet) {
      let j = 0;
      while (j < line.length && line.charCodeAt(j) >= 48 && line.charCodeAt(j) <= 57) j++;
      if (j >= 1 && j <= 9 && line.charCodeAt(j) === 46 && line.charCodeAt(j + 1) === 32) orderedDigits = j;
    }
    if (isBullet || orderedDigits !== -1) {
      const isOrdered = orderedDigits !== -1;
      let firstNum = 1;
      if (isOrdered) {
        let j = 0;
        while (j < line.length && line.charCodeAt(j) >= 48 && line.charCodeAt(j) <= 57) j++;
        firstNum = Number(line.slice(0, j));
      }
      const items = [];
      while (i < lines.length) {
        const cur = lines[i];
        if (isOrdered) {
          let j = 0;
          while (j < cur.length && cur.charCodeAt(j) >= 48 && cur.charCodeAt(j) <= 57) j++;
          if (j >= 1 && j <= 9 && cur.charCodeAt(j) === 46 && cur.charCodeAt(j + 1) === 32) {
            items.push([trimLine(cur.slice(j + 2))]);
            i++;
            continue;
          }
        } else if ((cur.charCodeAt(0) === 45 || cur.charCodeAt(0) === 42) && cur.charCodeAt(1) === 32) {
          items.push([trimLine(cur.slice(2))]);
          i++;
          continue;
        }
        let sp = 0;
        while (sp < cur.length && cur.charCodeAt(sp) === 32) sp++;
        if (sp >= 2 && sp < cur.length && /\S/.test(cur[sp])) {
          items[items.length - 1].push(trimLine(cur));
          i++;
          continue;
        }
        break;
      }
      tokens.push({ type: 'list', ordered: isOrdered, start: firstNum, items: items.map((parts) => parts.join('\n')) });
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < lines.length && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    tokens.push({ type: 'paragraph', text: body.join('\n') });
  }
  return tokens;
}

const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

function findUnescaped(s, what, from) {
  for (let j = from; j <= s.length - what.length; j++) {
    if (s[j] === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (c !== '*') continue;
    if (s[j + 1] === '*') {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

function inlineInto(s, env, out) {
  let i = 0;
  let run = -1; // start of the current plain run (-1: none); flushed by slice
  const flush = (end) => {
    if (run !== -1) {
      out.push(escapeHtml(s.slice(run, end)));
      run = -1;
    }
  };
  while (i < s.length) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length && ESCAPABLE.has(s[i + 1])) {
      flush(i);
      const e = s[i + 1];
      out.push(ESC[e] || e);
      i += 2;
      continue;
    }
    if (c === '`') {
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) {
        flush(i);
        out.push('<code>', escapeHtml(s.slice(i + 1, j)), '</code>');
        i = j + 1;
      } else {
        if (run === -1) run = i;
        i++;
      }
      continue;
    }
    if (c === '*') {
      if (s[i + 1] === '*') {
        const j = findUnescaped(s, '**', i + 2);
        if (j > i + 2) {
          flush(i);
          out.push('<strong>');
          inlineInto(s.slice(i + 2, j), env, out);
          out.push('</strong>');
          i = j + 2;
        } else {
          if (run === -1) run = i;
          i += 2;
        }
        continue;
      }
      const j = findSingleStar(s, i + 1);
      if (j > i + 1) {
        flush(i);
        out.push('<em>');
        inlineInto(s.slice(i + 1, j), env, out);
        out.push('</em>');
        i = j + 1;
      } else {
        if (run === -1) run = i;
        i++;
      }
      continue;
    }
    if (c === '[') {
      const k = findUnescaped(s, ']', i + 1);
      const m = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
      const target = m === -1 ? '' : s.slice(k + 2, m);
      if (target !== '' && !/\s/.test(target)) {
        flush(i);
        out.push('<a href="', escapeHtml(env.link(target)), '">');
        inlineInto(s.slice(i + 1, k), env, out);
        out.push('</a>');
        i = m + 1;
        continue;
      }
      if (run === -1) run = i;
      i++;
      continue;
    }
    if (run === -1) run = i;
    i++;
  }
  flush(s.length);
}

function inlineStr(s, env) {
  const out = [];
  inlineInto(s, env, out);
  return out.join('');
}

function renderMarkdown(src, env) {
  const ids = new Set();
  const parts = [];
  const toc = [];
  let excerpt = null;
  for (const t of lex(src)) {
    if (t.type === 'heading') {
      const id = uniqueSlug(slugify(t.text), ids);
      if (t.depth === 2 || t.depth === 3) {
        const html = inlineStr(t.text, env);
        toc.push({ level: t.depth, id, html });
        parts.push(`<h${t.depth} id="${id}">`, html, `</h${t.depth}>`, '\n');
      } else {
        parts.push(`<h${t.depth} id="${id}">`);
        inlineInto(t.text, env, parts);
        parts.push(`</h${t.depth}>`, '\n');
      }
    } else if (t.type === 'code') {
      const cls = t.lang === '' ? '' : ` class="language-${escapeHtml(t.lang)}"`;
      parts.push('<pre><code', cls, '>');
      for (const l of t.lines) {
        parts.push(escapeHtml(l), '\n');
      }
      parts.push('</code></pre>', '\n');
    } else if (t.type === 'hr') {
      parts.push('<hr>', '\n');
    } else if (t.type === 'blockquote') {
      if (t.lines.length === 0) parts.push('<blockquote>\n</blockquote>', '\n');
      else {
        parts.push('<blockquote>\n<p>');
        inlineInto(t.lines.join('\n'), env, parts);
        parts.push('</p>\n</blockquote>', '\n');
      }
    } else if (t.type === 'list') {
      const tag = t.ordered ? 'ol' : 'ul';
      const open = t.ordered && t.start !== 1 ? `<ol start="${t.start}">` : `<${tag}>`;
      parts.push(open, '\n');
      for (const item of t.items) {
        parts.push('<li>');
        inlineInto(item, env, parts);
        parts.push('</li>\n');
      }
      parts.push(`</${tag}>`, '\n');
    } else {
      if (excerpt === null) {
        const html = inlineStr(t.text, env);
        excerpt = html;
        parts.push('<p>', html, '</p>', '\n');
      } else {
        parts.push('<p>');
        inlineInto(t.text, env, parts);
        parts.push('</p>', '\n');
      }
    }
  }
  return { html: parts.join(''), toc, excerpt: excerpt ?? '' };
}

// --- templates: parse to a tree, then compile the tree to a JS function -----
// A compiled template is fn(out, scopes, tpl, depth, H): it appends to `out`
// (an array of strings), reads values from `scopes` (an array of vars objects,
// innermost last), looks other templates up in `tpl`, and stops including
// past depth 8. For-loop bindings are resolved statically where the template
// itself binds the name; anything else goes through the dynamic lookup.

class TemplateError extends Error {}

const TPL_PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const TPL_FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const TPL_IF = /^if (not )?(\S+)$/;
const TPL_INCLUDE = /^include "([a-z0-9-]+)"$/;

function pathOf(name, text) {
  if (!TPL_PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = TPL_FOR.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = TPL_IF.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = TPL_INCLUDE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

function lookup(scopes, path) {
  for (let i = scopes.length - 1; i >= 0; i--) {
    const vars = scopes[i];
    if (Object.hasOwn(vars, path[0])) {
      let v = vars[path[0]];
      for (let k = 1; k < path.length; k++) {
        if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
        v = v[path[k]];
      }
      return v;
    }
  }
  return undefined;
}

function getProp(v, k) {
  return v !== null && typeof v === 'object' && Object.hasOwn(v, k) ? v[k] : undefined;
}

function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) {
    let s = '';
    for (let i = 0; i < v.length; i++) {
      if (i > 0) s += ', ';
      s += textOf(v[i]);
    }
    return s;
  }
  return '';
}

function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

const HELPERS = { esc: escapeHtml, txt: textOf, truthy, lk: lookup, g: getProp };

// Compile one parsed template body to fn(out, scopes, tpl, depth, H).
function compileBody(nodes) {
  const pathConsts = [];
  const pathIds = new Map();
  const code = [];
  let tmp = 0;

  function pathConst(path) {
    const key = path.join('.');
    let id = pathIds.get(key);
    if (id === undefined) {
      id = `_p${pathConsts.length}`;
      pathIds.set(key, id);
      pathConsts.push(`const ${id}=${JSON.stringify(path)};`);
    }
    return id;
  }

  // Expression for the value at `path`, given the statically known for-binds.
  function lookupExpr(path, binds) {
    if (path[0] === 'loop') {
      if (binds.length > 0) {
        let e = binds[binds.length - 1].loop;
        for (let k = 1; k < path.length; k++) e = `H.g(${e},${JSON.stringify(path[k])})`;
        return e;
      }
    } else {
      for (let b = binds.length - 1; b >= 0; b--) {
        if (binds[b].name === path[0]) {
          let e = binds[b].elem;
          for (let k = 1; k < path.length; k++) e = `H.g(${e},${JSON.stringify(path[k])})`;
          return e;
        }
      }
    }
    if (path.length === 1) return `H.lk(scopes,${pathConst(path)})`;
    let e = `H.lk(scopes,${pathConst(path.slice(0, 1))})`;
    for (let k = 1; k < path.length; k++) e = `H.g(${e},${JSON.stringify(path[k])})`;
    return e;
  }

  function emit(nodes, binds) {
    for (const n of nodes) {
      if (n.kind === 'text') code.push(`out.push(${JSON.stringify(n.text)});`);
      else if (n.kind === 'var') code.push(`out.push(H.esc(H.txt(${lookupExpr(n.path, binds)})));`);
      else if (n.kind === 'raw') code.push(`out.push(H.txt(${lookupExpr(n.path, binds)}));`);
      else if (n.kind === 'if') {
        const cond = n.not ? `!H.truthy(${lookupExpr(n.path, binds)})` : `H.truthy(${lookupExpr(n.path, binds)})`;
        code.push(`if(${cond}){`);
        emit(n.then, binds);
        code.push('}');
        if (n.else !== null) {
          code.push('else{');
          emit(n.else, binds);
          code.push('}');
        }
      } else if (n.kind === 'for') {
        const id = tmp++;
        const xs = `_x${id}`;
        const ln = `_l${id}`;
        const lp = `_o${id}`;
        const vs = `_v${id}`;
        const kk = `_k${id}`;
        code.push(`{const ${xs}=${lookupExpr(n.path, binds)};if(Array.isArray(${xs})){const ${ln}=${xs}.length;const ${lp}={index:0,first:true,last:${ln}===1,length:${ln}};const ${vs}={};${vs}.loop=${lp};scopes.push(${vs});for(let ${kk}=0;${kk}<${ln};${kk}++){const _e${id}=${xs}[${kk}];${vs}[${JSON.stringify(n.name)}]=_e${id};${lp}.index=${kk}+1;${lp}.first=${kk}===0;${lp}.last=${kk}===${ln}-1;`);
        emit(n.body, [...binds, { name: n.name, elem: `_e${id}`, loop: lp }]);
        code.push('}scopes.pop();}}');
      } else if (n.kind === 'include') {
        const id = tmp++;
        code.push(`{const _f${id}=tpl.get(${JSON.stringify(n.name)});if(_f${id}!==undefined&&depth<8)_f${id}(out,scopes,tpl,depth+1,H);}`);
      }
    }
  }

  emit(nodes, []);
  const src = pathConsts.join('') + code.join('');
  return new Function('out', 'scopes', 'tpl', 'depth', 'H', src);
}

// Compiled templates are a pure function of their source, so they are cached
// within one build; the caches are cleared at the start of every run() so no
// state carries from one case to the next (each case answered alone).
const tplCache = new Map();

function compileTemplate(name, src) {
  let fn = tplCache.get(src);
  if (fn === undefined) {
    fn = compileBody(parseTemplate(name, src));
    tplCache.set(src, fn);
  }
  return fn;
}

// --- the build ---------------------------------------------------------------

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

export function run(input) {
  // Nothing cached from one case to the next: clear both memo caches.
  slugCache.clear();
  tplCache.clear();
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, compileTemplate(name, input.templates[name]));
    } catch (err) {
      if (err instanceof TemplateError) report.push(err.message);
      else throw err;
    }
  }

  const base = input.site.base_url.replace(/\/+$/, '');
  const output = {};

  // 1. Sources, sorted by path; .md sources have \r\n / \r made \n.
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.replace(/\r\n?/g, '\n') });
    else statics.push({ path: f.path, content: f.content });
  }

  // 2. Front matter and the drop checks, in order.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = s.path.startsWith('tags/') ? 'tags' : s.path.startsWith('page/') ? 'page' : undefined;
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // 3. Permalinks: slug unique in its directory, in source order.
  const taken = new Map();
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? ['posts', 'tags', 'page'] : []);
      taken.set(dir, set);
    }
    s.slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), set);
    s.outDir = dir === '' ? s.slug : `${dir}/${s.slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. Markdown, links resolved.
  const staticPaths = new Set();
  for (const f of statics) staticPaths.add(f.path);
  const broken = new Set();
  for (const s of kept) {
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        if (SCHEME.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
        if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
        broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.body, env);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. Collections: posts newest first, equal dates by slug.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. Tags, grouped by slug, first spelling kept, ordered by count then slug.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name);
      if (!seen.has(slug)) {
        seen.add(slug);
        out.push({ name, slug });
      }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const { name, slug } of ownTags(p)) {
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (!s.post) s.tagRefs = ownTags(s).map(({ name, slug }) => bySlug.get(slug) ?? { name, slug, url: '', posts: [] });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // 7. Layouts.
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  const cards = new Map();
  for (const p of posts) cards.set(p, cardOf(p));
  const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });
  const pageOf = (s) => {
    const c = s.post ? cards.get(s) : cardOf(s);
    return {
      ...c,
      slug: s.slug,
      content: s.html,
      toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
      newer: linkOf(s.newer ?? null),
      older: linkOf(s.older ?? null),
      is_post: s.post,
    };
  };
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const render = (name, vars) => {
    const fn = templates.get(name);
    if (fn === undefined) return null;
    const out = [];
    fn(out, [{ site, tags: allTags, recent, ...vars }], templates, 0, HELPERS);
    return out.join('');
  };
  for (const s of kept) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) } });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. The report.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = kept.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}
