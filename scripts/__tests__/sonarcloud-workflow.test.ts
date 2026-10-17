import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

type Step = { name?: string; uses?: string; run?: string; with?: { args?: string } };
type Job = { needs?: string; if: string; env?: Record<string, string>; steps: Step[] };
const workflow = parse(readFileSync('.github/workflows/sonarcloud.yml', 'utf8'));
const jobs: Record<string, Job> = workflow.jobs;

function script(job: string, name: string): string {
  const run = jobs[job].steps.find(step => step.name === name)?.run;
  expect(run).toBeTypeOf('string');
  return run!;
}

function runScript(run: string, env: Record<string, string>, metadata?: object) {
  const cwd = mkdtempSync(join(tmpdir(), 'learn-sonar-test-'));
  const output = join(cwd, 'output');
  writeFileSync(output, '');
  if (metadata) {
    mkdirSync(join(cwd, 'sonar-payload'));
    writeFileSync(join(cwd, 'sonar-payload/sonar-pr-meta.json'), JSON.stringify(metadata));
  }
  const result = spawnSync('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', run], {
    cwd, env: { ...process.env, ...env, GITHUB_OUTPUT: output }, encoding: 'utf8',
  });
  return { status: result.status, output: readFileSync(output, 'utf8') };
}

describe('SonarCloud analysis-mode contract', () => {
  it('guards every scanner behind a known, disabled Automatic Analysis setting', () => {
    const scanners = Object.values(jobs).filter(job =>
      job.steps.some(step => step.uses?.startsWith('SonarSource/')));
    expect(scanners).toHaveLength(2);
    for (const job of scanners) {
      expect(job.needs).toBe('analysis-mode');
      expect(job.if).toContain("needs.analysis-mode.outputs.automatic == 'false'");
    }
    expect(jobs['analysis-mode'].env?.SONAR_PROJECT_KEY).toBe('ima-jin_learn2');
    expect(jobs['analysis-mode'].env).not.toHaveProperty('SONAR_TOKEN');
  });

  const modeScript = `curl() { printf '%s' "$FIXTURE"; return "$CURL_STATUS"; }\n${
    script('analysis-mode', 'Read project analysis mode')}`;
  const setting = (value: unknown) => ({ key: 'sonar.autoscan.enabled', value });

  it.each(['true', 'false'])('exports the explicit %s mode', value => {
    const result = runScript(modeScript, {
      FIXTURE: JSON.stringify({ settings: [setting(value)] }), CURL_STATUS: '0',
    });
    expect(result.status).toBe(0);
    expect(result.output).toBe(`automatic=${value}\n`);
  });

  it.each([
    ['missing', '{"settings":[]}'],
    ['malformed', JSON.stringify({ settings: [setting('yes')] })],
    ['boolean', JSON.stringify({ settings: [setting(true)] })],
    ['duplicate', JSON.stringify({ settings: [setting('true'), setting('false')] })],
    ['invalid JSON', '{'],
  ])('fails closed on %s settings', (_name, fixture) => {
    const result = runScript(modeScript, { FIXTURE: fixture, CURL_STATUS: '0' });
    expect(result.status).not.toBe(0);
    expect(result.output).toBe('');
  });

  it('fails closed on an unavailable settings API', () => {
    const result = runScript(modeScript, {
      FIXTURE: JSON.stringify({ settings: [setting('false')] }), CURL_STATUS: '22',
    });
    expect(result.status).not.toBe(0);
    expect(result.output).toBe('');
  });

  const metadata = { prNumber: 21, headRef: 'fix/sonar-mode', baseRef: 'main' };
  const metadataScript = script('sonarcloud-pr', 'Read PR metadata');

  it('passes only a validated artifact head SHA to the PR scanner', () => {
    const headSha = 'a'.repeat(40);
    const result = runScript(metadataScript, {}, { ...metadata, headSha });
    expect(result.status).toBe(0);
    expect(result.output).toContain(`headSha=${headSha}\n`);
    const scanner = jobs['sonarcloud-pr'].steps.find(step => step.name === 'SonarCloud Scan');
    expect(scanner?.with?.args).toContain('-Dsonar.scm.revision=${{ steps.pr.outputs.headSha }}');
    expect(jobs['sonarcloud-pr'].steps.some(step => step.uses?.startsWith('actions/checkout'))).toBe(false);
  });

  it.each([undefined, '', 'abc', 'g'.repeat(40), `${'a'.repeat(40)}\ninjected=true`])(
    'rejects an invalid artifact revision (%s)', headSha => {
      const result = runScript(metadataScript, {}, { ...metadata, headSha });
      expect(result.status).not.toBe(0);
      expect(result.output).toBe('');
    },
  );
});
