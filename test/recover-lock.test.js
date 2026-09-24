import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { recoverLock } from '../src/recover-lock.js';

test('recovery preserves active process and WhatsApp files, removes only a dead PID lock', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vip-lock-test-'));
  try {
    const lock = join(dir, 'worker.lock');
    const session = join(dir, 'session-fixture');
    writeFileSync(lock, String(process.pid)); writeFileSync(session, 'preserve');
    assert.throws(() => recoverLock(dir), /sigue activo/);
    assert.ok(existsSync(lock));
    assert.throws(() => recoverLock(dir, () => { throw Object.assign(new Error(), { code: 'EPERM' }); }), /se conserva/);
    assert.equal(recoverLock(dir, () => { throw Object.assign(new Error(), { code: 'ESRCH' }); }), true);
    assert.equal(readFileSync(session, 'utf8'), 'preserve');
    assert.equal(recoverLock(dir), false);
  } finally { rmSync(dir, { recursive: true }); }
});
