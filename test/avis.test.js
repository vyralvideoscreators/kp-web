'use strict';
// FASE 2 — Núcleo de notificaciones `Avis` de kp-web.
//
// Estos tests ejecutan el CÓDIGO REAL de `Avis`: se extrae el bloque delimitado
// por `// <avis>` … `// </avis>` de app.js y se evalúa con dependencias
// inyectadas (localStorage/api/getToken/… falsos). No hay copia paralela del
// módulo: si app.js cambia, estos tests ven el cambio. Sin dependencias
// externas; se corren con `npm test` (node --test).

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const fs       = require('node:fs');
const path     = require('node:path');

// CustomEvent puede no existir según versión de Node; garantizamos uno mínimo.
globalThis.CustomEvent = globalThis.CustomEvent || class { constructor(t, o) { this.type = t; this.detail = o && o.detail; } };

// ── Extracción del Avis real ────────────────────────────────────────────────
const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8').replace(/\r\n/g, '\n');
const ini = app.indexOf('// <avis>');
const fin = app.indexOf('// </avis>');
assert.ok(ini !== -1 && fin !== -1 && fin > ini, 'no se encontró el bloque <avis>…</avis> en app.js');
const cuerpoAvis = app.slice(ini, fin);   // contiene `const Avis = { … };`

// Crea una instancia FRESCA de Avis con sus dependencias inyectadas.
function crearAvis(deps) {
  const fn = new Function(
    'api', 'getToken', 'hoyYmd', 'Auth', 'Citas', 'toast', 'window', 'localStorage', 'Notification',
    cuerpoAvis + '\n;return Avis;'
  );
  return fn(deps.api, deps.getToken, deps.hoyYmd, deps.Auth, deps.Citas, deps.toast,
    deps.window, deps.localStorage, deps.Notification);
}

// ── Dobles de prueba ──────────────────────────────────────────────────────────
function lsFalso() {
  const m = new Map();
  return {
    _m: m,
    getItem: k => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: k => { m.delete(k); },
  };
}

// JWT falso (payload base64url SIN firmar) con businessId/userId.
function token(businessId, userId) {
  const p = Buffer.from(JSON.stringify({ businessId, userId })).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return 'h.' + p + '.s';
}

function winFalso(capturados) {
  return { dispatchEvent: ev => { capturados.push(ev.detail); return true; } };
}

// api falso: responde según la ruta y DEJA CONSTANCIA de cada ruta pedida
// (fn.rutas), para poder afirmar qué fuentes se consultan y cuáles no.
function apiDe(estado) {
  const fn = async (ruta) => {
    fn.rutas.push(ruta);
    if (estado.throwCitas && ruta.indexOf('/api/appointments') !== -1) throw new Error('403');
    if (ruta.indexOf('estado=por_aprobar') !== -1) return (estado.porAprobar || []).slice();
    if (ruta.indexOf('estado=vivas') !== -1)       return (estado.vivas || []).slice();
    if (ruta.indexOf('/api/transport') !== -1)     return { paradas: (estado.paradas || []).slice() };
    return [];
  };
  fn.rutas = [];
  return fn;
}

// Armazón habitual: owner, hoy fijo, captura de eventos y ls compartible.
function montar(estado, opts) {
  opts = opts || {};
  const cap = [];
  const ls = opts.ls || lsFalso();
  const api = apiDe(estado);
  const A = crearAvis({
    api: api,
    getToken: () => token(opts.biz || 'B1', opts.uid || 'U1'),
    hoyYmd: () => '2026-10-06',
    Auth: { usuario: { rol: opts.rol || 'owner', email: opts.email || 'a@kp.com' } },
    Citas: undefined,
    toast: () => {},
    window: winFalso(cap),
    localStorage: ls,
    Notification: undefined,
  });
  return { A, cap, ls, api };
}

// ── IDENTIDAD ────────────────────────────────────────────────────────────────
test('identidad: aprobada = id + confirmed_at; pendiente = id; trayecto = id (preparada)', () => {
  const { A } = montar({});
  assert.equal(A.idAprobada({ id: 'a1', confirmadaEl: '2026-10-06T10:00:00Z' }), 'appt-confirmed:a1:2026-10-06T10:00:00Z');
  assert.equal(A.idPendiente({ id: 'p1' }), 'appt-pending:p1');
  assert.equal(A.idTrayecto({ id: 't1' }), 'transport:t1');   // preparada para FASE 5
  // La aprobada NO puede depender solo del id: dos confirmaciones distintas → identidades distintas.
  assert.notEqual(A.idAprobada({ id: 'a1', confirmadaEl: 'X' }), A.idAprobada({ id: 'a1', confirmadaEl: 'Y' }));
});

