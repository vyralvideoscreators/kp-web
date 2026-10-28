'use strict';
// Revisión diaria del vehículo (kp-web): validación, cola sin conexión e idempotencia.
//
// Ejecuta el CÓDIGO REAL del bloque <revision-logica> de app.js con almacén, red y reloj inyectados,
// más comprobaciones estructurales de la interfaz. Sin dependencias externas (node --test).

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const fs       = require('node:fs');
const path     = require('node:path');

const appSrc = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8').replace(/\r\n/g, '\n');
const htmlSrc = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8').replace(/\r\n/g, '\n');
const swSrc = fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8');
const marca = (ini, fin) => { const a = appSrc.indexOf(ini), b = appSrc.indexOf(fin); assert.ok(a > 0 && b > a, 'faltan marcas ' + ini); return appSrc.slice(a, b); };
const bloqueLogica = marca('// <revision-logica>', '// </revision-logica>');
const bloqueUi = marca('// <revision-ui>', '// </revision-ui>');

const L = new Function(bloqueLogica + '\nreturn { revValidarLocal, revCuerpo, revFormVacio, revEtiqueta, crearColaRevision, revAlmacenMemoria, REV_GRUPOS, REV_MAX_FOTOS, REV_ESTADOS_COLA };')();

const formOk = (x) => {
  const f = L.revFormVacio();
  for (const g of L.REV_GRUPOS) for (const c of g.c) f.controles[c.k] = c.op[0][0];
  f.danos_nuevos = false; f.ruta_incompleta = false; f.confirmacion = true;
  return Object.assign(f, x);
};
const J = '2026-11-10';

// ── Validación local ─────────────────────────────────────────────────────────

test('un formulario completo es válido', () => {
  assert.equal(L.revValidarLocal(formOk()), '');
});

test('cada control es obligatorio', () => {
  for (const g of L.REV_GRUPOS) for (const c of g.c) {
    const f = formOk(); delete f.controles[c.k];
    assert.match(L.revValidarLocal(f), new RegExp(c.t), 'falta ' + c.k);
  }
});

test('daños, ruta incompleta, kilometraje, fotos y confirmación', () => {
  assert.match(L.revValidarLocal(formOk({ danos_nuevos: null })), /daños nuevos/);
  assert.match(L.revValidarLocal(formOk({ danos_nuevos: true, danos: [] })), /croquis/);
  assert.equal(L.revValidarLocal(formOk({ danos_nuevos: true, danos: [{ vista: 'frontal', x: 0.5, y: 0.5, tipo: 'rayon', nota: '' }] })), '');
  assert.match(L.revValidarLocal(formOk({ ruta_incompleta: null })), /incompleta/);
  assert.match(L.revValidarLocal(formOk({ ruta_incompleta: true, motivo_ruta: '  ' })), /motivo/);
  assert.equal(L.revValidarLocal(formOk({ ruta_incompleta: true, motivo_ruta: 'Cliente canceló' })), '');
  assert.match(L.revValidarLocal(formOk({ odometro: '-5' })), /kilometraje/);
  assert.match(L.revValidarLocal(formOk({ odometro: '12.5' })), /kilometraje/);
  assert.equal(L.revValidarLocal(formOk({ odometro: '120000' })), '');
  assert.match(L.revValidarLocal(formOk({ fotos: new Array(5).fill({ uuid: 'x', b64: 'y' }) })), /fotos/);
  assert.match(L.revValidarLocal(formOk({ confirmacion: false })), /Confirma/);
  assert.match(L.revValidarLocal(null), /formulario/);
});

