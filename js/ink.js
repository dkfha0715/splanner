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
  const HOLD_MS = 550;
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

  // ---------- 모양 다듬기 (꾹 누르기) ----------
  function recognize(p) {
    const pts = [];
    for (let i = 0; i < p.length; i += 3) pts.push([p[i], p[i + 1]]);
    if (pts.length < 4) return null;
    let len = 0, minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    pts.forEach(([x, y], i) => {
      if (i) len += Math.hypot(x - pts[i - 1][0], y - pts[i - 1][1]);
      minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    });
    const diag = Math.hypot(maxX - minX, maxY - minY);
    if (diag < 12) return null;
    const [sx, sy] = pts[0], [ex, ey] = pts[pts.length - 1];
    const gap = Math.hypot(ex - sx, ey - sy);

    // 직선
    if (gap / len > 0.88) return { kind: "line", pts: [[sx, sy], [ex, ey]] };

    // 닫힌 모양 → 원 / 타원 (주성분으로 기울기까지 맞춤)
    if (gap < diag * 0.3 && len > diag * 1.8) {
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
      let a = (u1 - u0) / 2, b = (v1 - v0) / 2;
      const cu = (u0 + u1) / 2, cv = (v0 + v1) / 2;
      const cx = mx + cu * c - cv * s, cy = my + cu * s + cv * c;
      // 그린 점들이 타원 둘레에서 너무 벗어나면(8자 같은 낙서) 다듬지 않는다
      const err = pts.reduce((acc, [x, y]) => {
        const u = (x - cx) * c + (y - cy) * s, v = -(x - cx) * s + (y - cy) * c;
        return acc + Math.abs(Math.hypot(u / a, v / b) - 1);
      }, 0) / n;
      if (err > 0.28) return null;
      let rot = th;
      if (Math.min(a, b) / Math.max(a, b) > 0.82) { a = b = (a + b) / 2; rot = 0; }
      const per = Math.PI * (3 * (a + b) - Math.sqrt((3 * a + b) * (a + 3 * b)));
      const steps = Math.max(64, Math.round(per / 3));
      const start = Math.atan2(-((sx - cx) * Math.sin(rot)) + (sy - cy) * Math.cos(rot), (sx - cx) * Math.cos(rot) + (sy - cy) * Math.sin(rot));
      const out = [];
      for (let i = 0; i <= steps; i++) {
        const t = start + (i / steps) * Math.PI * 2;
        const u = a * Math.cos(t), v = b * Math.sin(t);
        out.push([cx + u * Math.cos(rot) - v * Math.sin(rot), cy + u * Math.sin(rot) + v * Math.cos(rot)]);
      }
      return { kind: a === b ? "circle" : "ellipse", pts: out };
    }
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
    drawStroke(a.s, a.el, true);
    a.el.classList.add("snapped");
    setTimeout(() => a.el.classList.remove("snapped"), 300);
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
  function wantsPointer(e) {
    if (e.target.closest && e.target.closest(".no-ink, dialog, .photo.sel")) return false;
    if (e.pointerType === "pen") return true;
    return pref.finger;
  }
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
    active = { id: e.pointerId, s, el, t0: Date.now(), target: e.target, anchor: [x, y] };
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
      // 움직이는 동안은 꾹 누르기 타이머를 다시 건다
      if (Math.hypot(x - active.anchor[0], y - active.anchor[1]) > 5) {
        active.anchor = [x, y];
        clearTimeout(holdTimer);
        holdTimer = setTimeout(snapActive, HOLD_MS);
      }
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
    clearTimeout(holdTimer);
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
    if (stylus || (pref.finger && !e.target.closest(".no-ink, .photo.sel"))) e.preventDefault();
  }, { passive: false, capture: true });
  canvas.addEventListener("touchmove", (e) => { if (active) e.preventDefault(); }, { passive: false, capture: true });

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