// 음식점 사이트용 네이버 검색 프록시 (Cloudflare Workers)
//
// 왜 필요한가: 네이버 검색 API는 Client Secret이 필요하고 브라우저에서 직접 부를 수 없어서(CORS),
// Secret을 서버 쪽(이 Worker의 환경 변수)에만 두고 사이트는 이 Worker를 부릅니다.
//
// 2026-07-31부터 네이버 개발자센터(developers.naver.com)의 검색 API 신규 신청이 종료되어,
// 네이버 클라우드 플랫폼의 NAVER API HUB 검색 API를 사용합니다.
//
// 설정: Cloudflare 대시보드 → Workers → 이 코드 붙여 넣기 → Settings → Variables and Secrets에
//   NAVER_CLIENT_ID     = NAVER API HUB 애플리케이션의 Client ID
//   NAVER_CLIENT_SECRET = 같은 애플리케이션의 Client Secret (Secret 타입으로 저장)
// NAVER API HUB 애플리케이션에서 '지역 검색'과 '블로그 검색' 두 API를 모두 골라 두어야 합니다.
//
// 주소:
//   ?query=비산동 돈카츠           → 지역 검색 (식당 5곳)
//   ?type=blog&query=가게이름 혼밥  → 블로그 검색 (혼밥 후기 확인용, 30개. 블로거 이름 등은 빼고 돌려줌)
// /health → 버전 확인,  /health?check=1 → 네이버 지역·블로그 검색이 실제로 되는지 확인 (관리패널 현황에서 사용, 1분 동안 기억)

const VERSION = "2.3";
// 사이트 주소 (GitHub Pages 예비 주소 + Cloudflare Pages 주소와 그 미리보기 주소)
const ALLOWED = ["https://4tpk7p297h-code.github.io", "https://song-meal.pages.dev"];
const isAllowed = (o, env) => !!o && (ALLOWED.includes(o) || /^https:\/\/[a-z0-9-]+\.song-meal\.pages\.dev$/.test(o) || (!!env.DEV_ORIGIN && o === env.DEV_ORIGIN));
const API = "https://naverapihub.apigw.ntruss.com/search/v1/";

// 같은 검색은 잠시 기억 (지역 30분, 블로그 6시간) → 네이버 호출 수를 줄임
const MEMO = new Map();
function remember(key, body, ms) {
  if (MEMO.size > 500) MEMO.delete(MEMO.keys().next().value);
  MEMO.set(key, { body, until: Date.now() + ms });
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin");
    const cors = {
      "Access-Control-Allow-Origin": isAllowed(origin, env) ? origin : ALLOWED[0],
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Vary": "Origin",
    };
    const url = new URL(request.url);
    const json = (body, status = 200, extra = {}) => new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status, headers: { ...cors, "Content-Type": "application/json; charset=utf-8", ...extra },
    });
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });
    const keys = { "X-NCP-APIGW-API-KEY-ID": env.NAVER_CLIENT_ID, "X-NCP-APIGW-API-KEY": env.NAVER_CLIENT_SECRET };
    if (url.pathname === "/health") {
      const info = { ok: true, version: VERSION, blog: true };
      if (url.searchParams.get("check") !== "1") return json(info);
      let chk = MEMO.get("health");
      if (!chk || chk.until < Date.now()) {
        const test = (path) => fetch(API + path, { headers: keys }).then(async (r) => { try { await r.arrayBuffer(); } catch {} return r.ok ? "ok" : String(r.status); }, () => "network");
        const [local, blogApi] = await Promise.all([
          test("local?display=1&query=" + encodeURIComponent("서울역 국밥")),
          test("blog?display=1&query=" + encodeURIComponent("혼밥")),
        ]);
        remember("health", { local, blogApi, keys: !!(env.NAVER_CLIENT_ID && env.NAVER_CLIENT_SECRET) }, 60e3);
        chk = MEMO.get("health");
      }
      return json({ ...info, ...chk.body });
    }

    if (!isAllowed(origin, env)) return new Response("forbidden", { status: 403, headers: cors });

    const type = url.searchParams.get("type") === "blog" ? "blog" : "local";
    const query = (url.searchParams.get("query") || "").trim();
    if (!query || query.length > 100) return new Response("bad query", { status: 400, headers: cors });

    const key = type + "|" + query;
    const hit = MEMO.get(key);
    const maxAge = type === "blog" ? 21600 : 300;
    if (hit && hit.until > Date.now()) return json(hit.body, 200, { "Cache-Control": `public, max-age=${maxAge}`, "X-Cache": "HIT" });

    const api = type === "blog"
      ? API + "blog?display=30&sort=sim&query=" + encodeURIComponent(query)
      : API + "local?display=5&sort=random&query=" + encodeURIComponent(query);
    let res;
    try {
      res = await fetch(api, { headers: keys });
    } catch {
      return json(type === "blog" ? { kind: "blog", error: "네이버에 연결하지 못했어요." } : { error: "네이버에 연결하지 못했어요." }, 502);
    }

    if (type === "local") {
      const body = await res.text();
      if (res.ok) remember(key, body, 30 * 60e3);
      return json(body, res.status, { "Cache-Control": `public, max-age=${maxAge}` });
    }

    // 블로그: 혼밥 판단에 필요한 칸만 돌려줌
    if (!res.ok) return json({ kind: "blog", error: `네이버 블로그 검색 오류 (${res.status})`, status: res.status }, 502);
    let d;
    try { d = await res.json(); } catch { return json({ kind: "blog", error: "블로그 검색 응답을 읽지 못했어요." }, 502); }
    const body = JSON.stringify({
      kind: "blog", total: d.total || 0,
      items: (d.items || []).map((it) => ({ title: it.title || "", description: it.description || "", link: it.link || "", postdate: it.postdate || "" })),
    });
    remember(key, body, 6 * 3600e3);
    return json(body, 200, { "Cache-Control": `public, max-age=${maxAge}` });
  },
};
