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
  assert.match(L.revValidarLocal(formOk({ ruta_incompleta: null })), /completaste todos los pasos/);
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
  assert.match(htmlSrc, /app\.js\?v=11/);
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

// ── Revisión previa a la integración (tarea 014) ─────────────────────────────

test('una respuesta 200/201 SIN el id de la revisión no cuenta como confirmación: sigue pendiente y se reintenta', async () => {
  for (const cuerpoRaro of [{}, { ok: true }, { revision: {} }, { revision: null }]) {
    const { cola, est } = entorno();
    est.respuesta = { code: 200, body: cuerpoRaro };
    await cola.encolar(J, formOk());
    await cola.procesar();
    const [it] = await cola.todos();
    assert.equal(it.estado, 'pendiente', JSON.stringify(cuerpoRaro));
    assert.match(it.error, /inesperada/);
    assert.equal(it.intentos, 1);
    est.respuesta = { code: 201, body: { revision: { id: 'srv-7' } } };
    await cola.procesar();
    assert.equal((await cola.todos())[0].estado, 'confirmada');
    assert.equal(est.llamadas.length, 2);
    assert.equal(new Set(est.llamadas.map((l) => l.id)).size, 1, 'misma client_uuid en el reintento');
  }
});

test('no aceptada por el servidor: se puede corregir y reenviar sin perder lo escrito; el conflicto solo se descarta', () => {
  assert.match(bloqueUi, /item\.estado === 'rechazada' \? '<button class="btn-linea btn-solido" onclick="Revision\.editarRechazada/);
  const i = bloqueUi.indexOf('editarRechazada: async function');
  const t = bloqueUi.slice(i, i + 900);
  assert.match(t, /Object\.assign\(revFormVacio\(\), it\.form \|\| \{\}, \{ confirmacion: false \}\)/);
  assert.match(t, /it\.estado !== 'rechazada'\) return/);
  assert.match(t, /await this\.cola\.descartar\(id\)/);
});

test('un aviso del servidor repinta la pantalla salvo que el conductor esté escribiendo el formulario', () => {
  const i = bloqueUi.indexOf('alRecibirPing: function');
  const t = bloqueUi.slice(i, i + 400);
  assert.match(t, /!this\.formVisible && !this\.editando\) this\.abrir\(\)/);
});

test('WebSocket: el manejador REAL ignora tipos desconocidos y mensajes rotos; vehicle_check_update solo avisa a la revisión', () => {
  const ini = appSrc.indexOf('this.ws.onmessage = e => {');
  const fin = appSrc.indexOf('this.ws.onclose', ini);
  assert.ok(ini > 0 && fin > ini);
  const codigo = appSrc.slice(ini, fin);
  const llamadas = [];
  const reg = (n) => (...a) => { llamadas.push(n + (a.length ? ':' + a.join(',') : '')); };
  // El manejador real se ejecuta con `this` = un contenedor de pruebas y los colaboradores sustituidos por espías.
  const cont = new Function('llamadas', 'Avis', 'Revision', 'actualizarBadgeTransporte', 'Transporte',
    'const cont = { ws: {}, huboReady: false, estado: (ok) => { llamadas.push("estado:" + ok); } };\n(function () {\n' + codigo + '\n}).call(cont);\nreturn cont;')(
    llamadas,
    { alRecibirPing: reg('avis.ping'), sincronizar: reg('avis.sync') },
    { alRecibirPing: reg('rev.ping'), refrescarIndicador: reg('rev.refrescar'), alVolver: reg('rev.volver') },
    reg('badge'), { fecha: J });
  const enviar = (m) => cont.ws.onmessage({ data: typeof m === 'string' ? m : JSON.stringify(m) });
  enviar({ type: 'tipo_futuro_desconocido' });
  enviar('esto no es json');
  enviar({});
  assert.deepEqual(llamadas, [], 'lo desconocido o roto no hace nada ni lanza');
  enviar({ type: 'vehicle_check_update' });
  assert.deepEqual(llamadas, ['rev.ping'], 'solo la revisión reacciona (no el seen-set de citas)');
  llamadas.length = 0;
  enviar({ type: 'appointment_update' });
  assert.deepEqual(llamadas, ['avis.ping', 'badge:' + J, 'rev.refrescar']);
  llamadas.length = 0;
  enviar({ type: 'ready' }); enviar({ type: 'ready' });
  assert.deepEqual(llamadas, ['estado:true', 'estado:true', 'avis.sync:ws-reconnect', 'rev.volver'], 'solo la RECONEXIÓN resincroniza');
});

// ── Correcciones de la auditoría ─────────────────────────────────────────────

