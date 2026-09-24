import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { routing } from '../src/config.js';

test('Render env-only routing keeps MediConecta payment mapping', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vip-routing-'));
  const file = join(dir, 'config.json');
  writeFileSync(file, JSON.stringify({ controlGroupId: '', defaultDoctorId: '', doctors: {}, assignments: {}, mediconecta: {} }));
  try {
    const r = routing(file, { DATA_DIR: dir, DOCTOR_PHONE: '573001234567', DOCTOR_ID: 'medico_principal' });
    assert.equal(r.mediconecta.paymentPath, 'pagado');
    assert.ok(r.mediconecta.paymentApprovedValues.includes(true));
    assert.ok(r.mediconecta.paymentApprovedValues.includes('PAGADO'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
