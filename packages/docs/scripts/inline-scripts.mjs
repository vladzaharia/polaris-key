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
const SPACE = /[\t\n\f\r ]/;

/** Index just past the `>` that ends the tag whose attributes start at `i`; quoted values may hold `>`. */
function tagEnd(html, i) {
  let quote = "";
  for (; i < html.length; i += 1) {
    const c = html[i];
    if (quote) {
      if (c === quote) quote = "";
    } else if (c === '"' || c === "'") {
      // A quote opens a value only straight after `=` (whitespace allowed), as in the tokenizer.
      let j = i - 1;
      while (j >= 0 && SPACE.test(html[j])) j -= 1;
      if (html[j] === "=") quote = c;
    } else if (c === ">") return i + 1;
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
    if (SPACE.test(src[i]) || src[i] === "/") {
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
  const lower = html.toLowerCase();
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
    if (
      html[lt + 1] === "!" ||
      html[lt + 1] === "?" ||
      (html[lt + 1] === "/" && !/[a-z]/i.test(html[lt + 2] ?? ""))
    ) {
      i = tagEnd(html, lt + 2); // doctype, CDATA, bogus comment: ends at the next `>`
      continue;
    }
    const nameMatch = /^<(\/?)([a-z][^\t\n\f\r \/>]*)/i.exec(
      html.slice(lt, lt + 40),
    );
    if (!nameMatch) {
      i = lt + 1;
      continue;
    }
    const closing = nameMatch[1] === "/";
    const name = nameMatch[2].toLowerCase();
    const attrsStart = lt + nameMatch[0].length;
    const end = tagEnd(html, attrsStart);
    if (closing || (name !== "script" && !RAW_TEXT.has(name))) {
      i = end;
      continue;
    }
    // Raw text: the body runs to the first `</name` followed by whitespace, `/` or `>`.
    const closeRe = new RegExp(`</${name}(?=[\\t\\n\\f\\r />]|$)`, "g");
    closeRe.lastIndex = end;
    const close = closeRe.exec(lower);
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