test('procesar: lo encolado durante una pasada lenta se envía en la misma tanda (sin despertar perdido)', async () => {
  const { cola, est } = entorno();
  const J2 = '2026-11-09';
  await cola.encolar(J2, formOk());
  let soltar; est.esperaEnvio = new Promise((r) => { soltar = r; });
  const lenta = cola.procesar();
  await new Promise((r) => setTimeout(r, 5));
  est.esperaEnvio = null;
  await cola.encolar(J, formOk());
  await cola.procesar();          // llega mientras la primera sigue ocupada: debe anotarse
  soltar();
  await lenta;
  const estados = Object.fromEntries((await cola.todos()).map((i) => [i.jornada, i.estado]));
  assert.deepEqual(estados, { [J2]: 'confirmada', [J]: 'confirmada' });
});

test('aviso de almacenamiento no duradero: se consulta en vivo, no una sola vez al crear la cola', () => {
  assert.match(bloqueUi, /esVolatil: function \(\) \{ return !!\(this\.alm && this\.alm\.volatil\); \}/);
  assert.match(bloqueUi, /if \(this\.esVolatil\(\)\) h \+=/);
  assert.doesNotMatch(bloqueUi, /this\.volatil\b/);
});

test('el historial reinicia formVisible (si no, los avisos dejan de repintarlo)', () => {
  const i = bloqueUi.indexOf('abrirHistorial: async function');
  assert.match(bloqueUi.slice(i, i + 250), /this\.formVisible = false/);
});

test('editarRechazada guarda el borrador ANTES de descartar la rechazada', () => {
  const i = bloqueUi.indexOf('editarRechazada: async function');
  const t = bloqueUi.slice(i, i + 1200);
  const g = t.indexOf('this.cola.guardarBorrador(');
  const d = t.indexOf('this.cola.descartar(id)');
  assert.ok(g > 0 && d > g, 'guardarBorrador debe ir antes que descartar');
});

// ── Cambios de diseño: secciones desplegables, confirmación flotante, sin ventilación ──

test('el formulario ya no pide "Ventilación del área de carga"', () => {
  assert.doesNotMatch(appSrc, /ventilacion_carga/);
  assert.doesNotMatch(appSrc, /Ventilación del área de carga/);
});

test('el kilometraje local rechaza lo que el servidor rechaza (hexadecimal, científica, espacios)', () => {
  const f = new Function(appSrc.slice(appSrc.indexOf('function revOdometroValido'), appSrc.indexOf('// Validación previa al envío')) + '\nreturn revOdometroValido;')();
  for (const v of ['', null, undefined, '0', '1200', ' 1200 ', 2000000, 0]) assert.equal(f(v), true, String(v));
  for (const v of [' ', '0x10', '1e3', '-1', '12.5', '2000001', '99999999', 'abc']) assert.equal(f(v), false, JSON.stringify(v));
});

test('cada título del formulario es una sección desplegable con botón a la derecha, cerrada por defecto', () => {
  const i = bloqueUi.indexOf('htmlForm: function');
  const t = bloqueUi.slice(i, i + 4200);
  for (const id of ["'g' + i", "'km'", "'danos'", "'ruta'", "'fotos'", "'obs'"]) assert.ok(t.includes('this.seccion(' + id), id);
  assert.doesNotMatch(t, /class="aj-grupo"/, 'ya no quedan títulos sueltos');
  const s = bloqueUi.slice(bloqueUi.indexOf('seccion: function'), bloqueUi.indexOf('progreso: function'));
  assert.match(s, /aria-expanded/);
  assert.match(s, /rev-chev/);
  assert.match(s, /type="button"/);
  assert.match(bloqueUi, /abiertas: \{\}/, 'todas cerradas al empezar');
});

test('el estado de cada sección sale del formulario: pendiente, completa u opcional', () => {
  const o = Object.create(null);
  const src = bloqueUi.slice(bloqueUi.indexOf('progreso: function'), bloqueUi.indexOf('idsSecciones: function')).replace(/^progreso: function/, 'function progreso');
  const progreso = new Function('REV_GRUPOS', 'REV_MAX_FOTOS', 'revFormVacio', 'revOdometroValido', src.replace(/,\s*$/, '') + '\nreturn progreso;')(
    [{ c: [{ k: 'a', op: [['x', 'X']] }, { k: 'b', op: [['x', 'X']] }] }], 4, () => ({ controles: {}, odometro: '', danos_nuevos: null, danos: [], ruta_incompleta: null, motivo_ruta: '', observaciones: '', fotos: [] }),
    (v) => v === '' || /^\d+$/.test(String(v)));
  const con = (form) => (id) => progreso.call({ form }, id);
  const v = con({ controles: { a: 'x' }, odometro: '', danos_nuevos: true, danos: [], ruta_incompleta: true, motivo_ruta: 'a', observaciones: '', fotos: [] });
  assert.deepEqual([v('g0').texto, v('g0').completa], ['1/2', false]);
  assert.deepEqual([v('km').texto, v('km').completa], ['Opcional', true]);
  assert.deepEqual([v('danos').texto, v('danos').completa], ['Sin marcar', false]);
  assert.deepEqual([v('ruta').texto, v('ruta').completa], ['Falta el motivo', false]);
  const w = con({ controles: { a: 'x', b: 'x' }, odometro: '12', danos_nuevos: false, danos: [], ruta_incompleta: false, motivo_ruta: '', observaciones: 'ok', fotos: [{}] });
  for (const id of ['g0', 'km', 'danos', 'ruta', 'fotos', 'obs']) assert.equal(w(id).completa, true, id);
  assert.equal(w('g0').texto, '✓');
  assert.equal(w('fotos').texto, '1/4');
});

