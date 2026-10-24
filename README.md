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

## Notas y lienzos

El botón **+** crea:

- **Nota**: título y texto, con el dibujo encima.
- **Lienzo**: hoja libre para dibujar, con papel en blanco, cuadrícula, rayada o de puntos (selector arriba a la derecha).

## Apple Pencil

- Con las herramientas de dibujo activas, **el Pencil dibuja y no mueve la hoja**; el dedo desplaza la hoja (con inercia). El botón de la mano permite dibujar también con el dedo.
- **Lápices** (toca el lápiz otra vez para abrir el panel): bolígrafo, pluma, lápiz de grafito, marcador, resaltador y pincel, con presión y grosor ajustable.
- **Colores**: 16 colores, "tinta" que se adapta al tema claro/oscuro y selector personalizado.
- **Formas**: línea, flecha, rectángulo, elipse, triángulo, rombo y estrella, con o sin relleno (con Shift se mantienen proporciones en ratón).
- **Stickers**: 48 emojis y etiquetas (IDEA, HECHO, URGENTE, TO-DO).
- **Seleccionar**: mueve, escala (asa en la esquina), duplica, recolorea o elimina cualquier trazo, forma o sticker.
- **Borrador** de trazos completos, deshacer/rehacer y la hoja crece al dibujar cerca del borde inferior.
- En una nota, en modo Texto, Scribble de iPadOS convierte tu escritura a texto.

## Estructura

- `server.js` — API Express + PostgreSQL (usuarios, sesiones, notas). Contraseñas con scrypt, sesiones con cookie HttpOnly.
- `public/` — frontend sin dependencias ni build.
- Los dibujos se guardan como JSON (`notes.drawing`, `jsonb`) con coordenadas normalizadas, así se ven igual en cualquier pantalla. `notes.kind` distingue nota/lienzo y `notes.paper` guarda el tipo de papel (las tablas existentes se migran solas).
