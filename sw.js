'use strict';
// ══════════════════════════════════════════════════════════════
// Service Worker de la PWA — mínimo a propósito.
//
// Solo existe para que la app se pueda instalar. Guarda en caché los
// archivos de la instalación (manifest e iconos) y NADA más:
//  · index.html y app.js no se tocan: siguen yendo a la red como siempre,
//    así "Actualizar la app" trae la última versión igual que antes.
//  · Nada de fuera de este origen pasa por aquí: ni el backend (Railway),
//    ni Google Maps, ni las fuentes. El WebSocket nunca pasa por un SW.
//  · Nunca se guardan respuestas de la API, ni el token, ni datos de
//    clientes, citas o traslados.
// ══════════════════════════════════════════════════════════════

const VERSION = 'kp-pwa-v1';
const PREFIJO = 'kp-pwa-';

// Rutas relativas al alcance del SW: valen igual en / (desarrollo) que en
// /kp-web/ (GitHub Pages).
const ESTATICOS = [
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png',
];

const urlsEstaticas = () => ESTATICOS.map(r => new URL(r, self.registration.scope).href);

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(VERSION)
      .then(cache => cache.addAll(urlsEstaticas()))
      .then(() => self.skipWaiting())
  );
});

// Al activarse, se borran las cachés de versiones anteriores de este SW.
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(claves => Promise.all(
        claves.filter(c => c.startsWith(PREFIJO) && c !== VERSION).map(c => caches.delete(c))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // Lo externo queda fuera del SW: el navegador lo pide como siempre.
  if (url.origin !== self.location.origin) return;

  // Solo los archivos de la instalación; todo lo demás, sin tocar.
  const limpia = url.origin + url.pathname;
  if (urlsEstaticas().indexOf(limpia) === -1) return;

  event.respondWith(
    caches.match(limpia).then(guardada => guardada || fetch(req))
  );
});
