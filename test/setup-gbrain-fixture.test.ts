/** Free regression coverage: real detector/verifier, owned fakes, no model calls. */
import { describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildHermeticEnv } from './helpers/hermetic-env';
import type { QueryProvider } from './helpers/agent-sdk-runner';
import { createSetupGbrainSandbox, runSetupGbrainAttempt } from './helpers/setup-gbrain-sandbox';

const originalClaudeMd = '# Fixture project\nKeep this content.\n';
async function command(bin: string, args: string[], env: Record<string, string>) {
  const child = Bun.spawn([bin, ...args], { env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

describe('setup-gbrain owned Path 4 fixture', () => {
  for (const status of [401, 200] as const) {
    test(`real verifier/detector exercise ${status} with a fresh MCP state and explicit child token`, async () => {
      const evidenceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gbrain-free-evidence-'));
      const ambient = { HOME: process.env.HOME, PATH: process.env.PATH, GSTACK_HOME: process.env.GSTACK_HOME, GBRAIN_MCP_TOKEN: process.env.GBRAIN_MCP_TOKEN };
      const fixture = await createSetupGbrainSandbox({
        name: `http-${status}`, status, originalClaudeMd,
        sections: ['brain-init.md', 'claude-md-persist.md'], evidenceRoot,
      });
      try {
        // Deliberately contaminated parent: only explicit overrides should survive.
        const env = buildHermeticEnv({ PATH: process.env.PATH, EVALS_HERMETIC: '1', GBRAIN_MCP_TOKEN: 'ambient-wrong', GBRAIN_HOME: '/unowned' }, {}, fixture.env);
        expect(env.GBRAIN_MCP_TOKEN === fixture.token).toBe(true);
        expect(env.HOME).toBe(fixture.home);
        expect(Object.entries(ambient).every(([key, value]) => process.env[key] === value)).toBe(true);
        const skill = fs.readFileSync(fixture.skillPath, 'utf8');
        expect(skill.includes('~/.claude/skills/gstack/bin/')).toBe(false);
        expect(skill.includes(`${fixture.bin}'/gstack-gbrain-install`)).toBe(true);
        expect(skill.includes('Want symbol-aware code search')).toBe(true);
        const detectPath = path.join(fixture.bin, 'gstack-gbrain-detect');
        const before = await command(detectPath, [], env);
        expect(before.exitCode).toBe(0);
        expect(JSON.parse(before.stdout).gbrain_mcp_mode).toBe('none');
        expect(JSON.parse(before.stdout).gbrain_local_status).toBe('missing-config');
        const verifier = path.join(fixture.bin, 'gstack-gbrain-mcp-verify');
        // Missing-token contrast reproduces the original pre-HTTP failure safely.
        const missing = await command(verifier, [fixture.url], { ...env, GBRAIN_MCP_TOKEN: '' });
        expect(missing.exitCode).toBe(2);
        expect(fixture.requests.length).toBe(0);
        const verified = await command(verifier, [fixture.url], env);
        expect(verified.exitCode).toBe(status === 401 ? 1 : 0);
        const output = JSON.parse(verified.stdout);
        expect(output.status).toBe(status === 401 ? 'auth' : 'success');
        expect(output.error_class).toBe(status === 401 ? 'AUTH' : null);
        if (status === 401) expect(output.error_text.includes('rotate token on the brain host')).toBe(true);
        expect(fixture.requests.map((r) => r.rpcMethod)).toEqual(status === 401 ? ['initialize'] : ['initialize', 'tools/list']);
        expect(fixture.requests.every((r) => r.method === 'POST' && r.authorizationPresent && r.authorizationMatches && r.status === status)).toBe(true);
        expect(verified.stdout.includes(fixture.token)).toBe(false);
        expect(fixture.snapshot().mcp.registered).toBe(false);
        expect(fixture.snapshot().claudeMdUnchanged).toBe(true);
        if (status === 200) {
          const installer = await command(path.join(fixture.bin, 'gstack-gbrain-install'), [], env);
          expect(installer.exitCode).toBe(0);
          expect((await command(path.join(fixture.bin, 'gbrain'), ['init', '--pglite', '--json'], env)).exitCode).toBe(0);
          const registration = await command(path.join(fixture.bin, 'claude'), [
            'mcp', 'add', '--scope', 'user', '--transport', 'http', 'gbrain', fixture.url,
            '--header', `Authorization: Bearer ${fixture.token}`,
          ], { ...env, GBRAIN_MCP_TOKEN: '' });
          expect(registration.exitCode).toBe(0);
          const after = await command(detectPath, [], env);
          expect(after.exitCode).toBe(0);
          expect(JSON.parse(after.stdout).gbrain_mcp_mode).toBe('remote-http');
          expect(JSON.parse(after.stdout).gbrain_engine).toBe('pglite');
          expect(JSON.parse(after.stdout).gbrain_local_status).toBe('ok');
          expect((await command(path.join(fixture.bin, 'claude'), ['mcp', 'remove', 'gbrain'], env)).exitCode).toBe(0);
          expect(JSON.parse((await command(detectPath, [], env)).stdout).gbrain_mcp_mode).toBe('none');
        }
        const calls = fixture.commands();
        expect(calls.some((c) => c.command === 'gstack-gbrain-mcp-verify' && c.phase === 'start' && c.tokenPresent && c.tokenMatches && c.homeMatches && c.gstackHomeMatches)).toBe(true);
        expect(JSON.stringify(calls).includes(fixture.token)).toBe(false);
        fixture.retain({ stage: 'free-probe-completed' });
        const evidence = fs.readFileSync(fixture.evidencePath, 'utf8');
        expect(evidence.includes(fixture.token)).toBe(false);
        expect(JSON.parse(evidence).initial.mcp.registered).toBe(false);
        expect(JSON.parse(evidence).final.claudeMdTokenLeak).toBe(false);
      } finally {
        await fixture.cleanup();
        fs.rmSync(evidenceRoot, { recursive: true, force: true });
      }
    }, 30_000);
  }

  test('SDK failure/exception evidence is unique, redacted, and retained before assertions and cleanup', async () => {
    const evidenceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gbrain-attempt-evidence-'));
    const paths: string[] = [];
    try {
      for (const mode of ['assertion', 'max-turns', 'throw', 'success'] as const) {
        const fixture = await createSetupGbrainSandbox({
          name: 'same-retry-name', status: 401, originalClaudeMd, sections: ['brain-init.md'], evidenceRoot,
        });
        paths.push(fixture.evidencePath);
        let assertionsRun = false;
        let providerCalls = 0;
        const queryProvider: QueryProvider = (input) => {
          providerCalls++;
          expect(input.options?.env?.GBRAIN_MCP_TOKEN === fixture.token).toBe(true);
          expect(input.options?.env?.HOME).toBe(fixture.home);
          return (async function* () {
            yield { type: 'system', subtype: 'init', claude_code_version: 'fixture-cli' };
            const questions = [{ question: 'Want symbol-aware code search?', options: [{ label: 'Yes, local PGLite' }] }];
            await input.options!.canUseTool!('AskUserQuestion', { questions }, {
              signal: new AbortController().signal, toolUseID: 'fixture-question',
            });
            yield { type: 'assistant', message: { content: [
              { type: 'text', text: `synthetic diagnostic ${fixture.token}` },
              { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'fixture probe' } },
            ] } };
            yield { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: `result ${fixture.token}` }] } };
            if (mode === 'throw') throw new Error(`fixture stream failed ${fixture.token}`);
            yield { type: 'result', subtype: mode === 'max-turns' ? 'error_max_turns' : 'success', num_turns: 1, total_cost_usd: 0 };
          })() as ReturnType<QueryProvider>;
        };
        let thrown = '';
        try {
          await runSetupGbrainAttempt(fixture, {
            systemPrompt: '', userPrompt: 'free fixture probe', queryProvider,
            canUseTool: async (_tool, input) => ({ behavior: 'allow', updatedInput: {
              ...input, answers: { 'Want symbol-aware code search?': 'Yes, local PGLite' },
            } }),
          }, () => {
            assertionsRun = true;
            const before = fs.readFileSync(fixture.evidencePath, 'utf8');
            expect(before.includes(fixture.token)).toBe(false);
            expect(JSON.parse(before).stage).toBe('before-assertions');
            if (mode === 'assertion') {
              fs.appendFileSync(path.join(fixture.home, 'CLAUDE.md'), fixture.token);
              throw new Error(`assertion diagnostic ${fixture.token}`);
            }
          });
        } catch (error) { thrown = String(error); }
        expect(thrown.includes(fixture.token)).toBe(false);
        expect(thrown.length > 0).toBe(mode !== 'success');
        expect(providerCalls).toBe(1);
        expect(assertionsRun).toBe(mode === 'assertion' || mode === 'success');
        expect(fs.existsSync(fixture.root)).toBe(false);
        const raw = fs.readFileSync(fixture.evidencePath, 'utf8');
        expect(raw.includes(fixture.token)).toBe(false);
        const evidence = JSON.parse(raw);
        expect(evidence.stage).toBe(mode === 'success' ? 'passed' : 'failed');
        expect(evidence.configuration.tokenPresent && evidence.configuration.tokenMatches).toBe(true);
        expect(evidence.configuration.homeMatches && evidence.configuration.gstackHomeMatches && evidence.configuration.ownedBinFirst).toBe(true);
        expect(evidence.events.some((e: { type: string }) => e.type === 'user')).toBe(true);
        expect(evidence.permissions[0].decision.updatedInput.answers['Want symbol-aware code search?']).toBe('Yes, local PGLite');
        expect(evidence.final.claudeMdTokenLeak).toBe(mode === 'assertion');
        expect(evidence.modelOutputTokenLeak).toBe(mode !== 'throw');
      }
      expect(new Set(paths).size).toBe(4);
      expect(paths.every((file) => fs.existsSync(file))).toBe(true);
    } finally { fs.rmSync(evidenceRoot, { recursive: true, force: true }); }
  }, 30_000);
});
