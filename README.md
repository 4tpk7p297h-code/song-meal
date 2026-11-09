# 🎧 뮤직푸드 (song-meal)

노래 → 곡 분위기 분석 → 음식 + 네이버 지도 검색 키워드 추천 웹앱 (HTML5, 단일 파일 `index.html`).

## 사용법
1. 개인정보 수집·이용 동의 (미동의 시 이용 불가)
2. 노래, 인원, 날씨, 위치, 식사 시간, 음식 종류, 음식 조건 입력
3. 본인 Anthropic API 키 입력 → 추천받기
4. 추천 음식별 📍 버튼을 누르면 네이버 지도 검색으로 이동

## API 키 처리 방식
정적 사이트(GitHub Pages)에 키를 넣으면 누구나 볼 수 있으므로 저장소에는 키가 없습니다.
사용자가 자기 키를 입력하면 브라우저에서 `api.anthropic.com`으로 직접 호출하고,
"기억하기"를 체크한 경우에만 그 브라우저의 localStorage에 저장됩니다.

## 배포
GitHub 저장소 Settings → Pages → Source: `Deploy from a branch`, Branch: `main` / `(root)`.
