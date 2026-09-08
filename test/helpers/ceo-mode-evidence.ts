import * as fs from 'node:fs';
import * as path from 'node:path';
import { redactFindingSpans } from '../../lib/redact-engine';

/** Private, unique attempt artifacts survive the hermetic session's cleanup.
 * Preserve owned records and terminal bytes, never ambient config/auth files.
 * Redaction happens on strings before serialization so JSON stays parseable.
 */
export function retainCeoModeEvidence(root: string, sessionId: string, evidence: unknown,
  env: Record<string, string | undefined>): string {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(sessionId)) {
    throw new Error('CEO evidence session ID must be a UUID');
  }
  const sensitive = /(?:token|secret|password|credential|authorization|api[_-]?key|private[_-]?key)/i;
  const secrets = [...new Set(Object.entries(env)
    .filter(([key, value]) => sensitive.test(key) && value && value.length >= 8)
    .map(([, value]) => value!))].sort((a, b) => b.length - a.length);
  let redactedStrings = 0;
  let omittedStrings = 0;
  function redact(value: any, key = ''): any {
    if (sensitive.test(key) && typeof value === 'string') return '[REDACTED_FIELD]';
    if (typeof value === 'string') {
      let known = value;
      for (const secret of secrets) known = known.replaceAll(secret, '[REDACTED_ENV]');
      const safe = redactFindingSpans(known, { maxBytes: 8 * 1024 * 1024 });
      if (safe === null) { omittedStrings++; return '[OMITTED_UNSAFE_STRING]'; }
      if (safe !== value) redactedStrings++;
      return safe;
    }
    if (Array.isArray(value)) return value.map(item => redact(item));
    if (value && typeof value === 'object') return Object.fromEntries(
      Object.entries(value).map(([field, item]) => [field, redact(item, field)]));
    return value;
  }
  const safe = redact(evidence);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  if (!fs.lstatSync(root).isDirectory() || fs.lstatSync(root).isSymbolicLink()) {
    throw new Error('CEO evidence root must be a real directory');
  }
  const dir = path.join(root, sessionId);
  fs.mkdirSync(dir, { mode: 0o700 }); // Exclusive: never overwrite another attempt.
  const file = path.join(dir, 'observation.json');
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, sessionId,
    redaction: { redactedStrings, omittedStrings }, evidence: safe }, null, 2) + '\n',
  { flag: 'wx', mode: 0o600 });
  return file;
}
