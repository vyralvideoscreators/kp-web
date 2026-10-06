'use strict';
// FASE 5 — Evento "nuevo trayecto" (Avis) + su presentación (AvisosUI).
//
// Ejecuta el CÓDIGO REAL de los bloques <avis> y <avisos-ui> de app.js con
// dependencias inyectadas. El trayecto es un EVENTO (identidad transport:<id>,
// mismo seen-set y baseline que las citas); el badge de FASE 3 (estado) no entra
// aquí. Sin dependencias externas (node --test).

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const fs       = require('node:fs');
const path     = require('node:path');

globalThis.CustomEvent = globalThis.CustomEvent || class { constructor(t, o) { this.type = t; this.detail = o && o.detail; } };

const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8').replace(/\r\n/g, '\n');
const bloqueAvis = app.slice(app.indexOf('// <avis>'), app.indexOf('// </avis>'));
const bloqueUI   = app.slice(app.indexOf('// <avisos-ui>'), app.indexOf('// </avisos-ui>'));
assert.ok(bloqueAvis && bloqueUI, 'faltan los bloques <avis>/<avisos-ui>');

// ── Avis real ────────────────────────────────────────────────────────────────
function crearAvis(deps) {
  const fn = new Function('api', 'getToken', 'hoyYmd', 'Auth', 'Citas', 'toast', 'window', 'localStorage', 'Notification',
    bloqueAvis + '\n;return Avis;');
  return fn(deps.api, deps.getToken, deps.hoyYmd, deps.Auth, deps.Citas, deps.toast, deps.window, deps.localStorage, deps.Notification);
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
function apiDe(estado) {
  const fn = async (ruta) => {
    fn.rutas.push(ruta);
    if (estado.throwTransport && ruta.indexOf('/api/transport') !== -1) throw new Error('sin red');
    if (ruta.indexOf('estado=por_aprobar') !== -1) return (estado.porAprobar || []).slice();
    if (ruta.indexOf('estado=vivas') !== -1)       return (estado.vivas || []).slice();
    if (ruta.indexOf('/api/transport') !== -1)     return { paradas: (estado.paradas || []).slice() };
    return [];
  };
  fn.rutas = [];
  return fn;
}
function montar(estado, opts) {
  opts = opts || {};
  const cap = [];
  const ls = opts.ls || lsFalso();
  const api = apiDe(estado);
  const A = crearAvis({
    api, getToken: () => token(opts.biz || 'B1', opts.uid || 'U1'), hoyYmd: () => '2026-10-06',
    Auth: { usuario: { rol: opts.rol || 'owner', email: 'a@kp.com' } }, Citas: undefined, toast: () => {},
    window: winFalso(cap), localStorage: ls, Notification: undefined,
  });
  return { A, cap, ls, api };
}
const soloTrayectos = (cap) => cap.filter(e => e.tipo === 'nuevo_trayecto');

// ── Avis: detección del evento ────────────────────────────────────────────────
test('1 · un trayecto nuevo genera el evento con identidad transport:<id>', async () => {
  const estado = { porAprobar: [], vivas: [], paradas: [] };
  const { A, cap } = montar(estado);
  await A.iniciar();                                 // baseline vacío
  estado.paradas = [{ id: 't100', estado: 'pendiente' }];
  await A.procesar(true);
  const tr = soloTrayectos(cap);
  assert.equal(tr.length, 1);
  assert.equal(tr[0].payload.id, 't100');
  assert.ok(A.visto('transport:t100'), 'la identidad transport:t100 queda en el seen-set');
});

test('2 · el mismo trayecto no genera dos eventos', async () => {
  const estado = { paradas: [] };
  const { A, cap } = montar(estado);
  await A.iniciar();
  estado.paradas = [{ id: 't1', estado: 'pendiente' }];
  await A.procesar(true);           // emite
  await A.procesar(true);           // repite → nada
  assert.equal(soloTrayectos(cap).length, 1);
});

test('3 · refresh no repite el trayecto', async () => {
  const estado = { paradas: [{ id: 't1', estado: 'pendiente' }] };
  const { A, cap } = montar(estado);
  await A.iniciar();                // baseline siembra t1
  await A.procesar(true);           // "refresh" con el mismo t1
  assert.equal(soloTrayectos(cap).length, 0);
});

test('4 · reconexión no repite el trayecto', async () => {
  const estado = { paradas: [] };
  const { A, cap } = montar(estado);
  await A.iniciar();
  estado.paradas = [{ id: 't1', estado: 'pendiente' }];
  await A.procesar(true);           // ping tras aparecer → emite
  await A.procesar(true);           // reconexión → re-emite ping → ya visto
  assert.equal(soloTrayectos(cap).length, 1);
});

test('5 · cerrar/abrir (nueva instancia, mismo localStorage) no repite', async () => {
  const estado = { paradas: [] };
  const ls = lsFalso();
  const a = montar(estado, { ls });
  await a.A.iniciar();
  estado.paradas = [{ id: 't1', estado: 'pendiente' }];
  await a.A.procesar(true);         // emite t1
  assert.equal(soloTrayectos(a.cap).length, 1);
  const b = montar(estado, { ls });
  await b.A.iniciar();              // reabrir: ya hay base; t1 ya visto
  assert.equal(soloTrayectos(b.cap).length, 0);
});

test('6 · baseline: trayectos existentes en el primer arranque no generan avisos', async () => {
  const estado = { paradas: [{ id: 't1' }, { id: 't2' }, { id: 't3' }] };
  const { A, cap } = montar(estado);
  await A.iniciar();
  assert.equal(soloTrayectos(cap).length, 0, 'no bombardear con trayectos históricos');
  assert.ok(A.visto('transport:t1') && A.visto('transport:t3'));
});

test('7 · un transporte pendiente existente NO genera nuevo_trayecto', async () => {
  const estado = { paradas: [{ id: 't1', estado: 'pendiente' }] };
  const { A, cap } = montar(estado);
  await A.iniciar();                // sembrado
  await A.procesar(true);           // sigue pendiente → no es nuevo
  assert.equal(soloTrayectos(cap).length, 0);
});

test('8 · "abrir Transporte" (reprocesar el mismo estado) no genera nuevo_trayecto', async () => {
  const estado = { paradas: [{ id: 't1', estado: 'pendiente' }] };
  const { A, cap } = montar(estado);
  await A.iniciar();
  await A.procesar(true);
  await A.procesar(true);
  assert.equal(soloTrayectos(cap).length, 0, 'mirar el estado no crea eventos');
});

test('9 · entregar/cancelar una parada existente no genera nuevo trayecto', async () => {
  const estado = { paradas: [{ id: 't1', estado: 'pendiente' }] };
  const { A, cap } = montar(estado);
  await A.iniciar();
  estado.paradas = [{ id: 't1', estado: 'entregado' }];   // cambia de estado
  await A.procesar(true);
  estado.paradas = [];                                     // cancelada → el backend ya la excluye
  await A.procesar(true);
  assert.equal(soloTrayectos(cap).length, 0);
});

test('10 · tres trayectos nuevos generan tres identidades/eventos', async () => {
  const estado = { paradas: [] };
  const { A, cap } = montar(estado);
  await A.iniciar();
  estado.paradas = [{ id: 't1' }, { id: 't2' }, { id: 't3' }];
  await A.procesar(true);
  const tr = soloTrayectos(cap);
  assert.equal(tr.length, 3);
  assert.deepEqual(tr.map(e => e.payload.id).sort(), ['t1', 't2', 't3']);
});

test('19 · un fallo al consultar transporte no fabrica un trayecto ni aborta las citas', async () => {
  const estado = { porAprobar: [{ id: 'p1' }], vivas: [], throwTransport: true };
  const { A, cap } = montar(estado);
  await A.iniciar();                // baseline: p1 sembrado; transporte falla (aislado)
  estado.porAprobar = [{ id: 'p1' }, { id: 'p2' }];
  await A.procesar(true);
  assert.equal(soloTrayectos(cap).length, 0, 'un error de transporte no fabrica nuevo_trayecto');
  assert.ok(cap.some(e => e.tipo === 'cita_por_aprobar' && e.payload.id === 'p2'), 'las citas se siguen detectando');
});

test('roles · DRIVER recibe trayectos (fetch de transporte, sin citas)', async () => {
  const estado = { porAprobar: [{ id: 'p1' }], vivas: [{ id: 'c1', estado: 'confirmed', confirmadaEl: 'Z' }], paradas: [] };
  const { A, cap, api } = montar(estado, { rol: 'driver' });
  await A.iniciar();
  estado.paradas = [{ id: 't1', estado: 'pendiente' }];
  await A.procesar(true);
  assert.ok(api.rutas.every(r => r.indexOf('/api/appointments') === -1), 'el driver no consulta citas');
  assert.equal(soloTrayectos(cap).length, 1, 'el driver sí recibe el nuevo trayecto');
  assert.ok(cap.every(e => e.tipo === 'nuevo_trayecto'), 'y ningún evento de cita');
});

// ── AvisosUI: presentación del trayecto ───────────────────────────────────────
function crearUI(deps) {
  const fn = new Function('$', 'window', 'Auth', 'App', 'Citas', 'console', 'setTimeout', 'clearTimeout',
    bloqueUI + '\n;return AvisosUI;');
  return fn(deps.$, deps.window, deps.Auth, deps.App, deps.Citas, deps.console, deps.setTimeout, deps.clearTimeout);
}
function elAviso() {
  const t = { textContent: '' }, s = { textContent: '' };
  const el = { on: false, classList: { add() { el.on = true; }, remove() { el.on = false; } },
    querySelector: sel => (sel === '.aviso-t' ? t : (sel === '.aviso-s' ? s : null)) };
  return { el, t, s };
}
function winUI() { let h = null; return { addEventListener: (tp, fn) => { if (tp === 'kp:aviso') h = fn; }, emitir: d => h && h({ detail: d }) }; }
function montarUI(opts) {
  opts = opts || {};
  const { el, t, s } = elAviso();
  const win = winUI();
  const log = [];
  const App = { ir: sec => log.push('App.ir:' + sec) };
  const Citas = { cambiar: v => log.push('Citas.cambiar:' + v), ver: id => log.push('Citas.ver:' + id) };
  const UI = crearUI({ $: () => el, window: win, Auth: { usuario: { rol: opts.rol || 'owner' } }, App, Citas,
    console: { warn() {} }, setTimeout: () => 0, clearTimeout: () => {} });
  UI.init();
  return { UI, win, el, t, s, log };
}

test('11 · un nuevo trayecto se muestra como "Nuevo trayecto"', () => {
  const { win, el, t } = montarUI();
  win.emitir({ tipo: 'nuevo_trayecto', payload: { id: 't1', fecha: '2026-10-06' } });
  assert.equal(el.on, true);
  assert.equal(t.textContent, 'Nuevo trayecto');
});

test('12 · varios trayectos se resumen como "N trayectos nuevos" (un solo banner)', () => {
  const { win, el, t } = montarUI();
  win.emitir({ tipo: 'nuevo_trayecto', payload: { id: 't1' } });
  win.emitir({ tipo: 'nuevo_trayecto', payload: { id: 't2' } });
  win.emitir({ tipo: 'nuevo_trayecto', payload: { id: 't3' } });
  assert.equal(el.on, true);
  assert.equal(t.textContent, '3 trayectos nuevos');
});

test('13 · tap en nuevo trayecto navega a Transporte', () => {
  const { win, UI, log } = montarUI();
  win.emitir({ tipo: 'nuevo_trayecto', payload: { id: 't1' } });
  UI.alTocar();
  assert.ok(log.includes('App.ir:transporte'));
  assert.ok(!log.some(l => l.indexOf('Citas') === 0), 'no debe tocar Citas para un trayecto');
});

test('16-18 · OWNER, STAFF y DRIVER pueden recibir el trayecto', () => {
  for (const rol of ['owner', 'staff', 'driver']) {
    const { UI, win, el } = montarUI({ rol });
    assert.equal(UI.permitido('nuevo_trayecto'), true, rol + ' debe poder recibir trayecto');
    win.emitir({ tipo: 'nuevo_trayecto', payload: { id: 't1' } });
    assert.equal(el.on, true, rol + ' ve el aviso de trayecto');
  }
});

test('14-15 · la UI de trayecto no toca seen-set ni reemite (estructural)', () => {
  assert.ok(!/localStorage|seen|kp_seen|Avis\.|dispatchEvent|CustomEvent/.test(bloqueUI));
});
