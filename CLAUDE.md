# kp-web — app móvil de Kisses and Paws (PWA)

Fuente de verdad del frontend de la app móvil del dueño (Christian, iPhone/Safari → Agregar a inicio).
Sitio estático en GitHub Pages: `app.magicdesignllc.com` (ver `CNAME`), remoto `vyralvideoscreators/kp-web`.
Habla con el backend de producción en Railway (`kissesandpaws-production.up.railway.app`). El backend es otro repo y no se modifica desde aquí.

`kissesandpaws-movil-huashu` es una copia antigua sin remoto y sin las FASES 2-6 de avisos: no editar ahí.

## Estructura

- `index.html`, `app.js` — toda la app (JS sin framework ni build).
- `sw.js` — service worker mínimo a propósito: solo cachea manifest e iconos; nunca API, token ni datos de clientes. Subir `VERSION` solo si cambia la lista de estáticos.
- `manifest.webmanifest`, `icons/` — instalación PWA.
- `test/*.test.js` — tests con `node --test`, sin dependencias.

## Comandos

- `npm test` — corre los tests (`node --test`).
- Servidor local: ver `.claude/launch.json` (puerto 5500). En local `app.js` usa el backend local; publicado, siempre producción.

## Reglas

- Sin build ni dependencias: editar y subir los archivos. No introducir bundlers ni paquetes.
- Antes de dar por buena una lógica de `app.js`, correr `npm test`; los módulos de avisos/transporte tienen cobertura.
- Trabajar en rama aparte; nunca push a `main` sin autorización expresa (publica directo a Christian).
- Commits con prefijo tipo `feat(area):` / `fix(area):` como el historial.
