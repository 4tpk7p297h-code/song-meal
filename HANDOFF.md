# 비트밥스 (song-meal) 인수인계 문서

> 새 Claude에게: 이 문서와 함께 받은 사이트 파일(index.html 등)을 읽고 이어서 작업해 주세요.
> 사용자에게는 한국어로 답해 주세요. 마지막 갱신: 2026-11-23 (사이트 v5.2, 업로드 zip 20261123_rev2, Worker song-meal-api v3.5 · naver-search v2.3)

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
- `worker/naver-search.js`: Cloudflare Worker(식당 검색 중계, v2.3). 지역 검색(`?query=`)과 블로그 검색(`?type=blog&query=`, 혼밥 후기용). 허용 Origin은 GitHub Pages 예비 주소, song-meal.pages.dev와 그 미리보기 주소. 주소가 바뀌면 ALLOWED에 추가해야 함. `/health`는 버전, `/health?check=1`은 네이버 지역·블로그 검색이 실제로 되는지(1분 기억)
- `mascot.png`(캐릭터 전신), `icon-32.png`, `icon-192.png`, `apple-touch-icon.png`(캐릭터 얼굴 파비콘), `og.png`(공유 미리보기 1200x630)
- `.nojekyll`, `README.md`

## 4. 외부 서비스와 키 (비밀값은 이 문서에 없음)
- **네이버 지도 (NCP Maps JS v3)**: Client ID `o8sqmz7fug`. 공개값이고 URL로 제한돼 있음.
  - 스크립트: `https://oapi.map.naver.com/openapi/v3/maps.js?ncpKeyId=o8sqmz7fug&submodules=geocoder`
  - **새 도메인으로 옮기면 NCP 콘솔 → Maps → Application → Web 서비스 URL에 그 주소를 추가해야 지도가 뜸.**