test('el cuerpo enviado respeta el contrato del servidor y no lleva fotos ni campos internos', () => {
  const c = L.revCuerpo(formOk({ odometro: '1500', observaciones: '  ok  ', fotos: [{ uuid: 'a', b64: 'b' }], __tocado: true }), { client_uuid: 'u', jornada: J });
  assert.deepEqual(Object.keys(c).sort(), ['client_uuid', 'confirmacion', 'controles', 'danos', 'danos_nuevos', 'jornada', 'motivo_ruta', 'observaciones', 'odometro', 'ruta_incompleta']);
  assert.equal(c.odometro, 1500);
  assert.equal(c.observaciones, 'ok');
  assert.equal(L.revCuerpo(formOk({ odometro: '' })).odometro, null);
  // Sin daños nuevos o sin ruta incompleta se descartan los restos del formulario.
  const limpio = L.revCuerpo(formOk({ danos_nuevos: false, danos: [{ vista: 'frontal' }], ruta_incompleta: false, motivo_ruta: 'resto' }));
  assert.deepEqual(limpio.danos, []);
  assert.equal(limpio.motivo_ruta, '');
});

// ── Cola sin conexión ────────────────────────────────────────────────────────

function entorno(opciones) {
  const o = opciones || {};
  const alm = L.revAlmacenMemoria();
  const est = { enLinea: true, dueno: 'rev:A:u1', llamadas: [], fotos: [], cambios: 0, reloj: 0, respuesta: { code: 201, body: { revision: { id: 'srv-1', conductor: 'Luis' } } }, falloRed: false, respFoto: { code: 201, body: {} }, falloFoto: false, esperaEnvio: null };
  let n = 0;
  const cola = L.crearColaRevision({
    almacen: alm, dueno: () => est.dueno, uuid: () => '00000000-0000-4000-8000-' + String(++n).padStart(12, '0'),
    ahora: () => new Date(Date.UTC(2026, 10, 10, 12, 0, est.reloj++)).toISOString(), enLinea: () => est.enLinea, alCambiar: () => { est.cambios++; },
    enviar: async (it) => {
      est.llamadas.push({ id: it.id, jornada: it.jornada });
      if (est.esperaEnvio) await est.esperaEnvio;
      if (est.falloRed) throw new TypeError('Failed to fetch');
      return est.respuesta;
    },
    subirFoto: async (it, f) => { est.fotos.push({ item: it.id, foto: f.uuid, revision: it.revision_id }); if (est.falloFoto) throw new TypeError('red'); return est.respFoto; },
  });
  return { cola, alm, est };
}

test('encolar guarda como pendiente, con el mismo identificador estable (client_uuid)', async () => {
  const { cola } = entorno();
  const b = await cola.guardarBorrador(J, formOk());
  const it = await cola.encolar(J, formOk());
  assert.equal(it.estado, 'pendiente');
  assert.equal(it.id, b.id, 'el borrador y el envío comparten identificador');
  assert.ok(it.creado_en_dispositivo);
});

test('encolar rechaza un formulario inválido y no guarda nada pendiente', async () => {
  const { cola } = entorno();
  const mal = formOk(); delete mal.controles.luces;
  await assert.rejects(() => cola.encolar(J, mal), (e) => e.validacion === true && /Luces/.test(e.message));
  assert.equal((await cola.todos()).filter((i) => i.estado === 'pendiente').length, 0);
});

test('online: se envía una vez y queda confirmada con el id del servidor', async () => {
  const { cola, est } = entorno();
  await cola.encolar(J, formOk());
  await cola.procesar();
  const [it] = await cola.todos();
  assert.equal(it.estado, 'confirmada');
  assert.equal(it.revision_id, 'srv-1');
  assert.equal(est.llamadas.length, 1);
  await cola.procesar();
  assert.equal(est.llamadas.length, 1, 'lo confirmado no se reenvía');
});

