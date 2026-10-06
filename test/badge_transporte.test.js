'use strict';
// FASE 3 — Badge de estado de Transporte (ESTADO, no evento).
//
// Ejecuta el CÓDIGO REAL del bloque `// <badge-transporte> … </badge-transporte>`
// de app.js con dependencias inyectadas (api/$/hoyYmd/console falsos). Comprueba
// la regla ON/OFF, que abrir la pantalla no apaga el badge, que un error de red
// conserva el estado, y que este camino NO toca Avis/seen-set/kp:aviso.

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const fs       = require('node:fs');
const path     = require('node:path');

const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8').replace(/\r\n/g, '\n');
const ini = app.indexOf('// <badge-transporte>');
const fin = app.indexOf('// </badge-transporte>');
assert.ok(ini !== -1 && fin !== -1 && fin > ini, 'no se encontró el bloque <badge-transporte>');
const bloque = app.slice(ini, fin);

function crearBadge(deps) {
  const fn = new Function('api', 'hoyYmd', '$', 'console',
    bloque + '\n;return { hay: hayTransportePendiente, pintar: pintarBadgeTransporte, actualizar: actualizarBadgeTransporte, previo: () => badgeTransportePrevio };');
  return fn(deps.api, deps.hoyYmd, deps.$, deps.console);
}

function elFalso() {
  const el = { on: false, classList: { toggle(c, v) { el.on = (v === undefined ? !el.on : !!v); } } };
  return el;
}
function montar(opts) {
  opts = opts || {};
  const el = elFalso();
  const B = crearBadge({
    api: opts.api || (async () => ({ paradas: [], resumen: { total: 0, entregado: 0 } })),
    hoyYmd: () => '2026-10-06',
    $: () => el,
    console: { warn() {} },
  });
  return { B, el };
}

// Helpers para construir una respuesta de /api/transport como la del backend.
const conResumen = (total, entregado) => ({ resumen: { total: total, entregado: entregado }, paradas: [] });
const conParadas = (...estados) => ({ paradas: estados.map((e, i) => ({ id: 't' + i, estado: e })) });

// ── Regla ON/OFF ──────────────────────────────────────────────────────────────
test('1 · sin trayectos → OFF', () => {
  const { B } = montar();
  assert.equal(B.hay(conResumen(0, 0)), false);
  assert.equal(B.hay({ paradas: [] }), false);
  assert.equal(B.hay(null), false);
});

test('2 · solo entregados → OFF', () => {
  const { B } = montar();
  assert.equal(B.hay(conResumen(3, 3)), false);
  assert.equal(B.hay(conParadas('entregado', 'entregado')), false);
});

test('3 · solo cancelados → OFF', () => {
  const { B } = montar();
  // El backend ya excluye cancelled de /api/transport; aun así, si llegaran, son terminales.
  assert.equal(B.hay(conParadas('cancelled', 'cancelled')), false);
});

test('4 · existe pendiente → ON', () => {
  const { B } = montar();
  assert.equal(B.hay(conResumen(1, 0)), true);
  assert.equal(B.hay(conParadas('pendiente')), true);
});

test('5 · existe en_camino → ON', () => {
  const { B } = montar();
  assert.equal(B.hay(conParadas('en_camino')), true);
});

test('6 · existe recogida → ON', () => {
  const { B } = montar();
  assert.equal(B.hay(conParadas('recogida')), true);
});

test('7 · mezcla entregado + cancelled + pendiente → ON', () => {
  const { B } = montar();
  assert.equal(B.hay(conParadas('entregado', 'cancelled', 'pendiente')), true);
  assert.equal(B.hay(conResumen(4, 3)), true);   // 4 totales, 3 entregados → 1 sin culminar
});

test('8 · todo pasa a terminal → OFF', () => {
  const { B } = montar();
  assert.equal(B.hay(conParadas('entregado', 'entregado', 'entregado')), false);
  assert.equal(B.hay(conResumen(3, 3)), false);
});

// ── Comportamiento ───────────────────────────────────────────────────────────
test('9 · abrir Transporte NO elimina el badge si sigue habiendo pendiente', async () => {
  // "Abrir" = recalcular desde el estado real. Con pendiente, vuelve a dar ON.
  const datos = conParadas('entregado', 'pendiente');
  const { B, el } = montar({ api: async () => datos });
  await B.actualizar('2026-10-06');           // primera carga
  assert.equal(el.on, true);
  await B.actualizar('2026-10-06');           // "reabrir": mismo estado real
  assert.equal(el.on, true, 'abrir la pantalla no apaga el badge; el estado manda');
});

test('10 · un error de red NO convierte un ON conocido en OFF', async () => {
  // Instancia cuya próxima consulta fallará, partiendo de un estado conocido ON.
  const { B, el } = montar({ api: async () => { throw new Error('sin red'); } });
  B.pintar(true);                              // estado conocido: ON
  assert.equal(el.on, true);
  await B.actualizar('2026-10-06');            // la consulta falla → debe CONSERVAR ON
  assert.equal(el.on, true, 'un fallo de red no debe apagar un badge ON');
  assert.equal(B.previo(), true, 'se conserva el último estado conocido');
});

// ── Separación Avis / estado (BLOQUEANTE de diseño) ───────────────────────────
test('11 · el badge NO escribe identidades transport: en el seen-set (no usa localStorage/Avis)', async () => {
  // Estructural: el bloque no menciona seen-set/Avis/localStorage.
  assert.ok(!/seen|kp_seen|localStorage|\bAvis\b/.test(bloque), 'el bloque del badge no debe tocar seen-set/Avis/localStorage');
  // De comportamiento: se ejecuta SIN inyectar localStorage; si lo usara, reventaría.
  const { B, el } = montar({ api: async () => conParadas('pendiente') });
  await B.actualizar('2026-10-06');
  assert.equal(el.on, true);   // funciona sin localStorage → no lo usa
});

test('12 · el badge NO emite kp:aviso (no usa CustomEvent/window/dispatchEvent)', async () => {
  assert.ok(!/kp:aviso|CustomEvent|dispatchEvent|\bwindow\b/.test(bloque), 'el bloque del badge no debe emitir eventos');
  const { B, el } = montar({ api: async () => conParadas('recogida') });
  await B.actualizar('2026-10-06');            // se ejecuta sin inyectar window → no lo usa
  assert.equal(el.on, true);
});
