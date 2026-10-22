// Find the inline <script> elements of an HTML document, the way the HTML tokenizer does: a
// `<script` inside an attribute value (a code sample's `data-code="…"`), an HTML comment or a
// raw-text element (<textarea>, <title>, <style>, …) is text, not an element, so it is never
// returned. Used by collect-csp-hashes.mjs, where every returned body lands on the CSP allowlist.
//
// Returns the text of each `<script>` that has no `src` attribute and a non-empty body, whatever
// its `type` (classic, module, importmap, JSON data blocks: the same set the old regex took).

const RAW_TEXT = new Set([
  "style",
  "textarea",
  "title",
  "xmp",
  "iframe",
  "noembed",
  "noframes",
  "plaintext",
]);
// Char codes, not one-character strings or regexes: this runs over ~60 MB of built HTML, and the
// string-indexing form was minutes slow on Node 22 (GC churn), seconds on Node 26.
// `</name` followed by whitespace, `/`, `>` or the end. Not `html.toLowerCase()`: that is seconds
// per large page on Node 22.
const closers = new Map(
  ["script", ...RAW_TEXT].map((n) => [
    n,
    new RegExp(`</${n}(?=[\\t\\n\\f\\r />]|$)`, "gi"),
  ]),
);
const isSpace = (c) => c === 9 || c === 10 || c === 12 || c === 13 || c === 32;
const isAlpha = (c) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
const QUOTE_D = 34;
const QUOTE_S = 39;
const GT = 62;
const EQ = 61;
const SLASH = 47;

/** Index just past the `>` that ends the tag whose attributes start at `i`; quoted values may hold `>`. */
function tagEnd(html, i) {
  let quote = 0;
  for (; i < html.length; i += 1) {
    const c = html.charCodeAt(i);
    if (quote) {
      if (c === quote) quote = 0;
    } else if (c === QUOTE_D || c === QUOTE_S) {
      // A quote opens a value only straight after `=` (whitespace allowed), as in the tokenizer.
      let j = i - 1;
      while (j >= 0 && isSpace(html.charCodeAt(j))) j -= 1;
      if (j >= 0 && html.charCodeAt(j) === EQ) quote = c;
    } else if (c === GT) return i + 1;
  }
  return html.length;
}

/** Attribute names present in a tag's source (between the tag name and `>`). */
function attrNames(src) {
  const names = new Set();
  const re =
    /([^\t\n\f\r \/>=][^\t\n\f\r \/>=]*)(?:[\t\n\f\r ]*=[\t\n\f\r ]*(?:"[^"]*"|'[^']*'|[^\t\n\f\r >]*))?/gy;
  let m;
  let i = 0;
  while (i < src.length) {
    if (isSpace(src.charCodeAt(i)) || src.charCodeAt(i) === SLASH) {
      i += 1;
      continue;
    }
    re.lastIndex = i;
    m = re.exec(src);
    if (!m) {
      i += 1;
      continue;
    }
    names.add(m[1].toLowerCase());
    i = re.lastIndex;
  }
  return names;
}

export function inlineScripts(html) {
  const found = [];
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt < 0) break;
    if (html.startsWith("<!--", lt)) {
      // `<!-->` and `<!--->` close immediately; otherwise up to the next `-->`.
      const start = html.startsWith("<!-->", lt)
        ? lt + 5
        : html.startsWith("<!--->", lt)
          ? lt + 6
          : lt + 4;
      const end = start > lt + 4 ? start : html.indexOf("-->", start);
      i = end < 0 ? html.length : start > lt + 4 ? end : end + 3;
      continue;
    }
    const c1 = html.charCodeAt(lt + 1);
    const closing = c1 === SLASH;
    const nameStart = lt + (closing ? 2 : 1);
    if (
      c1 === 33 ||
      c1 === 63 ||
      (closing && !isAlpha(html.charCodeAt(nameStart)))
    ) {
      i = tagEnd(html, lt + 2); // doctype, CDATA, bogus comment: ends at the next `>`
      continue;
    }
    if (!isAlpha(html.charCodeAt(nameStart))) {
      i = lt + 1;
      continue;
    }
    let nameEnd = nameStart;
    while (nameEnd < html.length) {
      const c = html.charCodeAt(nameEnd);
      if (isSpace(c) || c === SLASH || c === GT) break;
      nameEnd += 1;
    }
    const name = html.slice(nameStart, nameEnd).toLowerCase();
    const attrsStart = nameEnd;
    const end = tagEnd(html, attrsStart);
    if (closing || (name !== "script" && !RAW_TEXT.has(name))) {
      i = end;
      continue;
    }
    // Raw text: the body runs to the first `</name` followed by whitespace, `/` or `>`.
    const closeRe = closers.get(name);
    closeRe.lastIndex = end;
    const close = closeRe.exec(html);
    const bodyEnd = close ? close.index : html.length;
    if (name === "script") {
      const body = html.slice(end, bodyEnd);
      const tag = html.slice(attrsStart, end - 1);
      if (body.length > 0 && !attrNames(tag).has("src")) found.push(body);
    }
    i = close ? tagEnd(html, close.index + 2) : html.length;
  }
  return found;
}
