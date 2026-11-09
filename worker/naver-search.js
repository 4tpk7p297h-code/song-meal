// 음식점 사이트용 네이버 지역 검색 프록시 (Cloudflare Workers)
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

// 사이트 주소 (GitHub Pages 예비 주소 + Cloudflare Pages 주소와 그 미리보기 주소)
const ALLOWED = ["https://4tpk7p297h-code.github.io", "https://song-meal.pages.dev"];
const isAllowed = (o) => !!o && (ALLOWED.includes(o) || /^https:\/\/[a-z0-9-]+\.song-meal\.pages\.dev$/.test(o));

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin");
    const cors = {
      "Access-Control-Allow-Origin": isAllowed(origin) ? origin : ALLOWED[0],
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Vary": "Origin",
    };
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });

    if (!isAllowed(origin)) return new Response("forbidden", { status: 403, headers: cors });

    const query = new URL(request.url).searchParams.get("query") || "";
    if (!query || query.length > 100) return new Response("bad query", { status: 400, headers: cors });

    const api = "https://naverapihub.apigw.ntruss.com/search/v1/local?display=5&sort=random&query=" + encodeURIComponent(query);
    const res = await fetch(api, {
      headers: {
        "X-NCP-APIGW-API-KEY-ID": env.NAVER_CLIENT_ID,
        "X-NCP-APIGW-API-KEY": env.NAVER_CLIENT_SECRET,
      },
    });
    return new Response(await res.text(), {
      status: res.status,
      headers: { ...cors, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=300" },
    });
  },
};
