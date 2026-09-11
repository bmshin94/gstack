import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { seedCeoPairedProject } from './helpers/ceo-paired-fixture';
import { processPayment, PaymentFailure, ProviderError, type Payment } from './fixtures/paired-payment/src/payment';

test('paired review gets runnable existing coverage that leaves both intended gaps open', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paired-payment-fixture-'));
  try {
    seedCeoPairedProject(dir, '# Add two payment tests\n');
    const file = path.join(dir, 'src/payment.ts'); const original = fs.readFileSync(file, 'utf8');
    // These are candidate defects the two missing tests must catch. Recovery is
    // covered, but first-success receipts and exhausted retries remain untested.
    const variants = [original,
      original.replace('amount: request.amount, currency:', 'amount: request.amount + (attempt === 0 ? 1 : 0), currency:'),
      original.replace('attempt === 1', 'attempt === 2')];
    expect(new Set(variants).size).toBe(3);
    for (const source of variants) {
      fs.writeFileSync(file, source);
      const result = Bun.spawnSync([process.execPath, 'test', './contract.test.ts'], {
        cwd: dir, timeout: 5000, env: { PATH: process.env.PATH ?? '' },
      });
      expect(result.exitCode, result.stderr.toString()).toBe(0);
      expect(result.stderr.toString()).toContain('11 pass');
    }
    // The fixture must enforce its advertised pre-existing contracts without
    // closing either of the review's missing first-success/exhaustion tests.
    for (const [source, failedTest] of [
      [original.replace('amount: request.amount, currency:', 'amount: request.amount + 1, currency:'), 'recovery after one 502'],
      [original.replace('await io.sleep(100);', 'void io.sleep(100);'), 'recovery after one 502'],
      [original.replace('outcomeUnknown, error);', 'outcomeUnknown, new ProviderError((error as ProviderError).code));'), 'declined is never retried'],
    ]) {
      expect(source).not.toBe(original);
      fs.writeFileSync(file, source!);
      const result = Bun.spawnSync([process.execPath, 'test', './contract.test.ts'], {
        cwd: dir, timeout: 5000, env: { PATH: process.env.PATH ?? '' },
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr.toString()).toContain('(fail) ' + failedTest);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('existing payment behavior supports the missing happy and exhausted-retry tests', async () => {
  const payment: Payment = { key: 'order-42', amount: 1200, currency: 'usd' };
  let calls = 0; const delays: number[] = [];
  const receipt = await processPayment(payment, {
    chargeOnce: async () => { calls++; return { id: 'charge-42' }; },
    sleep: async ms => { delays.push(ms); },
  });
  expect(receipt).toEqual({ chargeId: 'charge-42', amount: 1200, currency: 'usd' });
  expect(calls).toBe(1); expect(delays).toEqual([]);
  for (const code of ['502', 'timeout'] as const) {
    const requests: Readonly<Payment>[] = []; const waits: number[] = []; const cause = new ProviderError(code);
    const outcome = processPayment(payment, {
      chargeOnce: async request => { requests.push(request); throw cause; },
      sleep: async ms => { waits.push(ms); },
    });
    await expect(outcome).rejects.toBeInstanceOf(PaymentFailure);
    await expect(outcome).rejects.toMatchObject({ key: payment.key, outcomeUnknown: true, cause });
    expect(requests).toEqual([payment, payment]); expect(requests[0]).toBe(requests[1]);
    expect(waits).toEqual([100]);
  }
  const causes = [new ProviderError('timeout'), new ProviderError('auth')];
  let mixedCalls = 0;
  await expect(processPayment(payment, {
    chargeOnce: async () => { throw causes[mixedCalls++]; }, sleep: async () => {},
  })).rejects.toMatchObject({ key: payment.key, outcomeUnknown: true, cause: causes[1] });
  expect(mixedCalls).toBe(2);
});
