// Reconocimiento de formas ("mantén el lápiz quieto al terminar el trazo").
//
// recognizeShape(points) recibe el trazo en px de pantalla ([[x, y], …]) y, si se parece a una forma,
// devuelve { kind, points, closed } con la forma limpia: línea, círculo, elipse, rectángulo, triángulo,
// polígono o línea quebrada. Si no se parece a nada (p. ej. escritura), devuelve null.

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const TAU = Math.PI * 2;

function pathLength(P) {
  let L = 0;
  for (let i = 1; i < P.length; i++) L += dist(P[i - 1], P[i]);
  return L;
}

// Remuestreo uniforme por longitud de arco (como en el reconocedor $1)
function resample(points, n) {
  const step = pathLength(points) / (n - 1);
  if (!step) return Array.from({ length: n }, () => points[0]);
  const pts = points.map((p) => [p[0], p[1]]);
  const out = [pts[0]];
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const d = dist(pts[i - 1], pts[i]);
    if (d > 0 && acc + d >= step) {
      const t = (step - acc) / d;
      const q = [pts[i - 1][0] + t * (pts[i][0] - pts[i - 1][0]), pts[i - 1][1] + t * (pts[i][1] - pts[i - 1][1])];
      out.push(q);
      pts.splice(i, 0, q);
      acc = 0;
    } else {
      acc += d;
    }
  }
  while (out.length < n) out.push(pts[pts.length - 1]);
  return out.slice(0, n);
}

function segDist(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2)) : 0;
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

// Ramer–Douglas–Peucker: vértices de una polilínea
function rdp(P, eps) {
  const keep = new Uint8Array(P.length);
  keep[0] = keep[P.length - 1] = 1;
  const stack = [[0, P.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let worst = 0, idx = -1;
    for (let i = a + 1; i < b; i++) {
      const d = segDist(P[i], P[a], P[b]);
      if (d > worst) { worst = d; idx = i; }
    }
    if (worst > eps) {
      keep[idx] = 1;
      stack.push([a, idx], [idx, b]);
    }
  }
  return P.filter((_, i) => keep[i]);
}

// Giro en un vértice en grados (0 = sigue recto, 180 = vuelve atrás)
function turn(a, b, c) {
  const a1 = Math.atan2(b[1] - a[1], b[0] - a[0]);
  const a2 = Math.atan2(c[1] - b[1], c[0] - b[0]);
  let d = Math.abs(a2 - a1) % TAU;
  if (d > Math.PI) d = TAU - d;
  return (d * 180) / Math.PI;
}

// Ajusta un ángulo a múltiplos de `stepDeg` si está a menos de `tolDeg`
function snapAngle(rad, stepDeg, tolDeg) {
  const deg = (rad * 180) / Math.PI;
  const snapped = Math.round(deg / stepDeg) * stepDeg;
  return Math.abs(deg - snapped) <= tolDeg ? (snapped * Math.PI) / 180 : rad;
}

// Distancia de los puntos a una polilínea (cerrada o abierta): máxima y media
function deviations(R, V, closed) {
  let worst = 0, sum = 0;
  for (const p of R) {
    let best = Infinity;
    const n = closed ? V.length : V.length - 1;
    for (let i = 0; i < n; i++) best = Math.min(best, segDist(p, V[i], V[(i + 1) % V.length]));
    worst = Math.max(worst, best);
    sum += best;
  }
  return { max: worst, mean: sum / R.length };
}
const maxDeviation = (R, V, closed) => deviations(R, V, closed).max;

// Elipse por componentes principales: centro, radios, giro y error medio del radio normalizado
function fitEllipse(R) {
  const n = R.length;
  let mx = 0, my = 0;
  for (const [x, y] of R) { mx += x; my += y; }
  mx /= n; my /= n;
  let sxx = 0, syy = 0, sxy = 0;
  for (const [x, y] of R) {
    sxx += (x - mx) ** 2;
    syy += (y - my) ** 2;
    sxy += (x - mx) * (y - my);
  }
  const th = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const ux = Math.cos(th), uy = Math.sin(th);
  const proj = R.map(([x, y]) => [(x - mx) * ux + (y - my) * uy, -(x - mx) * uy + (y - my) * ux]);
  const as = proj.map((p) => p[0]), bs = proj.map((p) => p[1]);
  const amin = Math.min(...as), amax = Math.max(...as), bmin = Math.min(...bs), bmax = Math.max(...bs);
  const rx = (amax - amin) / 2, ry = (bmax - bmin) / 2;
  if (rx < 6 || ry < 6) return null;
  const ca = (amax + amin) / 2, cb = (bmax + bmin) / 2;
  let err = 0, swept = 0, prev = null;
  for (const [a, b] of proj) {
    err += Math.abs(Math.hypot((a - ca) / rx, (b - cb) / ry) - 1);
    const ang = Math.atan2(b - cb, a - ca);
    if (prev !== null) {
      let d = ang - prev;
      if (d > Math.PI) d -= TAU;
      if (d < -Math.PI) d += TAU;
      swept += d;
    }
    prev = ang;
  }
  return { cx: mx + ux * ca - uy * cb, cy: my + uy * ca + ux * cb, rx, ry, th, err: err / n, coverage: Math.abs(swept) };
}

function ellipsePoints(cx, cy, rx, ry, th, steps = 72) {
  const pts = [];
  const c = Math.cos(th), s = Math.sin(th);
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * TAU;
    const x = rx * Math.cos(t), y = ry * Math.sin(t);
    pts.push([cx + x * c - y * s, cy + x * s + y * c]);
  }
  return pts;
}