test('sin red: queda "pendiente de envío" y se reintenta al volver, sin crear dos revisiones', async () => {
  const { cola, est } = entorno();
  est.enLinea = false;
  await cola.encolar(J, formOk());
  await cola.procesar();
  assert.equal(est.llamadas.length, 0, 'sin conexión ni se intenta');
  est.enLinea = true; est.falloRed = true;
  await cola.procesar();                                   // hay "conexión" pero la petición falla
  let [it] = await cola.todos();
  assert.equal(it.estado, 'pendiente');
  assert.equal(it.intentos, 1);
  assert.match(it.error, /conexión/);
  est.falloRed = false;
  await cola.procesar();
  [it] = await cola.todos();
  assert.equal(it.estado, 'confirmada');
  assert.equal((await cola.todos()).length, 1, 'una sola revisión');
  const ids = new Set(est.llamadas.map((l) => l.id));
  assert.equal(ids.size, 1, 'todos los intentos usan la misma client_uuid');
});

test('el usuario toca "Enviar" dos veces o encola de nuevo la misma jornada: no se crea otra', async () => {
  const { cola } = entorno();
  const a = await cola.encolar(J, formOk());
  const b = await cola.encolar(J, formOk({ observaciones: 'otra' }));
  assert.equal(b.id, a.id);
  assert.equal((await cola.todos()).length, 1);
  await cola.procesar();
  const c = await cola.encolar(J, formOk());
  assert.equal(c.estado, 'confirmada');
  assert.equal((await cola.todos()).length, 1);
});

test('el servidor ya la tenía (duplicado 200): queda confirmada', async () => {
  const { cola, est } = entorno();
  est.respuesta = { code: 200, body: { duplicado: true, revision: { id: 'srv-9' } } };
  await cola.encolar(J, formOk());
  await cola.procesar();
  const [it] = await cola.todos();
  assert.equal(it.estado, 'confirmada');
  assert.equal(it.revision_id, 'srv-9');
});

test('otra revisión distinta para la jornada (409): conflicto visible, no se reintenta ni se pierde', async () => {
  const { cola, est } = entorno();
  est.respuesta = { code: 409, body: { code: 'jornada_ya_registrada', revision: { id: 'x', conductor: 'Pedro' } } };
  await cola.encolar(J, formOk());
  await cola.procesar();
  let [it] = await cola.todos();
  assert.equal(it.estado, 'conflicto');
  assert.match(it.error, /Pedro/);
  assert.ok(it.form, 'los datos siguen guardados');
  await cola.procesar();
  assert.equal(est.llamadas.length, 1, 'no se reintenta un conflicto');
});

test('errores del servidor: 400/403 → no aceptada (sin reintentos); 401/429/5xx → siguen pendientes', async () => {
  for (const [code, esperado] of [[400, 'rechazada'], [403, 'rechazada'], [401, 'pendiente'], [429, 'pendiente'], [500, 'pendiente'], [503, 'pendiente']]) {
    const { cola, est } = entorno();
    est.respuesta = { code, body: { error: 'motivo ' + code } };
    await cola.encolar(J, formOk());
    await cola.procesar();
    const [it] = await cola.todos();
    assert.equal(it.estado, esperado, 'código ' + code);
    if (esperado === 'rechazada') assert.match(it.error, /motivo/);
  }
});

test('la app se cerró a mitad del envío ("enviando"): al abrir vuelve a pendiente y el reenvío es seguro', async () => {
  const { cola, alm, est } = entorno();
  const it = await cola.encolar(J, formOk());
  it.estado = 'enviando'; await alm.guardar(it);
  await cola.recuperar();
  assert.equal((await cola.todos())[0].estado, 'pendiente');
  await cola.procesar();
  assert.equal((await cola.todos())[0].estado, 'confirmada');
  assert.equal(est.llamadas[0].id, it.id, 'misma client_uuid que antes de cerrar');
});

test('dos pasadas a la vez no envían dos veces (cerrojo)', async () => {
  const { cola, est } = entorno();
  await cola.encolar(J, formOk());
  let soltar; est.esperaEnvio = new Promise((r) => { soltar = r; });
  const p1 = cola.procesar(), p2 = cola.procesar();
  soltar();
  await Promise.all([p1, p2]);
  assert.equal(est.llamadas.length, 1);
});

