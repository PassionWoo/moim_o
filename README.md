# 모임 시간표 (GitHub Pages + Firebase)

6명 개인 시간표와 종합 대시보드. 입력은 **초록(온·오프라인)** / **노랑(온라인만)** / **지우기** 3개 버튼으로 합니다. 화면을 손가락으로 누른 채 칠할 수 있습니다. 큰 글씨와 모바일 1일 보기 지원.

## 구성

- `index.html`, `style.css`, `app.js`, `firebase-config.js`: GitHub Pages에서 실행
- `firestore.rules`: Firebase 콘솔 **Firestore Database > 규칙**에 붙여넣기
- 개인 이름 탭 6개 + 종합 대시보드, 11월 20–25일, 하루 3시간 단위(06:00–24:00)
- 개인 탭은 본인만 수정 가능; 나머지는 열람만 가능 (화면뿐 아니라 Firestore 규칙으로 제한)
- 데이터는 기기 캐시가 아닌 **Firebase Cloud Firestore**에 공통 저장·실시간 동기화

## 1. Firebase 생성 (관리자 한 번만)

1. https://console.firebase.google.com 에서 프로젝트를 만듭니다.
2. **Authentication > Sign-in method**에서 **이메일/비밀번호** 방식을 활성화합니다.
3. **Authentication > Users > Add user**에서 아래 여섯 계정을 만듭니다. 각 계정의 비밀번호는 `GATHER-` + **해당 인물의 번호 끝 4자리** + `-2026!` 형식으로 입력합니다. 예: 뒷번호 `1234`라면 `GATHER-1234-2026!`. 실제 번호를 GitHub에 올리거나 코드에 기록하지 마세요.

   | 이름 | Firebase에 등록할 이메일 |
   | --- | --- |
   | 김덕중 | `member01@team-plan.example.com` |
   | 김원일 | `member02@team-plan.example.com` |
   | 김정님 | `member03@team-plan.example.com` |
   | 우성민 | `member04@team-plan.example.com` |
   | 이은정 | `member05@team-plan.example.com` |
   | 천윤호 | `member06@team-plan.example.com` |

   위 주소는 로그인용으로만 쓰는 가상의 이메일입니다. 실제 메일 수신/비밀번호 재설정에는 사용하면 안 됩니다. 비밀번호는 관리자가 Firebase 콘솔에서 수정할 수 있습니다.
4. **Firestore Database > Create database**에서 Firestore DB를 만듭니다. 운영용(Production)으로 시작한 뒤 **Rules(규칙)** 에 `firestore.rules` 전체를 붙여넣고 **게시**합니다.
5. **프로젝트 설정 > 내 앱 > 웹(</>)** 에서 웹 앱을 추가하고 제공된 Firebase 구성 정보(`apiKey`, `authDomain`, `projectId`, `appId`)를 `firebase-config.js`에 채웁니다.
6. **Authentication > Settings > Authorized domains**에서 사용할 `사용자이름.github.io` 도메인을 허용합니다. 일부 프로젝트에서는 기본 허용되어 있지 않으므로 직접 추가해야 합니다.

## 2. GitHub Pages 배포

1. GitHub 저장소를 만들고 이 폴더의 파일들을 업로드합니다. (`README.md`, `firestore.rules`는 배포 페이지 실행에는 필요 없지만 설명용으로 함께 두어도 됩니다.)
2. 저장소 **Settings > Pages > Build and deployment > Deploy from a branch** 를 선택하고 `main` / `(root)` 를 지정합니다.
3. `https://사용자이름.github.io/저장소이름/` 주소를 팀 카카오톡으로 공유합니다.

참여자는 링크 접속 → 이름 선택 → 번호 끝 4자리 입력 → 자기 이름 탭에서 색 선택 후 칠하기. 수정 내용은 자동 저장되며 **종합 대시보드에 바로 반영**됩니다.

## 중요

- **GitHub Pages만으로는 공동 데이터 저장과 로그인 권한 관리가 안 됩니다.** Firebase 프로젝트 연결이 반드시 필요합니다. 파일을 GitHub에 올리는 것만으로 서비스가 완성되지는 않습니다.
- `firebase-config.js` 안의 Firebase 웹 설정값은 공개되더라도 괜찮습니다. 그러나 **Firebase 관리자 서비스 계정 키/개인 번호 4자리 목록을 GitHub에 절대 업로드하지 마세요.**
- 번호 끝 **4자리 인증은 강한 보안 수단이 아닙니다.** 누구든 4자리를 알아내거나 추측하면 그 사람의 일정을 수정할 수 있습니다. 민감한 정보를 입력하지 않는 소규모 일정 조율용입니다. 대외 공개를 크게 할 경우 계정 기반 인증을 권장합니다.
- 셀의 빈칸은 체크되지 않은 상태입니다. 실제 불가와 미응답은 구분되지 않습니다.
- 네트워크 연결이 끊어지면 저장이 완료되지 않을 수 있습니다. 화면 상단 **'저장됨 ✓'** 을 확인해 주세요.
- 2026년 11월 20–25일의 고정 모임을 위한 버전입니다.