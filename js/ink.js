(() => {
  "use strict";

  // 도구 막대(굿노트식) + 애플펜슬 손글씨 + 사진
  // - 펜슬은 항상 그리기, 손가락은 평소처럼 입력/버튼 (옵션으로 손가락 그리기)
  // - 그리다가 떼지 않고 꾹 누르고 있으면 직선 · 원 · 타원으로 반듯하게
  // - 지우개는 문지른 부분만 지운다
  // - 날짜별로 IndexedDB에 저장 (손글씨 · 사진은 용량이 커서 localStorage 대신)

  const P = window.Planner;
  const $ = (id) => document.getElementById(id);
  const NS = "http://www.w3.org/2000/svg";
  const W = 1754, H = 1240;

  const GRAYS = ["#4a4a4a", "#8c8c8c", "#c9c9c5"];
  const PASTELS = ["#f6e7a6", "#f5cfc9", "#f8d9b5", "#cfe7d3", "#cbe0ec", "#dbd3ee", "#f0d3e2"];
  const COLORS = [...GRAYS, ...PASTELS];
  const SIZE_RANGE = { pen: [1, 30], hl: [6, 60], eraser: [6, 90] };
  const HOLD_MS = 500;   // 이만큼 멈춰 있으면 모양 다듬기
  const STILL_R = 10;    // 이 반경(캔버스 px) 안의 떨림은 멈춘 것으로
  const PREF_KEY = "shplanner.tools";

  const svg = $("ink");
  const canvas = $("canvas");
  const photosEl = $("photos");

  // ---------- 설정 ----------
  let pref = {
    tool: "pen",
    color: { pen: GRAYS[0], hl: PASTELS[0] },
    size: { pen: 5, hl: 22, eraser: 24 },
    custom: "#e8c9a8",
    finger: false,
    scribble: false, // 펜슬 글자 입력(Scribble). 꺼져 있으면 입력칸 위에서도 펜슬은 그리기만
    dock: "top", x: null, y: null,
  };
  try {
    const s = JSON.parse(localStorage.getItem(PREF_KEY) || "{}");
    pref = { ...pref, ...s, color: { ...pref.color, ...(s.color || {}) }, size: { ...pref.size, ...(s.size || {}) } };
  } catch (e) { /* 무시 */ }
  const savePref = () => { try { localStorage.setItem(PREF_KEY, JSON.stringify(pref)); } catch (e) { /* 무시 */ } };

  // 색은 하나: 막대에서 고른 색이 펜 · 형광펜 · 칸 채우기(요일 · 기분 · 날씨 · 시간표)에 그대로 쓰인다
  if (pref.color.hl !== pref.color.pen) pref.color.hl = pref.color.pen = pref.color[pref.tool === "hl" ? "hl" : "pen"];
  function fillColor() {
    if (pref.tool === "eraser") return null;
    return pref.color.pen;
  }

  // ---------- IndexedDB ----------
  const dbp = new Promise((res, rej) => {
    try {
      const r = indexedDB.open("shplanner-ink", 1);
      r.onupgradeneeded = () => r.result.createObjectStore("days");
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    } catch (e) { rej(e); }
  });
  const memory = new Map(); // IndexedDB를 못 쓰는 환경 대비
  function tx(mode, fn) {
    return dbp.then((db) => new Promise((res, rej) => {
      const t = db.transaction("days", mode);
      const out = fn(t.objectStore("days"));
      t.oncomplete = () => res(out && out.result);
      t.onerror = () => rej(t.error);
    }));
  }
  const isEmptyPage = (v) => !v || ((v.strokes || []).length === 0 && (v.images || []).length === 0);
  const idbGet = (k) => tx("readonly", (s) => s.get(k)).catch(() => memory.get(k));
  const idbPut = (k, v) => (isEmptyPage(v) ? tx("readwrite", (s) => s.delete(k)) : tx("readwrite", (s) => s.put(v, k)))
    .catch(() => { isEmptyPage(v) ? memory.delete(k) : memory.set(k, v); });
  // 예전 형식(획 배열만 저장)도 읽는다
  const normalize = (v) => Array.isArray(v) ? { strokes: v, images: [] } : { strokes: v?.strokes || [], images: v?.images || [] };

  // ---------- 획 그리기 ----------
  let getStroke = null; // perfect-freehand (필압 반영 붓질). 못 불러오면 일반 선으로
  import("https://cdn.jsdelivr.net/npm/perfect-freehand@1.2.3/+esm")
    .then((m) => { getStroke = m.getStroke; renderStrokes(); })
    .catch(() => {});

  function outlinePath(pts) {
    if (!pts.length) return "";
    const d = pts.reduce((acc, [x0, y0], i, arr) => {
      const [x1, y1] = arr[(i + 1) % arr.length];
      acc.push(x0.toFixed(1), y0.toFixed(1), ((x0 + x1) / 2).toFixed(1), ((y0 + y1) / 2).toFixed(1));
      return acc;
    }, ["M", pts[0][0].toFixed(1), pts[0][1].toFixed(1), "Q"]);
    d.push("Z");
    return d.join(" ");
  }
  function linePath(p) {
    if (p.length < 3) return "";
    let d = `M${p[0]} ${p[1]}`;
    if (p.length === 3) return d + ` L${p[0] + 0.1} ${p[1]}`;
    for (let i = 3; i < p.length; i += 3) d += ` L${p[i]} ${p[i + 1]}`;
    return d;
  }
  const triples = (p) => { const o = []; for (let i = 0; i < p.length; i += 3) o.push([p[i], p[i + 1], p[i + 2]]); return o; };

  function drawStroke(s, el, done = true) {
    el = el || document.createElementNS(NS, "path");
    if (s.t === "hl") {
      el.setAttribute("d", linePath(s.p));
      el.setAttribute("class", "hlr");
      el.setAttribute("fill", "none");
      el.setAttribute("stroke", s.c);
      el.setAttribute("stroke-width", s.w);
      el.setAttribute("stroke-linecap", "round");
      el.setAttribute("stroke-linejoin", "round");
    } else if (getStroke) {
      const outline = getStroke(triples(s.p), {
        size: s.w, thinning: s.even ? 0 : 0.55, smoothing: 0.5, streamline: s.even ? 0 : 0.45,
        simulatePressure: !!s.sim && !s.even, last: done,
      });
      el.setAttribute("d", outlinePath(outline));
      el.setAttribute("fill", s.c);
      el.removeAttribute("stroke");
      el.removeAttribute("class");
    } else {
      el.setAttribute("d", linePath(s.p));
      el.setAttribute("fill", "none");
      el.setAttribute("stroke", s.c);
      el.setAttribute("stroke-width", s.w * 0.8);
      el.setAttribute("stroke-linecap", "round");
      el.setAttribute("stroke-linejoin", "round");
    }
    return el;
  }

  // 빠르게 그어 점 사이가 벌어진 곳을 촘촘하게 (부분 지우개가 정확히 먹도록)
  function densify(p, step = 3) {
    const out = [p[0], p[1], p[2]];
    for (let i = 3; i < p.length; i += 3) {
      const [x0, y0, r0] = [out[out.length - 3], out[out.length - 2], out[out.length - 1]];
      const [x1, y1, r1] = [p[i], p[i + 1], p[i + 2]];
      const n = Math.floor(Math.hypot(x1 - x0, y1 - y0) / step);
      for (let k = 1; k < n; k++) {
        const t = k / n;
        out.push(+(x0 + (x1 - x0) * t).toFixed(1), +(y0 + (y1 - y0) * t).toFixed(1), +(r0 + (r1 - r0) * t).toFixed(2));
      }
      out.push(x1, y1, r1);
    }
    return out;
  }

  // ---------- 모양 다듬기 (그리다가 떼지 않고 꾹 누르기) ----------
  // 직선 · 꺾은선 · 원 · 타원 · 세모 · 네모(정사각형 · 직사각형) · 오각형 · 육각형 · 별 …
  // 그린 모양과 가장 비슷한 반듯한 도형으로 바꾼다.
  const D = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  function segDist(p, a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
    const t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
    return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
  }
  // 꼭짓점 뽑기 (Ramer–Douglas–Peucker)
  function rdp(pts, eps) {
    const keep = new Array(pts.length).fill(false);
    keep[0] = keep[pts.length - 1] = true;
    const stack = [[0, pts.length - 1]];
    while (stack.length) {
      const [s, e] = stack.pop();
      let idx = -1, max = 0;
      for (let i = s + 1; i < e; i++) { const d = segDist(pts[i], pts[s], pts[e]); if (d > max) { max = d; idx = i; } }
      if (max > eps && idx > 0) { keep[idx] = true; stack.push([s, idx], [idx, e]); }
    }
    return pts.filter((_, i) => keep[i]);
  }
  // 꼭짓점에서 두 변이 이루는 각 (도). 180에 가까우면 거의 일직선
  function cornerAngle(prev, v, next) {
    const a = [prev[0] - v[0], prev[1] - v[1]], b = [next[0] - v[0], next[1] - v[1]];
    const c = (a[0] * b[0] + a[1] * b[1]) / ((Math.hypot(...a) * Math.hypot(...b)) || 1);
    return (Math.acos(Math.max(-1, Math.min(1, c))) * 180) / Math.PI;
  }
  // 거의 일직선인 꼭짓점 · 너무 가까운 꼭짓점 정리
  function cleanVerts(V, closed, minEdge) {
    let changed = true;
    while (changed && V.length > (closed ? 3 : 2)) {
      changed = false;
      const n = V.length;
      for (let i = closed ? 0 : 1; i < (closed ? n : n - 1); i++) {
        const prev = V[(i - 1 + n) % n], next = V[(i + 1) % n];
        if (cornerAngle(prev, V[i], next) > 148 || D(V[i], next) < minEdge && (closed || i < n - 2)) {
          V = V.filter((_, j) => j !== i); changed = true; break;
        }
      }
    }
    return V;
  }
  // 진짜 모서리인지: 꼭짓점 앞뒤 아주 짧은 구간(w)에서 방향이 확 꺾였으면 모서리, 서서히 휘었으면 곡선
  function isRealCorner(pts, idx, w, closed, vertexTurn, need = 0.45) {
    const n = pts.length;
    const walk = (dir) => {
      let d = 0, i = idx;
      for (let step = 0; step < n; step++) {
        const j = i + dir;
        if (!closed && (j < 0 || j >= n)) return pts[i];
        const jj = (j + n) % n;
        d += D(pts[i], pts[jj]);
        i = jj;
        if (d >= w) return pts[i];
      }
      return pts[i];
    };
    const a = walk(-1), b = walk(1), v = pts[idx];
    const localTurn = 180 - cornerAngle(a, v, b);
    return vertexTurn > 25 && localTurn >= vertexTurn * need;
  }
  // 꼭짓점의 3/4 이상이 뚜렷한 모서리면 다각형으로 본다 (원을 여러 각으로 잘못 보지 않게)
  function allCorners(pts, V, closed, w) {
    const n = V.length;
    let total = 0, sharp = 0;
    for (let i = closed ? 0 : 1; i < (closed ? n : n - 1); i++) {
      const turn = 180 - cornerAngle(V[(i - 1 + n) % n], V[i], V[(i + 1) % n]);
      total++;
      if (isRealCorner(pts, pts.indexOf(V[i]), w, closed, turn, closed ? 0.45 : 0.6)) sharp++;
    }
    return total > 0 && sharp / total >= (closed ? 0.75 : 1);
  }
  // 그린 점들이 다각형 변에서 평균 얼마나 떨어졌는지 (평균 변 길이 대비)
  function edgeError(pts, V, closed) {
    const edges = [];
    for (let i = 0; i < V.length - (closed ? 0 : 1); i++) edges.push([V[i], V[(i + 1) % V.length]]);
    const avgEdge = edges.reduce((a, [p, q]) => a + D(p, q), 0) / edges.length;
    const mean = pts.reduce((a, p) => a + Math.min(...edges.map(([q, r]) => segDist(p, q, r))), 0) / pts.length;
    return mean / (avgEdge || 1);
  }
  function fitEllipse(pts) {
    const n = pts.length;
    const mx = pts.reduce((a, q) => a + q[0], 0) / n, my = pts.reduce((a, q) => a + q[1], 0) / n;
    let sxx = 0, syy = 0, sxy = 0;
    pts.forEach(([x, y]) => { sxx += (x - mx) ** 2; syy += (y - my) ** 2; sxy += (x - mx) * (y - my); });
    const th = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    const c = Math.cos(th), s = Math.sin(th);
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    pts.forEach(([x, y]) => {
      const u = (x - mx) * c + (y - my) * s, v = -(x - mx) * s + (y - my) * c;
      u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
    });
    const a = (u1 - u0) / 2 || 1, b = (v1 - v0) / 2 || 1;
    const cu = (u0 + u1) / 2, cv = (v0 + v1) / 2;
    const cx = mx + cu * c - cv * s, cy = my + cu * s + cv * c;
    const err = pts.reduce((acc, [x, y]) => {
      const u = (x - cx) * c + (y - cy) * s, v = -(x - cx) * s + (y - cy) * c;
      return acc + Math.abs(Math.hypot(u / a, v / b) - 1);
    }, 0) / n;
    return { cx, cy, a, b, th, err };
  }
  function ellipsePoints(e, from) {
    let { a, b, th: rot } = e;
    if (Math.min(a, b) / Math.max(a, b) > 0.82) { a = b = (a + b) / 2; rot = 0; }
    const per = Math.PI * (3 * (a + b) - Math.sqrt((3 * a + b) * (a + 3 * b)));
    const steps = Math.max(64, Math.round(per / 3));
    const start = Math.atan2(-(from[0] - e.cx) * Math.sin(rot) + (from[1] - e.cy) * Math.cos(rot),
                             (from[0] - e.cx) * Math.cos(rot) + (from[1] - e.cy) * Math.sin(rot));
    const out = [];
    for (let i = 0; i <= steps; i++) {
      const t = start + (i / steps) * Math.PI * 2, u = a * Math.cos(t), v = b * Math.sin(t);
      out.push([e.cx + u * Math.cos(rot) - v * Math.sin(rot), e.cy + u * Math.sin(rot) + v * Math.cos(rot)]);
    }
    return out;
  }
  const centroid = (P) => [P.reduce((a, p) => a + p[0], 0) / P.length, P.reduce((a, p) => a + p[1], 0) / P.length];
  // 위쪽(12시)에 가장 가까운 방향을 회전 기준으로
  function topAngle(C, candidates) {
    let best = null, bestD = Infinity;
    for (const p of candidates) {
      const ang = Math.atan2(p[1] - C[1], p[0] - C[0]);
      const d = Math.abs(Math.atan2(Math.sin(ang + Math.PI / 2), Math.cos(ang + Math.PI / 2)));
      if (d < bestD) { bestD = d; best = ang; }
    }
    return best;
  }
  function regularPolygon(C, R, n, start) {
    return Array.from({ length: n }, (_, i) => [C[0] + R * Math.cos(start + (i * 2 * Math.PI) / n), C[1] + R * Math.sin(start + (i * 2 * Math.PI) / n)]);
  }

  // 별: 중심에서의 거리가 길어졌다 짧아졌다를 5번 이상 되풀이하면
  function detectStar(pts) {
    const C = centroid(pts);
    const r = pts.map((p) => D(p, C));
    const n = r.length, w = Math.max(1, Math.round(n / 60));
    const sm = r.map((_, i) => { let s = 0; for (let k = -w; k <= w; k++) s += r[(i + k + n) % n]; return s / (2 * w + 1); });
    const maxR = Math.max(...sm), minR = Math.min(...sm);
    if (minR / maxR > 0.65) return null;
    const thr = minR + (maxR - minR) * 0.55;
    // 문턱보다 바깥에 있는 구간(뿔)을 센다
    const runs = [];
    let start = sm.findIndex((v) => v < thr);
    if (start < 0) return null;
    let cur = null;
    for (let k = 1; k <= n; k++) {
      const i = (start + k) % n;
      if (sm[i] >= thr) { if (!cur) cur = { best: i }; else if (sm[i] > sm[cur.best]) cur.best = i; }
      else if (cur) { runs.push(cur); cur = null; }
    }
    if (cur) runs.push(cur);
    const m = runs.length;
    if (m < 5 || m > 8) return null;
    const tips = runs.map((q) => pts[q.best]);
    const outer = tips.reduce((a, p) => a + D(p, C), 0) / m;
    const ratio = Math.max(0.34, Math.min(0.6, minR / maxR * 1.05));
    const start0 = topAngle(C, tips);
    const out = [];
    for (let i = 0; i < 2 * m; i++) {
      const R = i % 2 ? outer * ratio : outer;
      const ang = start0 + (i * Math.PI) / m;
      out.push([C[0] + R * Math.cos(ang), C[1] + R * Math.sin(ang)]);
    }
    return { kind: "star", pts: out.concat([out[0]]) };
  }

  // 닫힌 다각형을 가장 가까운 반듯한 도형으로
  function regularize(V) {
    const n = V.length, C = centroid(V);
    const sides = V.map((p, i) => D(p, V[(i + 1) % n]));
    const angles = V.map((p, i) => cornerAngle(V[(i - 1 + n) % n], p, V[(i + 1) % n]));
    const sideSpread = Math.max(...sides) / Math.min(...sides);
    const close = (P) => P.concat([P[0]]);

    if (n === 4 && angles.every((a) => Math.abs(a - 90) < 18)) {
      // 직사각형 · 정사각형: 변 방향의 평균(90도 주기)으로 기울기를 정하고, 거의 수평이면 반듯하게
      let sx = 0, sy = 0;
      V.forEach((p, i) => { const q = V[(i + 1) % n]; const a4 = 4 * Math.atan2(q[1] - p[1], q[0] - p[0]); sx += Math.cos(a4); sy += Math.sin(a4); });
      let th = Math.atan2(sy, sx) / 4;
      if (Math.abs(th) < (8 * Math.PI) / 180) th = 0;
      const c = Math.cos(th), s = Math.sin(th);
      let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
      V.forEach(([x, y]) => { const u = x * c + y * s, v = -x * s + y * c; u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v); });
      // 네 꼭짓점의 평균 위치로 (바깥 극값보다 손 모양에 가깝게)
      let hw = (u1 - u0) / 2, hh = (v1 - v0) / 2;
      const cu = (u0 + u1) / 2, cv = (v0 + v1) / 2;
      if (Math.abs(hw - hh) / Math.max(hw, hh) < 0.12) hw = hh = (hw + hh) / 2; // 정사각형
      const rect = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([u, v]) => [(cu + u) * c - (cv + v) * s, (cu + u) * s + (cv + v) * c]);
      return { kind: hw === hh ? "square" : "rectangle", pts: close(rect) };
    }
    const tol = n === 3 ? 18 : 22, spread = n === 3 ? 1.25 : 1.4;
    if (n >= 3 && n <= 8 && sideSpread < spread && angles.every((a) => Math.abs(a - (180 * (n - 2)) / n) < tol)) {
      // 정삼각형 · 정사각형(마름모) · 정오각형 · 정육각형 …
      const R = V.reduce((a, p) => a + D(p, C), 0) / n;
      return { kind: "regular" + n, pts: close(regularPolygon(C, R, n, topAngle(C, V))) };
    }
    return { kind: "polygon" + n, pts: close(V) }; // 모양은 그대로, 변만 곧게
  }

  function recognize(p) {
    const raw = [];
    for (let i = 0; i < p.length; i += 3) raw.push([p[i], p[i + 1]]);
    if (raw.length < 4) return null;
    // 끝에서 꾹 누르고 있는 동안 손 떨림으로 생긴 점들은 빼고 판단한다
    const last = raw[raw.length - 1];
    let k = raw.length - 1;
    while (k > 1 && D(raw[k - 1], last) < 10) k--;
    const trimmed = raw.slice(0, k).concat([last]);
    if (trimmed.length < 2) return null;
    // 잔떨림을 살짝 걸러낸 선으로 판단 (앞뒤 2점 평균, 양 끝은 그대로)
    const pts = trimmed.map((q, i) => {
      if (i < 2 || i > trimmed.length - 3) return q;
      let sx = 0, sy = 0;
      for (let j = i - 2; j <= i + 2; j++) { sx += trimmed[j][0]; sy += trimmed[j][1]; }
      return [sx / 5, sy / 5];
    });
    let len = 0, minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    pts.forEach(([x, y], i) => {
      if (i) len += D(pts[i], pts[i - 1]);
      minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    });
    const diag = Math.hypot(maxX - minX, maxY - minY);
    if (diag < 12) return null;
    const first = pts[0], end = pts[pts.length - 1];
    const gap = D(first, end);

    // 1) 직선: 시작점-끝점 선에서 가장 멀리 벗어난 거리가 작으면 (약간 삐뚤한 선도 OK)
    if (gap > 20) {
      const maxDev = Math.max(...pts.map((q) => segDist(q, first, end)));
      if (maxDev <= Math.max(10, gap * 0.1) && len < gap * 1.4) return { kind: "line", pts: [first, end] };
    }

    const eps = Math.max(8, diag * 0.06);
    const cornerW = Math.max(10, diag * 0.07);
    const closed = gap < diag * 0.3 && len > diag * 1.6;

    if (closed) {
      // 2) 별
      const star = detectStar(pts);
      if (star) return star;
      // 3) 다각형 (변이 곧고 모서리가 뚜렷하면)
      let V = rdp(pts, eps);
      if (D(V[0], V[V.length - 1]) < diag * 0.3) V = V.slice(0, -1);
      V = cleanVerts(V, true, diag * 0.08);
      if (V.length >= 3 && V.length <= 8) {
        const err = edgeError(pts, V, true);
        if (err < 0.05 && allCorners(pts, V, true, cornerW)) return regularize(V);
      }
      // 4) 원 · 타원
      const e = fitEllipse(pts);
      if (e.err < 0.28) return { kind: "ellipse", pts: ellipsePoints(e, first) };
      return null;
    }

    // 5) 꺾은선 (ㄱ, ㄴ, V, 번개 모양 등): 꺾이는 곳이 뚜렷하고 사이가 곧으면
    let V = cleanVerts(rdp(pts, eps), false, diag * 0.08);
    if (V.length >= 3 && V.length <= 7 && edgeError(pts, V, false) < 0.05 && allCorners(pts, V, false, cornerW)) return { kind: "polyline", pts: V };
    return null;
  }

  function snapActive() {
    const a = active;
    if (!a || a.erase || a.snapped) return;
    const shape = recognize(a.s.p);
    if (!shape) return;
    const flat = [];
    shape.pts.forEach(([x, y]) => flat.push(+x.toFixed(1), +y.toFixed(1), 0.5));
    a.s.p = densify(flat);
    a.s.even = true; // 일정한 굵기
    a.snapped = true;
    a.shape = shape.kind;
    drawStroke(a.s, a.el, true);
    a.el.dataset.shape = shape.kind;
    a.el.classList.add("snapped");
    setTimeout(() => a.el.classList.remove("snapped"), 300);
  }

  // 꾹 누르기 감지: 최근 HOLD_MS 동안 펜 끝이 작은 원(STILL_R) 안에 머물렀으면
  function checkHold() {
    const a = active;
    if (!a || a.erase || a.snapped) return;
    const now = performance.now();
    if (now - a.tStart < HOLD_MS) return;
    const p = a.s.p, ts = a.ts, n = ts.length;
    if (n < 4) return;
    const lx = p[p.length - 3], ly = p[p.length - 2];
    for (let i = n - 1; i >= 0; i--) {
      if (Math.hypot(p[i * 3] - lx, p[i * 3 + 1] - ly) > STILL_R) {
        if (ts[i] > now - HOLD_MS) return; // 최근에 움직였음
        break;
      }
    }
    snapActive();
  }

  // ---------- 날짜별 데이터 ----------
  let dayKey = null, strokes = [], els = [], images = [];
  let undo = [], redo = [], loadToken = 0, saveTimer = null;

  function renderStrokes() {
    svg.replaceChildren();
    els = strokes.map((s) => { const el = drawStroke(s); svg.appendChild(el); return el; });
  }
  const page = () => ({ strokes: strokes.slice(), images: images.map((o) => ({ ...o })) });
  function scheduleSave() {
    clearTimeout(saveTimer);
    const k = dayKey, data = page();
    saveTimer = setTimeout(() => { saveTimer = null; idbPut(k, data); }, 400);
  }
  function flush() {
    if (!saveTimer) return;
    clearTimeout(saveTimer); saveTimer = null;
    idbPut(dayKey, page());
  }

  async function setDay(k) {
    if (k === dayKey) return;
    flush();
    dayKey = k;
    strokes = []; images = []; undo = []; redo = [];
    selectPhoto(null);
    renderStrokes(); renderPhotos();
    const token = ++loadToken;
    const data = normalize(await idbGet(k));
    if (token !== loadToken) return;
    strokes = data.strokes; images = data.images;
    renderStrokes(); renderPhotos();
    updateButtons();
  }

  // 되돌리기: 바꾸기 전 모습을 통째로 기억
  function remember() {
    undo.push(page());
    if (undo.length > 80) undo.shift();
    redo = [];
    updateButtons();
  }
  function restore(from, to) {
    const snap = from.pop();
    if (!snap) return;
    to.push(page());
    strokes = snap.strokes; images = snap.images;
    renderStrokes(); renderPhotos(); scheduleSave(); updateButtons();
  }

  // ---------- 입력 ----------
  const isField = (el) => el && el.matches && el.matches("#canvas input[type='text'], #canvas textarea");
  function wantsPointer(e) {
    if (e.target.closest && e.target.closest(".no-ink, dialog, .photo.sel")) return false;
    // 펜슬 글자 입력을 켠 상태에서는 입력칸 위의 펜슬을 아이패드(Scribble)에 넘긴다
    if (pref.scribble && e.pointerType === "pen" && isField(e.target)) return false;
    if (e.pointerType === "pen") return true;
    return pref.finger;
  }

  // ---------- 펜슬 글자 입력(Scribble) 끄기 ----------
  // Scribble은 편집 가능한 칸에서만 켜지므로, 입력칸을 평소엔 '읽기 전용'으로 잠가 두고
  // 손가락 · 마우스로 누를 때만 풀어 키보드 입력을 받는다. 칸을 벗어나면 다시 잠근다.
  function lockFields() {
    canvas.querySelectorAll("input[type='text'], textarea").forEach((el) => {
      if (document.activeElement !== el) el.readOnly = !pref.scribble;
    });
  }
  canvas.addEventListener("pointerdown", (e) => {
    if (e.pointerType !== "pen" && isField(e.target) && !pref.finger) e.target.readOnly = false;
  }, true);
  // 엔터로 다음 칸에 넘어가는 등 키보드로 들어온 경우에도 입력되도록
  canvas.addEventListener("focusin", (e) => { if (isField(e.target)) e.target.readOnly = false; });
  canvas.addEventListener("focusout", (e) => { if (isField(e.target) && !pref.scribble) e.target.readOnly = true; });
  // 공부 목록은 날짜를 바꿀 때마다 새로 그려지므로 새 칸도 잠근다
  new MutationObserver(lockFields).observe($("tasks"), { childList: true });
  function toCanvas(e) {
    const r = canvas.getBoundingClientRect();
    const s = r.width / W;
    return [+((e.clientX - r.left) / s).toFixed(1), +((e.clientY - r.top) / s).toFixed(1)];
  }

  let active = null, lastUp = 0, holdTimer = null;

  canvas.addEventListener("pointerdown", (e) => {
    if (active || !wantsPointer(e)) return;
    e.preventDefault();
    e.stopPropagation();
    selectPhoto(null);
    if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
    lockFields(); // 펜슬이 닿으면 입력칸을 다시 잠가 글자 변환이 끼어들지 않게
    try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* 캡처 불가 환경 */ }
    const [x, y] = toCanvas(e);
    if (pref.tool === "eraser") {
      remember();
      active = { id: e.pointerId, erase: true, changed: false, last: [x, y] };
      eraseSeg(x, y, x, y);
      return;
    }
    const hasPressure = e.pointerType === "pen" && e.pressure > 0;
    const s = { t: pref.tool, c: pref.color[pref.tool], w: pref.size[pref.tool], sim: !hasPressure,
                p: [x, y, hasPressure ? +e.pressure.toFixed(2) : 0.5] };
    const el = drawStroke(s, null, false);
    svg.appendChild(el);
    active = { id: e.pointerId, s, el, t0: Date.now(), target: e.target, tStart: performance.now(), ts: [performance.now()] };
    clearInterval(holdTimer);
    holdTimer = setInterval(checkHold, 80);
  }, true);

  canvas.addEventListener("pointermove", (e) => {
    if (!active || e.pointerId !== active.id) return;
    e.preventDefault();
    const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
    for (const ev of (evs.length ? evs : [e])) {
      const [x, y] = toCanvas(ev);
      if (active.erase) { eraseSeg(active.last[0], active.last[1], x, y); active.last = [x, y]; continue; }
      if (active.snapped) continue;
      const p = active.s.p;
      if (Math.abs(x - p[p.length - 3]) + Math.abs(y - p[p.length - 2]) < 0.8) continue;
      p.push(x, y, active.s.sim ? 0.5 : +(ev.pressure || 0.5).toFixed(2));
      active.ts.push(performance.now());
    }
    if (!active.erase && !active.snapped) drawStroke(active.s, active.el, false);
  }, true);

  // 펜슬로 버튼을 톡 누른 경우는 그리기 대신 누르기 (입력칸 위의 짧은 점은 손글씨로 남김)
  function tapTarget(a) {
    if (a.erase || a.snapped || Date.now() - a.t0 > 350) return null;
    const p = a.s.p;
    for (let i = 3; i < p.length; i += 3) if (Math.hypot(p[i] - p[0], p[i + 1] - p[1]) > 6) return null;
    return a.target.closest && a.target.closest("button, .tt-c");
  }

  function endStroke(e) {
    if (!active || e.pointerId !== active.id) return;
    e.preventDefault();
    clearInterval(holdTimer);
    lastUp = Date.now();
    const a = active;
    active = null;
    if (a.erase) {
      if (a.changed) scheduleSave(); else undo.pop();
      updateButtons();
      return;
    }
    const target = tapTarget(a);
    if (target) {
      a.el.remove(); lastUp = 0;
      if (target.classList.contains("tt-c")) P.tapCell(+target.dataset.slot); else target.click();
      return;
    }
    if (!a.snapped) a.s.p = densify(a.s.p);
    drawStroke(a.s, a.el, true);
    remember();
    strokes.push(a.s);
    els.push(a.el);
    scheduleSave();
    updateButtons();
  }
  canvas.addEventListener("pointerup", endStroke, true);
  canvas.addEventListener("pointercancel", endStroke, true);

  // 펜으로 그린 직후 생기는 클릭 막기
  canvas.addEventListener("click", (e) => {
    if (Date.now() - lastUp < 350) { e.preventDefault(); e.stopPropagation(); }
  }, true);
  // 아이패드 Scribble(손글씨 → 글자 변환)이 입력칸에서 끼어들지 않게
  canvas.addEventListener("touchstart", (e) => {
    const stylus = [...e.changedTouches].some((t) => t.touchType === "stylus");
    if (stylus && pref.scribble && isField(e.target)) return; // 펜슬 글자 입력 켜짐: 아이패드에 맡김
    if (stylus || (pref.finger && !e.target.closest(".no-ink, .photo.sel"))) e.preventDefault();
  }, { passive: false, capture: true });
  canvas.addEventListener("touchmove", (e) => {
    const stylus = [...e.changedTouches].some((t) => t.touchType === "stylus");
    if (active || (stylus && !pref.scribble)) e.preventDefault();
  }, { passive: false, capture: true });

  // ---------- 부분 지우개 ----------
  // 지우개가 지나간 선분 근처의 점을 빼고, 남은 부분을 여러 획으로 나눈다
  function distToSeg(px, py, x0, y0, x1, y1) {
    const dx = x1 - x0, dy = y1 - y0, l2 = dx * dx + dy * dy;
    const t = l2 ? Math.max(0, Math.min(1, ((px - x0) * dx + (py - y0) * dy) / l2)) : 0;
    return Math.hypot(px - (x0 + t * dx), py - (y0 + t * dy));
  }
  function eraseSeg(x0, y0, x1, y1) {
    const r = pref.size.eraser / 2;
    P.eraseFillAt(x1, y1, r); // 시간표 · 요일 칸 색도 함께 지움
    const minX = Math.min(x0, x1) - r - 40, maxX = Math.max(x0, x1) + r + 40;
    const minY = Math.min(y0, y1) - r - 40, maxY = Math.max(y0, y1) + r + 40;
    for (let i = strokes.length - 1; i >= 0; i--) {
      const s = strokes[i], p = s.p, lim = r + s.w * 0.35;
      let hit = false;
      const keep = [];
      for (let j = 0; j < p.length; j += 3) {
        const inBox = p[j] > minX && p[j] < maxX && p[j + 1] > minY && p[j + 1] < maxY;
        const gone = inBox && distToSeg(p[j], p[j + 1], x0, y0, x1, y1) <= lim;
        keep.push(!gone);
        if (gone) hit = true;
      }
      if (!hit) continue;
      const pieces = [];
      let cur = null;
      keep.forEach((k, idx) => {
        if (k) { (cur = cur || []).push(p[idx * 3], p[idx * 3 + 1], p[idx * 3 + 2]); }
        else if (cur) { pieces.push(cur); cur = null; }
      });
      if (cur) pieces.push(cur);
      const next = pieces.filter((q) => q.length >= 6).map((q) => ({ ...s, p: q }));
      const nextEls = next.map((ns) => drawStroke(ns));
      const anchor = els[i].nextSibling;
      els[i].remove();
      nextEls.forEach((el) => svg.insertBefore(el, anchor));
      strokes.splice(i, 1, ...next);
      els.splice(i, 1, ...nextEls);
      active.changed = true;
    }
  }

  // ---------- 사진 ----------
  let selected = null, drag = null;

  function renderPhotos() {
    photosEl.innerHTML = images.map((o) => `
      <div class="photo${o.id === selected ? " sel" : ""}" data-id="${o.id}" style="left:${o.x}px;top:${o.y}px;width:${o.w}px;height:${o.h}px">
        <img src="${o.src}" alt="" draggable="false" />
        <button class="ph-del no-ink" data-act="del" aria-label="사진 삭제">✕</button>
        <span class="ph-handle no-ink" data-act="resize"></span>
      </div>`).join("");
  }
  function selectPhoto(id) {
    if (selected === id) return;
    selected = id;
    photosEl.querySelectorAll(".photo").forEach((el) => el.classList.toggle("sel", el.dataset.id === id));
  }

  photosEl.addEventListener("pointerdown", (e) => {
    const el = e.target.closest(".photo");
    if (!el || e.pointerType === "pen" && !e.target.closest(".no-ink") && el.dataset.id !== selected) return;
    e.preventDefault();
    e.stopPropagation();
    const o = images.find((q) => q.id === el.dataset.id);
    if (!o) return;
    if (e.target.closest('[data-act="del"]')) {
      remember();
      images = images.filter((q) => q !== o);
      selected = null;
      renderPhotos(); scheduleSave();
      return;
    }
    selectPhoto(o.id);
    remember();
    const [x, y] = toCanvas(e);
    drag = { id: e.pointerId, o, el, mode: e.target.closest('[data-act="resize"]') ? "resize" : "move", x, y, ox: o.x, oy: o.y, ow: o.w, oh: o.h, moved: false };
    try { photosEl.setPointerCapture(e.pointerId); } catch (err) { /* 무시 */ }
  });
  photosEl.addEventListener("pointermove", (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const [x, y] = toCanvas(e);
    const dx = x - drag.x, dy = y - drag.y;
    const o = drag.o;
    if (Math.abs(dx) + Math.abs(dy) > 2) drag.moved = true;
    if (drag.mode === "move") {
      o.x = Math.round(Math.min(W - 40, Math.max(40 - o.w, drag.ox + dx)));
      o.y = Math.round(Math.min(H - 40, Math.max(40 - o.h, drag.oy + dy)));
    } else {
      const ratio = drag.oh / drag.ow;
      o.w = Math.round(Math.max(60, drag.ow + dx));
      o.h = Math.round(o.w * ratio);
    }
    Object.assign(drag.el.style, { left: o.x + "px", top: o.y + "px", width: o.w + "px", height: o.h + "px" });
  });
  const endDrag = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    if (drag.moved) scheduleSave(); else undo.pop();
    drag = null;
    updateButtons();
  };
  photosEl.addEventListener("pointerup", endDrag);
  photosEl.addEventListener("pointercancel", endDrag);
  // 사진 밖을 누르면 선택 해제
  document.addEventListener("pointerdown", (e) => {
    if (selected && !e.target.closest(".photo, #gbar")) selectPhoto(null);
  }, true);

  function addPhoto(file) {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        // 저장 용량을 줄이려고 긴 변 1400px로 줄여 JPEG로
        const max = 1400, k = Math.min(1, max / Math.max(img.width, img.height));
        const c = document.createElement("canvas");
        c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
        const g = c.getContext("2d");
        g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height);
        g.drawImage(img, 0, 0, c.width, c.height);
        const src = c.toDataURL("image/jpeg", 0.85);
        const w = 460, h = Math.round((w * c.height) / c.width);
        remember();
        const o = { id: Math.random().toString(36).slice(2, 10), src, x: Math.round(W / 2 - w / 2), y: Math.round(Math.max(90, H / 2 - h / 2)), w, h };
        images.push(o);
        selected = o.id;
        renderPhotos(); scheduleSave(); updateButtons();
        P.toast("사진을 끌어 옮기고, 오른쪽 아래 모서리로 크기를 바꿔요");
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  }

  // ---------- 도구 막대 ----------
  // 막대에는 최근 쓴 5색만, 전체 팔레트와 굵기 슬라이더는 팝업으로 (굿노트처럼 단정하게)
  const bar = $("gbar");
  if (!Array.isArray(pref.fav) || pref.fav.length !== 5) pref.fav = [GRAYS[0], GRAYS[1], PASTELS[0], PASTELS[1], PASTELS[4]];

  const curColor = () => pref.color.pen;
  function useColor(c) {
    if (pref.tool === "eraser") pref.tool = "pen";
    pref.color.pen = pref.color.hl = c;
    if (!pref.fav.includes(c)) pref.fav = [c, ...pref.fav].slice(0, 5);
    savePref(); renderBar();
  }

  function sizeLook(v) {
    const lineW = Math.max(1.5, Math.min(12, v * (pref.tool === "pen" ? 0.55 : 0.22)));
    const c = pref.tool === "eraser" ? "#d8d3cb" : pref.color.pen;
    const line = $("gbSizeLine");
    line.style.height = lineW + "px";
    line.style.background = c;
    $("gbSizeVal").textContent = v;
    $("gbSizeVal2").textContent = v;
    const pv = $("gbPreview");
    pv.setAttribute("stroke", c);
    pv.setAttribute("stroke-width", Math.max(1, Math.min(34, v * (pref.tool === "pen" ? 0.9 : 0.55))));
    pv.style.opacity = pref.tool === "hl" ? 0.85 : 1;
  }

  function renderBar() {
    bar.querySelectorAll("[data-tool]").forEach((b) => b.classList.toggle("on", b.dataset.tool === pref.tool));
    const sel = curColor();
    if (!pref.fav.includes(sel)) pref.fav = [sel, ...pref.fav].slice(0, 5);
    bar.style.setProperty("--tip", sel); // 펜 · 형광펜 그림의 촉 색 = 지금 색
    $("gbShow").style.setProperty("--tip", sel);
    $("gbColors").innerHTML = pref.fav.map((c) =>
      `<button class="${c === sel ? "on" : ""}" style="--c:${c}" data-c="${c}" aria-label="색 ${c}"></button>`).join("");
    $("gbColors").classList.toggle("off", pref.tool === "eraser");
    $("gbPalGrid").innerHTML = COLORS.map((c) =>
      `<button class="${c === sel ? "on" : ""}" style="--c:${c}" data-c="${c}" aria-label="색 ${c}"></button>`).join("");
    $("gbCustom").value = pref.custom;
    $("gbCustomDot").style.background = pref.custom;
    const [lo, hi] = SIZE_RANGE[pref.tool];
    const size = $("gbSize");
    size.min = lo; size.max = hi; size.value = pref.size[pref.tool];
    sizeLook(pref.size[pref.tool]);
    $("gbFinger").classList.toggle("on", !!pref.finger);
    $("gbFinger").setAttribute("aria-pressed", !!pref.finger);
    $("gbScribble").classList.toggle("on", !!pref.scribble);
    $("gbScribble").setAttribute("aria-pressed", !!pref.scribble);
    lockFields();
    updateButtons();
  }
  function updateButtons() {
    $("inkUndo").disabled = !undo.length;
    $("inkRedo").disabled = !redo.length;
    $("inkClear").disabled = !strokes.length && !images.length;
  }

  // 팝업 (막대 바로 아래, 막대가 아래에 붙어 있으면 위로)
  let openPop = null;
  function showPop(pop, anchor) {
    hidePop();
    pop.hidden = false;
    const a = anchor.getBoundingClientRect(), b = bar.getBoundingClientRect();
    const w = pop.offsetWidth, h = pop.offsetHeight;
    const left = Math.max(8, Math.min(innerWidth - w - 8, a.left + a.width / 2 - w / 2));
    const below = b.bottom + 10 + h < innerHeight;
    pop.style.left = left + "px";
    pop.style.top = (below ? b.bottom + 10 : b.top - h - 10) + "px";
    openPop = pop;
  }
  function hidePop() { if (openPop) { openPop.hidden = true; openPop = null; } }
  document.addEventListener("pointerdown", (e) => {
    if (openPop && !e.target.closest(".gb-pop, #gbPalBtn, #gbSizeChip")) hidePop();
  }, true);

  bar.addEventListener("click", (e) => {
    const t = e.target.closest("[data-tool]");
    if (t) { pref.tool = t.dataset.tool; savePref(); renderBar(); hidePop(); return; }
    const c = e.target.closest("button[data-c]");
    if (c) useColor(c.dataset.c);
  });
  $("gbPalBtn").addEventListener("click", () => (openPop === $("gbPalPop") ? hidePop() : showPop($("gbPalPop"), $("gbPalBtn"))));
  $("gbPalGrid").addEventListener("click", (e) => {
    const c = e.target.closest("button[data-c]");
    if (c) { useColor(c.dataset.c); hidePop(); }
  });
  $("gbCustom").addEventListener("input", (e) => {
    pref.custom = e.target.value;
    $("gbCustomDot").style.background = e.target.value;
    if (pref.tool === "eraser") pref.tool = "pen";
    pref.color.pen = pref.color.hl = e.target.value;
    sizeLook(pref.size[pref.tool]);
  });
  $("gbCustom").addEventListener("change", (e) => useColor(e.target.value));
  $("gbSize").addEventListener("input", (e) => { pref.size[pref.tool] = +e.target.value; sizeLook(+e.target.value); });
  $("gbSize").addEventListener("change", savePref);

  // 굵기 칩: 좌우로 끌면 숫자가 바뀌고, 톡 누르면 슬라이더 팝업
  const chip = $("gbSizeChip");
  let scrub = null;
  chip.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    scrub = { id: e.pointerId, x: e.clientX, v: pref.size[pref.tool], moved: false };
    try { chip.setPointerCapture(e.pointerId); } catch (err) { /* 무시 */ }
  });
  chip.addEventListener("pointermove", (e) => {
    if (!scrub || e.pointerId !== scrub.id) return;
    if (Math.abs(e.clientX - scrub.x) > 4) scrub.moved = true;
    if (!scrub.moved) return;
    const [lo, hi] = SIZE_RANGE[pref.tool];
    const v = Math.max(lo, Math.min(hi, Math.round(scrub.v + (e.clientX - scrub.x) / 5)));
    pref.size[pref.tool] = v;
    $("gbSize").value = v;
    sizeLook(v);
  });
  chip.addEventListener("pointerup", (e) => {
    if (!scrub || e.pointerId !== scrub.id) return;
    const tap = !scrub.moved;
    scrub = null;
    savePref();
    if (tap) (openPop === $("gbSizePop") ? hidePop() : showPop($("gbSizePop"), chip));
  });

  $("inkUndo").addEventListener("click", () => restore(undo, redo));
  $("inkRedo").addEventListener("click", () => restore(redo, undo));
  $("inkClear").addEventListener("click", async () => {
    if (!strokes.length && !images.length) return;
    if (!(await P.ask("모두 지우기", "이 날의 손글씨와 사진을 모두 지울까요? 지운 뒤에도 되돌리기로 살릴 수 있어요.", "지우기"))) return;
    remember();
    strokes = []; images = [];
    renderStrokes(); renderPhotos(); scheduleSave(); updateButtons();
  });
  $("gbPhoto").addEventListener("click", () => $("photoFile").click());
  $("photoFile").addEventListener("change", (e) => {
    const f = e.target.files[0];
    e.target.value = "";
    if (f) addPhoto(f);
  });
  $("gbScribble").addEventListener("click", () => {
    pref.scribble = !pref.scribble; savePref(); renderBar();
    P.toast(pref.scribble ? "펜슬 글자 입력 켜짐 · 입력칸에 펜슬로 쓰면 글자로 바뀌어요" : "펜슬 글자 입력 꺼짐 · 펜슬은 어디서나 그리기만 해요");
  });
  $("gbFinger").addEventListener("click", () => {
    pref.finger = !pref.finger; savePref(); renderBar();
    P.toast(pref.finger ? "손가락으로도 그려요 · 글자 입력은 이 버튼을 다시 끄고" : "손가락은 입력용, 그리기는 펜슬로");
  });

  // 도구 막대 옮기기: 위/아래 가장자리에 놓으면 붙고(플래너가 그만큼 비켜남), 그 밖에선 떠 있음
  function applyDock() {
    document.body.classList.toggle("gbar-top", pref.dock === "top");
    document.body.classList.toggle("gbar-bottom", pref.dock === "bottom");
    bar.dataset.dock = pref.dock;
    if (pref.dock === "float") {
      const x = Math.max(8, Math.min(innerWidth - bar.offsetWidth - 8, pref.x ?? 20));
      const y = Math.max(8, Math.min(innerHeight - bar.offsetHeight - 8, pref.y ?? 80));
      Object.assign(bar.style, { left: x + "px", top: y + "px", bottom: "", transform: "none" });
    } else {
      Object.assign(bar.style, { left: "", top: "", bottom: "", transform: "" });
    }
    window.dispatchEvent(new Event("resize"));
  }
  let move = null;
  $("gbGrip").addEventListener("pointerdown", (e) => {
    e.preventDefault();
    const r = bar.getBoundingClientRect();
    move = { id: e.pointerId, dx: e.clientX - r.left, dy: e.clientY - r.top };
    bar.classList.add("moving");
    Object.assign(bar.style, { left: r.left + "px", top: r.top + "px", bottom: "", transform: "none" });
    try { $("gbGrip").setPointerCapture(e.pointerId); } catch (err) { /* 무시 */ }
  });
  $("gbGrip").addEventListener("pointermove", (e) => {
    if (!move || e.pointerId !== move.id) return;
    const x = Math.max(4, Math.min(innerWidth - bar.offsetWidth - 4, e.clientX - move.dx));
    const y = Math.max(4, Math.min(innerHeight - bar.offsetHeight - 4, e.clientY - move.dy));
    bar.style.left = x + "px"; bar.style.top = y + "px";
    bar.classList.toggle("near-top", y < 40);
    bar.classList.toggle("near-bottom", y > innerHeight - bar.offsetHeight - 40);
  });
  $("gbGrip").addEventListener("pointerup", (e) => {
    if (!move || e.pointerId !== move.id) return;
    move = null;
    bar.classList.remove("moving", "near-top", "near-bottom");
    const r = bar.getBoundingClientRect();
    if (r.top < 40) pref.dock = "top";
    else if (r.bottom > innerHeight - 40) pref.dock = "bottom";
    else { pref.dock = "float"; pref.x = Math.round(r.left); pref.y = Math.round(r.top); }
    savePref();
    applyDock();
  });
  // 막대 높이가 바뀌면(두 줄로 접힘, 통계 화면에서 짧아짐 등) 화면이 그만큼 비켜나도록
  const syncBarHeight = () => {
    const h = (pref.hidden ? 0 : bar.offsetHeight + 16) + "px";
    if (document.body.style.getPropertyValue("--bar-h") !== h) { document.body.style.setProperty("--bar-h", h); window.dispatchEvent(new Event("resize")); }
  };
  if (window.ResizeObserver) new ResizeObserver(syncBarHeight).observe(bar);

  // 막대 숨기기 / 다시 보이기
  function applyHidden() {
    document.body.classList.toggle("gbar-hidden", !!pref.hidden);
    $("gbShow").hidden = !pref.hidden;
    $("gbShow").dataset.dock = pref.dock;
    hidePop();
    syncBarHeight();
    window.dispatchEvent(new Event("resize"));
  }
  $("gbHide").addEventListener("click", () => { pref.hidden = true; savePref(); applyHidden(); });
  $("gbShow").addEventListener("click", () => { pref.hidden = false; savePref(); applyHidden(); });

  window.addEventListener("resize", () => {
    syncBarHeight();
    if (pref.dock === "float" && !move) {
    const x = Math.max(8, Math.min(innerWidth - bar.offsetWidth - 8, pref.x ?? 20));
    const y = Math.max(8, Math.min(innerHeight - bar.offsetHeight - 8, pref.y ?? 80));
    bar.style.left = x + "px"; bar.style.top = y + "px";
  } });

  window.addEventListener("pagehide", flush);
  document.addEventListener("visibilitychange", () => { if (document.hidden) flush(); });

  // ---------- 백업 ----------
  async function exportAll() {
    flush();
    try {
      return await dbp.then((db) => new Promise((res, rej) => {
        const out = {};
        const t = db.transaction("days", "readonly");
        const req = t.objectStore("days").openCursor();
        req.onsuccess = () => { const c = req.result; if (c) { out[c.key] = c.value; c.continue(); } };
        t.oncomplete = () => res(out);
        t.onerror = () => rej(t.error);
      }));
    } catch (e) {
      return Object.fromEntries(memory);
    }
  }
  async function importAll(data) {
    for (const [k, v] of Object.entries(data || {})) await idbPut(k, normalize(v));
    const k = dayKey; dayKey = null; await setDay(k);
  }

  window.PlannerInk = { setDay, wantsPointer, exportAll, importAll, fillColor, get tool() { return pref.tool; } };
  renderBar();
  applyDock();
  applyHidden();
  setDay(P.cur);
})();