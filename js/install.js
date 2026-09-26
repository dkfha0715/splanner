(() => {
  "use strict";

  // 앱 설치 안내
  // - 안드로이드 · PC 크롬/엣지: 브라우저 설치 창을 바로 띄움
  // - 아이폰 · 아이패드: 설치 버튼이 따로 없어서 "공유 → 홈 화면에 추가"를 그림으로 안내
  // - 카카오톡 · 인스타그램 등 앱 안 브라우저: 설치가 안 되므로 Safari/크롬으로 열도록 안내
  // - 이미 설치한 앱으로 열었으면 아무것도 띄우지 않음

  const $ = (id) => document.getElementById(id);
  const DISMISS_KEY = "splanner.installDismissed";
  const DISMISS_DAYS = 7;

  const ua = navigator.userAgent;
  const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  const isIOS = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const isAndroid = /Android/i.test(ua);
  const isKakao = /KAKAOTALK/i.test(ua);
  const inApp = isKakao || /Instagram|FBAN|FBAV|Line\/|NAVER\(inapp|DaumApps/i.test(ua);

  let deferred = null; // 안드로이드 · PC 크롬의 설치 창

  function dismissedRecently() {
    try {
      const t = +localStorage.getItem(DISMISS_KEY);
      return t && Date.now() - t < DISMISS_DAYS * 86400000;
    } catch (e) { return false; }
  }

  function showBar() {
    if (standalone || dismissedRecently()) return;
    $("installText").textContent = inApp
      ? "여기서는 설치가 안 돼요 · Safari나 크롬으로 열어 주세요"
      : "홈 화면에서 전체 화면 앱으로 열려요";
    $("installBtn").textContent = inApp ? "브라우저로 열기" : "설치";
    $("installBar").hidden = false;
  }
  function hideBar() { $("installBar").hidden = true; }

  function openGuide() {
    const steps = $("installSteps");
    let html;
    if (inApp) {
      html = `
        <li><b>${isKakao ? "오른쪽 아래 ⋯ (더보기)" : "오른쪽 위 ⋯ (더보기)"}</b>를 누르세요.</li>
        <li><b>${isIOS ? "Safari로 열기" : "다른 브라우저로 열기"}</b>를 고르세요.</li>
        <li>열린 ${isIOS ? "Safari" : "크롬"}에서 이 안내를 다시 따라 하면 설치돼요.</li>`;
    } else if (isIOS) {
      html = `
        <li>주소창 옆 <span class="ig-icon">${SHARE}</span> <b>공유</b>를 누르세요.<small>${/iPad/.test(ua) || navigator.maxTouchPoints > 1 && !/iPhone/.test(ua) ? "아이패드: 화면 오른쪽 위" : "아이폰: 화면 아래 가운데"} · 안 보이면 화면 맨 위를 한 번 톡</small></li>
        <li>메뉴를 아래로 내려 <span class="ig-icon">${ADD}</span> <b>홈 화면에 추가</b>를 누르세요.<small>없으면 맨 아래 '동작 편집…'에서 켜기</small></li>
        <li>오른쪽 위 <b>추가</b>를 누르면 끝! 홈 화면의 Splanner로 여세요.</li>`;
    } else if (isAndroid) {
      html = `
        <li>크롬 오른쪽 위 <b>⋮</b> (더보기)를 누르세요.</li>
        <li><b>앱 설치</b> 또는 <b>홈 화면에 추가</b>를 누르세요.</li>
        <li><b>설치</b>를 누르면 끝! 홈 화면의 Splanner로 여세요.</li>`;
    } else {
      html = `
        <li>크롬이나 엣지 주소창 오른쪽의 <b>설치 아이콘</b>(⊕ 또는 컴퓨터 모양)을 누르세요.</li>
        <li>또는 메뉴 ⋮ → <b>앱 설치</b> / <b>앱으로 설치</b>.</li>`;
    }
    steps.innerHTML = html;
    $("installDialog").showModal();
  }

  async function install() {
    if (inApp) {
      // 카카오톡은 바깥 브라우저로 여는 주소를 지원한다
      if (isKakao) { location.href = "kakaotalk://web/openExternal?url=" + encodeURIComponent(location.href); return; }
      openGuide();
      return;
    }
    if (deferred) {
      deferred.prompt();
      const choice = await deferred.userChoice.catch(() => null);
      deferred = null;
      if (choice && choice.outcome === "accepted") hideBar();
      return;
    }
    openGuide();
  }

  const SHARE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12M8 7l4-4 4 4"/><path d="M7 11H5.5A1.5 1.5 0 0 0 4 12.5v7A1.5 1.5 0 0 0 5.5 21h13a1.5 1.5 0 0 0 1.5-1.5v-7a1.5 1.5 0 0 0-1.5-1.5H17"/></svg>';
  const ADD = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><rect x="3.5" y="3.5" width="17" height="17" rx="4"/><path d="M12 8v8M8 12h8"/></svg>';

  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferred = e;
    showBar();
  });
  window.addEventListener("appinstalled", () => {
    hideBar();
    window.Planner?.toast("Splanner가 설치됐어요 · 홈 화면에서 열어 보세요");
  });

  $("installBtn").addEventListener("click", install);
  $("installClose").addEventListener("click", () => {
    hideBar();
    try { localStorage.setItem(DISMISS_KEY, String(Date.now())); } catch (e) { /* 무시 */ }
  });
  // 설정 창의 "앱으로 설치" (설치 안 한 상태에서만 보임)
  $("installFromSettings").hidden = standalone;
  $("installFromSettings").addEventListener("click", () => { $("settingsDialog").close(); install(); });

  // 휴대폰 · 태블릿은 설치 창 이벤트가 없거나 늦을 수 있으니 직접 띄운다 (누르면 설치 창 또는 안내)
  if (!standalone && (isIOS || isAndroid || inApp)) setTimeout(showBar, 1200);
})();
