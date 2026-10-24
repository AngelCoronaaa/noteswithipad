import express from 'express';
import pg from 'pg';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const scrypt = promisify(crypto.scrypt);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT || 3000);
const DATABASE_URL = process.env.DATABASE_URL || 'postgres://notes:notes@localhost:5433/notes';
const SESSION_DAYS = 30;

const pool = new pg.Pool({ connectionString: DATABASE_URL });

await pool.query(`
  CREATE TABLE IF NOT EXISTS users (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    username      text NOT NULL UNIQUE,
    password_hash text NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash text PRIMARY KEY,
    user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at timestamptz NOT NULL
  );
  CREATE TABLE IF NOT EXISTS notes (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title      text NOT NULL DEFAULT '',
    body       text NOT NULL DEFAULT '',
    drawing    jsonb,
    pinned     boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  ALTER TABLE notes ADD COLUMN IF NOT EXISTS kind  text NOT NULL DEFAULT 'note';
  ALTER TABLE notes ADD COLUMN IF NOT EXISTS paper text NOT NULL DEFAULT 'blank';
  CREATE INDEX IF NOT EXISTS notes_user_updated_idx ON notes (user_id, pinned DESC, updated_at DESC);
  DELETE FROM sessions WHERE expires_at < now();
`);

// ---------- helpers ----------

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, 64);
  return `s1$${salt.toString('hex')}$${hash.toString('hex')}`;
}

async function verifyPassword(password, stored) {
  const [, saltHex, hashHex] = stored.split('$');
  const expected = Buffer.from(hashHex, 'hex');
  const actual = await scrypt(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function setSessionCookie(req, res, token, maxAgeSeconds) {
  const secure = req.secure || process.env.NODE_ENV === 'production';
  res.setHeader(
    'Set-Cookie',
    `sid=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure ? '; Secure' : ''}`
  );
}

async function createSession(req, res, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  await pool.query(
    `INSERT INTO sessions (token_hash, user_id, expires_at)
     VALUES ($1, $2, now() + make_interval(days => $3))`,
    [sha256(token), userId, SESSION_DAYS]
  );
  setSessionCookie(req, res, token, SESSION_DAYS * 86400);
}

// Rate limit sencillo en memoria para login/registro.
const attempts = new Map();
function authLimiter(req, res, next) {
  const now = Date.now();
  const rec = attempts.get(req.ip);
  if (!rec || rec.reset < now) {
    attempts.set(req.ip, { count: 1, reset: now + 15 * 60_000 });
    return next();
  }
  if (++rec.count > 20) return res.status(429).json({ error: 'Demasiados intentos, espera unos minutos.' });
  next();
}

async function requireUser(req, res, next) {
  try {
    const token = parseCookies(req.headers.cookie).sid;
    if (token) {
      const { rows } = await pool.query(
        `SELECT u.id, u.username FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = $1 AND s.expires_at > now()`,
        [sha256(token)]
      );
      if (rows[0]) {
        req.user = rows[0];
        return next();
      }
    }
    res.status(401).json({ error: 'No autenticado' });
  } catch (err) {
    next(err);
  }
}

const isUuid = (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

const KINDS = ['note', 'canvas'];
const PAPERS = ['blank', 'grid', 'lined', 'dots'];

const LIST_COLUMNS = `id, title, kind, left(body, 140) AS preview, pinned, updated_at,
  (drawing IS NOT NULL AND jsonb_array_length(coalesce(drawing->'strokes', '[]'::jsonb)) > 0) AS has_drawing`;

// ---------- app ----------

const app = express();
if (process.env.TRUST_PROXY) app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'"
  );
  next();
});

app.use(express.json({ limit: '30mb' }));

// Bloquea peticiones de escritura que no sean JSON (mitiga CSRF junto con SameSite=Lax).
app.use('/api', (req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'DELETE' && !req.is('application/json')) {
    return res.status(415).json({ error: 'Content-Type debe ser application/json' });
  }
  next();
});

// Siempre revalida (ETag): evita que Safari/PWA siga mostrando una versión vieja de la app.
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
}));

// ----- auth -----

