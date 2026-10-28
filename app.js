'use strict';
// ══════════════════════════════════════════════════════════════
// Kisses and Paws — app móvil del dueño (Capacitor/Android)
// Consume la API existente de kissesandpaws. No modifica el backend.
// 4 secciones: Citas, Clientes (directorio), Transporte, Informes.
// ══════════════════════════════════════════════════════════════

// El backend por defecto es el local. En un teléfono real se cambia por la IP
// de la red (p. ej. http://192.168.1.20:3100) desde "Servidor" en el login.
const backendGuardado = (() => { try { return localStorage.getItem('kp_backend'); } catch (e) { return null; } })();

// ¿La app corre en una PC local (desarrollo) o publicada en internet?
const APP_LOCAL = (function () {
  const h = location.hostname || '';
  return h === 'localhost' || h === '127.0.0.1' ||
    h.startsWith('192.168.') || h.startsWith('10.') || h.startsWith('172.');
})();

const RAILWAY = 'https://kissesandpaws-production.up.railway.app';

// A qué backend habla la app:
//  · Publicada en internet (para Christian) → SIEMPRE producción (Railway).
//    Ignora y borra cualquier dirección guardada, para que una dirección vieja
//    o local no rompa el acceso.
//  · En desarrollo (PC de Carlos) → respeta lo guardado, o usa el backend local.
let BACKEND;
if (!APP_LOCAL) {
  BACKEND = RAILWAY;
  try { localStorage.removeItem('kp_backend'); } catch (e) {}
} else {
  BACKEND = backendGuardado || 'http://192.168.0.106:3100';
}

const getToken = () => { try { return localStorage.getItem('kp_token') || ''; } catch (e) { return ''; } };
const setToken = t => { try { t ? localStorage.setItem('kp_token', t) : localStorage.removeItem('kp_token'); } catch (e) {} };

// ── Utilidades ────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ymd = f => String(f == null ? '' : f).slice(0, 10);
const fmtDinero = n => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function diaBonito(y) {
  if (!y) return '';
  const d = new Date(y + 'T12:00:00');
  const s = d.toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' });
  return s.charAt(0).toUpperCase() + s.slice(1);
}
function hoyYmd() {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
  return f.format(new Date());
}
function sumarDias(y, n) {
  const d = new Date(y + 'T12:00:00'); d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

let toastTimer = null;
function toast(msg) {
  const t = $('toast'); t.textContent = msg; t.classList.add('on');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('on'), 2500);
}

async function api(ruta, opciones) {
  const o = opciones || {};
  const res = await fetch(BACKEND + ruta, {
    method: o.method || 'GET',
    headers: Object.assign({ 'Authorization': 'Bearer ' + getToken() }, o.body ? { 'Content-Type': 'application/json' } : {}),
    body: o.body ? JSON.stringify(o.body) : undefined,
  });
  // 401 = el token no vale (sin sesión, expiró o se cerró desde otro sitio):
  // ahí sí hay que mandar a la pantalla de entrar. 403 = sí está autenticada,
  // solo que esta ruta no es para su rol (p. ej. un driver topando con algo
  // fuera de su alcance, como /api/appointments) — no es que "se cerró la
  // sesión", así que no debe desconectarla ni borrarle el token.
  if (res.status === 401) { setToken(''); Auth.mostrarLogin(); throw new Error('Sesión terminada'); }
  const cuerpo = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(cuerpo.error || 'No se pudo completar');
  return cuerpo;
}

// Como api(), pero devuelve {code, body} sin lanzar por el código HTTP: solo lanza si no hay red.
// La cola de la revisión del vehículo lo necesita para distinguir "ya existe" de "sin conexión".
async function apiRaw(ruta, opciones) {
  const o = opciones || {};
  const res = await fetch(BACKEND + ruta, {
    method: o.method || 'GET',
    headers: Object.assign({ 'Authorization': 'Bearer ' + getToken() }, o.body ? { 'Content-Type': 'application/json' } : {}),
    body: o.body ? JSON.stringify(o.body) : undefined,
  });
  if (res.status === 401) { setToken(''); Auth.mostrarLogin(); return { code: 401, body: {} }; }
  return { code: res.status, body: await res.json().catch(() => ({})) };
}

// ── Hoja de confirmación (un paso, para lo irreversible) ──────
const Hoja = {
  abrir: function (html) { $('hoja').innerHTML = html; $('velo').classList.add('on'); $('hoja').classList.add('on'); },
  cerrar: function () { $('velo').classList.remove('on'); $('hoja').classList.remove('on'); },
};

