import { describe, expect, it } from 'vitest';
import { errorResponse, formatMoney, generateId, intParam, jsonResponse, readJson, slugify } from '../utils';

describe('generateId', () => {
  it('prefixes and is unique', () => {
    const a = generateId('crs');
    expect(a).toMatch(/^crs_[0-9a-z]+$/);
    expect(generateId('crs')).not.toBe(a);
  });
});

describe('slugify', () => {
  it.each([
    ['Intro to AI!', 'intro-to-ai'],
    ['  --Hello   World__again-- ', 'hello-world-again'],
    ['Ünïcode & symbols', 'ncode-symbols'],
    ['', ''],
    ['!!!', ''],
    ['tab\tand\nnewline', 'tab-and-newline'],
  ])('%j → %j', (input, expected) => {
    expect(slugify(input)).toBe(expected);
  });

  it('caps the slug at 80 characters', () => {
    expect(slugify('a'.repeat(200))).toHaveLength(80);
  });
});

describe('formatMoney', () => {
  it('formats cents in CAD by default and in another currency on request', () => {
    expect(formatMoney(12345)).toContain('123.45');
    expect(formatMoney(500, 'USD')).toContain('5.00');
  });
});

describe('responses', () => {
  it('jsonResponse / errorResponse set body and status', async () => {
    const ok = jsonResponse({ a: 1 });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ a: 1 });
    const created = jsonResponse({ a: 1 }, 201);
    expect(created.status).toBe(201);
    const bad = errorResponse('nope');
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: 'nope' });
    expect(errorResponse('gone', 404).status).toBe(404);
  });
});

describe('readJson', () => {
  const req = (body: string) => new Request('https://x.test', { method: 'POST', body });

  it('returns the parsed object', async () => {
    expect(await readJson(req('{"a":1}'))).toEqual({ body: { a: 1 } });
  });

  it.each(['{nope', 'null', '[1]', '"str"', '3'])('rejects %s with a 400', async (raw) => {
    const result = await readJson(req(raw));
    expect('response' in result && result.response.status).toBe(400);
  });
});

describe('intParam', () => {
  it('falls back on absent/garbage, parses numbers, and clamps', () => {
    expect(intParam(null, 20, 1, 100)).toBe(20);
    expect(intParam('abc', 20, 1, 100)).toBe(20);
    expect(intParam('7', 20, 1, 100)).toBe(7);
    expect(intParam('0', 20, 1, 100)).toBe(1);
    expect(intParam('500', 20, 1, 100)).toBe(100);
    expect(intParam('-3', 0, 0, 50)).toBe(0);
  });
});
