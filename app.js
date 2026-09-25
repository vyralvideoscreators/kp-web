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
  if (res.status === 401 || res.status === 403) { setToken(''); Auth.mostrarLogin(); throw new Error('Sesión terminada'); }
  const cuerpo = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(cuerpo.error || 'No se pudo completar');
  return cuerpo;
}

// ── Hoja de confirmación (un paso, para lo irreversible) ──────
const Hoja = {
  abrir: function (html) { $('hoja').innerHTML = html; $('velo').classList.add('on'); $('hoja').classList.add('on'); },
  cerrar: function () { $('velo').classList.remove('on'); $('hoja').classList.remove('on'); },
};

// ── Notificaciones ────────────────────────────────────────────
// Avisa cuando entra una cita por aprobar o un traslado nuevo. Usa las
// notificaciones del navegador + el WebSocket que ya tenemos: funciona con la
// app ABIERTA (aunque esté en segundo plano y siga viva). Para que lleguen con
// la app cerrada haría falta "push" del servidor (fase 2, toca el backend).
const Notif = {
  citasPrev: null, trasPrev: null,

  activa: function (tipo) { try { return localStorage.getItem('kp_notif_' + tipo) === '1'; } catch (e) { return false; } },
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

  disparar: function (titulo, cuerpo) {
    try { if (typeof Notification !== 'undefined' && Notification.permission === 'granted') new Notification(titulo, { body: cuerpo }); } catch (e) {}
  },

  // Mira los conteos actuales; si crecieron y la notificación está activa, avisa.
  // La primera vez solo fija los conteos base (no avisa).
  revisar: async function () {
    try {
      if (this.activa('citas')) {
        const pend = await api('/api/appointments?estado=por_aprobar');
        const n = pend.length;
        if (this.citasPrev !== null && n > this.citasPrev) this.disparar('Citas por aprobar', 'Tienes ' + n + (n === 1 ? ' cita por aprobar' : ' citas por aprobar'));
        this.citasPrev = n;
      }
      if (this.activa('traslados')) {
        const t = await api('/api/transport?date=' + hoyYmd());
        const n = (t.paradas || []).length;
        if (this.trasPrev !== null && n > this.trasPrev) this.disparar('Traslados de hoy', 'Hay ' + n + (n === 1 ? ' traslado' : ' traslados') + ' para hoy');
        this.trasPrev = n;
      }
    } catch (e) {}
  },
};

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
    const esDriver = this.usuario && this.usuario.rol === 'driver';
    if (esDriver) {
      ['citas', 'informes'].forEach(sec => {
        const b = document.querySelector('#nav button[data-sec="' + sec + '"]');
        if (b) b.style.display = 'none';
      });
    }
    Vivo.conectar();
    App.ir(esDriver ? 'transporte' : 'citas');
    Notif.revisar();   // fija los conteos base para las notificaciones
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
  ws: null, reintento: null,

  conectar: function () {
    try {
      const url = BACKEND.replace(/^http/, 'ws') + '/ws';
      this.ws = new WebSocket(url);
      this.ws.onopen = () => this.ws.send(JSON.stringify({ type: 'auth', token: getToken() }));
      this.ws.onmessage = e => {
        let m = {}; try { m = JSON.parse(e.data); } catch (x) {}
        if (m.type === 'ready') this.estado(true);
        if (m.type === 'appointment_update') { Citas.refrescarPorEvento(); }
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
  titulos: { citas: 'Citas', clientes: 'Clientes', transporte: 'Transporte', informes: 'Informes', ajustes: 'Ajustes' },

  ir: function (sec) {
    this.actual = sec;
    $('tituloPantalla').textContent = this.titulos[sec];
    document.querySelectorAll('.pantalla').forEach(p => p.classList.toggle('activa', p.id === 'p-' + sec));
    document.querySelectorAll('#nav button').forEach(b => b.classList.toggle('on', b.dataset.sec === sec));
    // La hamburguesa se marca cuando estamos en Ajustes (no es una pestaña del nav).
    $('btnAjustes').classList.toggle('on', sec === 'ajustes');
    ({ citas: Citas, clientes: Clientes, transporte: Transporte, informes: Informes, ajustes: Ajustes })[sec].abrir();
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

  refrescarPorEvento: function () {
    Notif.revisar();
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
        '<button class="btn-linea" onclick="event.stopPropagation();Citas.rechazar(\'' + c.id + '\',\'' + esc(c.cliente || '') + '\')">Rechazar</button>' +
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
      '<button class="btn-linea" onclick="Citas.rechazar(\'' + c.id + '\',\'' + esc(c.cliente || '') + '\')">Rechazar</button>' +
      '<button class="btn-linea btn-solido" onclick="Hoja.cerrar();Citas.aceptar(\'' + c.id + '\')">Aceptar</button>' +
      '</div>';
    h += '<button class="btn-linea" style="width:100%;margin-top:9px" onclick="Hoja.cerrar()">Cerrar</button>';
    Hoja.abrir(h);
  },

  aceptar: async function (id) {
    try { await api('/api/appointments/' + id + '/estado', { method: 'POST', body: { estado: 'confirmed' } }); toast('Cita aceptada'); await this.cargar(true); if (this.vista === 'agenda') this.cargarAgenda(); }
    catch (e) { toast(e.message); }
  },

  rechazar: function (id, nombre) {
    Hoja.abrir(
      '<h3>Rechazar la cita</h3>' +
      '<p>La de ' + esc(nombre || 'este cliente') + ' se cancelará. Es una acción que no se deshace.</p>' +
      '<textarea id="rzMotivo" rows="2" placeholder="Motivo (opcional)"></textarea>' +
      '<div class="fila-botones">' +
        '<button class="btn-linea" onclick="Hoja.cerrar()">No</button>' +
        '<button class="btn-linea" style="background:var(--rojo);border-color:transparent;color:#fff" onclick="Citas.confirmarRechazo(\'' + id + '\')">Sí, rechazar</button>' +
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

    // Mapa
    h += '<div class="mapa-caja"><div class="mapa-barra">' +
      '<span class="info" id="trInfo">' + (paradas.length ? paradas.length + (paradas.length === 1 ? ' parada' : ' paradas') : 'Sin paradas') + '</span>' +
      '<button class="btn-linea" style="flex:0 0 auto;padding:8px 12px" onclick="Transporte.abrirEnMaps()">Ver en Maps</button>' +
      '</div><div class="mapa-zona"><div class="mapa-real" id="trMapa" style="display:none"></div>' +
      '<div class="mapa-vacio" id="trMapaVacio"><div class="t">Mapa no conectado</div><div class="s">Se activa con la clave de Google Maps del negocio.</div></div>' +
      '</div></div>';

    // Ruta del día
    h += '<div class="gtitulo">' + (esHoy ? 'Ruta de hoy' : 'Ruta · ' + esc(diaBonito(this.fecha))) + '</div>';
    if (!paradas.length) {
      h += '<div class="vacio"><div class="vt">Sin traslados este día</div><div class="vs">Usa las flechas para ver otros días. Cuando una cita pida transporte, aparece aquí.</div></div>';
    } else {
      h += paradas.map((p, i) => this.tarjetaParada(p, i)).join('');
    }
    $('p-transporte').innerHTML = h;
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
      '<span class="cli-nombre">' + (i + 1) + '. ' + esc(p.cliente) + (p.mascota ? ' · ' + esc(p.mascota) : '') + '</span>' +
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
            '<span class="sw"><input type="checkbox" ' + (Notif.activa('citas') ? 'checked' : '') + ' onchange="Ajustes.toggleNotif(\'citas\', this.checked)"><i></i></span></label>' +
          '<div class="aj-sep"></div>') +
        '<label class="aj-toggle"><span>Traslados</span>' +
          '<span class="sw"><input type="checkbox" ' + (Notif.activa('traslados') ? 'checked' : '') + ' onchange="Ajustes.toggleNotif(\'traslados\', this.checked)"><i></i></span></label>' +
        (Notif.permiso() === 'denied'
          ? '<div class="aj-hint" style="color:var(--rojo)">Las notificaciones están bloqueadas. Actívalas en los ajustes del navegador.</div>'
          : '<div class="aj-hint">Te avisa cuando entra una cita por aprobar o un traslado, con la app abierta.</div>') +
      '</div>' +

      '<div class="aj-grupo">Aplicación</div>' +
      '<button class="btn-linea btn-solido aj-btn" style="margin-top:0" onclick="Ajustes.actualizar()">Actualizar la app</button>' +
      '<div class="aj-hint" style="text-align:center">Trae la última versión desde el servidor. También se actualiza sola cada vez que abres la app.</div>' +

      '<div class="aj-grupo">Sesión</div>' +
      '<button class="aj-salir" onclick="Ajustes.cerrarSesion()">Cerrar sesión</button>' +

      '<div class="aj-pie">Kisses and Paws · Huashu — v0.1</div>';
  },

  toggleNotif: async function (tipo, on) {
    const ok = await Notif.alternar(tipo, on);
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
    Citas.cargado = Clientes.cargado = Transporte.cargado = Informes.cargado = false;
    App.ir('citas');   // deja lista la primera pestaña para el próximo login
    Auth.mostrarLogin();
  },
};

// ── Arranque ──────────────────────────────────────────────────
Auth.init();