// ── Notificaciones ────────────────────────────────────────────
// Núcleo central de avisos (FASE 2). Fuente ÚNICA de verdad para los EVENTOS
// de notificación. Ante el ping `appointment_update` del WebSocket (que no trae
// payload) consulta las fuentes ya auditadas, construye una IDENTIDAD por evento
// y la compara contra un `seen-set` PERSISTIDO en localStorage (aislado por
// negocio+usuario): solo es NUEVO lo que no estuviera ya registrado. NO usa
// contadores. El primer arranque sin historial SIEMBRA el seen-set sin avisar
// (baseline). Emite un CustomEvent `kp:aviso` que las fases 4/5 pintarán; aquí
// todavía NO hay UI nueva. Los ESTADOS (transporte pendiente) NO pasan por el
// seen-set: su futuro badge (FASE 3) se calculará del estado real, nunca de aquí.
// <avis>
const Avis = {
  seen: {}, tieneBase: false, usuario: null, ocupado: false, pendiente: false,
  epoca: 0, syncTimer: null,               // epoca = guardia de sesión (logout/cambio de usuario)
  VENTANA_MS: 90 * 24 * 60 * 60 * 1000,    // poda del seen-set (90 días)
  DEBOUNCE_SYNC_MS: 400,                   // agrupa señales de ciclo de vida cercanas

  // ── Preferencias/permiso de notificación. Se conservan para fases futuras
  //    (FASE 4 presentación, FASE 8 push); la DETECCIÓN no depende de ellas,
  //    solo del rol. ──
  activa:  function (tipo) { try { return localStorage.getItem('kp_notif_' + tipo) === '1'; } catch (e) { return false; } },
  guardar: function (tipo, on) { try { on ? localStorage.setItem('kp_notif_' + tipo, '1') : localStorage.removeItem('kp_notif_' + tipo); } catch (e) {} },
  permiso: function () { return (typeof Notification !== 'undefined') ? Notification.permission : 'no'; },
  alternar: async function (tipo, on) {
    if (on) {
      if (typeof Notification === 'undefined') { toast('Este dispositivo no soporta notificaciones'); return false; }
      let p = Notification.permission;
      if (p === 'default') { try { p = await Notification.requestPermission(); } catch (e) {} }
      if (p !== 'granted') { toast('Permiso de notificaciones denegado'); return false; }
    }
    this.guardar(tipo, on);
    return true;
  },

  // ── Identidad de cada evento (cerrada en FASE 1.B). ──
  idAprobada:  function (c) { return 'appt-confirmed:' + c.id + ':' + (c.confirmadaEl || ''); },
  idPendiente: function (c) { return 'appt-pending:' + c.id; },
  idTrayecto:  function (p) { return 'transport:' + p.id; },

  // ── seen-set persistido, aislado por negocio+usuario. El negocio y el usuario
  //    salen del JWT (businessId, userId); si no se puede decodificar, se cae al
  //    email. Así el set de un usuario/negocio nunca se mezcla con el de otro. ──
  clave: function () {
    let biz = 'sin-negocio', uid = 'anon';
    try {
      const p = JSON.parse(atob(getToken().split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
      if (p.businessId) biz = String(p.businessId);
      if (p.userId) uid = String(p.userId);
    } catch (e) {}
    if (uid === 'anon' && this.usuario && this.usuario.email) uid = this.usuario.email;
    return 'kp_seen:' + biz + ':' + uid;
  },
  cargar: function () {
    this.seen = {}; this.tieneBase = false;
    try {
      const raw = localStorage.getItem(this.clave());
      if (raw) { const o = JSON.parse(raw); this.seen = (o && o.ids) || {}; this.tieneBase = true; this.podar(); }
    } catch (e) { this.seen = {}; this.tieneBase = false; }
  },
  persistir: function () {
    try { localStorage.setItem(this.clave(), JSON.stringify({ v: 1, ids: this.seen })); } catch (e) {}
  },
  podar: function () {
    const corte = Date.now() - this.VENTANA_MS;
    for (const k in this.seen) { if (this.seen[k] < corte) delete this.seen[k]; }
  },
  visto:  function (id) { return Object.prototype.hasOwnProperty.call(this.seen, id); },
  marcar: function (id) { this.seen[id] = Date.now(); },

  // ── Emisión: un evento interno que la UI (fases 4/5) consumirá. Aquí NO se
  //    pinta nada todavía. ──
  emitir: function (tipo, payload) {
    if (typeof window !== 'undefined' && typeof CustomEvent !== 'undefined') {
      window.dispatchEvent(new CustomEvent('kp:aviso', { detail: { tipo: tipo, payload: payload } }));
    }
  },

  // ── Candidatos desde las fuentes ya auditadas. Filtra por ROL: un DRIVER no
  //    puede consultar citas (/api/appointments → 403), así que ni se le piden,
  //    pero SÍ recibe trayectos (tiene acceso a Transporte).
  //
  //    TRANSPORTE como EVENTO (FASE 5): cada parada de /api/transport?date=hoy es
  //    un candidato con identidad `transport:<parada.id>`. Como van por el MISMO
  //    seen-set y el MISMO baseline que las citas, solo se emite "nuevo trayecto"
  //    cuando aparece una parada con id NUNCA visto: un cambio de estado de una
  //    parada existente NO cambia su id (no reemite), y las paradas presentes en
  //    el primer arranque se siembran sin avisar (baseline). Esto es un EVENTO,
  //    distinto del ESTADO "transporte pendiente" (badge, FASE 3), que se calcula
  //    aparte del estado real y NUNCA usa el seen-set.
  //    Si la consulta de transporte falla, se aísla: ni se fabrica un trayecto ni
  //    se abortan los eventos de cita (§17). ──
  recolectar: async function () {
    const esDriver = this.usuario && this.usuario.rol === 'driver';
    const out = [];
    if (!esDriver) {
      const pend = await api('/api/appointments?estado=por_aprobar');
      (pend || []).forEach(c => out.push({ id: this.idPendiente(c), tipo: 'cita_por_aprobar', payload: c }));
      const vivas = await api('/api/appointments?desde=' + hoyYmd() + '&estado=vivas');
      (vivas || []).forEach(c => { if (c.estado === 'confirmed' && c.confirmadaEl) out.push({ id: this.idAprobada(c), tipo: 'cita_aprobada', payload: c }); });
    }
    try {
      const hoy = hoyYmd();
      const tr = await api('/api/transport?date=' + hoy);
      ((tr && tr.paradas) || []).forEach(p => out.push({ id: this.idTrayecto(p), tipo: 'nuevo_trayecto', payload: { id: p.id, fecha: hoy } }));
    } catch (e) { if (typeof console !== 'undefined') console.warn('[Avis] no se pudo revisar transporte', e); }
    return out;
  },

  // ── Núcleo: identificar → comprobar → registrar de forma segura → emitir. La
  //    identidad se registra ANTES de emitir (para que una nueva evaluación no
  //    vuelva a producir el mismo evento); un fallo al emitir se controla y se
  //    loguea, nunca tumba la pasada ni pierde el registro. `emitir=false` =
  //    baseline (sembrar sin avisar). Un cerrojo evita pasadas solapadas
  //    (varios pings seguidos); si llega otra mientras corre, se encola una. ──
  procesar: async function (emitir) {
    if (this.ocupado) { this.pendiente = true; return; }
    this.ocupado = true;
    const ep = this.epoca;
    try {
      const cand = await this.recolectar();
      // Si la sesión cambió durante los fetch (logout / cambio de usuario), se
      // DESCARTA la respuesta: ni se marca, ni se persiste, ni se emite. Así una
      // respuesta tardía del usuario A nunca contamina al usuario B.
      if (ep !== this.epoca) return;
      for (const c of cand) {
        if (this.visto(c.id)) continue;
        this.marcar(c.id);
        if (emitir) {
          try { this.emitir(c.tipo, c.payload); }
          catch (e) { if (typeof console !== 'undefined') console.warn('[Avis] fallo al emitir', c.tipo, e); }
        }
      }
      this.persistir();
    } catch (e) {
      if (typeof console !== 'undefined') console.warn('[Avis] fallo al revisar', e);
    } finally {
      this.ocupado = false;
      if (this.pendiente && ep === this.epoca) { this.pendiente = false; this.procesar(emitir); }
      else { this.pendiente = false; }
    }
  },

  // ── Arranque: carga el seen-set del usuario actual. Si NO había historial
  //    (instalación nueva, storage vacío, usuario nuevo), siembra SIN avisar
  //    (baseline). Si ya lo había, revisa y emite lo nuevo desde la última vez
  //    (cubre citas llegadas con la app cerrada). ──
  iniciar: async function () {
    this.usuario = (typeof Auth !== 'undefined') ? Auth.usuario : null;
    this.epoca++;                      // nueva sesión: invalida cualquier pasada anterior en vuelo
    this.cargar();
    const emitir = this.tieneBase;
    this.tieneBase = true;
    await this.procesar(emitir);
  },

  // ── Entrada desde el WebSocket: una pasada que SÍ emite, más el refresco de
  //    las pantallas vivas (eso último es cosa de cada pantalla, no del núcleo). ──
  alRecibirPing: function () {
    this.procesar(true).catch(function () {});
    if (typeof Citas !== 'undefined') Citas.refrescarPorEvento();
  },

  // ── Resincronización (FASE 6): ÚNICA vía ante reconexión de WebSocket, vuelta
  //    online o la app volviéndose visible. No es un segundo sistema: reutiliza
  //    el MISMO pipeline (recolectar → diff contra seen-set → emitir), así que
  //    recupera lo perdido mientras estuvo suspendida sin duplicar lo ya visto.
  //    No consulta si no hay usuario o si el dispositivo está offline (se esperará
  //    al evento 'online'). Agrupa señales cercanas con un pequeño debounce para
  //    no lanzar varios GET por un mismo retorno. ──
  sincronizar: function (motivo) {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;   // offline → esperar 'online'
    if (!this.usuario) return;                                                     // sin sesión → nada que sincronizar
    if (typeof getToken === 'function' && !getToken()) return;
    if (this.syncTimer) return;        // ya hay una sincronización agrupando señales
    const ep = this.epoca;
    this.syncTimer = setTimeout(() => {
      this.syncTimer = null;
      if (ep !== this.epoca) return;   // la sesión cambió durante el debounce
      this.procesar(true);             // emite solo lo nuevo (el seen-set deduplica)
    }, this.DEBOUNCE_SYNC_MS);
  },

  // ── Cierre de sesión: olvida el estado EN MEMORIA para que el próximo login
  //    cargue el suyo. Incrementa la época e invalida el debounce pendiente, de
  //    modo que ninguna respuesta/sincronización en vuelo del usuario anterior
  //    emita ni toque el seen-set del nuevo. NO borra el seen-set de localStorage
  //    (si el mismo usuario vuelve, no debe recibir de golpe lo antiguo). ──
  alCerrarSesion: function () {
    this.epoca++;
    if (this.syncTimer) { clearTimeout(this.syncTimer); this.syncTimer = null; }
    this.seen = {}; this.tieneBase = false; this.usuario = null; this.ocupado = false; this.pendiente = false;
  },
};
// </avis>

// ── UI de avisos in-app (FASE 4) ──────────────────────────────
// Presenta los EVENTOS de cita que emite Avis (`kp:aviso`). NO decide si algo es
// nuevo, NO consulta datos, NO toca el seen-set, NO vuelve a emitir: solo pinta.
//   Avis = ¿es nuevo?   ·   AvisosUI = ¿cómo lo muestro?
// Un único elemento #aviso reutilizado (nunca una pila); texto por textContent
// (sin innerHTML, sin PII). Defensa de rol EXTRA: el driver nunca ve avisos de
// cita, aunque llegara el evento por error. No usa Notification API ni Push.
// <avisos-ui>
const AvisosUI = {
  cola: [], timer: null, DURACION_MS: 6000,

  init: function () {
    if (typeof window === 'undefined') return;
    window.addEventListener('kp:aviso', (e) => {
      try { this.alAviso(e && e.detail); }
      catch (x) { if (typeof console !== 'undefined') console.warn('[AvisosUI] fallo al presentar', x); }
    });
  },

  // Tipos soportados. Defensa de rol SOLO para citas (el driver no las ve). El
  // evento de transporte "nuevo_trayecto" sí es para cualquier rol con acceso a
  // Transporte (incluido el driver): no se le aplica la restricción de citas.
  permitido: function (tipo) {
    if (tipo === 'nuevo_trayecto') return true;
    if (tipo !== 'cita_aprobada' && tipo !== 'cita_por_aprobar') return false;
    const rol = (typeof Auth !== 'undefined' && Auth.usuario && Auth.usuario.rol) || '';
    return rol !== 'driver';
  },

  alAviso: function (detalle) {
    if (!detalle || !this.permitido(detalle.tipo)) return;
    this.cola.push(detalle);          // coalescencia: un único elemento, no una pila
    this.pintar();
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.ocultar(), this.DURACION_MS);
  },

  textos: function () {
    const n = this.cola.length;
    if (n === 1) {
      const t = this.cola[0].tipo;
      if (t === 'cita_aprobada')    return { t: 'Nueva cita', s: 'Toca para verla' };
      if (t === 'cita_por_aprobar') return { t: 'Nueva cita por aprobar', s: 'Toca para revisarla' };
      return { t: 'Nuevo trayecto', s: 'Toca para verlo' };
    }
    const unico = this.cola.every((e) => e.tipo === this.cola[0].tipo) ? this.cola[0].tipo : null;
    if (unico === 'cita_por_aprobar') return { t: n + ' citas por aprobar', s: 'Toca para revisarlas' };
    if (unico === 'cita_aprobada')    return { t: n + ' citas nuevas', s: 'Toca para verlas' };
    if (unico === 'nuevo_trayecto')   return { t: n + ' trayectos nuevos', s: 'Toca para verlos' };
    return { t: n + ' avisos nuevos', s: 'Toca para verlos' };   // mezcla de tipos
  },

  pintar: function () {
    const el = $('aviso'); if (!el) return;
    const tx = this.textos();
    const t = el.querySelector('.aviso-t'), s = el.querySelector('.aviso-s');
    if (t) t.textContent = tx.t;        // textContent: sin innerHTML, sin datos del backend
    if (s) s.textContent = tx.s;
    el.classList.add('on');
  },

  alTocar: function () {
    const cola = this.cola.slice();
    this.ocultar();
    if (!cola.length) return;
    // Solo trayectos → Transporte (cualquier rol). Mínimo aceptable: abrir la
    // pantalla y dejar que cargue su estado; el payload.fecha queda reservado
    // para una mejora futura de navegación (§12).
    if (cola.every((e) => e.tipo === 'nuevo_trayecto')) { App.ir('transporte'); return; }
    // Citas (o mezcla): defensa de rol + navegación de citas existente.
    if (typeof Auth !== 'undefined' && Auth.usuario && Auth.usuario.rol === 'driver') return;
    App.ir('citas');
    if (cola.length === 1 && cola[0].tipo === 'cita_aprobada') {
      Citas.cambiar('agenda');          // las confirmadas viven en la Agenda
      const id = cola[0].payload && cola[0].payload.id;
      if (id && typeof Citas.ver === 'function') { try { Citas.ver(id); } catch (e) {} }
    } else {
      Citas.cambiar('aprobar');         // pendientes o varias → Por aprobar
    }
  },

  ocultar: function () {
    clearTimeout(this.timer); this.timer = null;
    this.cola = [];
    const el = $('aviso'); if (el) el.classList.remove('on');
  },
};
// </avisos-ui>

// ══════════════════════════════════════════════════════════════
// Autenticación (reutiliza el JWT existente)
// ══════════════════════════════════════════════════════════════
const Auth = {
  usuario: null,

  init: function () {
    const g = $('liBackend'); if (g) g.value = backendGuardado || '';
    // En la versión publicada, el campo "Servidor" sobra y solo confunde: se oculta.
    if (!APP_LOCAL) { const s = document.querySelector('.login-avanzado'); if (s) s.style.display = 'none'; }
    $('liVer').addEventListener('click', () => {
      const i = $('liPass'); i.type = i.type === 'password' ? 'text' : 'password';
    });
    $('loginForm').addEventListener('submit', e => { e.preventDefault(); this.entrar(); });
    if (getToken()) this.arrancar(); else this.mostrarLogin();
  },

  entrar: async function () {
    const email = $('liEmail').value.trim();
    const pass = $('liPass').value;
    const srv = $('liBackend').value.trim();
    if (srv) { BACKEND = srv.replace(/\/+$/, ''); try { localStorage.setItem('kp_backend', BACKEND); } catch (e) {} }
    $('liError').textContent = '';
    $('liEntrar').disabled = true; $('liEntrar').textContent = 'Entrando…';
    try {
      const r = await fetch(BACKEND + '/api/auth/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password: pass }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || 'No se pudo entrar');
      setToken(d.token);
      this.usuario = d.usuario || null;
      this.arrancar();
    } catch (e) {
      $('liError').textContent = e.message === 'Failed to fetch' ? 'No se pudo conectar con el servidor' : e.message;
    } finally {
      $('liEntrar').disabled = false; $('liEntrar').textContent = 'Entrar';
    }
  },

  arrancar: async function () {
    if (!this.usuario) {
      try { this.usuario = await api('/api/auth/me'); } catch (e) { return; }
    }
    $('pantallaLogin').style.display = 'none';
    $('app').classList.add('on');
    // Rol driver (Fase 1): solo ve Transporte, Clientes y Ajustes en la
    // navegación — Citas e Informes se ocultan. Las restricciones dentro de
    // Ajustes quedan para una fase aparte, todavía sin definir; aquí no se
    // toca nada de Ajustes.
    // La navegación se pinta según el rol ACTUAL, partiendo siempre de la nav
    // completa: así un login anterior de driver (sin recargar la página) no deja
    // botones ocultos para el owner que entra después.
    document.querySelectorAll('#nav button[data-sec]').forEach(b => { b.style.display = ''; });
    const esDriver = this.usuario && this.usuario.rol === 'driver';
    if (esDriver) {
      ['citas', 'informes'].forEach(sec => {
        const b = document.querySelector('#nav button[data-sec="' + sec + '"]');
        if (b) b.style.display = 'none';
      });
    }
    Vivo.huboReady = false;   // el primer 'ready' de esta sesión no debe resincronizar (baseline lo cubre)
    Vivo.conectar();
    App.ir(esDriver ? 'transporte' : 'citas');
    Avis.iniciar();   // carga el seen-set del usuario y siembra el baseline (el primer arranque no avisa)
    actualizarBadgeTransporte(Transporte.fecha);   // estado inicial del punto rojo de Transporte (ESTADO, no evento)
    Revision.iniciar();   // cola sin conexión de la revisión del vehículo + indicador de pendientes
  },

  mostrarLogin: function () {
    $('app').classList.remove('on');
    $('pantallaLogin').style.display = 'flex';
    $('liPass').value = '';
  },
};

// ══════════════════════════════════════════════════════════════
// Conexión en vivo (WebSocket) — el pulso de la app
// ══════════════════════════════════════════════════════════════
const Vivo = {
  ws: null, reintento: null, huboReady: false,

  conectar: function () {
    try {
      const url = BACKEND.replace(/^http/, 'ws') + '/ws';
      this.ws = new WebSocket(url);
      this.ws.onopen = () => this.ws.send(JSON.stringify({ type: 'auth', token: getToken() }));
      this.ws.onmessage = e => {
        let m = {}; try { m = JSON.parse(e.data); } catch (x) {}
        if (m.type === 'ready') {
          this.estado(true);
          // Un 'ready' posterior al primero es una RECONEXIÓN: pudieron perderse
          // eventos mientras estuvo caído → resincronizar (una sola vía, Avis).
          // El primer 'ready' de la sesión no sincroniza: el baseline de iniciar
          // ya dejó el estado al día.
          if (this.huboReady) Avis.sincronizar('ws-reconnect');
          if (this.huboReady) Revision.alVolver();   // reintenta la cola de la revisión del vehículo
          this.huboReady = true;
        }
        // appointment_update también cubre cambios de transporte: Avis detecta
        // los EVENTOS de cita y, por separado, se reconsulta el ESTADO del badge
        // de Transporte (ruta independiente, no pasa por Avis ni por el seen-set).
        if (m.type === 'appointment_update') { Avis.alRecibirPing(); actualizarBadgeTransporte(Transporte.fecha); Revision.refrescarIndicador(); }
        // La revisión del vehículo: un mensaje sin datos; cada cliente reconsulta su estado.
        if (m.type === 'vehicle_check_update') Revision.alRecibirPing();
      };
      this.ws.onclose = () => { this.estado(false); this.programarReintento(); };
      this.ws.onerror = () => { try { this.ws.close(); } catch (x) {} };
    } catch (e) { this.estado(false); }
  },

  programarReintento: function () {
    clearTimeout(this.reintento);
    this.reintento = setTimeout(() => { if (getToken()) this.conectar(); }, 5000);
  },

  estado: function (ok) {
    const v = $('vivo'), p = v.querySelector('.punto');
    v.classList.toggle('on', ok);
    p.classList.toggle('off', !ok);
    $('vivoTxt').textContent = ok ? 'En vivo' : 'Reconectando…';
  },
};

// ══════════════════════════════════════════════════════════════
// Navegación entre las 4 secciones
// ══════════════════════════════════════════════════════════════
const App = {
  actual: null,
  titulos: { citas: 'Citas', clientes: 'Clientes', transporte: 'Transporte', informes: 'Informes', ajustes: 'Ajustes', revision: 'Revisión' },

  ir: function (sec) {
    this.actual = sec;
    $('tituloPantalla').textContent = this.titulos[sec];
    document.querySelectorAll('.pantalla').forEach(p => p.classList.toggle('activa', p.id === 'p-' + sec));
    document.querySelectorAll('#nav button').forEach(b => b.classList.toggle('on', b.dataset.sec === sec));
    // La hamburguesa se marca cuando estamos en Ajustes (no es una pestaña del nav).
    $('btnAjustes').classList.toggle('on', sec === 'ajustes');
    ({ citas: Citas, clientes: Clientes, transporte: Transporte, informes: Informes, ajustes: Ajustes, revision: Revision })[sec].abrir();
  },
};

const skeletons = n => Array.from({ length: n }, () => '<div class="sk sk-tarjeta"></div>').join('');

// ══════════════════════════════════════════════════════════════
// 1 · CITAS  — por aprobar / agenda, aprobar-rechazar, en vivo
// ══════════════════════════════════════════════════════════════
const Citas = {
  vista: 'aprobar', citas: [], cargado: false,
  fechaAgenda: null, agendaCitas: [], agendaCargando: false, agendaError: null,

  abrir: function () {
    if (!this.fechaAgenda) this.fechaAgenda = hoyYmd();
    if (!this.cargado) this.cargar();
    else { this.pintar(); if (this.vista === 'agenda') this.cargarAgenda(); }
  },

  // Refresco de la PANTALLA de citas cuando llega un cambio. La detección de
  // EVENTOS de notificación ya no vive aquí: la hace Avis (fuente única) antes
  // de llamar a esto desde Avis.alRecibirPing.
  refrescarPorEvento: function () {
    if (App.actual === 'citas') { this.cargar(true); if (this.vista === 'agenda') this.cargarAgenda(); }
    else this.contarPendientes();
  },

  cargar: async function (silencioso) {
    this.cargado = true;
    if (!silencioso && this.vista === 'aprobar') $('p-citas').innerHTML = '<div class="seg-hueco"></div>' + skeletons(4);
    try {
      // Lo vivo (pendiente + confirmado) de hoy en adelante: de aquí salen los
      // pendientes y el número del badge. La agenda por día se pide aparte.
      this.citas = await api('/api/appointments?desde=' + hoyYmd() + '&estado=vivas');
    } catch (e) {
      $('p-citas').innerHTML = '<div class="vacio"><div class="vt">No se pudo cargar</div><div class="vs">' + esc(e.message) + '</div></div>';
      return;
    }
    this.pintar();
  },

  // La agenda se busca por día (como Transporte): confirmadas de esa fecha.
  cargarAgenda: async function () {
    this.agendaCargando = true; this.agendaError = null;
    if (App.actual === 'citas' && this.vista === 'agenda') this.pintar();
    try {
      this.agendaCitas = await api('/api/appointments?desde=' + this.fechaAgenda + '&hasta=' + this.fechaAgenda + '&estado=confirmed');
    } catch (e) { this.agendaError = e.message; this.agendaCitas = []; }
    this.agendaCargando = false;
    if (App.actual === 'citas' && this.vista === 'agenda') this.pintar();
  },

  pendientes: function () { return this.citas.filter(c => c.estado === 'pending'); },

  contarPendientes: function () {
    const n = this.pendientes().length;
    const b = $('badgeCitas'); b.textContent = n; b.classList.toggle('on', n > 0);
  },

  pintar: function () {
    const pend = this.pendientes();
    this.contarPendientes();
    let h = '<div class="seg">' +
      '<button class="' + (this.vista === 'aprobar' ? 'on' : '') + '" onclick="Citas.cambiar(\'aprobar\')">Por aprobar' +
        (pend.length ? '<span class="cuenta">' + pend.length + '</span>' : '') + '</button>' +
      '<button class="' + (this.vista === 'agenda' ? 'on' : '') + '" onclick="Citas.cambiar(\'agenda\')">Agenda</button>' +
      '</div>';
    h += this.vista === 'aprobar' ? this.pintarAprobar(pend) : this.pintarAgenda();
    $('p-citas').innerHTML = h;
  },

  cambiar: function (v) { this.vista = v; this.pintar(); if (v === 'agenda') this.cargarAgenda(); },

  pintarAprobar: function (pend) {
    if (!pend.length) return '<div class="vacio"><div class="vt">Nada por aprobar</div><div class="vs">Las solicitudes nuevas aparecen aquí en cuanto entran.</div></div>';
    return pend.map(c => this.tarjetaAprobar(c)).join('');
  },

  tarjetaAprobar: function (c) {
    const serv = (c.servicios && c.servicios.length ? c.servicios.join(' + ') : c.servicio) || 'Cita';
    return '<div class="tarjeta entrando" onclick="Citas.ver(\'' + c.id + '\')">' +
      '<div class="cita-cab"><span class="cli-nombre">' + esc(c.cliente || 'Sin nombre') + '</span>' +
        (c.transporte ? '<span class="chip suave">Transporte</span>' : '') + '</div>' +
      (c.mascota ? '<div class="cita-serv">' + esc(c.mascota) + '</div>' : '') +
      '<div class="cita-serv" style="margin-top:6px;color:var(--tinta)">' + esc(serv) + '</div>' +
      '<div class="cli-linea"><svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/></svg>' +
        esc(diaBonito(ymd(c.fecha))) + (c.hora ? ' · ' + esc(c.hora) : '') + '</div>' +
      '<div class="fila-botones">' +
        '<button class="btn-linea" data-rechazar="' + esc(c.id) + '">Rechazar</button>' +
        '<button class="btn-linea btn-solido" onclick="event.stopPropagation();Citas.aceptar(\'' + c.id + '\')">Aceptar</button>' +
      '</div></div>';
  },

  pintarAgenda: function () {
    const esHoy = this.fechaAgenda === hoyYmd();
    let h = '<div class="tr-fecha">' +
      '<button class="tr-nav" onclick="Citas.agDia(-1)" aria-label="Día anterior">‹</button>' +
      '<input type="date" id="agFecha" value="' + esc(this.fechaAgenda) + '" onchange="Citas.agFecha(this.value)">' +
      '<button class="tr-nav" onclick="Citas.agDia(1)" aria-label="Día siguiente">›</button>' +
      (esHoy ? '' : '<button class="tr-hoy" onclick="Citas.agHoy()">Hoy</button>') +
      '</div>';
    if (this.agendaCargando) return h + skeletons(3);
    if (this.agendaError) return h + '<div class="vacio"><div class="vt">No se pudo cargar</div><div class="vs">' + esc(this.agendaError) + '</div></div>';
    const ag = this.agendaCitas.slice().sort((a, b) => (a.hora || '').localeCompare(b.hora || ''));
    if (!ag.length) return h + '<div class="vacio"><div class="vt">Sin citas ese día</div><div class="vs">Cambia de día con las flechas o el calendario.</div></div>';
    h += '<div class="titulo-dia">' + esc(diaBonito(this.fechaAgenda)) + '</div>';
    h += ag.map(c => this.tarjetaAgenda(c)).join('');
    return h;
  },

  tarjetaAgenda: function (c) {
    const serv = (c.servicios && c.servicios.length ? c.servicios.join(' + ') : c.servicio) || 'Cita';
    return '<div class="tarjeta" onclick="Citas.ver(\'' + c.id + '\')"><div class="cita-cab">' +
      '<span class="cita-hora">' + esc(c.hora || 'Todo el día') + '</span>' +
      (c.transporte ? '<span class="chip suave">Transporte</span>' : '') + '</div>' +
      '<div class="cita-cliente">' + esc(c.cliente || 'Sin nombre') + (c.mascota ? ' · ' + esc(c.mascota) : '') + '</div>' +
      '<div class="cita-serv">' + esc(serv) + '</div></div>';
  },

  agDia:   function (delta) { this.fechaAgenda = sumarDias(this.fechaAgenda, delta); this.cargarAgenda(); },
  agFecha: function (v) { if (v) { this.fechaAgenda = v; this.cargarAgenda(); } },
  agHoy:   function () { this.fechaAgenda = hoyYmd(); this.cargarAgenda(); },

  // Detalle de una cita en una hoja (no pantalla completa).
  ver: function (id) {
    const c = this.citas.concat(this.agendaCitas).find(x => x.id === id);
    if (!c) return;
    const serv = (c.servicios && c.servicios.length ? c.servicios.join(' + ') : c.servicio) || 'Cita';
    const tel = (c.telefono || '').replace(/[^\d+]/g, '');
    const wa = tel.replace(/^\+?1?/, '');
    const est = { pending: 'Por aprobar', confirmed: 'Confirmada', completed: 'Completada', cancelled: 'Cancelada', no_show: 'No vino' }[c.estado] || c.estado;
    const fila = (l, v) => v ? '<div class="det-fila"><span>' + esc(l) + '</span><b>' + esc(v) + '</b></div>' : '';
    let h = '<h3>' + esc(c.cliente || 'Sin nombre') + '</h3>' +
      '<div class="det">' +
        fila('Estado', est) +
        fila('Mascota', c.mascota) +
        fila('Raza', c.raza) +
        fila('Servicio', serv) +
        fila('Día', diaBonito(ymd(c.fecha)) + (c.hora ? ' · ' + c.hora : '')) +
        (c.hasta ? fila('Se va', diaBonito(ymd(c.hasta))) : '') +
        (c.transporte ? fila('Transporte', 'Sí') : '') +
        fila('Teléfono', c.telefono) +
        fila('Referencia', c.codigoReserva) +
        fila('Notas', c.notas) +
      '</div>';
    if (c.telefono) h += '<div class="fila-botones">' +
      '<a class="btn-linea btn-tinta" href="tel:' + esc(tel) + '"><svg viewBox="0 0 24 24" stroke="currentColor" fill="none"><path d="M5 4h4l2 5-3 2a11 11 0 005 5l2-3 5 2v4a2 2 0 01-2 2A16 16 0 013 6a2 2 0 012-2z"/></svg>Llamar</a>' +
      '<a class="btn-linea btn-wa" href="https://wa.me/1' + esc(wa) + '" target="_blank" rel="noopener"><svg viewBox="0 0 24 24" stroke="currentColor" fill="none"><path d="M12 3a9 9 0 00-8 13l-1 5 5-1a9 9 0 103.9-17z"/></svg>WhatsApp</a>' +
      '</div>';
    if (c.estado === 'pending') h += '<div class="fila-botones">' +
      '<button class="btn-linea" data-rechazar="' + esc(c.id) + '">Rechazar</button>' +
      '<button class="btn-linea btn-solido" onclick="Hoja.cerrar();Citas.aceptar(\'' + c.id + '\')">Aceptar</button>' +
      '</div>';
    h += '<button class="btn-linea" style="width:100%;margin-top:9px" onclick="Hoja.cerrar()">Cerrar</button>';
    Hoja.abrir(h);
  },

  aceptar: async function (id) {
    try { await api('/api/appointments/' + id + '/estado', { method: 'POST', body: { estado: 'confirmed' } }); toast('Cita aceptada'); await this.cargar(true); if (this.vista === 'agenda') this.cargarAgenda(); }
    catch (e) { toast(e.message); }
  },

  // Solo recibe el id. El nombre se busca en las citas ya cargadas: viene del
  // formulario público de reservas, así que nunca viaja dentro de un onclick
  // (ahí el navegador deshace el escape antes de ejecutarlo y un nombre con
  // comillas se convertía en código).
  rechazar: function (id) {
    const c = this.citas.concat(this.agendaCitas).find(x => x.id === id);
    const nombre = c ? c.cliente : '';
    Hoja.abrir(
      '<h3>Rechazar la cita</h3>' +
      '<p>La de ' + esc(nombre || 'este cliente') + ' se cancelará. Es una acción que no se deshace.</p>' +
      '<textarea id="rzMotivo" rows="2" placeholder="Motivo (opcional)"></textarea>' +
      '<div class="fila-botones">' +
        '<button class="btn-linea" onclick="Hoja.cerrar()">No</button>' +
        '<button class="btn-linea" style="background:var(--rojo);border-color:transparent;color:#fff" data-confirmar-rechazo="' + esc(id) + '">Sí, rechazar</button>' +
      '</div>'
    );
  },

  confirmarRechazo: async function (id) {
    const motivo = ($('rzMotivo') || {}).value || '';
    Hoja.cerrar();
    try { await api('/api/appointments/' + id + '/estado', { method: 'POST', body: { estado: 'cancelled', motivo } }); toast('Cita rechazada'); await this.cargar(true); if (this.vista === 'agenda') this.cargarAgenda(); }
    catch (e) { toast(e.message); }
  },
};

// Los botones de rechazar llevan el id de la cita como dato (data-*), no como
// código. Se escucha en fase de captura para cortar el clic antes de que llegue
// a la tarjeta, que si no abriría también su detalle (lo que antes hacía el
// event.stopPropagation() del onclick).
document.addEventListener('click', function (e) {
  const b = e.target && e.target.closest && e.target.closest('[data-rechazar],[data-confirmar-rechazo]');
  if (!b) return;
  e.stopPropagation();
  if (b.hasAttribute('data-rechazar')) Citas.rechazar(b.getAttribute('data-rechazar'));
  else Citas.confirmarRechazo(b.getAttribute('data-confirmar-rechazo'));
}, true);

// ══════════════════════════════════════════════════════════════
// 2 · CLIENTES — solo directorio de contacto (buscar, llamar, WhatsApp)
// ══════════════════════════════════════════════════════════════
const Clientes = {
  lista: [], cargado: false, filtro: '',

  abrir: function () { if (!this.cargado) this.cargar(); else this.pintar(); },

  cargar: async function () {
    this.cargado = true;
    $('p-clientes').innerHTML = '<input class="buscar" disabled placeholder="Buscar…">' + skeletons(5);
    try { this.lista = await api('/api/clients'); }
    catch (e) { $('p-clientes').innerHTML = '<div class="vacio"><div class="vt">No se pudo cargar</div><div class="vs">' + esc(e.message) + '</div></div>'; return; }
    this.pintar();
  },

  pintar: function () {
    const h = '<input class="buscar" id="cliBuscar" placeholder="Buscar por nombre, teléfono o mascota" value="' + esc(this.filtro) + '" oninput="Clientes.buscar(this.value)">' +
      '<div id="cliLista">' + this.filas() + '</div>';
    $('p-clientes').innerHTML = h;
    const b = $('cliBuscar'); if (b && this.filtro) { b.focus(); b.setSelectionRange(b.value.length, b.value.length); }
  },

  buscar: function (v) { this.filtro = v; $('cliLista').innerHTML = this.filas(); },

  filas: function () {
    const q = this.filtro.trim().toLowerCase();
    const r = !q ? this.lista : this.lista.filter(c =>
      (c.name || '').toLowerCase().includes(q) ||
      (c.phone || '').toLowerCase().includes(q) ||
      (c.mascotas || '').toLowerCase().includes(q));
    if (!r.length) return '<div class="vacio"><div class="vt">Sin resultados</div><div class="vs">Nadie coincide con «' + esc(this.filtro) + '».</div></div>';
    return r.slice(0, 200).map(c => this.tarjeta(c)).join('');
  },

  tarjeta: function (c) {
    const tel = (c.phone || '').replace(/[^\d+]/g, '');
    const wa = tel.replace(/^\+?1?/, '');
    const nombre = esc(c.name || 'Sin nombre') + (c.mascotas ? ' · ' + esc(c.mascotas) : '');
    return '<div class="cli-card">' +
      '<div class="cli-info">' +
        '<div class="nom">' + nombre + '</div>' +
        '<div class="tel">' + (c.phone ? esc(c.phone) : 'Sin teléfono') + '</div>' +
      '</div>' +
      (c.phone ? '<div class="cli-acciones">' +
        '<a class="cli-icono llamar" href="tel:' + esc(tel) + '" aria-label="Llamar">' +
          '<svg viewBox="0 0 24 24" stroke="currentColor"><path d="M5 4h4l2 5-3 2a11 11 0 005 5l2-3 5 2v4a2 2 0 01-2 2A16 16 0 013 6a2 2 0 012-2z"/></svg></a>' +
        '<a class="cli-icono wa" href="https://wa.me/1' + esc(wa) + '" target="_blank" rel="noopener" aria-label="WhatsApp">' +
          '<svg viewBox="0 0 24 24" stroke="currentColor"><path d="M12 3a9 9 0 00-8 13l-1 5 5-1a9 9 0 103.9-17z"/><path d="M8.5 9c0 4 3 6.5 6.5 6.5" stroke-width="1.6"/></svg></a>' +
      '</div>' : '') +
    '</div>';
  },
};

// ══════════════════════════════════════════════════════════════
// 3 · TRANSPORTE — vista del dueño/despachador (rutas del día)
// ══════════════════════════════════════════════════════════════
// La etiqueta y el color del tipo de traslado. "casa" = domicilio del cliente.
function tipoTraslado(t) {
  const N = { local: 'Local', boarding: 'Hospedaje', vet: 'Vet', casa: 'Casa' };
  const p = String(t || 'casa_local').split('_');
  const clase = p[0] === 'casa' ? 'recogida' : (p[1] === 'casa' ? 'entrega' : 'suave');
  return { label: (N[p[0]] || p[0]) + ' → ' + (N[p[1]] || p[1]), clase: clase };
}

// Un traslado es interno si ninguno de sus dos extremos es la casa del
// cliente (mismo criterio que el backend: server.js, función tipoInterno()).
function esInterno(t) {
  return String(t || 'casa_local').indexOf('casa') === -1;
}

// La consigna de 4 etapas del backend (server.js, ESTADOS_TRASLADO).
const ESTADOS_TRASLADO_TXT = { pendiente: 'Pendiente', en_camino: 'En camino', recogida: 'Recogida', entregado: 'Entregado' };

// ── Badge de Transporte (FASE 3) ──────────────────────────────
// Punto rojo en el icono de Transporte de la nav inferior. Es un ESTADO, NO un
// evento: refleja si en el día que mira Transporte quedan trayectos sin culminar.
// Por eso NO usa Avis, NO toca el seen-set, NO emite `kp:aviso` y NO desaparece
// por abrir la pantalla: solo se apaga cuando el estado real ya no lo requiere.
// Terminales: `entregado` y `cancelled` (el backend ya excluye los cancelados de
// /api/transport, así que ni llegan). Se usa el `resumen` del backend si viene;
// si no, se cuentan las paradas.
// <badge-transporte>
let badgeTransportePrevio = false;   // último estado conocido (no apagar por un fallo de red)

function hayTransportePendiente(datos) {
  if (!datos) return false;
  const r = datos.resumen;
  if (r && typeof r.total === 'number') return (r.total - (r.entregado || 0)) > 0;
  return (datos.paradas || []).some(p => p.estado !== 'entregado' && p.estado !== 'cancelled');
}

function pintarBadgeTransporte(hay) {
  badgeTransportePrevio = hay;
  const b = $('badgeTransporte');
  if (b) b.classList.toggle('on', hay);
}

// Reconsulta el estado y actualiza el badge. Ante fallo de red CONSERVA el último
// estado conocido (no apaga un ON real); registra el error y no rompe nada.
async function actualizarBadgeTransporte(fecha) {
  try {
    const d = await api('/api/transport?date=' + (fecha || hoyYmd()));
    pintarBadgeTransporte(hayTransportePendiente(d));
  } catch (e) {
    if (typeof console !== 'undefined') console.warn('[Transporte] no se pudo actualizar el badge', e);
  }
}
// </badge-transporte>

const Transporte = {
  datos: null, fecha: null, mapa: null, marcadores: [], scriptPuesto: false,

  abrir: function () { if (!this.fecha) this.fecha = hoyYmd(); this.cargar(); },

  dia:     function (delta) { this.fecha = sumarDias(this.fecha, delta); this.cargar(); },
  irFecha: function (v) { if (v) { this.fecha = v; this.cargar(); } },
  hoy:     function () { this.fecha = hoyYmd(); this.cargar(); },

  cargar: async function () {
    $('p-transporte').innerHTML = skeletons(4);
    try { this.datos = await api('/api/transport?date=' + this.fecha); }
    catch (e) { $('p-transporte').innerHTML = '<div class="vacio"><div class="vt">No se pudo cargar</div><div class="vs">' + esc(e.message) + '</div></div>'; return; }
    this.pintar();
    // El estado del badge sale del dato que ya trajimos (no se vuelve a pedir).
    // Abrir la pantalla NO cambia el estado: si sigue habiendo pendientes, sigue ON.
    pintarBadgeTransporte(hayTransportePendiente(this.datos));
    this.actualizarMapa();
  },

  pintar: function () {
    const d = this.datos, paradas = d.paradas || [];
    const esHoy = this.fecha === hoyYmd();
    let h = '';

    // Selector de día: la ruta no es solo la de hoy.
    h += '<div class="tr-fecha">' +
      '<button class="tr-nav" onclick="Transporte.dia(-1)" aria-label="Día anterior">‹</button>' +
      '<input type="date" id="trFecha" value="' + esc(this.fecha) + '" onchange="Transporte.irFecha(this.value)">' +
      '<button class="tr-nav" onclick="Transporte.dia(1)" aria-label="Día siguiente">›</button>' +
      (esHoy ? '' : '<button class="tr-hoy" onclick="Transporte.hoy()">Hoy</button>') +
      '</div>';

    // Revisión diaria del vehículo (todos los roles; el contenido depende del rol)
    h += Revision.tarjetaHtml();

    // Mapa
    h += '<div class="mapa-caja"><div class="mapa-barra">' +
      '<span class="info" id="trInfo">' + (paradas.length ? paradas.length + (paradas.length === 1 ? ' parada' : ' paradas') : 'Sin paradas') + '</span>' +
      '<button class="btn-linea" style="flex:0 0 auto;padding:8px 12px" onclick="Transporte.abrirEnMaps()">Ver en Maps</button>' +
      '</div><div class="mapa-zona"><div class="mapa-real" id="trMapa" style="display:none"></div>' +
      '<div class="mapa-vacio" id="trMapaVacio"><div class="t">Mapa no conectado</div><div class="s">Se activa con la clave de Google Maps del negocio.</div></div>' +
      '</div></div>';

    // Atajos a puntos fijos del negocio: cada botón solo si está configurado.
    const atajos = [['local', 'Local'], ['boarding', 'Hospedaje'], ['vet', 'Veterinario']].filter(a => d[a[0]]);
    if (atajos.length) {
      h += '<div class="tr-atajos">' + atajos.map(a =>
        '<button class="btn-linea" onclick="Transporte.irAtajo(\'' + a[0] + '\')">' +
        '<svg viewBox="0 0 24 24"><path d="M12 21s7-6 7-11a7 7 0 10-14 0c0 5 7 11 7 11z"/><circle cx="12" cy="10" r="2.4"/></svg>' +
        esc(a[1]) + '</button>').join('') + '</div>';
    }

    // Ruta del día
    h += '<div class="gtitulo">' + (esHoy ? 'Ruta de hoy' : 'Ruta · ' + esc(diaBonito(this.fecha))) + '</div>';
    if (!paradas.length) {
      h += '<div class="vacio"><div class="vt">Sin traslados este día</div><div class="vs">Usa las flechas para ver otros días. Cuando una cita pida transporte, aparece aquí.</div></div>';
    } else {
      h += paradas.map((p, i) => this.tarjetaParada(p, i)).join('');
    }
    $('p-transporte').innerHTML = h;
    Revision.refrescarIndicador();   // repinta la tarjeta con el estado real del día
  },

  // La única acción contextual que corresponde al estado actual de la parada
  // (misma consigna que el backend: pendiente→Ir, en_camino→Recogida,
  // recogida→Entregado, entregado→ninguna).
  accionDe: function (p) {
    return p.estado === 'pendiente'  ? { txt: 'Ir',        fn: "Transporte.ir('" + p.id + "')" }
      : p.estado === 'en_camino' ? { txt: 'Recogida',  fn: "Transporte.marcarRecogida('" + p.id + "')" }
      : p.estado === 'recogida'  ? { txt: 'Entregado', fn: "Transporte.marcarEntregado('" + p.id + "')" }
      : null;   // entregado: sin acción
  },

  // Toda la tarjeta abre el detalle en la Hoja al tocarla (mismo patrón que
  // Citas.tarjetaAgenda → Citas.ver); solo la acción corta la propagación
  // para no disparar ese detalle al usarla. El teléfono aquí es solo
  // informativo — no llama; para llamar está el botón dentro de la Hoja.
  tarjetaParada: function (p, i) {
    const t = tipoTraslado(p.tipo || p.dir);
    const estadoKey = ESTADOS_TRASLADO_TXT[p.estado] ? p.estado : 'pendiente';
    const estadoTxt = ESTADOS_TRASLADO_TXT[estadoKey];
    const accion = this.accionDe(p);
    return '<div class="tarjeta" onclick="Transporte.ver(\'' + p.id + '\')"><div class="cita-cab">' +
      '<span class="cli-nombre">' + (i + 1) + '. ' + esc(p.cliente) + (p.mascota ? ' · ' + esc(p.mascota) : '') + (p.raza ? ' · ' + esc(p.raza) : '') + '</span>' +
      '<span class="chip ' + t.clase + '">' + esc(t.label) + '</span></div>' +
      (p.telefono ? '<div class="cli-linea"><svg viewBox="0 0 24 24" stroke="currentColor" fill="none"><path d="M5 4h4l2 5-3 2a11 11 0 005 5l2-3 5 2v4a2 2 0 01-2 2A16 16 0 013 6a2 2 0 012-2z"/></svg>' + esc(p.telefono) + '</div>' : '') +
      (p.hora ? '<div class="cli-linea"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>' + esc(p.hora) + (p.ventana ? ' · ' + esc(p.ventana) : '') + '</div>' : (p.ventana ? '<div class="cli-linea"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>' + esc(p.ventana) + '</div>' : '')) +
      (p.direccion ? '<div class="cli-linea"><svg viewBox="0 0 24 24"><path d="M12 21s7-6 7-11a7 7 0 10-14 0c0 5 7 11 7 11z"/><circle cx="12" cy="10" r="2.4"/></svg>' + esc(p.direccion) + '</div>' : '') +
      '<div class="tr-pie">' +
        '<span class="chip est-' + estadoKey + '">' + estadoTxt + '</span>' +
        (accion ? '<button class="btn-linea btn-solido tr-accion" onclick="event.stopPropagation();' + accion.fn + '">' + accion.txt + '</button>' : '') +
      '</div></div>';
  },

  // Detalle completo de una parada en la Hoja. La acción contextual ya está
  // en la tarjeta, así que aquí no se repite el mismo botón — pero el
  // teléfono, aquí sí, es un botón real para llamar.
  ver: function (id) {
    const p = (this.datos && this.datos.paradas || []).find(x => x.id === id);
    if (!p) return;
    const t = tipoTraslado(p.tipo || p.dir);
    const estadoKey = ESTADOS_TRASLADO_TXT[p.estado] ? p.estado : 'pendiente';
    const horaTxt = p.hora ? (p.hora + (p.ventana ? ' · ' + p.ventana : '')) : (p.ventana || '');
    const tel = (p.telefono || '').replace(/[^\d+]/g, '');
    const fila = (l, v) => v ? '<div class="det-fila"><span>' + esc(l) + '</span><b>' + esc(v) + '</b></div>' : '';
    let h = '<h3>' + esc(p.cliente || 'Sin nombre') + '</h3>' +
      '<div class="det">' +
        fila('Mascota', p.mascota) +
        fila('Raza', p.raza) +
        fila('Teléfono', p.telefono) +
        fila('Tipo de traslado', t.label) +
        fila('Servicio', p.servicio) +
        fila('Hora', horaTxt) +
        fila('Dirección', p.direccion) +
        fila('Estado', ESTADOS_TRASLADO_TXT[estadoKey]) +
      '</div>';
    if (p.telefono) h += '<div class="fila-botones">' +
      '<a class="btn-linea btn-tinta" href="tel:' + esc(tel) + '"><svg viewBox="0 0 24 24" stroke="currentColor" fill="none"><path d="M5 4h4l2 5-3 2a11 11 0 005 5l2-3 5 2v4a2 2 0 01-2 2A16 16 0 013 6a2 2 0 012-2z"/></svg>Llamar</a>' +
      '</div>';
    h += '<button class="btn-linea" style="width:100%;margin-top:9px" onclick="Hoja.cerrar()">Cerrar</button>';
    Hoja.abrir(h);
  },

  // pendiente → en_camino: cambia el estado y abre Maps hacia el domicilio
  // del cliente de esta parada (nunca hacia Local/Boarding/Veterinario).
  ir: async function (id) {
    const p = (this.datos && this.datos.paradas || []).find(x => x.id === id);
    try { await api('/api/transport/' + id, { method: 'PATCH', body: { estado: 'en_camino' } }); }
    catch (e) { toast(e.message); return; }
    if (p && p.direccion) {
      const params = new URLSearchParams({ api: '1', destination: p.direccion, travelmode: 'driving' });
      window.open('https://www.google.com/maps/dir/?' + params.toString(), '_blank', 'noopener');
    }
    Hoja.cerrar();
    await this.cargar();
  },

  // en_camino → recogida: el conductor ya tiene a la mascota. No abre Maps.
  marcarRecogida: async function (id) {
    try { await api('/api/transport/' + id, { method: 'PATCH', body: { estado: 'recogida' } }); }
    catch (e) { toast(e.message); return; }
    Hoja.cerrar();
    await this.cargar();
  },

  // recogida → entregado: estado final. No abre Maps.
  marcarEntregado: async function (id) {
    try { await api('/api/transport/' + id, { method: 'PATCH', body: { estado: 'entregado' } }); }
    catch (e) { toast(e.message); return; }
    Hoja.cerrar();
    await this.cargar();
  },

  abrirEnMaps: function () {
    const d = this.datos, puntos = (d.paradas || []).map(p => p.direccion).filter(Boolean);
    if (!puntos.length) { toast('No hay direcciones para el mapa'); return; }
    const local = d.local;
    const origin = local || puntos[0];
    const destination = local || puntos[puntos.length - 1];
    const wp = local ? puntos : puntos.slice(1);
    const params = new URLSearchParams({ api: '1', origin, destination, travelmode: 'driving' });
    if (wp.length) params.set('waypoints', wp.join('|'));
    window.open('https://www.google.com/maps/dir/?' + params.toString(), '_blank', 'noopener');
  },

  // Atajo "llévame ahí": navegación directa de Google Maps a un punto fijo del
  // negocio (local, boarding o veterinario), sin escribir la dirección. Igual que la web.
  irAtajo: function (cual) {
    const destino = this.datos && this.datos[cual];
    if (!destino) { toast('Ese punto no está configurado'); return; }
    const params = new URLSearchParams({ api: '1', destination: destino, travelmode: 'driving' });
    window.open('https://www.google.com/maps/dir/?' + params.toString(), '_blank', 'noopener');
  },

  actualizarMapa: function () {
    const key = this.datos && this.datos.mapsKey;
    if (!key) return;
    if (window.google && window.google.maps) { this.pintarMapa(); return; }
    if (this.scriptPuesto) return;
    this.scriptPuesto = true;
    window.kpMapaInit = () => Transporte.pintarMapa();
    const s = document.createElement('script');
    s.src = 'https://maps.googleapis.com/maps/api/js?key=' + encodeURIComponent(key) + '&loading=async&callback=kpMapaInit';
    s.async = true;
    s.onerror = () => { this.scriptPuesto = false; };
    document.head.appendChild(s);
  },

  pintarMapa: function () {
    if (!(window.google && window.google.maps)) return;
    const zona = $('trMapa'), vacio = $('trMapaVacio');
    if (!zona) return;
    vacio.style.display = 'none'; zona.style.display = 'block';
    // pintar() reconstruye #p-transporte (y con él, #trMapa) en cada cargar().
    // Si this.mapa sigue enganchado al contenedor viejo (ya fuera del DOM),
    // hay que crear uno nuevo sobre el contenedor actual.
    if (!this.mapa || this.mapa.getDiv() !== zona) this.mapa = new google.maps.Map(zona, { center: { lat: 25.782, lng: -80.193 }, zoom: 11, mapTypeControl: false, streetViewControl: false, fullscreenControl: false });
    this.marcadores.forEach(m => m.setMap(null)); this.marcadores = [];
    const geo = new google.maps.Geocoder(), lim = new google.maps.LatLngBounds();
    (this.datos.paradas || []).forEach((p, i) => {
      // Solo domicilios de clientes activos: fuera las internas (entre Local/
      // Boarding/Veterinario, sin casa) y las ya entregadas.
      if (esInterno(p.tipo) || p.estado === 'entregado') return;
      if (!p.direccion) return;
      geo.geocode({ address: p.direccion }, (r, st) => {
        if (st !== 'OK' || !r[0]) return;
        this.marcadores.push(new google.maps.Marker({ position: r[0].geometry.location, map: this.mapa }));
        lim.extend(r[0].geometry.location); this.mapa.fitBounds(lim);
      });
    });
  },
};

// ══════════════════════════════════════════════════════════════
// 4 · INFORMES — solo lectura, con animación al cargar
// ══════════════════════════════════════════════════════════════
const Informes = {
  periodo: 'hoy', datos: null, cargado: false,

  abrir: function () { if (!this.cargado) this.cargar(); else this.pintar(); },

  rango: function () {
    const hoy = hoyYmd();
    if (this.periodo === 'semana') { const d = new Date(hoy + 'T12:00:00'); const dia = d.getDay(); return { from: sumarDias(hoy, dia === 0 ? -6 : 1 - dia), to: sumarDias(hoy, 1) }; }
    if (this.periodo === 'mes') return { from: hoy.slice(0, 8) + '01', to: sumarDias(hoy, 1) };
    return { from: hoy, to: sumarDias(hoy, 1) };
  },

  cargar: async function () {
    this.cargado = true;
    $('p-informes').innerHTML = '<div class="seg-hueco"></div><div class="kpis">' + skeletons(4).replace(/sk-tarjeta/g, 'sk-tarjeta" style="height:78px') + '</div>';
    const r = this.rango();
    try { this.datos = await api('/api/reports?from=' + r.from + '&to=' + r.to); }
    catch (e) { $('p-informes').innerHTML = '<div class="vacio"><div class="vt">No se pudo cargar</div><div class="vs">' + esc(e.message) + '</div></div>'; return; }
    this.pintar();
  },

  cambiar: function (p) { this.periodo = p; this.cargar(); },

  pintar: function () {
    const d = this.datos;
    let h = '<div class="seg">' +
      ['hoy', 'semana', 'mes'].map(p => '<button class="' + (this.periodo === p ? 'on' : '') + '" onclick="Informes.cambiar(\'' + p + '\')">' + ({ hoy: 'Hoy', semana: 'Semana', mes: 'Mes' }[p]) + '</button>').join('') +
      '</div>';

    h += '<div class="kpis">' +
      this.kpi('Cobrado', d.ingresos, true, 'destacado') +
      this.kpi('Pendiente', d.pendiente, true) +
      this.kpi('Clientes', d.clientes, false) +
      this.kpi('Ticket promedio', d.ticketPromedio, true) +
      '</div>';

    h += '<div class="gtitulo">Ingresos por día</div>' + this.grafico(d.porDia || []);

    const serv = this.topServicios(d.detalle || []);
    if (serv.length) {
      h += '<div class="gtitulo">Servicios que más facturan</div><div class="lista-serv">' +
        serv.map(s => {
          const pct = Math.round(s.total / serv[0].total * 100);
          return '<div class="serv-fila"><div class="serv-cab"><span>' + esc(s.nombre) + '</span><b>' + fmtDinero(s.total) + '</b></div>' +
            '<div class="serv-riel"><span data-w="' + pct + '"></span></div></div>';
        }).join('') + '</div>';
    }

    $('p-informes').innerHTML = h;
    this.animar();
  },

  kpi: function (lab, val, dinero, clase) {
    return '<div class="kpi ' + (clase || '') + '"><div class="lab">' + esc(lab) + '</div>' +
      '<div class="num" data-num="' + Number(val || 0) + '" data-dinero="' + (dinero ? 1 : 0) + '">' + (dinero ? fmtDinero(0) : '0') + '</div></div>';
  },

  grafico: function (porDia) {
    if (!porDia.length) return '<div class="vacio" style="padding:26px"><div class="vs">Sin ingresos en este periodo.</div></div>';
    const hoy = hoyYmd();
    const max = Math.max.apply(null, porDia.map(x => Number(x.total))) || 1;
    const dias = porDia.slice(-14);
    return '<div class="barras">' + dias.map(x => {
      const pct = Math.round(Number(x.total) / max * 100);
      const et = new Date(ymd(x.dia) + 'T12:00:00').toLocaleDateString('es-ES', { day: 'numeric', month: 'numeric' });
      return '<div class="barra-col' + (ymd(x.dia) === hoy ? ' hoy' : '') + '"><div class="barra-riel"><div class="barra-fill" data-h="' + pct + '"></div></div><div class="barra-lab">' + esc(et) + '</div></div>';
    }).join('') + '</div>';
  },

  topServicios: function (detalle) {
    const m = {};
    detalle.forEach(d => { const s = d.servicio || 'Otro'; m[s] = (m[s] || 0) + Number(d.monto || 0); });
    return Object.keys(m).map(k => ({ nombre: k, total: m[k] })).sort((a, b) => b.total - a.total).slice(0, 5);
  },

  animar: function () {
    // Números que cuentan y barras que crecen: la sensación de "vivo".
    document.querySelectorAll('#p-informes .num').forEach(el => {
      const fin = Number(el.dataset.num), dinero = el.dataset.dinero === '1', ini = performance.now(), dur = 650;
      const paso = t => {
        const k = Math.min(1, (t - ini) / dur), e = 1 - Math.pow(1 - k, 3), v = fin * e;
        el.textContent = dinero ? fmtDinero(v) : Math.round(v).toString();
        if (k < 1) requestAnimationFrame(paso);
      };
      requestAnimationFrame(paso);
    });
    requestAnimationFrame(() => {
      document.querySelectorAll('#p-informes .barra-fill').forEach(el => { el.style.height = el.dataset.h + '%'; });
      document.querySelectorAll('#p-informes .serv-riel span').forEach(el => { el.style.width = el.dataset.w + '%'; });
    });
  },
};

// ══════════════════════════════════════════════════════════════
// AJUSTES — cuenta, servidor y cerrar sesión (se abre con la hamburguesa)
// ══════════════════════════════════════════════════════════════
const Ajustes = {
  abrir: function () {
    const u = Auth.usuario || {};
    const nombre = u.nombre || u.name || '—';
    const inicial = (nombre.trim().charAt(0) || '?').toUpperCase();
    // Fase 2 del rol driver: el aviso de "citas por aprobar" no sirve de nada
    // para un driver (el dato que necesita, /api/appointments, sigue
    // bloqueado desde Fase 1) — se oculta el interruptor para no ofrecer algo
    // que nunca podrá avisarle. El resto de Ajustes no cambia para nadie.
    const esDriver = u.rol === 'driver';
    $('p-ajustes').innerHTML =
      '<div class="aj-grupo">Cuenta</div>' +
      '<div class="cli-card aj-cuenta">' +
        '<div class="aj-avatar">' + esc(inicial) + '</div>' +
        '<div style="min-width:0">' +
          '<div class="aj-nombre">' + esc(nombre) + '</div>' +
          (u.email ? '<div class="aj-sub">' + esc(u.email) + '</div>' : '') +
          (u.negocio ? '<div class="aj-sub">' + esc(u.negocio) + '</div>' : '') +
        '</div>' +
      '</div>' +

      (APP_LOCAL ?
        '<div class="aj-grupo">Conexión</div>' +
        '<div class="tarjeta">' +
          '<label class="aj-lab" for="ajServidor">Servidor (backend)</label>' +
          '<input class="aj-input" id="ajServidor" type="url" autocomplete="off" value="' + esc(BACKEND) + '">' +
          '<div class="aj-hint">La dirección de tu backend. Cámbiala si tu PC tomó otra IP en la red.</div>' +
          '<button class="btn-linea btn-solido aj-btn" onclick="Ajustes.guardarServidor()">Guardar y reconectar</button>' +
        '</div>'
        : '') +

      '<div class="aj-grupo">Notificaciones</div>' +
      '<div class="tarjeta">' +
        (esDriver ? '' :
          '<label class="aj-toggle"><span>Citas por aprobar</span>' +
            '<span class="sw"><input type="checkbox" ' + (Avis.activa('citas') ? 'checked' : '') + ' onchange="Ajustes.toggleNotif(\'citas\', this.checked)"><i></i></span></label>' +
          '<div class="aj-sep"></div>') +
        '<label class="aj-toggle"><span>Traslados</span>' +
          '<span class="sw"><input type="checkbox" ' + (Avis.activa('traslados') ? 'checked' : '') + ' onchange="Ajustes.toggleNotif(\'traslados\', this.checked)"><i></i></span></label>' +
        (Avis.permiso() === 'denied'
          ? '<div class="aj-hint" style="color:var(--rojo)">Las notificaciones están bloqueadas. Actívalas en los ajustes del navegador.</div>'
          : '<div class="aj-hint">Te avisa cuando entra una cita por aprobar o un traslado, con la app abierta.</div>') +
      '</div>' +

      '<div class="aj-grupo">Revisión del vehículo</div>' +
      '<div class="tarjeta">' +
        '<button class="btn-linea aj-btn" style="width:100%;margin-top:0" onclick="App.ir(\'revision\')">' + (esDriver ? 'Hacer la revisión del día' : 'Ver las revisiones') + '</button>' +
        (u.rol === 'owner' ?
          '<div class="aj-sep"></div>' +
          '<label class="aj-toggle"><span>Fotos en la revisión</span><span class="sw"><input type="checkbox" id="ajRevFotos" onchange="Revision.guardarAjusteFotos(this.checked)"><i></i></span></label>' +
          '<div class="aj-hint">Desactivado por defecto. Cuando se activa, el conductor puede añadir hasta 4 fotos a la revisión.</div>' : '') +
      '</div>' +

      '<div class="aj-grupo">Aplicación</div>' +
      '<button class="btn-linea btn-solido aj-btn" style="margin-top:0" onclick="Ajustes.actualizar()">Actualizar la app</button>' +
      '<div class="aj-hint" style="text-align:center">Trae la última versión desde el servidor. También se actualiza sola cada vez que abres la app.</div>' +

      '<div class="aj-grupo">Sesión</div>' +
      '<button class="aj-salir" onclick="Ajustes.cerrarSesion()">Cerrar sesión</button>' +

      '<div class="aj-pie">Kisses and Paws · Huashu — v0.1</div>';
    if (u.rol === 'owner') Revision.cargarAjusteFotos();
  },

  toggleNotif: async function (tipo, on) {
    const ok = await Avis.alternar(tipo, on);
    this.abrir();   // re-dibuja para reflejar el estado real (por si se negó el permiso)
    if (ok && on) toast('Notificaciones activadas');
  },

  actualizar: function () {
    toast('Actualizando…');
    setTimeout(function () { location.reload(); }, 250);
  },

  guardarServidor: function () {
    const v = ($('ajServidor').value || '').trim().replace(/\/+$/, '');
    if (!v) { toast('Escribe la dirección del servidor'); return; }
    BACKEND = v;
    try { localStorage.setItem('kp_backend', v); } catch (e) {}
    try { if (Vivo.ws) Vivo.ws.close(); } catch (e) {}
    Vivo.conectar();
    // Que las pantallas vuelvan a pedir datos al nuevo servidor.
    Citas.cargado = Clientes.cargado = Transporte.cargado = Informes.cargado = false;
    toast('Servidor guardado');
  },

  cerrarSesion: function () {
    Hoja.abrir(
      '<h3>Cerrar sesión</h3>' +
      '<p>Tendrás que entrar de nuevo con tu correo y contraseña.</p>' +
      '<div class="fila-botones">' +
        '<button class="btn-linea" onclick="Hoja.cerrar()">No</button>' +
        '<button class="btn-linea" style="background:var(--rojo);border-color:transparent;color:#fff" onclick="Ajustes.confirmarSalir()">Cerrar sesión</button>' +
      '</div>'
    );
  },

  confirmarSalir: function () {
    Hoja.cerrar();
    api('/api/auth/logout', { method: 'POST' }).catch(() => {});
    setToken('');
    try { if (Vivo.ws) Vivo.ws.close(); } catch (e) {}
    Auth.usuario = null;
    // Dejar la app en limpio para el próximo login: restaurar la navegación
    // completa (por si este era un driver) y olvidar los contadores del rol.
    document.querySelectorAll('#nav button[data-sec]').forEach(b => { b.style.display = ''; });
    Avis.alCerrarSesion();
    Revision.alCerrarSesion();
    Citas.cargado = Clientes.cargado = Transporte.cargado = Informes.cargado = false;
    App.ir('citas');   // deja lista la primera pestaña para el próximo login
    Auth.mostrarLogin();
  },
};

// ══════════════════════════════════════════════════════════════
// REVISIÓN DIARIA DEL VEHÍCULO
// El conductor registra una revisión al cerrar la jornada de transporte. Funciona
// con y sin conexión: el envío pasa por una cola persistente (IndexedDB) con un
// identificador estable por revisión (client_uuid), así un reintento NUNCA crea una
// segunda revisión. Estados visibles: borrador → pendiente de envío → enviando →
// confirmada (o conflicto / rechazada). Nunca bloquea las rutas.
// Dos bloques:  <revision-logica> (sin DOM ni red propia, probado con node --test)
//               <revision-ui>     (pantallas, croquis, historial, indicador).
// ══════════════════════════════════════════════════════════════

// <revision-logica>
const REV_LIMPIEZA  = [['limpio', 'Limpio'], ['aceptable', 'Aceptable'], ['necesita_limpieza', 'Necesita limpieza']];
const REV_ESTADO    = [['ok', 'OK'], ['revisar', 'Revisar'], ['defectuoso', 'Defectuoso']];
const REV_ESTADO_NA = REV_ESTADO.concat([['na', 'N/A']]);
const REV_SI_NO     = [['si', 'Sí'], ['no', 'No'], ['na', 'N/A']];
const REV_GRUPOS = [
  { t: 'Combustible y limpieza', c: [
    { k: 'combustible', t: 'Combustible', op: [['vacio', 'Vacío'], ['1/4', '¼'], ['1/2', '½'], ['3/4', '¾'], ['lleno', 'Lleno']] },
    { k: 'limpieza_interior', t: 'Limpieza interior', op: REV_LIMPIEZA },
    { k: 'limpieza_exterior', t: 'Limpieza exterior', op: REV_LIMPIEZA },
  ] },
  { t: 'Estado del vehículo', c: [
    { k: 'neumaticos', t: 'Neumáticos', op: REV_ESTADO },
    { k: 'luces', t: 'Luces', op: REV_ESTADO },
    { k: 'frenos', t: 'Frenos', op: REV_ESTADO },
    { k: 'limpiaparabrisas', t: 'Limpiaparabrisas', op: REV_ESTADO_NA },
    { k: 'aire_acondicionado', t: 'Aire acondicionado', op: REV_ESTADO_NA },
    { k: 'ventilacion_carga', t: 'Ventilación del área de carga', op: REV_ESTADO_NA },
  ] },
  { t: 'Equipamiento', c: [
    { k: 'jaulas_sujeciones', t: 'Jaulas y sujeciones', op: REV_SI_NO },
    { k: 'botiquin', t: 'Botiquín', op: REV_SI_NO },
    { k: 'agua', t: 'Agua para las mascotas', op: REV_SI_NO },
    { k: 'documentos', t: 'Documentos del vehículo', op: REV_SI_NO },
  ] },
];
const REV_VISTAS = [['frontal', 'Frontal'], ['trasera', 'Trasera'], ['lateral_izq', 'Lateral izq.'], ['lateral_der', 'Lateral der.'], ['techo', 'Techo']];
const REV_TIPOS  = [['rayon', 'Rayón'], ['abolladura', 'Abolladura'], ['golpe', 'Golpe'], ['cristal', 'Cristal'], ['otro', 'Otro']];
const REV_MAX_FOTOS = 4;
const REV_MAX_DANOS = 20;
const REV_ESTADOS_COLA = { borrador: 'Borrador', pendiente: 'Pendiente de envío', enviando: 'Enviando…', confirmada: 'Confirmada', conflicto: 'Conflicto', rechazada: 'No aceptada' };

function revFormVacio() {
  return { controles: {}, odometro: '', danos_nuevos: null, danos: [], ruta_incompleta: null, motivo_ruta: '', observaciones: '', confirmacion: false, fotos: [] };
}

// Etiqueta legible de un valor de un control (para el historial).
function revEtiqueta(clave, valor) {
  for (const g of REV_GRUPOS) for (const c of g.c) if (c.k === clave) { const o = c.op.find((x) => x[0] === valor); return o ? o[1] : String(valor); }
  return String(valor);
}

// Validación previa al envío (el servidor vuelve a validar todo). Devuelve '' si es válida.
function revValidarLocal(f) {
  if (!f) return 'Falta el formulario';
  for (const g of REV_GRUPOS) for (const c of g.c) {
    if (!f.controles || !c.op.some((o) => o[0] === f.controles[c.k])) return 'Falta responder: ' + c.t;
  }
  if (f.odometro !== '' && f.odometro !== null && f.odometro !== undefined) {
    const n = Number(f.odometro);
    if (!Number.isInteger(n) || n < 0 || n > 2000000) return 'El kilometraje no es válido';
  }
  if (typeof f.danos_nuevos !== 'boolean') return 'Indica si hay daños nuevos';
  if (f.danos_nuevos && !(f.danos && f.danos.length)) return 'Marca dónde está el daño en el croquis';
  if (f.danos && f.danos.length > REV_MAX_DANOS) return 'Demasiados daños marcados';
  if (typeof f.ruta_incompleta !== 'boolean') return 'Indica si la ruta quedó incompleta';
  if (f.ruta_incompleta && String(f.motivo_ruta || '').trim().length < 3) return 'Escribe el motivo de la ruta incompleta';
  if (f.fotos && f.fotos.length > REV_MAX_FOTOS) return 'Máximo ' + REV_MAX_FOTOS + ' fotos';
  if (f.confirmacion !== true) return 'Confirma que revisaste el vehículo';
  return '';
}

// Cuerpo exacto que espera POST/PUT /api/vehicle-checks (las fotos van aparte, una por petición).
function revCuerpo(f, extra) {
  return Object.assign({
    controles: f.controles,
    odometro: f.odometro === '' || f.odometro === null || f.odometro === undefined ? null : Number(f.odometro),
    danos_nuevos: f.danos_nuevos === true,
    danos: f.danos_nuevos === true ? f.danos : [],
    ruta_incompleta: f.ruta_incompleta === true,
    motivo_ruta: f.ruta_incompleta === true ? String(f.motivo_ruta || '').trim() : '',
    observaciones: String(f.observaciones || '').trim(),
    confirmacion: f.confirmacion === true,
  }, extra || {});
}

// Cola persistente. Todas las dependencias se inyectan (almacén, red, reloj), así se prueba sin navegador.
//   dep.almacen: { todos(dueno) -> items, guardar(item), borrar(id) }
//   dep.enviar(item) -> {code, body}   (lanza si no hay red)
//   dep.subirFoto(item, foto) -> {code, body}
//   dep.dueno() -> clave negocio:usuario;  dep.uuid();  dep.ahora() -> ISO;  dep.enLinea();  dep.alCambiar()
function crearColaRevision(dep) {
  let ocupado = false;
  const avisar = () => { try { if (dep.alCambiar) dep.alCambiar(); } catch (e) {} };
  const guardar = async (it) => { it.actualizado = dep.ahora(); await dep.almacen.guardar(it); avisar(); };
  const todos = async () => (await dep.almacen.todos(dep.dueno())).sort((a, b) => (a.creado < b.creado ? -1 : 1));

  // Las escrituras de borrador y de encolado van EN SERIE: el autoguardado (temporizador) no puede
  // cruzarse con el envío y dejar un segundo borrador o dos elementos para la misma jornada.
  let cadena = Promise.resolve();
  const enSerie = (fn) => { const p = cadena.then(fn, fn); cadena = p.catch(() => {}); return p; };
  const enCamino = (i, jornada) => i.jornada === jornada && ['pendiente', 'enviando', 'confirmada'].includes(i.estado);

  async function _guardarBorrador(jornada, form) {
    const lista = await todos();
    if (lista.some((i) => enCamino(i, jornada))) return null;     // ya enviada o en camino: no hay borrador que guardar
    const prev = lista.find((i) => i.jornada === jornada && i.estado === 'borrador');
    const it = prev || { id: dep.uuid(), dueno: dep.dueno(), jornada, estado: 'borrador', intentos: 0, error: null, creado: dep.ahora(), revision_id: null };
    it.form = form;
    await guardar(it);
    return it;
  }
  const guardarBorrador = (jornada, form) => enSerie(() => _guardarBorrador(jornada, form));

  // De borrador (o nuevo) a pendiente de envío. Conserva el mismo id: es la client_uuid del servidor.
  const encolar = (jornada, form) => enSerie(async () => {
    const motivo = revValidarLocal(form);
    if (motivo) { const e = new Error(motivo); e.validacion = true; throw e; }
    const ya = (await todos()).find((i) => enCamino(i, jornada));
    if (ya) return ya;     // ya hay una en camino o enviada: no se crea otra
    const it = await _guardarBorrador(jornada, form);
    it.estado = 'pendiente'; it.error = null;
    it.creado_en_dispositivo = dep.ahora();
    it.fotos = (form.fotos || []).map((f) => ({ uuid: f.uuid, b64: f.b64, subida: false }));
    it.form = Object.assign({}, form, { fotos: [] });   // las fotos viven solo en it.fotos
    await guardar(it);
    return it;
  });

  async function subirFotos(it) {
    let cambio = false;
    for (const f of it.fotos || []) {
      if (f.subida) continue;
      let r;
      try { r = await dep.subirFoto(it, f); } catch (e) { break; }          // sin red: se reintenta luego
      if (r.code === 200 || r.code === 201) { f.subida = true; delete f.b64; cambio = true; }
      else if (r.code === 403 || r.code === 409 || r.code === 400 || r.code === 404) { f.subida = 'descartada'; delete f.b64; cambio = true; }   // apagadas, tope o inválida: no se insiste
      else break;                                                            // 5xx / 401: más tarde
    }
    if (cambio) await guardar(it);
  }

  async function enviarUno(it) {
    if (it.estado === 'pendiente') {
      it.estado = 'enviando'; await guardar(it);
      let r;
      try { r = await dep.enviar(it); }
      catch (e) { it.estado = 'pendiente'; it.intentos++; it.error = 'Sin conexión'; await guardar(it); return; }
      const b = (r && r.body) || {};
      if (r.code === 200 || r.code === 201) { it.estado = 'confirmada'; it.error = null; it.revision_id = b.revision && b.revision.id; it.enviado_en = dep.ahora(); }
      else if (r.code === 409 && b.code === 'jornada_ya_registrada') { it.estado = 'conflicto'; it.error = 'Ya hay una revisión de esa jornada' + (b.revision && b.revision.conductor ? ' (' + b.revision.conductor + ')' : ''); }
      else if (r.code === 401 || r.code === 429 || r.code >= 500) { it.estado = 'pendiente'; it.intentos++; it.error = 'No se pudo enviar; se reintentará'; }
      else { it.estado = 'rechazada'; it.error = b.error || 'El servidor no aceptó la revisión'; }
      await guardar(it);
    }
    if (it.estado === 'confirmada' && (it.fotos || []).some((f) => !f.subida)) await subirFotos(it);
  }

  // Envía lo pendiente. Un cerrojo evita dos pasadas a la vez.
  async function procesar() {
    if (ocupado || !dep.enLinea()) return;
    ocupado = true;
    try {
      for (const it of await todos()) {
        if (it.estado === 'pendiente' || (it.estado === 'confirmada' && (it.fotos || []).some((f) => !f.subida))) await enviarUno(it);
      }
    } finally { ocupado = false; }
  }

  // Al abrir la app: lo que se quedó "enviando" (la app se cerró a mitad) vuelve a pendiente. Es seguro
  // reenviarlo: el servidor reconoce la misma client_uuid.
  async function recuperar() {
    for (const it of await todos()) if (it.estado === 'enviando') { it.estado = 'pendiente'; await guardar(it); }
  }

  async function descartar(id) { await dep.almacen.borrar(id); avisar(); }

  // Limpia lo confirmado hace más de `dias` días (y sin fotos por subir), los borradores de jornadas ya
  // enviadas o en camino (restos) y los borradores de más de 7 días.
  async function limpiar(hoy, dias) {
    const lista = await todos();
    for (const it of lista) {
      const edad = it.jornada ? Date.parse(hoy + 'T12:00:00Z') - Date.parse(it.jornada + 'T12:00:00Z') : 0;
      if (it.estado === 'confirmada' && edad > dias * 86400000 && !(it.fotos || []).some((f) => !f.subida)) await dep.almacen.borrar(it.id);
      else if (it.estado === 'borrador' && (edad > 7 * 86400000 || lista.some((o) => enCamino(o, it.jornada)))) await dep.almacen.borrar(it.id);
    }
  }

  return { guardarBorrador, encolar, procesar, recuperar, descartar, limpiar, todos, subirFotos };
}

// Almacén en memoria (pruebas y último recurso si el navegador no permite IndexedDB).
function revAlmacenMemoria() {
  const m = new Map();
  return {
    volatil: true,
    todos: async (dueno) => Array.from(m.values()).filter((i) => i.dueno === dueno).map((i) => JSON.parse(JSON.stringify(i))),
    guardar: async (it) => { m.set(it.id, JSON.parse(JSON.stringify(it))); },
    borrar: async (id) => { m.delete(id); },
  };
}
// </revision-logica>

// <revision-ui>
function revUuid() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  const b = new Uint8Array(16); crypto.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
}

// IndexedDB con respaldo en memoria. IndexedDB NO garantiza conservación permanente (el navegador puede
// vaciarla): por eso la pantalla siempre muestra "Pendiente de envío" hasta que el servidor confirma.
function revAlmacenIDB() {
  const mem = revAlmacenMemoria();
  let falla = typeof indexedDB === 'undefined';
  let dbp = null;
  const abrir = () => dbp || (dbp = new Promise((res, rej) => {
    const rq = indexedDB.open('kp_revision', 1);
    rq.onupgradeneeded = () => { if (!rq.result.objectStoreNames.contains('cola')) rq.result.createObjectStore('cola', { keyPath: 'id' }); };
    rq.onsuccess = () => res(rq.result);
    rq.onerror = () => rej(rq.error);
    rq.onblocked = () => rej(new Error('bloqueada'));
  }));
  const tx = async (modo, fn) => {
    const db = await abrir();
    return new Promise((res, rej) => {
      const t = db.transaction('cola', modo);
      const rq = fn(t.objectStore('cola'));
      t.oncomplete = () => res(rq && rq.result);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error);
    });
  };
  const alm = { volatil: falla };
  const intentar = async (accion, respaldo) => {
    if (!falla) { try { return await accion(); } catch (e) { falla = true; alm.volatil = true; } }
    return respaldo();
  };
  alm.todos = (dueno) => intentar(async () => (await tx('readonly', (st) => st.getAll())).filter((i) => i.dueno === dueno), () => mem.todos(dueno));
  alm.guardar = (it) => intentar(() => tx('readwrite', (st) => st.put(it)), () => mem.guardar(it));
  alm.borrar = (id) => intentar(() => tx('readwrite', (st) => st.delete(id)), () => mem.borrar(id));
  return alm;
}

