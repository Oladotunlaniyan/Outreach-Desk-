const ALLOWED_TAGS = new Set([
  'p',
  'br',
  'strong',
  'b',
  'em',
  'i',
  'u',
  'ul',
  'ol',
  'li',
  'a',
  'blockquote',
  'h3',
  'h4',
  'div',
  'span',
]);

const SELF_CLOSING_TAGS = new Set(['br']);

const DANGEROUS_BLOCK_REGEX =
  /<\s*(script|style|iframe|object|embed|svg|math|form|input|button|textarea|select|option|link|meta|base|noscript|template)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi;

const DANGEROUS_SINGLE_REGEX =
  /<\s*(script|style|iframe|object|embed|svg|math|form|input|button|textarea|select|option|link|meta|base|img|video|audio|source|track)[^>]*\/?>/gi;

function isSafeHref(rawHref: string): string | null {
  const trimmed = rawHref.trim();
  if (!trimmed) return null;

  // Decode minimal entities and strip ASCII control chars/whitespace before checking protocol
  const cleaned = trimmed
    .replace(/[\u0000-\u0020]+/g, '')
    .replace(/&#(\d+);?/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);?/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .toLowerCase();

  if (
    cleaned.startsWith('https://') ||
    cleaned.startsWith('http://') ||
    cleaned.startsWith('mailto:')
  ) {
    return trimmed.replace(/["<>]/g, '');
  }
  return null;
}

function extractSafeHrefAttribute(rawAttrs: string): string | null {
  const match = rawAttrs.match(
    /(?:^|\s)href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i
  );
  if (!match) return null;
  const candidate = match[1] ?? match[2] ?? match[3] ?? '';
  return isSafeHref(candidate);
}

export function sanitizeEmailHtml(rawHtml: string): string {
  if (!rawHtml || !rawHtml.trim()) return '';

  let sanitized = rawHtml
    // Strip HTML comments
    .replace(/<!--[\s\S]*?-->/g, '')
    // Iteratively remove dangerous container elements
    .replace(DANGEROUS_BLOCK_REGEX, '')
    .replace(DANGEROUS_BLOCK_REGEX, '')
    // Remove self-closing/unclosed dangerous tags
    .replace(DANGEROUS_SINGLE_REGEX, '');

  // Strip disallowed tags and strip all attributes except safe href on <a>
  sanitized = sanitized.replace(
    /<\s*(\/?)\s*([a-zA-Z0-9-]+)([^>]*)>/g,
    (_full, slash: string, rawTag: string, rawAttrs: string) => {
      const tag = rawTag.toLowerCase();
      if (!ALLOWED_TAGS.has(tag)) {
        return '';
      }

      if (slash) {
        return SELF_CLOSING_TAGS.has(tag) ? '' : `</${tag}>`;
      }

      if (tag === 'br') {
        return '<br>';
      }

      if (tag === 'a') {
        const safeHref = extractSafeHrefAttribute(rawAttrs);
        if (!safeHref) {
          return '<a>';
        }
        return `<a href="${safeHref}" rel="noopener noreferrer">`;
      }

      return `<${tag}>`;
    }
  );

  return sanitized.trim();
}

export function textToBasicEmailHtml(text: string): string {
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  const paragraphs = escaped
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${p.replace(/\n/g, '<br>')}</p>`);

  return paragraphs.join('\n');
}
