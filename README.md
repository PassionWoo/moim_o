# 모이모 (Moim_O) — 우리 지금 만나!

여러 사람의 참석 가능 시간을 한눈에 조율하는 웹앱입니다.

## 서비스 구성
- 웹 프론트엔드: GitHub Pages (HTML, CSS, JavaScript)
- API, 팀장 인증, 모임별 데이터 저장·실시간 동기화: Cloudflare Workers + SQLite Durable Objects
- Firebase 사용 없음
- GitHub Pages: https://passionwoo.github.io/moim_o/
- Cloudflare API: https://moim-o-api.w862589.workers.dev

## 사용 방식
1. 팀장이 아이디와 비밀번호로 가입 또는 로그인합니다.
2. 팀장이 모임을 만들면서 참가자별 이름과 전화번호 끝 4자리를 등록합니다.
3. '모임 링크 복사하기' 버튼으로 공통 주소를 팀원들에게 한 번만 공유합니다.
4. 팀원은 해당 링크에서 자기 이름을 선택하고 4자리 번호를 입력해 본인의 시간표만 수정합니다.
5. 팀장은 '내 모임' 목록에서 여러 모임을 확인하고 어느 기기에서나 같은 계정으로 접근할 수 있습니다.
6. 팀장은 모임을 직접 삭제할 수 있습니다.

## 데이터 보관 정책
- **새로 생성된 모임**은 생성 시각으로부터 정확히 60일 후 Cloudflare Durable Object Alarm으로 자동 정리되도록 예약합니다.
- 만료 시 모임 내 시간표 및 참가자 인증 세션을 삭제하고, 계정의 '내 모임' 목록에서도 제거합니다.
- SQLite 기반 Durable Object의 `storage.deleteAll()`로 모임 저장소를 비워 더 이상 이용할 수 없게 합니다.
- 이전 버전에서 생성된 모임은 생성 시각이 기록되지 않았으므로, 새 코드에서 최초 접근한 날부터 60일 보관을 시작합니다.
- 팀장 계정 자체는 모임과 별도로 보관되며, 비밀번호 복구 기능은 아직 제공하지 않습니다.

## 배포 구조
- `server/src/index.js`: Cloudflare Worker + Durable Object API, 자체 계정 인증, 60일 만료 예약
- `server/wrangler.toml`: Cloudflare 배포 설정
- `auth.js`: 팀장 Cloudflare 계정 로그인 및 세션 복원
- `app.js`: 모임 생성·달력·대시보드·팀원 로그인
- `index.html`, `style.css`: 화면
- `config.js`: Workers 서버 주소

Cloudflare 연동 저장소는 `PassionWoo/moim_o`이며, Workers 빌드 루트는 `/server`, 배포 명령은 `npx wrangler deploy`입니다.

## 참고
- 4자리 번호는 사용 편의를 위한 간단한 인증 방법으로, 강한 보안을 제공하지 않습니다. 로그인 시도 횟수를 제한하고 서버에서 참가자별 수정 권한을 확인합니다.
- 자동 배포 및 코드 문법 검사와 별개로 실제 로그인, 모임 생성, 공유 링크 입장, 실시간 저장, 만료·삭제 동작의 종단 간 검증이 필요합니다.