// Reduce una foto en el teléfono: JPEG, lado largo 1280 px y menos de 250 KB. Devuelve base64 (sin cabecera).
function revComprimirFoto(file) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(file), img = new Image();
    img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('No se pudo leer la foto')); };
    img.onload = () => {
      URL.revokeObjectURL(url);
      let escala = Math.min(1, 1280 / Math.max(img.width, img.height)), q = 0.72;
      for (let i = 0; i < 14; i++) {
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(img.width * escala)); c.height = Math.max(1, Math.round(img.height * escala));
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        const b64 = c.toDataURL('image/jpeg', q).split(',')[1] || '';
        if (Math.floor(b64.length * 3 / 4) <= 245 * 1024) return res(b64);
        if (q > 0.4) q -= 0.1; else escala *= 0.8;
      }
      rej(new Error('La foto es demasiado grande'));
    };
    img.src = url;
  });
}

const Revision = {
  cola: null, items: [], estadoHoy: null, estado: null, errorEstado: '', form: null, jornada: null, editando: null, formVisible: false,
  modo: 'conductor', historial: [], pend: [], filtro: { novedades: false, dias: 30 }, indN: 0,
  vistaSel: 'frontal', tipoSel: 'rayon', ajusteFotos: false, guardaT: null, volatil: false, enviando: false,

  rol: function () { return (Auth.usuario && Auth.usuario.rol) || ''; },
  puedeLeer: function () { return this.rol() === 'owner' || this.rol() === 'staff'; },
  esDueno: function () { return this.rol() === 'owner'; },

  // Clave de la cola local: negocio + usuario (del JWT), para no mezclar cuentas en un mismo dispositivo.
  clave: function () {
    let biz = 'sin-negocio', uid = 'anon';
    try {
      const p = JSON.parse(atob(getToken().split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
      if (p.businessId) biz = String(p.businessId);
      if (p.userId) uid = String(p.userId);
    } catch (e) {}
    return 'rev:' + biz + ':' + uid;
  },

  crearCola: function () {
    const self = this, alm = revAlmacenIDB();
    this.cola = crearColaRevision({
      almacen: alm, dueno: () => self.clave(), uuid: revUuid, ahora: () => new Date().toISOString(),
      enLinea: () => typeof navigator === 'undefined' || navigator.onLine !== false,
      alCambiar: () => self.alCambiarCola(),
      enviar: (it) => apiRaw('/api/vehicle-checks', { method: 'POST', body: revCuerpo(it.form, { client_uuid: it.id, jornada: it.jornada, creado_en_dispositivo: it.creado_en_dispositivo }) }),
      subirFoto: (it, f) => apiRaw('/api/vehicle-checks/' + it.revision_id + '/photos', { method: 'POST', body: { client_uuid: f.uuid, mime: 'image/jpeg', datos: f.b64 } }),
    });
    this.volatil = !!alm.volatil;
  },

  // Arranque de sesión: recupera la cola, reintenta lo pendiente y calcula el indicador.
  iniciar: async function () {
    try {
      if (!this.cola) this.crearCola();
      await this.cola.recuperar();
      await this.cola.limpiar(hoyYmd(), 3);
      this.items = await this.cola.todos();
      this.cola.procesar().catch(() => {});
    } catch (e) { if (typeof console !== 'undefined') console.warn('[Revisión] no se pudo iniciar la cola', e); }
    this.refrescarIndicador();
  },
  alCerrarSesion: function () {
    clearTimeout(this.guardaT);
    this.items = []; this.estadoHoy = null; this.estado = null; this.form = null; this.editando = null; this.historial = []; this.pend = []; this.indN = 0; this.jornada = null;
    this.pintarIndicador();
  },
  alVolver: function () {
    if (!Auth.usuario || !getToken() || !this.cola) return;
    this.cola.procesar().catch(() => {}).then(() => this.refrescarIndicador());
  },
  alRecibirPing: function () {
    this.refrescarIndicador();
    if (App.actual === 'revision' && !this.form && !this.editando) this.abrir();
  },
  alCambiarCola: function () {
    if (!this.cola) return;
    this.cola.todos().then((l) => {
      this.items = l; this.pintarIndicador(); this.pintarTarjeta();
      // Si el conductor está mirando el estado de su revisión (no escribiendo), se actualiza solo:
      // p. ej. "Pendiente de envío" pasa a "Confirmada" cuando vuelve la conexión.
      if (App.actual === 'revision' && this.modo === 'conductor' && !this.formVisible) {
        this.cargarEstado(this.jornada).then(() => this.pintarConductor());
      }
    }).catch(() => {});
  },

  // ── Indicador visible (ESTADO, no evento): se apaga solo cuando ya no hay nada pendiente ──
  refrescarIndicador: async function () {
    if (!Auth.usuario || !getToken()) return;
    try {
      if (this.puedeLeer()) { const d = await api('/api/vehicle-checks/pendientes'); this.pend = d.pendientes || []; this.indN = this.pend.length; }
      else this.estadoHoy = await api('/api/vehicle-checks/estado');
    } catch (e) { /* sin red: se conserva lo último conocido */ }
    this.pintarIndicador(); this.pintarTarjeta();
  },
  pendientesDeEnvio: function () { return (this.items || []).filter((i) => i.estado === 'pendiente' || i.estado === 'enviando').length; },
  textoEstado: function () {
    if (this.puedeLeer()) {
      if (this.indN > 0) return { t: this.indN === 1 ? '1 inspección del vehículo pendiente' : this.indN + ' inspecciones del vehículo pendientes', s: 'Toca para ver cuáles', clase: 'alerta' };
      return null;
    }
    const mala = (this.items || []).find((i) => i.estado === 'conflicto' || i.estado === 'rechazada');
    if (this.pendientesDeEnvio() > 0) return { t: 'Revisión del vehículo pendiente de envío', s: 'Se enviará al tener conexión', clase: 'espera' };
    if (mala) return { t: 'La revisión del vehículo necesita atención', s: mala.error || '', clase: 'alerta' };
    const e = this.estadoHoy;
    if (e && e.requerida && e.lista && !e.existe) return { t: 'Falta la revisión del vehículo de hoy', s: 'Toca para completarla', clase: 'alerta' };
    if (e && e.requerida && e.existe) return { t: 'Revisión del vehículo enviada', s: '', clase: 'ok' };
    if (e && e.requerida && !e.lista) return { t: 'Revisión del vehículo', s: 'Se completa al terminar la ruta', clase: 'suave' };
    return null;
  },
  pintarIndicador: function () {
    const el = $('revInd'); if (!el) return;
    const t = this.textoEstado();
    // Solo se muestra de forma persistente lo que requiere acción (alerta o espera).
    const mostrar = t && (t.clase === 'alerta' || t.clase === 'espera');
    el.textContent = mostrar ? t.t : '';
    el.className = 'rev-ind' + (mostrar ? ' on ' + t.clase : '');
  },
  alTocarIndicador: function () { App.ir('revision'); },

  // Tarjeta dentro de Transporte (todos los roles).
  tarjetaHtml: function () { return '<div id="revTarjeta">' + this.htmlTarjeta() + '</div>'; },
  htmlTarjeta: function () {
    const t = this.textoEstado(); if (!t) return '';
    return '<div class="tarjeta rev-tarjeta ' + t.clase + '" onclick="App.ir(\'revision\')"><div><div class="rt-t">' + esc(t.t) + '</div>' +
      (t.s ? '<div class="rt-s">' + esc(t.s) + '</div>' : '') + '</div><span class="rt-ir">›</span></div>';
  },
  pintarTarjeta: function () { const el = $('revTarjeta'); if (el) el.innerHTML = this.htmlTarjeta(); },

  // ── Pantalla ──
  abrir: function () {
    if (!this.cola) this.crearCola();
    this.cola.todos().then((l) => { this.items = l; }).catch(() => {});
    if (this.puedeLeer() && !this.forzarForm) return this.abrirHistorial();
    this.forzarForm = false;
    return this.abrirConductor();
  },
  nueva: function () { this.forzarForm = true; this.form = null; this.editando = null; this.jornada = hoyYmd(); this.abrir(); },

  cargarEstado: async function (fecha) {
    try { this.estado = await api('/api/vehicle-checks/estado?date=' + fecha); this.errorEstado = ''; }
    catch (e) { this.estado = null; this.errorEstado = e.message; }
  },

  abrirConductor: async function () {
    this.modo = 'conductor';
    if (!this.jornada) this.jornada = hoyYmd();
    $('p-revision').innerHTML = skeletons(2);
    await this.cargarEstado(this.jornada);
    this.items = await this.cola.todos();
    if (!this.form && !this.editando) {
      const borrador = this.items.find((i) => i.jornada === this.jornada && i.estado === 'borrador');
      this.form = borrador ? borrador.form : revFormVacio();
    }
    this.pintarConductor();
  },
  cambiarJornada: function (v) {
    if (!v || v > hoyYmd() || v < sumarDias(hoyYmd(), -7)) { toast('Elige un día de los últimos 7'); return; }
    this.jornada = v; this.form = null; this.editando = null; this.abrirConductor();
  },

  pintarConductor: function () {
    if (this.modo !== 'conductor' || App.actual !== 'revision') return;
    const f = this.jornada, est = this.estado;
    const item = (this.items || []).find((i) => i.jornada === f && i.estado !== 'borrador');
    const hoy = hoyYmd();
    let h = '<div class="tr-fecha"><input type="date" value="' + esc(f) + '" min="' + esc(sumarDias(hoy, -7)) + '" max="' + esc(hoy) + '" onchange="Revision.cambiarJornada(this.value)"></div>';
    if (this.volatil) h += '<div class="rev-banner espera">Este dispositivo no permite guardar la revisión sin conexión de forma duradera. Envíala cuando tengas red.</div>';
    if (this.puedeLeer()) h += '<button class="btn-linea" style="width:100%;margin-bottom:12px" onclick="Revision.abrirHistorial()">‹ Volver al historial</button>';

    this.formVisible = false;   // se pone a true solo cuando se pinta el formulario (así no se repinta mientras se escribe)
    if (this.editando) { this.formVisible = true; $('p-revision').innerHTML = h + this.htmlForm(true); this.alPintarForm(); return; }

    if (item && (item.estado === 'pendiente' || item.estado === 'enviando')) {
      h += '<div class="tarjeta rev-estado espera"><div class="rt-t">' + esc(REV_ESTADOS_COLA[item.estado]) + '</div>' +
        '<div class="rt-s">' + (item.error ? esc(item.error) + '. ' : '') + 'La revisión está guardada en este dispositivo y se enviará sola al tener conexión.</div>' +
        '<div class="fila-botones"><button class="btn-linea btn-solido" onclick="Revision.reintentar()">Enviar ahora</button></div></div>';
      $('p-revision').innerHTML = h + this.htmlResumenForm(item.form); return;
    }
    if (item && (item.estado === 'conflicto' || item.estado === 'rechazada')) {
      h += '<div class="tarjeta rev-estado alerta"><div class="rt-t">' + esc(REV_ESTADOS_COLA[item.estado]) + '</div><div class="rt-s">' + esc(item.error || '') + '</div>' +
        '<div class="fila-botones"><button class="btn-linea" onclick="Revision.descartar(\'' + esc(item.id) + '\')">Descartar y empezar de nuevo</button></div></div>';
      $('p-revision').innerHTML = h + this.htmlResumenForm(item.form); return;
    }
    if ((est && est.existe) || (item && item.estado === 'confirmada')) {
      const r = est && est.revision;
      h += '<div class="tarjeta rev-estado ok"><div class="rt-t">Revisión enviada y confirmada</div><div class="rt-s">' +
        (r ? esc(r.conductor || '') + (r.version > 1 ? ' · versión ' + r.version : '') : 'Recibida por el servidor') + '</div>' +
        (est && est.puedeCorregir ? '<div class="fila-botones"><button class="btn-linea" onclick="Revision.corregir()">Corregir</button></div>' : '') + '</div>';
      $('p-revision').innerHTML = h + (r && r.controles ? this.htmlResumenDetalle(r) : (item ? this.htmlResumenForm(item.form) : '')); return;
    }
    // Sin revisión: el formulario.
    if (est && est.jornada === f && est.requerida === false && !(this.form && this.form.__tocado)) {
      h += '<div class="rev-banner suave">No hay transportes ese día: la revisión no es obligatoria, pero puedes registrarla.</div>';
    } else if (est && est.requerida && !est.lista) {
      h += '<div class="rev-banner suave">La ruta de ese día aún no está terminada (' + est.terminales + ' de ' + est.paradas + '). Puedes enviar la revisión indicando el motivo si quedó incompleta.</div>';
    } else if (this.errorEstado && !est) {
      h += '<div class="rev-banner espera">Sin conexión con el servidor: puedes rellenar la revisión y quedará pendiente de envío.</div>';
    }
    this.formVisible = true;
    $('p-revision').innerHTML = h + this.htmlForm(false);
    this.alPintarForm();
  },

  // ── Formulario ──
  chips: function (clave, op, valor) {
    return '<div class="rev-op" id="rg-' + clave + '">' + op.map((o) =>
      '<button type="button" data-v="' + esc(o[0]) + '" class="rev-chip' + (valor === o[0] ? ' on' : '') + '" onclick="Revision.set(\'' + clave + '\',\'' + o[0] + '\')">' + esc(o[1]) + '</button>').join('') + '</div>';
  },
  htmlForm: function (edicion) {
    const f = this.form, e = this.estado;
    let h = '<h2 class="gtitulo" style="margin-top:6px">' + (edicion ? 'Corregir la revisión' : 'Revisión del vehículo') + '</h2>' +
      '<div class="aj-hint" style="margin:-6px 4px 12px">' + (e && e.vehiculo ? esc(e.vehiculo) + ' · ' : '') + esc(diaBonito(this.jornada)) + '</div>';
    for (const g of REV_GRUPOS) {
      h += '<div class="aj-grupo">' + esc(g.t) + '</div><div class="tarjeta">';
      h += g.c.map((c) => '<div class="rev-fila"><div class="rev-et">' + esc(c.t) + '</div>' + this.chips(c.k, c.op, f.controles[c.k]) + '</div>').join('');
      h += '</div>';
    }
    h += '<div class="aj-grupo">Kilometraje</div><div class="tarjeta"><input class="aj-input" type="number" inputmode="numeric" min="0" placeholder="Opcional" value="' + esc(f.odometro) + '" oninput="Revision.campo(\'odometro\',this.value)"></div>';
    h += '<div class="aj-grupo">Daños</div><div class="tarjeta"><div class="rev-et">¿Hay daños nuevos en el vehículo?</div>' +
      '<div class="rev-op" id="rg-danos_nuevos">' + [[true, 'Sí'], [false, 'No']].map((o) => '<button type="button" class="rev-chip' + (f.danos_nuevos === o[0] ? ' on' : '') + '" onclick="Revision.setDanos(' + o[0] + ')">' + o[1] + '</button>').join('') + '</div>' +
      '<div id="revCroquis">' + this.htmlCroquis() + '</div></div>';
    h += '<div class="aj-grupo">Ruta</div><div class="tarjeta"><div class="rev-et">¿Quedó la ruta incompleta?</div>' +
      '<div class="rev-op" id="rg-ruta">' + [[true, 'Sí'], [false, 'No']].map((o) => '<button type="button" class="rev-chip' + (f.ruta_incompleta === o[0] ? ' on' : '') + '" onclick="Revision.setRuta(' + o[0] + ')">' + o[1] + '</button>').join('') + '</div>' +
      '<div id="revMotivo">' + this.htmlMotivo() + '</div></div>';
    if (!edicion && e && e.fotosActivas) {
      h += '<div class="aj-grupo">Fotos (opcional)</div><div class="tarjeta"><div id="revFotos">' + this.htmlFotos() + '</div>' +
        '<input type="file" id="revFotoIn" accept="image/*" capture="environment" multiple style="display:none" onchange="Revision.alElegirFotos(this)">' +
        '<button type="button" class="btn-linea" style="width:100%;margin-top:10px" onclick="$(\'revFotoIn\').click()">Añadir foto</button>' +
        '<div class="aj-hint">Máximo ' + REV_MAX_FOTOS + ' fotos. Se reducen en el teléfono antes de enviarse.</div></div>';
    }
    h += '<div class="aj-grupo">Observaciones</div><div class="tarjeta"><textarea class="aj-input" rows="3" maxlength="1000" placeholder="Opcional" oninput="Revision.campo(\'observaciones\',this.value)" style="width:100%">' + esc(f.observaciones) + '</textarea>';
    if (edicion) h += '<input class="aj-input" style="margin-top:10px" maxlength="200" placeholder="Motivo del cambio (opcional)" id="revMotivoCambio">';
    h += '</div>';
    h += '<label class="aj-toggle tarjeta"><span>Confirmo que revisé el vehículo</span><span class="sw"><input type="checkbox" id="revConf" ' + (f.confirmacion ? 'checked' : '') + ' onchange="Revision.campo(\'confirmacion\',this.checked)"><i></i></span></label>';
    h += '<div class="fila-botones"><button class="btn-linea btn-solido" id="revEnviar" onclick="Revision.' + (edicion ? 'guardarCorreccion' : 'enviar') + '()">' + (edicion ? 'Guardar corrección' : 'Enviar revisión') + '</button>' +
      (edicion ? '<button class="btn-linea" onclick="Revision.cancelarEdicion()">Cancelar</button>' : '') + '</div>';
    h += '<div class="aj-hint" style="text-align:center;margin-top:8px">' + (edicion ? 'Cada corrección queda en el historial de versiones.' : 'Si no hay conexión, se guarda en este dispositivo y se envía sola.') + '</div>';
    return h;
  },
  alPintarForm: function () { /* el formulario usa eventos en línea; nada que enlazar */ },

  guardarBorradorDiferido: function () {
    if (this.editando || !this.cola || !this.form) return;
    clearTimeout(this.guardaT);
    this.guardaT = setTimeout(() => { if (this.form && !this.editando && !this.enviando) this.cola.guardarBorrador(this.jornada, this.form).catch(() => {}); }, 700);
  },
  set: function (k, v) {
    this.form.controles[k] = v; this.form.__tocado = true;
    const g = $('rg-' + k); if (g) g.querySelectorAll('.rev-chip').forEach((b) => b.classList.toggle('on', b.getAttribute('data-v') === v));
    this.guardarBorradorDiferido();
  },
  campo: function (k, v) { this.form[k] = v; this.form.__tocado = true; this.guardarBorradorDiferido(); },
  setDanos: function (v) {
    this.form.danos_nuevos = v; if (!v) this.form.danos = [];
    this.marcarGrupo('rg-danos_nuevos', v ? 0 : 1);
    $('revCroquis').innerHTML = this.htmlCroquis(); this.guardarBorradorDiferido();
  },
  setRuta: function (v) {
    this.form.ruta_incompleta = v;
    this.marcarGrupo('rg-ruta', v ? 0 : 1);
    $('revMotivo').innerHTML = this.htmlMotivo(); this.guardarBorradorDiferido();
  },
  marcarGrupo: function (id, idx) { const g = $(id); if (g) g.querySelectorAll('.rev-chip').forEach((b, i) => b.classList.toggle('on', i === idx)); },
  htmlMotivo: function () {
    if (this.form.ruta_incompleta !== true) return '';
    return '<textarea class="aj-input" rows="2" maxlength="300" placeholder="Motivo (obligatorio)" style="width:100%;margin-top:10px" oninput="Revision.campo(\'motivo_ruta\',this.value)">' + esc(this.form.motivo_ruta) + '</textarea>';
  },

  // ── Croquis de daños ──
  svgVehiculo: function (vista) {
    const lat = '<path d="M28 124 L28 74 Q28 58 46 56 L112 50 L196 50 Q220 50 232 74 L262 94 Q272 100 272 114 L272 124 Z" class="rv-body"/><path d="M40 74 L40 62 L108 58 L108 80 Z" class="rv-glass"/><path d="M118 58 L190 58 Q208 58 216 76 L216 82 L118 82 Z" class="rv-glass"/><circle cx="84" cy="126" r="20" class="rv-rueda"/><circle cx="222" cy="126" r="20" class="rv-rueda"/>';
    if (vista === 'lateral_izq') return lat;
    if (vista === 'lateral_der') return '<g transform="translate(300,0) scale(-1,1)">' + lat + '</g>';
    if (vista === 'techo') return '<rect x="92" y="12" width="116" height="146" rx="22" class="rv-body"/><rect x="104" y="22" width="92" height="34" rx="9" class="rv-glass"/><rect x="104" y="116" width="92" height="30" rx="9" class="rv-glass"/><line x1="104" y1="70" x2="196" y2="70" class="rv-line"/><line x1="104" y1="100" x2="196" y2="100" class="rv-line"/>';
    const caja = '<rect x="62" y="28" width="176" height="104" rx="20" class="rv-body"/><rect x="52" y="124" width="196" height="16" rx="7" class="rv-body"/><rect x="68" y="136" width="30" height="24" rx="5" class="rv-rueda"/><rect x="202" y="136" width="30" height="24" rx="5" class="rv-rueda"/>';
    if (vista === 'trasera') return caja + '<rect x="82" y="40" width="64" height="52" rx="6" class="rv-glass"/><rect x="154" y="40" width="64" height="52" rx="6" class="rv-glass"/><rect x="70" y="100" width="12" height="20" rx="3" class="rv-luz"/><rect x="218" y="100" width="12" height="20" rx="3" class="rv-luz"/><rect x="124" y="104" width="52" height="14" rx="3" class="rv-line"/>';
    return caja + '<rect x="82" y="40" width="136" height="44" rx="8" class="rv-glass"/><circle cx="92" cy="108" r="9" class="rv-luz"/><circle cx="208" cy="108" r="9" class="rv-luz"/><rect x="124" y="98" width="52" height="12" rx="3" class="rv-line"/>';
  },
  htmlCroquis: function () {
    const f = this.form;
    if (f.danos_nuevos !== true) return '';
    const marcas = f.danos.map((d, i) => d.vista !== this.vistaSel ? '' :
      '<g><circle cx="' + (d.x * 300).toFixed(1) + '" cy="' + (d.y * 170).toFixed(1) + '" r="11" class="rv-marca"/><text x="' + (d.x * 300).toFixed(1) + '" y="' + (d.y * 170 + 4).toFixed(1) + '" class="rv-num">' + (i + 1) + '</text></g>').join('');
    return '<div class="rev-et" style="margin-top:12px">Toca en el croquis donde está el daño</div>' +
      '<div class="rev-tabs">' + REV_VISTAS.map((v) => '<button type="button" class="rev-chip' + (this.vistaSel === v[0] ? ' on' : '') + '" onclick="Revision.vista(\'' + v[0] + '\')">' + esc(v[1]) + '</button>').join('') + '</div>' +
      '<svg viewBox="0 0 300 170" class="rev-svg" onclick="Revision.tocarCroquis(event)" role="img" aria-label="Croquis del vehículo">' + this.svgVehiculo(this.vistaSel) + marcas + '</svg>' +
      '<div class="rev-et">Tipo de daño</div><div class="rev-tabs">' + REV_TIPOS.map((t) => '<button type="button" class="rev-chip' + (this.tipoSel === t[0] ? ' on' : '') + '" onclick="Revision.tipo(\'' + t[0] + '\')">' + esc(t[1]) + '</button>').join('') + '</div>' +
      '<div id="revLista">' + this.htmlListaDanos() + '</div>';
  },
  htmlListaDanos: function () {
    const f = this.form;
    if (!f.danos.length) return '<div class="aj-hint">Aún no has marcado ningún daño.</div>';
    return f.danos.map((d, i) => '<div class="rev-dano"><b>' + (i + 1) + '</b><span>' + esc((REV_VISTAS.find((v) => v[0] === d.vista) || [0, d.vista])[1]) + ' · ' +
      esc((REV_TIPOS.find((t) => t[0] === d.tipo) || [0, d.tipo])[1]) + '</span>' +
      '<input class="aj-input" maxlength="200" placeholder="Nota (opcional)" value="' + esc(d.nota) + '" oninput="Revision.notaDano(' + i + ',this.value)">' +
      '<button type="button" class="btn-linea" onclick="Revision.quitarDano(' + i + ')" aria-label="Quitar">✕</button></div>').join('');
  },
  vista: function (v) { this.vistaSel = v; $('revCroquis').innerHTML = this.htmlCroquis(); },
  tipo: function (t) { this.tipoSel = t; $('revCroquis').innerHTML = this.htmlCroquis(); },
  tocarCroquis: function (ev) {
    if (this.form.danos.length >= REV_MAX_DANOS) { toast('Máximo ' + REV_MAX_DANOS + ' daños'); return; }
    const r = ev.currentTarget.getBoundingClientRect();
    const x = Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width)), y = Math.min(1, Math.max(0, (ev.clientY - r.top) / r.height));
    this.form.danos.push({ vista: this.vistaSel, x: Math.round(x * 1000) / 1000, y: Math.round(y * 1000) / 1000, tipo: this.tipoSel, nota: '' });
    this.form.__tocado = true;
    $('revCroquis').innerHTML = this.htmlCroquis(); this.guardarBorradorDiferido();
  },
  notaDano: function (i, v) { if (this.form.danos[i]) this.form.danos[i].nota = v; this.guardarBorradorDiferido(); },
  quitarDano: function (i) { this.form.danos.splice(i, 1); $('revCroquis').innerHTML = this.htmlCroquis(); this.guardarBorradorDiferido(); },

  // ── Fotos (solo si el propietario las activó; el servidor las vuelve a comprobar) ──
  htmlFotos: function () {
    const fs = this.form.fotos || [];
    return fs.length ? '<div class="rev-fotos">' + fs.map((f, i) => '<div class="rev-foto"><img alt="Foto ' + (i + 1) + '" src="data:image/jpeg;base64,' + f.b64 + '"><button type="button" onclick="Revision.quitarFoto(' + i + ')" aria-label="Quitar foto">✕</button></div>').join('') + '</div>' : '<div class="aj-hint">Sin fotos.</div>';
  },
  alElegirFotos: async function (input) {
    const lista = Array.from(input.files || []); input.value = '';
    for (const file of lista) {
      if (this.form.fotos.length >= REV_MAX_FOTOS) { toast('Máximo ' + REV_MAX_FOTOS + ' fotos'); break; }
      try { this.form.fotos.push({ uuid: revUuid(), b64: await revComprimirFoto(file) }); } catch (e) { toast(e.message || 'No se pudo procesar la foto'); }
    }
    const c = $('revFotos'); if (c) c.innerHTML = this.htmlFotos();
    this.guardarBorradorDiferido();
  },
  quitarFoto: function (i) { this.form.fotos.splice(i, 1); const c = $('revFotos'); if (c) c.innerHTML = this.htmlFotos(); this.guardarBorradorDiferido(); },

  // ── Envío ──
  enviar: async function () {
    if (this.enviando) return;
    const err = revValidarLocal(this.form);
    if (err) { toast(err); return; }
    this.enviando = true;
    clearTimeout(this.guardaT);   // el autoguardado del borrador no debe cruzarse con el envío
    try {
      const f = this.form; delete f.__tocado;
      await this.cola.encolar(this.jornada, f);
      this.form = null;
      toast(navigator.onLine === false ? 'Guardada. Se enviará al tener conexión' : 'Enviando…');
      await this.cola.procesar();
    } catch (e) { toast(e.message || 'No se pudo guardar la revisión'); }
    finally { this.enviando = false; }
    await this.cargarEstado(this.jornada);
    this.items = await this.cola.todos();
    this.pintarConductor(); this.refrescarIndicador();
  },
  reintentar: async function () {
    toast('Enviando…');
    await this.cola.procesar();
    await this.cargarEstado(this.jornada); this.items = await this.cola.todos();
    this.pintarConductor(); this.refrescarIndicador();
  },
  descartar: async function (id) {
    await this.cola.descartar(id); this.form = null; this.items = await this.cola.todos();
    await this.cargarEstado(this.jornada); this.abrirConductor(); this.refrescarIndicador();
  },

  // ── Corrección (necesita conexión: no pasa por la cola) ──
  formDesdeDetalle: function (r) {
    return { controles: Object.assign({}, r.controles), odometro: r.odometro === null || r.odometro === undefined ? '' : String(r.odometro),
      danos_nuevos: !!r.danos_nuevos, danos: (r.danos || []).map((d) => Object.assign({}, d)), ruta_incompleta: !!r.ruta_incompleta,
      motivo_ruta: r.motivo_ruta || '', observaciones: r.observaciones || '', confirmacion: false, fotos: [] };
  },
  corregir: function () {
    const r = this.estado && this.estado.revision;
    if (!r || !r.controles) { toast('No se pudo cargar la revisión'); return; }
    this.form = this.formDesdeDetalle(r); this.editando = { id: r.id, version: r.version };
    this.pintarConductor();
  },
  cancelarEdicion: function () { this.editando = null; this.form = null; this.abrir(); },
  guardarCorreccion: async function () {
    if (this.enviando) return;
    const err = revValidarLocal(this.form);
    if (err) { toast(err); return; }
    if (navigator.onLine === false) { toast('Para corregir necesitas conexión'); return; }
    this.enviando = true;
    try {
      const m = $('revMotivoCambio');
      await api('/api/vehicle-checks/' + this.editando.id, { method: 'PUT', body: revCuerpo(this.form, { version_esperada: this.editando.version, motivo_cambio: m ? m.value : '' }) });
      toast('Corrección guardada');
      this.editando = null; this.form = null;
    } catch (e) { toast(e.message || 'No se pudo guardar la corrección'); this.enviando = false; return; }
    this.enviando = false;
    this.refrescarIndicador();
    if (this.puedeLeer()) this.abrirHistorial(); else this.abrirConductor();
  },

  // ── Resúmenes de solo lectura ──
  filaResumen: function (clave, valor, titulo) {
    const mala = valor === 'revisar' || valor === 'defectuoso' || valor === 'necesita_limpieza' || (REV_SI_NO.some((o) => o[0] === valor) && valor === 'no' && ['jaulas_sujeciones', 'botiquin', 'agua', 'documentos'].indexOf(clave) !== -1);
    return '<div class="det-fila"><span>' + esc(titulo) + '</span><b' + (mala ? ' style="color:var(--rojo)"' : '') + '>' + esc(revEtiqueta(clave, valor)) + '</b></div>';
  },
  htmlResumenDetalle: function (r) {
    let h = '<div class="tarjeta det">';
    for (const g of REV_GRUPOS) for (const c of g.c) if (r.controles[c.k] !== undefined) h += this.filaResumen(c.k, r.controles[c.k], c.t);
    if (r.odometro !== null && r.odometro !== undefined) h += '<div class="det-fila"><span>Kilometraje</span><b>' + esc(r.odometro) + '</b></div>';
    h += '<div class="det-fila"><span>Daños nuevos</span><b>' + (r.danos_nuevos ? 'Sí (' + (r.danos || []).length + ')' : 'No') + '</b></div>';
    (r.danos || []).forEach((d, i) => { h += '<div class="det-fila"><span>' + (i + 1) + '. ' + esc((REV_VISTAS.find((v) => v[0] === d.vista) || [0, d.vista])[1]) + '</span><b>' + esc((REV_TIPOS.find((t) => t[0] === d.tipo) || [0, d.tipo])[1]) + (d.nota ? ' · ' + esc(d.nota) : '') + '</b></div>'; });
    if (r.ruta_incompleta) h += '<div class="det-fila"><span>Ruta incompleta</span><b style="color:var(--rojo)">' + esc(r.motivo_ruta || 'Sí') + '</b></div>';
    if (r.observaciones) h += '<div class="det-fila"><span>Observaciones</span><b>' + esc(r.observaciones) + '</b></div>';
    return h + '</div>';
  },
  htmlResumenForm: function (f) { return f ? this.htmlResumenDetalle({ controles: f.controles || {}, odometro: f.odometro === '' ? null : f.odometro, danos_nuevos: f.danos_nuevos, danos: f.danos, ruta_incompleta: f.ruta_incompleta, motivo_ruta: f.motivo_ruta, observaciones: f.observaciones }) : ''; },

  // ── Historial (propietario y personal) ──
  abrirHistorial: async function () {
    this.modo = 'historial'; this.form = null; this.editando = null;
    $('p-revision').innerHTML = skeletons(3);
    const desde = sumarDias(hoyYmd(), -this.filtro.dias);
    try {
      const [h, p] = await Promise.all([
        api('/api/vehicle-checks?from=' + desde + '&limit=200' + (this.filtro.novedades ? '&novedades=1' : '')),
        api('/api/vehicle-checks/pendientes'),
      ]);
      this.historial = h.revisiones || []; this.pend = p.pendientes || []; this.indN = this.pend.length;
    } catch (e) { $('p-revision').innerHTML = '<div class="vacio"><div class="vt">No se pudo cargar</div><div class="vs">' + esc(e.message) + '</div></div>'; return; }
    this.pintarHistorial(); this.pintarIndicador();
  },
  filtrar: function (dias, nov) { if (dias) this.filtro.dias = dias; if (nov !== undefined) this.filtro.novedades = nov; this.abrirHistorial(); },
  pintarHistorial: function () {
    if (this.modo !== 'historial' || App.actual !== 'revision') return;
    const fl = this.filtro;
    let h = '<div class="seg">' + [7, 30, 90].map((d) => '<button class="' + (fl.dias === d ? 'on' : '') + '" onclick="Revision.filtrar(' + d + ')">' + d + ' días</button>').join('') + '</div>';
    h += '<label class="aj-toggle tarjeta"><span>Solo con novedades</span><span class="sw"><input type="checkbox" ' + (fl.novedades ? 'checked' : '') + ' onchange="Revision.filtrar(0,this.checked)"><i></i></span></label>';
    if (this.esDueno()) h += '<div class="fila-botones" style="margin:0 0 12px"><button class="btn-linea" onclick="Revision.exportarCsv()">Exportar CSV</button><button class="btn-linea btn-solido" onclick="Revision.nueva()">Hacer una revisión</button></div>';
    if (this.pend.length) {
      h += '<div class="gtitulo">Pendientes</div>' + this.pend.map((p) => '<div class="tarjeta rev-tarjeta alerta"><div><div class="rt-t">' + esc(diaBonito(p.jornada)) + '</div><div class="rt-s">' + p.terminales + ' de ' + p.paradas + ' traslados terminados · sin revisión</div></div></div>').join('');
    }
    h += '<div class="gtitulo">Revisiones</div>';
    if (!this.historial.length) h += '<div class="vacio"><div class="vt">Sin revisiones</div><div class="vs">No hay revisiones en este periodo.</div></div>';
    else h += this.historial.map((r) => '<div class="tarjeta" onclick="Revision.ver(\'' + esc(r.id) + '\')"><div class="cita-cab"><span class="cli-nombre">' + esc(diaBonito(r.jornada)) + '</span>' +
      (r.hay_novedades ? '<span class="chip" style="background:rgba(255,61,113,.14);color:var(--rojo)">Novedades</span>' : '<span class="chip suave">Sin novedades</span>') + '</div>' +
      '<div class="cli-linea">' + esc(r.conductor || '—') + (r.vehiculo ? ' · ' + esc(r.vehiculo) : '') + '</div>' +
      '<div class="tr-pie">' + (r.ruta_incompleta ? '<span class="chip suave">Ruta incompleta</span>' : '') + (r.version > 1 ? '<span class="chip suave">v' + r.version + '</span>' : '') + (r.fotos ? '<span class="chip suave">' + r.fotos + ' foto' + (r.fotos === 1 ? '' : 's') + '</span>' : '') + '</div></div>').join('');
    $('p-revision').innerHTML = h;
  },
  ver: async function (id) {
    let r;
    try { r = await api('/api/vehicle-checks/' + id); } catch (e) { toast(e.message); return; }
    this.detalleActual = r;
    let h = '<h3>' + esc(diaBonito(r.jornada)) + '</h3><div class="aj-hint" style="margin-bottom:8px">' + esc(r.conductor || '') + (r.vehiculo ? ' · ' + esc(r.vehiculo) : '') + ' · versión ' + r.version + '</div>' + this.htmlResumenDetalle(r);
    if (r.versiones && r.versiones.length > 1) {
      h += '<div class="aj-grupo">Historial de cambios</div><div class="tarjeta det">' + r.versiones.map((v) => '<div class="det-fila"><span>v' + v.version + ' · ' + esc(String(v.cambiado_en || '').slice(0, 16).replace('T', ' ')) + '</span><b>' + esc(v.cambiado_por || '') + (v.motivo ? ' — ' + esc(v.motivo) : '') + '</b></div>').join('') + '</div>';
    }
    if (r.fotos && r.fotos.length) h += '<div class="aj-grupo">Fotos</div><div class="rev-fotos" id="revFotosDet"><div class="aj-hint">Cargando…</div></div>';
    h += '<div class="fila-botones" style="margin-top:12px">' + (this.esDueno() ? '<button class="btn-linea" onclick="Revision.corregirDesdeHistorial()">Corregir</button>' : '') + '<button class="btn-linea" onclick="Hoja.cerrar()">Cerrar</button></div>';
    Hoja.abrir(h);
    if (r.fotos && r.fotos.length) this.cargarFotos(r);
  },
  cargarFotos: async function (r) {
    const cont = $('revFotosDet'); if (!cont) return;
    const out = [];
    for (const f of r.fotos) {
      try {
        const res = await fetch(BACKEND + '/api/vehicle-checks/' + r.id + '/photos/' + f.id, { headers: { Authorization: 'Bearer ' + getToken() } });
        if (res.ok) out.push('<div class="rev-foto"><img alt="Foto de la revisión" src="' + URL.createObjectURL(await res.blob()) + '"></div>');
      } catch (e) {}
    }
    cont.innerHTML = out.length ? out.join('') : '<div class="aj-hint">No se pudieron cargar las fotos.</div>';
  },
  corregirDesdeHistorial: function () {
    const r = this.detalleActual; if (!r) return;
    Hoja.cerrar();
    this.modo = 'conductor'; this.jornada = r.jornada;
    this.estado = { jornada: r.jornada, existe: true, revision: r, puedeCorregir: true, fotosActivas: false, vehiculo: r.vehiculo };
    this.form = this.formDesdeDetalle(r); this.editando = { id: r.id, version: r.version };
    this.pintarConductor();
  },
  exportarCsv: async function () {
    try {
      const desde = sumarDias(hoyYmd(), -this.filtro.dias);
      const res = await fetch(BACKEND + '/api/vehicle-checks/export.csv?from=' + desde, { headers: { Authorization: 'Bearer ' + getToken() } });
      if (!res.ok) throw new Error('No se pudo exportar');
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement('a'); a.href = url; a.download = 'revisiones-vehiculo.csv';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (e) { toast(e.message || 'No se pudo exportar'); }
  },

  // ── Ajuste de fotos (Ajustes, solo propietario). Apagado por defecto ──
  cargarAjusteFotos: async function () {
    const c = $('ajRevFotos'); if (!c) return;
    try { const s = await api('/api/vehicle-checks/settings'); this.ajusteFotos = !!s.fotosActivas; c.checked = this.ajusteFotos; } catch (e) {}
  },
  guardarAjusteFotos: async function (on) {
    try { await api('/api/vehicle-checks/settings', { method: 'PUT', body: { fotosActivas: !!on } }); this.ajusteFotos = !!on; toast(on ? 'Fotos activadas' : 'Fotos desactivadas'); }
    catch (e) { toast(e.message); const c = $('ajRevFotos'); if (c) c.checked = this.ajusteFotos; }
  },
};

// Reintentos al recuperar la red o volver a la app (listeners propios; no hay polling).
function registrarCicloRevision() {
  if (typeof window !== 'undefined' && window.addEventListener) window.addEventListener('online', function () { Revision.alVolver(); });
  if (typeof document !== 'undefined' && document.addEventListener) {
    document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') Revision.alVolver(); });
  }
}
// </revision-ui>

// ── Ciclo de vida / red (FASE 6) ──────────────────────────────
// Reconexión de WebSocket, vuelta online y app volviéndose visible terminan en
// UNA sola vía: Avis.sincronizar (que deduplica con el seen-set y agrupa señales
// cercanas). No hay polling ni un segundo sistema de sincronización. Mientras el
// dispositivo esté offline no se consulta; al volver 'online' se reintenta.
function registrarCicloDeVida() {
  if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('online', function () { Avis.sincronizar('online'); });
  }
  if (typeof document !== 'undefined' && document.addEventListener) {
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') Avis.sincronizar('visible');
    });
  }
}

// ── Arranque ──────────────────────────────────────────────────
AvisosUI.init();          // escucha kp:aviso ANTES de que Auth.init pueda auto-arrancar sesión
registrarCicloDeVida();   // listeners de online/visibilidad (la reconexión WS la dispara Vivo)
registrarCicloRevision(); // reintento de la cola de la revisión del vehículo al volver la red
Auth.init();
