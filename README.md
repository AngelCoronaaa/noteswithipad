# Notas (liquid glass + Apple Pencil)

App web de notas con texto y dibujo a mano, guardadas por usuario en PostgreSQL.

## Arrancar

```bash
npm install
npm run db      # PostgreSQL en Docker (puerto 5433)
npm start       # http://localhost:3000
```

Las tablas se crean solas al iniciar. Para usar otra base de datos, copia `.env.example` a `.env` y cambia `DATABASE_URL`.

## Usarla en el iPad

Abre `http://<ip-de-tu-mac>:3000` en Safari (mismo Wi‑Fi) y usa *Compartir → Añadir a pantalla de inicio* para verla a pantalla completa.
Para uso fuera de casa, ponla detrás de HTTPS (Caddy, Nginx, Cloudflare Tunnel…) y arranca con `NODE_ENV=production TRUST_PROXY=1`.

## Apariencia

Arriba a la derecha eliges **Automático** (sigue al sistema), **Claro** u **Oscuro**, con una animación de revelado. Se recuerda en cada dispositivo. El fondo es liso, sin colores.

## Instalarla como app (PWA)

- **iPad/iPhone:** Safari → Compartir → *Añadir a pantalla de inicio*.
- **Mac/Android/PC:** botón *Instalar* de Chrome o Edge en la barra de direcciones.
- Hay accesos directos al mantener pulsado el icono: *Nueva nota* y *Nuevo lienzo*.
- El service worker (la app abre sin conexión) solo funciona en **HTTPS** o en `localhost`. Por `http://<ip-de-tu-mac>:3000` se puede añadir a la pantalla de inicio, pero sin service worker. Para HTTPS fuera de casa usa Cloudflare Tunnel, Tailscale Serve, Caddy, etc.
- La red va primero: siempre intenta cargar la versión nueva y solo usa la copia guardada si no hay conexión, así nunca se queda atascada una versión vieja.

## Sin conexión y sincronización

Las notas se guardan primero **en el dispositivo** (IndexedDB) y se envían al servidor cuando hay conexión:

- Puedes **ver, crear, editar, dibujar, fijar, buscar y borrar** sin conexión, incluso recargando la app.
- Arriba, junto a "Notas", aparece **"Sin conexión · N pendientes"**; las notas aún sin enviar tienen un punto naranja.
- Al volver la conexión se sincroniza solo (también al abrir la app, al volver a ella y cada 45 s). Tocar el indicador reintenta al momento.
- Los cambios hechos en otros dispositivos se bajan en cada sincronización. La nota que estás editando no se pisa.
- **Conflictos:** si editas la misma nota sin conexión y en otro dispositivo, se conserva la versión del servidor y la tuya se guarda como copia `"Título (conflicto)"`. No se pierde texto ni dibujos.
- Cerrar sesión necesita conexión (así no se pierden cambios sin enviar) y **borra las copias locales** de ese dispositivo.
- Safari no permite sincronizar con la app cerrada: lo pendiente se envía la próxima vez que la abras.
- La primera vez en un dispositivo hace falta conexión para descargar las notas.

## Inicio, archivos e importar/exportar

- Al entrar ves el **inicio**: tarjetas con vista previa de notas, lienzos y archivos, filtros (Todo / Notas / Lienzos / Archivos), búsqueda y sección de fijadas. El botón **⋯** de cada tarjeta permite fijar, duplicar, exportar o eliminar.
- **Importar** (botón o arrastrando al inicio): `.txt`/`.md` se convierten en notas, las copias `.notas.json` se restauran completas y cualquier otro archivo (PDF, imágenes, audio, vídeo…) se guarda en **Archivos** (máx. 30 MB). Los archivos también funcionan sin conexión.
- **Visor de archivos**: imágenes, PDF, texto, audio y vídeo. Las imágenes tienen **Anotar**, que crea un lienzo con la imagen para escribir encima.
- En un lienzo, el botón de imagen de la barra **inserta una foto**; se puede mover, escalar, enviar al fondo y el borrador no la borra.
- **Exportar** (botón de compartir en el editor): PNG (lienzos), PDF (diálogo de impresión → Guardar como PDF), Markdown (notas) y `.notas.json`. En el menú de la cuenta: **copia de seguridad** completa.

## Notas y lienzos

El botón **+** crea:

- **Nota**: título y texto, con el dibujo encima.
- **Lienzo**: infinito y con zoom, con papel en blanco, cuadrícula, rayada o de puntos (selector arriba a la derecha).
  - Un dedo desplaza, dos dedos hacen zoom (10 %–800 %); en ordenador, rueda/trackpad para moverse y Ctrl/⌘ + rueda o pellizco para el zoom.
  - El botón de porcentaje ofrece *Zoom 100 %*, *Ver todo* y *Volver al inicio*. Cada lienzo recuerda su vista.

## Apple Pencil

- Con las herramientas de dibujo activas, **el Pencil dibuja y no mueve la hoja**; el dedo desplaza la hoja (con inercia). El botón de la mano permite dibujar también con el dedo.
- **Lápices** (toca el lápiz otra vez para abrir el panel): bolígrafo, pluma, lápiz de grafito, marcador, resaltador y pincel, con presión y grosor ajustable.
- **Colores**: 16 colores, "tinta" que se adapta al tema claro/oscuro y selector personalizado.
- **Formas**: línea, flecha, rectángulo, elipse, triángulo, rombo y estrella, con o sin relleno (con Shift se mantienen proporciones en ratón).
- **Stickers**: 48 emojis y etiquetas (IDEA, HECHO, URGENTE, TO-DO).
- **Seleccionar (lazo)**: rodea varios elementos (o toca uno) para moverlos, escalarlos (asa en la esquina), duplicarlos, recolorearlos, enviarlos al fondo o eliminarlos juntos.
- **Estabilizador** (panel de lápices): suaviza el temblor del trazo; 0 lo desactiva.
- **Borrador** de trazos completos, deshacer/rehacer y la hoja crece al dibujar cerca del borde inferior.
- **Rechazo de palma:** mientras escribes con el Pencil, los toques de la mano no seleccionan texto, no desplazan la hoja y no pulsan botones.
- En una nota, en modo Texto, Scribble de iPadOS convierte tu escritura a texto.

## Despliegue y caché

Cada vez que arranca, el servidor calcula un identificador del contenido de `public/` y lo añade a las URLs de CSS y JS (`app.css?v=…`). Así un CDN (p. ej. Cloudflare, que por defecto guarda estos archivos 4 h en el navegador) nunca mezcla un HTML nuevo con un CSS o JS viejo. Basta con reiniciar el servidor tras actualizar.

## Estructura

- `server.js` — API Express + PostgreSQL (usuarios, sesiones, notas). Contraseñas con scrypt, sesiones con cookie HttpOnly.
- `public/` — frontend sin dependencias ni build: `app.js` (interfaz y dibujo), `store.js` (IndexedDB), `sync.js` (sincronización), `sw.js` (PWA).
- Tablas: `users`, `sessions`, `notes` y `files` (contenido en `bytea`).
- Los dibujos se guardan como JSON (`notes.drawing`, `jsonb`) con coordenadas normalizadas, así se ven igual en cualquier pantalla. `notes.kind` distingue nota/lienzo y `notes.paper` guarda el tipo de papel (las tablas existentes se migran solas).
