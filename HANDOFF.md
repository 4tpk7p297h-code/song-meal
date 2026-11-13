# 음식점 (song-meal) 인수인계 문서

> 새 Claude에게: 이 문서와 함께 받은 사이트 파일(index.html 등)을 읽고 이어서 작업해 주세요.
> 사용자에게는 한국어로 답해 주세요. 마지막 갱신: 2026-11-13 (사이트 v2.2, 업로드 zip 20261113_rev1, Worker song-meal-api v2.2)

## 1. 프로젝트 한 줄 요약
좋아하는 노래를 입력하면 곡 분위기(장르로 추정)에 맞는 오늘의 메뉴 3개와 주변 식당을 네이버 지도로 보여 주는 웹사이트.
원래 C 언어 콘솔 프로그램 "뮤직푸드"를 HTML5로 옮긴 것. **12월 중순 과제 발표용**이라 그때까지 끊김 없이 유지돼야 하고, 어디서든 접속돼야 함.

## 2. 현재 배포 상태
| 항목 | 값 |
|---|---|
| 사이트 주소 | https://song-meal.pages.dev (Cloudflare Pages, 메인) / https://4tpk7p297h-code.github.io/song-meal/ (GitHub Pages, 예비) |
| 저장소 | github.com/4tpk7p297h-code/song-meal (public) |
| 예전 계정 | minchan-creator: GitHub 이용약관 위반으로 제한돼 사용 불가 |
| 식당 검색 프록시 | https://naver-search.fare1451.workers.dev (Cloudflare Worker, 코드: worker/naver-search.js) |

## 3. 파일 구성
- `index.html`: 앱 전체 (HTML+CSS+JS 한 파일, 빌드 과정 없음)
- `privacy.html`: 개인정보 처리방침. **[운영자 이름], [연락 이메일] 자리표시자를 아직 채우지 않음**
- `worker/naver-search.js`: Cloudflare Worker. 허용 Origin은 https://4tpk7p297h-code.github.io 하나뿐. 주소가 바뀌면 여기에 추가해야 함
- `mascot.png`(캐릭터 전신), `icon-32.png`, `icon-192.png`, `apple-touch-icon.png`(캐릭터 얼굴 파비콘), `og.png`(공유 미리보기 1200x630)
- `.nojekyll`, `README.md`

## 4. 외부 서비스와 키 (비밀값은 이 문서에 없음)
- **네이버 지도 (NCP Maps JS v3)**: Client ID `o8sqmz7fug`. 공개값이고 URL로 제한돼 있음.
  - 스크립트: `https://oapi.map.naver.com/openapi/v3/maps.js?ncpKeyId=o8sqmz7fug&submodules=geocoder`
  - **새 도메인으로 옮기면 NCP 콘솔 → Maps → Application → Web 서비스 URL에 그 주소를 추가해야 지도가 뜸.**
- **식당 검색**: NAVER API HUB 지역 검색 (`naverapihub.apigw.ntruss.com/search/v1/local`). 브라우저 → Cloudflare Worker → HUB 순서로 호출.
  - Cloudflare 변수: `NAVER_CLIENT_ID=zcvnckns7t`, `NAVER_CLIENT_SECRET`(Secret으로 저장, 채팅이나 저장소에 절대 쓰지 말 것)
  - 네이버 개발자센터의 "검색" API는 2026-07-31부터 신규 신청이 막혀서 HUB를 사용함
- **곡 정보**: 여러 음악 서비스를 비교해서 고름 (v2.1)
  - 브라우저에서 직접: iTunes Search/Lookup + Deezer API (JSONP, 키 없음). 앨범 이미지와 30초 미리듣기, 미리듣기 BPM 분석(Web Audio)에 사용
  - Worker song-meal-api의 `GET /music/search?a=가수&t=곡명&k=영어표기|...`를 거쳐: MusicBrainz(곡·첫 발매일·태그, 키 없음, 1초 1번 한도), Wikidata(한글↔영어 가수·곡 이름, 키 없음)
  - 선택: Worker Secret `SPOTIFY_CLIENT_ID`·`SPOTIFY_CLIENT_SECRET`(Spotify), `LASTFM_API_KEY`(Last.fm 오타 고침·태그)를 넣으면 같이 비교. 키가 없으면 그냥 건너뜀
  - Worker 주소 뒤에 `/health`를 열면 버전(2.2)과 각 서비스 켜짐/꺼짐이 보임
