// 비트밥스 커뮤니티 API (Cloudflare Workers + D1)
// 회원가입·로그인, 후기(노래 + 음식 사진) 올리기, 좋아요, 코너별 순위, 신고, 회원 탈퇴
//
// 설정 (Cloudflare 대시보드)
//   1) D1 데이터베이스 song-meal-db 를 만들고 Console 에서 schema.sql 실행
//   2) Worker song-meal-api 를 만들고 이 코드를 붙여 넣기
//   3) Worker → Settings → Bindings → D1 database 추가: 변수 이름 DB, 데이터베이스 song-meal-db
//   4) (선택) Worker → Settings → Variables and Secrets 에 Secret 으로 추가하면 곡 검색에 함께 쓰임
//        SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET (Spotify),  LASTFM_API_KEY (Last.fm)
//      키가 없어도 MusicBrainz·Wikidata(키 필요 없음)는 항상 함께 비교함 → 맨 아래 '곡 정보' 부분
//
//   6) (선택) 노래 추천의 가게 사진 AI 분석 + 메뉴 추천의 곡 교차검증·분석: Secret 으로 GEMINI_API_KEY (Google AI Studio 무료 키)
//        AI가 고른 곡은 Deezer(키 필요 없음)에서, 없으면 Spotify(키를 넣었으면)에서 실제로 있는지 확인한 곡만 보여 줌
//        없거나 무료 한도를 넘으면 사이트가 브라우저 안 사진 색감 분석으로 대신함. 모델을 바꾸려면 Text 변수 GEMINI_MODEL
//
//   5) (선택) 카카오 로그인: Secret 으로 KAKAO_REST_KEY(REST API 키), KAKAO_CLIENT_SECRET(보안 → Client Secret 코드)
//        두 개가 모두 있으면 켜짐. KAKAO_ADMIN_KEY(어드민 키)도 넣으면 탈퇴할 때 카카오 연결도 함께 끊음
//        카카오 개발자 콘솔 Redirect URI: 이 Worker 주소 + /auth/kakao/callback
//
// 설정 확인: 브라우저에서 이 Worker 주소 뒤에 /health 를 붙여 열면 DB 연결과 곡 검색 서비스 상태가 보임
//
// 비밀번호는 PBKDF2-SHA256(사용자별 무작위 salt)으로 해시해서 저장하고, 원래 비밀번호는 저장하지 않습니다.
// 로그인 토큰도 해시만 저장합니다.

const ALLOWED = ["https://song-meal.pages.dev", "https://4tpk7p297h-code.github.io"];
const isAllowed = (o, env) =>
  !!o && (ALLOWED.includes(o) || /^https:\/\/[a-z0-9-]+\.song-meal\.pages\.dev$/.test(o) || (env.DEV_ORIGIN && o === env.DEV_ORIGIN));

// 관리자 아이디. 이 아이디는 회원가입으로 만들 수 없고, D1 콘솔에서만 만들 수 있음
const ADMINS = ["aiadmin"];
const RESERVED_LOGIN = /admin|root|manager|operator/;
const RESERVED_NICK = /관리자|운영자|admin/i;
const isAdmin = (login) => ADMINS.includes(login);

const KINDS = ["한식", "중식", "일식", "양식", "분식", "아시안", "카페·디저트"];
const ITER = 10000;                 // 무료 플랜 CPU 한도(10ms) 안에서 도는 반복 횟수
const SESSION_DAYS = 30;
const MAX_PHOTO = 700000;           // data URL 길이 (약 500KB JPEG)
const MAX_THUMB = 80000;
const HIDE_AT = 3;                  // 신고 3건이면 숨김
const POSTS_PER_DAY = 20;

const now = () => Date.now();
const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const randHex = (n) => hex(crypto.getRandomValues(new Uint8Array(n)));
const sha256 = async (s) => hex(await crypto.subtle.digest("SHA-256", enc.encode(s)));

async function pbkdf2(pw, salt) {
  const key = await crypto.subtle.importKey("raw", enc.encode(pw), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: enc.encode(salt), iterations: ITER }, key, 256);
  return hex(bits);
}
function sameHex(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

const str = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const safeUrl = (u) => {
  const s = str(u, 500);
  try {
    const x = new URL(s);
    return x.protocol === "https:" && /(^|\.)(mzstatic\.com|apple\.com|dzcdn\.net|deezer\.com|scdn\.co|coverartarchive\.org)$/.test(x.hostname) ? s : "";
  } catch { return ""; }
};

// 회원의 동의 기록 (users.prefs 열, JSON). 열이 아직 없으면(ALTER 전) 빈 값으로 동작
const cleanPrefs = (p, prev = {}) => ({
  abroad: !!p.abroad, geo: !!p.geo,
  agreedAt: prev.agreedAt || Date.now(), updatedAt: Date.now(),
});
async function getPrefs(DB, id) {
  try { const r = await DB.prepare("SELECT prefs FROM users WHERE id = ?").bind(id).first(); return JSON.parse((r && r.prefs) || "{}"); }
  catch { return {}; }
}
async function setPrefs(DB, id, prefs) {
  try { await DB.prepare("UPDATE users SET prefs = ? WHERE id = ?").bind(JSON.stringify(prefs), id).run(); return true; }
  catch { return false; }
}
function tempPassword() {
  const cs = "abcdefghjkmnpqrstuvwxyzACDEFGHJKLMNPQRSTUVWXYZ23456789";
  return [...crypto.getRandomValues(new Uint8Array(10))].map((b) => cs[b % cs.length]).join("");
}

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const fail = (status, msg) => { throw new HttpError(status, msg); };

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin");
    const cors = {
      "Access-Control-Allow-Origin": isAllowed(origin, env) ? origin : ALLOWED[0],
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Max-Age": "86400",
      "Vary": "Origin",
    };
    const json = (data, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: { ...cors, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    // 설정 확인용: 브라우저 주소창에서 /health 를 열면 DB 연결 상태를 보여 줌
    const pathname = new URL(request.url).pathname;
    if (pathname === "/health") {
      let db = "연결 안 됨 (Bindings에 DB 추가 필요)";
      if (env.DB) { try { await env.DB.prepare("SELECT COUNT(*) AS n FROM users").first(); db = "정상"; } catch { db = "연결됐지만 표가 없음 (schema.sql 실행 필요)"; } }
      const k = musicKeys(env);
      return json({ ok: true, version: MUSIC_VERSION, db, music: {
        MusicBrainz: "켜짐", Wikidata: "켜짐",
        Spotify: k.spotify ? "켜짐" : "꺼짐 (SPOTIFY_CLIENT_ID·SPOTIFY_CLIENT_SECRET 없음)",
        "Last.fm": k.lastfm ? "켜짐" : "꺼짐 (LASTFM_API_KEY 없음)",
      }, gemini: env.GEMINI_API_KEY ? "켜짐 (" + (env.GEMINI_MODEL || GEMINI_MODELS[0]) + ")" : "꺼짐 (GEMINI_API_KEY 없음)", kakao: kakaoOn(env) ? "켜짐" : "꺼짐 (KAKAO_REST_KEY·KAKAO_CLIENT_SECRET 없음)" });
    }
    // 카카오 로그인 시작·돌아오기 (브라우저가 페이지째 이동하므로 Origin 이 없음 → 허용 사이트 검사보다 먼저)
    if (pathname === "/auth/kakao/start" || pathname === "/auth/kakao/callback") {
      try { return await kakaoPage(request, env, pathname); }
      catch (e) { console.log("kakao", e && e.stack); return new Response("카카오 로그인 중 문제가 생겼어요.", { status: 500, headers: { "Content-Type": "text/plain; charset=utf-8" } }); }
    }
    if (!isAllowed(origin, env)) return json({ error: "허용되지 않은 사이트예요." }, 403);
    // 곡 정보 검색은 DB 없이도 동작
    if (pathname === "/music/search" && request.method === "GET") {
      if (tooMany(request.headers.get("CF-Connecting-IP") || "?")) return json({ error: "곡 검색을 너무 자주 했어요. 1분 뒤에 다시 해 주세요." }, 429);
      try { return json(await musicSearch(new URL(request.url).searchParams, env)); }
      catch (e) {
        if (e instanceof HttpError) return json({ error: e.message }, e.status);
        console.log("music", e && e.stack);
        return json({ error: "곡 정보 서버에서 문제가 생겼어요." }, 500);
      }
    }
    // 곡 분위기 태그 (Last.fm): 곡이 정해진 뒤 분석에만 씀. 곡 검색과는 따로
    if (pathname === "/music/mood" && request.method === "GET") {
      if (tooMany(request.headers.get("CF-Connecting-IP") || "?")) return json({ error: "너무 자주 요청했어요. 1분 뒤에 다시 해 주세요." }, 429);
      try { return json(await musicMood(new URL(request.url).searchParams, env)); }
      catch (e) { console.log("mood", e && e.stack); return json({ tags: [], error: "분위기 태그를 가져오지 못했어요." }); }
    }
    // 노래 추천(사장님용): 가게 사진·이름으로 Gemini가 분위기를 분석하고 노래 10곡을 고름. DB 없이 동작
    if (pathname === "/shop/vibe" && request.method === "POST") {
      if (!env.GEMINI_API_KEY) return json({ error: "off" }, 503);
      if (tooManyAI(request.headers.get("CF-Connecting-IP") || "?")) return json({ error: "limit" }, 429);
      try { return json(await shopVibe(await body(request), env)); }
      catch (e) {
        if (e instanceof HttpError) return json({ error: e.message }, e.status);
        console.log("vibe", e && e.stack);
        return json({ error: "fail" }, 502);
      }
    }
    // 노래 추천 예비 곡 실제 확인 (AI 키 없어도 됨)
    if (pathname === "/shop/verify" && request.method === "POST") {
      if (tooMany(request.headers.get("CF-Connecting-IP") || "?")) return json({ error: "busy" }, 429);
      try { return json(await shopVerify(await body(request), env)); } catch (e) { console.log("verify", e && e.stack); return json({ error: "fail" }, 502); }
    }
    // 메뉴 추천: 찾은 곡이 입력과 맞는지 Gemini 교차검증 + 곡 분석
    if (pathname === "/music/check" && request.method === "POST") {
      if (!env.GEMINI_API_KEY) return json({ error: "off" }, 503);
      if (tooManyAI(request.headers.get("CF-Connecting-IP") || "?")) return json({ error: "limit" }, 429);
      try { return json(await songCheck(await body(request), env)); }
      catch (e) {
        if (e instanceof HttpError) return json({ error: e.message }, e.status);
        console.log("check", e && e.stack); return json({ error: "fail" }, 502);
      }
    }
    // 곡 이름 이중 확인: 한국어로 쓴 곡의 Apple Music·해외 등록 이름(영어·로마자)을 Gemini에게 물어봄 → 브라우저가 그 이름으로 Apple 재검색
    if (pathname === "/music/alias" && request.method === "POST") {
      if (!env.GEMINI_API_KEY) return json({ error: "off" }, 503);
      if (tooManyAI(request.headers.get("CF-Connecting-IP") || "?")) return json({ error: "limit" }, 429);
      try { return json(await songAlias(await body(request), env)); }
      catch (e) {
        if (e instanceof HttpError) return json({ error: e.message }, e.status);
        console.log("alias", e && e.stack); return json({ error: "fail" }, 502);
      }
    }
    if (!env.DB) return json({ error: "서버에 데이터베이스(DB)가 연결되지 않았어요." }, 500);

    try {
      return json(await route(request, env));
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      console.log("error", e && e.stack);
      return json({ error: "서버에서 문제가 생겼어요. 잠시 후 다시 시도해 주세요." }, 500);
    }
  },
};

async function body(request) {
  try { return await request.json(); } catch { fail(400, "요청 형식이 올바르지 않아요."); }
}

async function currentUser(request, env, required) {
  const m = /^Bearer ([0-9a-f]{64})$/.exec(request.headers.get("Authorization") || "");
  if (m) {
    const row = await env.DB.prepare(
      "SELECT u.id, u.login, u.nick FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires > ?"
    ).bind(await sha256(m[1]), now()).first();
    if (row) return { ...row, admin: isAdmin(row.login), kakao: isKakao(row.login) };
  }
  if (required) fail(401, "로그인이 필요해요.");
  return null;
}

async function newSession(env, userId) {
  const token = randHex(32);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM sessions WHERE expires < ?").bind(now()),
    env.DB.prepare("INSERT INTO sessions (token_hash, user_id, expires) VALUES (?, ?, ?)").bind(await sha256(token), userId, now() + SESSION_DAYS * 864e5),
  ]);
  return token;
}

