import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

/**
 * The api-spec is only worth serving if it is true. This ties it to the code:
 * every exported HTTP handler under app/api must be a documented operation,
 * and every documented operation must have a handler.
 */
const API_DIR = join(process.cwd(), 'app', 'api');
const HTTP_METHODS = ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'];

function routeFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry !== '__tests__') out.push(...routeFiles(full));
    } else if (entry === 'route.ts') {
      out.push(full);
    }
  }
  return out;
}

/** `app/api/courses/[slug]/route.ts` → `/api/courses/{slug}` */
function toSpecPath(file: string): string {
  const dir = relative(join(process.cwd(), 'app'), join(file, '..'));
  return '/' + dir.split(sep).join('/').replaceAll(/\[(\w+)\]/g, '{$1}');
}

function exportedMethods(file: string): string[] {
  const source = readFileSync(file, 'utf-8');
  return HTTP_METHODS.filter((m) => new RegExp(String.raw`export (async function|function|const) ${m}\b`).test(source));
}

const spec = parse(readFileSync(join(process.cwd(), 'api-spec', 'openapi.yaml'), 'utf-8'));

const implemented = new Set<string>();
for (const file of routeFiles(API_DIR)) {
  for (const method of exportedMethods(file)) implemented.add(`${method} ${toSpecPath(file)}`);
}

const documented = new Set<string>();
for (const [path, item] of Object.entries<Record<string, unknown>>(spec.paths)) {
  for (const method of Object.keys(item)) documented.add(`${method.toUpperCase()} ${path}`);
}

describe('api-spec ↔ routes', () => {
  it('finds the routes (guards against the walker silently matching nothing)', () => {
    expect(implemented.size).toBeGreaterThan(20);
    expect(implemented.has('GET /api/courses/{slug}')).toBe(true);
  });

  it('documents every implemented operation', () => {
    expect([...implemented].filter((op) => !documented.has(op)).sort()).toEqual([]);
  });

  it('documents nothing that is not implemented', () => {
    expect([...documented].filter((op) => !implemented.has(op)).sort()).toEqual([]);
  });

  it('gives every operation a unique operationId', () => {
    const ids: string[] = [];
    for (const item of Object.values<Record<string, { operationId?: string }>>(spec.paths)) {
      for (const op of Object.values(item)) ids.push(op.operationId ?? '');
    }
    expect(ids.every(Boolean)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('resolves every $ref to a defined schema', () => {
    const text = readFileSync(join(process.cwd(), 'api-spec', 'openapi.yaml'), 'utf-8');
    const refs = [...text.matchAll(/#\/components\/schemas\/(\w+)/g)].map((m) => m[1]);
    for (const name of new Set(refs)) {
      expect(Object.keys(spec.components.schemas)).toContain(name);
    }
  });

  it('only advertises auth schemes it defines, and drops the unimplemented `tag` filter', () => {
    const defined = Object.keys(spec.components.securitySchemes);
    for (const item of Object.values<Record<string, { security?: Record<string, unknown>[] }>>(spec.paths)) {
      for (const op of Object.values(item)) {
        for (const requirement of op.security ?? []) {
          for (const scheme of Object.keys(requirement)) expect(defined).toContain(scheme);
        }
      }
    }
    const params = spec.paths['/api/courses'].get.parameters.map((p: { name: string }) => p.name);
    expect(params).toEqual(['creator_did', 'status', 'limit', 'offset']);
  });
});
