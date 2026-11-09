// 음식점 커뮤니티 API (Cloudflare Workers + D1)
// 회원가입·로그인, 후기(노래 + 음식 사진) 올리기, 좋아요, 코너별 순위, 신고, 회원 탈퇴
//
// 설정 (Cloudflare 대시보드)
//   1) D1 데이터베이스 song-meal-db 를 만들고 Console 에서 schema.sql 실행
//   2) Worker song-meal-api 를 만들고 이 코드를 붙여 넣기
//   3) Worker → Settings → Bindings → D1 database 추가: 변수 이름 DB, 데이터베이스 song-meal-db
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
    return x.protocol === "https:" && /(^|\.)(mzstatic\.com|apple\.com|dzcdn\.net|deezer\.com)$/.test(x.hostname) ? s : "";
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
    if (new URL(request.url).pathname === "/health") {
      let db = "연결 안 됨 (Bindings에 DB 추가 필요)";
      if (env.DB) { try { await env.DB.prepare("SELECT COUNT(*) AS n FROM users").first(); db = "정상"; } catch { db = "연결됐지만 표가 없음 (schema.sql 실행 필요)"; } }
      return json({ ok: true, db });
    }
    if (!isAllowed(origin, env)) return json({ error: "허용되지 않은 사이트예요." }, 403);
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
    if (row) return { ...row, admin: isAdmin(row.login) };
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
    if (act === "" && M === "DELETE") { await deleteAccount(DB, uid); return { ok: true }; }
    if (act === "/reset-password" && M === "POST") {
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

  if (path === "/login" && M === "POST") {
    const b = await body(request);
    const login = str(b.login, 40).toLowerCase(), pw = typeof b.pw === "string" ? b.pw : "";
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
    return { token: await newSession(env, u.id), user: { id: u.id, login: u.login, nick: u.nick, admin: isAdmin(u.login), prefs: await getPrefs(DB, u.id) } };
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
    const u = await DB.prepare("SELECT salt, hash FROM users WHERE id = ?").bind(me.id).first();
    if (!sameHex(await pbkdf2(typeof b.pw === "string" ? b.pw : "", u.salt), u.hash)) fail(401, "비밀번호가 맞지 않아요.");
    if (me.admin) fail(400, "관리자 계정은 탈퇴할 수 없어요.");
    await deleteAccount(DB, me.id);
    return { ok: true };
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
    const order = sort === "top" ? "p.likes DESC, p.created DESC" : "p.created DESC";
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
         SELECT ${POST_COLS}, p.thumb, ROW_NUMBER() OVER (PARTITION BY p.kind ORDER BY p.likes DESC, p.created ASC) AS rn
         FROM posts p JOIN users u ON u.id = p.user_id WHERE p.hidden = 0
       ) WHERE rn <= 3 ORDER BY kind, rn`
    ).all();
    const corners = Object.fromEntries(KINDS.map((k) => [k, []]));
    results.forEach((r) => corners[r.kind] && corners[r.kind].push(pub(r, null, false)));
    return { corners };
  }

  fail(404, "없는 주소예요.");
}
