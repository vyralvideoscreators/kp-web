'use strict';
// FASE 6 — Robustez de ciclo de vida / online / WebSocket.
//
// Ejecuta el CÓDIGO REAL del bloque <avis> con timers y navigator inyectados
// (controlables), más comprobaciones estructurales de las vías de resincronización
// en app.js. Todo termina en Avis.sincronizar, que reutiliza el pipeline/seen-set
// existente. Sin dependencias externas (node --test).

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const fs       = require('node:fs');
const path     = require('node:path');

globalThis.CustomEvent = globalThis.CustomEvent || class { constructor(t, o) { this.type = t; this.detail = o && o.detail; } };

const appSrc = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8').replace(/\r\n/g, '\n');
const bloqueAvis = appSrc.slice(appSrc.indexOf('// <avis>'), appSrc.indexOf('// </avis>'));

// ── Harness ──────────────────────────────────────────────────────────────────
function crearAvis(deps) {
  const fn = new Function('api', 'getToken', 'hoyYmd', 'Auth', 'Citas', 'toast', 'window', 'localStorage', 'Notification', 'navigator', 'setTimeout', 'clearTimeout',
    bloqueAvis + '\n;return Avis;');
  return fn(deps.api, deps.getToken, deps.hoyYmd, deps.Auth, deps.Citas, deps.toast, deps.window, deps.localStorage, deps.Notification, deps.navigator, deps.setTimeout, deps.clearTimeout);
}
function lsFalso() {
  const m = new Map();
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: k => { m.delete(k); } };
}
function token(biz, uid) {
  const p = Buffer.from(JSON.stringify({ businessId: biz, userId: uid })).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return 'h.' + p + '.s';
}
function winFalso(cap) { return { dispatchEvent: ev => { cap.push(ev.detail); return true; } }; }
function diferido() { let resolve; const p = new Promise(r => { resolve = r; }); return { p, resolve }; }
async function flush() { for (let i = 0; i < 10; i++) await new Promise(r => setImmediate(r)); }

function timers() {
  let cb = null;
  return {
    setTimeout: fn => { cb = fn; return 1; },
    clearTimeout: () => { cb = null; },
    pendiente: () => cb !== null,
    fire: async () => { const f = cb; cb = null; if (f) f(); await flush(); },
  };
}
function apiDe(estado) {
  const fn = async (ruta) => {
    fn.rutas.push(ruta);
    if (estado.throwCitas && ruta.indexOf('/api/appointments') !== -1) throw new Error('403');
    if (estado.throwTransport && ruta.indexOf('/api/transport') !== -1) throw new Error('sin red');
    if (ruta.indexOf('estado=por_aprobar') !== -1) { if (estado.gate && fn.n++ >= 1) await estado.gate.p; return (estado.porAprobar || []).slice(); }
    if (ruta.indexOf('estado=vivas') !== -1)       return (estado.vivas || []).slice();
    if (ruta.indexOf('/api/transport') !== -1)     return { paradas: (estado.paradas || []).slice() };
    return [];
  };
  fn.rutas = []; fn.n = 0;
  return fn;
}
function montar(estado, opts) {
  opts = opts || {};
  const cap = [];
  const ls = opts.ls || lsFalso();
  const nav = { onLine: opts.onLine === undefined ? true : opts.onLine };
  const T = timers();
  const api = opts.api || apiDe(estado);
  const A = crearAvis({
    api, getToken: () => (opts.sinToken ? '' : token(opts.biz || 'B1', opts.uid || 'U1')), hoyYmd: () => '2026-10-06',
    Auth: { usuario: opts.sinUsuario ? null : { rol: opts.rol || 'owner', email: 'a@kp.com' } },
    Citas: undefined, toast: () => {}, window: winFalso(cap), localStorage: ls, Notification: undefined,
    navigator: nav, setTimeout: T.setTimeout, clearTimeout: T.clearTimeout,
  });
  return { A, cap, ls, T, nav, api };
}
const citas = (cap) => cap.filter(e => e.tipo === 'cita_por_aprobar' || e.tipo === 'cita_aprobada');
const tray  = (cap) => cap.filter(e => e.tipo === 'nuevo_trayecto');