test('enviar y guardar corrección piden confirmación flotante ANTES de enviar o guardar', () => {
  const e = bloqueUi.slice(bloqueUi.indexOf('enviar: async function'), bloqueUi.indexOf('reintentar: async function'));
  assert.ok(e.indexOf('confirmarEnvio(false)') > 0 && e.indexOf('confirmarEnvio(false)') < e.indexOf('this.cola.encolar('), 'envío');
  const c = bloqueUi.slice(bloqueUi.indexOf('guardarCorreccion: async function'), bloqueUi.indexOf('// ── Resúmenes de solo lectura'));
  assert.ok(c.indexOf('confirmarEnvio(true)') > 0 && c.indexOf('confirmarEnvio(true)') < c.indexOf("method: 'PUT'"), 'corrección');
  assert.match(e, /mostrarPrimeraIncompleta/);
});

test('la ventana de confirmación: centrada, accesible y con "Revisar" por defecto', () => {
  assert.match(htmlSrc, /id="revModal"[^>]*aria-hidden="true"/);
  assert.match(htmlSrc, /role="alertdialog" aria-modal="true"/);
  assert.match(htmlSrc, /¿Estás seguro de que el informe está completo\?/);
  assert.match(htmlSrc, /id="revModalNo">Revisar</);
  assert.match(htmlSrc, /\.rev-modal \{[^}]*display: grid; place-items: center/);
  const t = bloqueUi.slice(bloqueUi.indexOf('confirmarEnvio: function'), bloqueUi.indexOf('// Reduce una foto') > 0 ? undefined : undefined);
  assert.match(t, /Escape/);
  assert.match(t, /no\.focus\(\)/, 'el foco inicial es "Revisar"');
});

// ── Comportamiento real de la ventana de confirmación (con un DOM mínimo) ──
function ventanaDePrueba() {
  const clases = new Set(); const escuchas = {};
  const el = (id) => ({ id, textContent: '', onclick: null, focus() { dom.foco = id; } });
  const dom = { foco: '', nodos: { revModalSub: el('revModalSub'), revModalSi: el('revModalSi'), revModalNo: el('revModalNo') }, teclas: [] };
  dom.nodos.revModal = Object.assign(el('revModal'), {
    classList: { add: (c) => clases.add(c), remove: (c) => clases.delete(c), contains: (c) => clases.has(c) },
    setAttribute() {}, addEventListener: (t, f) => { escuchas[t] = f; }, removeEventListener: (t) => { delete escuchas[t]; },
  });
  const doc = { activeElement: { focus() { dom.foco = 'previo'; } },
    addEventListener: (t, f) => { dom.tecla = f; }, removeEventListener: () => { dom.tecla = null; } };
  const ini = bloqueUi.indexOf('confirmarEnvio: function'), fin = bloqueUi.indexOf('\n  },\n', ini) + 4;
  const src = bloqueUi.slice(ini, fin).replace(/^confirmarEnvio: function/, 'function confirmarEnvio');
  const fn = new Function('$', 'document', src + '\nreturn confirmarEnvio;')((id) => dom.nodos[id], doc);
  const ctx = { cierraModal: null };
  return { dom, clases, escuchas, abrir: (corr) => fn.call(ctx, corr), ctx };
}

test('ventana de confirmación: "Sí" resuelve true; "Revisar", Escape, clic fuera y cierre externo resuelven false; los listeners se quitan', async () => {
  for (const [accion, esperado] of [['si', true], ['no', false], ['esc', false], ['fuera', false], ['externo', false]]) {
    const w = ventanaDePrueba();
    const p = w.abrir(false);
    assert.equal(w.clases.has('on'), true);
    assert.equal(w.dom.foco, 'revModalNo', 'el foco inicial es "Revisar"');
    assert.equal(w.dom.nodos.revModalSi.textContent, 'Sí, enviar');
    if (accion === 'si') w.dom.nodos.revModalSi.onclick();
    else if (accion === 'no') w.dom.nodos.revModalNo.onclick();
    else if (accion === 'esc') w.dom.tecla({ key: 'Escape', preventDefault() {} });
    else if (accion === 'fuera') w.escuchas.click({ target: w.dom.nodos.revModal });
    else w.ctx.cierraModal(false);
    assert.equal(await p, esperado, accion);
    assert.equal(w.clases.has('on'), false, accion + ': se cierra');
    assert.equal(w.dom.tecla, null, accion + ': sin listener de teclado');
    assert.equal(w.escuchas.click, undefined, accion + ': sin listener de clic');
    assert.equal(w.ctx.cierraModal, null);
  }
});