- Anthropic API는 사용자 요청으로 제거함 (다시 넣지 말 것)

## 5. 기능 요약 (현재 동작)
1. **동의 화면**: [필수] 만 14세 이상, 개인정보 수집·이용 / [선택] 국외 이전(Apple, Deezer, Cloudflare, MusicBrainz·Wikidata(서버를 거쳐 곡 이름만). 미동의 시 곡 검색과 식당 검색 끔), 위치정보(미동의 시 '현재 위치' 버튼 대신 입력 화면에 '선택 동의' 안내와 동의하기 버튼 #geo-ask, v2.2). 비회원 동의는 저장하지 않음
2. **입력**: 가수 이름(선택)과 노래 제목(필수), 식사 시간, 인원, 날씨(다중 선택 칩), 위치(직접 입력, 현재 위치, 지도에서 직접 고르기), 음식 종류(다중 선택), 음식 조건(자유 입력: "매운 음식 제외", "국물 좋아요" 등. parseCond, TAGS/SYN)
3. **추천 로직** (브라우저 안 규칙 기반):
   - 장르로 에너지(energyFromGenre)와 분위기(valenceFromGenre)를 각 1~3으로 추정
   - pickType으로 유형 A~F를 정하고, TYPES/WEATHER 메뉴 풀에서 3개를 고름
   - "국물" 같은 우선 조건은 3개 메뉴 모두에 적용함. 모자라면 안내 문구를 띄움
   - "다른 메뉴 추천"을 누르면 이미 나온 메뉴 그룹(GROUP)을 빼고 다시 고름
4. **결과**: 곡 분석(시놉시스, 인트로·벌스·후렴 해설, BPM, 미리듣기), 메뉴 3개, 사이트 안 네이버 지도(식당 마커, 3km 안만 '근처'로 판정). 길찾기: 모바일은 nmap:// 앱, PC는 map.naver.com 레거시 URL(PC 쪽은 동작 미확인). '🛵 배달 앱으로 주문하기' 체크(v2.2): 식당마다 배민·쿠팡이츠 버튼
5. **기타**: 라이트/다크/시스템 테마(localStorage "food.theme"), 로고를 누르면 동의 화면으로, 뒤로가기는 화면 단위로 이동(history.pushState), 로딩 중에는 블러 배경 위 가운데에 캐릭터 표시, 귀여운 디자인(Jua 폰트, 코랄 #ff7a59)
6. **공식 캐릭터**: 보라색 헤드폰을 쓰고 새싹이 달린 흰 고양이(사용자 제공 이미지). 파비콘, 헤더 로고, 동의 화면 인사, 로딩, og.png에 사용

## 6. 사용자가 요청했던 것 (시간 순, 모두 완료)
C 코드를 HTML5로 변환해 배포 → Anthropic API 제거, 이름 "음식점" → 네이버 지도 연동 → 음식 조건 자유 입력, 곡 분석(시놉시스/벌스/BPM) → 식당을 새 탭이 아닌 사이트 안 지도에 표시 → 유형 칩 제거, 위치 권한 대안(지도에서 고르기) → 곡 검색 정확도(아이유 밤편지 버그) → 추천 다양화와 중복 제거, 근처 식당이 없을 때 안내, 한 화면 레이아웃 → 한국 법령에 맞는 동의 화면과 처리방침 → 로고로 처음 화면, 곡 에너지 입력 삭제, 날씨·음식 종류 다중 선택, 네이버 길찾기, 테마 선택 → 공유 이름 통일, 국물 조건 로직, 귀여운 디자인 → 곡 분위기 입력 삭제, 캐릭터와 파비콘 → 뒤로가기, 노래 필수, 로딩 오버레이

## 7. 커뮤니티 기능 (2026-11-09 추가)
노래와 음식 사진 후기를 인스타 스토리처럼 올리고, 좋아요를 누르고, 음식 종류 7개 코너별로 좋아요 TOP 3를 보여 줌.
- 호스팅: **Cloudflare Pages** `song-meal.pages.dev` (대시보드에 zip 직접 업로드, GitHub 연동 없음). GitHub Pages는 예비 주소
- API: Worker `song-meal-api` (`worker/song-meal-api.js`) + D1 `song-meal-db` (`worker/schema.sql`), 바인딩 이름 `DB`
  - 주소: https://song-meal-api.fare1451.workers.dev (index.html의 `API` 상수), `/health`로 DB 상태 확인
  - 가입: 아이디+비밀번호+닉네임(이메일 없음), PBKDF2-SHA256 10,000회(무료 플랜 CPU 10ms 한도 때문), 토큰은 해시만 저장, 30일
  - 사진: 브라우저에서 긴 변 1080px JPEG(<650KB data URL) + 300x400 썸네일로 줄여 D1에 텍스트로 저장 (R2 안 씀)
  - 좋아요 계정당 1회, 신고 3건이면 자동 숨김, 하루 20개 글 제한, 로그인 5회 실패 시 5분 잠금, 탈퇴 시 전부 삭제
- 화면: 헤더 📸스토리 / 🏆순위 / 👤로그인, 결과 화면의 "이 조합으로 후기 올리기"(노래·메뉴·식당 자동 채움)
- 로컬 테스트: node:sqlite로 D1을 흉내 낸 서버를 띄워 확인함 (실제 Cloudflare 환경은 사용자 확인 필요)
- 남은 일: 처리방침의 [운영자 이름]/[연락 이메일] 채우기, 12월 초 시연 녹화, 정기 백업(D1 → Export)

## 7-1. 관리자와 업데이트 내역
- 관리자 아이디 `aiadmin` (worker의 ADMINS). 회원가입으로는 만들 수 없고, D1 콘솔에서 INSERT로 만든 계정. 비밀번호는 사용자만 앎(저장소에 없음)
- 관리자: 헤더의 "📋 업데이트 내역"(index.html의 CHANGELOG, APP_VERSION), 아무 후기나 삭제 가능, 탈퇴 불가
- **사이트를 바꿀 때마다 CHANGELOG에 새 버전을 맨 위에 추가하고 APP_VERSION을 올릴 것**
- 업로드 zip 이름: releases/song-meal-pages_YYYYMMDD_rev[n].zip
- v1.4: 회원은 가입할 때 서비스 동의를 함께 받고(필수: 메뉴 추천, 선택: 국외 이전 검색·위치), 로그인 뒤에는 동의 화면을 건너뜀. 선택 동의는 users.prefs(JSON)에 저장, 내 정보에서 변경. '가입 없이 이용'일 때만 예전 동의 화면 표시
- v2.2: 코너별 순위·스토리, 위치정보 동의 버튼, 배달 앱 연결
  - '🏆 순위·스토리' 탭(#rank) = 코너 타일 8개(✨ 전체 + KINDS 7개, 1위 사진·닉네임·좋아요, 후기 수). 누르면 #corner 화면(history state `{screen:"corner", k, sort, fromTiles}`)에서 그 코너 후기를 좋아요 순위(🥇🥈🥉, 4위…)/최신으로, 24개씩 더 보기. 예전 #feed 목록과 FEED 코드는 없앰 (옛 기록 screen:"feed"는 rank로 보냄)
  - 스토리를 닫고 돌아오면 다시 불러오지 않고 보던 자리 그대로(route()의 fromStory, ST.back). 후기를 올리면 그 코너의 최신순으로 이동, 코너 안 '후기 올리기'는 코너를 미리 골라 둠
  - Worker: /posts 순위 정렬을 '좋아요 → 먼저 올린 글 → id'로(코너 TOP 3와 같은 기준), /ranking에 코너별 후기 수 counts 추가 (옛 Worker여도 사이트는 동작, 후기 수만 안 보임)
  - 입력 화면 #geo-ask: 위치 미동의면 안내 + 동의하기(회원은 POST /me/prefs로 저장, 비회원은 이 페이지에서만). syncGeo()가 '현재 위치' 버튼과 안내를 함께 맞춤
  - 배달: 배민·쿠팡이츠 모두 공개 API·가게 바로가기 주소가 없어 '배달 가능 점포만 보기'나 가게 화면 바로 열기는 불가능. 대신 버튼을 누르면 가게 이름을 클립보드에 복사하고 앱을 엶 (안드로이드 intent://…;package=com.sampleapp / com.coupang.mobile.eats, 앱이 없으면 크롬이 플레이 스토어로. 아이폰 itms-apps:// 앱스토어 화면(id378084485 / id1445504255)에서 '열기'. PC는 복사만). 표시 여부는 localStorage food.dlv
- v2.1: 여러 음악 서비스 비교 검색 (lookupSong, pick, finish, musicServer)
  - 1단계: Apple 한국(입력 그대로)·Deezer(가수 영어 표기)·서버(/music/search)를 동시에 부름 → pick()이 같은 곡(sameSong: 곡명 같음 + 가수 일치 3점 이상)끼리 묶고 '점수 → 확인한 서비스 수 → 먼저 나온 순'으로 고름. 곡명만 입력하면 각 서비스 상위 결과의 순위 점수(1위 3점, 2위 2점, 3위 1점, MusicBrainz 제외) 합으로 고름
  - Apple·Deezer(미리듣기 있는 곳)가 들어 있는 묶음을 찾으면 끝. MusicBrainz에서만 찾았으면 2단계(서버가 알려 준 영어 표기·다른 곡명으로 Apple·Deezer 다시)를 돈 뒤에도 없을 때 MusicBrainz 결과를 씀
  - 서버가 알려 준 이름은 DYN(가수)·TDYN(곡명) Map에 저장해 aliasForms()·titleScore()가 같이 씀 (페이지를 닫으면 사라짐)
  - finish(): 표지·미리듣기 Apple→Deezer 순, 장르 Apple→Deezer 앨범→태그, 연도는 가장 이른 날짜(MusicBrainz 첫 발매일). 결과에 sources(확인한 서비스 목록) 저장, 결과 화면에 '🔎 n곳에서 같은 곡 확인'
  - 서버가 옛 버전(404)이거나 안 되면 Apple·Deezer만으로 v2.0처럼 동작. 관리패널 곡 검색 점검 위에 서버 버전·서비스 상태 표시
  - Worker: 서버 메모리에 같은 검색 30분 기억(실패한 서비스가 있으면 안 함), IP당 1분 40번 제한, 전체 6.5초 안에 끝냄, MusicBrainz 503이면 1.1초 뒤 한 번 더
- v2.0: 곡 검색 재작성 (index.html의 lookupSong). 순서: 입력 그대로(Apple 한국) → 사전의 영어 표기(한국) → 영어 표기(미국) → 곡명 전용 검색(songTerm) 후 가수 비교(한국·미국) → 가수의 전곡 목록 → Deezer. 확정 점수 5 이상이면 바로 멈춤(보통 1~3번 요청)
  - 가수 사전 ARTISTS: 한 줄에 '영어|한글|변형' (약 450줄, 양방향). 사전에 없으면 phon()으로 한글↔영어 자음 뼈대 비교 (칸예 웨스트=KNST=Kanye West)
  - Apple 검색 한도(약 20번/분) 때문에 itTake()로 1분 18번까지만 요청(localStorage food.itlog), 실패 시 45초 쉼 → Deezer로. 찾은 곡은 localStorage food.songs에 7일 저장
  - 못 찾은 이유 lookupSong.last.reason: off(선택 동의 꺼짐 → 결과 화면에 '내 정보에서 켜기' 버튼), busy(Apple 막힘), none, partial
  - 관리자 계정(aiadmin)은 prefs가 비어 있어 곡·식당 검색이 꺼진 상태로 시작함. 내 정보 → 선택 동의 관리에서 켜야 함
  - 관리패널 '🎵 곡 검색 점검' 탭: 여러 곡을 실제로 검색해 단계별 과정(로그)을 보여 줌. 실제 Apple 응답은 이 도구로 사용자 브라우저에서 확인 (작업 환경에서는 itunes.apple.com, api.deezer.com, musicbrainz.org, wikidata.org 접속 불가 → 가짜 서비스로 시험)
- v1.9: 곡 검색 개선. ALIAS에 해외 가수 한글 표기 100여 명, norm이 악센트·&·The·feat 무시, 오타 허용(편집 거리 80%), kr·us 스토어와 Deezer를 단계별 병렬 검색, 커버·카라오케 감점, 한글 가수명을 확인 못 하면 unverified 안내
- v1.8: 📸스토리 탭 제거, 🏆 순위·스토리 탭 안(TOP 3 아래)에 #feed 목록 (v2.2에서 코너 화면으로 바뀜). 스토리 열면 미리듣기 자동 재생(하나의 Audio 재사용), 끝나면 다음 스토리, 미리듣기 없으면 7초, 댓글 창 열려 있으면 닫을 때 넘어감
- v1.7: 헤더 맨 앞 🎵 음악찾기(로고와 같은 동작), 결과 제목 '뮤디의 추천 음식'. 공식 캐릭터 이름은 '뮤디'
- v1.6: 추천 입력의 노래 칸을 '가수 이름'(선택) + '노래 제목'(필수)으로 나눔. 검색할 때는 '가수 - 곡명'으로 합침
- v1.5: 헤더 🚪 로그아웃 버튼, 스토리 💬 댓글(comments 표, 150자, 시간당 30개, 본인·글쓴이·관리자 삭제), 결과 화면 유튜브·스포티파이·애플뮤직 전곡 듣기 링크(검색 URL, 애플은 iTunes trackViewUrl 우선)
- 관리자 패널(헤더 🛠️ 관리패널, 관리자만 보임): 통계, 후기 관리(신고·숨김 필터, 신고 사유, 숨김/해제, 삭제), 회원 관리(닉네임 변경, 임시 비밀번호 발급, 잠금 해제, 계정 삭제), 업데이트 내역

## 8. 작업할 때 주의
- 비밀값(Client Secret, API 키)은 저장소나 채팅에 절대 넣지 말 것. Cloudflare Secret에만 저장
- 주소를 옮기면 바꿀 곳: NCP 지도 Web 서비스 URL, Worker 허용 Origin, index.html의 og:url과 og:image
- 사용자는 비개발자라서 단계별 체크리스트와 스크린샷 기준 안내를 선호함

## 9. 인수인계 묶음 사용법 (새 Claude에게)
- 이 zip 안: HANDOFF.md(이 문서), site/(사이트 파일, Pages에 올리는 것과 같음), worker/(song-meal-api.js, naver-search.js, schema.sql, comments-setup.sql)
- 지금 서비스는 이미 Cloudflare(Pages·Worker·D1)에서 돌아가고 있음. 새로 만들 필요 없이, 고친 파일을 사용자에게 주면 사용자가 대시보드에서 직접 올림
  - 사이트 변경: site/ 파일을 zip으로 묶어 song-meal-pages_YYYYMMDD_rev[n].zip으로 전달 (마지막: 20261113_rev1)
  - 서버 변경: song-meal-api.js 전체를 Worker 편집기에 붙여 넣고 Deploy
  - DB 변경: 주석 없는 SQL을 D1 Console에 붙여 넣기 (주석이 있으면 "No SQL statements detected")
- 회원·후기 데이터는 D1 안에 있어서 이 zip에는 없음 (백업은 D1 → Export)
