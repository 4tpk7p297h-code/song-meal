# 🍽️ 음식점 (song-meal)

노래 분위기 → 곡 분석 → 오늘의 메뉴 + 주변 식당을 사이트 안 지도에 보여 주는 웹앱 (HTML5, `index.html` 한 파일).

사이트: https://4tpk7p297h-code.github.io/song-meal/

## 기능
- 서비스 이용 동의: [필수] 만 14세 이상, [필수] 개인정보 수집·이용, [선택] 국외 이전(Apple·Deezer·Cloudflare), [선택] 위치정보. 선택 미동의 시 해당 기능만 꺼짐. 처리방침은 `privacy.html` (운영자 이름·연락처 채워야 함)
- **곡 분석**: Apple 음악 검색(키 필요 없음)으로 가수·곡명·장르·발매 연도·앨범 아트·미리듣기를 가져오고,
  미리듣기 30초를 브라우저에서 분석해 BPM과 소리 크기 흐름을 보여 줍니다. 분석이 안 되면 장르·에너지로 BPM 범위를 추정합니다.
  시놉시스와 인트로·벌스·후렴 해설은 곡 장르로 에너지·분위기를 추정해 만든 해설입니다. 곡 분위기 입력칸은 없습니다.
- **음식 조건 직접 입력**: "매운 음식 제외, 해산물 빼고, 국물 좋아요"처럼 쉼표로 입력.
  "제외·빼고·싫어·말고·없이"가 붙으면 빼고, 그 밖의 말은 먼저 추천합니다.
  인식하는 특징: 매운, 고기, 해산물, 면, 밀가루, 국물, 튀김, 술, 단것, 채소 (그 밖의 말은 메뉴 이름으로 찾음).
- **사이트 안 지도**: 결과 화면에 입력 위치 지도, 추천 키워드를 누르면 주변 식당을 같은 지도에 마커와 목록으로 표시.
- **현재 위치** 버튼, 위치 권한 거부 시 브라우저별 해결 안내.

메뉴 데이터는 `index.html`의 `TYPES`, `WEATHER`, `TAGS`에서 고칠 수 있습니다.

## 네이버 지도 (NCP Maps)
`index.html` 상단 스크립트에 Client ID가 연결돼 있습니다 (Dynamic Map, Geocoding, Reverse Geocoding).
NCP 콘솔의 Web 서비스 URL에 `https://4tpk7p297h-code.github.io`가 등록돼 있어야 합니다.

## 식당 검색 연결
지도에 실제 식당을 찍으려면 **NAVER API HUB 검색 API(지역)** 가 필요합니다. 이 API는 Client Secret이 필요해서
`worker/naver-search.js`를 Cloudflare Workers(무료)에 올려 Secret을 숨깁니다.

1. [NCP 콘솔](https://console.ncloud.com)의 **NAVER API HUB**에서 애플리케이션 생성 → **검색** API 선택 → Client ID / Secret 발급
   (네이버 개발자센터의 검색 API는 2026-07-31에 신규 신청이 종료됨. 지도용 Maps 키와는 다른 키입니다)
2. https://dash.cloudflare.com → Workers & Pages → Create → Worker 만들기 → `worker/naver-search.js` 내용 붙여 넣고 Deploy
3. Worker → Settings → Variables and Secrets에 `NAVER_CLIENT_ID`, `NAVER_CLIENT_SECRET`(Secret 타입) 추가
4. Worker 주소(예: `https://naver-search.이름.workers.dev`)를 `index.html`의 `const SEARCH_PROXY = "";`에 넣기

Secret은 이 저장소에 절대 넣지 마세요.

## 배포
GitHub 저장소 Settings → Pages → Source: `Deploy from a branch`, Branch: `main` / `(root)`.
