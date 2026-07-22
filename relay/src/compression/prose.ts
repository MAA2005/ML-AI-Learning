import { estimateTokens } from "./tokens.js";
import type { CompressionEngine, CompressionResult } from "./types.js";

/**
 * The default (and, for now, only) engine: shrink verbose prose while preserving
 * anything structured byte-for-byte.
 *
 * Protected regions — never altered:
 *   - fenced code blocks  ```...```
 *   - inline code         `...`
 *   - URLs                https://...
 *   - structured JSON     a balanced {...} / [...] span that JSON.parses
 *
 * Everything else is prose, where we collapse redundant whitespace and blank
 * lines. Segmentation is a single left-to-right pass so protected regions can't
 * be partially rewritten.
 */

type Segment = { protected: boolean; text: string };

/** Find a balanced {..}/[..] span starting at `start` that parses as JSON. */
function matchJsonSpan(text: string, start: number): string | null {
  const open = text[start];
  if (open !== "{" && open !== "[") return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let j = start; j < text.length; j++) {
    const c = text[j];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") {
      depth--;
      if (depth === 0) {
        const span = text.slice(start, j + 1);
        try {
          JSON.parse(span);
          return span;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

const URL_AT_START = /^https?:\/\/[^\s]+/;

export function segment(text: string): Segment[] {
  const segments: Segment[] = [];
  let prose = "";
  const flush = () => {
    if (prose) {
      segments.push({ protected: false, text: prose });
      prose = "";
    }
  };

  let i = 0;
  while (i < text.length) {
    // Fenced code block.
    if (text.startsWith("```", i)) {
      const end = text.indexOf("```", i + 3);
      if (end !== -1) {
        flush();
        segments.push({ protected: true, text: text.slice(i, end + 3) });
        i = end + 3;
        continue;
      }
    }
    // Inline code.
    if (text[i] === "`") {
      const end = text.indexOf("`", i + 1);
      if (end !== -1) {
        flush();
        segments.push({ protected: true, text: text.slice(i, end + 1) });
        i = end + 1;
        continue;
      }
    }
    // URL.
    const url = URL_AT_START.exec(text.slice(i));
    if (url) {
      flush();
      segments.push({ protected: true, text: url[0] });
      i += url[0].length;
      continue;
    }
    // Structured JSON span.
    if (text[i] === "{" || text[i] === "[") {
      const span = matchJsonSpan(text, i);
      if (span) {
        flush();
        segments.push({ protected: true, text: span });
        i += span.length;
        continue;
      }
    }
    prose += text[i];
    i++;
  }
  flush();
  return segments;
}

function shrinkProse(s: string): string {
  return s
    .replace(/[ \t]{2,}/g, " ") // runs of spaces/tabs → one space
    .replace(/[ \t]+\n/g, "\n") // trailing spaces before newline
    .replace(/\n{3,}/g, "\n\n"); // 3+ blank lines → one blank line
}

export class ProseShrinkEngine implements CompressionEngine {
  readonly mode = "prose";

  compress(text: string): CompressionResult {
    const before = estimateTokens(text);
    const out = segment(text)
      .map((seg) => (seg.protected ? seg.text : shrinkProse(seg.text)))
      .join("");
    return { text: out, before, after: estimateTokens(out) };
  }
}