function validateCredentials(body) {
  const username = String(body?.username ?? '').trim().toLowerCase();
  const password = String(body?.password ?? '');
  if (!/^[a-z0-9_.-]{3,32}$/.test(username)) {
    return { error: 'Usuario: 3–32 caracteres (letras, números, . _ -)' };
  }
  if (password.length < 8 || password.length > 200) {
    return { error: 'La contraseña debe tener al menos 8 caracteres' };
  }
  return { username, password };
}

app.post('/api/auth/register', authLimiter, async (req, res, next) => {
  try {
    const { username, password, error } = validateCredentials(req.body);
    if (error) return res.status(400).json({ error });
    const { rows } = await pool.query(
      `INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id, username`,
      [username, await hashPassword(password)]
    );
    await createSession(req, res, rows[0].id);
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Ese usuario ya existe' });
    next(err);
  }
});

app.post('/api/auth/login', authLimiter, async (req, res, next) => {
  try {
    const username = String(req.body?.username ?? '').trim().toLowerCase();
    const password = String(req.body?.password ?? '');
    const { rows } = await pool.query(`SELECT id, username, password_hash FROM users WHERE username = $1`, [username]);
    const ok = rows[0] ? await verifyPassword(password, rows[0].password_hash) : false;
    if (!ok) return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
    await createSession(req, res, rows[0].id);
    res.json({ id: rows[0].id, username: rows[0].username });
  } catch (err) {
    next(err);
  }
});

