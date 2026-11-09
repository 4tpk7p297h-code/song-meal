// 음식점 사이트용 네이버 지역 검색 프록시 (Cloudflare Workers)
//
// 왜 필요한가: 네이버 검색 API는 Client Secret이 필요하고 브라우저에서 직접 부를 수 없어서(CORS),
// Secret을 서버 쪽(이 Worker의 환경 변수)에만 두고 사이트는 이 Worker를 부릅니다.
//
// 설정: Cloudflare 대시보드 → Workers → 이 코드 붙여 넣기 → Settings → Variables and Secrets에
//   NAVER_CLIENT_ID     = developers.naver.com 애플리케이션의 Client ID
//   NAVER_CLIENT_SECRET = 같은 애플리케이션의 Client Secret (Secret 타입으로 저장)

const ALLOWED_ORIGIN = "https://4tpk7p297h-code.github.io";

export default {
  async fetch(request, env) {
    const cors = {
      "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Vary": "Origin",
    };
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });

    const origin = request.headers.get("Origin");
    if (origin !== ALLOWED_ORIGIN) return new Response("forbidden", { status: 403, headers: cors });

    const query = new URL(request.url).searchParams.get("query") || "";
    if (!query || query.length > 100) return new Response("bad query", { status: 400, headers: cors });

    const api = "https://openapi.naver.com/v1/search/local.json?display=5&sort=random&query=" + encodeURIComponent(query);
    const res = await fetch(api, {
      headers: {
        "X-Naver-Client-Id": env.NAVER_CLIENT_ID,
        "X-Naver-Client-Secret": env.NAVER_CLIENT_SECRET,
      },
    });
    return new Response(await res.text(), {
      status: res.status,
      headers: { ...cors, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=300" },
    });
  },
};
