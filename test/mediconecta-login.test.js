import test from 'node:test';
import assert from 'node:assert/strict';
import { mediconecta } from '../src/mediconecta.js';

const config = { base: 'https://vip-mediconecta.app' };
const routes = { mediconecta: { doctorIdPath: 'medico', paymentPath: 'pagado', formLookup: 'bsl-wix-id' } };
const env = {
  MEDICONNECTA_LOOKUP: 'true', MEDICONNECTA_AUTH_MODE: 'login',
  MEDICONNECTA_LOGIN_EMAIL: 'bot@example.invalid', MEDICONNECTA_LOGIN_PASSWORD: 'clave-de-prueba',
};

function response(status, data) {
  return { ok: status >= 200 && status < 300, status, async json() { return data; } };
}

test('login mode requires dedicated credentials and never silently uses public mode', () => {
  assert.throws(() => mediconecta(config, routes, { MEDICONNECTA_LOOKUP: 'true', MEDICONNECTA_AUTH_MODE: 'login' }), /requiere MEDICONNECTA_LOGIN_EMAIL/);
  assert.throws(() => mediconecta(config, routes, { ...env, MEDICONNECTA_LOGIN_PASSWORD: '' }), /requiere MEDICONNECTA_LOGIN_EMAIL/);
});

test('auto-login caches the token and uses it for order and form lookups', async () => {
  let logins = 0, orders = 0, forms = 0;
  const client = mediconecta(config, routes, env, async (url, options) => {
    if (url.endsWith('/api/auth/login')) {
      logins++;
      assert.equal(options.method, 'POST');
      assert.deepEqual(JSON.parse(options.body), { email: env.MEDICONNECTA_LOGIN_EMAIL, password: env.MEDICONNECTA_LOGIN_PASSWORD });
      assert.equal(options.redirect, 'error');
      return response(200, { success: true, token: 'jwt-test-1', expiresIn: 86400 });
    }
    assert.equal(options.headers.Authorization, 'Bearer jwt-test-1');
    if (url.includes('/api/ordenes/')) {
      orders++;
      return response(200, { success: true, data: { _id: 'orden1', medico: 'medico1', pagado: true } });
    }
    forms++;
    return response(200, { success: true, data: { wix_id: 'orden1' } });
  });
  assert.deepEqual(await client.lookup('orden1'), { doctorId: 'medico1', payment: 'approved', form: 'received' });
  await client.lookup('orden1');
  assert.equal(logins, 1);
  assert.equal(orders, 2);
  assert.equal(forms, 2);
});

test('on HTTP 401 the bot logs in again and retries the order only once', async () => {
  let logins = 0, requests = 0;
  const client = mediconecta(config, { mediconecta: { doctorIdPath: 'medico' } }, env, async (url, options) => {
    if (url.endsWith('/api/auth/login')) return response(200, { success: true, token: `jwt-${++logins}`, expiresIn: 86400 });
    requests++;
    if (options.headers.Authorization === 'Bearer jwt-1') return response(401, {});
    assert.equal(options.headers.Authorization, 'Bearer jwt-2');
    return response(200, { success: true, data: { _id: 'orden2', medico: 'medico1' } });
  });
  assert.equal((await client.lookup('orden2')).doctorId, 'medico1');
  assert.equal(logins, 2);
  assert.equal(requests, 2);
  await client.lookup('orden2');
  assert.equal(logins, 2);
});

test('login failures stop private lookups without exposing credentials in errors', async () => {
  const client = mediconecta(config, routes, env, async (url) => {
    assert.ok(url.endsWith('/api/auth/login'), 'No debe consultar órdenes sin sesión');
    return response(401, { message: 'credenciales inválidas' });
  });
  await assert.rejects(() => client.lookup('orden1'), error => {
    assert.match(error.message, /Autenticación MediConecta rechazada \(HTTP 401\)/);
    assert.ok(!error.message.includes(env.MEDICONNECTA_LOGIN_PASSWORD));
    return true;
  });
});
