# Moim_O — 모임 시간표

기존 Team Schedule 고정형 프로그램을 Moim_O로 전환했습니다.

## 파일
- `index.html`, `app.js`, `style.css`: 모임 생성·달력·시간표·대시보드
- `config.js`: 서버 주소 (현재 미설정)
- `server/src/index.js`: Cloudflare Worker + Durable Object API
- `server/wrangler.toml`: Cloudflare 배포 설정

## 서버 연결
1. Cloudflare Workers & Pages에서 GitHub 저장소 `PassionWoo/team-schedule`을 연결합니다.
2. Worker의 루트 경로를 `server`로 지정하고 `npx wrangler deploy`를 실행합니다.
3. 배포된 `https://...workers.dev` 주소를 최상위 `config.js`의 `window.MOIMO_API_URL`에 입력합니다.
4. GitHub Pages는 `main` 브랜치의 `/(root)`를 배포합니다.

GitHub Pages 주소: https://passionwoo.github.io/team-schedule/

서버가 배포되고 주소가 연결되기 전에는 모임 생성 및 공동 저장 기능이 작동하지 않습니다.

참가자 개인 링크는 수정 권한을 부여하는 비밀 링크입니다. 유출 시 해당 참가자의 시간표를 다른 사람이 수정할 수 있으므로 개인적으로 전달해야 합니다.

실제 서버 배포 및 종단 간 실사용 테스트는 아직 완료되지 않았습니다.
