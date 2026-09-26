(() => {
  "use strict";

  const KEY = "shplanner.v1";
  const DEFAULT_ROWS = 10;
  const DAY_START_HOUR = 6; // 시간표는 오전 6시부터 다음날 오전 5시까지
  const SLOT_MS = 10 * 60 * 1000;
  const WEEK = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"];
  // 기분 · 날씨: 원본 이미지에 그려진 아이콘의 중심 좌표 (캔버스 px)
  const MOODS = [["최악", 1489, 302], ["슬픔", 1537, 302], ["보통", 1584, 302], ["좋음", 1631, 302], ["최고", 1679, 302]];
  const WEATHERS = [["맑음", 1491, 360], ["구름 조금", 1538, 360], ["흐림", 1586, 360], ["비", 1632, 360], ["눈", 1680, 360]];
  // 과목 색상: 연한 파스텔 8색. 처음 기록된 순서대로 고정 배정, 9번째부터는 '기타' 회색
  const SUBJECT_COLORS = ["#f2c9c4", "#c9ddea", "#f3e6ae", "#cde6d3",
                          "#d8d1eb", "#f6d9b8", "#ebcfdd", "#dde3c6"];
  const OTHER_COLOR = "#e0e0dc";
  const NONAME_COLOR = "#ebebe8";
  const ROWS = 10; // 디자인에 그려진 줄 수
  // 형광펜 · 시간표 칠하기에 쓰는 연한 파스텔
  const PASTELS = ["#f6e7a6", "#f5cfc9", "#f8d9b5", "#cfe7d3", "#cbe0ec", "#dbd3ee", "#f0d3e2", "#e2e2de"];
  const DEFAULT_PREFS = { hl: PASTELS[0], tt: PASTELS[4] };
  const NONAME = "과목 없음";

  const ICON = {
    play: '<svg viewBox="0 0 16 16"><path d="M4 2.5v11l9-5.5z"/></svg>',
    pause: '<svg viewBox="0 0 16 16"><path d="M4 2.5h3v11H4zM9 2.5h3v11H9z"/></svg>',
    stop: '<svg viewBox="0 0 16 16"><rect x="3" y="3" width="10" height="10" rx="1.5"/></svg>',
    check: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8.5l3.2 3L13 4.5"/></svg>',
  };

  const $ = (id) => document.getElementById(id);

  // ---------- 저장소 ----------
  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) {
        const s = JSON.parse(raw);
        return { days: s.days || {}, active: s.active || null, dday: s.dday || null, goalSec: s.goalSec || 0,
                 prefs: { ...DEFAULT_PREFS, ...(s.prefs || {}) }, subjectColors: s.subjectColors || {} };
      }
    } catch (e) { /* 저장소 사용 불가 */ }
    return { days: {}, active: null, dday: null, goalSec: 0, prefs: { ...DEFAULT_PREFS }, subjectColors: {} };
  }

  function isEmptyDay(d) {
    return !d.goal && !d.memo && d.mood == null && d.weather == null && d.wk === undefined &&
      (!d.tt || !Object.keys(d.tt).length) &&
      d.tasks.every((t) => !t.subject && !t.content && !t.done && t.total === 0 && t.state === "idle");
  }

  function snapshot() {
    const days = {};
    for (const [k, d] of Object.entries(store.days)) if (!isEmptyDay(d)) days[k] = d;
    return { days, active: store.active, dday: store.dday, goalSec: store.goalSec, prefs: store.prefs, subjectColors: store.subjectColors };
  }

  function save() {
    subjectOrder = null;
    try {
      localStorage.setItem(KEY, JSON.stringify(snapshot()));
    } catch (e) { /* 저장소 사용 불가 */ }
  }

  const store = load();

  // ---------- 과목 색상 ----------
  const subjName = (t) => t.subject.trim() || NONAME;
  let subjectOrder = null;

  // 모든 기록을 날짜순으로 훑어 공부 시간이 있는 과목이 처음 나온 순서를 만든다
  function getSubjectOrder() {
    if (subjectOrder) return subjectOrder;
    subjectOrder = new Map();
    for (const k of Object.keys(store.days).sort()) {
      for (const t of store.days[k].tasks) {
        const n = t.subject.trim();
        if (n && !subjectOrder.has(n) && (t.total > 0 || t.state === "running")) subjectOrder.set(n, subjectOrder.size);
      }
    }
    return subjectOrder;
  }

  function colorFor(name) {
    const n = (name || "").trim() || NONAME;
    if (store.subjectColors[n]) return store.subjectColors[n]; // 도구 막대로 직접 바꾼 색
    if (n === NONAME) return NONAME_COLOR;
    const i = getSubjectOrder().get(n);
    if (i == null) return NONAME_COLOR;
    return i < SUBJECT_COLORS.length ? SUBJECT_COLORS[i] : OTHER_COLOR;
  }

  // ---------- 날짜 ----------
  const pad = (n) => String(n).padStart(2, "0");
  const toKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const fromKey = (k) => { const [y, m, d] = k.split("-").map(Number); return new Date(y, m - 1, d); };
  const addDays = (k, n) => { const d = fromKey(k); d.setDate(d.getDate() + n); return toKey(d); };
  const weekIdx = (k) => (fromKey(k).getDay() + 6) % 7; // 월=0 ... 일=6

  let cur = toKey(new Date());

  // ---------- 데이터 ----------
  const uid = () => Math.random().toString(36).slice(2, 10);
  const newTask = () => ({ id: uid(), subject: "", content: "", done: false, total: 0, segs: [], state: "idle", runStart: null });
  const blankDay = () => ({ goal: "", memo: "", mood: null, weather: null, tasks: Array.from({ length: DEFAULT_ROWS }, newTask) });

  function day(k = cur) {
    if (!store.days[k]) store.days[k] = blankDay();
    return store.days[k];
  }

  function findTask(k, id) {
    const d = store.days[k];
    return d ? d.tasks.find((t) => t.id === id) : null;
  }

  const taskSec = (t, now = Date.now()) =>
    Math.floor(t.total + (t.state === "running" ? (now - t.runStart) / 1000 : 0));

  function fmt(sec) {
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return `${h}:${pad(m)}:${pad(s)}`;
  }

  function fmtKo(sec) {
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
    if (h && m) return `${h}시간 ${m}분`;
    if (h) return `${h}시간`;
    if (m) return `${m}분`;
    return `${sec}초`;
  }

  // ---------- 타이머 ----------
  function commit(t) {
    if (t.state !== "running") return;
    const now = Date.now();
    if (now - t.runStart >= 1000) {
      t.total += (now - t.runStart) / 1000;
      t.segs.push([t.runStart, now]);
    }
    t.runStart = null;
  }

  function pauseActive() {
    if (!store.active) return;
    const t = findTask(store.active.date, store.active.id);
    if (t) { commit(t); t.state = "paused"; }
    store.active = null;
  }

  function start(k, id) {
    const t = findTask(k, id);
    if (!t) return;
    if (store.active && !(store.active.date === k && store.active.id === id)) pauseActive();
    t.state = "running";
    t.runStart = Date.now();
    store.active = { date: k, id };
    save(); tick();
  }

  function pause(k, id) {
    const t = findTask(k, id);
    if (!t || t.state !== "running") return;
    commit(t);
    t.state = "paused";
    store.active = null;
    save(); tick();
  }

  function stop(k, id) {
    const t = findTask(k, id);
    if (!t) return;
    commit(t);
    t.state = "idle";
    if (store.active && store.active.id === id) store.active = null;
    save(); tick();
    const name = t.subject || t.content || "공부";
    toast(`${name} · 총 ${fmtKo(taskSec(t))} 공부했어요 👏`);
  }

  // 칸 채우기 색: 도구 막대에서 고른 색 (지우개면 null)
  const fillColor = () => (window.PlannerInk ? window.PlannerInk.fillColor() : store.prefs.hl);

  // ---------- 렌더: 헤더 ----------
  function renderDate() {
    const [y, m, d] = cur.split("-");
    const parts = [y, m, d];
    document.querySelectorAll("#dateBoxes .grp").forEach((g, i) => {
      g.innerHTML = [...parts[i]].map((c) => `<span class="box">${c}</span>`).join("");
    });
    $("datePicker").value = cur;

    const wi = weekIdx(cur), today = toKey(new Date());
    const monday = addDays(cur, -wi);
    // 보고 있는 날의 요일 칸을 통째로 칠함. 칠한 칸을 다시 누르면 지워짐 (d.wk: 없으면 기본색, null이면 지움)
    const dayData = day();
    const fill = dayData.wk === null ? null : dayData.wk || store.prefs.hl;
    $("week").innerHTML = WEEK.map((w, i) => {
      const k = addDays(monday, i);
      const cls = [i === wi ? "on" : "", i === wi && fill ? "filled" : "", k === today ? "today" : ""].join(" ");
      return `<button class="${cls}" data-key="${k}" aria-label="${w} ${k}"></button>`;
    }).join("");
    if (fill) $("week").style.setProperty("--fill", fill);

    renderDday();
  }

  function renderDday() {
    const box = $("ddayBox");
    const dd = store.dday;
    if (!dd || !dd.date) {
      box.classList.add("unset");
      $("ddayLabel").textContent = "D-DAY";
      $("ddayNum").textContent = "탭해서 설정";
      return;
    }
    box.classList.remove("unset");
    const diff = Math.round((fromKey(dd.date) - fromKey(cur)) / 86400000);
    $("ddayLabel").textContent = dd.label || dd.date;
    $("ddayNum").textContent = diff === 0 ? "D-DAY" : diff > 0 ? `D-${diff}` : `D+${-diff}`;
  }

  // ---------- 렌더: 공부 목록 ----------
  function renderTasks() {
    const d = day();
    const ul = $("tasks");
    ul.innerHTML = "";
    while (d.tasks.length < ROWS) d.tasks.push(newTask());
    d.tasks.slice(0, ROWS).forEach((t) => {
      const li = document.createElement("li");
      li.className = "task";
      li.dataset.id = t.id;
      li.innerHTML = `
        <div class="subj-wrap"><button class="swatch" data-act="subjcolor" aria-label="과목 색 바꾸기"></button><input type="text" class="subj" data-f="subject" placeholder="과목" maxlength="20"></div>
        <input type="text" class="cont" data-f="content" placeholder="공부한 내용">
        <div class="timer">
          <button class="time" data-act="edit" title="시간 직접 수정"></button>
          <button class="ic play" data-act="toggle"></button>
          <button class="ic stop" data-act="stop" title="종료">${ICON.stop}</button>
        </div>
        <button class="check" data-act="done" title="완료">${ICON.check}</button>`;
      li.querySelector(".subj").value = t.subject;
      li.querySelector(".cont").value = t.content;
      ul.appendChild(li);
    });
    $("goal").value = d.goal;
    $("memo").value = d.memo;
    renderPicks();
    tick();
  }

  function renderPicks() {
    const d = day();
    const btns = (list, sel, color, kind) => list.map(([name, x, y], i) =>
      `<button class="${sel === i ? "on" : ""}" style="left:${x}px;top:${y}px;--fill:${sel === i ? color : "transparent"}" data-i="${i}" aria-label="${kind} ${name}" aria-pressed="${sel === i}"></button>`).join("");
    $("moods").innerHTML = btns(MOODS, d.mood, d.moodColor || store.prefs.hl, "기분");
    $("weathers").innerHTML = btns(WEATHERS, d.weather, d.weatherColor || store.prefs.hl, "날씨");
  }

  // 누르면 그 칸을 지금 색으로 칠하고, 칠한 칸을 다시 누르면 지움
  function togglePick(kind, i) {
    const d = day();
    const c = fillColor();
    if (d[kind] === i || !c) { d[kind] = null; }
    else { d[kind] = i; d[kind + "Color"] = c; store.prefs.hl = c; }
    save(); renderPicks();
  }

  // ---------- 렌더: 시간표 ----------
  const ttCells = [];
  function buildTimetable() {
    const tt = $("timetable");
    let html = "";
    for (let r = 0; r < 24; r++) {
      for (let c = 0; c < 6; c++) html += `<div class="tt-c" data-slot="${r * 6 + c}"></div>`;
    }
    tt.innerHTML = html;
    tt.querySelectorAll(".tt-c").forEach((el) => ttCells.push(el));
    $("ttLabels").innerHTML = Array.from({ length: 24 }, (_, r) => {
      const h = (DAY_START_HOUR + r) % 24;
      return `<span>${h % 12 === 0 ? 12 : h % 12}</span>`;
    }).join("");
  }

  // 시간표 칸을 누르거나 끌면 도구 막대의 색으로 칠한다 (칠한 칸을 다시 누르면 지움, 지우개 도구면 지움)
  let ttPaint = null;
  function paintCell(el) {
    const slot = el.dataset.slot;
    const d = day();
    d.tt = d.tt || {};
    // 타이머 기록으로 자동 칠해진 칸은 "none"으로 표시해 숨긴다
    if (ttPaint.mode === "erase") { if (autoFilled[slot]) d.tt[slot] = "none"; else delete d.tt[slot]; }
    else d.tt[slot] = ttPaint.color;
    paintTimetable(Date.now());
  }
  $("timetable").addEventListener("pointerdown", (e) => {
    const el = e.target.closest(".tt-c");
    if (!el || e.pointerType === "pen" || window.PlannerInk?.wantsPointer(e)) return;
    e.preventDefault();
    const color = fillColor();
    // 지금 색이 보이는 칸(직접 칠했든 타이머로 칠해졌든)을 누르면 지우기
    const shown = !!ttCells[el.dataset.slot].style.backgroundColor;
    ttPaint = { color, mode: !color || shown ? "erase" : "paint", last: el };
    try { $("timetable").setPointerCapture(e.pointerId); } catch (err) { /* 캡처 불가 환경 */ }
    paintCell(el);
  });
  $("timetable").addEventListener("pointermove", (e) => {
    if (!ttPaint) return;
    const hit = document.elementFromPoint(e.clientX, e.clientY);
    const el = hit && hit.closest && hit.closest(".tt-c");
    if (el && el !== ttPaint.last) { ttPaint.last = el; paintCell(el); }
  });
  const endPaint = () => { if (ttPaint) { ttPaint = null; save(); } };
  $("timetable").addEventListener("pointerup", endPaint);
  $("timetable").addEventListener("pointercancel", endPaint);

  function slotOf(ms) {
    const d = new Date(ms);
    return ((d.getHours() - DAY_START_HOUR + 24) % 24) * 6 + Math.floor(d.getMinutes() / 10);
  }

  function paintTimetable(now) {
    const d = day();
    const map = new Array(144).fill(null);
    d.tasks.forEach((t, i) => {
      const segs = t.state === "running" ? [...t.segs, [t.runStart, now]] : t.segs;
      for (const [s, e] of segs) {
        let c = s, guard = 0;
        while (c < e && guard++ < 150) {
          map[slotOf(c)] = i;
          const dt = new Date(c);
          c = new Date(dt.getFullYear(), dt.getMonth(), dt.getDate(), dt.getHours(),
                       Math.floor(dt.getMinutes() / 10) * 10 + 10).getTime();
        }
      }
    });
    const manual = d.tt || {};
    ttCells.forEach((el, i) => {
      const t = map[i] == null ? null : d.tasks[map[i]];
      autoFilled[i] = !!t;
      // 직접 칠한 색이 타이머 기록보다 우선 ("none"은 지운 칸). multiply로 겹쳐 인쇄된 선이 비쳐 보이게
      const c = manual[i] === "none" ? "" : manual[i] || (t ? colorFor(t.subject) : "");
      el.style.backgroundColor = c;
      el.title = c && t ? (t.subject || t.content || "공부") : "";
    });
  }
  const autoFilled = [];

  // 펜슬 지우개가 지나간 곳의 칸 색도 지운다 (좌표는 캔버스 px)
  const TT = { x: 1193, y: 287, w: 266, h: 905 };
  let fillSaveTimer = null;
  function eraseFillAt(x, y, r) {
    const d = day();
    let changed = false;
    if (x + r > TT.x && x - r < TT.x + TT.w && y + r > TT.y && y - r < TT.y + TT.h) {
      const cw = TT.w / 6, ch = TT.h / 24;
      const c0 = Math.max(0, Math.floor((x - r - TT.x) / cw)), c1 = Math.min(5, Math.floor((x + r - TT.x) / cw));
      const r0 = Math.max(0, Math.floor((y - r - TT.y) / ch)), r1 = Math.min(23, Math.floor((y + r - TT.y) / ch));
      d.tt = d.tt || {};
      for (let row = r0; row <= r1; row++) for (let col = c0; col <= c1; col++) {
        const slot = row * 6 + col;
        if (!ttCells[slot].style.backgroundColor) continue;
        if (autoFilled[slot]) d.tt[slot] = "none"; else delete d.tt[slot];
        changed = true;
      }
      if (changed) paintTimetable(Date.now());
    }
    // 요일 칸 (보고 있는 날)
    const wx = 55 + weekIdx(cur) * (1646 / 7);
    if (d.wk !== null && x + r > wx && x - r < wx + 1646 / 7 && y + r > 210 && y - r < 263) {
      d.wk = null; changed = true; renderDate();
    }
    if (changed) { clearTimeout(fillSaveTimer); fillSaveTimer = setTimeout(save, 300); }
  }
  // 펜슬로 시간표 칸을 톡 누르면 손가락처럼 칠하기/지우기
  function tapCell(slot) {
    const el = ttCells[slot];
    const color = fillColor();
    ttPaint = { color, mode: !color || el.style.backgroundColor ? "erase" : "paint", last: el };
    paintCell(el);
    ttPaint = null;
    save();
  }

  // ---------- 주기적 갱신 ----------
  function tick() {
    const now = Date.now();
    const d = day();
    let total = 0;
    document.querySelectorAll("#tasks .task").forEach((li) => {
      const t = d.tasks.find((x) => x.id === li.dataset.id);
      if (!t) return;
      const sec = taskSec(t, now);
      total += sec;
      li.querySelector(".time").textContent = fmt(sec);
      li.classList.toggle("running", t.state === "running");
      li.classList.toggle("paused", t.state === "paused");
      li.classList.toggle("has-time", sec > 0);
      li.classList.toggle("done", t.done);
      li.style.setProperty("--c", colorFor(t.subject));
      const play = li.querySelector(".play");
      const running = t.state === "running";
      if (play.dataset.mode !== (running ? "pause" : "play")) {
        play.dataset.mode = running ? "pause" : "play";
        play.innerHTML = running ? ICON.pause : ICON.play;
        play.title = running ? "일시정지" : t.state === "paused" ? "이어하기" : "시작";
      }
    });
    $("totalTime").textContent = fmt(total);
    renderGoal(total);
    paintTimetable(now);

    // 다른 날짜(또는 통계 화면)에서 진행 중인 타이머 안내
    const a = store.active;
    const at = a && findTask(a.date, a.id);
    if (at && (a.date !== cur || view !== "planner")) {
      $("bannerText").textContent = `${a.date.slice(5).replace("-", "/")} ${at.subject || at.content || "공부"} ${fmt(taskSec(at, now))}`;
      $("activeBanner").hidden = false;
    } else {
      $("activeBanner").hidden = true;
    }
    document.title = at ? `⏱ ${fmt(taskSec(at, now))} · Splanner` : "Splanner";
  }

  function renderGoal(total) {
    const box = $("goalBox");
    $("canvas").classList.toggle("has-goal", !!store.goalSec);
    if (!store.goalSec) { box.hidden = true; return; }
    box.hidden = false;
    const pct = Math.min(100, Math.round((total / store.goalSec) * 100));
    $("goalFill").style.width = pct + "%";
    box.classList.toggle("reached", total >= store.goalSec);
    $("goalTxt").textContent = total >= store.goalSec ? "✓" : `${pct}%`;
    box.title = `하루 목표 ${fmtKo(store.goalSec)}`;
  }

  // ---------- 화면 크기에 맞춰 플래너 확대/축소 ----------
  const CANVAS_W = 1754, CANVAS_H = 1240;
  // 플래너 · 통계 모두 같은 가로 한 장(1754 x 1240)을 화면에 꽉 맞춘다
  function fit() {
    document.querySelectorAll(".stage").forEach((stage) => {
      if (stage.hidden) return;
      const canvas = stage.querySelector(".canvas");
      const cs = getComputedStyle(stage);
      const w = stage.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      const h = stage.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
      const s = Math.min(w / CANVAS_W, h / CANVAS_H);
      let wrap = canvas.parentElement;
      if (!wrap.classList.contains("fit")) {
        wrap = document.createElement("div");
        wrap.className = "fit";
        canvas.replaceWith(wrap);
        wrap.appendChild(canvas);
      }
      wrap.style.width = CANVAS_W * s + "px";
      wrap.style.height = CANVAS_H * s + "px";
      canvas.style.transform = `scale(${s})`;
      canvas.dataset.scale = s;
    });
  }
  window.addEventListener("resize", fit);
  window.addEventListener("orientationchange", () => setTimeout(fit, 200));

  // ---------- 이동 ----------
  function go(k) {
    cur = k;
    renderDate();
    renderTasks();
    window.PlannerInk?.setDay(k);
  }

  // ---------- 화면 전환 (플래너 / 통계) ----------
  let view = "planner";
  function setView(v) {
    view = v;
    $("plannerView").hidden = v !== "planner";
    $("statsView").hidden = v !== "stats";
    document.body.classList.toggle("view-stats", v === "stats");
    document.querySelectorAll(".view-tabs button").forEach((b) => {
      b.classList.toggle("on", b.dataset.view === v);
      b.setAttribute("aria-selected", b.dataset.view === v);
    });
    fit();
    if (v === "stats" && window.Stats) window.Stats.render();
    if (location.hash !== (v === "stats" ? "#stats" : "")) history.replaceState(null, "", v === "stats" ? "#stats" : location.pathname + location.search);
    window.scrollTo(0, 0);
    tick();
  }
  document.querySelectorAll(".view-tabs").forEach((el) => el.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-view]");
    if (b) setView(b.dataset.view);
  }));

  // ---------- 설정 (목표 시간, 백업) ----------
  const openSettings = () => {
    $("goalH").value = Math.floor(store.goalSec / 3600);
    $("goalM").value = Math.floor((store.goalSec % 3600) / 60);
    $("settingsDialog").showModal();
  };
  document.querySelectorAll(".settings-btn").forEach((b) => b.addEventListener("click", openSettings));
  $("settingsDialog").addEventListener("close", () => {
    if ($("settingsDialog").returnValue !== "save") return;
    const h = Math.min(23, Math.max(0, parseInt($("goalH").value, 10) || 0));
    const m = Math.min(59, Math.max(0, parseInt($("goalM").value, 10) || 0));
    store.goalSec = h * 3600 + m * 60;
    save(); tick();
    if (view === "stats") window.Stats.render();
  });

  $("exportBtn").addEventListener("click", async () => {
    const data = { ...snapshot(), ink: window.PlannerInk ? await window.PlannerInk.exportAll() : {} };
    const blob = new Blob([JSON.stringify(data)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `study-planner-backup-${toKey(new Date())}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
  $("importBtn").addEventListener("click", () => $("importFile").click());
  $("importFile").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    try {
      const s = JSON.parse(await file.text());
      if (!s || typeof s.days !== "object") throw new Error("형식 오류");
      if (!(await ask("백업 불러오기", "백업 파일로 지금 기록을 모두 덮어쓸까요?", "덮어쓰기"))) return;
      store.days = s.days; store.active = s.active || null;
      store.dday = s.dday || null; store.goalSec = s.goalSec || 0;
      store.prefs = { ...DEFAULT_PREFS, ...(s.prefs || {}) };
      store.subjectColors = s.subjectColors || {};
      save();
      if (s.ink && window.PlannerInk) await window.PlannerInk.importAll(s.ink);
      $("settingsDialog").close();
      go(cur);
      if (view === "stats") window.Stats.render();
      toast("백업을 불러왔어요");
    } catch (err) {
      toast("백업 파일을 읽을 수 없어요");
    }
  });

  // ---------- 토스트 ----------
  let toastTimer;
  function toast(msg) {
    const el = $("toast");
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("show"), 2600);
  }

  // ---------- 시간 수정 ----------
  let editing = null;
  function openEdit(id) {
    const t = findTask(cur, id);
    if (!t) return;
    if (t.state === "running") pause(cur, id);
    editing = id;
    const sec = taskSec(t);
    $("editH").value = Math.floor(sec / 3600);
    $("editM").value = Math.floor((sec % 3600) / 60);
    $("editS").value = sec % 60;
    $("timeDialogSub").textContent = t.subject || t.content ? `${t.subject} ${t.content}`.trim() : "";
    $("timeDialog").showModal();
    $("editH").select();
  }

  $("timeDialog").addEventListener("close", () => {
    const t = editing && findTask(cur, editing);
    const v = $("timeDialog").returnValue;
    editing = null;
    if (!t) return;
    const n = (id, max) => Math.min(max, Math.max(0, parseInt($(id).value, 10) || 0));
    if (v === "save") {
      t.total = n("editH", 99) * 3600 + n("editM", 59) * 60 + n("editS", 59);
    } else if (v === "reset") {
      t.total = 0; t.segs = []; t.state = "idle";
    } else return;
    save(); tick();
  });

  // ---------- D-Day ----------
  $("ddayBox").addEventListener("click", () => {
    $("ddayName").value = store.dday?.label || "";
    $("ddayDate").value = store.dday?.date || "";
    $("ddayDialog").showModal();
  });
  $("ddayDialog").addEventListener("close", () => {
    const v = $("ddayDialog").returnValue;
    if (v === "save" && $("ddayDate").value) {
      store.dday = { label: $("ddayName").value.trim(), date: $("ddayDate").value };
    } else if (v === "clear") {
      store.dday = null;
    } else return;
    save(); renderDday();
  });

  // ---------- 이벤트 ----------
  const tasksEl = $("tasks");

  tasksEl.addEventListener("input", (e) => {
    const f = e.target.dataset.f;
    const li = e.target.closest(".task");
    if (!f || !li) return;
    const t = findTask(cur, li.dataset.id);
    t[f] = e.target.value;
    save();
  });

  tasksEl.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || !e.target.dataset.f || e.isComposing) return;
    e.preventDefault();
    const li = e.target.closest(".task");
    if (e.target.dataset.f === "subject") { li.querySelector(".cont").focus(); return; }
    const next = li.nextElementSibling;
    if (next) next.querySelector(".subj").focus();
  });

  tasksEl.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    const id = btn.closest(".task").dataset.id;
    const t = findTask(cur, id);
    switch (btn.dataset.act) {
      case "toggle": t.state === "running" ? pause(cur, id) : start(cur, id); break;
      case "stop": stop(cur, id); break;
      case "edit": openEdit(id); break;
      case "done": t.done = !t.done; save(); tick(); break;
      case "subjcolor": if (t.subject.trim()) setSubjectColor(t.subject.trim(), fillColor()); break;
    }
  });

  $("goal").addEventListener("input", (e) => { day().goal = e.target.value; save(); });
  $("memo").addEventListener("input", (e) => { day().memo = e.target.value; save(); });

  $("moods").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (b) togglePick("mood", +b.dataset.i);
  });
  $("weathers").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (b) togglePick("weather", +b.dataset.i);
  });

  $("prevDay").addEventListener("click", () => go(addDays(cur, -1)));
  $("nextDay").addEventListener("click", () => go(addDays(cur, 1)));
  $("todayBtn").addEventListener("click", () => go(toKey(new Date())));
  $("week").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-key]");
    if (!b) return;
    if (b.dataset.key === cur) {
      // 보고 있는 요일 칸: 칠해져 있으면 지우고, 비어 있으면 도구 막대의 색으로 칠함
      const d = day();
      const c = fillColor();
      if (b.classList.contains("filled") || !c) d.wk = null;
      else { d.wk = c; store.prefs.hl = c; }
      save(); renderDate();
    } else go(b.dataset.key);
  });
  $("dateBoxes").addEventListener("click", () => {
    const p = $("datePicker");
    try { p.showPicker(); } catch (err) { p.focus(); p.click(); }
  });
  $("datePicker").addEventListener("change", (e) => { if (e.target.value) go(e.target.value); });
  $("bannerGo").addEventListener("click", () => {
    if (!store.active) return;
    go(store.active.date);
    setView("planner");
  });

  // 다른 탭에서 바뀐 내용 반영
  window.addEventListener("storage", (e) => {
    if (e.key !== KEY) return;
    const s = load();
    store.days = s.days; store.active = s.active; store.dday = s.dday; store.goalSec = s.goalSec;
    store.prefs = s.prefs; store.subjectColors = s.subjectColors;
    subjectOrder = null;
    go(cur);
    if (view === "stats") window.Stats.render();
  });

  // 앱 안의 확인 창 (결과: true / false)
  function ask(title, text, okLabel = "확인") {
    return new Promise((resolve) => {
      const dlg = $("askDialog");
      $("askTitle").textContent = title;
      $("askText").textContent = text;
      $("askOk").textContent = okLabel;
      dlg.returnValue = "";
      dlg.addEventListener("close", () => resolve(dlg.returnValue === "ok"), { once: true });
      dlg.showModal();
    });
  }

  // 과목 색 바꾸기 (도구 막대의 색, 지우개면 원래 색으로)
  function setSubjectColor(name, color) {
    if (color) store.subjectColors[name] = color;
    else delete store.subjectColors[name];
    save(); tick();
    if (view === "stats") window.Stats.render();
    toast(color ? `'${name}' 색을 바꿨어요` : `'${name}' 색을 원래대로 돌렸어요`);
  }

  // ---------- 통계 화면에 넘겨줄 공용 함수 ----------
  window.Planner = {
    store, NONAME, SUBJECT_COLORS, OTHER_COLOR, NONAME_COLOR, DAY_START_HOUR,
    taskSec, fmt, fmtKo, pad, toKey, fromKey, addDays, weekIdx, subjName, colorFor, getSubjectOrder,
    openDay(k) { go(k); setView("planner"); },
    get cur() { return cur; },
    save, toast, ask, eraseFillAt, tapCell, setSubjectColor, fillColor,
  };

  // ---------- 시작 ----------
  buildTimetable();
  fit();
  go(cur);
  setInterval(tick, 1000);
  // 통계 화면을 보는 중에 타이머가 돌고 있으면 15초마다 갱신
  setInterval(() => { if (view === "stats" && store.active) window.Stats.render(); }, 15000);
  window.addEventListener("DOMContentLoaded", () => { if (location.hash === "#stats") setView("stats"); });
})();