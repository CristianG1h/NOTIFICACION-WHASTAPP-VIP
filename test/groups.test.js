import test from 'node:test';
import assert from 'node:assert/strict';
import { listGroups, readGroupSummaries } from '../src/groups.js';
import { providerFields, mediconecta } from '../src/mediconecta.js';

test('group picker supports old/new WIDs without chat serialization or participant lookup', () => {
  globalThis.window = { require(name) {
    assert.equal(name, 'WAWebCollections');
    return { Chat: { getModelsArray() { return [
      { id: { _serialized: '123@g.us' }, formattedTitle: 'Control', serialize() { throw new Error('r: r'); } },
      { id: { $1: '456@g.us' }, name: 'Otro' },
      { id: { _serialized: '111@c.us' }, name: 'Personal' },
      { get id() { throw new Error('Malformed'); } },
    ]; } } };
  } };
  try { assert.deepEqual(readGroupSummaries().map(g => g.id._serialized), ['123@g.us', '456@g.us']); }
  finally { delete globalThis.window; }
});
test('group picker retries synchronization and gives a useful failure instead of r:r', async () => {
  let attempts = 0;
  const client = { pupPage: { async evaluate() { if (++attempts < 3) throw new Error('r: r'); return [{ id: { _serialized: '123@g.us' } }]; } } };
  assert.equal((await listGroups(client, async () => {})).length, 1);
  assert.equal(attempts, 3);
  await assert.rejects(listGroups({ pupPage: { async evaluate() { return []; } } }, async () => {}), /No borres la sesión/);
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