// Rectángulo orientado según el lado más largo; se endereza si está casi horizontal/vertical
function fitRect(V, R) {
  let best = 0, th = 0;
  for (let i = 0; i < V.length; i++) {
    const a = V[i], b = V[(i + 1) % V.length];
    const d = dist(a, b);
    if (d > best) { best = d; th = Math.atan2(b[1] - a[1], b[0] - a[0]); }
  }
  th = snapAngle(th, 90, 10);
  const ux = Math.cos(th), uy = Math.sin(th);
  const proj = R.map(([x, y]) => [x * ux + y * uy, -x * uy + y * ux]);
  // Bordes robustos: percentiles 5–95 para ignorar picos del trazo
  const sorted = (arr) => [...arr].sort((p, q) => p - q);
  const as = sorted(proj.map((p) => p[0])), bs = sorted(proj.map((p) => p[1]));
  const q = (arr, f) => arr[Math.min(arr.length - 1, Math.max(0, Math.round(f * (arr.length - 1))))];
  const a0 = q(as, 0.04), a1 = q(as, 0.96), b0 = q(bs, 0.04), b1 = q(bs, 0.96);
  const corner = (a, b) => [a * ux - b * uy, a * uy + b * ux];
  const pts = [corner(a0, b0), corner(a1, b0), corner(a1, b1), corner(a0, b1)];
  return [...pts, pts[0]];
}

function isStraight(R, a, b, chord) {
  const ux = (b[0] - a[0]) / chord, uy = (b[1] - a[1]) / chord;
  let lo = Infinity, hi = -Infinity, worst = 0;
  for (const p of R) {
    const t = (p[0] - a[0]) * ux + (p[1] - a[1]) * uy;
    lo = Math.min(lo, t);
    hi = Math.max(hi, t);
    worst = Math.max(worst, Math.abs(-(p[0] - a[0]) * uy + (p[1] - a[1]) * ux));
  }
  if (!(worst < Math.max(6, chord * 0.07) && lo > -chord * 0.08 && hi < chord * 1.08)) return false;
  // Sin ondas: el recorrido suavizado (sin el temblor) mide casi lo mismo que la recta. La escritura ondula.
  const S = R.map((_, i) => {
    let x = 0, y = 0, n = 0;
    for (let k = Math.max(0, i - 2); k <= Math.min(R.length - 1, i + 2); k++) { x += R[k][0]; y += R[k][1]; n++; }
    return [x / n, y / n];
  });
  return pathLength(S) / chord < 1.05;
}

