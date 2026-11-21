# Moim_O — 모임 시간표

## 현재 상태
- 정적 웹화면: `/moim-o/index.html` (GitHub Pages 배포 시 해당 주소로 접속)
- 서버: `/moim-o/server/src/index.js` (Cloudflare Workers + SQLite Durable Objects)
- 서버 연결 설정: `/moim-o/config.js` **아직 Cloudflare Worker 주소 미설정**
- 기존 `team-schedule` 프로그램은 그대로 유지함.

## 최초 1회 배포

1. [Cloudflare Dashboard](https://dash.cloudflare.com/) → **Workers & Pages** → **Create** → **Import a repository** 또는 **Connect to Git**.
2. GitHub 저장소 `PassionWoo/team-schedule` 연결.
3. **Root directory: `moim-o/server`**, Worker name: `moim-o-api`.
4. Build command는 필요 없음. Deploy command는 `npx wrangler deploy`를 사용. 설정 파일 `moim-o/server/wrangler.toml`에 Durable Object 클래스와 마이그레이션이 정의되어 있음.
5. 성공 시 생성되는 `https://moim-o-api.<계정>.workers.dev` 형태의 **Worker URL** 복사.
6. GitHub 저장소 `moim-o/config.js`의 `window.MOIMO_API_URL`에 Worker URL을 적고 저장 (끝에 / 없이). 공개 설정값만 넣고 비밀번호나 API 토큰은 넣지 않기.
7. GitHub Pages가 main/root를 배포하도록 설정되어 있으면 `https://passionwoo.github.io/team-schedule/moim-o/`에서 접속.

Cloudflare Git 연결 UI는 계정 상태와 시기에 따라 항목명이 다를 수 있습니다. 저장소 연결이 불편한 경우 로컬 터미널에서 `cd moim-o/server && npx wrangler login && npx wrangler deploy`로 최초 배포할 수도 있습니다.

## 기능
- 이름 입력칸 기본 4개, 더하기/삭제 (1~30명)
- 달력에서 시작일 → 종료일 선택 (연속 최대 31일)
- 시간 단위 직접 입력 (5~720분, 하루 96칸 이내)
- 온라인·오프라인 모두 가능 = 초록색, 온라인만 가능 = 노란색
- 칸을 연속해서 칠하고 손을 놓을 때 변경 사항 일괄 저장
- 모든 참가자의 시간을 가나다순으로 열람
- 종합 대시보드는 각 이름 앞 두 글자로 표현
- WebSocket으로 실시간 상태 동기화, 연결 종료 시 자동 재접속
- 팀장 링크, 참석자별 수정 링크, 대시보드 전용 보기 링크
- 관리자가 참석자 링크나 보기 링크를 재발급 가능

## 유의사항
- **모임별 개인 링크는 비밀번호 역할을 합니다.** 해당 링크를 가진 누구나 그 사람의 시간을 수정할 수 있습니다. 공개 게시판에 개인 링크를 올리지 마세요.
- **관리자 링크는 특히 중요합니다.** 해당 링크를 분실하면 팀원 링크를 다시 발급하기 어렵습니다. 안전하게 보관하세요.
- 인증값은 생성 시 난수로 만들고, 서버에는 SHA-256 해시만 저장합니다. 주소의 `#` 뒤에 넣는 이유는 HTTP 요청 및 일반 서버 접근 로그에 토큰이 포함되는 것을 줄이기 위함입니다.
- 링크로 받은 사람만 수정할 수 있게 하되, 동일한 링크를 서로 공유할 경우 신원 자체는 확인할 수 없습니다.
- 저장소 화면의 서버 코드는 암호나 개인별 토큰을 포함하지 않습니다.
- 사용자가 모든 모임을 영구 보유하도록 설계된 백업 서비스는 아닙니다. 공개 운영 전 보존 및 삭제 정책을 결정하세요.
- 한 팀의 참가자가 동시에 같은 링크로 수정하면 마지막으로 저장된 동일 슬롯의 값이 적용될 수 있습니다.
- **무료 플랜의 요청량·저장 용량 한도가 적용됩니다.** 초기 구동/실사용 테스트가 필요합니다.

## 시험 확인
1. 새 모임 생성 → 참가자 2명 이상 추가
2. 서로 다른 브라우저로 참가자 링크 두 개 열기
3. A가 초록색 칠하고 대시보드에 반영되는지 확인
4. B가 노란색 칠하고 A의 화면에 반영되는지 확인
5. A 링크로 B의 시간표가 수정 불가능한지 확인
6. 새로고침 후 저장된 색이 유지되는지 확인
7. 읽기 전용 링크에서 수정이 불가능한지 확인

아직 Cloudflare 서버 배포/실제 다중 클라이언트 통합 테스트는 완료되지 않았습니다.
