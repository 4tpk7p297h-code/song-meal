# 음식점 (song-meal) 인수인계 문서

> 새 Claude에게: 이 문서와 함께 받은 사이트 파일(index.html 등)을 읽고 이어서 작업해 주세요.
> 사용자에게는 한국어로 답해 주세요. 마지막 갱신: 2026-11-09

## 1. 프로젝트 한 줄 요약
좋아하는 노래를 입력하면 곡 분위기(장르로 추정)에 맞는 오늘의 메뉴 3개와 주변 식당을 네이버 지도로 보여 주는 웹사이트.
원래 C 언어 콘솔 프로그램 "뮤직푸드"를 HTML5로 옮긴 것. **12월 중순 과제 발표용**이라 그때까지 끊김 없이 유지돼야 하고, 어디서든 접속돼야 함.

## 2. 현재 배포 상태
| 항목 | 값 |
|---|---|
| 사이트 주소 | https://4tpk7p297h-code.github.io/song-meal/ (GitHub Pages, main 브랜치 / root) |
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
- **곡 정보**: iTunes Search/Lookup + Deezer API (JSONP, 키 없음). 앨범 이미지와 30초 미리듣기, 미리듣기 BPM 분석(Web Audio)에 사용
- Anthropic API는 사용자 요청으로 제거함 (다시 넣지 말 것)

## 5. 기능 요약 (현재 동작)
1. **동의 화면**: [필수] 만 14세 이상, 개인정보 수집·이용 / [선택] 국외 이전(Apple, Deezer, Cloudflare. 미동의 시 곡 검색과 식당 검색 끔), 위치정보(미동의 시 '현재 위치' 버튼 숨김). 동의는 저장하지 않음
2. **입력**: 노래(필수, '가수 - 곡명'), 식사 시간, 인원, 날씨(다중 선택 칩), 위치(직접 입력, 현재 위치, 지도에서 직접 고르기), 음식 종류(다중 선택), 음식 조건(자유 입력: "매운 음식 제외", "국물 좋아요" 등. parseCond, TAGS/SYN)
3. **추천 로직** (브라우저 안 규칙 기반):
   - 장르로 에너지(energyFromGenre)와 분위기(valenceFromGenre)를 각 1~3으로 추정
   - pickType으로 유형 A~F를 정하고, TYPES/WEATHER 메뉴 풀에서 3개를 고름
   - "국물" 같은 우선 조건은 3개 메뉴 모두에 적용함. 모자라면 안내 문구를 띄움
   - "다른 메뉴 추천"을 누르면 이미 나온 메뉴 그룹(GROUP)을 빼고 다시 고름
4. **결과**: 곡 분석(시놉시스, 인트로·벌스·후렴 해설, BPM, 미리듣기), 메뉴 3개, 사이트 안 네이버 지도(식당 마커, 3km 안만 '근처'로 판정). 길찾기: 모바일은 nmap:// 앱, PC는 map.naver.com 레거시 URL(PC 쪽은 동작 미확인)
5. **기타**: 라이트/다크/시스템 테마(localStorage "food.theme"), 로고를 누르면 동의 화면으로, 뒤로가기는 화면 단위로 이동(history.pushState), 로딩 중에는 블러 배경 위 가운데에 캐릭터 표시, 귀여운 디자인(Jua 폰트, 코랄 #ff7a59)
6. **공식 캐릭터**: 보라색 헤드폰을 쓰고 새싹이 달린 흰 고양이(사용자 제공 이미지). 파비콘, 헤더 로고, 동의 화면 인사, 로딩, og.png에 사용

## 6. 사용자가 요청했던 것 (시간 순, 모두 완료)
C 코드를 HTML5로 변환해 배포 → Anthropic API 제거, 이름 "음식점" → 네이버 지도 연동 → 음식 조건 자유 입력, 곡 분석(시놉시스/벌스/BPM) → 식당을 새 탭이 아닌 사이트 안 지도에 표시 → 유형 칩 제거, 위치 권한 대안(지도에서 고르기) → 곡 검색 정확도(아이유 밤편지 버그) → 추천 다양화와 중복 제거, 근처 식당이 없을 때 안내, 한 화면 레이아웃 → 한국 법령에 맞는 동의 화면과 처리방침 → 로고로 처음 화면, 곡 에너지 입력 삭제, 날씨·음식 종류 다중 선택, 네이버 길찾기, 테마 선택 → 공유 이름 통일, 국물 조건 로직, 귀여운 디자인 → 곡 분위기 입력 삭제, 캐릭터와 파비콘 → 뒤로가기, 노래 필수, 로딩 오버레이

## 7. 다음 단계 (논의 중, 사용자 승인 대기)
사용자 구상: **노래와 식당 후기를 인스타 스토리처럼 올리고, 다른 사람이 좋아요를 누르고, 음식 코너별(예: 일식/우동, 양식/파스타)로 좋아요 순위를 보여 주기.**

제안한 방식 (무료, 안정성 우선):
- 호스팅: **Cloudflare Pages** (GitHub 없이 직접 업로드). GitHub Pages는 예비 주소로 계속 유지
- 데이터: **Cloudflare Workers + D1** (회원, 후기, 좋아요). 사진은 브라우저에서 줄여서 D1에 저장해 R2(카드 등록 필요)를 피함
  - Supabase는 무료 플랜이 7일 동안 안 쓰면 멈춰서 발표 날 위험하므로 제외
- 가입: **아이디 + 비밀번호 + 닉네임만** (이메일과 소셜 로그인 없음). 비밀번호는 서버에서 해시해서 저장. 좋아요는 계정당 1회
- 필요한 것: 처리방침과 동의 화면 개정(계정, 게시물, 사진 저장, 탈퇴할 때까지 보관), 게시물 신고·삭제 기능, 운영자 이름과 연락처
- 안전장치: 코드와 데이터를 정기적으로 백업, 12월 초에 시연 화면을 녹화해 두기

## 8. 작업할 때 주의
- 비밀값(Client Secret, API 키)은 저장소나 채팅에 절대 넣지 말 것. Cloudflare Secret에만 저장
- 주소를 옮기면 바꿀 곳: NCP 지도 Web 서비스 URL, Worker 허용 Origin, index.html의 og:url과 og:image
- 사용자는 비개발자라서 단계별 체크리스트와 스크린샷 기준 안내를 선호함