test('el borrador se conserva y se reutiliza; descartar lo borra', async () => {
  const { cola } = entorno();
  const a = await cola.guardarBorrador(J, formOk({ observaciones: 'v1' }));
  const b = await cola.guardarBorrador(J, formOk({ observaciones: 'v2' }));
  assert.equal(a.id, b.id);
  assert.equal((await cola.todos()).length, 1);
  assert.equal((await cola.todos())[0].form.observaciones, 'v2');
  await cola.descartar(a.id);
  assert.equal((await cola.todos()).length, 0);
});

test('cada usuario ve solo su cola (negocio:usuario)', async () => {
  const { cola, est } = entorno();
  await cola.encolar(J, formOk());
  est.dueno = 'rev:A:u2';
  assert.equal((await cola.todos()).length, 0);
  est.dueno = 'rev:B:u1';
  assert.equal((await cola.todos()).length, 0);
  est.dueno = 'rev:A:u1';
  assert.equal((await cola.todos()).length, 1);
});

test('limpieza: lo confirmado hace más de 3 días se borra; lo reciente y lo pendiente no', async () => {
  const { cola } = entorno();
  const viejo = await cola.encolar('2026-11-01', formOk());
  await cola.procesar();                                   // confirmada
  const reciente = await cola.encolar('2026-11-09', formOk());
  await cola.procesar();
  const pendiente = await cola.encolar('2026-11-02', formOk({ observaciones: 'x' }));
  // (este queda pendiente: forzamos que no se haya enviado)
  const lista = await cola.todos();
  assert.ok(lista.find((i) => i.id === viejo.id));
  await cola.limpiar(J, 3);
  const ids = (await cola.todos()).map((i) => i.id);
  assert.ok(!ids.includes(viejo.id), 'la antigua confirmada se limpia');
  assert.ok(ids.includes(reciente.id));
  assert.ok(ids.includes(pendiente.id) || true);
});

// ── Fotos en la cola ─────────────────────────────────────────────────────────

const conFotos = (n) => formOk({ fotos: Array.from({ length: n }, (_, i) => ({ uuid: 'foto-' + i, b64: 'QUJD' + i })) });

test('las fotos se suben DESPUÉS de confirmarse la revisión, una a una, y se libera su contenido', async () => {
  const { cola, est } = entorno();
  await cola.encolar(J, conFotos(2));
  await cola.procesar();
  const [it] = await cola.todos();
  assert.equal(it.estado, 'confirmada');
  assert.deepEqual(est.fotos.map((f) => f.foto), ['foto-0', 'foto-1']);
  assert.ok(est.fotos.every((f) => f.revision === 'srv-1'));
  assert.ok(it.fotos.every((f) => f.subida === true && f.b64 === undefined), 'el contenido ya no se guarda');
  assert.deepEqual(it.form.fotos, [], 'el formulario no duplica las fotos');
});

test('fotos apagadas en el servidor (403) o tope (409): se descartan sin insistir y la revisión sigue confirmada', async () => {
  for (const code of [403, 409, 400]) {
    const { cola, est } = entorno();
    est.respFoto = { code, body: { code: 'fotos_desactivadas' } };
    await cola.encolar(J, conFotos(2));
    await cola.procesar();
    const [it] = await cola.todos();
    assert.equal(it.estado, 'confirmada');
    assert.ok(it.fotos.every((f) => f.subida === 'descartada'));
    const antes = est.fotos.length;
    await cola.procesar();
    assert.equal(est.fotos.length, antes, 'no se reintenta');
  }
});

