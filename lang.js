// 비트밥스 다국어 (v2.17): 화면에 보이는 글자만 고른 언어로 바꿔 줌.
// 곡 검색·추천 계산 같은 로직은 한국어 그대로 동작하고, 화면에 그려진 뒤 글자만 바뀜.
//  - TR_HTML: 굵은 글씨·링크가 섞인 문단은 요소의 innerHTML 통째로 바꿈 (안에 id 달린 요소가 없을 때만)
//  - TR: 글자 조각(텍스트 노드) 하나가 통째로 같으면 바꿈
//  - RULES: 숫자·이름이 들어간 문장은 정규식으로 바꿈
//  - 사람이 쓴 글(후기, 닉네임, 곡·가게 이름 등)은 translate="no" 안에 있으면 건드리지 않음
(function () {
  const LANGS = ["ko", "en", "ja", "zh"];
  const D = window.I18N_DATA || { TR: {}, TR_HTML: {}, RULES: [] };
  let L = 0;   // 0=ko, 1=en, 2=ja, 3=zh
  try { const l = localStorage.getItem("food.lang"); if (LANGS.includes(l)) L = LANGS.indexOf(l); } catch {}
  const ORIG = new WeakMap(), MINE = new WeakMap();      // 텍스트 노드 → 원래 한국어 / 우리가 쓴 번역
  const ORIG_H = new WeakMap(), MINE_H = new WeakMap();  // 요소 innerHTML
  const ORIG_A = new WeakMap();                           // 요소 → { 속성: 원래 한국어 }
  const ATTRS = ["placeholder", "title", "aria-label", "alt"];
  const HAS_KO = /[가-힣]/;
  const INLINE = new Set(["B", "STRONG", "SPAN", "SMALL", "A", "EM", "I", "LABEL", "SUMMARY"]);
  const BLOCKOK = new Set(["P", "LI", "TD", "TH", "H1", "H2", "H3", "H4", "DIV", "DT", "DD", "BUTTON", "FIGCAPTION", "LEGEND", "CAPTION", "OPTION"]);
  const norm = (s) => s.replace(/\s+/g, " ").trim();
  const miss = new Set(); window.__i18nMiss = miss;

  // 한국어 문장 하나를 고른 언어로 (없으면 null)
  function tr(ko) {
    if (!L || !ko || !HAS_KO.test(ko)) return null;
    const k = norm(ko);
    const hit = D.TR[k]; if (hit && hit[L - 1] != null) return hit[L - 1];
    for (const [rx, fn] of D.RULES) {
      const m = rx.exec(k); if (!m) continue;
      const out = fn(m, L, word);
      if (out != null) return out;
    }
    return null;
  }
  // 문장 안의 낱말(메뉴 이름 등): 사전에 있으면 번역, 없으면 원문
  function word(ko) { const t = tr(ko); return t == null ? ko : t; }
  function trText(ko) {
    const t = tr(ko);
    if (t == null) { if (L && HAS_KO.test(ko)) miss.add(norm(ko)); return ko; }
    const lead = ko.match(/^\s*/)[0], tail = ko.match(/\s*$/)[0];   // 앞뒤 띄어쓰기 유지
    return lead + t + tail;
  }
  const skip = (el) => !el || el.closest('[translate="no"], script, style, textarea, .notr');

  function doText(n) {
    if (skip(n.parentElement)) return;
    let ko = ORIG.get(n);
    if (ko == null || n.data !== MINE.get(n)) { ko = n.data; ORIG.set(n, ko); }   // 앱이 글자를 새로 썼으면 그게 원문
    if (!HAS_KO.test(ko)) return;
    const out = L ? trText(ko) : ko;
    MINE.set(n, out);
    if (n.data !== out) n.data = out;
  }
  function doAttrs(el) {
    if (!el || el.closest('[translate="no"], script, style, .notr')) return;   // 글 입력 칸(textarea)의 안내 문구는 번역
    let o = ORIG_A.get(el);
    for (const a of ATTRS) {
      const v = el.getAttribute(a); if (v == null) continue;
      if (!o) { o = {}; ORIG_A.set(el, o); }
      if (!(a in o) || (v !== o[a] && v !== o["_" + a])) o[a] = v;   // 앱이 바꾼 값이면 새 원문
      if (!HAS_KO.test(o[a])) continue;
      const out = L ? (tr(o[a]) ?? (miss.add(norm(o[a])), o[a])) : o[a];
      o["_" + a] = out;
      if (v !== out) el.setAttribute(a, out);
    }
  }
  // 굵은 글씨 등이 섞인 문단: innerHTML 통째로
  function doHTML(el) {
    if (el.children.length === 0 || el.children.length > 12 || !INLINE.has(el.tagName) && !BLOCKOK.has(el.tagName)) return false;
    if (el.innerHTML.length > 1500 || skip(el) || el.querySelector(":not(b, strong, i, em, small, a, br, code, span, u, sub, sup, mark)") || el.querySelector("[id]")) return false;
    let ko = ORIG_H.get(el);
    if (ko == null || el.innerHTML !== MINE_H.get(el)) { ko = el.innerHTML; ORIG_H.set(el, ko); }
    const k = norm(ko);
    const hit = D.TR_HTML[k];
    if (!hit) return false;
    const out = L ? (hit[L - 1] ?? ko) : ko;
    MINE_H.set(el, out);
    if (el.innerHTML !== out) el.innerHTML = out;
    return true;
  }
  function walk(root) {
    if (!root) return;
    if (root.nodeType === 3) { doText(root); return; }
    if (root.nodeType !== 1) return;
    if (root.tagName === "TEXTAREA") { doAttrs(root); return; }   // 글 입력 칸: 안내 문구(placeholder)만
    if (skip(root)) return;
    doAttrs(root);
    if (doHTML(root)) return;
    for (let c = root.firstChild; c; c = c.nextSibling) walk(c);
  }
  let busy = false;
  const mo = new MutationObserver((list) => {
    if (busy) return;
    busy = true;
    try {
      for (const m of list) {
        if (m.type === "characterData") doText(m.target);
        else if (m.type === "attributes") doAttrs(m.target);
        else {
          // 요소 안 내용이 바뀌면 그 요소부터 다시 (TR_HTML 대상일 수 있어서)
          if (m.target.nodeType === 1 && ORIG_H.has(m.target)) walk(m.target);
          m.addedNodes.forEach(walk);
        }
      }
    } finally { mo.takeRecords(); busy = false; }
  });
  function start() {
    walk(document.body);
    mo.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  }
  window.I18 = {
    LANGS,
    get lang() { return LANGS[L]; },
    set(l) {
      const i = LANGS.indexOf(l); L = i < 0 ? 0 : i;
      try { localStorage.setItem("food.lang", LANGS[L]); } catch {}
      document.documentElement.lang = ["ko", "en", "ja", "zh-CN"][L];
      busy = true; try { walk(document.body); } finally { mo.takeRecords(); busy = false; }
    },
    t: (ko) => (L ? trText(ko) : ko),   // 스크립트에서 바로 번역이 필요할 때 (토스트 등은 DOM이라 자동)
  };
  document.documentElement.lang = ["ko", "en", "ja", "zh-CN"][L];
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
})();
