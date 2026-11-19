'use strict';
// Aviso informativo tras pulsar «Ir». Ejecuta el CÓDIGO REAL de app.js (bloque <aviso-sms> y
// Transporte.ir) con dependencias inyectadas. Sin dependencias externas (node --test).

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const fs       = require('node:fs');
const path     = require('node:path');

const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8').replace(/\r\n/g, '\n');
const bloque = app.slice(app.indexOf('// <aviso-sms>'), app.indexOf('// </aviso-sms>'));
assert.ok(bloque, 'falta el bloque <aviso-sms>');
const textoAvisoSms = new Function(bloque + '\n;return textoAvisoSms;')();

test('enviado: «Aviso enviado»', () => {
  assert.equal(textoAvisoSms({ enviado: true, motivo: 'en_cola' }), 'Aviso enviado');
});

test('el cliente no recibe avisos: mismo texto, sin culpar al conductor', () => {
  for (const motivo of ['sin_consentimiento', 'sin_telefono', 'baja', 'tope_mensual']) {
    assert.equal(textoAvisoSms({ omitido: true, motivo }), 'El cliente no recibe avisos por texto', motivo);
  }
});

test('lo que no le aporta nada al conductor no se muestra', () => {
  for (const motivo of ['interno', 'ya_enviado', 'no_configurado', 'no_disponible', 'otro']) {
    assert.equal(textoAvisoSms({ omitido: true, motivo }), null, motivo);
  }
});

test('sin sms en la respuesta (sistema apagado o backend anterior): nada', () => {
  assert.equal(textoAvisoSms(undefined), null);
  assert.equal(textoAvisoSms(null), null);
  assert.equal(textoAvisoSms({}), null);
});

// Transporte.ir real.
function irReal(d) {
  const ini = app.indexOf('  ir: async function (id) {');
  const fin = app.indexOf('\n  },\n', ini);
  assert.ok(ini > 0 && fin > ini);
  const toasts = [], abiertos = [];
  let cerrada = 0, cargas = 0;
  const yo = {
    datos: { paradas: [{ id: 'p1', direccion: 'Calle 1' }] },
    async cargar() { cargas++; },
    ir: new Function('api', 'toast', 'textoAvisoSms', 'window', 'Hoja', 'URLSearchParams',
      'return async function (id) {' + app.slice(app.indexOf('{', ini) + 1, fin) + '\n};')(
      d.api, (m) => toasts.push(m), textoAvisoSms, { open: (u) => abiertos.push(u) }, { cerrar() { cerrada++; } }, URLSearchParams),
  };
  return { yo, toasts, abiertos, cuenta: () => ({ cerrada, cargas }) };
}

test('«Ir» manda solo el estado, avisa y sigue abriendo el mapa', async () => {
  let pedido = null;
  const { yo, toasts, abiertos, cuenta } = irReal({ api: async (ruta, o) => { pedido = { ruta, o }; return { success: true, sms: { enviado: true, motivo: 'en_cola' } }; } });
  await yo.ir('p1');
  assert.equal(pedido.ruta, '/api/transport/p1');
  assert.deepEqual(pedido.o, { method: 'PATCH', body: { estado: 'en_camino' } });
  assert.deepEqual(toasts, ['Aviso enviado']);
  assert.equal(abiertos.length, 1);
  assert.deepEqual(cuenta(), { cerrada: 1, cargas: 1 });
});

test('sin sms en la respuesta, «Ir» se comporta exactamente como antes', async () => {
  const { yo, toasts, abiertos, cuenta } = irReal({ api: async () => ({ success: true }) });
  await yo.ir('p1');
  assert.deepEqual(toasts, []);
  assert.equal(abiertos.length, 1);
  assert.deepEqual(cuenta(), { cerrada: 1, cargas: 1 });
});

test('si el cambio de estado falla: su error de siempre, sin aviso ni mapa', async () => {
  const { yo, toasts, abiertos, cuenta } = irReal({ api: async () => { throw new Error('Sin conexión'); } });
  await yo.ir('p1');
  assert.deepEqual(toasts, ['Sin conexión']);
  assert.equal(abiertos.length, 0);
  assert.deepEqual(cuenta(), { cerrada: 0, cargas: 0 });
});

test('los botones no cambian y «Recogida» y «Entregado» siguen sin leer sms', () => {
  assert.match(app, /txt: 'Ir',\s+fn: "Transporte\.ir\('"/);
  assert.match(app, /txt: 'Recogida',\s+fn: "Transporte\.marcarRecogida\('"/);
  assert.match(app, /txt: 'Entregado', fn: "Transporte\.marcarEntregado\('"/);
  const r = app.slice(app.indexOf('  marcarRecogida: async function (id) {'), app.indexOf('  abrirEnMaps: function () {'));
  assert.doesNotMatch(r, /sms/i);
});

test('el conductor no ve conversaciones: la app no llama a las rutas de mensajes', () => {
  assert.doesNotMatch(app, /\/api\/sms/);
});