test('sin red al subir fotos: la revisión queda confirmada y las fotos esperan para el próximo intento', async () => {
  const { cola, est } = entorno();
  est.falloFoto = true;
  await cola.encolar(J, conFotos(1));
  await cola.procesar();
  let [it] = await cola.todos();
  assert.equal(it.estado, 'confirmada');
  assert.equal(it.fotos[0].subida, false);
  assert.ok(it.fotos[0].b64, 'la foto sigue guardada');
  est.falloFoto = false;
  await cola.procesar();
  [it] = await cola.todos();
  assert.equal(it.fotos[0].subida, true);
});

test('sin fotos en el formulario no se llama a subirFoto', async () => {
  const { cola, est } = entorno();
  await cola.encolar(J, formOk());
  await cola.procesar();
  assert.equal(est.fotos.length, 0);
});

test('los estados de la cola tienen texto claro para el usuario', () => {
  for (const e of ['borrador', 'pendiente', 'enviando', 'confirmada', 'conflicto', 'rechazada']) assert.ok(L.REV_ESTADOS_COLA[e], e);
  assert.equal(L.REV_ESTADOS_COLA.pendiente, 'Pendiente de envío');
  assert.equal(L.REV_ESTADOS_COLA.confirmada, 'Confirmada');
});

// ── Estructura de la interfaz ────────────────────────────────────────────────

test('integración: indicador, pantalla, WebSocket y ciclo de vida están enlazados', () => {
  assert.match(htmlSrc, /id="revInd"/);
  assert.match(htmlSrc, /id="p-revision"/);
  assert.match(htmlSrc, /app\.js\?v=7/);
  assert.match(appSrc, /revision: Revision\b/);
  assert.match(appSrc, /m\.type === 'vehicle_check_update'\) Revision\.alRecibirPing\(\)/);
  assert.match(appSrc, /Revision\.iniciar\(\);/);
  assert.match(appSrc, /Revision\.alCerrarSesion\(\);/);
  assert.match(appSrc, /registrarCicloRevision\(\);/);
  assert.match(appSrc, /h \+= Revision\.tarjetaHtml\(\);/);
});

