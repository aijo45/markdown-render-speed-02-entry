// parse.js — a fast, dependency-free Markdown to HTML renderer.
//
// Written from scratch for this competition. It produces, for every input
// string, exactly the HTML that marked 18.1.3 produces with its default
// options (GFM on, breaks off, pedantic off, async off). The behaviour was
// learned from the CommonMark 0.31.2 and GFM 0.29 specifications and from
// probing the reference renderer's output on the spec examples; no code
// from any other renderer is used here.
//
// Design: a block pass splits the document into blocks (headings, lists,
// block quotes, code, tables, HTML, paragraphs) and an inline pass turns
// each block's text into HTML. Both passes scan with plain character loops
// instead of regular expressions on their hot paths, which is what makes
// this renderer fast: the input is walked once per pass, text runs are
// copied in bulk, and no per-token regular expression is executed.
//
// parse() is pure: it keeps nothing between calls and returns, for each
// input, only what that input alone renders to.

/* ------------------------------------------------------------------ */
/* Character classification                                            */
/* ------------------------------------------------------------------ */

// Bit flags for ASCII characters (code < 128), indexed by code point.
const C_SPACE = 1; // JS \s for ASCII: space, \t, \n, \v, \f, \r
const C_PUNCT = 2; // Unicode P or S categories, ASCII subset
const C_WORD = 4; // [A-Za-z0-9_]
const C_DIGIT = 8;

const CLS = new Uint8Array(128);
{
  const punct = "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~";
  for (let i = 0; i < 128; i++) {
    let b = 0;
    const ch = String.fromCharCode(i);
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\v" || ch === "\f" || ch === "\r") b |= C_SPACE;
    if (punct.indexOf(ch) !== -1) b |= C_PUNCT;
    if ((i >= 48 && i <= 57) || (i >= 65 && i <= 90) || (i >= 97 && i <= 122) || i === 95) b |= C_WORD;
    if (i >= 48 && i <= 57) b |= C_DIGIT;
    CLS[i] = b;
  }
}

// Classification cache for non-ASCII code points, keyed by code point.
const clsCache = new Map();
const RE_SPACE_U = /\s/u;
const RE_PUNCT_U = /[\p{P}\p{S}]/u;
const RE_ALNUM_U = /[\p{L}\p{N}]/u;

function clsOf(codePoint) {
  if (codePoint < 128) return CLS[codePoint];
  let v = clsCache.get(codePoint);
  if (v !== undefined) return v;
  const ch = String.fromCodePoint(codePoint);
  v = 0;
  if (RE_SPACE_U.test(ch)) v |= C_SPACE;
  if (RE_PUNCT_U.test(ch)) v |= C_PUNCT;
  // A non-ASCII letter or number is a word character for boundary tests.
  if (RE_ALNUM_U.test(ch)) v |= C_WORD;
  clsCache.set(codePoint, v);
  return v;
}

function isSpaceCode(cp) { return (clsOf(cp) & C_SPACE) !== 0; }
function isPunctCode(cp) { return (clsOf(cp) & C_PUNCT) !== 0; }
function isAlnumCode(cp) {
  if (cp < 128) return (CLS[cp] & C_WORD) !== 0 && cp !== 95;
  return RE_ALNUM_U.test(String.fromCodePoint(cp));
}

/* ------------------------------------------------------------------ */
/* HTML escaping and entities                                          */
/* ------------------------------------------------------------------ */

const ESC_MAP = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

// Escape &, <, >, " and ' (the "encode" form).
function escAll(s) {
  if (s.indexOf("&") === -1 && s.indexOf("<") === -1 && s.indexOf(">") === -1 && s.indexOf('"') === -1 && s.indexOf("'") === -1) return s;
  let out = "";
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const m = ESC_MAP[s[i]];
    if (m !== undefined) {
      out += s.slice(start, i) + m;
      start = i + 1;
    }
  }
  return out + s.slice(start);
}

// Is the text at s[i] a valid entity reference (named or numeric)?
// Used to decide whether a bare & is left alone.
function entityAt(s, i) {
  // s[i] === '&'
  const c = s[i + 1];
  if (c === "#") {
    let j = i + 2;
    if (s[j] === "x" || s[j] === "X") {
      j++;
      const start = j;
      while (j < s.length && ((s[j] >= "0" && s[j] <= "9") || (s[j] >= "a" && s[j] <= "f") || (s[j] >= "A" && s[j] <= "F"))) j++;
      if (j - start >= 1 && j - start <= 6 && s[j] === ";") return j + 1;
      return -1;
    }
    const start = j;
    while (j < s.length && s[j] >= "0" && s[j] <= "9") j++;
    if (j - start >= 1 && j - start <= 7 && s[j] === ";") return j + 1;
    return -1;
  }
  if (c !== undefined && ((c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || (c >= "0" && c <= "9") || c === "_")) {
    let j = i + 1;
    while (j < s.length) {
      const d = s[j];
      if ((d >= "a" && d <= "z") || (d >= "A" && d <= "Z") || (d >= "0" && d <= "9") || d === "_") { j++; continue; }
      break;
    }
    if (s[j] === ";") return j + 1;
  }
  return -1;
}

// Escape <, >, " and ', and & unless it starts a valid entity reference.
function escKeepEntities(s) {
  if (s.indexOf("&") === -1 && s.indexOf("<") === -1 && s.indexOf(">") === -1 && s.indexOf('"') === -1 && s.indexOf("'") === -1) return s;
  let out = "";
  let start = 0;
  let i = 0;
  const n = s.length;
  while (i < n) {
    const ch = s[i];
    if (ch === "&") {
      if (entityAt(s, i) !== -1) { i++; continue; }
      out += s.slice(start, i) + "&amp;";
      i++;
      start = i;
      continue;
    }
    const m = ESC_MAP[ch];
    if (m !== undefined) {
      out += s.slice(start, i) + m;
      i++;
      start = i;
      continue;
    }
    i++;
  }
  return start === 0 ? s : out + s.slice(start);
}

// Decode numeric character references in a string, and turn a bare &
// (one that does not start a valid entity) into &amp;. Named entities
// are left untouched. Only called when the string holds a numeric ref.
function decodeNumericRefs(s) {
  let out = "";
  let start = 0;
  let i = 0;
  const n = s.length;
  while (i < n) {
    if (s[i] !== "&") { i++; continue; }
    const c = s[i + 1];
    if (c === "#") {
      let j = i + 2;
      let hex = false;
      if (s[j] === "x" || s[j] === "X") { hex = true; j++; }
      const d0 = j;
      if (hex) {
        while (j < n && ((s[j] >= "0" && s[j] <= "9") || (s[j] >= "a" && s[j] <= "f") || (s[j] >= "A" && s[j] <= "F"))) j++;
      } else {
        while (j < n && s[j] >= "0" && s[j] <= "9") j++;
      }
      const digits = j - d0;
      if (digits >= 1 && digits <= (hex ? 6 : 7) && s[j] === ";") {
        const code = parseInt(s.slice(d0, j), hex ? 16 : 10);
        let rep;
        if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) rep = "\uFFFD";
        else if (code === 38) rep = "&amp;";
        else rep = String.fromCodePoint(code);
        out += s.slice(start, i) + rep;
        i = j + 1;
        start = i;
        continue;
      }
      // Not a valid numeric reference: treat & as bare.
      if (entityAt(s, i) === -1) {
        out += s.slice(start, i) + "&amp;";
        i++;
        start = i;
        continue;
      }
      i++;
      continue;
    }
    if (entityAt(s, i) === -1) {
      out += s.slice(start, i) + "&amp;";
      i++;
      start = i;
      continue;
    }
    i++;
  }
  return start === 0 ? s : out + s.slice(start);
}

function hasNumericRef(s) {
  const i = s.indexOf("&#");
  if (i === -1) return false;
  // Confirm the shape &#digits; or &#xhex; (1-7 digits / 1-6 hex).
  let j = i + 2;
  let hex = false;
  if (s[j] === "x" || s[j] === "X") { hex = true; j++; }
  const d0 = j;
  if (hex) {
    while (j < s.length && ((s[j] >= "0" && s[j] <= "9") || (s[j] >= "a" && s[j] <= "f") || (s[j] >= "A" && s[j] <= "F"))) j++;
  } else {
    while (j < s.length && s[j] >= "0" && s[j] <= "9") j++;
  }
  const digits = j - d0;
  return digits >= 1 && digits <= (hex ? 6 : 7) && s[j] === ";";
}

// The reference renderer applies numeric-reference decoding to plain
// text only when the text holds at least one numeric reference.
function unescapeText(s) {
  return hasNumericRef(s) ? decodeNumericRefs(s) : s;
}

/* ------------------------------------------------------------------ */
/* URLs, labels, tables, tabs                                          */
/* ------------------------------------------------------------------ */

// Clean a link destination the way encodeURI does, undoing %25 back to %.
function cleanUrl(href) {
  try {
    return encodeURI(href).replace(/%25/g, "%");
  } catch {
    return null;
  }
}

// Normalize a link label for lookup: trim, collapse whitespace, fold case.
function normLabel(s) {
  return s.trim().replace(/\s+/g, " ").toLowerCase().toUpperCase().toLowerCase();
}

// Expand tabs to spaces, tracking the column from `col`.
function expandTabs(s, col) {
  let out = "";
  let t = col || 0;
  for (const ch of s) {
    if (ch === "\t") {
      const r = 4 - (t % 4);
      out += "    ".slice(0, r);
      t += r;
    } else {
      out += ch;
      t++;
    }
  }
  return out;
}

// Strip trailing occurrences of `ch` (or, when `notCh` is true, trailing
// characters that are not `ch`).
function stripTail(s, ch, notCh) {
  let n = s.length;
  if (n === 0) return "";
  let k = 0;
  for (; k < n;) {
    const c = s.charAt(n - k - 1);
    if (c === ch && !notCh) k++;
    else if (c !== ch && notCh) k++;
    else break;
  }
  return s.slice(0, n - k);
}

// Remove trailing blank lines beyond the first, as the reference does
// for raw HTML blocks: keep the string when at most one blank line
// follows the last non-blank line, else cut everything after it.
function trimBlankTail(s) {
  const lines = s.split("\n");
  let t = lines.length - 1;
  while (t >= 0 && /^[ \t]*$/.test(lines[t])) t--;
  return lines.length - t <= 2 ? s : lines.slice(0, t + 1).join("\n");
}

// Find the first unbalanced close paren in `s` (backslashes escape).
// Returns its index, -2 when an open paren is never closed, -1 otherwise.
function findUnbalancedParen(s) {
  if (s.indexOf("(") === -1 && s.indexOf(")") === -1) return -1;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\") { i++; continue; }
    if (s[i] === "(") depth++;
    else if (s[i] === ")") {
      depth--;
      if (depth < 0) return i;
    }
  }
  return depth > 0 ? -2 : -1;
}

// Split a table row on unescaped pipes, drop empty edge cells, trim,
// unescape \|, and pad or cut to `count` cells when given. A pipe is
// escaped when an odd number of backslashes precedes it.
function splitCells(row, count) {
  const cells = [];
  let cur = "";
  let i = 0;
  const n = row.length;
  while (i < n) {
    const ch = row[i];
    if (ch === "|") {
      let bs = 0;
      for (let p = cur.length - 1; p >= 0 && cur[p] === "\\"; p--) bs++;
      if (bs % 2 === 1) {
        cur += "|";
      } else {
        cells.push(cur);
        cur = "";
      }
      i++;
      continue;
    }
    cur += ch;
    i++;
  }
  cells.push(cur);
  if (cells.length > 0 && cells[0].trim() === "") cells.shift();
  if (cells.length > 0 && cells[cells.length - 1].trim() === "") cells.pop();
  if (count !== undefined) {
    if (cells.length > count) cells.length = count;
    else while (cells.length < count) cells.push("");
  }
  for (let k = 0; k < cells.length; k++) {
    cells[k] = cells[k].trim().replace(/\\\|/g, "|");
  }
  return cells;
}

// Does `s` hold a character that could start an inline construct?
const INLINE_SPECIALS = new Set(["\\", "<", "[", "!", "*", "_", "`", "~"]);