export function recognizeShape(points) {
  if (points.length < 2) return null;
  const length = pathLength(points);
  if (length < 24) return null;
  const R = resample(points, 64);
  const start = R[0], end = R[R.length - 1];
  const chord = dist(start, end);

  // 1) Línea recta: el trazo no se aleja del segmento entre sus extremos ni vuelve hacia atrás.
  //    (No se usa la longitud del trazo: el temblor de la mano la alarga mucho con un lápiz de alta frecuencia.)
  if (chord > 30 && isStraight(R, start, end, chord)) {
    const ang = snapAngle(Math.atan2(end[1] - start[1], end[0] - start[0]), 45, 5);
    return { kind: 'line', closed: false, points: [start, [start[0] + Math.cos(ang) * chord, start[1] + Math.sin(ang) * chord]] };
  }

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of R) {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  const size = Math.hypot(maxX - minX, maxY - minY);

  const closed = chord < Math.max(16, size * 0.22);
  if (closed) {
    if (size < 40) return null; // demasiado pequeño: probablemente es una letra
    // Se ajustan polígono y elipse y gana el que mejor encaja (un pentágono no es un círculo, ni al revés).
    const poly = closedPolygon(R, size);
    const e = fitEllipse(R);
    const ellipseOk = e && e.err < 0.09 && e.coverage > 1.7 * Math.PI;
    const ellipseErr = ellipseOk ? e.err * ((e.rx + e.ry) / 2) : Infinity;
    if (poly && poly.err < ellipseErr * 0.75) {
      const V = poly.V;
      if (V.length === 4) {
        const angles = V.map((_, i) => 180 - turn(V[(i - 1 + 4) % 4], V[i], V[(i + 1) % 4]));
        if (angles.every((a) => Math.abs(a - 90) < 22)) return { kind: 'rect', closed: true, points: fitRect(V, R) };
      }
      return { kind: V.length === 3 ? 'triangle' : 'polygon', closed: true, points: [...V, V[0]] };
    }
    if (ellipseOk) {
      const ratio = e.rx / e.ry;
      if (ratio > 0.85 && ratio < 1.18) {
        const r = (e.rx + e.ry) / 2;
        return { kind: 'circle', closed: true, points: ellipsePoints(e.cx, e.cy, r, r, 0) };
      }
      return { kind: 'ellipse', closed: true, points: ellipsePoints(e.cx, e.cy, e.rx, e.ry, snapAngle(e.th, 90, 10)) };
    }
    return null;
  }
  if (size < 28) return null;

  // 4) Línea quebrada abierta (ángulos, zigzag de 2–4 tramos)
  const eps = Math.max(5, size * 0.05);
  const V = rdp(R, eps);
  if (V.length >= 3 && V.length <= 5 && maxDeviation(R, V, false) <= eps * 1.4) {
    let sharp = true;
    for (let i = 1; i < V.length - 1; i++) if (turn(V[i - 1], V[i], V[i + 1]) < 25) sharp = false;
    if (sharp) return { kind: 'polyline', closed: false, points: V };
  }
  return null;
}

// Polígono cerrado de 3–6 vértices con esquinas marcadas; err = distancia media de los puntos a sus lados
function closedPolygon(R, size) {
  {
    const eps = Math.max(5, size * 0.07);
    let V = rdp(R, eps);
    if (V.length > 2 && dist(V[0], V[V.length - 1]) < eps * 2.5) V = V.slice(0, -1);
    for (let changed = true; changed && V.length > 3;) {
      changed = false;
      for (let i = 0; i < V.length; i++) {
        if (turn(V[(i - 1 + V.length) % V.length], V[i], V[(i + 1) % V.length]) < 28) {
          V.splice(i, 1); // el trazo empezó a mitad de un lado
          changed = true;
          break;
        }
      }
    }
    if (V.length < 3 || V.length > 6) return null;
    for (let i = 0; i < V.length; i++) if (turn(V[(i - 1 + V.length) % V.length], V[i], V[(i + 1) % V.length]) < 35) return null;
    const d = deviations(R, V, true);
    if (d.max > eps * 1.6) return null;
    return { V, err: d.mean };
  }
}