- **식당 검색**: NAVER API HUB 지역 검색 (`naverapihub.apigw.ntruss.com/search/v1/local`)과 블로그 검색(`.../search/v1/blog`, v2.3 혼밥 후기). 브라우저 → Cloudflare Worker(naver-search) → HUB 순서로 호출.
  - **API HUB 애플리케이션에서 '지역 검색'과 '블로그 검색'을 둘 다 골라 둬야 함** (같은 Client ID·Secret). 블로그 검색이 빠져 있으면 혼밥은 가게 분류로만 고르고 안내가 뜸. 관리패널 📊 현황 맨 아래에서 확인 가능
  - 2026-11 기준 API HUB 검색 API는 한시적 무료(하루 25,000번 정도). 혼밥 필터를 켜고 한 번 추천받으면 블로그 검색이 가게 수만큼(보통 20~40번) 불리지만, 기기에 7일·Worker에 6시간 기억해서 같은 가게는 다시 안 부름
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
4. **결과**: 곡 분석(시놉시스, 인트로·벌스·후렴 해설, BPM, 미리듣기), 메뉴 3개, 사이트 안 네이버 지도(식당 마커, 3km 안만 '근처'로 판정). 길찾기: 모바일은 nmap:// 앱, PC는 map.naver.com 레거시 URL(PC 쪽은 동작 미확인). '🛵 배달 앱으로 주문하기' 체크(v2.2): 식당마다 배민·쿠팡이츠 버튼. '🙋 혼밥 가능한 곳만 보기' 필터와 식당별 혼밥 태그(v2.3)
5. **기타**: 라이트/다크/시스템 테마(localStorage "food.theme"), 로고를 누르면 동의 화면으로, 뒤로가기는 화면 단위로 이동(history.pushState), 로딩 중에는 블러 배경 위 가운데에 캐릭터 표시, 귀여운 디자인(Jua 폰트, 코랄 #ff7a59)
6. **공식 캐릭터**: 보라색 헤드폰을 쓰고 새싹이 달린 흰 고양이(사용자 제공 이미지). 파비콘, 헤더 로고, 동의 화면 인사, 로딩, og.png에 사용

## 6. 사용자가 요청했던 것 (시간 순, 모두 완료)
C 코드를 HTML5로 변환해 배포 → Anthropic API 제거, 이름 "음식점" → 네이버 지도 연동 → 음식 조건 자유 입력, 곡 분석(시놉시스/벌스/BPM) → 식당을 새 탭이 아닌 사이트 안 지도에 표시 → 유형 칩 제거, 위치 권한 대안(지도에서 고르기) → 곡 검색 정확도(아이유 밤편지 버그) → 추천 다양화와 중복 제거, 근처 식당이 없을 때 안내, 한 화면 레이아웃 → 한국 법령에 맞는 동의 화면과 처리방침 → 로고로 처음 화면, 곡 에너지 입력 삭제, 날씨·음식 종류 다중 선택, 네이버 길찾기, 테마 선택 → 공유 이름 통일, 국물 조건 로직, 귀여운 디자인 → 곡 분위기 입력 삭제, 캐릭터와 파비콘 → 뒤로가기, 노래 필수, 로딩 오버레이

## 7. 커뮤니티 기능 (2026-11-09 추가)
노래와 음식 사진 후기를 인스타 스토리처럼 올리고, 좋아요를 누르고, 음식 종류 7개 코너별로 좋아요 TOP 3를 보여 줌.
- 호스팅: **Cloudflare Pages** `song-meal.pages.dev` (대시보드에 zip 직접 업로드, GitHub 연동 없음). GitHub Pages는 예비 주소
- API: Worker `song-meal-api` (`worker/song-meal-api.js`) + D1 `song-meal-db` (`worker/schema.sql`), 바인딩 이름 `DB`
  - 주소: https://song-meal-api.fare1451.workers.dev (index.html의 `API` 상수), `/health`로 DB 상태 확인
  - 가입: 아이디+비밀번호+닉네임(이메일 없음) 또는 카카오로 시작하기(v2.7), PBKDF2-SHA256 10,000회(무료 플랜 CPU 10ms 한도 때문), 토큰은 해시만 저장, 30일
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
- v3.3: 테스터 의견 반영. 날씨 칸 '🌡️ 지금 날씨 가져오기'(#wx-now): resolveLoc(위치) 좌표를 소수 둘째 자리로 줄여 Open-Meteo(api.open-meteo.com, 키 없음, 비상업 무료) current=temperature_2m,apparent_temperature,weather_code → 하늘 칩 1개 + 체감 28↑ 더움 / 5↓ 추움 체크. 기온 직접 입력 #wx-temp. resolveLoc(): 네이버 geocode(주소) 실패 시 naver-search 장소 검색(검색어=위치만)으로 역·학교·건물 좌표, drawMapInner도 이걸 씀. 국외 이전 동의(abroad) 필요, 동의 문구·처리방침에 Open-Meteo 추가. 시험: t34.js
- v3.4: 관리패널 업데이트 내역을 버튼식으로(사용자 요청: 펼치지 말고 스크롤 없이). .logmaj 큰 버전 버튼(v2·v1·v0) → .logsub 세부 버전 버튼 → .logv에 고른 버전 하나만 표시. CHANGELOG 데이터 형식은 그대로라 새 항목은 맨 위에 넣으면 자동으로 묶임(큰 버전 이름은 렌더러의 name 표). rev9의 접기 방식은 폐기. 시험: t35.js
- v3.5: '지금 날씨 가져오기'가 위치 칸 없이도 동작. 순서: 위치 칸 resolveLoc → wxHere()(CONSENT.geo일 때 기기 GPS 좌표만, 주소 변환·위치 칸 채우기 없음) → 서울(37.57,126.98) 기준 + 안내. 국외 이전 동의(abroad)는 여전히 필요. 시험: t35w.js
- v3.6: 사이트 이름 '비트밥스'(2026-11-16 사용자 요청; 주소 song-meal.pages.dev·저장소·Worker 이름은 그대로, og.png 다시 만듦). 회원가입·로그인 화면 다국어(ko·en·ja·zh): #langbar 버튼, [data-i18n] 요소는 원래 한국어를 I18N_KO에 기억해 두고 I18N[키]=[en,ja,zh]로 바꿈, 스크립트 문구는 tt(키, 한국어, vars), 서버·검사 오류는 한국어로 받아 ttErr()로 표시만 번역(I18N_ERR). LANG_HOOKS로 nav-me·가입 버튼·비밀번호 안내·말풍선·오류 다시 그림. localStorage food.lang. 외국어 표기 이름 BeatBobs(영어·중국어)/ビートバプス. 다른 화면(입력·결과·순위 등)은 아직 한국어. 시험: t36.js
- v3.7: 사이트 전체 다국어. lang.js = 화면 번역 엔진(MutationObserver로 새로 그려지는 글자를 바꿈. 앱 로직은 계속 한국어로 돌고, 보이는 글자만 번역). 글자 노드는 TR[한국어]=[en,ja,zh]로 정확히 일치, 안쪽에 b·span 등만 있는 요소는 TR_HTML[innerHTML], placeholder·title·aria-label·alt도 번역, 숫자·이름이 섞인 문장은 RULES(정규식+함수). 원래 한국어는 WeakMap에 기억해 한국어로 돌아가면 복원. translate="no"·textarea·.notr 안은 건드리지 않음(업데이트 내역 #adm-log는 한국어 유지). 못 바꾼 글자는 window.__i18nMiss에 모임. API: I18.set(lang)/I18.t(ko), applyLang 끝에서 호출. lang-data.js = 번역 사전(window.I18N_DATA={TR,TR_HTML,RULES}); 세션 밖 스크립트로 만들었지만 직접 고쳐도 됨. 화면 문구를 바꾸거나 새로 넣으면 lang-data.js TR에 같은 한국어 키로 [en,ja,zh]를 추가해야 번역됨. 가게 이름·주소·후기·닉네임·곡 제목은 번역 안 함. 배포 zip에 lang.js·lang-data.js 꼭 포함.
- v3.8: 캐릭터 리디자인(2026-11-17 사용자 요청, 사용자가 준 토마토·헤드폰 버섯·돈가스 셰프 3개를 합침): 토마토 꼭지+헤드폰+빨간 버섯 갓(흰 점)+바삭한 주황 돈가스 몸+뒤집개+락 손. 원본은 SVG로 직접 그림(/mnt/project-files/song-meal/mascot.svg). mascot.png·아이콘 5개·og.png 다시 만듦. 이미지 주소는 ?v=3으로 바꿔 카카오톡 등 링크 미리보기 캐시를 피함(이미지 바꿀 때마다 숫자 올리기). 이름 '뮤디'는 그대로.
- v3.9: 사용자 정정("셋이 나란히 친구처럼, 부위를 합치는 게 아니라") → v3.8 합친 캐릭터 폐기. 사용자가 준 원본 3장(헤드폰 토마토·헤드폰 버섯·뒤집개 돈가스 셰프)의 배경만 투명하게 따서 나란히 배치. 원본 조각·단체 그림: /mnt/project-files/song-meal/characters/(tomato·mush·cutlet·group.png). mascot.png(단체 900×369)는 헤더 로고·첫 화면·로딩, 앱 아이콘은 버섯 위·토마토/돈가스 아래 삼각형, icon-32는 버섯만. 이미지 주소 ?v=4.
- v4.0: 팀원 피드백 반영. 첫 화면 #hub 두 패널(노래 추천 #shop / 기존 메뉴 추천). 노래 추천 = 가게 사진(768px JPEG)+이름·위치 → Worker POST /shop/vibe → Gemini(Secret GEMINI_API_KEY, 모델 gemini-2.5-flash→flash-latest→2.0-flash, IP당 분당 6회) → 10곡 JSON. 키 없음·한도·실패 시 브라우저 자체 분석(사진 색감 analyzePixels + 가게 종류 SCENES) + 내장 SHOP_SONGS(실제 곡 ~120). 미리듣기는 기존 lookupSong 호출만(수정 안 함). 새 화면은 .notr + T4(ko,en,ja,zh) 직접 번역. 동의: 게스트·가입 모두 필수(국외 이전·위치), 국외 이전에 Google LLC 추가, privacy.html 동일 반영. resolveLoc: 짧은 동네 이름은 이름 포함 장소 검색 우선→'이름+동' 지오코딩, 주소 후보 여러 개면 5km 안 장소 검색으로 확인(마곡→강서구 마곡동). 음량: localStorage food.vol, 계정 설정 #vol-box.
- v4.1: (1) 곡 검색 피드백: 결과 #songfb 👍/👎 → 다른 후보(pick.groups)·직접 검색(lookupSong fresh) → pickFix가 songCache+songDone 재렌더. Worker POST /song/fb, GET /song/fix (D1 song_fb·song_fix 자동 생성), 서로 다른 2명(FIX_MIN) 이상 같은 정정 & '원래 결과 맞아요'보다 많으면 submit 때 lookupSong(정정 곡)을 먼저 부름(lookupSong 자체는 수정 안 함). 관리패널 🎯 곡 피드백(승인 1/막기 -1). (2) 노래 추천 곡 실제 확인: Worker verifySongs가 Deezer 검색(키 없음, 요청 45회 예산)으로 AI 15곡+내장 예비 20곡(pool, 한글 가수는 ARTISTS로 영어 표기) 중 확인된 곡만 10곡, preview·art 붙여 줌 → 미리듣기 바로 재생, 모자라면 내장 곡으로 채움. 키 없으면 POST /shop/verify. (3) POST /music/check: Gemini(flash-lite 우선)가 입력↔찾은 곡 일치 판단+Last.fm 태그 참고 곡 분석, 다르면 제안 곡(Deezer 확인된 것만) → #sfb-ai로 바꾸기. 일치하면 energy/valence를 AI 값으로(energyBy 'ai'). (4) 관리패널 '내 계정' 탭 삭제(사용자 요청). 멜론·지니는 공개 API 없음.
- v4.2: 사용자 규칙 '버전 끝자리는 0~9, 9 다음은 바로 다음 큰 번호' → 예전 v2.10~2.19를 v3.0~3.9, v2.20·2.21을 v4.0·4.1로 바꿈(업데이트 내역·APP_VERSION·sw CACHE·lang ?v). Worker song-meal-api도 2.10·2.11 → 3.0·3.1. 다음 사이트 버전은 v4.3.
- v4.3: 사용자 결정(국내 플랫폼 공식 API 없음 → 멜론 비공식 대신 Spotify 키): verifySongs가 Deezer에 없으면 spFind(기존 spotify() 재사용, market=KR, 15회 예산)로 확인. Secret SPOTIFY_CLIENT_ID·SPOTIFY_CLIENT_SECRET는 사용자 설정 대기.
- v4.4: 사용자 '검색결과 탭이 복잡, 이전 비율 유지' → #songfb를 #result 밖 고정 팝업(오른쪽 아래, 모바일은 아래 전체 폭)으로. 결과 뜬 뒤 2.8초 후 표시, ✕ 닫기, 고마워요는 3.5초 뒤 자동 닫힘. 로딩 제목 #load-title: 노래 추천 때 전용 문구, 끝나면 기본 문구로 되돌림.
- v4.5: 사용자 정정 — '관리자 비밀번호 변경 없애기'는 관리자 계정의 내 정보 #pw-box를 숨기라는 뜻(회원 비밀번호 초기화는 유지). v4.1에서 지운 관리패널 '내 계정' 탭(안내뿐)은 지운 채로 둠.
- v4.6: 개인정보 처리방침 최신화(사용자 요청). privacy.html: 목적(곡 확인·피드백), 위탁(네이버 가게 정보, Cloudflare 피드백 보관·중계), 국외 이전(피드백 표 신설, Spotify·Last.fm 분리, Deezer·Cloudflare·Google 갱신), 기기 저장 항목, 11/19 개정 이력. 앱 안 동의(x2.to/items/purpose/when, 손님 목적 칸은 새 키 x2.purpose.full) 4개 언어 I18N 갱신. 새 외부 서비스를 붙이면 privacy.html과 이 키들을 같이 고칠 것.
- v4.7: 전체 화면 최적화·디자인(사용자 요청, 메뉴·탭 구성은 그대로). index.html 끝의 "v4.7 레이아웃·디자인" CSS 블록: 붙는 반투명 머리글(모바일은 로고+테마 한 줄, 메뉴 가로 스크롤), PC(≥960) main 1120px, 메뉴 입력 .fgrid/.fcol 2단, 가입 #auth 2단·.pmore로 안내 표 접기·.idpw.fgrid2, 노래 추천 결과 때 #shop-form 숨김(다시 입력에서 보임)·PC 카드별 스크롤. 측정 스크립트 ux.js: PC는 모든 화면 1~1.17화면, 모바일 가입 3.5→2.1, 입력 2.2→1.55, 노래 결과 5.8→2.9.
- v4.8: 처음 화면 언어 버튼 간격. aiBar() 배지(파란 Gemini / 회색 기본 분석 + aiWhy 이유: off·busy(Gemini 429)·limit(서버 자체 1분 10번)·key·time·net·consent) 노래·메뉴 결과 맨 위. 한국어 곡 이중 검색 aliasLookup(): 첫 검색이 못 찾음·미리듣기 없음·다른 가수면 Worker /music/alias(Gemini가 Apple Music 등록 영어 이름) → lookupSong 재호출, 이름이 맞으면 채택하고 기기에 저장. lookupSong 자체는 그대로. Worker v3.3.
- v4.9: 사용자 실제 화면에서 '세븐틴 소용돌이'가 Last.fm(서버)에서만 '세븐틴 (Seventeen) - 소용돌이 (To you)'로 찾아져 미리듣기 없음 + AI 9초 초과. aliasLookup 1단계로 괄호 속 이름 재검색(AI 없이), 2단계 Gemini. 타임아웃 alias 15초·check 18초. Worker v3.4 askGemini fast 옵션(2.5-flash 계열 thinkingBudget 0).
- v5.0: 다국어 전면 점검(스크래치 crawl3.js: en/ja/zh로 모든 화면을 돌며 window.__i18nMiss + 보이는 한국어 수집). TR 추가(곡 고르기 '이 곡이에요', 장르 26개, 네이버 가게 분류 + 규칙 '분류 · 주소'), lang.js가 textarea placeholder도 번역, 관리 곡 피드백 행은 T4. 남는 한국어는 가게 이름·주소·닉네임·곡 이름(데이터, 의도). 해외 위치: inKorea()/ABROAD() — 현재 위치·지도 고르기·영문 주소 입력이 한국 밖이면 안내(네이버 검색은 한국만). 모바일 .cnav nowrap, #map z-index 0.
- v5.1: 사용자 요청 '가게 이름·주소는 한국어 외 모든 화면에서 영어로'. romanize()(국어의 로마자 표기법: 연음·콧소리·ㄹ 처리), nameEn()(…점 → Branch), addrRoman() 대체 + fillEnAddr()(네이버 geocode englishAddress, 한국어 아닐 때만). pName()/pAddr()가 .kov/.env 두 span을 그리고 CSS html[lang] 으로 전환. 길찾기·네이버 지도 링크·배달 앱 복사는 한국어 이름 유지.
- v5.2 (Worker v3.5): 사용자 요청 '곡 검색 정정을 관리자 승인 없이 자동 반영'. songFix() 점수제: 정정 1명당 1점, AI(Gemini lite, song_ai 테이블에 입력·곡당 한 번 저장) 같은 곡 +1.5 / 다른 곡 -1, 2점 이상이고 '맞아요' 표보다 높으면 적용. 관리자 state 1(고정)·-1(막기)은 그대로 우선. lookupSong 등 검색·매칭 로직은 손대지 않음.
- v3.2: Last.fm 분위기 태그는 분석에만 (사용자 지시: 곡 검색·결과 도출 로직은 절대 건드리지 말 것). Worker GET /music/mood?a=가수|별칭&t=곡명|다른표기 → track.getTopTags(태그 3개 이상) 아니면 artist.getTopTags, 30분 메모. 사이트: 곡이 정해진 뒤 lastfmMood() → moodFromTags(MOOD_RE eLow/eHigh/vNeg/vPos, count 비중) → v.energy/v.valence 덮어씀(관련 태그 없으면 장르 추정 유지). 시험: 스크래치패드 mood.mjs(Worker), t33.js(화면)
- v3.1: 화면 비율 (style 끝 'v3.1' 블록). viewport-fit=cover + safe-area 여백, max-width 360px 좁은 화면(.row 한 줄, 테마 .tl 숨김), 700~959px 또는 960+ 높이 559 이하에서 결과 2칸, 기존 3칸은 min-height 560 이상만, horizontal-viewport-segments: 2(듀얼 스크린) 경첩 피하기. 가입 비밀번호 실시간 안내 #su-pwcheck/#su-pw2check(pwSync), #auth-err 상자+흔들기. 시험: 스크래치패드 t31.js(9개 화면 크기 가로넘침 검사), t32.js
- v3.0: 사용자 브라우저의 실제 응답(Deezer '싸이 예술이야' → Psy "Fantastic Duo 2 Part.4 '예술이야'", 싸이 (PSY) "It's Art" / Apple 미국 'PSY 예술이야' → It's Art (Live), It's Art, I LUV IT …, Apple 한국은 0곡)으로 재현(스크래치패드 lktest6.mjs). 합치기는 pick 묶음 대신 pool에서 직접: hit 표시 + 서버 확정 곡의 가수 + 라이브·MR 제외 원곡이 Apple·Deezer 2곳에서 sameSong이면 확정. 한 칸·곡명만 입력도 됨. 점검 로그에 검색 결과 맨 위 3곡(top3)
- v2.9: 실제 사례 '싸이 - 예술이야'(Apple·Deezer엔 영어 제목, 서버는 한글 제목)를 위한 hit 점수. '가수+곡명' 검색(stage1 두 칸 입력, 2단계 영어 표기, fill)의 맨 위 3곡에 hit 표시 → pick에서 곡명이 안 맞아도 가수가 맞으면 4점(확정 아님). 서버가 확정했는데 미리듣기가 없을 때 hit 4점 묶음이 Apple·Deezer 등 2곳 이상이면 합쳐서 확정(표시는 입력 제목), 1곳이면 후보 창. titleScore1은 괄호 속 다른 언어 제목도 같은 제목으로 봄. 미리듣기 없는 결과 저장 10분
- v2.8: 곡 검색 미리듣기 빠짐 줄이기 (lookupSong). 2단계까지 Apple·Deezer 곡을 못 찾고 서버(Last.fm·MusicBrainz 등)에서만 확인되면 fill(): 그 곡의 가수·곡명으로 Deezer artist:/track:, Apple 한국, Deezer 일반, Apple 미국 순으로 다시 찾음. 그래도 애매하면(미리듣기 없음·mismatch·unverified) lookupSong.last.cands(pick.groups 중 미리듣기 있는 상위 3개) → 제출 화면에서 askSong() 후보 창(#songpick), 고르면 chooseSong()이 기기에 저장. Deezer 미리듣기 주소의 exp가 지났으면 freshPreview()로 새 주소(곡 번호 /track/ 또는 검색), 스토리 재생 오류 때도 1번 갱신. 미리듣기 없는 결과는 기기에 1시간만 저장. 시험: 스크래치패드 lktest5.mjs(7건), t30.js
- v2.7: 카카오로 시작하기 (기존 아이디 가입·로그인 유지). 카카오에서는 회원번호만 받고 users.login = "kakao:회원번호"로 저장(스키마 변경 없음, UNIQUE라 카카오 계정 1개당 1명, 비밀번호 해시는 무작위라 아이디 로그인 불가)
  - Worker: GET /auth/kakao/start?back=사이트주소 → 카카오 → GET /auth/kakao/callback(state 서명 + ks 쿠키 확인, 토큰 교환, /v2/user/me) → 사이트#kakao=login|signup|error&t=서명된 표(2분/15분). 사이트가 POST /auth/kakao/login 또는 /signup/kakao 로 표를 로그인 토큰으로 바꿈(토큰이 주소창에 안 남음)
  - Secret: KAKAO_REST_KEY, KAKAO_CLIENT_SECRET(둘 다 있어야 켜짐, /health의 kakao), 선택 KAKAO_ADMIN_KEY(탈퇴 때 unlink). 카카오 개발자 콘솔 Redirect URI: https://song-meal-api.fare1451.workers.dev/auth/kakao/callback
  - 카카오 회원: 비밀번호 변경 숨김, 탈퇴는 확인 체크(confirm:true), 관리자 비번 초기화 불가. 관리패널 현황에 '커뮤니티 서버' 줄(카카오 켜짐/꺼짐). 시험: 스크래치패드 dev4.mjs(가짜 카카오) + t29.js
- v2.6: 홈 화면 앱(PWA). manifest.webmanifest(아이콘 icon-192/512, icon-maskable-512), sw.js(같은 사이트 파일만 네트워크 우선 + 오프라인 때 캐시, CACHE 이름을 버전마다 바꿈), 헤더 #nav-install(안드로이드 beforeinstallprompt 설치 창, 아이폰은 공유 → 홈 화면에 추가 안내, standalone이면 숨김). 업로드 zip에 manifest.webmanifest·sw.js·icon-512.png·icon-maskable-512.png 포함 필수. 스토어 출시(플레이 12명 14일 테스트, 앱스토어 99달러·4.2 거절 위험)는 검토만 하고 보류
- v2.5: 곡 검색 개선 (lookupSong·score). comboScore: 한 칸에 '가수 곡명'/'곡명 가수'를 써도 띄어쓰기로 나눠 곡명+가수로 맞춤, 확정 못 하면 2단계에서 사전 가수를 떼어(split1) 영어 표기로 Deezer·Apple 다시. artistOnly: 사전에 있는 가수 이름만 쓰면 2점 → 인기 순으로 대표곡. isVariant는 곡명의 괄호·' - ' 꼬리(deco)만 봄. 1단계는 Apple·Deezer가 확실하면(두 곳 확인, 또는 곡명·가수 정확히 같음 7점, 또는 곡명만 검색) 서버를 0.8초까지만 기다림. 사전에 없는 한글 가수는 Deezer를 track:"곡명"으로. 시험: 스크래치패드 lktest3(기존 61건)·lktest4(새 18건) 모두 통과
- v2.4: 아이폰 배달 버튼이 앱스토어 대신 baemin:// · coupangeats://로 앱을 바로 엶 (2026-11-14 사용자 아이폰에서 두 주소 모두 '열기' 확인 후 앱 열림). 앱이 없으면 사파리 오류 창이 뜨므로 안내 창(toast, html)에 앱스토어 설치 링크
- v2.3: 혼밥 가능한 식당 찾기 (index.html의 '혼밥 확인' 블록: SOLO, searchBlog, blogSolo, soloJudge, soloOf, passSolo, soloTag, candidates)
  - 네이버 지도(플레이스) 방문자 리뷰와 '혼밥하기 좋아요' 키워드 리뷰는 공식 API가 없고, 긁어 오기는 막혀 있고 약관 위반이라 쓰지 않음. 대신 API HUB 공식 '블로그 검색'으로 "가게이름 혼밥"을 찾아, 글 제목·요약에 가게 이름(지점명을 뺀 coreName)과 혼밥 이야기(SOLO_POS: 혼밥·혼자·1인석·바 좌석 등)가 함께 나온 글 수를 셈. 어렵다는 말(SOLO_NEG: 혼밥 눈치·2인 이상 주문 등)은 따로 셈
  - 판정: review('🙋 혼밥 후기 n건', 누르면 네이버 블로그 검색) → hard('👥 혼밥이 어렵다는 후기') → 가게 분류 CAT_SOLO(국밥·라멘·돈가스 등 → '🙋 혼밥하기 좋은 메뉴') / CAT_GROUP(고기구이·한정식·술집 등 → '👥 여럿이 가기 좋은 곳') → none(태그 없음)
  - 입력 화면 #solo 칩(인원을 1명으로 하면 자동, 음식 조건에 '혼밥'이라고 써도 됨) → 추천 조건에 {tag:"혼밥"}('혼밥 우선', SOLO_FOODS 68개 메뉴 먼저), 메뉴에 '🙋 혼밥 메뉴'
  - 결과 지도 카드 #solo-on '혼밥 가능한 곳만 보기': review 또는 menu인 식당만 보여 줌. 필터를 켜면 'kw 혼밥' 지역 검색 결과도 더하는데, 이렇게 더 찾은 식당(extra)은 review일 때만. 숨긴 수 안내, 추천 메뉴 배지 '혼밥 식당 n곳'. 필터를 꺼도 목록 태그는 붙음
  - 호출 줄이기: 기기 localStorage food.solo에 가게별 결과 7일(최대 300곳), 한 번에 3개까지, 보고 있는 목록 먼저. Worker 메모리에 블로그 6시간·지역 30분
  - 블로그 검색이 안 되면(옛 Worker이거나 API HUB 401/403/404 → 새로고침 전까지, 그 밖의 오류 → 2분 쉼) 가게 분류로만 고르고 #solo-note 안내
  - 관리패널 📊 현황 맨 아래 '식당 검색 서버': /health?check=1 결과(지역·블로그 검색 ✅/❌, 옛 Worker 안내)
  - 한계(사용자에게 설명함): 후기 수는 참고용. 체인점은 다른 지점 글도 세고, 이름이 흔한 가게는 다른 가게 글이 섞일 수 있음. 실제 플레이스 리뷰는 '네이버 지도에서 보기'로 직접 확인
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
  - 사이트 변경: site/ 파일을 zip으로 묶어 song-meal-pages_YYYYMMDD_rev[n].zip으로 전달 (마지막: 20261116_rev1)
  - 서버 변경: song-meal-api.js(또는 naver-search.js) 전체를 그 Worker 편집기에 붙여 넣고 Deploy
  - DB 변경: 주석 없는 SQL을 D1 Console에 붙여 넣기 (주석이 있으면 "No SQL statements detected")
- 회원·후기 데이터는 D1 안에 있어서 이 zip에는 없음 (백업은 D1 → Export)
