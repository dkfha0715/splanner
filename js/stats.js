(() => {
  "use strict";

  const P = window.Planner;
  const $ = (id) => document.getElementById(id);
  const DOW = ["월", "화", "수", "목", "금", "토", "일"];
  const OTHER = "기타";
  // 공부 달력 농도: 무채색 한 가지로 연한 → 진한 순
  // 색 섞기 (도구 막대로 고른 한 가지 색에서 연한 → 진한 단계를 만든다)
  const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const mix = (a, b, t) => "#" + hex(a).map((v, i) => Math.round(v + (hex(b)[i] - v) * t).toString(16).padStart(2, "0")).join("");
  const HEAT_BASE = "#62625d", HOUR_BASE = "#d6d6d2";
  function heatRamp() {
    const base = P.store.prefs.heatColor || HEAT_BASE;
    return ["#f3f3f1", ...[0.18, 0.36, 0.58, 0.8, 1].map((t) => mix("#ffffff", base, t))];
  }
  let HEAT = heatRamp();
  const HEAT_STEPS = [0, 1, 2, 4, 6]; // 시간 단위 경계: 0 | ~1h | ~2h | ~4h | ~6h | 6h+

  let period = "week";
  let anchor = P.toKey(new Date());
  let tips = [];

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // ---------- 기간 ----------
  function range() {
    const a = P.fromKey(anchor);
    let start, end;
    if (period === "week") {
      start = P.addDays(anchor, -P.weekIdx(anchor));
      end = P.addDays(start, 6);
    } else if (period === "month") {
      start = P.toKey(new Date(a.getFullYear(), a.getMonth(), 1));
      end = P.toKey(new Date(a.getFullYear(), a.getMonth() + 1, 0));
    } else {
      start = `${a.getFullYear()}-01-01`;
      end = `${a.getFullYear()}-12-31`;
    }
    const days = [];
    for (let k = start; k <= end; k = P.addDays(k, 1)) days.push(k);
    return { start, end, days };
  }

  function shift(n) {
    shiftAnchorOnly(n);
    render();
  }

  function periodLabel(r) {
    const s = P.fromKey(r.start), e = P.fromKey(r.end);
    if (period === "year") return `${s.getFullYear()}년`;
    if (period === "month") return `${s.getFullYear()}년 ${s.getMonth() + 1}월`;
    const sameMonth = s.getMonth() === e.getMonth();
    return `${s.getMonth() + 1}월 ${s.getDate()}일 – ${sameMonth ? "" : e.getMonth() + 1 + "월 "}${e.getDate()}일`;
  }

  const PREV_WORD = { week: "지난주", month: "지난달", year: "작년" };
  const NOW_WORD = { week: "이번 주", month: "이번 달", year: "올해" };

  // ---------- 집계 ----------
  function dayStats(k, now) {
    const d = P.store.days[k];
    const res = { total: 0, subj: new Map(), sessions: 0, done: 0, planned: 0, hours: new Array(24).fill(0) };
    if (!d) return res;
    for (const t of d.tasks) {
      const sec = P.taskSec(t, now);
      if (t.subject.trim() || t.content.trim()) { res.planned++; if (t.done) res.done++; }
      if (sec <= 0) continue;
      res.total += sec;
      const n = P.subjName(t);
      res.subj.set(n, (res.subj.get(n) || 0) + sec);
      const segs = t.state === "running" ? [...t.segs, [t.runStart, now]] : t.segs;
      res.sessions += segs.length;
      for (const [s, e] of segs) {
        let c = s, guard = 0;
        while (c < e && guard++ < 48) {
          const dt = new Date(c);
          const next = new Date(dt.getFullYear(), dt.getMonth(), dt.getDate(), dt.getHours() + 1).getTime();
          res.hours[dt.getHours()] += (Math.min(next, e) - c) / 1000;
          c = next;
        }
      }
    }
    return res;
  }

  function aggregate(keys, now) {
    const agg = { total: 0, subj: new Map(), subjDays: new Map(), sessions: new Map(), done: 0, planned: 0,
                  hours: new Array(24).fill(0), per: new Map() };
    for (const k of keys) {
      const s = dayStats(k, now);
      agg.per.set(k, s);
      agg.total += s.total; agg.done += s.done; agg.planned += s.planned;
      s.hours.forEach((v, i) => { agg.hours[i] += v; });
      for (const [n, v] of s.subj) {
        agg.subj.set(n, (agg.subj.get(n) || 0) + v);
        agg.subjDays.set(n, (agg.subjDays.get(n) || 0) + 1);
      }
    }
    // 세션 수는 과목별로 한 번 더 센다
    for (const k of keys) {
      const d = P.store.days[k];
      if (!d) continue;
      for (const t of d.tasks) {
        if (P.taskSec(t, now) <= 0) continue;
        const n = P.subjName(t);
        agg.sessions.set(n, (agg.sessions.get(n) || 0) + t.segs.length + (t.state === "running" ? 1 : 0));
      }
    }
    return agg;
  }

  // 전체 기록 기준 연속 공부일
  function streaks(now) {
    const studied = new Set(Object.keys(P.store.days).filter((k) => dayStats(k, now).total > 0));
    const today = P.toKey(new Date(now));
    let k = studied.has(today) ? today : P.addDays(today, -1), current = 0;
    while (studied.has(k)) { current++; k = P.addDays(k, -1); }
    let longest = 0, run = 0, prev = null;
    for (const d of [...studied].sort()) {
      run = prev && P.addDays(prev, 1) === d ? run + 1 : 1;
      longest = Math.max(longest, run);
      prev = d;
    }
    return { current, longest };
  }

  // 차트에 표시할 이름: 색이 배정된 8과목 외에는 '기타'로 묶는다
  function seriesName(n) {
    if (n === P.NONAME) return n;
    const i = P.getSubjectOrder().get(n);
    return i != null && i < P.SUBJECT_COLORS.length ? n : OTHER;
  }
  function seriesColor(n) {
    if (n === OTHER) return P.store.subjectColors[OTHER] || P.OTHER_COLOR;
    return P.colorFor(n);
  }
  function seriesRank(n) {
    if (n === OTHER) return 900;
    if (n === P.NONAME) return 901;
    return P.getSubjectOrder().get(n) ?? 800;
  }
  function fold(subjMap) {
    const out = new Map();
    for (const [n, v] of subjMap) {
      const s = seriesName(n);
      out.set(s, (out.get(s) || 0) + v);
    }
    return [...out].sort((a, b) => seriesRank(a[0]) - seriesRank(b[0]));
  }

  // ---------- 형식 ----------
  function hm(sec) {
    sec = Math.round(sec);
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
    if (h && m) return `${h}시간 ${m}분`;
    if (h) return `${h}시간`;
    if (m) return `${m}분`;
    return sec > 0 ? `${sec}초` : "0분";
  }
  function big(sec) {
    sec = Math.round(sec);
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
    if (h) return `<b>${h}</b><small>시간</small> <b>${m}</b><small>분</small>`;
    return `<b>${m}</b><small>분</small>`;
  }
  const md = (k) => { const d = P.fromKey(k); return `${d.getMonth() + 1}/${d.getDate()} (${DOW[P.weekIdx(k)]})`; };
  const hourName = (h) => h === 0 ? "자정" : h === 12 ? "정오" : h < 12 ? `오전 ${h}시` : `오후 ${h - 12}시`;

  function tipHtml(title, rows) {
    return `<div class="tip-t">${esc(title)}</div>` + rows.map(([n, v, c]) =>
      `<div class="tip-r"><i style="background:${c}"></i><span>${esc(n)}</span><em>${hm(v)}</em></div>`).join("");
  }
  const addTip = (html) => { tips.push(html); return tips.length - 1; };

  // ---------- 요약 카드 ----------
  function renderTiles(r, agg, prevTotal, now) {
    const today = P.toKey(new Date(now));
    const elapsed = r.days.filter((k) => k <= today);
    const studied = elapsed.filter((k) => agg.per.get(k).total > 0);
    const avg = elapsed.length ? agg.total / elapsed.length : 0;
    const avgStudied = studied.length ? agg.total / studied.length : 0;

    let best = null;
    for (const k of r.days) { const t = agg.per.get(k).total; if (t > 0 && (!best || t > best.t)) best = { k, t }; }

    const diff = agg.total - prevTotal;
    let cmp = `${PREV_WORD[period]} 기록 없음`;
    if (prevTotal > 0) {
      if (Math.abs(diff) < 60) cmp = `${PREV_WORD[period]}과 비슷해요`;
      else cmp = `${PREV_WORD[period]}보다 ${hm(Math.abs(diff))} ${diff > 0 ? "▲ 더" : "▼ 덜"}`;
    }

    const st = streaks(now);
    const goal = P.store.goalSec;
    const reached = goal ? elapsed.filter((k) => agg.per.get(k).total >= goal).length : 0;
    const rate = agg.planned ? Math.round((agg.done / agg.planned) * 100) : 0;

    const tiles = [
      ["총 공부 시간", big(agg.total), cmp],
      ["하루 평균", big(avg), studied.length ? `공부한 날 평균 ${hm(avgStudied)}` : "아직 기록이 없어요"],
      ["공부한 날", `<b>${studied.length}</b><small>일 / ${elapsed.length}일</small>`, `현재 ${st.current}일 연속 · 최장 ${st.longest}일`],
      ["최고 기록", best ? big(best.t) : "<b>-</b>", best ? md(best.k) : "기록 없음"],
      goal
        ? ["목표 달성", `<b>${reached}</b><small>일</small>`, `하루 ${hm(goal)} 목표 · 달성률 ${elapsed.length ? Math.round((reached / elapsed.length) * 100) : 0}%`]
        : ["목표 달성", "<b>-</b>", '<button class="link" data-act="goal">하루 목표 시간 정하기</button>'],
      ["할 일 완료", `<b>${agg.done}</b><small>/ ${agg.planned}개</small>`, agg.planned ? `완료율 ${rate}%` : "등록한 할 일 없음"],
    ];
    $("tiles").innerHTML = tiles.map(([h, v, s]) =>
      `<div class="tile"><div class="tile-h">${h}</div><div class="tile-v">${v}</div><div class="tile-s">${s}</div></div>`).join("");
  }

  // ---------- 막대 차트 ----------
  function niceStep(maxH) {
    const steps = [0.25, 0.5, 1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 25, 30, 40, 50, 60, 80, 100, 150, 200, 250, 300, 400, 500];
    return steps.find((s) => Math.ceil(maxH / s) <= 4) || Math.ceil(maxH / 4 / 100) * 100;
  }
  const tickLabel = (h) => (h === 0 ? "0" : h < 1 ? `${Math.round(h * 60)}분` : `${h}시간`);

  function renderBars(r, agg, now) {
    const today = P.toKey(new Date(now));
    let cols;
    if (period === "year") {
      const y = P.fromKey(r.start).getFullYear();
      cols = Array.from({ length: 12 }, (_, m) => {
        const subj = new Map();
        let total = 0;
        for (const [k, s] of agg.per) {
          if (P.fromKey(k).getMonth() !== m) continue;
          total += s.total;
          for (const [n, v] of s.subj) subj.set(n, (subj.get(n) || 0) + v);
        }
        const isNow = new Date(now).getFullYear() === y && new Date(now).getMonth() === m;
        return { label: `${m + 1}월`, sub: "", total, subj, key: P.toKey(new Date(y, m, 1)), now: isNow, title: `${y}년 ${m + 1}월` };
      });
    } else {
      cols = r.days.map((k) => {
        const s = agg.per.get(k), d = P.fromKey(k);
        return {
          label: period === "week" ? DOW[P.weekIdx(k)] : String(d.getDate()),
          sub: period === "week" ? String(d.getDate()) : "",
          total: s.total, subj: s.subj, key: k, now: k === today, future: k > today, title: md(k),
        };
      });
    }

    const goal = period === "year" ? 0 : P.store.goalSec;
    const maxSec = Math.max(goal, ...cols.map((c) => c.total));
    const step = niceStep(maxSec / 3600 || 1);
    const ticks = Math.max(1, Math.ceil(maxSec / 3600 / step));
    const top = ticks * step * 3600;

    // 범례: 기간 안에 나온 과목 (2개 이상일 때만)
    const series = fold(agg.subj);
    $("barLegend").innerHTML = series.length >= 2
      ? series.map(([n]) => `<span data-subj="${esc(n)}"><i style="background:${seriesColor(n)}"></i>${esc(n)}</span>`).join("")
      : "";

    const grid = Array.from({ length: ticks + 1 }, (_, i) =>
      `<div class="gl" style="bottom:${(i / ticks) * 100}%"><span>${tickLabel(i * step)}</span></div>`).join("");
    const goalLine = goal ? `<div class="goal-line" style="bottom:${(goal / top) * 100}%"><span>목표</span></div>` : "";

    const colHtml = cols.map((c) => {
      const parts = fold(c.subj);
      const tip = addTip(tipHtml(`${c.title} · ${hm(c.total)}`, parts.map(([n, v]) => [n, v, seriesColor(n)])));
      const segs = parts.map(([n, v]) => `<i style="flex-grow:${v};background:${seriesColor(n)}" data-subj="${esc(n)}"></i>`).join("");
      return `<button class="col${c.now ? " now" : ""}${c.future ? " future" : ""}" data-tip="${tip}" data-key="${c.key}" aria-label="${esc(c.title)} ${hm(c.total)}">
        <span class="stack" style="height:${c.total ? Math.max(0.8, (c.total / top) * 100) : 0}%">${segs}</span>
      </button>`;
    }).join("");
    const xl = cols.map((c) => `<span class="${c.now ? "now" : ""}" data-key="${c.key}">${c.label}${c.sub ? `<small>${c.sub}</small>` : ""}</span>`).join("");

    $("barChart").className = `bars p-${period}`;
    $("barChart").innerHTML = `
      <div class="plot">${grid}${goalLine}<div class="cols">${colHtml}</div>
        ${agg.total ? "" : '<div class="st-empty">이 기간에는 아직 공부 기록이 없어요</div>'}</div>
      <div class="xl">${xl}</div>`;

    const hint = (period === "year" ? "월 이름을 누르면 월간으로" : "날짜를 누르면 그날 플래너로") + " · 막대를 누르면 고른 색으로";
    $("barSub").textContent = (period === "year" ? "월별 합계" : "일별 합계") + " · " + hint;
  }

  // ---------- 과목별 ----------
  function renderSubjects(r, agg) {
    const rows = [...agg.subj].sort((a, b) => b[1] - a[1]);
    $("subjSub").textContent = rows.length ? `${rows.length}과목` : "";
    if (!rows.length) {
      $("subjStrip").innerHTML = "";
      $("subjList").innerHTML = '<p class="empty-s">과목을 입력하고 타이머를 켜면 여기에 모여요</p>';
      return;
    }
    const max = rows[0][1];
    $("subjStrip").innerHTML = fold(agg.subj).sort((a, b) => b[1] - a[1]).map(([n, v]) => {
      const tip = addTip(tipHtml(n, [[n, v, seriesColor(n)]]));
      return `<i style="flex-grow:${v};background:${seriesColor(n)}" data-tip="${tip}" data-subj="${esc(n)}"></i>`;
    }).join("");
    $("subjList").innerHTML = rows.map(([n, v]) => {
      const pct = Math.round((v / agg.total) * 100);
      const days = agg.subjDays.get(n) || 0;
      const ses = agg.sessions.get(n) || 0;
      const c = P.colorFor(n);
      return `<div class="srow" data-subj="${esc(n)}">
        <div class="s-name"><i style="background:${c}"></i><span>${esc(n)}</span></div>
        <div class="s-bar"><span style="width:${(v / max) * 100}%;background:${c}"></span></div>
        <div class="s-time">${hm(v)}</div>
        <div class="s-pct">${pct}%</div>
        <div class="s-meta">${days}일 공부 · 하루 평균 ${hm(v / days)}${ses ? ` · 타이머 ${ses}회` : ""}</div>
      </div>`;
    }).join("");
  }

  // ---------- 시간대별 ----------
  function renderHours(agg) {
    const order = Array.from({ length: 24 }, (_, i) => (P.DAY_START_HOUR + i) % 24);
    const max = Math.max(...agg.hours);
    const peak = max > 0 ? agg.hours.indexOf(max) : -1;
    $("hourSub").textContent = peak >= 0 ? `가장 집중한 시간 ${hourName(peak)}` : "";
    const bars = order.map((h) => {
      const v = agg.hours[h];
      const tip = addTip(`<div class="tip-t">${hourName(h)} – ${hourName((h + 1) % 24)}</div><div class="tip-r"><span>공부</span><em>${hm(v)}</em></div>`);
      return `<span class="hb${h === peak ? " peak" : ""}" data-tip="${tip}" data-part="hour"><i style="height:${max ? Math.max(v ? 3 : 0, (v / max) * 100) : 0}%"></i></span>`;
    }).join("");
    const marks = { 6: "오전 6시", 12: "정오", 18: "오후 6시", 0: "자정" };
    const labels = order.map((h) => `<span>${marks[h] || ""}</span>`).join("");
    const hc = P.store.prefs.hourColor || HOUR_BASE;
    $("hourChart").style.setProperty("--hour", hc);
    $("hourChart").style.setProperty("--hour-peak", P.store.prefs.hourColor ? mix(hc, "#000000", 0.28) : "#9a9a95");
    $("hourChart").innerHTML = `<div class="hplot">${bars}${max ? "" : '<div class="st-empty">타이머 기록이 없어요</div>'}</div><div class="hxl">${labels}</div>`;
  }

  // ---------- 공부 달력 ----------
  function level(sec) {
    if (sec <= 0) return 0;
    const h = sec / 3600;
    for (let i = HEAT_STEPS.length - 1; i >= 0; i--) if (h > HEAT_STEPS[i]) return i + 1;
    return 1;
  }

  function renderHeat(r, agg, now) {
    const today = P.toKey(new Date(now));
    const short = (sec) => { sec = Math.round(sec); return sec >= 60 ? `${Math.floor(sec / 3600)}:${P.pad(Math.floor((sec % 3600) / 60))}` : ""; };
    HEAT = heatRamp();
    $("heatLegend").dataset.part = "heat";
    $("heatLegend").innerHTML = `<span>적게</span>${HEAT.slice(1).map((c) => `<i style="background:${c}"></i>`).join("")}<span>많이</span>`;

    const cell = (k, cls, inner = "") => {
      const s = agg.per.get(k);
      const t = s ? s.total : 0;
      const tip = addTip(tipHtml(`${md(k)} · ${hm(t)}`, s ? fold(s.subj).map(([n, v]) => [n, v, seriesColor(n)]) : []));
      const fut = k > today ? " future" : "";
      return `<button class="${cls}${fut}${k === today ? " now" : ""}" style="background:${HEAT[level(t)]}" data-tip="${tip}" data-key="${k}" aria-label="${md(k)} ${hm(t)}">${inner}</button>`;
    };

    const dayCell = (k) => {
      const t = agg.per.get(k)?.total || 0;
      return cell(k, "cal-d", `<span>${P.fromKey(k).getDate()}</span>${t >= 60 ? `<em>${short(t)}</em>` : ""}`);
    };

    if (period === "week") {
      $("heatTitle").textContent = "WEEKLY";
      $("heatmap").className = "cal week-cal";
      $("heatmap").innerHTML = DOW.map((d) => `<span class="cal-h">${d}</span>`).join("") + r.days.map(dayCell).join("");
    } else if (period === "month") {
      $("heatTitle").textContent = "CALENDAR";
      const lead = P.weekIdx(r.start);
      let html = DOW.map((d) => `<span class="cal-h">${d}</span>`).join("");
      html += "<span></span>".repeat(lead);
      html += r.days.map(dayCell).join("");
      const rows = Math.ceil((lead + r.days.length) / 7);
      $("heatmap").className = "cal";
      $("heatmap").style.gridTemplateRows = `24px repeat(${rows}, 1fr)`;
      $("heatmap").innerHTML = html;
    } else {
      $("heatTitle").textContent = "YEAR";
      const first = P.addDays(r.start, -P.weekIdx(r.start));
      const weeks = [];
      for (let w = first; w <= r.end; w = P.addDays(w, 7)) weeks.push(w);
      let months = "", lastM = -1;
      const colsHtml = weeks.map((w, wi) => {
        const days = Array.from({ length: 7 }, (_, i) => P.addDays(w, i));
        const inYear = days.find((k) => k >= r.start && k <= r.end);
        const m = P.fromKey(inYear).getMonth();
        if (m !== lastM && P.fromKey(inYear).getDate() <= 7) {
          months += `<span style="grid-column:${wi + 1}">${m + 1}월</span>`;
          lastM = m;
        }
        return `<div class="gw">${days.map((k) => (k < r.start || k > r.end) ? "<span></span>" : cell(k, "gd")).join("")}</div>`;
      }).join("");
      $("heatmap").className = "grass";
      $("heatmap").innerHTML = `
        <div class="grass-in" style="--w:${weeks.length}">
          <div class="gm">${months}</div>
          <div class="gbody"><div class="gdow"><span>월</span><span></span><span>수</span><span></span><span>금</span><span></span><span></span></div>${colsHtml}</div>
        </div>`;
    }
    if (period !== "month") $("heatmap").style.gridTemplateRows = "";
  }

  function renderDday(now) {
    const dd = P.store.dday;
    const box = $("stDday");
    box.classList.toggle("unset", !dd || !dd.date);
    if (!dd || !dd.date) { $("stDdayLabel").textContent = "D-DAY"; $("stDdayNum").textContent = ""; return; }
    const diff = Math.round((P.fromKey(dd.date) - P.fromKey(P.toKey(new Date(now)))) / 86400000);
    $("stDdayLabel").textContent = dd.label || dd.date;
    $("stDdayNum").textContent = diff === 0 ? "D-DAY" : diff > 0 ? `D-${diff}` : `D+${-diff}`;
  }

  // ---------- 전체 렌더 ----------
  function render() {
    tips = [];
    const now = Date.now();
    const r = range();
    const agg = aggregate(r.days, now);

    // 비교용 이전 기간
    const saved = anchor;
    shiftAnchorOnly(-1);
    const prevTotal = aggregate(range().days, now).total;
    anchor = saved;

    document.querySelectorAll("#periodTabs button").forEach((b) => b.classList.toggle("on", b.dataset.p === period));
    $("periodLabel").textContent = periodLabel(r);
    $("stNow").textContent = NOW_WORD[period];
    const today = P.toKey(new Date(now));
    $("stNow").hidden = today >= r.start && today <= r.end;

    renderTiles(r, agg, prevTotal, now);
    renderBars(r, agg, now);
    renderSubjects(r, agg);
    renderHours(agg);
    renderHeat(r, agg, now);
    renderDday(now);
  }

  function shiftAnchorOnly(n) {
    const a = P.fromKey(anchor);
    if (period === "week") anchor = P.addDays(anchor, 7 * n);
    else if (period === "month") anchor = P.toKey(new Date(a.getFullYear(), a.getMonth() + n, 1));
    else anchor = P.toKey(new Date(a.getFullYear() + n, 0, 1));
  }

  // ---------- 이벤트 ----------
  $("periodTabs").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-p]");
    if (!b || b.dataset.p === period) return;
    period = b.dataset.p;
    render();
  });
  $("stPrev").addEventListener("click", () => shift(-1));
  $("stNext").addEventListener("click", () => shift(1));
  $("stNow").addEventListener("click", () => { anchor = P.toKey(new Date()); render(); });

  $("statsView").addEventListener("click", (e) => {
    if (e.target.closest('[data-act="goal"]')) { document.querySelector(".settings-btn").click(); return; }
    // 도구 막대에서 고른 색으로 칠하기 (지우개면 원래 색)
    const subj = e.target.closest("[data-subj]");
    if (subj) { hideTip(); P.setSubjectColor(subj.dataset.subj, P.fillColor()); return; }
    const part = e.target.closest("[data-part]");
    if (part) {
      const key = part.dataset.part === "hour" ? "hourColor" : "heatColor";
      const c = P.fillColor();
      if (c) P.store.prefs[key] = c; else delete P.store.prefs[key];
      P.save(); hideTip(); render();
      P.toast(c ? (key === "hourColor" ? "시간대 막대 색을 바꿨어요" : "달력 색을 바꿨어요") : "원래 색으로 돌렸어요");
      return;
    }
    const b = e.target.closest("[data-key]");
    if (!b) return;
    if (period === "year") {
      period = "month"; anchor = b.dataset.key; render(); return;
    }
    hideTip();
    P.openDay(b.dataset.key);
  });

  // 툴팁
  const tip = $("tip");
  function hideTip() { tip.hidden = true; }
  function place(e) {
    const pad = 12, w = tip.offsetWidth, h = tip.offsetHeight;
    let x = e.clientX + pad, y = e.clientY - h - pad;
    if (x + w > innerWidth - 8) x = e.clientX - w - pad;
    if (x < 8) x = 8;
    if (y < 8) y = e.clientY + pad;
    tip.style.transform = `translate(${x}px, ${y}px)`;
  }
  $("statsView").addEventListener("pointerover", (e) => {
    const el = e.target.closest("[data-tip]");
    if (!el) return;
    tip.innerHTML = tips[+el.dataset.tip] || "";
    tip.hidden = false;
    place(e);
  });
  $("statsView").addEventListener("pointermove", (e) => { if (!tip.hidden) place(e); });
  $("statsView").addEventListener("pointerout", (e) => {
    const el = e.target.closest("[data-tip]");
    if (el && !el.contains(e.relatedTarget)) hideTip();
  });
  window.addEventListener("scroll", hideTip, { passive: true });

  window.Stats = { render };
})();