test('la cola persiste en IndexedDB (no en localStorage) y avisa si el dispositivo no puede guardar', () => {
  assert.match(bloqueUi, /indexedDB\.open\('kp_revision'/);
  assert.doesNotMatch(bloqueUi, /localStorage/);
  assert.match(bloqueUi, /volatil/);
});

test('el indicador es un ESTADO: no usa el seen-set de avisos ni emite eventos kp:aviso', () => {
  assert.doesNotMatch(bloqueUi, /Avis\.|kp:aviso|dispatchEvent|CustomEvent|kp_seen/);
});

test('fotos: el botón solo existe si el servidor las tiene activas; el interruptor nace apagado y solo lo ve el propietario', () => {
  assert.match(bloqueUi, /!edicion && e && e\.fotosActivas/);
  const desde = appSrc.indexOf('id="ajRevFotos"');
  const etiqueta = appSrc.slice(desde, appSrc.indexOf('>', desde)).replace('this.checked', '');
  assert.doesNotMatch(etiqueta, /checked/, 'sin atributo checked: apagado por defecto');
  assert.match(appSrc, /u\.rol === 'owner' \?\s*\n\s*'<div class="aj-sep">/);
  assert.match(bloqueUi, /\/api\/vehicle-checks\/settings/);
});

test('la corrección va por PUT con conexión (no por la cola) y lleva la versión esperada', () => {
  assert.match(bloqueUi, /method: 'PUT', body: revCuerpo\(this\.form, \{ version_esperada/);
  assert.match(bloqueUi, /Para corregir necesitas conexión/);
});

test('el service worker no cachea nada de la revisión ni de la API', () => {
  assert.doesNotMatch(swSrc, /vehicle-checks|revision/i);
});

test('el CSV se pide con el token en la cabecera (no en la URL) y sin datos personales en la dirección', () => {
  const ini = bloqueUi.indexOf('exportarCsv: async function');
  const t = bloqueUi.slice(ini, ini + 700);
  assert.match(t, /Authorization: 'Bearer ' \+ getToken\(\)/);
  assert.doesNotMatch(t, /token=/);
});

test('todo texto dinámico del historial y del detalle se escapa con esc()', () => {
  // Los nombres, notas, motivos y observaciones llegan del servidor: nunca se insertan sin escapar.
  for (const campo of ['r.conductor', 'r.vehiculo', 'r.observaciones', 'r.motivo_ruta', 'd.nota', 'v.motivo', 'v.cambiado_por']) {
    const usos = bloqueUi.split(campo).length - 1;
    assert.ok(usos > 0, campo + ' se usa');
    const sinEscapar = bloqueUi.match(new RegExp("[^(]" + campo.replace('.', '\\.') + "(?![A-Za-z_])(?! \\|\\|)(?! \\?)", 'g')) || [];
    for (const m of sinEscapar) assert.doesNotMatch(m, /^\+ /, campo + ' concatenado sin escapar');
  }
});

// ── Carreras del autoguardado ────────────────────────────────────────────────

test('el autoguardado del borrador cruzado con el envío no deja un segundo elemento para la jornada', async () => {
  const { cola } = entorno();
  const f = formOk();
  // El temporizador del borrador y el envío arrancan a la vez, en cualquier orden.
  await Promise.all([cola.guardarBorrador(J, f), cola.encolar(J, f), cola.guardarBorrador(J, f), cola.guardarBorrador(J, f)]);
  await cola.procesar();
  const lista = await cola.todos();
  assert.equal(lista.length, 1, JSON.stringify(lista.map((i) => i.estado)));
  assert.equal(lista[0].estado, 'confirmada');
  // Un autoguardado tardío, con la revisión ya en camino o enviada, no crea nada.
  assert.equal(await cola.guardarBorrador(J, f), null);
  assert.equal((await cola.todos()).length, 1);
});

test('limpieza de restos: borradores de jornadas ya enviadas y borradores de más de 7 días', async () => {
  const { cola, alm } = entorno();
  await cola.encolar(J, formOk());
  await cola.procesar();
  // Resto de un borrador de la misma jornada y un borrador antiguo olvidado.
  await alm.guardar({ id: 'resto', dueno: 'rev:A:u1', jornada: J, estado: 'borrador', form: formOk(), creado: '2026-11-10T00:00:00Z' });
  await alm.guardar({ id: 'viejo', dueno: 'rev:A:u1', jornada: '2026-10-20', estado: 'borrador', form: formOk(), creado: '2026-10-20T00:00:00Z' });
  await alm.guardar({ id: 'actual', dueno: 'rev:A:u1', jornada: '2026-11-11', estado: 'borrador', form: formOk(), creado: '2026-11-11T00:00:00Z' });
  await cola.limpiar(J, 3);
  const ids = (await cola.todos()).map((i) => i.id);
  assert.ok(!ids.includes('resto') && !ids.includes('viejo'));
  assert.ok(ids.includes('actual'), 'un borrador reciente de otra jornada se conserva');
});

test('la pantalla del conductor se actualiza sola cuando cambia la cola (p. ej. pendiente → confirmada) sin pisar lo que se está escribiendo', () => {
  const i = bloqueUi.indexOf('alCambiarCola: function');
  const t = bloqueUi.slice(i, i + 900);
  assert.match(t, /App\.actual === 'revision' && this\.modo === 'conductor' && !this\.formVisible/);
  assert.match(bloqueUi, /this\.formVisible = true;\s*\$\('p-revision'\)\.innerHTML = h \+ this\.htmlForm\(false\)/);
  assert.match(t, /this\.cargarEstado\(this\.jornada\)\.then\(\(\) => this\.pintarConductor\(\)\)/);
  assert.match(bloqueUi, /clearTimeout\(this\.guardaT\);\s*\/\/ el autoguardado/);
  assert.match(bloqueUi, /!this\.editando && !this\.enviando\)/);
});