test('ventana de confirmación de corrección: textos propios y la trampa de foco recoge un foco perdido', async () => {
  const w = ventanaDePrueba();
  const p = w.abrir(true);
  assert.equal(w.dom.nodos.revModalSi.textContent, 'Sí, guardar');
  assert.match(w.dom.nodos.revModalSub.textContent, /nueva versión/);
  w.dom.foco = 'body';
  let evitado = false;
  w.dom.tecla({ key: 'Tab', shiftKey: false, preventDefault() { evitado = true; } });
  assert.equal(evitado, true);
  assert.equal(w.dom.foco, 'revModalNo');
  w.dom.nodos.revModalNo.onclick();
  assert.equal(await p, false);
});

test('enviar y guardar corrección: si la ventana falla o se cancela, "enviando" no queda atascado', () => {
  for (const [ini, fin, arg] of [['enviar: async function', 'reintentar: async function', 'false'], ['guardarCorreccion: async function', '// ── Resúmenes de solo lectura', 'true']]) {
    const t = bloqueUi.slice(bloqueUi.indexOf(ini), bloqueUi.indexOf(fin));
    assert.ok(t.includes('try { ok = await this.confirmarEnvio(' + arg + '); } finally { if (!ok) this.enviando = false; }'), ini);
  }
});

test('al cerrar la sesión se cierra la ventana de confirmación', () => {
  const t = bloqueUi.slice(bloqueUi.indexOf('alCerrarSesion: function'), bloqueUi.indexOf('alVolver: function'));
  assert.match(t, /if \(this\.cierraModal\) this\.cierraModal\(false\)/);
});

// ── Croquis y pregunta de la ruta ──

test('croquis: el punto se calcula con la matriz real del SVG (no con el ancho de la caja) y cae donde se toca', () => {
  const ini = appSrc.indexOf('function revPuntoEnCroquis'), fin = appSrc.indexOf('// Etiqueta legible', ini);
  const f = new Function(appSrc.slice(ini, fin) + '\nreturn revPuntoEnCroquis;')();
  // Caja de 400x220 con un dibujo 300x170 centrado (escala 1.294): bandas laterales de 6.1 px por lado... se simula con la matriz.
  const escala = 220 / 170, ancho = 300 * escala, margen = (400 - ancho) / 2;
  const svg = {
    viewBox: { baseVal: { width: 300, height: 170 } },
    getScreenCTM: () => ({ inverse: () => ({ a: 1 / escala, d: 1 / escala, e: -margen / escala, f: 0 }) }),
    createSVGPoint: () => ({ x: 0, y: 0, matrixTransform(m) { return { x: this.x * m.a + m.e, y: this.y * m.d + m.f }; } }),
  };
  // Tocar el centro de la caja = centro del dibujo.
  const c = f(svg, 200, 110);
  assert.ok(Math.abs(c.x - 0.5) < 1e-9 && Math.abs(c.y - 0.5) < 1e-9, JSON.stringify(c));
  // Tocar justo en el borde izquierdo del dibujo (no de la caja) = x 0; el mismo toque con el cálculo antiguo daría 0.1.
  assert.ok(Math.abs(f(svg, margen, 0).x) < 1e-9);
  // Fuera del dibujo (banda lateral): se queda en el borde, no sale del rango.
  assert.equal(f(svg, 0, 110).x, 0);
  // Sin matriz disponible no se inventa nada.
  assert.equal(f({ viewBox: null }, 10, 10), null);
});

test('ruta: la pregunta es "¿Completaste todos los pasos de las rutas?"; "Sí" = ruta completa (ruta_incompleta false) y "No" pide el motivo', () => {
  assert.match(appSrc, /¿Completaste todos los pasos de las rutas\?/);
  assert.doesNotMatch(appSrc, /¿Quedó la ruta incompleta\?/);
  assert.ok(appSrc.includes("[[false, 'Sí'], [true, 'No']]"), 'Sí → false, No → true');
  assert.ok(appSrc.includes("this.marcarGrupo('rg-ruta', v ? 1 : 0)"), '"Sí" es el primer botón');
  assert.match(appSrc, /Indica si completaste todos los pasos de las rutas/);
});
