import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { LEARN_DELEGATION_EXCEPTIONS, LEARN_DELEGATION_ROUTES } from '@/lib/auth/delegation';

const ROOT = resolve(__dirname, '../../..');
const MUTATIONS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function routes(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === '__tests__') return [];
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return routes(path);
    return entry.name === 'route.ts' ? [path] : [];
  });
}

/** Include exported functions, wrapped/SDK handlers, named aliases and re-exports. */
function exportedMutations(file: string, text = readFileSync(file, 'utf8')) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const handlers: { method: string; path: string; source: string }[] = [];
  const path = `/${relative(join(ROOT, 'app'), file).replaceAll('\\', '/').slice(0, -'/route.ts'.length)}`;
  function add(method: string, node: ts.Node) {
    if (MUTATIONS.has(method)) handlers.push({ method, path, source: node.getText(source) });
  }
  for (const node of source.statements) {
    if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)) {
      for (const element of node.exportClause.elements) add(element.name.text, node);
    }
    // A wildcard could hide mutating exports in another file: require explicit named exports.
    if (ts.isExportDeclaration(node)) expect(node.exportClause).toBeDefined();
    if (!ts.canHaveModifiers(node) || !ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue;
    if (ts.isFunctionDeclaration(node) && node.name) add(node.name.text, node);
    if (ts.isVariableStatement(node)) {
      for (const declaration of node.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) add(declaration.name.text, declaration);
      }
    }
  }
  return handlers;
}

const handlers = routes(join(ROOT, 'app')).flatMap((file) => exportedMutations(file));
const inventory = [...Object.values(LEARN_DELEGATION_ROUTES), ...LEARN_DELEGATION_EXCEPTIONS];
const signature = (entry: { method: string; path: string }) => `${entry.method} ${entry.path}`;

describe('delegation mutation coverage (#26, events #60 pattern)', () => {
  it('discovers a nonempty inventory and all supported export forms', () => {
    expect(handlers.length).toBeGreaterThanOrEqual(16);
    const fixture = exportedMutations(join(ROOT, 'app/api/fixture/route.ts'), `
      export async function POST() {}
      export const PUT = wrap(handler);
      export { handler as PATCH };
      export { DELETE } from './other';
      export async function GET() {}
    `);
    expect(fixture.map((handler) => handler.method)).toEqual(['POST', 'PUT', 'PATCH', 'DELETE']);
  });

  it.each(handlers)('$method $path has exactly one classification or documented exception', (handler) => {
    expect(inventory.filter((entry) => signature(entry) === signature(handler))).toHaveLength(1);
  });

  it.each(inventory)('$method $path points at exactly one real exported handler', (entry) => {
    expect(entry.why.length).toBeGreaterThan(10);
    expect(handlers.filter((handler) => signature(handler) === signature(entry))).toHaveLength(1);
  });

  it.each(Object.values(LEARN_DELEGATION_ROUTES))('$method $path requires the central policy boundary', (entry) => {
    const handler = handlers.find((candidate) => signature(candidate) === signature(entry));
    expect(handler?.source).toMatch(/\bawait (?:authenticate|requireCourseOwner)\(request[,)]/);
    // Optional auth must never downgrade a denied mutation to anonymous execution.
    expect(handler?.source).not.toMatch(/\bauthenticateOptional\(/);
    if (handler?.source.includes('await authenticate(')) {
      expect(handler.source).toContain('authenticationErrorResponse(authResult)');
    }
  });

  it('keeps the shared owner and authentication helpers connected before effects', () => {
    const owner = readFileSync(join(ROOT, 'src/lib/owner.ts'), 'utf8');
    expect(owner).toContain('await authenticate(request)');
    expect(owner).toContain('authenticationErrorResponse(authResult)');
    expect(owner.indexOf('await authenticate(')).toBeLessThan(owner.indexOf('await getCourseBySlug('));
    const auth = readFileSync(join(ROOT, 'src/lib/auth/authenticate.ts'), 'utf8');
    expect(auth).toContain('await enforceOwnerMutationPolicy(auth, request)');
    expect(auth.indexOf('await enforceOwnerMutationPolicy(')).toBeLessThan(auth.indexOf('return { auth }'));
    expect(auth).toContain('result.proposal ?? { error: result.error }');
  });
});
