import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { routing } from '../src/config.js';

test('Render env can configure doctor phone and control group without ROUTING_JSON', t => {
  const dir = mkdtempSync(join(tmpdir(), 'vip-routing-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = {
    DATA_DIR: dir,
    DOCTOR_PHONE: '573001234567',
    DOCTOR_ID: 'medico_principal',
    CONTROL_GROUP_ID: '120363123456789@g.us',
    DOCTOR_FORCE_DEFAULT: 'true',
  };
  const r = routing('/path/that/does/not/exist.json', env);
  assert.equal(r.defaultDoctorId, 'medico_principal');
  assert.equal(r.doctors.medico_principal, '573001234567');
  assert.equal(r.controlGroupId, '120363123456789@g.us');
  assert.equal(r.forceDefaultDoctor, true);
});

import { selectedDoctor } from '../src/domain.js';

test('single-doctor Render mode sends any appointment to DOCTOR_PHONE', () => {
  const routes = {
    doctors: { medico_principal: '573001234567' },
    assignments: {},
    defaultDoctorId: 'medico_principal',
    forceDefaultDoctor: true,
  };
  assert.equal(selectedDoctor({ doctorId: 'otro_medico', id: 'cita-1' }, routes), '573001234567');
  assert.equal(selectedDoctor({ doctorId: 'PROVIDER_UNAVAILABLE', id: 'cita-2' }, routes), '573001234567');
});