// ── Vías de resincronización (estructural: las 3 señales → Avis.sincronizar) ──
test('1/3/5 · reconnect, online y visibilitychange terminan en Avis.sincronizar', () => {
  assert.match(appSrc, /if \(this\.huboReady\) Avis\.sincronizar\('ws-reconnect'\)/, 'reconnect → sincronizar');
  assert.match(appSrc, /addEventListener\('online', function \(\) \{ Avis\.sincronizar\('online'\)/, 'online → sincronizar');
  assert.match(appSrc, /visibilityState === 'visible'\) Avis\.sincronizar\('visible'\)/, 'visible → sincronizar');
});

test('6 · no hay polling (ningún setInterval en la app)', () => {
  assert.ok(!/setInterval/.test(appSrc), 'la resincronización es por evento, no por polling');
});

// ── Comportamiento de sincronizar ─────────────────────────────────────────────
test('1b · una resincronización detecta y emite el evento nuevo (reconnect/visible)', async () => {
  const estado = { porAprobar: [], vivas: [], paradas: [] };
  const { A, cap, T } = montar(estado);
  await A.iniciar();                       // baseline
  estado.porAprobar = [{ id: 'p1' }];
  A.sincronizar('ws-reconnect');
  assert.equal(T.pendiente(), true, 'programa una sincronización (con debounce)');
  await T.fire();
  assert.equal(citas(cap).length, 1);
  assert.equal(cap[0].payload.id, 'p1');
});

test('2 · reconnect no duplica un evento ya visto', async () => {
  const estado = { porAprobar: [], vivas: [], paradas: [] };
  const { A, cap, T } = montar(estado);
  await A.iniciar();
  estado.porAprobar = [{ id: 'p1' }];
  A.sincronizar('ws-reconnect'); await T.fire();    // emite p1
  A.sincronizar('ws-reconnect'); await T.fire();    // reconexión de nuevo → ya visto
  assert.equal(citas(cap).length, 1);
});

test('4 · online mientras el dispositivo está offline no programa ninguna consulta', async () => {
  const estado = { porAprobar: [{ id: 'p1' }] };
  const { A, T } = montar(estado, { onLine: false });
  await A.iniciar();
  A.sincronizar('visible');
  assert.equal(T.pendiente(), false, 'offline → no se programa sincronización');
});

test('4b · al volver online sí se sincroniza', async () => {
  const estado = { porAprobar: [], vivas: [], paradas: [] };
  const { A, cap, T, nav } = montar(estado, { onLine: false });
  await A.iniciar();
  estado.porAprobar = [{ id: 'p1' }];
  A.sincronizar('visible');
  assert.equal(T.pendiente(), false);
  nav.onLine = true;                       // vuelve la red
  A.sincronizar('online');
  await T.fire();
  assert.equal(citas(cap).length, 1);
});

test('7 · online + visibility + reconnect cercanos → UNA sola sincronización efectiva', async () => {
  const estado = { porAprobar: [], vivas: [], paradas: [] };
  const { A, cap, T, api } = montar(estado);
  await A.iniciar();
  const rutasBase = api.rutas.length;
  estado.porAprobar = [{ id: 'p1' }];
  A.sincronizar('online');
  A.sincronizar('visible');
  A.sincronizar('ws-reconnect');           // las tres se agrupan (debounce)
  await T.fire();
  assert.equal(citas(cap).length, 1, 'un solo evento, no tres');
  const gets = api.rutas.length - rutasBase;
  assert.ok(gets <= 3, 'una sola pasada (por_aprobar + vivas + transport), no 3 pasadas');
});

test('8 · reentrancia: dos pasadas concurrentes no duplican', async () => {
  const estado = { porAprobar: [], vivas: [], paradas: [] };
  const { A, cap } = montar(estado);
  await A.iniciar();
  estado.porAprobar = [{ id: 'p1' }];
  const a = A.procesar(true);
  const b = A.procesar(true);              // ocupado → se encola una sola
  await Promise.all([a, b]);
  await flush();
  assert.equal(citas(cap).length, 1);
});

test('9/10 · error de red no toca el seen-set y una sincronización posterior se recupera', async () => {
  const estado = { porAprobar: [], vivas: [], paradas: [] };
  const { A, cap } = montar(estado);
  await A.iniciar();                        // baseline ok
  estado.throwCitas = true; estado.porAprobar = [{ id: 'p1' }];
  await A.procesar(true);                   // falla → ni emite ni marca
  assert.equal(citas(cap).length, 0);
  assert.ok(!A.visto('appt-pending:p1'), 'el seen-set no se modifica ante el error');
  estado.throwCitas = false;
  await A.procesar(true);                   // se recupera
  assert.equal(citas(cap).length, 1);
  assert.ok(A.visto('appt-pending:p1'));
});

test('11 · primer arranque sigue sin generar avisos históricos', async () => {
  const estado = { porAprobar: [{ id: 'p1' }, { id: 'p2' }], vivas: [], paradas: [{ id: 't1' }] };
  const { A, cap } = montar(estado);
  await A.iniciar();
  assert.equal(cap.length, 0, 'baseline: nada histórico');
});

test('12 · usuario ya baselizado: tras volver de background recibe solo lo nuevo', async () => {
  const estado = { porAprobar: [{ id: 'p1' }], vivas: [], paradas: [] };
  const ls = lsFalso();
  const a = montar(estado, { ls });
  await a.A.iniciar();                      // baseline siembra p1
  // "cerrar y volver": nueva instancia, mismo ls/usuario
  const b = montar(estado, { ls });
  await b.A.iniciar();                      // ya baselizado
  estado.porAprobar = [{ id: 'p1' }, { id: 'p2' }];
  b.A.sincronizar('visible');
  await b.T.fire();
  assert.equal(citas(b.cap).length, 1);
  assert.equal(b.cap[0].payload.id, 'p2', 'solo el nuevo p2');
});

test('13 · logout/cambio de usuario: respuesta tardía de A no contamina a B', async () => {
  const gate = diferido();
  const estado = { porAprobar: [], vivas: [], paradas: [], gate };
  const { A, cap } = montar(estado);
  await A.iniciar();                        // baseline (gate aún no bloquea: n=0 → <1)
  estado.porAprobar = [{ id: 'pX' }];
  const p = A.procesar(true);               // 2ª consulta de por_aprobar → bloquea en gate
  A.alCerrarSesion();                        // LOGOUT durante la consulta → epoca++
  gate.resolve();                            // la respuesta de A llega ahora
  await p; await flush();
  assert.equal(cap.length, 0, 'la respuesta tardía de A no emite nada');
  assert.ok(!A.visto('appt-pending:pX'), 'ni toca el seen-set de la sesión nueva');
});

test('14 · cambio de negocio no comparte seen-set', async () => {
  const estado = { porAprobar: [{ id: 'p1' }], vivas: [], paradas: [] };
  const ls = lsFalso();
  const a = montar(estado, { ls, biz: 'B1', uid: 'U1' });
  await a.A.iniciar();
  const b = montar(estado, { ls, biz: 'B2', uid: 'U1' });
  await b.A.iniciar();                      // otro negocio → otra clave → baseline propio
  assert.notEqual(a.A.clave(), b.A.clave());
  assert.equal(b.cap.length, 0, 'no hereda eventos del otro negocio');
});

test('15 · una resincronización no convierte un transporte pendiente existente en nuevo_trayecto', async () => {
  const estado = { porAprobar: [], vivas: [], paradas: [{ id: 't1', estado: 'pendiente' }] };
  const { A, cap, T } = montar(estado);
  await A.iniciar();                        // siembra t1
  A.sincronizar('visible');
  await T.fire();
  assert.equal(tray(cap).length, 0, 'el pendiente ya conocido no es un nuevo trayecto');
});