const POST_COLS = "p.id, p.song, p.art, p.preview, p.kind, p.menu, p.place, p.body, p.likes, p.created, p.user_id, u.nick";
const pub = (r, me, liked) => ({
  id: r.id, song: r.song, art: r.art, preview: r.preview, kind: r.kind, menu: r.menu, place: r.place, body: r.body,
  likes: r.likes, created: r.created, nick: r.nick, mine: !!me && me.id === r.user_id, liked: !!liked,
  canDelete: !!me && (me.id === r.user_id || !!me.admin),
  ...(r.thumb !== undefined ? { thumb: r.thumb } : {}), ...(r.photo !== undefined ? { photo: r.photo } : {}),
});

const MAX_COMMENTS = 200, COMMENTS_PER_HOUR = 30;
const cpub = (c, me, owner) => ({
  id: c.id, nick: c.nick, body: c.body, created: c.created, mine: !!me && me.id === c.user_id,
  canDelete: !!me && (me.id === c.user_id || me.id === owner || !!me.admin),
});

async function likedSet(env, me, ids) {
  if (!me || !ids.length) return new Set();
  const { results } = await env.DB.prepare(`SELECT post_id FROM likes WHERE user_id = ? AND post_id IN (${ids.map(() => "?").join(",")})`)
    .bind(me.id, ...ids).all();
  return new Set(results.map((r) => r.post_id));
}

// 회원과 그 회원의 글·좋아요·신고·세션을 모두 지움 (내가 누른 좋아요 수는 글에서 뺌)
async function deleteAccount(DB, uid) {
  // 댓글 표가 아직 없을 수도 있어서(DB 업데이트 전) 따로 지움
  try { await DB.prepare("DELETE FROM comments WHERE user_id = ? OR post_id IN (SELECT id FROM posts WHERE user_id = ?)").bind(uid, uid).run(); } catch {}
  try { await DB.prepare("DELETE FROM song_fb WHERE who = ?").bind("u" + uid).run(); } catch {}   // 곡 검색 피드백
  await DB.batch([
    DB.prepare("UPDATE posts SET likes = MAX(likes - 1, 0) WHERE id IN (SELECT post_id FROM likes WHERE user_id = ?)").bind(uid),
    DB.prepare("UPDATE posts SET reports = MAX(reports - 1, 0) WHERE id IN (SELECT post_id FROM reports WHERE user_id = ?)").bind(uid),
    DB.prepare("DELETE FROM likes WHERE user_id = ? OR post_id IN (SELECT id FROM posts WHERE user_id = ?)").bind(uid, uid),
    DB.prepare("DELETE FROM reports WHERE user_id = ? OR post_id IN (SELECT id FROM posts WHERE user_id = ?)").bind(uid, uid),
    DB.prepare("DELETE FROM posts WHERE user_id = ?").bind(uid),
    DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(uid),
    DB.prepare("DELETE FROM users WHERE id = ?").bind(uid),
  ]);
}

async function admin(request, env, me, path, M, url) {
  const DB = env.DB;
  let m;
  const num = (k, d = 0) => Math.max(0, +url.searchParams.get(k) || d);

  if (path === "/admin/stats" && M === "GET") {
    const one = async (sql) => (await DB.prepare(sql).first()).n;
    const day = Date.now() - 864e5;
    const [users, posts, likes, reported, hidden, newUsers, newPosts] = await Promise.all([
      one("SELECT COUNT(*) AS n FROM users"), one("SELECT COUNT(*) AS n FROM posts"), one("SELECT COUNT(*) AS n FROM likes"),
      one("SELECT COUNT(*) AS n FROM posts WHERE reports > 0 AND hidden = 0"), one("SELECT COUNT(*) AS n FROM posts WHERE hidden = 1"),
      one(`SELECT COUNT(*) AS n FROM users WHERE created > ${day}`), one(`SELECT COUNT(*) AS n FROM posts WHERE created > ${day}`),
    ]);
    const { results: byKind } = await DB.prepare("SELECT kind, COUNT(*) AS n, SUM(likes) AS likes FROM posts GROUP BY kind").all();
    let comments = null;
    try { comments = await one("SELECT COUNT(*) AS n FROM comments"); } catch {}
    return { users, posts, likes, reported, hidden, newUsers, newPosts, byKind, comments };
  }

  // 곡 검색 피드백: 입력별 맞음·틀림 수, 가장 많이 고른 정정, 관리자 상태(1 승인·-1 막음)
  if (path === "/admin/songfb" && M === "GET") {
    await fbTables(DB);
    const f = url.searchParams.get("filter") || "all";
    const { results } = await DB.prepare(
      `SELECT f.q, SUM(f.ok) AS oks, SUM(1 - f.ok) AS bads, MAX(f.created) AS last, x.state, x.a AS xa, x.t AS xt,
         (SELECT got FROM song_fb g WHERE g.q = f.q AND g.got != '' ORDER BY g.created DESC LIMIT 1) AS got
       FROM song_fb f LEFT JOIN song_fix x ON x.q = f.q GROUP BY f.q
       ${f === "bad" ? "HAVING SUM(1 - f.ok) > 0" : ""} ORDER BY last DESC LIMIT 101 OFFSET ?`
    ).bind(num("offset")).all();
    const rows = await Promise.all(results.slice(0, 100).map(async (r) => {
      const { results: fixes } = await DB.prepare(
        "SELECT fix_a AS a, fix_t AS t, COUNT(*) AS n FROM song_fb WHERE q = ? AND fix_t IS NOT NULL GROUP BY lower(fix_a), lower(fix_t) ORDER BY n DESC LIMIT 3"
      ).bind(r.q).all();
      let got = null; try { got = r.got ? JSON.parse(r.got) : null; } catch {}
      return { q: r.q, oks: r.oks, bads: r.bads, last: r.last, state: r.state || 0, set: r.xt ? { a: r.xa, t: r.xt } : null, got, fixes, live: await songFix(DB, r.q) };
    }));
    const one = async (sql) => (await DB.prepare(sql).first()).n;
    const [total, oks, inputs] = await Promise.all([one("SELECT COUNT(*) AS n FROM song_fb"), one("SELECT COUNT(*) AS n FROM song_fb WHERE ok = 1"), one("SELECT COUNT(DISTINCT q) AS n FROM song_fb")]);
    return { rows, more: results.length > 100, total, oks, inputs };
  }
  if (path === "/admin/songfix" && M === "POST") {
    await fbTables(DB);
    const b = await body(request), q = songKey(b.q), state = [1, -1, 0].includes(b.state) ? b.state : 0;
    if (!q) fail(400, "입력이 없어요.");
    if (state === 0) await DB.prepare("DELETE FROM song_fix WHERE q = ?").bind(q).run();
    else await DB.prepare("INSERT INTO song_fix (q, a, t, state, updated) VALUES (?, ?, ?, ?, ?) ON CONFLICT(q) DO UPDATE SET a = excluded.a, t = excluded.t, state = excluded.state, updated = excluded.updated")
      .bind(q, str(b.a, 80), str(b.t, 120), state, now()).run();
    return { ok: true, live: await songFix(DB, q) };
  }
  if (path === "/admin/songfb/delete" && M === "POST") {
    await fbTables(DB);
    const q = songKey((await body(request)).q);
    await DB.batch([DB.prepare("DELETE FROM song_fb WHERE q = ?").bind(q), DB.prepare("DELETE FROM song_fix WHERE q = ?").bind(q)]);
    return { ok: true };
  }

  if (path === "/admin/posts" && M === "GET") {
    const f = url.searchParams.get("filter") || "all";
    const q = (url.searchParams.get("q") || "").trim().slice(0, 40);
    const where = [], args = [];
    if (f === "reported") where.push("p.reports > 0 AND p.hidden = 0");
    if (f === "hidden") where.push("p.hidden = 1");
    if (q) { where.push("(u.nick LIKE ? OR u.login LIKE ? OR p.song LIKE ? OR p.menu LIKE ? OR p.place LIKE ?)"); for (let i = 0; i < 5; i++) args.push(`%${q}%`); }
    const { results } = await DB.prepare(
      `SELECT p.id, p.song, p.kind, p.menu, p.place, p.body, p.likes, p.reports, p.hidden, p.created, p.thumb, u.nick, u.login
       FROM posts p JOIN users u ON u.id = p.user_id ${where.length ? "WHERE " + where.join(" AND ") : ""}
       ORDER BY ${f === "reported" ? "p.reports DESC," : ""} p.created DESC LIMIT 31 OFFSET ?`
    ).bind(...args, num("offset")).all();
    return { posts: results.slice(0, 30), more: results.length > 30 };
  }

  if ((m = /^\/admin\/posts\/(\d+)\/hide$/.exec(path)) && M === "POST") {
    const id = +m[1];
    const b = await request.json().catch(() => ({}));
    if (b.hidden) await DB.prepare("UPDATE posts SET hidden = 1 WHERE id = ?").bind(id).run();
    else await DB.batch([   // 숨김 해제하면 신고 기록도 초기화
      DB.prepare("UPDATE posts SET hidden = 0, reports = 0 WHERE id = ?").bind(id),
      DB.prepare("DELETE FROM reports WHERE post_id = ?").bind(id),
    ]);
    return { ok: true };
  }

  if ((m = /^\/admin\/posts\/(\d+)\/reports$/.exec(path)) && M === "GET") {
    const { results } = await DB.prepare(
      "SELECT r.reason, r.created, u.nick, u.login FROM reports r LEFT JOIN users u ON u.id = r.user_id WHERE r.post_id = ? ORDER BY r.created DESC"
    ).bind(+m[1]).all();
    return { reports: results };
  }

  if (path === "/admin/users" && M === "GET") {
    const q = (url.searchParams.get("q") || "").trim().slice(0, 40);
    const { results } = await DB.prepare(
      `SELECT u.id, u.login, u.nick, u.created, u.locked_until,
        (SELECT COUNT(*) FROM posts WHERE user_id = u.id) AS posts,
        (SELECT COALESCE(SUM(likes), 0) FROM posts WHERE user_id = u.id) AS likes
       FROM users u ${q ? "WHERE u.login LIKE ? OR u.nick LIKE ?" : ""} ORDER BY u.created DESC LIMIT 51 OFFSET ?`
    ).bind(...(q ? [`%${q}%`, `%${q}%`] : []), num("offset")).all();
    return { users: results.slice(0, 50).map((u) => ({ ...u, admin: isAdmin(u.login) })), more: results.length > 50 };
  }

  if ((m = /^\/admin\/users\/(\d+)(\/[a-z-]+)?$/.exec(path))) {
    const uid = +m[1], act = m[2] || "";
    const u = await DB.prepare("SELECT id, login, nick FROM users WHERE id = ?").bind(uid).first();
    if (!u) fail(404, "없는 회원이에요.");
    if (isAdmin(u.login) && act !== "/nick") fail(400, "관리자 계정은 여기서 바꿀 수 없어요. 내 비밀번호 변경을 이용해 주세요.");
    if (act === "" && M === "DELETE") { await deleteAccount(DB, uid); if (isKakao(u.login)) await kakaoUnlink(env, u.login); return { ok: true }; }
    if (act === "/reset-password" && M === "POST") {
      if (isKakao(u.login)) fail(400, "카카오로 가입한 회원은 비밀번호가 없어요. 카카오로 로그인하면 돼요.");
      const temp = tempPassword(), salt = randHex(16);
      await DB.batch([
        DB.prepare("UPDATE users SET salt = ?, hash = ?, fails = 0, locked_until = 0 WHERE id = ?").bind(salt, await pbkdf2(temp, salt), uid),
        DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(uid),
      ]);
      return { temp };
    }
    if (act === "/unlock" && M === "POST") { await DB.prepare("UPDATE users SET fails = 0, locked_until = 0 WHERE id = ?").bind(uid).run(); return { ok: true }; }
    if (act === "/nick" && M === "POST") {
      const b = await request.json().catch(() => ({}));
      const nick = str(b.nick, 40);
      if (nick.length < 2 || nick.length > 12) fail(400, "닉네임은 2~12자로 해 주세요.");
      await DB.prepare("UPDATE users SET nick = ? WHERE id = ?").bind(nick, uid).run();
      return { ok: true };
    }
  }
  fail(404, "없는 관리자 기능이에요.");
}