// ── BASELINE ─────────────────────────────────────────────────────────────────
test('baseline: el primer arranque NO notifica lo existente; lo nuevo posterior SÍ', async () => {
  const estado = { porAprobar: [{ id: 'p1' }], vivas: [] };
  const { A, cap } = montar(estado);
  await A.iniciar();
  assert.equal(cap.length, 0, 'el baseline no debe emitir nada');
  // entra una nueva cita por aprobar
  estado.porAprobar = [{ id: 'p1' }, { id: 'p2' }];
  await A.procesar(true);
  assert.equal(cap.length, 1);
  assert.equal(cap[0].tipo, 'cita_por_aprobar');
  assert.equal(cap[0].payload.id, 'p2');
});

test('baseline: instalación nueva / storage vacío no dispara histórico', async () => {
  const estado = { porAprobar: [{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }], vivas: [] };
  const { A, cap } = montar(estado);
  await A.iniciar();
  assert.deepEqual(cap, [], 'con storage vacío, el baseline siembra sin avisar');
});

// ── DEDUPLICACIÓN ────────────────────────────────────────────────────────────
test('dedup: el mismo evento no se repite en pasadas sucesivas (refresh/reconexión)', async () => {
  const estado = { porAprobar: [{ id: 'p1' }], vivas: [] };
  const { A, cap } = montar(estado);
  await A.iniciar();                 // baseline
  estado.porAprobar = [{ id: 'p1' }, { id: 'p2' }];
  await A.procesar(true);            // emite p2
  await A.procesar(true);            // refresh → nada nuevo
  await A.procesar(true);            // reconexión → nada nuevo
  assert.equal(cap.length, 1);
});

test('dedup: cerrar y abrir (nueva instancia, mismo localStorage) no reemite', async () => {
  const estado = { porAprobar: [{ id: 'p1' }], vivas: [] };
  const ls = lsFalso();
  const prim = montar(estado, { ls });
  await prim.A.iniciar();            // baseline siembra p1
  estado.porAprobar = [{ id: 'p1' }, { id: 'p2' }];
  await prim.A.procesar(true);       // emite p2
  assert.equal(prim.cap.length, 1);
  // "cerrar y abrir": instancia nueva, MISMO ls, MISMO usuario/token
  const seg = montar(estado, { ls });
  await seg.A.iniciar();             // ya hay base → revisa, pero p1 y p2 ya vistos
  assert.equal(seg.cap.length, 0, 'tras reabrir no debe reemitir lo ya visto');
});

// ── NET-ZERO (el caso crítico) ───────────────────────────────────────────────
test('net-zero: 2 pending → 1 se aprueba y entra 1 nueva (siguen 2) → detecta la nueva y la aprobada', async () => {
  const estado = { porAprobar: [{ id: 'p1' }, { id: 'p2' }], vivas: [] };
  const { A, cap } = montar(estado);
  await A.iniciar();                 // baseline con p1, p2
  // p2 se aprueba (sale de pendientes, aparece confirmada en vivas) y entra p3
  estado.porAprobar = [{ id: 'p1' }, { id: 'p3' }];
  estado.vivas      = [{ id: 'p2', estado: 'confirmed', confirmadaEl: '2026-10-06T11:00:00Z' }];
  await A.procesar(true);
  const tipos = cap.map(e => e.tipo + ':' + e.payload.id).sort();
  assert.deepEqual(tipos, ['cita_aprobada:p2', 'cita_por_aprobar:p3'],
    'el contador sigue en 2 pendientes, pero deben detectarse p3 (nueva) y p2 (aprobada)');
});

// ── NAMESPACING ──────────────────────────────────────────────────────────────
test('namespacing: usuario A y usuario B no comparten seen-set (mismo dispositivo)', async () => {
  const estado = { porAprobar: [{ id: 'p1' }], vivas: [] };
  const ls = lsFalso();
  const a = montar(estado, { ls, biz: 'B1', uid: 'UA' });
  await a.A.iniciar();
  estado.porAprobar = [{ id: 'p1' }, { id: 'p2' }];
  await a.A.procesar(true);          // A emite p2
  assert.equal(a.cap.length, 1);
  // Entra el usuario B en el mismo dispositivo (mismo ls, otro userId)
  const b = montar(estado, { ls, biz: 'B1', uid: 'UB' });
  await b.A.iniciar();               // B no tiene historial → baseline (no emite), aunque p1/p2 existan
  assert.equal(b.cap.length, 0, 'B no debe heredar ni reaccionar al seen-set de A');
  assert.notEqual(a.A.clave(), b.A.clave(), 'las claves de A y B deben diferir');
});

test('namespacing: negocio A y negocio B no comparten seen-set', () => {
  const b1 = montar({}, { biz: 'B1', uid: 'U1' });
  const b2 = montar({}, { biz: 'B2', uid: 'U1' });
  assert.notEqual(b1.A.clave(), b2.A.clave());
  assert.match(b1.A.clave(), /^kp_seen:B1:U1$/);
  assert.match(b2.A.clave(), /^kp_seen:B2:U1$/);
});

