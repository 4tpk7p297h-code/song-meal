# 🍽️ 음식점 (song-meal)

노래 분위기 → 오늘의 메뉴 + 네이버 지도 검색 키워드 추천 웹앱 (HTML5, 단일 파일 `index.html`).

## 사용법
1. 개인정보 수집·이용 동의 (미동의 시 이용 불가)
2. 노래, 곡 에너지·분위기, 인원, 날씨, 위치, 식사 시간, 음식 종류, 매운 음식 제외 여부 입력
3. 추천받기 → 추천 음식별 📍 버튼을 누르면 네이버 지도 검색으로 이동

## 추천 방식
외부 AI API 없이 브라우저 안에서 규칙으로 추천합니다.
곡 에너지 × 분위기로 유형 A~F를 정하고, 날씨(비·더움·추움·눈) 메뉴를 하나 먼저 넣은 뒤, 음식 종류와 매운 음식 제외 조건으로 3개를 고릅니다.
메뉴 목록은 `index.html`의 `TYPES`, `WEATHER`에서 고칠 수 있습니다.

## 네이버 지도 API
NCP Maps Client ID를 `index.html` 상단 스크립트에 연결했습니다 (Dynamic Map, Geocoding, Reverse Geocoding 사용).
- 결과 화면: 입력한 위치를 Geocoding으로 찾아 지도와 마커 표시
- 입력 화면: "📍 현재 위치" 버튼으로 현재 위치의 구·동 이름 자동 입력
- NCP 콘솔의 Web 서비스 URL에 `https://4tpk7p297h-code.github.io`가 등록돼 있어야 합니다.
- Client Secret은 이 저장소에 절대 넣지 마세요.

## 배포
GitHub 저장소 Settings → Pages → Source: `Deploy from a branch`, Branch: `main` / `(root)`.