app.post('/api/auth/logout', async (req, res, next) => {
  try {
    const token = parseCookies(req.headers.cookie).sid;
    if (token) await pool.query(`DELETE FROM sessions WHERE token_hash = $1`, [sha256(token)]);
    setSessionCookie(req, res, '', 0);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

app.get('/api/me', requireUser, (req, res) => res.json(req.user));

// ----- notes -----

app.get('/api/notes', requireUser, async (req, res, next) => {
  try {
    const q = String(req.query.q ?? '').trim();
    const params = [req.user.id];
    let where = 'user_id = $1';
    if (q) {
      params.push(`%${q.replace(/[\\%_]/g, '\\$&')}%`);
      where += ' AND (title ILIKE $2 OR body ILIKE $2)';
    }
    const { rows } = await pool.query(
      `SELECT ${LIST_COLUMNS} FROM notes WHERE ${where} ORDER BY pinned DESC, updated_at DESC LIMIT 500`,
      params
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

app.post('/api/notes', requireUser, async (req, res, next) => {
  try {
    const kind = KINDS.includes(req.body?.kind) ? req.body.kind : 'note';
    const paper = PAPERS.includes(req.body?.paper) ? req.body.paper : 'blank';
    const { rows } = await pool.query(
      `INSERT INTO notes (user_id, kind, paper) VALUES ($1, $2, $3) RETURNING ${LIST_COLUMNS}`,
      [req.user.id, kind, paper]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

app.get('/api/notes/:id', requireUser, async (req, res, next) => {
  try {
    if (!isUuid(req.params.id)) return res.status(404).json({ error: 'No encontrada' });
    const { rows } = await pool.query(
      `SELECT id, title, kind, paper, body, drawing, pinned, updated_at FROM notes WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.user.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'No encontrada' });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// Serialización estable (claves ordenadas) para comparar JSON sin depender del orden de las claves.
function canon(v) {
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`;
  return JSON.stringify(v ?? null);
}

const FULL_COLUMNS = 'id, title, kind, paper, body, drawing, pinned, updated_at';

// Crea o actualiza una nota. Pensado para sincronización sin conexión:
//  - `create` + id del cliente: crea la nota si no existe (y es idempotente si se reintenta).
//  - `base`: updated_at que el cliente conocía. Si la nota cambió desde entonces en el servidor y el cliente
//    quiere pisar título/texto/dibujo con otro valor, responde 409 con la versión del servidor (no se pierde nada).
app.put('/api/notes/:id', requireUser, async (req, res, next) => {
  if (!isUuid(req.params.id)) return res.status(404).json({ error: 'No encontrada' });
  const b = req.body ?? {};
  const fields = {};
  if ('title' in b) fields.title = String(b.title).slice(0, 300);
  if ('body' in b) fields.body = String(b.body).slice(0, 500_000);
  if ('pinned' in b) fields.pinned = Boolean(b.pinned);
  if ('paper' in b) {
    if (!PAPERS.includes(b.paper)) return res.status(400).json({ error: 'Papel inválido' });
    fields.paper = b.paper;
  }
  if ('drawing' in b) {
    if (b.drawing !== null && (typeof b.drawing !== 'object' || !Array.isArray(b.drawing.strokes))) {
      return res.status(400).json({ error: 'Dibujo inválido' });
    }
    fields.drawing = b.drawing;
  }
  const create = b.create && typeof b.create === 'object' ? b.create : null;
  const base = typeof b.base === 'string' && !Number.isNaN(Date.parse(b.base)) ? Date.parse(b.base) : null;
  if (!Object.keys(fields).length && !create) return res.status(400).json({ error: 'Nada que actualizar' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const select = () => client.query(`SELECT ${FULL_COLUMNS}, user_id FROM notes WHERE id = $1 FOR UPDATE`, [req.params.id]);
    let { rows } = await select();

    if (!rows[0] && create) {
      const kind = KINDS.includes(create.kind) ? create.kind : 'note';
      const paper = fields.paper ?? (PAPERS.includes(create.paper) ? create.paper : 'blank');
      const ins = await client.query(
        `INSERT INTO notes (id, user_id, title, body, drawing, pinned, kind, paper)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)
         ON CONFLICT (id) DO NOTHING RETURNING ${LIST_COLUMNS}`,
        [req.params.id, req.user.id, fields.title ?? '', fields.body ?? '', fields.drawing == null ? null : JSON.stringify(fields.drawing), fields.pinned ?? false, kind, paper]
      );
      if (ins.rows[0]) {
        await client.query('COMMIT');
        return res.status(201).json(ins.rows[0]);
      }
      ({ rows } = await select()); // otro intento simultáneo ya la creó: continúa como actualización
    }

    const row = rows[0];
    if (!row || row.user_id !== req.user.id) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'No encontrada' });
    }

    if (base !== null && row.updated_at.getTime() > base) {
      const conflicts = ['title', 'body', 'drawing'].filter((f) => f in fields && canon(fields[f]) !== canon(row[f]));
      if (conflicts.length) {
        await client.query('ROLLBACK');
        const { user_id, ...server } = row;
        return res.status(409).json({ error: 'conflict', fields: conflicts, server });
      }
    }

    const sets = [];
    const params = [req.params.id, req.user.id];
    const add = (col, value, cast = '') => {
      params.push(value);
      sets.push(`${col} = $${params.length}${cast}`);
    };
    if ('title' in fields) add('title', fields.title);
    if ('body' in fields) add('body', fields.body);
    if ('pinned' in fields) add('pinned', fields.pinned);
    if ('paper' in fields) add('paper', fields.paper);
    if ('drawing' in fields) add('drawing', fields.drawing === null ? null : JSON.stringify(fields.drawing), '::jsonb');
    if (!sets.length) {
      await client.query('COMMIT');
      const cur = await pool.query(`SELECT ${LIST_COLUMNS} FROM notes WHERE id = $1`, [req.params.id]);
      return res.json(cur.rows[0]);
    }
    // El pin no debe mover la nota en "modificadas recientemente".
    if (Object.keys(fields).some((k) => k !== 'pinned')) sets.push('updated_at = now()');

    const upd = await client.query(
      `UPDATE notes SET ${sets.join(', ')} WHERE id = $1 AND user_id = $2 RETURNING ${LIST_COLUMNS}`,
      params
    );
    await client.query('COMMIT');
    res.json(upd.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

app.delete('/api/notes/:id', requireUser, async (req, res, next) => {
  try {
    if (!isUuid(req.params.id)) return res.status(404).json({ error: 'No encontrada' });
    await pool.query(`DELETE FROM notes WHERE id = $1 AND user_id = $2`, [req.params.id, req.user.id]);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

app.use('/api', (req, res) => res.status(404).json({ error: 'No encontrado' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'La nota es demasiado grande' });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'JSON inválido' });
  console.error(err);
  res.status(500).json({ error: 'Error del servidor' });
});

app.listen(PORT, () => console.log(`Notas listo en http://localhost:${PORT}`));