// ── ROLES ────────────────────────────────────────────────────────────────────
test('roles: OWNER y STAFF reciben eventos de cita', async () => {
  for (const rol of ['owner', 'staff']) {
    const estado = { porAprobar: [{ id: 'p1' }], vivas: [] };
    const { A, cap } = montar(estado, { rol });
    await A.iniciar();
    estado.porAprobar = [{ id: 'p1' }, { id: 'p2' }];
    await A.procesar(true);
    assert.equal(cap.length, 1, rol + ' debe recibir la cita por aprobar');
    assert.equal(cap[0].tipo, 'cita_por_aprobar');
  }
});

test('roles: DRIVER no recibe eventos de cita, no consulta las fuentes de citas ni genera identidades de cita', async () => {
  // Si se pidieran /api/appointments, el api falso lanzaría (throwCitas); el que
  // no rompa demuestra que NO se consultan. Además: cero eventos y cero claves de cita.
  const estado = { throwCitas: true, porAprobar: [{ id: 'p1' }], vivas: [{ id: 'p2', estado: 'confirmed', confirmadaEl: 'Z' }] };
  const { A, cap, api } = montar(estado, { rol: 'driver' });
  await A.iniciar();
  estado.porAprobar = [{ id: 'p1' }, { id: 'p9' }];
  await A.procesar(true);
  assert.equal(cap.length, 0, 'el driver no recibe eventos de cita en FASE 2');
  assert.ok(api.rutas.every(r => r.indexOf('/api/appointments') === -1), 'el driver NO debe consultar /api/appointments');
  assert.ok(Object.keys(A.seen).every(k => k.indexOf('appt-') === -1), 'el driver no genera identidades de cita');
});

// ── EVENTO vs ESTADO (transporte) — BLOQUEANTE de la revisión ────────────────
test('transporte: FASE 2 NO consulta /api/transport ni mete el estado en el seen-set', async () => {
  // Existe un estado de transporte (paradas pendientes), pero no es un evento.
  const estado = { porAprobar: [], vivas: [], paradas: [{ id: 't1', estado: 'pendiente' }, { id: 't2', estado: 'recogida' }] };
  const { A, cap, api } = montar(estado);
  await A.iniciar();                 // baseline
  await A.procesar(true);            // una pasada normal
  await A.procesar(true);            // repetir el mismo estado…
  assert.equal(cap.length, 0, 'un estado de transporte no genera eventos');
  assert.ok(api.rutas.every(r => r.indexOf('/api/transport') === -1), 'FASE 2 no debe consultar /api/transport');
  assert.deepEqual(Object.keys(A.seen), [], 'el estado de transporte NO entra en el seen-set');
});

test('transporte: el seen-set solo contiene identidades de EVENTO; el estado se calculará aparte (FASE 3/5)', async () => {
  const estado = { porAprobar: [{ id: 'p1' }], vivas: [], paradas: [{ id: 't1', estado: 'pendiente' }] };
  const { A } = montar(estado);
  await A.iniciar();                 // baseline con p1 (cita)
  const claves = Object.keys(A.seen);
  assert.ok(claves.length >= 1);
  assert.ok(claves.every(k => /^(appt-confirmed:|appt-pending:)/.test(k)), 'solo identidades de evento de cita en FASE 2; ningún transport:');
  assert.ok(claves.every(k => k.indexOf('transport:') === -1), 'ninguna identidad transport: en el seen-set');
  // La identidad de trayecto existe SOLO como preparación (FASE 5), sin usarse.
  assert.equal(A.idTrayecto({ id: 't1' }), 'transport:t1');
  // El núcleo NO expone estado/badge de transporte: se calculará del estado real.
  assert.equal(typeof A.transportePendiente, 'undefined');
  assert.equal(typeof A.badge, 'undefined');
});

// ── ORDEN SEGURO: registrar antes de emitir ──────────────────────────────────
test('orden: un fallo al emitir no pierde el registro ni tumba la pasada', async () => {
  const estado = { porAprobar: [{ id: 'p1' }], vivas: [] };
  const { A } = montar(estado);
  await A.iniciar();                 // baseline
  estado.porAprobar = [{ id: 'p1' }, { id: 'p2' }];
  let llamado = 0;
  A.emitir = () => { llamado++; throw new Error('UI caída'); };   // la presentación falla
  await assert.doesNotReject(A.procesar(true), 'un fallo de UI no debe propagar');
  assert.equal(llamado, 1, 'intentó emitir');
  assert.ok(A.visto('appt-pending:p2'), 'la identidad quedó registrada aunque la emisión fallara');
});