// ---------- 카카오 로그인 ----------
// 카카오에서 받는 것은 회원번호(숫자) 하나뿐. 아이디는 "kakao:회원번호"로 저장 → 카카오 계정 1개당 사이트 계정 1개
const isKakao = (login) => typeof login === "string" && login.startsWith("kakao:");
const kakaoOn = (env) => !!(env.KAKAO_REST_KEY && env.KAKAO_CLIENT_SECRET);
const b64u = (s) => btoa(String.fromCharCode(...enc.encode(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = (s) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)));
async function hmac(env, s) {
  const key = await crypto.subtle.importKey("raw", enc.encode("kakao|" + env.KAKAO_CLIENT_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, enc.encode(s)));
}
// 서버만 만들 수 있는 짧은 표 (위조·기간 지난 표는 거절)
async function seal(env, obj, ms) {
  const p = b64u(JSON.stringify({ ...obj, exp: now() + ms }));
  return p + "." + await hmac(env, p);
}
async function unseal(env, t, use) {
  if (!kakaoOn(env) || typeof t !== "string" || t.length > 2000) return null;
  const [p, sig] = t.split(".");
  if (!p || !sig || !sameHex(await hmac(env, p), sig)) return null;
  try { const o = JSON.parse(unb64u(p)); return o.exp > now() && o.use === use ? o : null; } catch { return null; }
}
async function kakaoUnlink(env, login) {
  if (!env.KAKAO_ADMIN_KEY) return;
  try {
    await fetch("https://kapi.kakao.com/v1/user/unlink", { method: "POST",
      headers: { Authorization: "KakaoAK " + env.KAKAO_ADMIN_KEY, "Content-Type": "application/x-www-form-urlencoded;charset=utf-8" },
      body: new URLSearchParams({ target_id_type: "user_id", target_id: login.slice(6) }) });
  } catch {}
}
async function kakaoPage(request, env, pathname) {
  const url = new URL(request.url);
  const redirectUri = url.origin + "/auth/kakao/callback";
  const go = (to, cookie) => new Response(null, { status: 302, headers: { Location: to, "Cache-Control": "no-store",
    "Set-Cookie": cookie || "ks=; Path=/auth/kakao; Max-Age=0; HttpOnly; Secure; SameSite=Lax" } });
  const text = (msg, st = 400) => new Response(msg, { status: st, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  const siteBack = (b) => { try { const u = new URL(b); u.hash = ""; return isAllowed(u.origin, env) ? u.href : null; } catch { return null; } };

  if (pathname === "/auth/kakao/start") {
    const back = siteBack(url.searchParams.get("back") || "");
    if (!back) return text("허용되지 않은 사이트예요.", 403);
    if (!kakaoOn(env)) return go(back + "#kakao=error&m=" + encodeURIComponent("카카오 로그인이 아직 켜지지 않았어요."));
    const n = randHex(16);
    const state = await seal(env, { use: "state", back, n }, 10 * 60e3);
    const q = new URLSearchParams({ client_id: env.KAKAO_REST_KEY, redirect_uri: redirectUri, response_type: "code", state });
    return go("https://kauth.kakao.com/oauth/authorize?" + q, `ks=${n}; Path=/auth/kakao; Max-Age=600; HttpOnly; Secure; SameSite=Lax`);
  }

  // /auth/kakao/callback
  const st = await unseal(env, url.searchParams.get("state") || "", "state");
  if (!st) return text("카카오 로그인 시간이 지났어요. 사이트로 돌아가서 다시 시도해 주세요.");
  const back = siteBack(st.back);
  if (!back) return text("허용되지 않은 사이트예요.", 403);
  const err = (m) => go(back + "#kakao=error&m=" + encodeURIComponent(m));
  const ck = /(?:^|;\s*)ks=([0-9a-f]{32})/.exec(request.headers.get("Cookie") || "");
  if (!ck || !sameHex(ck[1], st.n)) return err("같은 브라우저에서 다시 시도해 주세요.");
  if (url.searchParams.get("error")) return err("카카오 로그인을 취소했어요.");
  const code = url.searchParams.get("code");
  if (!code) return err("카카오에서 확인 코드를 받지 못했어요.");
  let kid;
  try {
    const tr = await fetch("https://kauth.kakao.com/oauth/token", { method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded;charset=utf-8" },
      body: new URLSearchParams({ grant_type: "authorization_code", client_id: env.KAKAO_REST_KEY, client_secret: env.KAKAO_CLIENT_SECRET, redirect_uri: redirectUri, code }) });
    const tk = await tr.json().catch(() => ({}));
    if (!tr.ok || !tk.access_token) { console.log("kakao token", tr.status, tk.error, tk.error_code); return err("카카오 확인에 실패했어요. (" + (tk.error_code || tk.error || tr.status) + ")"); }
    const mr = await fetch("https://kapi.kakao.com/v2/user/me", { headers: { Authorization: "Bearer " + tk.access_token } });
    const me = await mr.json().catch(() => ({}));
    if (!mr.ok || !me.id) return err("카카오 회원 정보를 받지 못했어요.");
    kid = String(me.id);
    // 사이트는 카카오 토큰을 보관하지 않으므로 바로 로그아웃 처리
    fetch("https://kapi.kakao.com/v1/user/logout", { method: "POST", headers: { Authorization: "Bearer " + tk.access_token } }).catch(() => {});
  } catch (e) { console.log("kakao", e && e.stack); return err("카카오 서버에 연결하지 못했어요."); }
  if (!/^\d{1,20}$/.test(kid)) return err("카카오 회원 정보가 올바르지 않아요.");
  if (!env.DB) return err("서버에 데이터베이스(DB)가 연결되지 않았어요.");
  const u = await env.DB.prepare("SELECT id FROM users WHERE login = ?").bind("kakao:" + kid).first();
  if (u) return go(back + "#kakao=login&t=" + await seal(env, { use: "login", kid }, 2 * 60e3));
  return go(back + "#kakao=signup&t=" + await seal(env, { use: "signup", kid }, 15 * 60e3));
}

async function route(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const M = request.method;
  const DB = env.DB;
  let m;

  if (path === "/" || path === "/health") return { ok: true };

  // ---------- 회원 ----------
  if (path === "/signup" && M === "POST") {
    const b = await body(request);
    const login = str(b.login, 40).toLowerCase(), nick = str(b.nick, 40), pw = typeof b.pw === "string" ? b.pw : "";
    if (!b.agreeAge || !b.agreeCollect || !b.agreeAbroad || b.agreeRec === false) fail(400, "필수 항목에 모두 동의해 주세요.");
    if (!/^[a-z0-9_]{4,20}$/.test(login)) fail(400, "아이디는 영문 소문자·숫자·_ 4~20자로 만들어 주세요.");
    if (pw.length < 8 || pw.length > 72) fail(400, "비밀번호는 8자 이상으로 만들어 주세요.");
    if (pw.toLowerCase().includes(login)) fail(400, "비밀번호에 아이디를 넣지 말아 주세요.");
    if (nick.length < 2 || nick.length > 12) fail(400, "닉네임은 2~12자로 만들어 주세요.");
    if (RESERVED_LOGIN.test(login)) fail(400, "이 아이디는 쓸 수 없어요. 다른 아이디를 골라 주세요.");
    if (RESERVED_NICK.test(nick)) fail(400, "이 닉네임은 쓸 수 없어요. 다른 닉네임을 골라 주세요.");
    if (await DB.prepare("SELECT 1 FROM users WHERE login = ?").bind(login).first()) fail(409, "이미 쓰이는 아이디예요.");
    const salt = randHex(16);
    const res = await DB.prepare("INSERT INTO users (login, nick, salt, hash, created) VALUES (?, ?, ?, ?, ?)")
      .bind(login, nick, salt, await pbkdf2(pw, salt), now()).run();
    const id = res.meta.last_row_id;
    const prefs = cleanPrefs(b.prefs || {});
    await setPrefs(DB, id, prefs);
    return { token: await newSession(env, id), user: { id, login, nick, admin: false, prefs } };
  }

  // 카카오로 처음 가입: 돌아올 때 받은 표(ticket) + 닉네임 + 동의
  if (path === "/signup/kakao" && M === "POST") {
    if (!kakaoOn(env)) fail(400, "카카오 로그인이 아직 켜지지 않았어요.");
    const b = await body(request);
    const t = await unseal(env, b.ticket, "signup");
    if (!t) fail(400, "카카오 확인 시간이 지났어요. 카카오로 시작하기를 다시 눌러 주세요.");
    const nick = str(b.nick, 40), login = "kakao:" + t.kid;
    if (!b.agreeAge || !b.agreeCollect || !b.agreeAbroad || b.agreeRec === false) fail(400, "필수 항목에 모두 동의해 주세요.");
    if (nick.length < 2 || nick.length > 12) fail(400, "닉네임은 2~12자로 만들어 주세요.");
    if (RESERVED_NICK.test(nick)) fail(400, "이 닉네임은 쓸 수 없어요. 다른 닉네임을 골라 주세요.");
    if (await DB.prepare("SELECT 1 FROM users WHERE login = ?").bind(login).first()) fail(409, "이 카카오 계정으로 이미 가입했어요. 카카오로 시작하기를 다시 누르면 로그인돼요.");
    // 비밀번호가 없는 계정: 아무도 모르는 무작위 해시를 넣어 아이디·비밀번호 로그인은 불가능
    const res = await DB.prepare("INSERT INTO users (login, nick, salt, hash, created) VALUES (?, ?, ?, ?, ?)")
      .bind(login, nick, randHex(16), "kakao-" + randHex(32), now()).run();
    const id = res.meta.last_row_id;
    const prefs = cleanPrefs(b.prefs || {});
    await setPrefs(DB, id, prefs);
    return { token: await newSession(env, id), user: { id, login, nick, admin: false, kakao: true, prefs } };
  }

  // 카카오로 이미 가입한 사람: 돌아올 때 받은 표로 로그인 토큰 받기 (토큰이 주소창에 남지 않게)
  if (path === "/auth/kakao/login" && M === "POST") {
    const b = await body(request);
    const t = await unseal(env, b.ticket, "login");
    if (!t) fail(400, "카카오 확인 시간이 지났어요. 카카오로 시작하기를 다시 눌러 주세요.");
    const u = await DB.prepare("SELECT id, login, nick FROM users WHERE login = ?").bind("kakao:" + t.kid).first();
    if (!u) fail(404, "가입 정보가 없어요. 카카오로 시작하기를 다시 눌러 주세요.");
    return { token: await newSession(env, u.id), user: { id: u.id, login: u.login, nick: u.nick, admin: false, kakao: true, prefs: await getPrefs(DB, u.id) } };
  }

  if (path === "/login" && M === "POST") {
    const b = await body(request);
    const login = str(b.login, 40).toLowerCase(), pw = typeof b.pw === "string" ? b.pw : "";
    if (isKakao(login)) fail(401, "아이디 또는 비밀번호가 맞지 않아요.");
    const u = await DB.prepare("SELECT * FROM users WHERE login = ?").bind(login).first();
    if (!u) fail(401, "아이디 또는 비밀번호가 맞지 않아요.");
    if (u.locked_until > now()) fail(429, "로그인을 여러 번 실패해서 5분 동안 잠겼어요. 잠시 후 다시 시도해 주세요.");
    if (!sameHex(await pbkdf2(pw, u.salt), u.hash)) {
      const fails = u.fails + 1;
      await DB.prepare("UPDATE users SET fails = ?, locked_until = ? WHERE id = ?")
        .bind(fails >= 5 ? 0 : fails, fails >= 5 ? now() + 5 * 60e3 : 0, u.id).run();
      fail(401, "아이디 또는 비밀번호가 맞지 않아요.");
    }
    await DB.prepare("UPDATE users SET fails = 0, locked_until = 0 WHERE id = ?").bind(u.id).run();
    return { token: await newSession(env, u.id), user: { id: u.id, login: u.login, nick: u.nick, admin: isAdmin(u.login), kakao: false, prefs: await getPrefs(DB, u.id) } };
  }

  if (path === "/logout" && M === "POST") {
    const m2 = /^Bearer ([0-9a-f]{64})$/.exec(request.headers.get("Authorization") || "");
    if (m2) await DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256(m2[1])).run();
    return { ok: true };
  }

  if (path === "/me" && M === "GET") {
    const me = await currentUser(request, env, true);
    const { results } = await DB.prepare(`SELECT ${POST_COLS}, p.thumb, p.hidden FROM posts p JOIN users u ON u.id = p.user_id WHERE p.user_id = ? ORDER BY p.created DESC`)
      .bind(me.id).all();
    return { user: { ...me, prefs: await getPrefs(DB, me.id) }, posts: results.map((r) => ({ ...pub(r, me, false), hidden: !!r.hidden })) };
  }

  if (path === "/me/prefs" && M === "POST") {
    const me = await currentUser(request, env, true);
    const b = await body(request);
    const prefs = cleanPrefs(b, await getPrefs(DB, me.id));
    if (!(await setPrefs(DB, me.id, prefs))) fail(500, "동의 설정을 저장하지 못했어요. 관리자에게 DB 업데이트(prefs 열 추가)를 요청해 주세요.");
    return { prefs };
  }

  if (path === "/me/password" && M === "POST") {
    const me = await currentUser(request, env, true);
    const b = await body(request);
    const pw = typeof b.pw === "string" ? b.pw : "", np = typeof b.newPw === "string" ? b.newPw : "";
    if (me.kakao) fail(400, "카카오로 가입한 계정은 비밀번호가 없어요.");
    const u = await DB.prepare("SELECT salt, hash FROM users WHERE id = ?").bind(me.id).first();
    if (!sameHex(await pbkdf2(pw, u.salt), u.hash)) fail(401, "현재 비밀번호가 맞지 않아요.");
    if (np.length < 8 || np.length > 72) fail(400, "새 비밀번호는 8자 이상으로 만들어 주세요.");
    if (np.toLowerCase().includes(me.login)) fail(400, "비밀번호에 아이디를 넣지 말아 주세요.");
    const salt = randHex(16);
    const keep = /^Bearer ([0-9a-f]{64})$/.exec(request.headers.get("Authorization") || "");
    // 비밀번호를 바꾸면 지금 기기를 뺀 다른 기기의 로그인은 모두 끊음
    await DB.batch([
      DB.prepare("UPDATE users SET salt = ?, hash = ?, fails = 0, locked_until = 0 WHERE id = ?").bind(salt, await pbkdf2(np, salt), me.id),
      DB.prepare("DELETE FROM sessions WHERE user_id = ? AND token_hash != ?").bind(me.id, keep ? await sha256(keep[1]) : ""),
    ]);
    return { ok: true };
  }

  if (path === "/me" && M === "DELETE") {
    const me = await currentUser(request, env, true);
    const b = await body(request);
    if (me.kakao) {
      if (b.confirm !== true) fail(400, "탈퇴 확인에 체크해 주세요.");
    } else {
      const u = await DB.prepare("SELECT salt, hash FROM users WHERE id = ?").bind(me.id).first();
      if (!sameHex(await pbkdf2(typeof b.pw === "string" ? b.pw : "", u.salt), u.hash)) fail(401, "비밀번호가 맞지 않아요.");
    }
    if (me.admin) fail(400, "관리자 계정은 탈퇴할 수 없어요.");
    await deleteAccount(DB, me.id);
    if (me.kakao) await kakaoUnlink(env, me.login);
    return { ok: true };
  }

  // ---------- 곡 검색 피드백 (찾은 곡이 맞는지 이용자가 표시 → 쌓인 정정을 다음 검색에 먼저 적용) ----------
  if (path === "/song/fb" && M === "POST") {
    if (tooMany(request.headers.get("CF-Connecting-IP") || "?")) fail(429, "너무 자주 보냈어요. 잠시 후 다시 해 주세요.");
    await fbTables(DB);
    const b = await body(request), q = songKey(b.q);
    if (!q) fail(400, "곡 이름이 없어요.");
    const got = b.got && typeof b.got === "object" ? JSON.stringify({ a: str(b.got.a, 80), t: str(b.got.t, 120), src: str(b.got.src, 20) }) : "";
    const fx = b.fix && typeof b.fix === "object" ? { a: str(b.fix.a, 80), t: str(b.fix.t, 120), src: str(b.fix.src, 20) } : null;
    const me = await currentUser(request, env, false);
    const who = me ? "u" + me.id : "i" + (await sha256("fb|" + (request.headers.get("CF-Connecting-IP") || "?"))).slice(0, 16);
    // 한 사람은 같은 입력에 한 표만 (다시 누르면 바뀜)
    await DB.prepare(`INSERT INTO song_fb (q, who, ok, got, fix_a, fix_t, fix_src, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(q, who) DO UPDATE SET ok = excluded.ok, got = excluded.got, fix_a = excluded.fix_a, fix_t = excluded.fix_t, fix_src = excluded.fix_src, created = excluded.created`)
      .bind(q, who, b.ok ? 1 : 0, got, fx && fx.t ? fx.a : null, fx && fx.t ? fx.t : null, fx && fx.t ? fx.src : null, now()).run();
    return { ok: true };
  }
  if (path === "/song/fix" && M === "GET") {
    const q = songKey(url.searchParams.get("q"));
    if (!q) return { fix: null };
    try { return { fix: await songFix(DB, q) }; } catch { return { fix: null }; }   // 표가 아직 없으면 정정 없음
  }

  // ---------- 관리자 ----------
  if (path.startsWith("/admin/")) {
    const me = await currentUser(request, env, true);
    if (!me.admin) fail(403, "관리자만 쓸 수 있어요.");
    return admin(request, env, me, path, M, url);
  }

  // ---------- 후기 ----------
  if (path === "/posts" && M === "GET") {
    const me = await currentUser(request, env, false);
    const kind = url.searchParams.get("kind") || "";
    const sort = url.searchParams.get("sort") === "top" ? "top" : "new";
    const limit = Math.min(30, Math.max(1, +url.searchParams.get("limit") || 24));
    const offset = Math.max(0, +url.searchParams.get("offset") || 0);
    const where = ["p.hidden = 0"], args = [];
    if (kind) { if (!KINDS.includes(kind)) fail(400, "없는 코너예요."); where.push("p.kind = ?"); args.push(kind); }
    // 순위(top): 좋아요가 같으면 먼저 올린 후기가 앞 (코너별 순위와 같은 기준)
    const order = sort === "top" ? "p.likes DESC, p.created ASC, p.id ASC" : "p.created DESC, p.id DESC";
    const { results } = await DB.prepare(`SELECT ${POST_COLS}, p.thumb FROM posts p JOIN users u ON u.id = p.user_id WHERE ${where.join(" AND ")} ORDER BY ${order} LIMIT ? OFFSET ?`)
      .bind(...args, limit + 1, offset).all();
    const page = results.slice(0, limit);
    const liked = await likedSet(env, me, page.map((r) => r.id));
    return { posts: page.map((r) => pub(r, me, liked.has(r.id))), more: results.length > limit };
  }

  if (path === "/posts" && M === "POST") {
    const me = await currentUser(request, env, true);
    const b = await body(request);
    const p = {
      song: str(b.song, 120), art: safeUrl(b.art), preview: safeUrl(b.preview), kind: str(b.kind, 20),
      menu: str(b.menu, 40), place: str(b.place, 60), body: str(b.body, 200),
      photo: typeof b.photo === "string" ? b.photo : "", thumb: typeof b.thumb === "string" ? b.thumb : "",
    };
    if (!p.song) fail(400, "노래를 입력해 주세요.");
    if (!KINDS.includes(p.kind)) fail(400, "코너(음식 종류)를 골라 주세요.");
    if (!p.menu) fail(400, "메뉴 이름을 입력해 주세요.");
    if (!/^data:image\/(jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(p.photo) || p.photo.length > MAX_PHOTO) fail(400, "사진을 다시 골라 주세요. (너무 크거나 형식이 맞지 않아요)");
    if (!/^data:image\/(jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(p.thumb) || p.thumb.length > MAX_THUMB) fail(400, "사진을 다시 골라 주세요.");
    const today = await DB.prepare("SELECT COUNT(*) AS n FROM posts WHERE user_id = ? AND created > ?").bind(me.id, now() - 864e5).first();
    if (today.n >= POSTS_PER_DAY) fail(429, `후기는 하루에 ${POSTS_PER_DAY}개까지 올릴 수 있어요.`);
    const res = await DB.prepare("INSERT INTO posts (user_id, song, art, preview, kind, menu, place, body, photo, thumb, created) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .bind(me.id, p.song, p.art, p.preview, p.kind, p.menu, p.place, p.body, p.photo, p.thumb, now()).run();
    return { id: res.meta.last_row_id };
  }

  if ((m = /^\/posts\/(\d+)$/.exec(path))) {
    const id = +m[1];
    if (M === "GET") {
      const me = await currentUser(request, env, false);
      const r = await DB.prepare(`SELECT ${POST_COLS}, p.photo, p.hidden FROM posts p JOIN users u ON u.id = p.user_id WHERE p.id = ?`).bind(id).first();
      if (!r || (r.hidden && !(me && (me.id === r.user_id || me.admin)))) fail(404, "삭제되었거나 숨겨진 후기예요.");
      const liked = await likedSet(env, me, [id]);
      return { post: pub(r, me, liked.has(id)) };
    }
    if (M === "DELETE") {
      const me = await currentUser(request, env, true);
      const r = await DB.prepare("SELECT user_id FROM posts WHERE id = ?").bind(id).first();
      if (!r) fail(404, "이미 삭제된 후기예요.");
      if (r.user_id !== me.id && !me.admin) fail(403, "내가 쓴 후기만 지울 수 있어요.");
      try { await DB.prepare("DELETE FROM comments WHERE post_id = ?").bind(id).run(); } catch {}
      await DB.batch([
        DB.prepare("DELETE FROM likes WHERE post_id = ?").bind(id),
        DB.prepare("DELETE FROM reports WHERE post_id = ?").bind(id),
        DB.prepare("DELETE FROM posts WHERE id = ?").bind(id),
      ]);
      return { ok: true };
    }
  }

  if ((m = /^\/posts\/(\d+)\/like$/.exec(path)) && M === "POST") {
    const me = await currentUser(request, env, true);
    const id = +m[1];
    if (!(await DB.prepare("SELECT 1 FROM posts WHERE id = ? AND hidden = 0").bind(id).first())) fail(404, "삭제되었거나 숨겨진 후기예요.");
    const ins = await DB.prepare("INSERT OR IGNORE INTO likes (post_id, user_id) VALUES (?, ?)").bind(id, me.id).run();
    let liked = true;
    if (ins.meta.changes) {
      await DB.prepare("UPDATE posts SET likes = likes + 1 WHERE id = ?").bind(id).run();
    } else {
      await DB.batch([
        DB.prepare("DELETE FROM likes WHERE post_id = ? AND user_id = ?").bind(id, me.id),
        DB.prepare("UPDATE posts SET likes = MAX(likes - 1, 0) WHERE id = ?").bind(id),
      ]);
      liked = false;
    }
    const r = await DB.prepare("SELECT likes FROM posts WHERE id = ?").bind(id).first();
    return { liked, likes: r ? r.likes : 0 };
  }

  if ((m = /^\/posts\/(\d+)\/report$/.exec(path)) && M === "POST") {
    const me = await currentUser(request, env, true);
    const id = +m[1];
    const b = await body(request);
    const r = await DB.prepare("SELECT user_id FROM posts WHERE id = ?").bind(id).first();
    if (!r) fail(404, "이미 삭제된 후기예요.");
    if (r.user_id === me.id) fail(400, "내 후기는 신고할 수 없어요. 삭제 버튼을 눌러 주세요.");
    const ins = await DB.prepare("INSERT OR IGNORE INTO reports (post_id, user_id, reason, created) VALUES (?, ?, ?, ?)")
      .bind(id, me.id, str(b.reason, 200), now()).run();
    if (!ins.meta.changes) return { ok: true, already: true };
    await DB.prepare("UPDATE posts SET reports = reports + 1, hidden = CASE WHEN reports + 1 >= ? THEN 1 ELSE hidden END WHERE id = ?").bind(HIDE_AT, id).run();
    return { ok: true };
  }

  // ---------- 댓글 ----------
  if ((m = /^\/posts\/(\d+)\/comments$/.exec(path))) {
    const id = +m[1];
    const me = await currentUser(request, env, M === "POST");
    const post = await DB.prepare("SELECT user_id, hidden FROM posts WHERE id = ?").bind(id).first();
    if (!post || (post.hidden && !(me && (me.id === post.user_id || me.admin)))) fail(404, "삭제되었거나 숨겨진 후기예요.");
    if (M === "GET") {
      let results;
      try {
        ({ results } = await DB.prepare(
          `SELECT c.id, c.user_id, c.body, c.created, u.nick FROM comments c JOIN users u ON u.id = c.user_id
           WHERE c.post_id = ? ORDER BY c.created ASC LIMIT ${MAX_COMMENTS}`
        ).bind(id).all());
      } catch { fail(503, "댓글 기능을 준비 중이에요. (관리자: DB에 comments 표 추가 필요)"); }
      return { comments: results.map((c) => cpub(c, me, post.user_id)) };
    }
    if (M === "POST") {
      const b = await body(request);
      const text = str(b.body, 300);
      if (!text) fail(400, "댓글 내용을 입력해 주세요.");
      if (text.length > 150) fail(400, "댓글은 150자까지 쓸 수 있어요.");
      let recent;
      try { recent = await DB.prepare("SELECT COUNT(*) AS n FROM comments WHERE user_id = ? AND created > ?").bind(me.id, now() - 36e5).first(); }
      catch { fail(503, "댓글 기능을 준비 중이에요. (관리자: DB에 comments 표 추가 필요)"); }
      if (recent.n >= COMMENTS_PER_HOUR) fail(429, `댓글은 한 시간에 ${COMMENTS_PER_HOUR}개까지 쓸 수 있어요.`);
      const t = now();
      const res = await DB.prepare("INSERT INTO comments (post_id, user_id, body, created) VALUES (?, ?, ?, ?)").bind(id, me.id, text, t).run();
      return { comment: cpub({ id: res.meta.last_row_id, user_id: me.id, body: text, created: t, nick: me.nick }, me) };
    }
  }
  if ((m = /^\/comments\/(\d+)$/.exec(path)) && M === "DELETE") {
    const me = await currentUser(request, env, true);
    const c = await DB.prepare("SELECT c.user_id, p.user_id AS owner FROM comments c LEFT JOIN posts p ON p.id = c.post_id WHERE c.id = ?").bind(+m[1]).first();
    if (!c) fail(404, "이미 삭제된 댓글이에요.");
    if (c.user_id !== me.id && c.owner !== me.id && !me.admin) fail(403, "내 댓글이나 내 후기에 달린 댓글만 지울 수 있어요.");
    await DB.prepare("DELETE FROM comments WHERE id = ?").bind(+m[1]).run();
    return { ok: true };
  }

  // ---------- 코너별 순위 ----------
  if (path === "/ranking" && M === "GET") {
    const { results } = await DB.prepare(
      `SELECT * FROM (
         SELECT ${POST_COLS}, p.thumb, ROW_NUMBER() OVER (PARTITION BY p.kind ORDER BY p.likes DESC, p.created ASC, p.id ASC) AS rn
         FROM posts p JOIN users u ON u.id = p.user_id WHERE p.hidden = 0
       ) WHERE rn <= 3 ORDER BY kind, rn`
    ).all();
    const corners = Object.fromEntries(KINDS.map((k) => [k, []]));
    results.forEach((r) => corners[r.kind] && corners[r.kind].push(pub(r, null, false)));
    // 코너마다 후기 수 (코너 타일에 표시)
    const { results: cnt } = await DB.prepare("SELECT kind, COUNT(*) AS n FROM posts WHERE hidden = 0 GROUP BY kind").all();
    const counts = Object.fromEntries(KINDS.map((k) => [k, 0]));
    cnt.forEach((r) => { if (r.kind in counts) counts[r.kind] = r.n; });
    return { corners, counts };
  }

  fail(404, "없는 주소예요.");
}

// ================= 곡 정보: 여러 음악 서비스 비교 (/music/search) =================
// 사이트가 Apple Music·Deezer에서 곡을 직접 찾는 동안, 서버는 아래 서비스에서 같은 곡을 찾아 돌려줘요.
// 사이트는 모든 결과를 모아 '같은 곡이 몇 곳에서 나왔는지' 비교해서 가장 믿을 만한 곡을 골라요.
//   - MusicBrainz (키 필요 없음): 곡·가수·첫 발매일·장르 태그
//   - Wikidata    (키 필요 없음): 가수·곡 이름의 한글 ↔ 영어 표기 (예: 사브리나 카펜터 → Sabrina Carpenter)
//   - Spotify  (선택): Worker → Settings → Variables and Secrets 에 SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET 을 넣으면 켜짐
//   - Last.fm  (선택): 같은 곳에 LASTFM_API_KEY 를 넣으면 켜짐
// 이 서비스들에는 검색어(가수·곡 이름)만 전달되고, 사용자의 IP·회원 정보는 전달되지 않아요.
const MUSIC_VERSION = "3.4";   // /health에 보이는 서버 버전
const UA = "SongMeal/2.1 ( https://song-meal.pages.dev )";
const musicKeys = (env) => ({
  spotify: !!(env.SPOTIFY_CLIENT_ID && env.SPOTIFY_CLIENT_SECRET),
  lastfm: !!env.LASTFM_API_KEY,
});

// 같은 검색은 30분 동안 다시 묻지 않음 (Worker가 켜져 있는 동안만 기억)
// ---------- 곡 검색 피드백 ----------
// 입력을 같은 모양으로: 소문자, 기호·띄어쓰기 정리 (예: "IU - 밤편지" = "iu 밤편지")
const songKey = (v) => (typeof v === "string" ? v : "").normalize("NFC").toLowerCase().replace(/[\s\-–—·,./'"’`!?()\[\]]+/g, " ").trim().slice(0, 80);
let FB_READY = false;
async function fbTables(DB) {
  if (FB_READY) return;
  await DB.batch([
    DB.prepare(`CREATE TABLE IF NOT EXISTS song_fb (id INTEGER PRIMARY KEY AUTOINCREMENT, q TEXT NOT NULL, who TEXT NOT NULL, ok INTEGER NOT NULL,
      got TEXT NOT NULL DEFAULT '', fix_a TEXT, fix_t TEXT, fix_src TEXT, created INTEGER NOT NULL, UNIQUE (q, who))`),
    DB.prepare("CREATE INDEX IF NOT EXISTS song_fb_q ON song_fb(q, ok)"),
    DB.prepare("CREATE TABLE IF NOT EXISTS song_fix (q TEXT PRIMARY KEY, a TEXT, t TEXT, state INTEGER NOT NULL, updated INTEGER NOT NULL)"),
  ]);
  FB_READY = true;
}
// 지금 적용할 정정: 관리자가 막았으면 없음, 승인했으면 그 곡, 아니면 서로 다른 2명 이상이 같은 곡으로 고쳤고(정정된 곡에 '맞아요'도 포함) 원래 검색 결과에 '맞아요'보다 많을 때
const FIX_MIN = 2;
async function songFix(DB, q) {
  const x = await DB.prepare("SELECT a, t, state FROM song_fix WHERE q = ?").bind(q).first();
  if (x && x.state === -1) return null;
  if (x && x.state === 1 && x.t) return { a: x.a, t: x.t, by: "admin" };
  const top = await DB.prepare(
    "SELECT fix_a AS a, fix_t AS t, COUNT(*) AS n FROM song_fb WHERE q = ? AND fix_t IS NOT NULL GROUP BY lower(fix_a), lower(fix_t) ORDER BY n DESC LIMIT 1"
  ).bind(q).first();
  if (!top || top.n < FIX_MIN) return null;
  const oks = (await DB.prepare("SELECT COUNT(*) AS n FROM song_fb WHERE q = ? AND ok = 1 AND fix_t IS NULL").bind(q).first()).n;
  return top.n > oks ? { a: top.a, t: top.t, n: top.n, by: "users" } : null;
}

const MEMO = new Map();
function memo(k, v) {
  if (v === undefined) { const x = MEMO.get(k); return x && Date.now() - x.t < 30 * 60e3 ? x.v : undefined; }
  MEMO.set(k, { t: Date.now(), v });
  if (MEMO.size > 300) MEMO.delete(MEMO.keys().next().value);
  return v;
}
// 한 사람(IP)이 1분에 40번 넘게 부르면 잠깐 막음 (MusicBrainz는 1초에 1번 정도만 허용)
const HITS = new Map();
function tooMany(ip) {
  const t = Date.now(), h = (HITS.get(ip) || []).filter((x) => t - x < 60e3);
  h.push(t); HITS.delete(ip); HITS.set(ip, h);
  if (HITS.size > 2000) HITS.delete(HITS.keys().next().value);
  return h.length > 40;
}

async function getJSON(u, opt = {}, ms = 4000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try {
    const r = await fetch(u, { ...opt, signal: ac.signal, headers: { "User-Agent": UA, Accept: "application/json", ...(opt.headers || {}) } });
    if (!r.ok) return { _err: `응답 없음(${r.status})`, _status: r.status };
    return await r.json();
  } catch (e) {
    return { _err: e && e.name === "AbortError" ? "시간 초과" : "연결 안 됨" };
  } finally { clearTimeout(timer); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 전체 검색이 6.5초 안에 끝나도록 남은 시간만큼만 기다림
const left = (until, def) => Math.max(300, Math.min(def, until - Date.now()));

// 이름 비교용: 대소문자·띄어쓰기·기호·맨 앞 The 무시
const nk = (s) => String(s || "").normalize("NFKC").toLowerCase().replace(/^\s*(the|더)\s+/, "").replace(/[\s\p{P}\p{S}]/gu, "");
const uniqNames = (list) => { const seen = new Set(); return list.filter((x) => { const k = nk(x); if (!x || !k || seen.has(k)) return false; seen.add(k); return true; }); };
function sameName(x, y) {
  const a = nk(x), b = nk(y);
  if (!a || !b) return false;
  if (a === b) return true;
  const [s, l] = a.length <= b.length ? [a, b] : [b, a];
  return s.length >= 2 && l.includes(s) && l.length - s.length <= 2;
}
const langOf = (s) => (/[가-힣]/.test(s) ? "ko" : /[぀-ヿ一-鿿]/.test(s) ? "ja" : "en");
const MUSICIAN = /가수|래퍼|밴드|그룹|음악가|뮤지션|싱어|작곡가|프로듀서|디제이|아이돌|듀오|보컬|singer|rapper|band|musician|group|songwriter|producer|\bdj\b|duo|composer|vocalist|idol/i;
const SONGISH = /노래|곡|싱글|song|single|track/i;

// ---------- Wikidata: 한글 ↔ 영어 이름 ----------
async function wdSearch(text, until) {
  const lang = langOf(text);
  const d = await getJSON(`https://www.wikidata.org/w/api.php?action=wbsearchentities&format=json&type=item&limit=8&language=${lang}&uselang=${lang}&search=${encodeURIComponent(text)}`, {}, left(until, 2500));
  if (d._err) return { err: d._err, ids: [] };
  // 검색어와 같은 이름(또는 별명)으로 찾은 항목만
  return { ids: (d.search || []).filter((x) => sameName((x.match && x.match.text) || x.label, text)).map((x) => x.id).slice(0, 5) };
}
async function wdEntities(ids, until) {
  if (!ids.length) return {};
  const d = await getJSON(`https://www.wikidata.org/w/api.php?action=wbgetentities&format=json&props=labels%7Cdescriptions%7Caliases&languages=en%7Cmul%7Cko&ids=${ids.join("%7C")}`, {}, left(until, 2500));
  return d._err ? { _err: d._err } : d.entities || {};
}
const wdText = (o, l) => (o && o[l] && o[l].value) || "";
function wdNames(e) {
  const al = (l) => ((e.aliases && e.aliases[l]) || []).map((x) => x.value);
  return {
    name: wdText(e.labels, "en") || wdText(e.labels, "mul"),
    ko: wdText(e.labels, "ko"),
    aliases: uniqNames([...al("en"), ...al("mul"), ...al("ko")]).slice(0, 6),
    desc: [wdText(e.descriptions, "en"), wdText(e.descriptions, "mul"), wdText(e.descriptions, "ko")].join(" "),
  };
}

// ---------- MusicBrainz: 곡 ----------
const luq = (s) => '"' + String(s).replace(/[\\"]/g, "\\$&") + '"';
const credit = (ac) => (ac || []).map((c) => (c.name || (c.artist && c.artist.name) || "") + (c.joinphrase || "")).join("").trim();
function bestRelease(rs) {
  const sc = (r) => {
    const g = r["release-group"] || {};
    return (r.status === "Official" ? 2 : 0) + (/Album|Single|EP/.test(g["primary-type"] || "") ? 1 : 0) - ((g["secondary-types"] || []).length ? 2 : 0);
  };
  return (rs || []).slice().sort((x, y) => sc(y) - sc(x) || String(x.date || "9999").localeCompare(String(y.date || "9999")))[0] || null;
}
async function mbRecordings(titles, names, until) {
  const q = `(${titles.map((x) => "recording:" + luq(x)).join(" OR ")}) AND (${names.map((n) => "artist:" + luq(n)).join(" OR ")})`;
  const u = `https://musicbrainz.org/ws/2/recording?fmt=json&limit=12&query=${encodeURIComponent(q)}`;
  let d = await getJSON(u, {}, left(until, 4000));
  if (d._status === 503 && until - Date.now() > 2600) { await sleep(1100); d = await getJSON(u, {}, left(until, 3000)); }   // 1초 한도에 걸리면 한 번 더
  if (d._err) return { err: d._err, tracks: [] };
  const tracks = (d.recordings || []).filter((r) => r && r.title && !r.video && (r.score === undefined || +r.score >= 60)).map((r) => {
    const rel = bestRelease(r.releases), rg = rel && rel["release-group"];
    const tags = (r.tags || []).slice().sort((x, y) => (y.count || 0) - (x.count || 0)).map((x) => x.name).filter(Boolean).slice(0, 4);
    return {
      source: "MusicBrainz", trackId: "mb" + r.id,
      artistName: credit(r["artist-credit"]),
      trackName: r.title + (r.disambiguation ? ` (${r.disambiguation})` : ""),
      collectionName: rel ? rel.title || "" : "",
      releaseDate: r["first-release-date"] || (rel && rel.date) || "",
      primaryGenreName: tags.join(", "), tags,
      artworkUrl100: rg && rg.id ? `https://coverartarchive.org/release-group/${rg.id}/front-250` : "",
    };
  });
  return { tracks };
}

// ---------- Spotify (선택) ----------
const SPT = { token: "", until: 0 };
async function spotify(env, t, names, until) {
  if (!musicKeys(env).spotify) return { err: "키 없음", tracks: [] };
  if (!SPT.token || Date.now() > SPT.until) {
    const d = await getJSON("https://accounts.spotify.com/api/token", {
      method: "POST", body: "grant_type=client_credentials",
      headers: { Authorization: "Basic " + btoa(`${env.SPOTIFY_CLIENT_ID}:${env.SPOTIFY_CLIENT_SECRET}`), "Content-Type": "application/x-www-form-urlencoded" },
    }, left(until, 2500));
    if (!d.access_token) return { err: d._status === 400 || d._status === 401 ? "키가 맞지 않음" : d._err || "토큰 실패", tracks: [] };
    SPT.token = d.access_token; SPT.until = Date.now() + ((+d.expires_in || 3600) - 120) * 1000;
  }
  const q = [names[0] || "", t].join(" ").trim();
  const d = await getJSON(`https://api.spotify.com/v1/search?type=track&market=KR&limit=10&q=${encodeURIComponent(q)}`, { headers: { Authorization: "Bearer " + SPT.token } }, left(until, 3500));
  if (d._status === 401) SPT.token = "";
  if (d._err) return { err: d._err, tracks: [] };
  return {
    tracks: ((d.tracks && d.tracks.items) || []).filter((x) => x && x.name).map((x) => {
      const al = x.album || {}, imgs = al.images || [];
      return {
        source: "Spotify", trackId: "sp" + x.id,
        artistName: (x.artists || []).map((y) => y.name).filter(Boolean).join(", "),
        trackName: x.name, collectionName: al.name || "", releaseDate: al.release_date || "",
        artworkUrl100: (imgs.find((i) => i.width && i.width <= 320) || imgs[0] || {}).url || "",
        previewUrl: x.preview_url || "",
        spotifyUrl: (x.external_urls && x.external_urls.spotify) || "",
      };
    }),
  };
}

// ---------- Last.fm (선택): 오타 고침(autocorrect)과 장르 태그 ----------
async function lastfm(env, t, names, until) {
  if (!musicKeys(env).lastfm) return { err: "키 없음", tracks: [] };
  const base = `https://ws.audioscrobbler.com/2.0/?format=json&api_key=${encodeURIComponent(env.LASTFM_API_KEY)}`;
  const a = names[0] || "";
  if (a) {
    const d = await getJSON(`${base}&method=track.getInfo&autocorrect=1&artist=${encodeURIComponent(a)}&track=${encodeURIComponent(t)}`, {}, left(until, 3500));
    const x = d.track;
    if (x && x.name) {
      const tags = ((x.toptags && x.toptags.tag) || []).map((g) => g && g.name).filter(Boolean).slice(0, 4);
      const an = (x.artist && x.artist.name) || a;
      return { fix: nk(an) !== nk(a) ? an : "", tracks: [{ source: "Last.fm", trackId: "lf" + nk(an) + "|" + nk(x.name), artistName: an, trackName: x.name,
        collectionName: (x.album && x.album.title) || "", primaryGenreName: tags.join(", "), tags, listeners: +x.listeners || 0 }] };
    }
    if (d._status === 403 || d._status === 401) return { err: "키가 맞지 않음", tracks: [] };
  }
  const d = await getJSON(`${base}&method=track.search&limit=10&track=${encodeURIComponent(t)}${a ? "&artist=" + encodeURIComponent(a) : ""}`, {}, left(until, 3500));
  if (d._err) return { err: d._status === 403 ? "키가 맞지 않음" : d._err, tracks: [] };
  let list = (d.results && d.results.trackmatches && d.results.trackmatches.track) || [];
  if (!Array.isArray(list)) list = [list];
  return { tracks: list.filter((x) => x && x.name).map((x) => ({ source: "Last.fm", trackId: "lf" + nk(x.artist) + "|" + nk(x.name),
    artistName: x.artist || "", trackName: x.name, collectionName: "", listeners: +x.listeners || 0 })) };
}

// ---------- 곡 분위기 태그 (Last.fm) ----------
// a: 가수 이름 후보들, t: 곡명 후보들 ('|'로 구분). 곡 태그가 적으면 가수 태그로 대신함
// 결과: { from: "track" | "artist" | "", tags: [{ name, count }] }  (count: Last.fm 태그 비중 0~100)
async function musicMood(q, env) {
  if (!musicKeys(env).lastfm) return { off: true, tags: [] };
  const as = uniqNames(str(q.get("a"), 240).split("|").map((x) => x.trim())).slice(0, 3);
  const ts = uniqNames(str(q.get("t"), 240).split("|").map((x) => x.trim())).slice(0, 2);
  if (!as.length || !ts.length) return { tags: [] };
  const key = "mood|" + as.map(nk).join(",") + "|" + ts.map(nk).join(",");
  const hit = memo(key); if (hit) return { ...hit, cached: true };
  const base = `https://ws.audioscrobbler.com/2.0/?format=json&autocorrect=1&api_key=${encodeURIComponent(env.LASTFM_API_KEY)}`;
  const until = Date.now() + 4500;
  const clean = (d) => ((d && d.toptags && d.toptags.tag) || []).filter((g) => g && g.name).map((g) => ({ name: String(g.name).slice(0, 40), count: +g.count || 0 })).filter((g) => g.count >= 5).slice(0, 12);
  let artistTags = [];
  for (const a of as) {
    for (const t of ts) {
      if (Date.now() > until) break;
      const d = await getJSON(`${base}&method=track.getTopTags&artist=${encodeURIComponent(a)}&track=${encodeURIComponent(t)}`, {}, left(until, 2500));
      const tags = clean(d);
      if (tags.length >= 3) return memo(key, { from: "track", artist: a, track: t, tags });
    }
    if (!artistTags.length && Date.now() < until) {
      const d = await getJSON(`${base}&method=artist.getTopTags&artist=${encodeURIComponent(a)}`, {}, left(until, 2000));
      artistTags = clean(d);
    }
  }
  return memo(key, artistTags.length ? { from: "artist", tags: artistTags } : { from: "", tags: [] });
}

// a: 가수(선택), t: 곡 제목, k: 사이트가 이미 아는 가수의 영어 표기들('|'로 구분)
async function musicSearch(q, env) {
  const a = str(q.get("a"), 80), t = str(q.get("t"), 120);
  const known = str(q.get("k"), 240).split("|").map((x) => x.trim()).filter(Boolean).slice(0, 4);
  if (!t) fail(400, "곡 제목이 필요해요.");
  const key = JSON.stringify([a, t, known]);
  const hit = memo(key);
  if (hit) return { ...hit, cached: true };
  const keys = musicKeys(env), until = Date.now() + 6500;
  const status = { musicbrainz: "안 씀", wikidata: "안 씀", spotify: keys.spotify ? "안 씀" : "키 없음", lastfm: keys.lastfm ? "안 씀" : "키 없음" };

  // 1) 이름 풀기: 사이트가 모르는 가수 이름, 한글·일본어 곡명은 Wikidata에서 다른 표기를 찾음
  const needA = !!a && !known.length;
  const needT = langOf(t) !== "en" || (!!a && langOf(a) !== "en");
  let names = [], titles = [];
  if (needA || needT) {
    const [sa, st] = await Promise.all([needA ? wdSearch(a, until) : { ids: [] }, needT ? wdSearch(t, until) : { ids: [] }]);
    const ents = await wdEntities([...new Set([...sa.ids, ...st.ids])], until);
    const got = (ids, re) => ids.map((id) => ents[id]).filter(Boolean).map(wdNames).filter((n) => n.name && re.test(n.desc)).slice(0, 3);
    names = got(sa.ids, MUSICIAN);
    titles = got(st.ids, SONGISH);
    status.wikidata = sa.err || st.err || ents._err || `가수 이름 ${names.length}개 · 곡명 ${titles.length}개`;
  }

  // 2) 곡 찾기: MusicBrainz·Spotify·Last.fm을 한꺼번에
  const nameList = uniqNames([...known, ...names.map((n) => n.name), a]).slice(0, 4);
  const titleList = uniqNames([t, ...titles.map((x) => x.name)]).slice(0, 3);
  const run = (k, p) => p.then((r) => {
    status[k] = r.err || `${r.tracks.length}곡`;
    // Last.fm이 가수 이름 오타를 고쳐 주면 그 이름도 알려 줌 (예: Kanye Wset → Kanye West)
    if (r.fix && !names.some((n) => sameName(n.name, r.fix))) names.push({ name: r.fix, ko: "", aliases: [], from: "Last.fm" });
    return r.tracks;
  });
  const jobs = [];
  if (nameList.length) jobs.push(run("musicbrainz", mbRecordings(titleList, nameList, until)));
  else status.musicbrainz = "가수 이름이 없어 안 씀";
  if (keys.spotify) jobs.push(run("spotify", spotify(env, t, nameList, until)));
  if (keys.lastfm) jobs.push(run("lastfm", lastfm(env, t, nameList, until)));
  const tracks = (await Promise.all(jobs)).flat();

  const clean = ({ name, ko, aliases, from }) => ({ name, ko, aliases, from: from || "Wikidata" });
  const out = { v: MUSIC_VERSION, names: names.map(clean), titles: titles.map(clean), tracks, status };
  // 응답이 없던 서비스가 있으면 기억하지 않음 (다음 검색 때 다시 물어봄)
  return Object.values(status).some((x) => /응답 없음|시간 초과|연결 안 됨|토큰 실패/.test(x)) ? out : memo(key, out);
}


// ---------- 노래 추천 (사장님용): Gemini 사진 분석 ----------
// 사진은 분석에만 쓰고 저장하지 않음. 무료 키 한도를 아끼려고 한 사람(IP)당 1분에 6번까지
const GEMINI_MODELS = ["gemini-2.5-flash", "gemini-flash-latest", "gemini-2.0-flash"];
const AI_HITS = new Map();
function tooManyAI(ip) {
  const t = Date.now(), h = (AI_HITS.get(ip) || []).filter((x) => t - x < 60e3);
  h.push(t); AI_HITS.delete(ip); AI_HITS.set(ip, h);
  if (AI_HITS.size > 2000) AI_HITS.delete(AI_HITS.keys().next().value);
  return h.length > 10;
}
const LANG_NAME = { ko: "한국어", en: "English", ja: "日本語", zh: "简体中文" };
const cut = (v, n) => String(v == null ? "" : v).replace(/[\u0000-\u001f]/g, " ").trim().slice(0, n);
const lv = (v) => Math.max(1, Math.min(3, Math.round(+v) || 2));

// Gemini 한 번 부르기 → JSON 객체. 모델 이름이 바뀌었으면(404) 다음 모델로. 한도(429)면 busy
async function askGemini(env, parts, { models, temperature = 0.7, check, fast } = {}) {
  const list = env.GEMINI_MODEL ? [env.GEMINI_MODEL, ...(models || GEMINI_MODELS)] : models || GEMINI_MODELS;
  let lastStatus = 0;
  for (const model of list) {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
      body: JSON.stringify({ contents: [{ role: "user", parts }], generationConfig: { responseMimeType: "application/json", temperature, ...(fast && /2\.5-flash/.test(model) ? { thinkingConfig: { thinkingBudget: 0 } } : {}) } }),
    });
    lastStatus = r.status;
    if (r.status === 404) continue;
    if (r.status === 429) fail(429, "busy");
    if (!r.ok) { console.log("gemini", model, r.status, (await r.text()).slice(0, 300)); continue; }
    const d = await r.json();
    const text = (((d.candidates || [])[0] || {}).content || {}).parts?.map((p) => p.text || "").join("") || "";
    let o; try { o = JSON.parse(text.replace(/^```(json)?|```$/g, "").trim()); } catch { continue; }
    if (check && !check(o)) continue;
    return { o, model };
  }
  fail(502, lastStatus === 403 || lastStatus === 401 ? "key" : "fail");
}

// ---------- 곡 실제 확인 (Deezer, 키 필요 없음) ----------
// AI가 고른 곡이 실제로 있는지 Deezer에서 찾아보고, 있으면 미리듣기·앨범 표지·링크를 붙임. 곡 검색(lookupSong)과는 별개
const nTitle = (t) => String(t || "").normalize("NFKC").toLowerCase().replace(/\s*[([].*?[)\]]\s*/g, " ").replace(/\b(feat|ft|with)\b.*$/, "").replace(/[^0-9a-z가-힣ぁ-んァ-ン一-龥]+/g, "");
const nArtist = (t) => String(t || "").normalize("NFKC").toLowerCase().replace(/[^0-9a-z가-힣ぁ-んァ-ン一-龥]+/g, "");
const near = (a, b) => !!a && !!b && (a === b || (Math.min(a.length, b.length) >= 3 && (a.includes(b) || b.includes(a))));
async function dzFind(s, budget = { n: 8 }) {
  const titles = [s.title, s.title_en].map(nTitle).filter(Boolean), artists = [s.artist, s.artist_en].map(nArtist).filter(Boolean);
  const qs = [...new Set([`artist:"${s.artist}" track:"${s.title}"`, s.artist_en && s.title_en ? `artist:"${s.artist_en}" track:"${s.title_en}"` : "",
    s.artist_en ? `artist:"${s.artist_en}" track:"${s.title}"` : "", `${s.artist_en || s.artist} ${s.title_en || s.title}`, `track:"${s.title}"`, s.title_en ? `track:"${s.title_en}"` : ""].filter(Boolean))];
  let reached = false;
  for (const q of qs) {
    const k = "dz|" + q;
    let d = memo(k);
    if (d === undefined) {
      if (budget.n-- <= 0) break;   // Deezer 한도(5초에 50번) 안에서만
      try { d = await getJSON("https://api.deezer.com/search?limit=10&q=" + encodeURIComponent(q), {}, 3500); if (d && Array.isArray(d.data)) memo(k, d); } catch { d = null; }
    }
    if (!d || !Array.isArray(d.data)) continue;
    reached = true;
    const hit = d.data.find((x) => x.artist && artists.some((a) => near(nArtist(x.artist.name), a)) && titles.some((t) => near(nTitle(x.title_short || x.title), t)));
    if (hit) return { ok: true, preview: hit.preview || "", art: (hit.album && (hit.album.cover_medium || hit.album.cover)) || "", link: hit.link || "", dz: { artist: hit.artist.name, title: hit.title_short || hit.title, id: hit.id } };
  }
  return { ok: false, reached };
}
// Deezer에 없을 때 Spotify(키를 넣은 경우)에서 한 번 더 확인 — 한국 곡을 한글 이름으로 갖고 있음 (미리듣기는 대부분 없음)
async function spFind(s, env, budget) {
  if (!env || !musicKeys(env).spotify || budget.sp-- <= 0) return { ok: false };
  const titles = [s.title, s.title_en].map(nTitle).filter(Boolean), artists = [s.artist, s.artist_en].map(nArtist).filter(Boolean);
  const r = await spotify(env, s.title, [s.artist], Date.now() + 4000).catch(() => ({ tracks: [] }));
  if (r.err) return { ok: false, reached: false };
  const hit = (r.tracks || []).find((x) => x.artistName.split(", ").some((a) => artists.some((b) => near(nArtist(a), b))) && titles.some((t) => near(nTitle(x.trackName), t)));
  return hit ? { ok: true, reached: true, preview: hit.previewUrl || "", art: hit.artworkUrl100 || "", link: hit.spotifyUrl || "", sp: { artist: hit.artistName, title: hit.trackName } } : { ok: false, reached: true };
}
// 목록을 앞에서부터 확인해서 확인된 곡만 need곡까지. Deezer가 아예 안 되면 확인 못 한 곡을 그대로 둠(checked=false)
async function verifySongs(list, need, env) {
  const out = [], tried = [];
  let reached = false;
  const budget = { n: 45, sp: 15 };
  for (let i = 0; i < list.length && out.length < need && budget.n > 0; i += 5) {
    const part = list.slice(i, i + 5);
    const res = await Promise.all(part.map(async (s) => {
      const d = await dzFind(s, budget).catch(() => ({ ok: false }));
      if (d.ok) return d;
      const sp = await spFind(s, env, budget).catch(() => ({ ok: false }));
      return sp.ok || sp.reached ? { ...sp, reached: sp.reached || d.reached } : d;
    }));
    part.forEach((s, k) => { if (res[k].reached || res[k].ok) reached = true; if (res[k].ok && out.length < need) out.push({ ...s, ...res[k], ok: undefined, reached: undefined, checked: true }); else tried.push(s); });
  }
  if (!reached) return { songs: list.slice(0, need).map((s) => ({ ...s, checked: false })), reached: false };
  return { songs: out, dropped: tried.map((s) => `${s.artist} - ${s.title}`).slice(0, 20), reached: true };
}
const songIn = (x, extra = {}) => ({
  artist: cut(x.artist, 80), title: cut(x.title, 100), artist_en: cut(x.artist_en, 80), title_en: cut(x.title_en, 100), genre: cut(x.genre, 30),
  energy: lv(x.energy), valence: lv(x.valence), reason: cut(x.reason, 200), intro: cut(x.intro, 140), verse: cut(x.verse, 140), chorus: cut(x.chorus, 140), ...extra,
});

async function shopVibe(b, env) {
  const img = typeof b.image === "string" ? b.image.replace(/^data:[^,]+,/, "") : "";
  if (img && (img.length > 2_400_000 || !/^[A-Za-z0-9+/=]+$/.test(img))) fail(400, "photo");
  const name = cut(b.name, 60), kind = cut(b.kind, 40), cat = cut(b.category, 60), loc = cut(b.loc, 60);
  if (!img && !name) fail(400, "need");
  const lang = LANG_NAME[b.lang] ? b.lang : "ko";
  const avoid = Array.isArray(b.avoid) ? b.avoid.slice(0, 40).map((x) => cut(x, 80)).filter(Boolean) : [];
  const hour = Number.isInteger(b.hour) && b.hour >= 0 && b.hour < 24 ? b.hour : null;
  const prompt = [
    "You are a music curator for restaurants and cafes in Korea. A shop owner wants background music that fits the shop.",
    img ? "Look at the attached photo of the shop (interior, lighting, colors, materials, furniture, crowd feel)." : "There is no photo; use the shop information only.",
    `Shop name: ${name || "(none)"} / Shop type chosen by owner: ${kind || "(auto)"} / Naver category: ${cat || "(unknown)"} / Area: ${loc || "(unknown)"}` + (hour !== null ? ` / Current hour: ${hour}` : ""),
    "Pick exactly 15 REAL, officially released, popular songs that certainly exist on Deezer, Apple Music and Spotify (prefer well-known tracks; avoid obscure, unreleased or live-only songs). Never invent songs or mix up artists. Mix Korean songs and international songs unless the shop clearly suits one style. At most 2 songs per artist. Order them as a playlist flow, best fits first.",
    avoid.length ? "Do not use these songs: " + avoid.join(" | ") : "",
    `Write every descriptive text in ${LANG_NAME[lang]}. artist/title exactly as officially written (Korean songs in Korean); artist_en/title_en = the official English/romanized names used on global services (same as artist/title if already English).`,
    "energy and valence are integers 1-3 (1 = calm/dark, 3 = energetic/bright).",
    "Return only JSON with this shape:",
    '{"summary":"2 sentences about the shop atmosphere","lighting":"short","colors":"short","materials":"short","tags":["5 short mood keywords"],"energy":2,"valence":2,"songs":[{"artist":"","title":"","artist_en":"","title_en":"","genre":"","energy":2,"valence":2,"reason":"1 sentence why it fits this shop","intro":"1 short sentence","verse":"1 short sentence","chorus":"1 short sentence"}]}',
  ].filter(Boolean).join("\n");
  const parts = [{ text: prompt }];
  if (img) parts.push({ inline_data: { mime_type: /^image\/(png|webp|jpeg)$/.test(b.mime) ? b.mime : "image/jpeg", data: img } });
  const { o, model } = await askGemini(env, parts, { temperature: 0.9, check: (o) => Array.isArray(o.songs) && o.songs.length >= 5 });
  const seen = new Set();
  const ai = o.songs.map((x) => songIn(x)).filter((x) => x.artist && x.title && !seen.has((x.artist + x.title).toLowerCase()) && seen.add((x.artist + x.title).toLowerCase())).slice(0, 16);
  // 사이트가 보낸 예비 곡(실제 곡 목록) → AI 곡이 확인 안 되면 이걸로 채움
  const pool = (Array.isArray(b.pool) ? b.pool : []).slice(0, 30).map((x) => songIn(x, { pool: true })).filter((x) => x.artist && x.title && !seen.has((x.artist + x.title).toLowerCase()));
  const v = await verifySongs([...ai, ...pool], 10, env);
  return {
    model, summary: cut(o.summary, 400), lighting: cut(o.lighting, 80), colors: cut(o.colors, 80), materials: cut(o.materials, 80),
    tags: (Array.isArray(o.tags) ? o.tags : []).map((t) => cut(t, 24)).filter(Boolean).slice(0, 6),
    energy: lv(o.energy), valence: lv(o.valence), songs: v.songs, verified: v.reached, dropped: v.dropped || [],
  };
}

// 예비 곡만 확인 (AI 키가 없을 때 사이트 자체 추천 목록용)
async function shopVerify(b, env) {
  const list = (Array.isArray(b.songs) ? b.songs : []).slice(0, 30).map((x) => songIn(x, { pool: !!x.pool })).filter((x) => x.artist && x.title);
  return verifySongs(list, Math.max(1, Math.min(10, +b.need || 10)), env);
}

// ---------- 메뉴 추천의 곡 교차검증 + 곡 분석 (Gemini) ----------
// 곡 검색 결과는 바꾸지 않음. 입력과 찾은 곡이 맞는지 의견을 내고, 아니면 맞을 것 같은 곡을 '제안'만 함(사용자가 눌러야 바뀜)
const GEMINI_LITE = ["gemini-2.5-flash-lite", "gemini-flash-lite-latest", ...GEMINI_MODELS];
// 한국어 곡 이름 → 음원 서비스(Apple Music 등)에 등록된 영어·로마자 이름. 곡 검색 로직은 그대로, 브라우저가 이 이름으로 한 번 더 검색
async function songAlias(b, env) {
  const q = cut(b.q, 100);
  if (!q) fail(400, "need");
  const f = b.found && typeof b.found === "object" ? { artist: cut(b.found.artist, 80), title: cut(b.found.title, 120) } : null;
  const prompt = [
    "A user typed a song (often Korean names) to search Apple Music. Apple Music often lists Korean songs under their English/romanized names (e.g. 세븐틴 → SEVENTEEN, 아이유 → IU, 방탄소년단 → BTS; a Korean title may be listed as its official English title).",
    `The user typed: "${q}"`,
    f && f.title ? `A first search found: "${f.artist} - ${f.title}" (it may be wrong or lack a preview).` : "A first search found nothing useful.",
    "Identify the single REAL song the user most likely means. Give its names as typed/Korean (artist, title) and as officially listed on Apple Music / international streaming (artist_en, title_en). alt_titles: other official titles of the same song (Korean, English, romanized), max 3.",
    "If you are not confident the song exists, set confident to false. Never invent songs.",
    'Return only JSON: {"confident":true,"artist":"","title":"","artist_en":"","title_en":"","alt_titles":[]}',
  ].join("\n");
  const { o, model } = await askGemini(env, [{ text: prompt }], { models: GEMINI_LITE, temperature: 0.1, fast: true, check: (o) => typeof o.confident === "boolean" });
  if (!o.confident || !(o.title_en || o.title)) return { model, found: false };
  return { model, found: true, artist: cut(o.artist, 80), title: cut(o.title, 120), artist_en: cut(o.artist_en, 80), title_en: cut(o.title_en, 120),
    alt_titles: (Array.isArray(o.alt_titles) ? o.alt_titles : []).map((t) => cut(t, 120)).filter(Boolean).slice(0, 3) };
}

async function songCheck(b, env) {
  const q = cut(b.q, 100);
  if (!q) fail(400, "need");
  const lang = LANG_NAME[b.lang] ? b.lang : "ko";
  const f = b.found && typeof b.found === "object" ? { artist: cut(b.found.artist, 80), title: cut(b.found.title, 120), album: cut(b.found.album, 120), genre: cut(b.found.genre, 40), year: cut(b.found.year, 4) } : null;
  const tags = (Array.isArray(b.tags) ? b.tags : []).slice(0, 10).map((t) => cut(t, 30)).filter(Boolean);
  const prompt = [
    "You check a music search result and analyze the song. Be factual; never invent songs.",
    `The user typed: "${q}"`,
    f && f.title ? `The search engine found: "${f.artist} - ${f.title}" (album: ${f.album || "?"}, genre: ${f.genre || "?"}, year: ${f.year || "?"})` : "The search engine found nothing.",
    tags.length ? `Last.fm listener tags for the found song: ${tags.join(", ")}` : "",
    "1) match: true if the found song is very likely the song the user meant (same song; different language title or romanization is still a match). false if it is a different song (e.g. same title by another artist, a cover, karaoke, or the user clearly meant another artist).",
    "2) If match is false or nothing was found, suggest the single most likely intended REAL song as {artist, title, artist_en, title_en}; otherwise suggest null. If unsure, null.",
    `3) Analyze the song (the found song if match, otherwise the suggested song). Use the Last.fm tags as evidence when given. Write texts in ${LANG_NAME[lang]}.`,
    "energy and valence: integers 1-3 (1 calm/sad, 3 energetic/happy). bpm: typical tempo integer.",
    'Return only JSON: {"match":true,"confidence":0.0,"why":"1 short sentence","suggest":null,"energy":2,"valence":2,"bpm":100,"mood":["3-5 short words"],"summary":"2 sentences about the song\'s sound and feeling","intro":"1 short sentence","verse":"1 short sentence","chorus":"1 short sentence"}',
  ].filter(Boolean).join("\n");
  const { o, model } = await askGemini(env, [{ text: prompt }], { models: GEMINI_LITE, temperature: 0.2, fast: true, check: (o) => typeof o.match === "boolean" });
  let suggest = null;
  if (o.suggest && o.suggest.title && o.suggest.artist) {
    const s = songIn(o.suggest);
    const same = f && near(nTitle(s.title), nTitle(f.title)) && near(nArtist(s.artist), nArtist(f.artist));
    if (!same) { let d = await dzFind(s).catch(() => ({ ok: false })); if (!d.ok) d = await spFind(s, env, { sp: 1 }).catch(() => ({ ok: false })); if (d.ok) suggest = { artist: s.artist, title: s.title, artist_en: s.artist_en, title_en: s.title_en, preview: d.preview, art: d.art }; }
  }
  const bpm = Math.round(+o.bpm);
  return {
    model, match: !!o.match, confidence: Math.max(0, Math.min(1, +o.confidence || 0)), why: cut(o.why, 160), suggest,
    energy: lv(o.energy), valence: lv(o.valence), bpm: bpm >= 40 && bpm <= 220 ? bpm : null,
    mood: (Array.isArray(o.mood) ? o.mood : []).map((t) => cut(t, 20)).filter(Boolean).slice(0, 5),
    summary: cut(o.summary, 300), intro: cut(o.intro, 140), verse: cut(o.verse, 140), chorus: cut(o.chorus, 140),
  };
}
