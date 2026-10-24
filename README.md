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

## Apple Pencil

- Herramientas: **Texto**, **Lápiz** (con presión), **Borrador** (borra trazos completos).
- Con Lápiz/Borrador activos, solo el Pencil dibuja y el dedo hace scroll. El botón de la mano permite dibujar también con el dedo.
- En modo Texto, Scribble de iPadOS convierte tu escritura a texto en el título y el cuerpo.
- La hoja crece automáticamente al dibujar cerca del borde inferior.

## Estructura

- `server.js` — API Express + PostgreSQL (usuarios, sesiones, notas). Contraseñas con scrypt, sesiones con cookie HttpOnly.
- `public/` — frontend sin dependencias ni build.
- Los dibujos se guardan como JSON (`notes.drawing`, `jsonb`) con coordenadas normalizadas, así se ven igual en cualquier pantalla.
