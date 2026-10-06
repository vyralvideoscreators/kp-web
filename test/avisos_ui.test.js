'use strict';
// FASE 4 — UI in-app de avisos de citas (`AvisosUI`).
//
// Ejecuta el CÓDIGO REAL del bloque `// <avisos-ui> … </avisos-ui>` de app.js con
// dependencias inyectadas ($/window/Auth/App/Citas/console/timers falsos). La UI
// solo PINTA lo que Avis emite por `kp:aviso`: no consulta, no deduplica, no toca
// el seen-set, no reemite, no usa Notification API.

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const fs       = require('node:fs');
const path     = require('node:path');

const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8').replace(/\r\n/g, '\n');
const ini = app.indexOf('// <avisos-ui>');
const fin = app.indexOf('// </avisos-ui>');
assert.ok(ini !== -1 && fin !== -1 && fin > ini, 'no se encontró el bloque <avisos-ui>');
const bloque = app.slice(ini, fin);

// ── Dobles ───────────────────────────────────────────────────────────────────
function elAviso() {
  const t = { textContent: '' }, s = { textContent: '' };
  const el = {
    on: false,
    classList: { add() { el.on = true; }, remove() { el.on = false; }, contains() { return el.on; } },
    querySelector: (sel) => (sel === '.aviso-t' ? t : (sel === '.aviso-s' ? s : null)),
  };
  return { el, t, s };
}
function winFalso() {
  let handler = null;
  return {
    addEventListener: (tipo, h) => { if (tipo === 'kp:aviso') handler = h; },
    emitir: (detalle) => { if (handler) handler({ detail: detalle }); },
  };
}
function crearUI(deps) {
  const fn = new Function('$', 'window', 'Auth', 'App', 'Citas', 'console', 'setTimeout', 'clearTimeout',
    bloque + '\n;return AvisosUI;');
  return fn(deps.$, deps.window, deps.Auth, deps.App, deps.Citas, deps.console, deps.setTimeout, deps.clearTimeout);
}
function montar(opts) {
  opts = opts || {};
  const { el, t, s } = elAviso();
  const win = winFalso();
  const log = [];
  const App = { ir: (sec) => log.push('App.ir:' + sec) };
  const Citas = { cambiar: (v) => log.push('Citas.cambiar:' + v), ver: (id) => log.push('Citas.ver:' + id) };
  const UI = crearUI({
    $: () => el,
    window: win,
    Auth: { usuario: { rol: opts.rol || 'owner' } },
    App: App, Citas: Citas,
    console: { warn() {} },
    setTimeout: () => 0, clearTimeout: () => {},
  });
  UI.init();
  return { UI, win, el, t, s, log };
}

// ── Presentación ──────────────────────────────────────────────────────────────
test('1 · appt-confirmed → "Nueva cita"', () => {
  const { win, el, t } = montar();
  win.emitir({ tipo: 'cita_aprobada', payload: { id: 'a1' } });
  assert.equal(el.on, true);
  assert.equal(t.textContent, 'Nueva cita');
});

test('2 · appt-pending → "Nueva cita por aprobar"', () => {
  const { win, el, t } = montar();
  win.emitir({ tipo: 'cita_por_aprobar', payload: { id: 'p1' } });
  assert.equal(el.on, true);
  assert.equal(t.textContent, 'Nueva cita por aprobar');
});

test('3 · OWNER puede recibir ambos', () => {
  const { UI } = montar({ rol: 'owner' });
  assert.equal(UI.permitido('cita_aprobada'), true);
  assert.equal(UI.permitido('cita_por_aprobar'), true);
});

test('4 · STAFF puede recibir ambos', () => {
  const { UI, win, el } = montar({ rol: 'staff' });
  assert.equal(UI.permitido('cita_aprobada'), true);
  assert.equal(UI.permitido('cita_por_aprobar'), true);
  win.emitir({ tipo: 'cita_aprobada', payload: { id: 'a1' } });
  assert.equal(el.on, true);
});