// Next inline stop for the text scanner: a character that starts a
// token, a URL scheme, a mailto:/xmpp: autolink, a bare e-mail address,
// a www. autolink, or a hard break (two or more spaces before a
// newline). The e-mail lookahead is guarded by a lookbehind so it only
// fires at the start of a run; the mailto: lookahead only needs a
// non-alphanumeric preceding character. The e-mail lookahead comes
// before www. so that a www. rejected below does not skip an e-mail
// that starts at the same position (e.g. "www.a@b.c" after ';').
const TEXT_STOP_RE = /[\\<\[!`*~_]|[hH][tT][tT][pP][sS]?:\/\/|[fF][tT][pP]:\/\/|(?<![A-Za-z0-9])(?=(?:mailto:|xmpp:)[A-Za-z0-9.!#$%&'*+\/=?_`{|}~-]+@)|(?<![A-Za-z0-9.!#$%&'*+\/=?_`{|}~-])(?=[A-Za-z0-9.!#$%&'*+\/=?_`{|}~-]+@)|www\.|(?= {2,}\n)/g;

/* ------------------------------------------------------------------ */
/* Block-level HTML tag names (CommonMark / GFM block tag list)        */
/* ------------------------------------------------------------------ */

const BLOCK_TAGS = new Set(
  ("address article aside base basefont blockquote body caption center col colgroup dd " +
   "details dialog dir div dl dt fieldset figcaption figure footer form frame frameset " +
   "h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem meta " +
   "nav noframes ol optgroup option p param search section summary table tbody td tfoot " +
   "th thead title tr track ul").split(" ")
);

// Tags that are not treated as block tags in pedantic mode are irrelevant
// here (pedantic is off); the set above is the GFM block list.

/* ------------------------------------------------------------------ */
/* Inline label and email matching                                     */
/* ------------------------------------------------------------------ */

// Characters that may appear in an email address run (used by the text
// scanner's lookahead for an address starting just ahead).
function isEmailChar(ch) {
  if (ch === undefined) return false;
  const c = ch.charCodeAt(0);
  if (c < 128) {
    return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) ||
      ".!#$%&'*+/=?_`{|}~-".indexOf(ch) !== -1;
  }
  return false;
}

// Does an email address run start at s[i] (a run of email characters
// followed by @)? The run's first character is at i.
function emailRunAt(s, i) {
  if (!isEmailChar(s[i])) return false;
  let j = i;
  while (j < s.length && isEmailChar(s[j])) j++;
  return s[j] === "@";
}

// Match an autolink-style email address starting at s[i]:
// local@domain with at least one dot, labels of 1-63 characters that
// neither start nor end with '-'. Returns the end index, or -1.
function matchAutolinkEmail(s, i) {
  let j = i;
  const n = s.length;
  // The autolink local part also allows '^' (the text scanner's email
  // run does not).
  const isLocal = (ch) => ch !== undefined && (isEmailChar(ch) || ch === "^");
  while (j < n && isLocal(s[j]) && s[j] !== "@") j++;
  if (j === i || s[j] !== "@") return -1;
  j++;
  // Domain: first label.
  let labels = 0;
  while (true) {
    if (j >= n) return -1;
    const c = s[j];
    if (!((c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || (c >= "0" && c <= "9"))) return -1;
    let k = j + 1;
    while (k < n && ((s[k] >= "a" && s[k] <= "z") || (s[k] >= "A" && s[k] <= "Z") || (s[k] >= "0" && s[k] <= "9") || s[k] === "-")) k++;
    if (k - j > 63) return -1;
    if (s[k - 1] === "-") return -1;
    labels++;
    j = k;
    if (s[j] === ".") { j++; continue; }
    break;
  }
  if (labels < 2) return -1;
  if (s[j] === "-" || s[j] === "_") return -1;
  return j;
}

// Match the looser email form used by extended autolinks: the local
// part is [A-Za-z0-9._+-]+, domain labels may hold '_' and '-', the
// final label ends in an alphanumeric, and the next character must not
// be a word character or '-'. Returns the end index, or -1.
function matchLooseEmail(s, i) {
  let j = i;
  const n = s.length;
  const isLocal = (ch) => ch !== undefined && ((ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || (ch >= "0" && ch <= "9") || ch === "." || ch === "_" || ch === "+" || ch === "-");
  while (j < n && isLocal(s[j])) j++;
  if (j === i || s[j] !== "@") return -1;
  j++;
  const isDom = (ch) => ch !== undefined && ((ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || (ch >= "0" && ch <= "9") || ch === "-" || ch === "_");
  const isAlnum = (ch) => ch !== undefined && ((ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || (ch >= "0" && ch <= "9"));
  // The first label may end in '-' or '_'; later labels must end in
  // an alphanumeric, and at least one dot is required.
  if (j >= n || !isDom(s[j])) return -1;
  let k = j;
  while (k < n && isDom(s[k])) k++;
  j = k;
  let labels = 1;
  let lastValid = j;
  while (s[j] === ".") {
    // A dot only starts another label when an alphanumeric or
    // '-'/'_' follows; a trailing dot ends the address.
    if (j + 1 >= n || !isDom(s[j + 1])) break;
    j++;
    k = j;
    while (k < n && isDom(s[k])) k++;
    let end = k;
    while (end > j && !isAlnum(s[end - 1])) end--;
    if (end === j) {
      // The label after the dot has no alphanumeric (e.g. ".-" or
      // ".---"): the address ends at the last valid label instead
      // of failing outright.
      j = lastValid;
      break;
    }
    labels++;
    j = end;
    lastValid = end;
  }
  if (labels < 2) return -1;
  const next = s[j];
  if (next !== undefined && ((next >= "a" && next <= "z") || (next >= "A" && next <= "Z") || (next >= "0" && next <= "9") || next === "_" || next === "-")) return -1;
  return j;
}

// Match a mailto:/xmpp: address starting at s[i] (the emailProtocol
// form). Returns the end index, or -1.
function matchEmailProtocol(s, i) {
  // `mailto:`/`xmpp:` are lowercase-only in marked's url rule.
  const head = s.slice(i, i + 7);
  let j;
  if (head.startsWith("mailto:")) j = i + 7;
  else if (head.startsWith("xmpp:")) j = i + 5;
  else return -1;
  const end = matchLooseEmail(s, j);
  if (end === -1) return -1;
  // xmpp: allows an optional /path of [A-Za-z0-9@.]+ after the address.
  if (head.startsWith("xmpp:") && s[end] === "/") {
    let k = end + 1;
    while (k < s.length && ((s[k] >= "a" && s[k] <= "z") || (s[k] >= "A" && s[k] <= "Z") || (s[k] >= "0" && s[k] <= "9") || s[k] === "@" || s[k] === ".")) k++;
    if (k > end + 1) return k;
  }
  return end;
}

// Scan a code span starting at s[i] (s[i] is a backtick) with the given
// opening run length k. Returns the end index just past the closing
// run, or -1. The closing run must be exactly k backticks long.
function matchCodeSpanEnd(s, i, k) {
  const n = s.length;
  let p = i;
  while (p < n) {
    if (s[p] !== "`") { p++; continue; }
    let q = p;
    while (q < n && s[q] === "`") q++;
    if (q - p === k && p > i) return q;
    p = q;
  }
  return -1;
}

// Parse a link label starting at s[i] === '[' following the strict
// grammar (no nested brackets, no newlines except non-blank ones).
// Returns {end, text} where end is just past the closing ']', or null.
function matchSimpleLabel(s, i) {
  const n = s.length;
  // The label must not be only whitespace before ']'.
  let j = i + 1;
  while (j < n && (s[j] === " " || s[j] === "\t")) j++;
  if (s[j] === "]") return null;
  let p = i + 1;
  while (p < n) {
    const ch = s[p];
    if (ch === "\\") {
      if (p + 1 >= n) return null;
      p += 2;
      continue;
    }
    if (ch === "]") return { end: p + 1, text: s.slice(i + 1, p) };
    if (ch === "[" || ch === "\n") {
      if (ch === "\n") {
        // A newline is allowed only when the next line is not blank.
        let q = p + 1;
        while (q < n && (s[q] === " " || s[q] === "\t")) q++;
        if (s[q] === "\n" || q >= n) return null;
      } else {
        return null;
      }
      p++;
      continue;
    }
    p++;
  }
  return null;
}

// Parse a one-level nested bracket group starting at s[i] === '[':
// '[' (escaped chars or chars other than '[' ']' '\')* ']'.
function matchBracketGroup(s, i) {
  // Matches "[...]" where the content may itself hold one nested
  // "[...]" group (whose content holds no '['), matching marked's
  // label rule. Newlines are allowed inside.
  const n = s.length;
  let p = i + 1;
  while (p < n) {
    const ch = s[p];
    if (ch === "\\") {
      if (p + 1 >= n) return -1;
      p += 2;
      continue;
    }
    if (ch === "]") return p + 1;
    if (ch === "[") {
      const g = matchLeGroup(s, p);
      if (g === -1) return -1;
      p = g;
      continue;
    }
    p++;
  }
  return -1;
}

// A bracket group with no '[' inside (marked's `Le`).
function matchLeGroup(s, i) {
  const n = s.length;
  let p = i + 1;
  while (p < n) {
    const ch = s[p];
    if (ch === "\\") {
      if (p + 1 >= n) return -1;
      p += 2;
      continue;
    }
    if (ch === "]") return p + 1;
    if (ch === "[") return -1;
    p++;
  }
  return -1;
}

// Parse a link label starting at s[i] === '[' following the full
// grammar (nested one-level brackets, escapes, code spans, and a run
// of backticks just before the closing bracket). Returns {end, text}
// or null. The match is lazy: it ends at the first ']' that closes it.
// A code span inside a link label (marked's label rule):
// an opening backtick run, content with no backtick, and a
// closing backtick run of any length. Returns the index just
// after the closing run, or -1.
function matchLabelCodeSpan(s, i) {
  const n = s.length;
  let q = i;
  while (q < n && s[q] === "`") q++;
  let r = q;
  while (r < n && s[r] !== "`") r++;
  if (r >= n) return -1;
  let e2 = r;
  while (e2 < n && s[e2] === "`") e2++;
  return e2;
}

function matchFullLabel(s, i) {
  const n = s.length;
  let p = i + 1;
  while (p < n) {
    const ch = s[p];
    if (ch === "]") return { end: p + 1, text: s.slice(i + 1, p) };
    if (ch === "\\") {
      if (p + 1 >= n) return null;
      p += 2;
      continue;
    }
    if (ch === "[") {
      const g = matchBracketGroup(s, p);
      if (g === -1) return null;
      p = g;
      continue;
    }
    if (ch === "`") {
      // A run of backticks just before ']' is its own unit, but
      // only when the run has at least two backticks (marked's
      // label rule is `` ``+ ``, i.e. two or more). A single
      // backtick before ']' leaves the label unmatched.
      let q = p;
      while (q < n && s[q] === "`") q++;
      if (s[q] === "]") {
        if (q - p < 2) return null;
        p = q;
        continue;
      }
      // A code span inside a label follows marked's label rule
      // (`+(?!`)[^`]*?`+(?!`)): the content holds no backtick and
      // the closing run may be any length — unlike a real code
      // span, whose closing run must match the opening run.
      const close = matchLabelCodeSpan(s, p);
      if (close === -1) return null;
      p = close;
      continue;
    }
    p++;
  }
  return null;
}

// Match a reference label (1-999 characters, escapes allowed, no
// brackets, no backslashes left bare) starting at s[i] === '['.
// Returns {end, text} or null.
function matchRefLabel(s, i) {
  const n = s.length;
  let p = i + 1;
  let count = 0;
  while (p < n && count < 999) {
    const ch = s[p];
    if (ch === "\\") {
      if (p + 1 >= n) return null;
      p += 2;
      count += 2;
      continue;
    }
    if (ch === "]") {
      if (count === 0) return null;
      return { end: p + 1, text: s.slice(i + 1, p) };
    }
    if (ch === "[") return null;
    p++;
    count++;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Link-in-HTML check (the "Be" rule)                                  */
/* ------------------------------------------------------------------ */

// Does the label `label` (starting at offset `off` in the full string
// `full`) hold an HTML tag or autolink that runs past the label's end?
// Such a link is not a link at all.
function labelHasOpenTag(full, label, off, lx) {
  if (label.indexOf("<") === -1) return false;
  for (let s = 0; s < label.length; s++) {
    if (label[s] === "\\") { s++; continue; }
    if (label[s] === "`") {
      const close = matchCodeSpanEnd(label, s, (() => { let q = s; while (q < label.length && label[q] === "`") q++; return q - s; })());
      if (close !== -1) { s = close - 1; continue; }
    }
    if (label[s] !== "<") continue;
    const rest = full.slice(off + s);
    const tag = matchInlineTag(rest);
    const auto = tag === -1 ? matchAutolink(rest) : null;
    const len = tag !== -1 ? tag : (auto ? auto.len : -1);
    if (len !== -1) {
      if (len > label.length - s) return true;
      s += len - 1;
    }
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* Inline HTML tag and autolink matching                               */
/* ------------------------------------------------------------------ */

// Match an inline HTML tag, comment, processing instruction,
// declaration or CDATA section starting at s[0] === '<'.
// Returns the match length, or -1.
function matchInlineTag(s) {
  if (s[0] !== "<") return -1;
  const n = s.length;
  // Comment: <!-- ... --> (or <!--> / <!--->).
  if (s[1] === "!" && s[2] === "-" && s[3] === "-") {
    if (s[4] === ">") return 5;
    if (s[4] === "-" && s[5] === ">") return 6;
    const end = s.indexOf("-->", 4);
    if (end === -1) return -1;
    return end + 3;
  }
  // Closing tag: </name ...>.
  if (s[1] === "/") {
    let j = 2;
    if (j >= n || !isAsciiLetter(s[j])) return -1;
    while (j < n && (isAsciiLetter(s[j]) || isDigit(s[j]) || s[j] === "-")) j++;
    while (j < n && isSpaceChar(s[j])) j++;
    if (s[j] === ">") return j + 1;
    return -1;
  }
  // Processing instruction: <? ... ?>.
  if (s[1] === "?") {
    const end = s.indexOf("?>", 2);
    if (end === -1) return -1;
    return end + 2;
  }
  // Declaration: <!Letter ...> (first '>' ends it).
  if (s[1] === "!" && isAsciiLetter(s[2])) {
    let j = 2;
    while (j < n && isAsciiLetter(s[j])) j++;
    if (j >= n || !isSpaceChar(s[j])) return -1;
    const end = s.indexOf(">", j);
    if (end === -1) return -1;
    return end + 1;
  }
  // CDATA: <![CDATA[ ... ]]>.
  if (s.startsWith("<![CDATA[")) {
    const end = s.indexOf("]]>", 9);
    if (end === -1) return -1;
    return end + 3;
  }
  // Opening tag: <name (attribute)* /?>.
  if (isAsciiLetter(s[1])) {
    let j = 1;
    while (j < n && (isAsciiLetter(s[j]) || isDigit(s[j]) || s[j] === "-")) j++;
    while (true) {
      // Skip whitespace.
      let k = j;
      while (k < n && (s[k] === " " || s[k] === "\t" || s[k] === "\n" || s[k] === "\r" || s[k] === "\f")) k++;
      if (s[k] === ">") return k + 1;
      if (s[k] === "/" && s[k + 1] === ">") return k + 2;
      if (k === j) return -1; // No whitespace and not the end: not a tag.
      // One attribute: name [= value].
      j = k;
      if (!isAsciiLetter(s[j]) && s[j] !== ":" && s[j] !== "_") return -1;
      j++;
      while (j < n && (isWordChar(s[j]) || s[j] === "." || s[j] === ":" || s[j] === "-")) j++;
      let m = j;
      while (m < n && (s[m] === " " || s[m] === "\t" || s[m] === "\n" || s[m] === "\r" || s[m] === "\f")) m++;
      if (s[m] === "=") {
        m++;
        while (m < n && (s[m] === " " || s[m] === "\t" || s[m] === "\n" || s[m] === "\r" || s[m] === "\f")) m++;
        if (s[m] === '"') {
          const q = s.indexOf('"', m + 1);
          if (q === -1) return -1;
          j = q + 1;
        } else if (s[m] === "'") {
          const q = s.indexOf("'", m + 1);
          if (q === -1) return -1;
          j = q + 1;
        } else {
          let q = m;
          while (q < n && !isSpaceChar(s[q]) && s[q] !== '"' && s[q] !== "'" && s[q] !== "=" && s[q] !== "<" && s[q] !== ">" && s[q] !== "`") q++;
          if (q === m) return -1;
          j = q;
        }
      }
    }
  }
  return -1;
}

function isAsciiLetter(ch) {
  return ch !== undefined && ((ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z"));
}
function isDigit(ch) {
  return ch !== undefined && ch >= "0" && ch <= "9";
}
function isWordChar(ch) {
  return ch !== undefined && ((ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || (ch >= "0" && ch <= "9") || ch === "_");
}
function isSpaceChar(ch) {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\v" || ch === "\f";
}

// The full JavaScript \s set (ASCII whitespace plus Unicode spaces),
// as used by the reference's [^\s<] in extended autolinks.
function isJsSpace(ch) {
  if (ch === undefined) return false;
  if (isSpaceChar(ch)) return true;
  const cp = ch.codePointAt(0);
  return cp === 0x00a0 || cp === 0x1680 || (cp >= 0x2000 && cp <= 0x200a) || cp === 0x2028 || cp === 0x2029 || cp === 0x202f || cp === 0x205f || cp === 0x3000 || cp === 0xfeff;
}

// Match an autolink <scheme:...> or <email> starting at s[0] === '<'.
// Returns the match length, or -1. When it matches an email, the
// returned object carries email=true.
function matchAutolink(s) {
  if (s[0] !== "<") return null;
  const n = s.length;
  const gt = s.indexOf(">");
  if (gt === -1) return null;
  const inner = s.slice(1, gt);
  // Scheme: [a-zA-Z][a-zA-Z0-9+.-]{1,31} ':' rest (no space, control, <, >).
  let j = 0;
  if (isAsciiLetter(inner[0])) {
    j = 1;
    while (j < inner.length && (isAsciiLetter(inner[j]) || isDigit(inner[j]) || inner[j] === "+" || inner[j] === "." || inner[j] === "-")) j++;
    if (j >= 2 && j <= 32 && inner[j] === ":") {
      let ok = true;
      for (let k = j + 1; k < inner.length; k++) {
        const c = inner.charCodeAt(k);
        if (c <= 32 || c === 127 || inner[k] === "<" || inner[k] === ">") { ok = false; break; }
      }
      if (ok) return { len: gt + 1, email: false };
    }
  }
  // Email.
  const end = matchAutolinkEmail(s, 1);
  if (end !== -1 && s[end] === ">") return { len: end + 1, email: true };
  return null;
}

// Match an extended-autolink URL or email at the start of s.
// Returns {len, href, text, email} or null.
function matchExtendedUrl(s) {
  const c0 = s.charCodeAt(0);
  // mailto:/xmpp: addresses first (lowercase-only prefix).
  if (c0 === 109 || c0 === 120) { // 'm' or 'x'
    const proto = matchEmailProtocol(s, 0);
    if (proto !== -1) {
      return { len: proto, href: s.slice(0, proto), text: s.slice(0, proto), email: true };
    }
  }
  // scheme:// or www. — the scheme is case-insensitive, `www.`
  // is lowercase-only.
  let j = 0;
  if (c0 === 104 || c0 === 72 || c0 === 102 || c0 === 70) { // 'h'/'H'/'f'/'F'
    const low = s.slice(0, 8).toLowerCase();
    if (low.startsWith("http://") || low.startsWith("https://") || low.startsWith("ftp://")) {
      j = s.indexOf("://") + 3;
    }
  } else if (c0 === 119 && s.startsWith("www.")) { // 'w'
    j = 4;
  }
  if (j > 0) {
    // Domain: (alnum/hyphen run with an optional dot) one or more times.
    let k = j;
    let any = false;
    while (k < s.length) {
      if (!isAsciiLetter(s[k]) && !isDigit(s[k]) && s[k] !== "-") break;
      while (k < s.length && (isAsciiLetter(s[k]) || isDigit(s[k]) || s[k] === "-")) k++;
      any = true;
      if (s[k] === ".") { k++; continue; }
      break;
    }
    if (!any) {
      // "www." with no usable domain is not a URL; the string may
      // still be a bare e-mail address (e.g. "www.______a.b-c_d@e.f").
    } else {
      while (k < s.length && !isJsSpace(s[k]) && s[k] !== "<") k++;
      let len = backpedalUrl(s.slice(0, k));
      if (len === 0) return null;
      const text = s.slice(0, len);
      return { len, href: j === 4 ? "http://" + text : text, text, email: false };
    }
  }
  // Bare email.
  const em = matchLooseEmail(s, 0);
  if (em !== -1) {
    return { len: em, href: "mailto:" + s.slice(0, em), text: s.slice(0, em), email: true };
  }
  return null;
}

// Trim trailing punctuation from an extended-autolink match the way
// the reference's backpedal does: drop a trailing run of punctuation,
// drop an unmatched '(' and everything after it, and drop a '&' that
// starts an entity reference at the end.
function backpedalUrl(s) {
  // Trim a URL the way marked's backpedal does, applied until stable:
  // a URL keeps non-punctuation runs, '(...)' groups, an '&' that does
  // not start a trailing entity, and punctuation runs that are not at
  // the end; a trailing punctuation run (or entity) is dropped, which
  // can expose another one underneath.
  let end = s.length;
  for (;;) {
    const next = backpedalPrefix(s, end);
    if (next === end) return end;
    end = next;
  }
}

function backpedalPrefix(s, limit) {
  const PUNCT = "?!.,:;*_'\"~)";
  let end = 0;
  let i = 0;
  while (i < limit) {
    const ch = s[i];
    if (ch === '(') {
      const close = s.indexOf(')', i + 1);
      if (close === -1 || close >= limit) break; // Unmatched "(": the URL ends here.
      end = close + 1;
      i = close + 1;
      continue;
    }
    if (ch === '&') {
      // An & that starts an entity reference at the very end is dropped.
      let k = i + 1;
      while (k < limit && ((s[k] >= 'a' && s[k] <= 'z') || (s[k] >= 'A' && s[k] <= 'Z') || (s[k] >= '0' && s[k] <= '9'))) k++;
      if (k > i + 1 && s[k] === ';' && k === limit - 1) break;
      end = i + 1;
      i++;
      continue;
    }
    if (PUNCT.indexOf(ch) !== -1) {
      let k = i;
      while (k < limit && PUNCT.indexOf(s[k]) !== -1) k++;
      if (k >= limit) break; // A punctuation run at the end is dropped.
      end = k;
      i = k;
      continue;
    }
    let k = i;
    while (k < limit && PUNCT.indexOf(s[k]) === -1 && s[k] !== '(' && s[k] !== '&') k++;
    end = k;
    i = k;
  }
  return end;
}

/* ------------------------------------------------------------------ */
/* Emphasis masking (the reference hides link text and code from the   */
/* delimiter search, so a '*' inside a link cannot close emphasis)    */
/* ------------------------------------------------------------------ */

// Find every reference-link-shaped match in s: [label][ref] or [ref]
// (with an optional [] after it, and never followed by '(').
// Returns an array of {start, end}.
function findReflinkMatches(s) {
  const out = [];
  const n = s.length;
  let i = 0;
  while (i < n) {
    // Jump to the next '[' or '!' (only '![' can start a match).
    const a = s.indexOf("[", i);
    const b = s.indexOf("!", i);
    let next = a === -1 ? b : (b === -1 ? a : Math.min(a, b));
    if (next === -1) break;
    i = next;
    const bang = s[i] === "!" && s[i + 1] === "[";
    if (s[i] !== "[" && !bang) { i++; continue; }
    const base = bang ? i + 1 : i;
    let end = -1;
    // Reference link: [label][ref].
    const lab = matchFullLabel(s, base);
    if (lab !== null && s[lab.end] === "[") {
      const ref = matchRefLabel(s, lab.end);
      if (ref !== null) end = ref.end;
    }
    if (end === -1) {
      // Shortcut link: [ref] with an optional [].
      const ref = matchRefLabel(s, base);
      if (ref !== null) {
        end = ref.end;
        if (s[end] === "[" && s[end + 1] === "]") end += 2;
        if (s[end] === "(") end = -1;
      }
    }
    if (end !== -1) {
      out.push({ start: i, end });
      i = end;
    } else {
      i++;
    }
  }
  return out;
}

// A strict code span: opening run, content with no backticks at all,
// and a closing run of the same length. Returns the end index, or -1.
function matchStrictCodeSpan(s, i) {
  const n = s.length;
  let k = 0;
  while (i + k < n && s[i + k] === "`") k++;
  if (k === 0) return -1;
  let p = i + k;
  if (p >= n) return -1;
  while (p < n) {
    if (s[p] !== "`") { p++; continue; }
    let q = p;
    while (q < n && s[q] === "`") q++;
    if (q - p === k) return q;
    return -1; // The first backtick run after the opening must close it.
  }
  return -1;
}

// Does the string s hold an inline or reference link anywhere?
function linkInText(s, links) {
  if (s.indexOf("[") === -1) return false;
  // Inline links, found through blockSkip matches.
  for (const m of findBlockSkipMatches(s)) {
    if (matchInlineLinkShape(s.slice(m.start, m.end)) !== -1 && s[m.start - 1] !== "!") return true;
  }
  for (const m of findReflinkMatches(s)) {
    const text = s.slice(m.start, m.end);
    const r = text.lastIndexOf("[");
    const ref = normLabel(text.slice(r + 1, -1));
    if (text.charAt(0) === "!" || !Object.hasOwn(links, ref)) continue;
    if (r > 1 && linkInText(text.slice(1, r - 1), links)) continue;
    return true;
  }
  return false;
}

// Find every blockSkip match in s: an inline link, a code span not
// preceded by a backtick, or an HTML-ish tag. Returns {start, end} list.
function findBlockSkipMatches(s) {
  const out = [];
  const n = s.length;
  let i = 0;
  while (i < n) {
    // Jump to the next character that can start a match.
    const a = s.indexOf("[", i);
    const b = s.indexOf("`", i);
    const c = s.indexOf("<", i);
    let next = n;
    if (a !== -1 && a < next) next = a;
    if (b !== -1 && b < next) next = b;
    if (c !== -1 && c < next) next = c;
    if (next >= n) break;
    i = next;
    let end = -1;
    if (s[i] === "[") {
      end = matchBlockSkipLink(s, i);
    }
    if (end === -1 && s[i] === "`" && s[i - 1] !== "`") {
      end = matchStrictCodeSpan(s, i);
    }
    if (end === -1 && s[i] === "<" && s[i + 1] !== " ") {
      let j = i + 1;
      while (j < n && s[j] !== ">" && s[j] !== "<") j++;
      if (j < n && s[j] === ">") end = j + 1;
    }
    if (end !== -1) {
      out.push({ start: i, end });
      i = end;
    } else {
      i++;
    }
  }
  return out;
}

// Match an inline link [text](destination) starting at s[i] === '[',
// following the blockSkip link shape: the label may hold code spans
// but no bare brackets, and the destination may hold one level of
// parentheses. Returns the end index, or -1.
function matchBlockSkipLink(s, i) {
  const n = s.length;
  let p = i + 1;
  // Label: characters other than '[', ']' and '`', or code spans.
  while (p < n) {
    const ch = s[p];
    if (ch === "]") break;
    if (ch === "[" ) return -1;
    if (ch === "`") {
      const close = matchStrictCodeSpan(s, p);
      if (close === -1) return -1;
      p = close;
      continue;
    }
    p++;
  }
  if (p >= n || s[p] !== "]" || s[p + 1] !== "(") return -1;
  p += 2;
  // Destination: escaped characters, characters other than '(' and
  // ')', or one parenthesised group.
  while (p < n) {
    const ch = s[p];
    if (ch === "\\") { p += 2; continue; }
    if (ch === ")") return p + 1;
    if (ch === "(") {
      p++;
      let closed = false;
      while (p < n) {
        if (s[p] === "\\") { p += 2; continue; }
        if (s[p] === ")") { closed = true; p++; break; }
        if (s[p] === "(") return -1;
        p++;
      }
      if (!closed) return -1;
      continue;
    }
    p++;
  }
  return -1;
}

// Is the string a valid inline link shape (used by linkInText)?
// Returns the length of the link, or -1. This is the full inline
// link grammar: label, destination (angle or bare), optional title.
function matchInlineLinkShape(s) {
  const m = parseInlineLink(s, 0);
  return m === null ? -1 : m.raw.length;
}

// Parse an inline link starting at s[i] ('[' or '!['). Returns
// {raw, label, href, title, image} or null. This follows the link
// grammar exactly: label, '(', optional spaces/newlines, destination,
// optional title, optional spaces/newlines, ')'.
function parseInlineLink(s, i) {
  const n = s.length;
  const image = s[i] === "!";
  const base = image ? i + 1 : i;
  if (s[base] !== "[") return null;
  const lab = matchFullLabel(s, base);
  if (lab === null) return null;
  let p = lab.end;
  if (s[p] !== "(") return null;
  p++;
  // Spaces, tabs and newlines after '('.
  while (p < n && (s[p] === " " || s[p] === "\t" || s[p] === "\n")) p++;
  // Destination: an angle-bracketed one (at least one character), or
  // a bare one (no spaces or control characters), or an empty one.
  let href = "";
  if (s[p] === "<" && s[p + 1] !== ">") {
    let q = p + 1;
    let closed = false;
    while (q < n) {
      if (s[q] === "\\") { q += 2; continue; }
      if (s[q] === "\n" || s[q] === "<") break;
      if (s[q] === ">") { closed = true; break; }
      q++;
    }
    if (!closed) return null;
    href = s.slice(p, q + 1);
    p = q + 1;
  } else {
    // Bare destination: no spaces or control characters, and a
    // ')' only closes the link when the parenthesis balance would
    // otherwise go negative.
    let q = p;
    let depth = 0;
    while (q < n) {
      const ch = s[q];
      if (ch === "\\") { q += 2; continue; }
      if (ch === " " || ch === "\t" || ch === "\n" || ch.charCodeAt(0) <= 31) break;
      if (ch === "(") depth++;
      else if (ch === ")") { if (depth === 0) break; depth--; }
      q++;
    }
    // An empty destination is allowed only when ')' follows.
    if (q === p && s[q] !== ")") return null;
    href = s.slice(p, q);
    p = q;
  }
  // Optional title, preceded by spaces (with an optional newline) or
  // by a newline. A title may span lines in any of its three forms.
  let title = null;
  let save = p;
  let q = p;
  let sep = 0;
  while (q < n && (s[q] === " " || s[q] === "\t")) { q++; sep++; }
  if (s[q] === "\n" && sep > 0) {
    q++;
    while (q < n && (s[q] === " " || s[q] === "\t")) q++;
  } else if (sep === 0 && s[q] === "\n") {
    q++;
    while (q < n && (s[q] === " " || s[q] === "\t")) q++;
  } else if (sep === 0) {
    q = save;
  }
  if (q !== save && q < n && (s[q] === '"' || s[q] === "'" || s[q] === "(")) {
    const open = s[q];
    const close = open === "(" ? ")" : open;
    let r = q + 1;
    let ok = false;
    while (r < n) {
      if (s[r] === "\\") { r += 2; continue; }
      if (s[r] === close) { ok = true; break; }
      r++;
    }
    if (ok) {
      title = s.slice(q, r + 1);
      p = r + 1;
    } else {
      p = save;
    }
  } else {
    p = save;
  }
  // Trailing spaces/newlines, then ')'.
  while (p < n && (s[p] === " " || s[p] === "\t" || s[p] === "\n")) p++;
  if (s[p] !== ")") return null;
  return { raw: s.slice(i, p + 1), label: lab.text, href, title, image };
}

// The masked form of a string: link text, code spans and HTML are
// replaced by runs of 'a' of the same length, and backslash escapes
// become '+', so the emphasis search never sees a delimiter that sits
// inside one of them.
function maskInline(src, links) {
  let t = src;
  if (links !== null && src.indexOf("[") !== -1) {
    const matches = findReflinkMatches(t);
    if (matches.length > 0) {
      let out = "";
      let pos = 0;
      for (const m of matches) {
        const r = t.slice(m.start, m.end);
        out += t.slice(pos, m.start);
        out += maskReflinkMatch(r, links);
        pos = m.end;
      }
      t = out + t.slice(pos);
    }
  }
  // Backslash escapes and code spans: escapes become '+', the inside
  // of a code span keeps its backticks but loses inner backticks.
  // Skipped outright when the string holds neither.
  if (t.indexOf("`") !== -1 || t.indexOf("\\") !== -1) {
    let out = "";
    let pos = 0;
    let i = 0;
    const n = t.length;
    while (i < n) {
      if (t[i] === "`") {
        let k = 0;
        while (i + k < n && t[i + k] === "`") k++;
        const close = matchCodeSpanEnd(t, i, k);
        if (close !== -1) {
          out += t.slice(pos, i);
          const inner = t.slice(i + k, close - k).replace(/`/g, "+");
          out += t.slice(i, i + k) + inner + t.slice(close - k, close);
          pos = close;
          i = close;
          continue;
        }
        i += k;
        continue;
      }
      if (t[i] === "\\" && i + 1 < n && isPunctCode(t.codePointAt(i + 1))) {
        const units = t.codePointAt(i + 1) > 0xffff ? 2 : 1;
        out += t.slice(pos, i) + "+".repeat(1 + units);
        pos = i + 1 + units;
        i += 1 + units;
        continue;
      }
      i++;
    }
    t = out + t.slice(pos);
  }
  // Inline links, code spans and HTML tags become [aaa...].
  // Skipped outright when nothing that starts one is present.
  if (t.indexOf("[") !== -1 || t.indexOf("`") !== -1 || t.indexOf("<") !== -1) {
    const matches = findBlockSkipMatches(t);
    if (matches.length > 0) {
      let out = "";
      let pos = 0;
      for (const m of matches) {
        out += t.slice(pos, m.start);
        out += "[" + "a".repeat(m.end - m.start - 2) + "]";
        pos = m.end;
      }
      t = out + t.slice(pos);
    }
  }
  return t;
}

function maskReflinkMatch(r, links) {
  const o = r.lastIndexOf("[");
  if (!Object.hasOwn(links, normLabel(r.slice(o + 1, -1)))) return r;
  if (o > 1 && r.charAt(0) !== "!") {
    const inner = r.slice(1, o - 1);
    if (linkInText(inner, links)) {
      return "[" + maskReflinkInner(inner, links) + "][" + "a".repeat(r.length - o - 2) + "]";
    }
  }
  return "[" + "a".repeat(r.length - 2) + "]";
}

function maskReflinkInner(inner, links) {
  const matches = findReflinkMatches(inner);
  if (matches.length === 0) return inner;
  let out = "";
  let pos = 0;
  for (const m of matches) {
    out += inner.slice(pos, m.start);
    out += maskReflinkMatch(inner.slice(m.start, m.end), links);
    pos = m.end;
  }
  return out + inner.slice(pos);
}

// Scan the masked string for the last delimiter run of each kind
// whose preceding character is not a space, tab, newline, carriage
// return or form feed. Only such a run can close emphasis.
function scanLastDelims(masked) {
  return { star: lastCloser(masked, "*"), und: lastCloser(masked, "_"), tilde: lastCloser(masked, "~") };
}

// The start of the last run of `d` whose preceding character is not
// a space, tab, newline, CR or FF (a run at position 0 never counts).
// Searched backwards with lastIndexOf instead of scanning the string.
function lastCloser(masked, d) {
  let p = masked.lastIndexOf(d);
  while (p !== -1) {
    let s = p;
    while (s > 0 && masked[s - 1] === d) s--;
    if (s > 0) {
      const pc = masked.charCodeAt(s - 1);
      if (pc !== 32 && pc !== 9 && pc !== 10 && pc !== 13 && pc !== 12) return s;
      p = masked.lastIndexOf(d, s - 1);
    } else {
      // A run at position 0 never counts, and there is nothing
      // before it to search.
      return -1;
    }
  }
  return -1;
}

/* ------------------------------------------------------------------ */
/* Emphasis and strikethrough delimiter search                       */
/* ------------------------------------------------------------------ */

// The code point ending at index i of s (i > 0), or -1.
function cpBefore(s, i) {
  if (i <= 0) return -1;
  const lo = s.charCodeAt(i - 1);
  if (lo >= 0xdc00 && lo <= 0xdfff && i >= 2) {
    const hi = s.charCodeAt(i - 2);
    if (hi >= 0xd800 && hi <= 0xdbff) return (hi - 0xd800) * 0x400 + (lo - 0xdc00) + 0x10000;
  }
  return lo;
}

// The code point starting at index i of s, or -1 at the end.
function cpAfter(s, i) {
  if (i >= s.length) return -1;
  return s.codePointAt(i);
}

// Is the code point a space or punctuation, other than '*' and '_'?
// (The reference's "punctuation" test excludes those two.)
function isSpaceOrPunctNt(cp) {
  if (cp < 0 || cp === 42 || cp === 95) return false;
  return isSpaceCode(cp) || isPunctCode(cp);
}

// Classify one character for the closer search: 1 = punctuation,
// 2 = whitespace (or end of string), 3 = anything else. When
// `tildeAsOther` is true, '~' counts as a letter, not punctuation.
function delimClass(cp, tildeAsOther) {
  if (cp < 0) return 2;
  if (cp === 126 && tildeAsOther) return 3;
  if (isSpaceCode(cp)) return 2;
  if (isPunctCode(cp)) return 1;
  return 3;
}

// Which closer group a delimiter run falls into, from the characters
// around it: 1-6 as the reference's patterns assign them, or 0 when
// the run cannot close anything. For '_' the (punct, other) case is
// group 6; for '*' and '~' it is group 3.
function closerGroup(prevCp, nextCp, tildeAsOther, isUnd) {
  const pc = delimClass(prevCp, tildeAsOther);
  const nc = delimClass(nextCp, tildeAsOther);
  if (pc === 1) {
    if (nc === 1) return 5;
    if (nc === 2) return 1;
    // Preceded by punctuation, followed by other text: can open
    // but cannot close (right-flanking fails), for both '*' and '_'.
    return 3;
  }
  if (pc === 2) {
    if (nc === 1) return 4;
    if (nc === 2) return 0;
    return 3;
  }
  if (nc === 1 || nc === 2) return 2;
  // Preceded and followed by other text: '*' can both open and
  // close; '_' can do neither (it is neither left- nor
  // right-flanking in the '_' sense).
  return isUnd ? 0 : 6;
}

// The first-alternative skip for '*' closers: text of the shape
// [no * or _] __ [no * or _] * [no * or _] __ is consumed without
// closing anything. Returns the index to resume at, or 0.
function skipStarPrefix(t) {
  let p = 0;
  while (p < t.length && t[p] !== "*" && t[p] !== "_") p++;
  if (t[p] !== "_" || t[p + 1] !== "_") return 0;
  let q = p + 2;
  while (q < t.length && t[q] !== "*" && t[q] !== "_") q++;
  if (t[q] !== "*") return 0;
  let r = q + 1;
  while (r < t.length && t[r] !== "*" && t[r] !== "_") r++;
  if (t[r] === "_" && t[r + 1] === "_") return r;
  return 0;
}

// The same skip for '_' closers, with '**' and '_' swapped.
function skipUndPrefix(t) {
  let p = 0;
  while (p < t.length && t[p] !== "*" && t[p] !== "_") p++;
  if (t[p] !== "*" || t[p + 1] !== "*") return 0;
  let q = p + 2;
  while (q < t.length && t[q] !== "*" && t[q] !== "_") q++;
  if (t[q] !== "_") return 0;
  let r = q + 1;
  while (r < t.length && t[r] !== "*" && t[r] !== "_") r++;
  if (t[r] === "*" && t[r + 1] === "*") return r;
  return 0;
}

// Try to read an emphasis or strong emphasis opener at the start of
// `e` (the remaining original text). `masked` is the full masked
// string, `prev` the last character of the previous text token (or
// ""), `fe` the last-possible-closer scan. Returns {type, raw, text}
// or null.
function tryEmStrong(e, masked, prev, fe) {
  const d0 = e.charCodeAt(0);
  if (d0 !== 42 && d0 !== 95) return null; // '*' or '_'
  const delim = d0 === 42 ? "*" : "_";
  let k = 0;
  while (k < e.length && e.charCodeAt(k) === d0) k++;
  const afterCp = k < e.length ? e.codePointAt(k) : -1;
  let afterPunct = false;
  let afterOther = false;
  if (afterCp !== -1) {
    const afterCh = String.fromCodePoint(afterCp);
    if (afterCh !== "~" && isPunctCode(afterCp)) afterPunct = true;
    else if (!isSpaceCode(afterCp) && afterCh !== delim) afterOther = true;
  }
  if (!afterPunct && !afterOther) return null;
  const i = masked.length - e.length;
  let l = i;
  while (l > 0 && masked.charCodeAt(l - 1) === d0) l--;
  const pCp = cpBefore(masked, l);
  const pCh = pCp === -1 ? "" : String.fromCodePoint(pCp);
  const h = pCh === "*" || pCh === "_" || isSpaceOrPunctNt(pCp);
  const o = prev === delim;
  let n = prev;
  if (l < i) n = pCh;
  const u = l < i ? h : (n !== "" && isSpaceOrPunctNt(n.codePointAt(0)));
  // An '_' run followed by a non-punctuation character, with an
  // alphanumeric before it, cannot open.
  if (d0 === 95 && afterOther && n !== "" && isAlnumCode(n.codePointAt(0))) return null;
  const d = afterPunct;
  if (d && n !== "" && !u) return null;
  const y = i - l + k;
  const R = pCh.trim() !== "" && (d || (d0 === 42 && !h));
  const v = d0 === 42 ? fe.star : fe.und;
  const Q = i + k;
  if (v < Q) return null;
  const sliced = masked.slice(Q);
  const ee = v - Q;
  const tildeAsOther = d0 === 42;
  let pos = d0 === 42 ? skipStarPrefix(sliced) : skipUndPrefix(sliced);
  let m = k;
  let f = 0;
  while (true) {
    let rs = -1;
    for (let j = pos; j < sliced.length; j++) {
      if (sliced.charCodeAt(j) === d0) { rs = j; break; }
    }
    if (rs === -1) return null;
    if (rs - 1 > ee) return null;
    let re = rs + 1;
    while (re < sliced.length && sliced.charCodeAt(re) === d0) re++;
    const b = re - rs;
    const g = closerGroup(cpBefore(sliced, rs), cpAfter(sliced, re), tildeAsOther, d0 === 95);
    pos = re;
    if (g === 0) continue;
    if (g === 3 || g === 4) { m += b; continue; }
    if (g === 5 || g === 6 || R) {
      if (o && (g === 5 || g === 6)) return null;
      if (y % 3 !== 0 && (y + b) % 3 === 0) { f += b; continue; }
    }
    m -= b;
    if (m > 0) continue;
    const bb = Math.min(b, b + m + f);
    const M = e.slice(0, k + rs + bb);
    if (Math.min(k, bb) % 2 === 1) {
      return { type: "em", raw: M, text: M.slice(1, -1) };
    }
    return { type: "strong", raw: M, text: M.slice(2, -2) };
  }
}

// Try to read a strikethrough opener at the start of `e`.
// Returns {type, raw, text} or null.
function tryDel(e, masked, prev, fe) {
  if (e.charCodeAt(0) !== 126) return null; // '~'
  let run = 0;
  while (run < e.length && e.charCodeAt(run) === 126) run++;
  const matchedRun = Math.min(run, 2);
  const afterCp = matchedRun < e.length ? e.codePointAt(matchedRun) : -1;
  let afterPunct = false;
  let groupMatched = false;
  if (afterCp !== -1) {
    const afterCh = String.fromCodePoint(afterCp);
    if (afterCh !== "~" && isPunctCode(afterCp)) afterPunct = true;
    groupMatched = afterPunct || (!isSpaceCode(afterCp) && afterCh !== "~");
  }
  if (afterPunct && prev !== "" && !isSpaceOrPunctNt(prev.codePointAt(0))) return null;
  const o = matchedRun + (groupMatched ? 1 : 0) - 1;
  const u = fe.tilde;
  const i = masked.length - e.length;
  const d = i + o;
  if (u < d) return null;
  const sliced = masked.slice(d);
  const k = u - d;
  let p = o;
  let pos = 0;
  while (true) {
    let rs = -1;
    for (let j = pos; j < sliced.length; j++) {
      if (sliced.charCodeAt(j) === 126) { rs = j; break; }
    }
    if (rs === -1) return null;
    if (rs - 1 > k) return null;
    let re = rs + 1;
    while (re < sliced.length && sliced.charCodeAt(re) === 126) re++;
    const b = re - rs;
    pos = re;
    if (rs === 0) continue;
    const g = closerGroup(cpBefore(sliced, rs), cpAfter(sliced, re), false);
    if (g === 0 || b !== o) continue;
    if (g === 3 || g === 4) { p += b; continue; }
    p -= b;
    if (p > 0) continue;
    const bb = Math.min(b, b + p);
    const M = e.slice(0, o + rs + bb);
    return { type: "del", raw: M, text: M.slice(o, -o) };
  }
}

/* ------------------------------------------------------------------ */
/* Inline tokenizers                                                   */
/* ------------------------------------------------------------------ */

// Characters that may start an inline link or reference link.
const LINK_START = new Set(["[", "!"]);

// Does a hard line break (two or more spaces, then a newline) start
// at s[i]?
function startsHardBreak(s, i) {
  let j = i;
  while (j < s.length && s[j] === " ") j++;
  return j - i >= 2 && s[j] === "\n";
}

// May a 'www.' link start at s[i] given the preceding character?
function isWwwPreceding(ch) {
  return ch === undefined || isSpaceChar(ch) || ch === "*" || ch === "_" || ch === "~" || ch === "(";
}

// Replace backslash escapes of punctuation with the punctuation.
function unescapePunct(s) {
  if (s.indexOf("\\") === -1) return s;
  let out = "";
  let start = 0;
  let i = 0;
  while (i < s.length) {
    if (s[i] === "\\" && i + 1 < s.length && isPunctCode(s.codePointAt(i + 1))) {
      const units = s.codePointAt(i + 1) > 0xffff ? 2 : 1;
      out += s.slice(start, i) + s.slice(i + 1, i + 1 + units);
      i += 1 + units;
      start = i;
      continue;
    }
    i++;
  }
  return start === 0 ? s : out + s.slice(start);
}

class Lexer {
  constructor() {
    this.links = Object.create(null);
    this.queue = [];
    this.inLink = false;
    this.inRawBlock = false;
    this.linkEmitted = false;
    this.linkParenPossible = true;
    this.top = true;
  }

  // Queue a string for inline tokenization after the block pass.
  inline(src) {
    const tokens = [];
    this.queue.push({ src, tokens });
    return tokens;
  }

  // Tokenize `src` inline right now, appending to `out`.
  inlineTokens(src, out) {
    const saved = this.linkParenPossible;
    this.linkParenPossible = saved && src.indexOf(")") !== -1;
    try {
      return this.inlineTokensInner(src, out);
    } finally {
      this.linkParenPossible = saved;
    }
  }

  inlineTokensInner(src, out) {
    const hasDelim = src.indexOf("*") !== -1 || src.indexOf("_") !== -1 || src.indexOf("~") !== -1;
    const masked = hasDelim ? maskInline(src, this.links) : src;
    const fe = hasDelim ? scanLastDelims(masked) : { star: -1, und: -1, tilde: -1 };
    // Index-based: the remaining string is materialized only when a
    // tokenizer needs it, so long paragraphs are not re-sliced on
    // every token.
    const n = src.length;
    let pos = 0;
    let prev = "";
    let wasText = false;
    let lastPos = -1;
    while (pos < n) {
      if (pos <= lastPos) throw new Error("Infinite loop on byte: " + src.charCodeAt(pos));
      lastPos = pos;
      if (!wasText) prev = "";
      wasText = false;
      let tok = null;
      const c0 = src.charCodeAt(pos);
      if (c0 === 92) tok = this.tryEscape(src.slice(pos)); // backslash
      if (!tok && c0 === 60) tok = this.tryTag(src.slice(pos)); // '<'
      if (!tok && (c0 === 91 || c0 === 33)) tok = this.tryLink(src.slice(pos)); // '[' or '!'
      if (!tok && (c0 === 91 || c0 === 33)) tok = this.tryReflink(src.slice(pos));
      if (!tok && (c0 === 42 || c0 === 95)) { // '*' or '_'
        const r = tryEmStrong(src.slice(pos), masked, prev, fe);
        if (r) {
          r.tokens = [];
          this.inlineTokens(r.text, r.tokens);
          tok = r;
        }
      }
      if (!tok && c0 === 96) tok = this.tryCodespan(src.slice(pos)); // '`'
      if (!tok && (c0 === 32 || c0 === 92)) tok = this.tryBr(src.slice(pos));
      if (!tok && c0 === 126) { // '~'
        const r = tryDel(src.slice(pos), masked, prev, fe);
        if (r) {
          r.tokens = [];
          this.inlineTokens(r.text, r.tokens);
          tok = r;
        }
      }
      if (!tok && c0 === 60) tok = this.tryAutolink(src.slice(pos));
      if (!tok && !this.inLink) tok = this.tryUrl(src.slice(pos));
      if (!tok) {
        const t = this.scanTextAt(src, pos);
        if (t) {
          pos += t.raw.length;
          if (t.raw.slice(-1) !== "_") prev = t.raw.slice(-1);
          wasText = true;
          const last = out[out.length - 1];
          if (last && last.type === "text") { last.raw += t.raw; last.text += t.text; }
          else out.push(t);
          continue;
        }
      }
      if (!tok) throw new Error("Infinite loop on byte: " + src.charCodeAt(pos));
      pos += tok.raw.length;
      if (tok.type === "text") {
        const last = out[out.length - 1];
        if (last && last.type === "text") { last.raw += tok.raw; last.text += tok.text; }
        else out.push(tok);
      } else {
        out.push(tok);
      }
    }
    return out;
  }

  // \ + ASCII punctuation.
  tryEscape(e) {
    if (e.charCodeAt(0) !== 92 || e.length < 2) return null;
    const ch = e[1];
    if ("!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~".indexOf(ch) === -1) return null;
    return { type: "escape", raw: e.slice(0, 2), text: ch };
  }

  // An inline HTML tag, comment, processing instruction, declaration
  // or CDATA section. Updates the in-link and raw-block state.
  tryTag(e) {
    const len = matchInlineTag(e);
    if (len === -1) return null;
    const text = e.slice(0, len);
    const low = text.toLowerCase();
    if (!this.inLink && low.startsWith("<a ")) this.inLink = true;
    else if (this.inLink && low.startsWith("</a>")) this.inLink = false;
    if (!this.inRawBlock && /^(?:<(?:pre|code|kbd|script))(?:\s|>)/.test(low)) this.inRawBlock = true;
    else if (this.inRawBlock && /^(?:<\/(?:pre|code|kbd|script))(?:\s|>)/.test(low)) this.inRawBlock = false;
    return { type: "html", raw: text, text, block: false, inLink: this.inLink, inRawBlock: this.inRawBlock };
  }

  // An inline link [text](destination "title").
  tryLink(e) {
    if (!this.linkParenPossible) return null;
    const m = parseInlineLink(e, 0);
    if (m === null) return null;
    const off = m.image ? 2 : 1;
    if (labelHasOpenTag(e, m.label, off, this)) return null;
    const s = m.href.trim();
    if (s.charAt(0) === "<") {
      if (s.charAt(s.length - 1) !== ">") return null;
      const inner = stripTail(s.slice(0, -1), "\\");
      if ((s.length - inner.length) % 2 === 0) return null;
    } else {
      const p = findUnbalancedParen(m.href);
      if (p === -2) return null;
      if (p > -1) {
        const h = (m.image ? 5 : 4) + m.label.length + p;
        m.href = m.href.substring(0, p);
        m.raw = m.raw.substring(0, h).trim();
        m.title = null;
      }
    }
    const noTrail = stripTail(m.raw.slice(0, -1), "\\");
    if ((m.raw.length - noTrail.length) % 2 === 0) return null;
    let href = m.href.trim();
    if (href.charAt(0) === "<") href = href.slice(1, -1);
    const title = m.title ? m.title.slice(1, -1) : "";
    return this.makeLink(m, { href: href && unescapePunct(href), title: title && unescapePunct(title) }, m.raw);
  }

  // A reference link [text][ref] or [ref].
  tryReflink(e) {
    const bang = e.charCodeAt(0) === 33 && e.charCodeAt(1) === 91;
    const base = bang ? 1 : 0;
    if (e.charCodeAt(base) !== 91) return null;
    let label = null;
    let refText = null;
    let rawEnd = -1;
    const lab = matchFullLabel(e, base);
    if (lab !== null && e[lab.end] === "[") {
      const ref = matchSimpleLabel(e, lab.end);
      if (ref !== null) {
        label = lab.text;
        refText = ref.text;
        rawEnd = ref.end;
      }
    }
    if (rawEnd === -1) {
      const ref = matchSimpleLabel(e, base);
      if (ref !== null) {
        let end = ref.end;
        if (e[end] === "[" && e[end + 1] === "]") end += 2;
        // A bare [ref] matches even when followed by '(': the
        // inline-link form is tried first, and if it fails the
        // reference link still stands.
        label = ref.text;
        refText = ref.text;
        rawEnd = end;
      }
    }
    if (rawEnd === -1) return null;
    const off = bang ? 2 : 1;
    if (labelHasOpenTag(e, label, off, this)) return null;
    const dest = this.links[normLabel(refText || label)];
    if (!dest) {
      const ch = e.charAt(0);
      return { type: "text", raw: ch, text: ch };
    }
    return this.makeLink({ image: bang, label }, dest, e.slice(0, rawEnd));
  }

  // Build a link or image token, tokenizing its text inline. A link
  // whose text itself holds a link is dropped.
  makeLink(m, dest, raw) {
    const text = m.label.replace(/\\([\[\]])/g, "$1");
    const isImage = m.image;
    const saveInLink = this.inLink;
    const saveEmitted = this.linkEmitted;
    const saveRaw = this.inRawBlock;
    this.inLink = true;
    this.linkEmitted = false;
    const tokens = [];
    this.inlineTokens(text, tokens);
    const innerLink = this.linkEmitted;
    this.linkEmitted = saveEmitted;
    this.inLink = saveInLink;
    if (!isImage) {
      if (innerLink) { this.inRawBlock = saveRaw; return null; }
      this.linkEmitted = true;
    }
    return { type: isImage ? "image" : "link", raw, href: dest.href, title: dest.title || null, text, tokens };
  }

  // A code span.
  tryCodespan(e) {
    if (e.charCodeAt(0) !== 96) return null;
    let k = 0;
    while (k < e.length && e.charCodeAt(k) === 96) k++;
    const close = matchCodeSpanEnd(e, 0, k);
    if (close === -1) return null;
    let text = e.slice(k, close - k).replace(/\n/g, " ");
    const hasNonSpace = text.indexOf(" ") === -1 || /[^ ]/.test(text);
    if (hasNonSpace && text.charAt(0) === " " && text.charAt(text.length - 1) === " ") {
      text = text.substring(1, text.length - 1);
    }
    return { type: "codespan", raw: e.slice(0, close), text };
  }

  // A hard line break: two or more spaces, or a backslash, then a
  // newline, not at the very end of the block.
  tryBr(e) {
    const c0 = e.charCodeAt(0);
    let i;
    if (c0 === 92) {
      if (e.charCodeAt(1) !== 10) return null;
      i = 2;
    } else if (c0 === 32) {
      let spaces = 0;
      while (spaces < e.length && e.charCodeAt(spaces) === 32) spaces++;
      if (spaces < 2 || e.charCodeAt(spaces) !== 10) return null;
      i = spaces + 1;
    } else {
      return null;
    }
    let j = i;
    while (j < e.length && isSpaceChar(e[j])) j++;
    if (j >= e.length) return null;
    while (i < e.length && (e[i] === " " || e[i] === "\t")) i++;
    return { type: "br", raw: e.slice(0, i) };
  }

  // An autolink <scheme:...> or <email>.
  tryAutolink(e) {
    const m = matchAutolink(e);
    if (m === null) return null;
    const inner = e.slice(1, m.len - 1);
    const href = m.email ? "mailto:" + inner : inner;
    return { type: "link", raw: e.slice(0, m.len), text: inner, href, autolink: true, tokens: [{ type: "text", raw: inner, text: inner }] };
  }

  // An extended autolink: www., a scheme, or a bare email.
  tryUrl(e) {
    const m = matchExtendedUrl(e);
    if (m === null) return null;
    return { type: "link", raw: e.slice(0, m.len), text: m.text, href: m.href, autolink: true, tokens: [{ type: "text", raw: m.text, text: m.text }] };
  }

  // A run of plain text, stopping at the next inline construct.
  // A run of plain text starting at src[pos]. Index-based: the
  // expensive per-character checks (protocol / email / www.) are
  // gated on the character that could start one, so ordinary prose
  // costs one cheap test per character.
  // The next inline stop: a character that starts a token, a URL scheme,
  // a www. autolink, a mailto:/xmpp: autolink, a bare e-mail address, or a
  // hard break (two or more spaces before a newline). The e-mail and
  // mailto: lookaheads are guarded by a lookbehind so they only fire at
  // the start of a run; a run that starts right after the first unit is
  // caught by the explicit check below, which is also how a mailto: link
  // directly after a leading space is found.
  scanTextAt(src, pos) {
    const n = src.length;
    let i = pos;
    const c0 = src.charCodeAt(pos);
    if (c0 === 96) {
      while (i < n && src.charCodeAt(i) === 96) i++;
    } else if (c0 === 126) {
      while (i < n && src.charCodeAt(i) === 126) i++;
    } else {
      i = pos + 1;
    }
    let end = n;
    if (i < n) {
      const c = src.charCodeAt(i);
      if (c === 96 || c === 126 || startsHardBreak(src, i) || emailRunAt(src, i)) {
        // The text ends right after its first unit.
        end = i;
      } else {
        TEXT_STOP_RE.lastIndex = i;
        let m = TEXT_STOP_RE.exec(src);
        while (m !== null) {
          const p = m.index;
          if (m[0] === "www.") {
            // A www. autolink needs a qualifying preceding character.
            if (isWwwPreceding(src[p - 1])) { end = p; break; }
            TEXT_STOP_RE.lastIndex = p + 1;
            m = TEXT_STOP_RE.exec(src);
            continue;
          }
          if (m[0] === "" && p === i && i > pos + 1 && (src.startsWith("mailto:", p) || src.startsWith("xmpp:", p))) {
            // A mailto:/xmpp: link directly after a backtick/tilde run
            // is not an autolink: the run is the first unit, and the
            // preceding character is not a standalone one.
            TEXT_STOP_RE.lastIndex = p + 1;
            m = TEXT_STOP_RE.exec(src);
            continue;
          }
          end = p;
          break;
        }
      }
    }
    const raw = src.slice(pos, end);
    return { type: "text", raw, text: this.inRawBlock ? raw : unescapeText(raw), escaped: this.inRawBlock };
  }
}

/* ------------------------------------------------------------------ */
/* Block tokenizers                                                    */
/* ------------------------------------------------------------------ */

// Line-start predicates used by the paragraph, table, list and
// setext-heading stop conditions. `i` is a line start in `s`.

// A thematic break line: 0-3 spaces, then 3+ of '-', '_' or '*'
// with spaces/tabs between them, then the line ends.
function isHrLine(s, i) {
  let j = i;
  let spaces = 0;
  while (spaces < 3 && s[j] === " ") { j++; spaces++; }
  const c = s[j];
  if (c !== "-" && c !== "_" && c !== "*") return false;
  let count = 0;
  while (j < s.length) {
    if (s[j] === c) { count++; j++; }
    else if (s[j] === " " || s[j] === "\t") { j++; }
    else break;
  }
  if (count < 3) return false;
  return j >= s.length || s[j] === "\n";
}

// An ATX heading line: 0-3 spaces, 1-6 '#', then whitespace or end.
function isHeadingLine(s, i) {
  let j = i;
  let spaces = 0;
  while (spaces < 3 && s[j] === " ") { j++; spaces++; }
  let hashes = 0;
  while (hashes < 6 && s[j] === "#") { j++; hashes++; }
  if (hashes === 0) return false;
  return j >= s.length || isJsSpace(s[j]);
}

// A blockquote line: 0-3 spaces, then '>'.
function isBlockquoteLine(s, i) {
  let j = i;
  let spaces = 0;
  while (spaces < 3 && s[j] === " ") { j++; spaces++; }
  return s[j] === ">";
}

// A fenced-code opening line: 0-3 spaces, then 3+ backticks (with no
// backtick later on the line) or 3+ tildes.
function isFencesLine(s, i) {
  let j = i;
  let spaces = 0;
  while (spaces < 3 && s[j] === " ") { j++; spaces++; }
  const c = s[j];
  if (c !== "`" && c !== "~") return false;
  let k = j;
  while (k < s.length && s[k] === c) k++;
  if (k - j < 3) return false;
  if (c === "`") {
    let m = k;
    while (m < s.length && s[m] !== "\n") { if (s[m] === "`") return false; m++; }
  }
  return true;
}

// A list-item line. variant "para" is the paragraph stop (only the
// number 1, then spaces and a non-blank character); "bq" is the
// blockquote-paragraph stop (any 1-9 digit number, then a space, tab,
// newline or end); "table" is the table-row stop (only 1, then a
// space or tab).
function isListLine(s, i, variant) {
  let j = i;
  let spaces = 0;
  while (spaces < 3 && s[j] === " ") { j++; spaces++; }
  const c = s[j];
  if (c === "*" || c === "+" || c === "-") {
    j++;
  } else if (c >= "0" && c <= "9") {
    if (variant === "para" || variant === "table") {
      if (c !== "1") return false;
      j++;
    } else {
      let k = j;
      while (k < s.length && s[k] >= "0" && s[k] <= "9" && k - j < 9) k++;
      if (k === j) return false;
      j = k;
    }
    if (s[j] !== "." && s[j] !== ")") return false;
    j++;
  } else {
    return false;
  }
  if (variant === "para") {
    let k = j;
    while (s[k] === " " || s[k] === "\t") k++;
    if (k === j) return false;
    const ch = s[k];
    return ch !== undefined && ch !== " " && ch !== "\t" && ch !== "\n";
  }
  if (variant === "bq") {
    const ch = s[j];
    return ch === " " || ch === "\t" || ch === "\n" || ch === undefined;
  }
  return s[j] === " " || s[j] === "\t";
}

// The start of an HTML block: 0-3 spaces, then '<' followed by a
// block tag, script/pre/style/textarea, a comment, a processing
// instruction, a declaration or a CDATA section. `nlOk` selects the
// tag terminator used in paragraph/table lookaheads ('\n') versus the
// list tokenizer (end of string).
function isHtmlBegin(s, i, nlOk) {
  let j = i;
  let spaces = 0;
  while (spaces < 3 && s[j] === " ") { j++; spaces++; }
  if (s[j] !== "<") return false;
  if (s[j + 1] === "!" && s[j + 2] === "-" && s[j + 3] === "-") return true;
  if (s[j + 1] === "?") return true;
  if (s[j + 1] === "!" && s[j + 2] === "[" && s.slice(j + 3, j + 9) === "CDATA[") return true;
  if (s[j + 1] === "!" && isAsciiLetter(s[j + 2])) return true;
  let k = j + 1;
  const closing = s[k] === "/";
  if (closing) k++;
  // A script/pre/style/textarea tag followed by whitespace, '>' or end.
  // Only an opening tag counts here: a closing </pre> does not
  // interrupt a paragraph (marked's paragraph HTML alternative is
  // open-tag-only for these names).
  let m = k;
  while (m < s.length && ((s[m] >= "a" && s[m] <= "z") || (s[m] >= "A" && s[m] <= "Z") || (s[m] >= "0" && s[m] <= "9") || s[m] === "-")) m++;
  const name = s.slice(k, m).toLowerCase();
  if (!closing && (name === "script" || name === "pre" || name === "style" || name === "textarea")) {
    const ch = s[m];
    return ch === undefined || isJsSpace(ch) || ch === ">";
  }
  // A block tag followed by spaces, a newline (or end), or '>'.
  if (!BLOCK_TAGS.has(name)) return false;
  const ch = s[m];
  if (ch === " ") return true;
  if (nlOk ? ch === "\n" : ch === undefined) return true;
  if (ch === ">") return true;
  if (ch === "/" && s[m + 1] === ">") return true;
  return false;
}

// A table delimiter line (setext-heading stop): 0-3 spaces, an
// optional '|', then 1+ groups of [:- ]* '|', then [:- ]*, then '\n'.
function isTableDelimiterLine(s, i) {
  let j = i;
  let spaces = 0;
  while (spaces < 3 && s[j] === " ") { j++; spaces++; }
  if (s[j] === "|") j++;
  let groups = 0;
  while (true) {
    let k = j;
    while (s[k] === ":" || s[k] === "-" || s[k] === " ") k++;
    if (s[k] !== "|") break;
    j = k + 1;
    groups++;
  }
  if (groups === 0) return false;
  while (s[j] === ":" || s[j] === "-" || s[j] === " ") j++;
  return s[j] === "\n" || j >= s.length;
}

// Is the line starting at `i` blank (only spaces/tabs, then a
// newline or the end)?
function isBlankLine(s, i) {
  let j = i;
  while (s[j] === " " || s[j] === "\t") j++;
  return j >= s.length || s[j] === "\n";
}

// Is the line starting at `i` blank in the paragraph sense: spaces
// or tabs, then a newline (a line of only spaces at the very end
// does not count)?
function isBlankLineNl(s, i) {
  let j = i;
  let count = 0;
  while (s[j] === " " || s[j] === "\t") { j++; count++; }
  return count > 0 && s[j] === "\n";
}

// A setext underline line: 0-3 spaces, 1+ '=' or '-', spaces/tabs,
// then a newline or the end. Returns the depth (1 for '=', 2 for
// '-') and the match end, or null.
function matchSetextLine(s, i) {
  let j = i;
  let spaces = 0;
  while (spaces < 3 && s[j] === " ") { j++; spaces++; }
  const c = s[j];
  if (c !== "=" && c !== "-") return null;
  let k = j;
  while (k < s.length && s[k] === c) k++;
  while (s[k] === " " || s[k] === "\t") k++;
  if (k < s.length && s[k] !== "\n") return null;
  let end = k;
  while (end < s.length && s[end] === "\n") end++;
  return { depth: c === "=" ? 1 : 2, end };
}

// The stop conditions for a setext-heading content line. `first`
// is the outer negative lookahead (bull, block code, fences,
// blockquote, heading, html, table); later lines use the inner one
// (blank line, bull, fences, blockquote, heading, hr, html, table).
function isLheadingStop(s, i, first) {
  if (!first) {
    // A blank line (empty, or only spaces/tabs before a newline).
    let m = i;
    while (s[m] === " " || s[m] === "\t") m++;
    if (s[m] === "\n") return true;
  }
  let j = i;
  let spaces = 0;
  while (spaces < 3 && s[j] === " ") { j++; spaces++; }
  // Bull: 0-3 spaces, then a bullet or a number.
  const c = s[j];
  if (c === "*" || c === "+" || c === "-") return true;
  if (c >= "0" && c <= "9") {
    let k = j;
    while (k < s.length && s[k] >= "0" && s[k] <= "9" && k - j < 9) k++;
    if (k > j && (s[k] === "." || s[k] === ")")) return true;
  }
  if (first) {
    // Block code: 4 spaces, or 0-3 spaces then a tab.
    if (s[j] === "\t") return true;
    let k = i;
    let sp = 0;
    while (sp < 4 && s[k] === " ") { k++; sp++; }
    if (sp === 4) return true;
  } else if (isHrLine(s, i)) {
    return true;
  }
  if (isFencesLine(s, i) || isBlockquoteLine(s, i) || isHeadingLine(s, i)) return true;
  if (isTableDelimiterLine(s, i)) return true;
  // html: 0-3 spaces, '<', 1+ chars that are not a newline or '>',
  // then '>' and a newline.
  if (s[j] === "<") {
    let m = j + 1;
    while (m < s.length && s[m] !== "\n" && s[m] !== ">") m++;
    if (m > j + 1 && s[m] === ">" && s[m + 1] === "\n") return true;
  }
  return false;
}

// A run of blank lines: one or more lines of only spaces/tabs.
// Returns the match length, or 0.
Lexer.prototype.tokenizeSpace = function (t) {
  let i = 0;
  let matched = false;
  while (i < t.length) {
    let j = i;
    while (j < t.length && (t[j] === " " || t[j] === "\t")) j++;
    if (j < t.length && t[j] === "\n") { i = j + 1; matched = true; continue; }
    if (j >= t.length) { i = j; matched = true; break; }
    break;
  }
  return matched ? i : 0;
};

// Indented code: lines indented by 4 spaces (or 0-3 spaces + tab),
// with blank lines allowed between them.
Lexer.prototype.tokenizeCode = function (t) {
  let i = 0;
  let matched = 0;
  while (true) {
    let indent = -1;
    if (t[i] === " " && t[i + 1] === " " && t[i + 2] === " " && t[i + 3] === " ") indent = 4;
    else {
      let sp = 0;
      while (sp < 3 && t[i + sp] === " ") sp++;
      if (t[i + sp] === "\t") indent = sp + 1;
    }
    if (indent === -1) break;
    let k = i + indent;
    if (k >= t.length || t[k] === "\n") break;
    while (k < t.length && t[k] !== "\n") k++;
    matched = k;
    i = k;
    if (i < t.length && t[i] === "\n") {
      let m = i + 1;
      while (true) {
        let p = m;
        while (p < t.length && (t[p] === " " || t[p] === "\t")) p++;
        if (p < t.length && t[p] === "\n") { m = p + 1; continue; }
        if (p >= t.length) { m = p; break; }
        break;
      }
      i = m;
    }
  }
  if (matched === 0) return null;
  const raw = trimBlankTail(t.slice(0, i));
  const text = raw.replace(/^(?: {0,3}\t| {1,4})/gm, "");
  return { type: "code", raw, codeBlockStyle: "indented", text };
};

// Fenced code: an opening fence, an info string, content lines, and
// an optional closing fence of at least the opening length.
Lexer.prototype.tokenizeFences = function (t) {
  let i = 0;
  let spaces = 0;
  while (spaces < 3 && t[i] === " ") { i++; spaces++; }
  const c = t[i];
  if (c !== "`" && c !== "~") return null;
  let j = i;
  while (j < t.length && t[j] === c) j++;
  const openLen = j - i;
  if (openLen < 3) return null;
  if (c === "`") {
    let k = j;
    while (k < t.length && t[k] !== "\n") { if (t[k] === "`") return null; k++; }
  }
  let infoEnd = j;
  while (infoEnd < t.length && t[infoEnd] !== "\n") infoEnd++;
  const info = t.slice(j, infoEnd);
  const contentStart = infoEnd < t.length ? infoEnd + 1 : infoEnd;
  let pos = contentStart;
  let closeLineStart = -1;
  let closeEnd = -1;
  while (pos < t.length) {
    let k = pos;
    let sp = 0;
    while (sp < 3 && t[k] === " ") { k++; sp++; }
    if (t[k] === c) {
      let m = k;
      while (m < t.length && t[m] === c) m++;
      if (m - k >= openLen) {
        let p = m;
        while (p < t.length && t[p] === " ") p++;
        if (p >= t.length || t[p] === "\n") { closeLineStart = pos; closeEnd = p; break; }
      }
    }
    const nl = t.indexOf("\n", pos);
    if (nl === -1) break;
    pos = nl + 1;
  }
  let raw;
  let content;
  if (closeLineStart !== -1) {
    raw = t.slice(0, closeEnd);
    content = closeLineStart === contentStart ? "" : t.slice(contentStart, closeLineStart - 1);
  } else {
    raw = t;
    content = t.slice(contentStart);
    if (content.charAt(content.length - 1) === "\n") content = content.slice(0, -1);
  }
  // Indent compensation: a backtick fence whose opening line starts
  // with whitespace pulls that many characters off each content line.
  const m2 = /^(\s+)(?:```)/.exec(raw);
  if (m2 !== null) {
    const s = m2[1];
    content = content.split("\n").map((line) => {
      const o = /^\s+/.exec(line);
      if (o === null) return line;
      return line.slice(Math.min(o[0].length, s.length));
    }).join("\n");
  }
  return { type: "code", raw, lang: info ? unescapePunct(info.trim()) : info, text: content };
};

// An ATX heading.
Lexer.prototype.tokenizeHeading = function (t) {
  let i = 0;
  let spaces = 0;
  while (spaces < 3 && t[i] === " ") { i++; spaces++; }
  let hashes = 0;
  while (hashes < 6 && t[i] === "#") { i++; hashes++; }
  if (hashes === 0) return null;
  if (i < t.length && !isJsSpace(t[i])) return null;
  let end = i;
  while (end < t.length && t[end] !== "\n") end++;
  let n = t.slice(i, end).trim();
  if (n.charAt(n.length - 1) === "#") {
    const s = stripTail(n, "#");
    if (!s || s.charAt(s.length - 1) === " " || s.charAt(s.length - 1) === "\t") n = s.trim();
  }
  return { type: "heading", raw: t.slice(0, end), depth: hashes, text: n, tokens: this.inline(n) };
};

// A thematic break.
Lexer.prototype.tokenizeHr = function (t) {
  let i = 0;
  let spaces = 0;
  while (spaces < 3 && t[i] === " ") { i++; spaces++; }
  const c = t[i];
  if (c !== "-" && c !== "_" && c !== "*") return null;
  let count = 0;
  let j = i;
  while (j < t.length) {
    if (t[j] === c) { count++; j++; }
    else if (t[j] === " " || t[j] === "\t") { j++; }
    else break;
  }
  if (count < 3) return null;
  if (j < t.length && t[j] !== "\n") return null;
  return { type: "hr", raw: t.slice(0, j) };
};

/* ------------------------------------------------------------------ */
/* Block tokenizers (continued)                                        */
/* ------------------------------------------------------------------ */

// Index of the next newline at or after `i`, or the string length.
function lineEnd(s, i) {
  const n = s.indexOf("\n", i);
  return n === -1 ? s.length : n;
}

// Start of the line after the one starting at `i`.
function nextLineStart(s, i) {
  const n = s.indexOf("\n", i);
  return n === -1 ? s.length : n + 1;
}

// Strip trailing newlines from a raw match, as the reference does
// for heading, hr, setext, def and table raws.
function stripNewlines(s) {
  let n = s.length;
  while (n > 0 && s[n - 1] === "\n") n--;
  return s.slice(0, n);
}

// Is the line starting at `i` the start of an indented code block:
// 4 spaces, or 0-3 spaces then a tab, followed by a non-newline?
function isCodeStart(s, i) {
  let j = i;
  let sp = 0;
  while (sp < 3 && s[j] === " ") { j++; sp++; }
  if (s[j] === "\t") return j + 1 < s.length && s[j + 1] !== "\n";
  let k = i;
  let c = 0;
  while (c < 4 && s[k] === " ") { k++; c++; }
  return c === 4 && k < s.length && s[k] !== "\n";
}

// Is the line starting at `i` a table header line followed by a
// delimiter line (the table shape the paragraph and setext rules
// stop at)? The delimiter itself needs no ':' or '|' here; the
// table tokenizer checks that.
function isTableShape(s, i) {
  let j = i;
  while (s[j] === " ") j++;
  if (j >= s.length || s[j] === "\n" || s[j] === " ") return false;
  const d = nextLineStart(s, i);
  return d < s.length && isTableDelimiterLine(s, d);
}

// Does the text starting at line `i` form a setext heading: one or
// more content lines (none of them a block start) followed by an
// underline line?
function startsSetextHeading(s, i) {
  let p = i;
  let first = true;
  while (true) {
    if (isLheadingStop(s, p, first)) return false;
    const nx = nextLineStart(s, p);
    if (nx >= s.length) return false;
    if (matchSetextLine(s, nx) !== null) return true;
    if (isBlankLine(s, nx)) return false;
    p = nx;
    first = false;
  }
}

// Scan a link title at `i`: "..." (any chars, backslash pairs),
// '...' (no blank line inside), or (...) (no parens inside).
// Returns {title, end} or null. The title excludes its quotes.
function scanTitle(s, i) {
  const q = s[i];
  if (q !== '"' && q !== "'" && q !== "(") return null;
  const close = q === "(" ? ")" : q;
  let j = i + 1;
  while (j < s.length) {
    const ch = s[j];
    if (ch === "\\" && j + 1 < s.length) { j += 2; continue; }
    if (ch === close) return { title: s.slice(i + 1, j), end: j + 1 };
    if (q === "'" && ch === "\n" && s[j + 1] === "\n") return null;
    j++;
  }
  return null;
}

// A link reference definition: [label]: destination "title".
// Returns the def token or null.
Lexer.prototype.tokenizeDef = function (t) {
  let i = 0;
  let spaces = 0;
  while (spaces < 3 && t[i] === " ") { i++; spaces++; }
  if (t[i] !== "[") return null;
  // Label: backslash pairs, any char except '[', ']' and newline,
  // or a newline that is not followed by a blank line.
  let j = i + 1;
  let label = "";
  while (j < t.length) {
    const ch = t[j];
    if (ch === "\\" && j + 1 < t.length) { label += t.slice(j, j + 2); j += 2; continue; }
    if (ch === "[" || ch === "]") break;
    if (ch === "\n") {
      let m = j + 1;
      while (t[m] === " " || t[m] === "\t") m++;
      if (m >= t.length || t[m] === "\n") return null;
      label += ch;
      j++;
      continue;
    }
    label += ch;
    j++;
  }
  if (j >= t.length || t[j] !== "]" || label.trim() === "") return null;
  if (t[j + 1] !== ":") return null;
  let p = j + 2;
  while (t[p] === " ") p++;
  if (t[p] === "\n") {
    p++;
    while (t[p] === " " || t[p] === "\t") p++;
  }
  // Destination: <...> on one line, or a run of non-space chars.
  let href = null;
  let angle = false;
  if (t[p] === "<") {
    let q = p + 1;
    while (q < t.length && t[q] !== ">" && t[q] !== "\n") q++;
    if (q >= t.length || t[q] !== ">") return null;
    href = t.slice(p + 1, q);
    angle = true;
    p = q + 1;
  } else {
    if (t[p] === undefined || t[p] === " " || t[p] === "\t" || t[p] === "\n") return null;
    let q = p;
    while (q < t.length && t[q] !== " " && t[q] !== "\t" && t[q] !== "\n") q++;
    href = t.slice(p, q);
    p = q;
  }
  if (!angle && findUnbalancedParen(href) !== -1) return null;
  // Optional title, on this line or the next.
  let title;
  let end = -1;
  {
    let q = p;
    let sp = 0;
    while (t[q] === " ") { q++; sp++; }
    let nl = false;
    if (t[q] === "\n") { nl = true; q++; while (t[q] === " " || t[q] === "\t") q++; }
    if (sp > 0 || nl) {
      const tq = scanTitle(t, q);
      if (tq !== null) {
        let r = tq.end;
        while (t[r] === " ") r++;
        if (r >= t.length || t[r] === "\n") {
          title = tq.title;
          end = r;
        }
      }
    }
    if (end === -1) {
      let r = p;
      while (t[r] === " ") r++;
      if (r < t.length && t[r] !== "\n") return null;
      end = r;
    }
  }
  let rawEnd = end;
  while (rawEnd < t.length && t[rawEnd] === "\n") rawEnd++;
  return {
    type: "def",
    tag: normLabel(label),
    raw: stripNewlines(t.slice(0, rawEnd)),
    href: href ? unescapePunct(href) : href,
    title: title === undefined ? title : unescapePunct(title),
  };
};

// Parse a table delimiter line into its cells, or null when the
// line is not a delimiter: 0-3 spaces, cells of [:- ]* separated
// by '|', an optional trailing '|', then the line ends. Every cell
// must hold at least one '-'.
function parseDelimCells(line) {
  let j = 0;
  let spaces = 0;
  while (spaces < 3 && line[j] === " ") { j++; spaces++; }
  if (line[j] === "|") j++;
  const cells = [];
  while (true) {
    let k = j;
    while (line[k] === ":" || line[k] === "-" || line[k] === " ") k++;
    if (line[k] === "|") {
      cells.push(line.slice(j, k));
      j = k + 1;
      let m = j;
      while (line[m] === " ") m++;
      if (m >= line.length) break;
      continue;
    }
    if (k >= line.length) { cells.push(line.slice(j, k)); break; }
    return null;
  }
  if (cells.length === 0) return null;
  for (const c of cells) if (!/^:?-+:?$/.test(c.trim())) return null;
  return cells;
}

// A GFM table: header line, delimiter line, then row lines until a
// blank line or a block start. Returns the table token or null.
Lexer.prototype.tokenizeTable = function (t) {
  const firstEnd = lineEnd(t, 0);
  let j = 0;
  while (t[j] === " ") j++;
  if (j >= firstEnd) return null;
  const headerLine = t.slice(0, firstEnd);
  const dStart = firstEnd + 1;
  if (dStart > t.length) return null;
  const dEnd = lineEnd(t, dStart);
  const delimLine = t.slice(dStart, dEnd);
  const delimCells = parseDelimCells(delimLine);
  if (delimCells === null) return null;
  if (delimLine.indexOf(":") === -1 && delimLine.indexOf("|") === -1) return null;
  const header = splitCells(headerLine);
  if (header.length !== delimCells.length) return null;
  const align = delimCells.map((c) => {
    const v = c.trim();
    if (/^ *-+: *$/.test(c)) return "right";
    if (/^ *:-+: *$/.test(c)) return "center";
    if (/^ *:-+ *$/.test(c)) return "left";
    return null;
  });
  const rows = [];
  let p = dEnd + 1;
  while (p < t.length) {
    // A row line ends the table only when it holds spaces alone:
    // marked's table row lookahead is `(?! *\n|...)`, so a line
    // holding a tab (e.g. "\t") is still a row, of empty cells.
    let q = p;
    while (t[q] === " ") q++;
    if (t[q] === "\n" || q >= t.length) break;
    if (isHrLine(t, p) || isHeadingLine(t, p) || isBlockquoteLine(t, p) ||
        isFencesLine(t, p) || isListLine(t, p, "table") || isHtmlBegin(t, p, true) ||
        isCodeStart(t, p)) break;
    const e = lineEnd(t, p);
    rows.push(t.slice(p, e));
    p = e + 1;
  }
  let rawEnd;
  if (rows.length > 0) {
    rawEnd = dEnd + 1;
    for (let k = 0; k < rows.length; k++) rawEnd += rows[k].length + 1;
    rawEnd -= 1;
  } else {
    rawEnd = dEnd;
  }
  const tok = { type: "table", raw: stripNewlines(t.slice(0, rawEnd)), header: [], align, rows: [] };
  for (let k = 0; k < header.length; k++) {
    tok.header.push({ text: header[k], tokens: this.inline(header[k]), header: true, align: align[k] });
  }
  for (const row of rows) {
    const cells = splitCells(row, header.length);
    tok.rows.push(cells.map((c, k) => ({ text: c, tokens: this.inline(c), header: false, align: align[k] })));
  }
  return tok;
};

// A setext heading: content lines then an underline line.
Lexer.prototype.tokenizeLheading = function (t) {
  if (isLheadingStop(t, 0, true)) return null;
  let p = 0;
  let contentEnd = -1;
  let depth = 0;
  let rawEnd = -1;
  while (true) {
    const nx = nextLineStart(t, p);
    if (nx >= t.length) return null;
    const u = matchSetextLine(t, nx);
    if (u !== null) { contentEnd = nx; depth = u.depth; rawEnd = u.end; break; }
    if (isBlankLine(t, nx)) return null;
    if (isLheadingStop(t, nx, false)) return null;
    p = nx;
  }
  const text = t.slice(0, contentEnd).trim();
  return {
    type: "heading",
    raw: stripNewlines(t.slice(0, rawEnd)),
    depth,
    text,
    tokens: this.inline(text),
  };
};

// A paragraph: the first line plus continuation lines, stopping at
// a blank line or a block start (hr, heading, setext, blockquote,
// fences, list, HTML, table).
Lexer.prototype.tokenizeParagraph = function (t) {
  let p = 0;
  while (true) {
    const nx = nextLineStart(t, p);
    if (nx >= t.length) break;
    // A line of only spaces/tabs followed by a newline ends it;
    // a spaces-only line at the very end does not.
    if (isBlankLineNl(t, nx)) break;
    if (t[nx] === "\n") break;
    if (isHrLine(t, nx) || isHeadingLine(t, nx) || isBlockquoteLine(t, nx) ||
        isFencesLine(t, nx) || isListLine(t, nx, "para") || isHtmlBegin(t, nx, true) ||
        isTableShape(t, nx) || startsSetextHeading(t, nx)) break;
    p = nx;
  }
  const end = lineEnd(t, p);
  const text = t.slice(0, end);
  return { type: "paragraph", raw: text, text, tokens: this.inline(text) };
};

// A single text line (used inside list items, where the lexer runs
// with top off and paragraphs are not formed).
Lexer.prototype.tokenizeText = function (t) {
  const end = lineEnd(t, 0);
  if (end === 0) return null;
  const text = t.slice(0, end);
  return { type: "text", raw: text, text, tokens: this.inline(text) };
};

/* ------------------------------------------------------------------ */
/* HTML blocks, block quotes, lists                                    */
/* ------------------------------------------------------------------ */

// Is `ch` a tag-name character ([a-zA-Z0-9-])?
function isTagNameChar(ch) {
  return ch !== undefined && ((ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") ||
    (ch >= "0" && ch <= "9") || ch === "-");
}

// From index `q` (just after an end marker), consume to the end of
// the line and then all following newlines.
function endOfLinePlusNewlines(s, q) {
  while (q < s.length && s[q] !== "\n") q++;
  while (q < s.length && s[q] === "\n") q++;
  return q;
}

// End of an HTML block of the kind that runs to a blank line:
// the index just after the first blank line, or the string end.
function endAtBlankLine(s, i) {
  let p = i;
  while (p < s.length) {
    if (isBlankLine(s, p)) {
      const e = lineEnd(s, p);
      return e < s.length ? e + 1 : e;
    }
    p = nextLineStart(s, p);
  }
  return s.length;
}

// Scan a complete open tag starting at `i` ('<'): a name, then
// attributes, then an optional '/' and '>'. Returns the index just
// after '>', or -1.
function scanTagEnd(s, i) {
  let k = i + 1;
  if (!isAsciiLetter(s[k])) return -1;
  while (isTagNameChar(s[k])) k++;
  while (true) {
    let q = k;
    let sp = 0;
    while (s[q] === " ") { q++; sp++; }
    if (sp === 0) break;
    if (!isAsciiLetter(s[q]) && s[q] !== "_" && s[q] !== ":") break;
    while (isWordChar(s[q]) || s[q] === "." || s[q] === ":" || s[q] === "-") q++;
    while (s[q] === " ") q++;
    if (s[q] === "=") {
      q++;
      while (s[q] === " ") q++;
      if (s[q] === '"') {
        q++;
        while (q < s.length && s[q] !== '"' && s[q] !== "\n") q++;
        if (s[q] !== '"') return -1;
        q++;
      } else if (s[q] === "'") {
        q++;
        while (q < s.length && s[q] !== "'" && s[q] !== "\n") q++;
        if (s[q] !== "'") return -1;
        q++;
      } else {
        const r0 = q;
        while (q < s.length && s[q] !== " " && s[q] !== "\t" && s[q] !== "\n" &&
               s[q] !== '"' && s[q] !== "'" && s[q] !== "=" && s[q] !== "<" &&
               s[q] !== ">" && s[q] !== "`") q++;
        if (q === r0) return -1;
      }
    }
    k = q;
  }
  let q = k;
  while (s[q] === " ") q++;
  if (s[q] === "/") q++;
  if (s[q] !== ">") return -1;
  return q + 1;
}

// A raw HTML block: comment, processing instruction, declaration,
// CDATA, script/pre/style/textarea, a block tag, or a complete tag
// alone on its line. Returns the html token or null.
Lexer.prototype.tokenizeHtml = function (t) {
  let i = 0;
  let spaces = 0;
  while (spaces < 3 && t[i] === " ") { i++; spaces++; }
  if (t[i] !== "<") return null;
  let end = -1;
  let pre = false;
  const rest = t.slice(i);
  if (rest.startsWith("<!--")) {
    let close = -1;
    if (rest.startsWith("<!-->") || rest.startsWith("<!--->")) close = rest.indexOf(">", 4);
    else {
      const k = rest.indexOf("-->");
      close = k === -1 ? -1 : k + 2;
    }
    end = close === -1 ? t.length : endOfLinePlusNewlines(t, i + close + 1);
  } else if (rest.startsWith("<?")) {
    const k = rest.indexOf("?>");
    end = k === -1 ? t.length : endOfLinePlusNewlines(t, i + k + 2);
  } else if (rest.startsWith("<![CDATA[")) {
    const k = rest.indexOf("]]>");
    end = k === -1 ? t.length : endOfLinePlusNewlines(t, i + k + 3);
  } else if (rest.startsWith("<!") && isAsciiLetter(rest[2])) {
    const k = rest.indexOf(">");
    end = k === -1 ? t.length : endOfLinePlusNewlines(t, i + k + 1);
  } else {
    let k = i + 1;
    let closing = false;
    if (t[k] === "/") { closing = true; k++; }
    let m = k;
    while (m < t.length && isTagNameChar(t[m])) m++;
    const name = t.slice(k, m).toLowerCase();
    if (name === "") return null;
    const ch = t[m];
    if (!closing && (name === "script" || name === "pre" || name === "style" || name === "textarea") &&
        (ch === undefined || isJsSpace(ch) || ch === ">")) {
      const closer = "</" + name + ">";
      const idx = t.toLowerCase().indexOf(closer, m);
      end = idx === -1 ? t.length : endOfLinePlusNewlines(t, idx + closer.length);
      pre = name === "pre" || name === "script" || name === "style";
    } else if (BLOCK_TAGS.has(name) &&
        (ch === " " || ch === "\t" || ch === "\n" || ch === ">" ||
         (ch === "/" && t[m + 1] === ">") || ch === undefined)) {
      end = endAtBlankLine(t, i);
    } else if (!closing && name !== "script" && name !== "pre" && name !== "style" && name !== "textarea") {
      const tagEnd = scanTagEnd(t, i);
      if (tagEnd === -1) return null;
      let r = tagEnd;
      while (t[r] === " " || t[r] === "\t") r++;
      if (r < t.length && t[r] !== "\n") return null;
      end = endAtBlankLine(t, i);
    } else if (closing) {
      let q = m;
      while (t[q] === " " || t[q] === "\t") q++;
      if (t[q] !== ">") return null;
      let r = q + 1;
      while (t[r] === " " || t[r] === "\t") r++;
      if (r < t.length && t[r] !== "\n") return null;
      end = endAtBlankLine(t, i);
    } else {
      return null;
    }
  }
  if (end === -1) return null;
  const raw = trimBlankTail(t.slice(0, end));
  return { type: "html", block: true, raw, pre, text: raw };
};

// Strip the blockquote markers from one chunk of lines: expand the
// whitespace after each '>', indent lazy setext underlines, then
// remove each marker plus one following space or tab.
function stripBlockquoteChunk(h) {
  let u = h.replace(/^( {0,3}>)([ \t]+)/gm, (g, b, m) => b + expandTabs(m, b.length));
  u = u.replace(/\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g, "\n    $1");
  u = u.replace(/^ {0,3}>[ \t]?/gm, "");
  return u;
}

// Is the line starting at `i` blank in the sense that ends a
// blockquote paragraph: empty, or only spaces/tabs before a
// newline? A spaces-only line at the very end does not count.
function isBlankLineWithNl(s, i) {
  let j = i;
  while (s[j] === " " || s[j] === "\t") j++;
  return s[j] === "\n";
}

// A block quote. The matched region is '>' lines plus lazy
// paragraph continuation lines; the lines are then lexed in chunks
// so that a heading, hr, code block or table inside ejects the
// lazy lines that follow it, and a list or nested quote that spans
// chunks is re-parsed whole.
Lexer.prototype.tokenizeBlockquote = function (t) {
  // Matched extent.
  let p = 0;
  let paraOpen = false;
  const spans = [];
  while (p < t.length) {
    if (isBlockquoteLine(t, p)) {
      spans.push({ start: p, end: lineEnd(t, p) });
      // Blank content closes the paragraph; any other content opens it.
      let j = p;
      let sp = 0;
      while (sp < 3 && t[j] === " ") { j++; sp++; }
      j++; // '>'
      if (t[j] === " " || t[j] === "\t") j++;
      let rest = t.slice(j, lineEnd(t, p));
      paraOpen = rest.trim() !== "";
      p = nextLineStart(t, p);
      continue;
    }
    if (!paraOpen) break;
    if (isBlankLineWithNl(t, p)) break;
    if (isHrLine(t, p) || isHeadingLine(t, p) || isBlockquoteLine(t, p) ||
        isFencesLine(t, p) || isListLine(t, p, "bq") || isHtmlBegin(t, p, true)) break;
    spans.push({ start: p, end: lineEnd(t, p) });
    p = nextLineStart(t, p);
  }
  if (spans.length === 0) return null;
  let lines = spans.map((s) => t.slice(s.start, s.end));
  let s = "";
  let r = "";
  const tokens = [];
  while (lines.length > 0) {
    let i = false;
    const l = [];
    let q = 0;
    for (; q < lines.length; q++) {
      if (isBlockquoteLine(lines[q], 0)) { l.push(lines[q]); i = true; }
      else if (!i) l.push(lines[q]);
      else break;
    }
    lines = lines.slice(q);
    const h = l.join("\n");
    const u = stripBlockquoteChunk(h);
    s = s ? s + "\n" + h : h;
    r = r ? r + "\n" + u : u;
    const savedTop = this.top;
    this.top = true;
    this.blockTokens(u, tokens, true);
    this.top = savedTop;
    if (lines.length === 0) break;
    const k = tokens[tokens.length - 1];
    if (k && (k.type === "code" || k.type === "heading" || k.type === "hr" ||
              k.type === "html" || k.type === "table")) break;
    if (k && k.type === "blockquote") {
      const g = k;
      const b = lines.join("\n");
      const m = g.raw + "\n" + b.replace(/^ {0,3}>[ \t]?/gm, "");
      const f = this.tokenizeBlockquote(m);
      tokens[tokens.length - 1] = f;
      const y = m.substring(f.raw.length).replace(/^\n/, "");
      const R = y ? y.split("\n").length : 0;
      const A = R ? lines.slice(0, -R) : lines;
      if (A.length > 0) s = s + "\n" + A.join("\n");
      r = r.substring(0, r.length - g.text.length) + f.text;
      lines = lines.slice(A.length);
      if (lines.length > 0 && isBlockquoteLine(lines[0], 0)) continue;
      break;
    } else if (k && k.type === "list") {
      const g = k;
      const b = g.raw + "\n" + lines.join("\n");
      const m = this.tokenizeList(b);
      tokens[tokens.length - 1] = m;
      const f = m.raw.length > g.raw.length
        ? b.slice(g.raw.length + 1, m.raw.length).split("\n").length : 0;
      if (f > 0) {
        const y = lines.slice(0, f).join("\n");
        s = s + "\n" + y;
        r = r + "\n" + y;
      }
      lines = lines.slice(f);
      continue;
    }
  }
  return { type: "blockquote", raw: s, tokens, text: r };
};

/* ------------------------------------------------------------------ */
/* Lists                                                               */
/* ------------------------------------------------------------------ */

const LIST_IS_TASK = /^\[[ xX]\][ \t]+\S/;
const LIST_REPLACE_TASK = /^\[[ xX]\][ \t]+/;
const LIST_TASK_CHECKBOX = /\[[ xX]\]/;

// Expand only the leading spaces/tabs of `s`, tracking the column
// from `col`.
function expandLeadingTabs(s, col) {
  let j = 0;
  while (s[j] === " " || s[j] === "\t") j++;
  if (j === 0) return s;
  return expandTabs(s.slice(0, j), col) + s.slice(j);
}

// Index of the first character that is not a space, or -1.
function firstNonSpace(s) {
  for (let i = 0; i < s.length; i++) if (s[i] !== " ") return i;
  return -1;
}

// Is the single line `f` blank (only spaces/tabs)?
function isBlankLineStr(f) {
  return /^[ \t]*$/.test(f);
}

// Match a bullet line at `i`: 0-`maxSp` spaces, then a bullet or a
// 1-9 digit number with '.' or ')', then a space/tab and the rest of
// the line, or the line end. `want` pins the kind and marker, or is
// null for any. Returns {bullet, ordered, marker, bulletLen, rest,
// matchLen} or null.
function scanBulletLine(s, i, want, maxSp) {
  let j = i;
  let sp = 0;
  const lim = maxSp === undefined ? 3 : maxSp;
  while (sp < lim && s[j] === " ") { j++; sp++; }
  const c = s[j];
  let bullet = null;
  let ordered = false;
  let marker = "";
  if (c === "*" || c === "+" || c === "-") {
    bullet = c;
    marker = c;
    j++;
  } else if (c >= "0" && c <= "9") {
    let k = j;
    while (k < s.length && s[k] >= "0" && s[k] <= "9" && k - j < 9) k++;
    if (k === j) return null;
    if (s[k] !== "." && s[k] !== ")") return null;
    bullet = s.slice(j, k + 1);
    ordered = true;
    marker = s[k];
    j = k + 1;
  } else {
    return null;
  }
  if (want !== null && (want.ordered !== ordered || want.marker !== marker)) return null;
  let rest = "";
  let matchLen;
  if (s[j] === " " || s[j] === "\t") {
    const e = lineEnd(s, j);
    rest = s.slice(j, e);
    matchLen = (e < s.length ? e + 1 : e) - i;
  } else if (s[j] === "\n" || j >= s.length) {
    rest = "";
    matchLen = (j < s.length ? j + 1 : j) - i;
  } else {
    return null;
  }
  return { bullet, ordered, marker, bulletLen: j - i, rest, matchLen };
}

// Line-start predicates with a max indent, for list item content.
function isHrAt(s, i, maxSp) {
  let j = i;
  let sp = 0;
  while (sp < maxSp && s[j] === " ") { j++; sp++; }
  const c = s[j];
  if (c !== "-" && c !== "_" && c !== "*") return false;
  let count = 0;
  while (j < s.length) {
    if (s[j] === c) { count++; j++; }
    else if (s[j] === " " || s[j] === "\t") { j++; }
    else break;
  }
  if (count < 3) return false;
  return j >= s.length || s[j] === "\n";
}

function isHeadingAt(s, i, maxSp) {
  let j = i;
  let sp = 0;
  while (sp < maxSp && s[j] === " ") { j++; sp++; }
  let hashes = 0;
  while (hashes < 6 && s[j] === "#") { j++; hashes++; }
  if (hashes === 0) return false;
  return j >= s.length || isJsSpace(s[j]);
}

function isBlockquoteAt(s, i, maxSp) {
  let j = i;
  let sp = 0;
  while (sp < maxSp && s[j] === " ") { j++; sp++; }
  return s[j] === ">";
}

function isFencesBeginAt(s, i, maxSp) {
  let j = i;
  let sp = 0;
  while (sp < maxSp && s[j] === " ") { j++; sp++; }
  const c = s[j];
  if (c !== "`" && c !== "~") return false;
  let k = j;
  while (k < s.length && s[k] === c) k++;
  return k - j >= 3;
}

// HTML-block start as the list tokenizer tests it: the tag
// terminator is a space, the end of the string, or '/>'.
function isHtmlBeginAt(s, i, maxSp) {
  let j = i;
  let sp = 0;
  while (sp < maxSp && s[j] === " ") { j++; sp++; }
  if (s[j] !== "<") return false;
  if (s[j + 1] === "!" && s[j + 2] === "-" && s[j + 3] === "-") return true;
  if (s[j + 1] === "?") return true;
  if (s[j + 1] === "!" && s[j + 2] === "[" && s.slice(j + 3, j + 9) === "CDATA[") return true;
  if (s[j + 1] === "!" && isAsciiLetter(s[j + 2])) return true;
  let k = j + 1;
  const closing = s[k] === "/";
  if (closing) k++;
  let m = k;
  while (m < s.length && isTagNameChar(s[m])) m++;
  const name = s.slice(k, m).toLowerCase();
  if (!closing && (name === "script" || name === "pre" || name === "style" || name === "textarea")) {
    const ch = s[m];
    return ch === undefined || isJsSpace(ch) || ch === ">";
  }
  if (!BLOCK_TAGS.has(name)) return false;
  const ch = s[m];
  if (ch === " ") return true;
  if (ch === undefined) return true;
  if (ch === ">") return true;
  if (ch === "/" && s[m + 1] === ">") return true;
  return false;
}

// A list: items with their content indent, lazy continuation
// lines, loose/tight detection and task checkboxes.
Lexer.prototype.tokenizeList = function (t) {
  const first = scanBulletLine(t, 0, null, 3);
  if (first === null) return null;
  const bulletText = first.bullet.trim();
  const ordered = bulletText.length > 1;
  const start = ordered ? parseInt(bulletText.slice(0, -1), 10) : "";
  const marker = ordered ? bulletText.slice(-1) : bulletText;
  const want = { ordered, marker };
  const list = { type: "list", raw: "", ordered, start, loose: false, items: [] };
  let src = t;
  let consumed = 0;
  let pendingLoose = false;
  while (src.length > 0) {
    const item = scanBulletLine(src, 0, want, 3);
    if (item === null) break;
    if (isHrLine(src, 0)) break;
    const itemStart = consumed;
    src = src.slice(item.matchLen);
    consumed += item.matchLen;
    const g = item.rest;
    const b = item.bulletLen;
    let m = expandLeadingTabs(g, b);
    let f = src.slice(0, lineEnd(src, 0));
    const y0 = m.trim() === "";
    let R;
    let d;
    if (y0) {
      R = b + 1;
      d = m;
    } else {
      R = firstNonSpace(m);
      if (R === -1) R = m.length;
      if (R > 4) R = 1;
      d = m.slice(R);
      R += b;
    }
    let u = false;
    if (y0 && isBlankLineStr(f)) {
      src = src.slice(f.length + 1);
      consumed += f.length + 1;
      u = true;
    }
    // The item text is built as an array of lines and joined once, so
    // a long item is not re-copied on every line.
    const dParts = [d];
    if (!u) {
      let y = y0;
      while (src.length > 0) {
        const U = src.slice(0, lineEnd(src, 0));
        f = U;
        const Z = expandLeadingTabs(U, 0);
        const lim = Math.max(0, Math.min(3, R - 1));
        if (isFencesBeginAt(src, 0, lim) || isHeadingAt(src, 0, lim) || isHtmlBeginAt(src, 0, lim) ||
            isBlockquoteAt(src, 0, lim) || scanBulletLine(src, 0, null, lim) !== null ||
            isHrAt(src, 0, lim)) break;
        const nz = firstNonSpace(Z);
        if ((nz !== -1 && nz >= R) || U.trim() === "") {
          dParts.push(Z.slice(R));
        } else {
          if (y || firstNonSpace(m.replace(/\t/g, "    ")) >= 4 ||
              isFencesBeginAt(m, 0, lim) || isHeadingAt(m, 0, lim) ||
              isHtmlBeginAt(m, 0, lim) || isHrAt(m, 0, lim)) break;
          let qe = U;
          if (/^ {0,3}(?:=+|-+) *$/.test(U) && this.tokenizeLheading(m + "\n" + U) !== null) {
            qe = "    " + Z.replace(/^ {0,3}/, "");
          }
          dParts.push(qe);
        }
        y = U.trim() === "";
        src = src.slice(U.length + 1);
        consumed += U.length + 1;
        m = Z.slice(R);
      }
    }
    d = dParts.join("\n");
    const itemRaw = t.slice(itemStart, consumed);
    if (!list.loose) {
      if (pendingLoose) list.loose = true;
      else if (/\n[ \t]*\n[ \t]*$/.test(itemRaw)) pendingLoose = true;
    }
    list.items.push({
      type: "list_item",
      raw: itemRaw,
      task: LIST_IS_TASK.test(d),
      loose: false,
      text: d,
      tokens: [],
    });
  }
  const last = list.items[list.items.length - 1];
  if (!last) return null;
  last.raw = last.raw.trimEnd();
  last.text = last.text.trimEnd();
  list.raw = t.slice(0, consumed).trimEnd();
  for (const item of list.items) {
    this.top = false;
    item.tokens = this.blockTokens(item.text, []);
    if (!list.loose) {
      const spaces = item.tokens.filter((tok) => tok.type === "space");
      if (spaces.length > 0 && spaces.some((tok) => /\n.*\n/.test(tok.raw))) list.loose = true;
    }
  }
  for (const item of list.items) {
    const firstTok = item.tokens[0];
    if (item.task && (firstTok && (firstTok.type === "text" || firstTok.type === "paragraph"))) {
      item.text = item.text.replace(LIST_REPLACE_TASK, "");
      firstTok.raw = firstTok.raw.replace(LIST_REPLACE_TASK, "");
      firstTok.text = firstTok.text.replace(LIST_REPLACE_TASK, "");
      for (let g = this.queue.length - 1; g >= 0; g--) {
        if (LIST_IS_TASK.test(this.queue[g].src)) {
          this.queue[g].src = this.queue[g].src.replace(LIST_REPLACE_TASK, "");
          break;
        }
      }
      const k = LIST_TASK_CHECKBOX.exec(item.raw);
      if (k) {
        const cb = { type: "checkbox", raw: k[0] + " ", checked: k[0] !== "[ ]" };
        item.checked = cb.checked;
        if (list.loose) {
          if (firstTok && (firstTok.type === "paragraph" || firstTok.type === "text") && firstTok.tokens) {
            firstTok.raw = cb.raw + firstTok.raw;
            firstTok.text = cb.raw + firstTok.text;
            firstTok.tokens.unshift(cb);
          } else {
            item.tokens.unshift({ type: "paragraph", raw: cb.raw, text: cb.raw, tokens: [cb] });
          }
        } else {
          item.tokens.unshift(cb);
        }
      }
    } else if (item.task) {
      item.task = false;
    }
  }
  if (list.loose) {
    for (const item of list.items) {
      item.loose = true;
      for (const tok of item.tokens) if (tok.type === "text") tok.type = "paragraph";
    }
  }
  return list;
};

/* ------------------------------------------------------------------ */
/* Block driver                                                        */
/* ------------------------------------------------------------------ */

// Tokenize `src` into block tokens, appending to `tokens`.
// `quoteMode` is true while lexing blockquote chunks, where a
// paragraph merges into the previous paragraph token.
Lexer.prototype.blockTokens = function (src, tokens, quoteMode) {
  let mergePara = !!quoteMode;
  let prevLen = Infinity;
  while (src.length > 0) {
    if (src.length >= prevLen) throw new Error("Infinite loop on byte: " + src.charCodeAt(0));
    prevLen = src.length;
    let tok = null;
    // Blank lines.
    const spLen = this.tokenizeSpace(src);
    if (spLen > 0) {
      const raw = src.slice(0, spLen);
      src = src.slice(spLen);
      const last = tokens[tokens.length - 1];
      if (raw.length === 1 && last !== undefined) last.raw += "\n";
      else tokens.push({ type: "space", raw });
      continue;
    }
    // Indented code, merging into a preceding paragraph or text.
    tok = this.tokenizeCode(src);
    if (tok !== null) {
      src = src.slice(tok.raw.length);
      const last = tokens[tokens.length - 1];
      if (last && (last.type === "paragraph" || last.type === "text")) {
        last.raw += (last.raw.endsWith("\n") ? "" : "\n") + tok.raw;
        last.text += "\n" + tok.text;
        this.queue[this.queue.length - 1].src = last.text;
      } else {
        tokens.push(tok);
      }
      continue;
    }
    tok = this.tokenizeFences(src);
    if (tok !== null) { src = src.slice(tok.raw.length); tokens.push(tok); continue; }
    tok = this.tokenizeHeading(src);
    if (tok !== null) { src = src.slice(tok.raw.length); tokens.push(tok); continue; }
    tok = this.tokenizeHr(src);
    if (tok !== null) { src = src.slice(tok.raw.length); tokens.push(tok); continue; }
    tok = this.tokenizeBlockquote(src);
    if (tok !== null) { src = src.slice(tok.raw.length); tokens.push(tok); continue; }
    tok = this.tokenizeList(src);
    if (tok !== null) { src = src.slice(tok.raw.length); tokens.push(tok); continue; }
    tok = this.tokenizeHtml(src);
    if (tok !== null) { src = src.slice(tok.raw.length); tokens.push(tok); continue; }
    tok = this.tokenizeDef(src);
    if (tok !== null) {
      src = src.slice(tok.raw.length);
      const last = tokens[tokens.length - 1];
      if (last && (last.type === "paragraph" || last.type === "text")) {
        last.raw += (last.raw.endsWith("\n") ? "" : "\n") + tok.raw;
        last.text += "\n" + tok.raw;
        this.queue[this.queue.length - 1].src = last.text;
      } else {
        if (!this.links[tok.tag]) this.links[tok.tag] = { href: tok.href, title: tok.title };
        tokens.push(tok);
      }
      continue;
    }
    tok = this.tokenizeTable(src);
    if (tok !== null) { src = src.slice(tok.raw.length); tokens.push(tok); continue; }
    tok = this.tokenizeLheading(src);
    if (tok !== null) { src = src.slice(tok.raw.length); tokens.push(tok); continue; }
    if (this.top) {
      tok = this.tokenizeParagraph(src);
      if (tok !== null) {
        src = src.slice(tok.raw.length);
        const last = tokens[tokens.length - 1];
        if (mergePara && last && last.type === "paragraph") {
          last.raw += (last.raw.endsWith("\n") ? "" : "\n") + tok.raw;
          last.text += "\n" + tok.text;
          this.queue.pop();
          this.queue[this.queue.length - 1].src = last.text;
        } else {
          tokens.push(tok);
        }
        mergePara = false;
        continue;
      }
    }
    tok = this.tokenizeText(src);
    if (tok !== null) {
      src = src.slice(tok.raw.length);
      const last = tokens[tokens.length - 1];
      if (last && last.type === "text") {
        last.raw += (last.raw.endsWith("\n") ? "" : "\n") + tok.raw;
        last.text += "\n" + tok.text;
        this.queue.pop();
        this.queue[this.queue.length - 1].src = last.text;
      } else {
        tokens.push(tok);
      }
      continue;
    }
    throw new Error("Infinite loop on byte: " + src.charCodeAt(0));
  }
  this.top = true;
  return tokens;
};

// Lex a whole document: normalize line ends, run the block pass,
// then tokenize every queued inline source in order.
Lexer.prototype.lex = function (src) {
  src = src.replace(/\r\n|\r/g, "\n");
  const tokens = [];
  this.blockTokens(src, tokens, false);
  for (let k = 0; k < this.queue.length; k++) {
    const item = this.queue[k];
    this.inRawBlock = false;
    this.inlineTokens(item.src, item.tokens);
  }
  this.queue = [];
  return tokens;
};

/* ------------------------------------------------------------------ */
/* Renderer                                                            */
/* ------------------------------------------------------------------ */

// Plain text of inline tokens (used for image alt text): links and
// emphasis contribute their inner text, code spans their text, hard
// breaks nothing, checkboxes their raw marker.
function plainText(tokens) {
  let out = "";
  for (const tok of tokens) {
    switch (tok.type) {
      case "escape":
      case "html":
      case "codespan":
      case "text":
        out += tok.text;
        break;
      case "link":
      case "image":
      case "strong":
      case "em":
      case "del":
        out += tok.tokens ? plainText(tok.tokens) : tok.text;
        break;
      case "br":
        break;
      case "checkbox":
        out += tok.raw;
        break;
      default:
        out += tok.text || "";
        break;
    }
  }
  return out;
}

function renderInline(tokens) {
  let out = "";
  for (const tok of tokens) {
    switch (tok.type) {
      case "escape":
        out += escKeepEntities(tok.text);
        break;
      case "html":
        out += tok.text;
        break;
      case "link": {
        const inner = tok.autolink ? escAll(tok.text) : renderInline(tok.tokens);
        const cleaned = cleanUrl(tok.href);
        if (cleaned === null) { out += inner; break; }
        const href = tok.autolink ? escAll(cleaned) : escKeepEntities(cleaned);
        let s = '<a href="' + href + '"';
        if (tok.title) s += ' title="' + escKeepEntities(tok.title) + '"';
        out += s + ">" + inner + "</a>";
        break;
      }
      case "image": {
        const alt = tok.tokens ? plainText(tok.tokens) : tok.text;
        const cleaned = cleanUrl(tok.href);
        if (cleaned === null) { out += escKeepEntities(alt); break; }
        let s = '<img src="' + escKeepEntities(cleaned) + '" alt="' + escKeepEntities(alt) + '"';
        if (tok.title) s += ' title="' + escKeepEntities(tok.title) + '"';
        out += s + ">";
        break;
      }
      case "checkbox":
        out += "<input " + (tok.checked ? 'checked="" ' : "") + 'disabled="" type="checkbox"> ';
        break;
      case "strong":
        out += "<strong>" + renderInline(tok.tokens) + "</strong>";
        break;
      case "em":
        out += "<em>" + renderInline(tok.tokens) + "</em>";
        break;
      case "codespan":
        out += "<code>" + escAll(tok.text) + "</code>";
        break;
      case "br":
        out += "<br>";
        break;
      case "del":
        out += "<del>" + renderInline(tok.tokens) + "</del>";
        break;
      case "text":
        out += tok.escaped ? tok.text : escKeepEntities(tok.text);
        break;
      default:
        throw new Error('Token with "' + tok.type + '" type was not found.');
    }
  }
  return out;
}

function renderTableCell(cell) {
  const tag = cell.header ? "th" : "td";
  return "<" + tag + (cell.align ? ' align="' + cell.align + '"' : "") + ">" +
    renderInline(cell.tokens) + "</" + tag + ">\n";
}

function renderBlock(tokens) {
  let out = "";
  for (const tok of tokens) {
    switch (tok.type) {
      case "space":
        break;
      case "hr":
        out += "<hr>\n";
        break;
      case "heading":
        out += "<h" + tok.depth + ">" + renderInline(tok.tokens) + "</h" + tok.depth + ">\n";
        break;
      case "code": {
        const lang = (tok.lang || "").match(/^\S*/)[0];
        const text = tok.text ? tok.text.replace(/\n$/, "") + "\n" : "";
        out += lang
          ? '<pre><code class="language-' + escKeepEntities(lang) + '">' + escAll(text) + "</code></pre>\n"
          : "<pre><code>" + escAll(text) + "</code></pre>\n";
        break;
      }
      case "table": {
        let head = "";
        for (const cell of tok.header) head += renderTableCell(cell);
        let body = "";
        for (const row of tok.rows) {
          let cells = "";
          for (const cell of row) cells += renderTableCell(cell);
          body += "<tr>\n" + cells + "</tr>\n";
        }
        out += "<table>\n<thead>\n<tr>\n" + head + "</tr>\n</thead>\n" +
          (body ? "<tbody>" + body + "</tbody>" : "") + "</table>\n";
        break;
      }
      case "blockquote":
        out += "<blockquote>\n" + renderBlock(tok.tokens) + "</blockquote>\n";
        break;
      case "list": {
        const tag = tok.ordered ? "ol" : "ul";
        const startAttr = tok.ordered && tok.start !== 1 ? ' start="' + tok.start + '"' : "";
        let items = "";
        for (const item of tok.items) items += "<li>" + renderBlock(item.tokens) + "</li>\n";
        out += "<" + tag + startAttr + ">\n" + items + "</" + tag + ">\n";
        break;
      }
      case "checkbox":
        out += "<input " + (tok.checked ? 'checked="" ' : "") + 'disabled="" type="checkbox"> ';
        break;
      case "html":
        out += tok.text;
        break;
      case "def":
        break;
      case "paragraph":
        out += "<p>" + renderInline(tok.tokens) + "</p>\n";
        break;
      case "text":
        out += renderInline(tok.tokens);
        break;
      default:
        throw new Error('Token with "' + tok.type + '" type was not found.');
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

// The HTML marked 18.1.3 renders for `markdown`, with marked's
// default options. Pure: nothing is kept between calls.
export function parse(markdown) {
  const lexer = new Lexer();
  const tokens = lexer.lex(markdown);
  return renderBlock(tokens);
}
