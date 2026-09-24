import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeBaileysGroups, listGroups } from '../src/groups.js';
import { providerFields, mediconecta } from '../src/mediconecta.js';

test('Baileys group picker normalizes participating groups', () => {
  const groups = normalizeBaileysGroups({
    a: { id: '123@g.us', subject: 'Control' },
    b: { id: '456-789@g.us', subject: 'Otro' },
    c: { id: '111@s.whatsapp.net', subject: 'Personal' },
  });
  assert.deepEqual(groups.map(g => g.id).sort(), ['123@g.us', '456-789@g.us']);
});

test('Baileys group picker uses groupFetchAllParticipating', async () => {
  const socket = { async groupFetchAllParticipating() { return { a: { id: '123@g.us', subject: 'Control' } }; } };
  assert.deepEqual(await listGroups(socket), [{ id: '123@g.us', name: 'Control' }]);
  await assert.rejects(listGroups({ async groupFetchAllParticipating() { return {}; } }), /no se encontraron grupos/i);
});

test('provider aliases map exact names to local doctors; unknown alias never uses a default', () => {
  const mapping = { doctorIdPath: 'medico', requireDoctorAlias: true, doctorAliases: { 'MÉDICO EJEMPLO': 'doctor1' } };
  assert.equal(providerFields({ medico: 'MÉDICO EJEMPLO' }, mapping).doctorId, 'doctor1');
  assert.equal(providerFields({ medico: 'NO CONFIGURADO' }, mapping).doctorId, 'PROVIDER_UNAVAILABLE');
});
test('form lookup accepts only exact wix_id and distinguishes receipt from completion', async () => {
  const routes = { mediconecta: { doctorIdPath: 'medico', formLookup: 'bsl-wix-id' } };
  let linkedId = 'order-1';
  const fetcher = async url => ({ ok: true, async json() {
    return url.includes('/api/ordenes/') ? { success: true, data: { _id: 'order-1', medico: 'doctor1' } }
      : { success: true, data: { wix_id: linkedId } };
  } });
  const client = mediconecta({ base: 'https://vip-mediconecta.app' }, routes, { MEDICONNECTA_LOOKUP: 'true', MEDICONNECTA_TOKEN: 'fixture' }, fetcher);
  assert.equal((await client.lookup('order-1')).form, 'received');
  linkedId = 'other-order';
  assert.equal((await client.lookup('order-1')).form, 'unknown');
});
test('explicit public access never adds credentials and completed visits stop reminders', async () => {
  const routes = { mediconecta: { doctorIdPath: 'medico', statusPath: 'atendido', completedStatusValues: ['ATENDIDO'] } };
  const client = mediconecta({ base: 'https://vip-mediconecta.app' }, routes, { MEDICONNECTA_LOOKUP: 'true', MEDICONNECTA_AUTH_MODE: 'public' }, async (_url, options) => {
    assert.equal(options.headers.Authorization, undefined);
    return { ok: true, async json() { return { success: true, data: { _id: 'order-1', medico: 'YULI', atendido: 'ATENDIDO' } }; } };
  });
  assert.equal((await client.lookup('order-1')).status, 'completed');
  const denied = mediconecta({ base: 'https://vip-mediconecta.app' }, routes, { MEDICONNECTA_LOOKUP: 'true', MEDICONNECTA_AUTH_MODE: 'public' }, async () => ({ ok: false, status: 403 }));
  await assert.rejects(denied.lookup('order-1'), /No se pudo consultar/);
});
