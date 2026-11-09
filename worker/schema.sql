-- 음식점 커뮤니티(후기·좋아요·순위)용 D1 데이터베이스 구조
-- Cloudflare 대시보드 → Storage & databases → D1 → song-meal-db → Console 에 통째로 붙여 넣고 실행하세요.

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  login TEXT NOT NULL UNIQUE,          -- 아이디 (영문 소문자·숫자·_)
  nick TEXT NOT NULL,                  -- 닉네임 (화면에 표시)
  salt TEXT NOT NULL,                  -- 비밀번호 해시용 무작위 값
  hash TEXT NOT NULL,                  -- 비밀번호 해시 (PBKDF2-SHA256), 원래 비밀번호는 저장하지 않음
  fails INTEGER NOT NULL DEFAULT 0,    -- 로그인 연속 실패 횟수
  locked_until INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,         -- 로그인 토큰의 해시 (토큰 원문은 저장하지 않음)
  user_id INTEGER NOT NULL,
  expires INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  song TEXT NOT NULL,                  -- '가수 - 곡명'
  art TEXT NOT NULL DEFAULT '',        -- 앨범 이미지 주소
  preview TEXT NOT NULL DEFAULT '',    -- 30초 미리듣기 주소
  kind TEXT NOT NULL,                  -- 코너: 한식/중식/일식/양식/분식/아시안/카페·디저트
  menu TEXT NOT NULL,                  -- 메뉴 이름 (예: 우동)
  place TEXT NOT NULL DEFAULT '',      -- 식당 이름
  body TEXT NOT NULL DEFAULT '',       -- 한 줄 후기
  photo TEXT NOT NULL,                 -- 음식 사진 (줄인 JPEG, data URL)
  thumb TEXT NOT NULL,                 -- 작은 미리보기 사진
  likes INTEGER NOT NULL DEFAULT 0,
  reports INTEGER NOT NULL DEFAULT 0,
  hidden INTEGER NOT NULL DEFAULT 0,   -- 신고 3건 이상이면 1 (숨김)
  created INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS posts_rank ON posts(hidden, kind, likes DESC, created);
CREATE INDEX IF NOT EXISTS posts_new ON posts(hidden, created DESC);
CREATE INDEX IF NOT EXISTS posts_user ON posts(user_id);

CREATE TABLE IF NOT EXISTS likes (
  post_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  PRIMARY KEY (post_id, user_id)
);
CREATE INDEX IF NOT EXISTS likes_user ON likes(user_id);

CREATE TABLE IF NOT EXISTS reports (
  post_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  created INTEGER NOT NULL,
  PRIMARY KEY (post_id, user_id)
);