test('5 · DRIVER no presenta avisos de citas (defensa de rol en la UI)', () => {
  const { UI, win, el } = montar({ rol: 'driver' });
  assert.equal(UI.permitido('cita_aprobada'), false);
  assert.equal(UI.permitido('cita_por_aprobar'), false);
  win.emitir({ tipo: 'cita_aprobada', payload: { id: 'a1' } });
  assert.equal(el.on, false, 'el driver no debe ver el aviso aunque llegue el evento');
});

// ── No invade a Avis ────────────────────────────────────────────────────────
test('6 · la UI NO escribe en el seen-set (no usa localStorage/seen/Avis)', () => {
  assert.ok(!/localStorage|seen|kp_seen|Avis\./.test(bloque), 'la UI no debe tocar el seen-set');
  // Se ejecuta sin inyectar localStorage; si lo usara, reventaría.
  const { win, el } = montar();
  win.emitir({ tipo: 'cita_aprobada', payload: { id: 'a1' } });
  assert.equal(el.on, true);
});

test('7 · la UI NO emite otro kp:aviso (no usa dispatchEvent/CustomEvent)', () => {
  assert.ok(!/dispatchEvent|CustomEvent/.test(bloque), 'la UI no debe emitir eventos');
});

test('8 · un evento no genera una segunda consulta de deduplicación (no usa api)', () => {
  assert.ok(!/\bapi\(/.test(bloque), 'la UI no debe consultar datos para deduplicar');
  // Corre sin inyectar `api`; si la UI lo usara para deduplicar, reventaría.
  const { win, el } = montar();
  win.emitir({ tipo: 'cita_por_aprobar', payload: { id: 'p1' } });
  assert.equal(el.on, true);
});

// ── Interacción ──────────────────────────────────────────────────────────────
test('9 · tap en cita aprobada usa la navegación existente (App.ir + Citas)', () => {
  const { win, UI, log, el } = montar();
  win.emitir({ tipo: 'cita_aprobada', payload: { id: 'a1' } });
  UI.alTocar();
  assert.ok(log.includes('App.ir:citas'), 'debe navegar a Citas con el flujo existente');
  assert.ok(log.includes('Citas.cambiar:agenda'));
  assert.ok(log.includes('Citas.ver:a1'), 'intenta abrir la cita concreta');
  assert.equal(el.on, false, 'tras tocar, el aviso se oculta');
});

test('10 · tap en cita por aprobar lleva a "Por aprobar"', () => {
  const { win, UI, log } = montar();
  win.emitir({ tipo: 'cita_por_aprobar', payload: { id: 'p1' } });
  UI.alTocar();
  assert.ok(log.includes('App.ir:citas'));
  assert.ok(log.includes('Citas.cambiar:aprobar'), 'debe ir a la vista Por aprobar');
});

// ── Coalescencia ─────────────────────────────────────────────────────────────
test('11 · varios eventos consecutivos NO crean una pila (un único elemento, texto resumido)', () => {
  const { win, el, t } = montar();
  win.emitir({ tipo: 'cita_por_aprobar', payload: { id: 'p1' } });
  win.emitir({ tipo: 'cita_por_aprobar', payload: { id: 'p2' } });
  win.emitir({ tipo: 'cita_por_aprobar', payload: { id: 'p3' } });
  assert.equal(el.on, true);
  assert.match(t.textContent, /3/, 'se resume en un solo aviso ("3 …"), no tres banners');
});

// ── Orden seguro ─────────────────────────────────────────────────────────────
test('12 · un fallo de presentación no propaga ni hace reaparecer el evento', () => {
  const { win, UI } = montar();
  UI.pintar = () => { throw new Error('UI caída'); };   // la presentación falla
  // El listener registrado por init envuelve en try/catch: no debe propagar.
  assert.doesNotThrow(() => win.emitir({ tipo: 'cita_aprobada', payload: { id: 'a1' } }));
  // La UI no reemite ni toca Avis: la identidad ya la registró Avis (FASE 2).
});
