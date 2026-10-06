/**
 * Generate a random ID with prefix
 */
export function generateId(prefix: string): string {
  const random = crypto.randomUUID().replaceAll('-', '').substring(0, 13);
  const timestamp = Date.now().toString(36);
  return `${prefix}_${timestamp}${random}`;
}

/**
 * Generate URL-friendly slug from title
 */
export function slugify(text: string): string {
  let out = '';
  let previousDash = false;
  for (const ch of text.toLowerCase()) {
    const code = ch.codePointAt(0)!;
    const isAlphaNum = (code >= 48 && code <= 57) || (code >= 97 && code <= 122);
    if (isAlphaNum) {
      out += ch;
      previousDash = false;
      continue;
    }
    const isSeparator = ch === ' ' || ch === '\t' || ch === '\n' || ch === '_' || ch === '-';
    if (isSeparator && !previousDash) {
      out += '-';
      previousDash = true;
    }
  }

  let start = 0;
  let end = out.length;
  while (start < end && out[start] === '-') start += 1;
  while (end > start && out[end - 1] === '-') end -= 1;

  return out.slice(start, Math.min(end, start + 80));
}

/**
 * Format cents to dollars
 */
export function formatMoney(cents: number, currency = 'CAD'): string {
  return new Intl.NumberFormat('en-CA', {
    style: 'currency',
    currency,
  }).format(cents / 100);
}

/**
 * Standard JSON response helpers
 */
export function jsonResponse(data: unknown, status = 200) {
  return Response.json(data, { status });
}

export function errorResponse(error: string, status = 400) {
  return Response.json({ error }, { status });
}

/**
 * Parse a request's JSON body. Malformed JSON is a client error (400) rather
 * than an unhandled 500.
 */
export async function readJson(request: Request): Promise<{ body: Record<string, any> } | { response: Response }> {
  try {
    const parsed = await request.json();
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { response: errorResponse('Request body must be a JSON object') };
    }
    return { body: parsed };
  } catch {
    return { response: errorResponse('Invalid JSON body') };
  }
}

/** Parse an integer query param, falling back when absent or not a number, and clamping to [min, max]. */
export function intParam(raw: string | null, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  if (Number.isNaN(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}
