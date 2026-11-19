# UI Review Agent

URL이나 이미지에서 UI의 정보 계층, 가독성, 접근성을 검토하는 셀프호스팅 도구입니다. 소개와 설치는 [README.md](README.md)를 먼저 읽으세요. 이 파일에는 코드를 바꿀 때 알아야 하는 것만 적습니다.

## 명령어

- `pnpm install --frozen-lockfile`: 의존성 설치. pnpm이 없으면 `corepack enable`
- `pnpm exec playwright install chromium`: 브라우저 설치. Linux에서 실행 오류가 나면 `--with-deps`를 붙임
- `pnpm run typecheck`: 엔진(`src/`, `tests/`) 타입 검사
- `pnpm run viewer:typecheck`: 대시보드(`viewer/`) 타입 검사
- `pnpm test`: 전체 테스트. 약 3분 걸리므로 하나만 돌릴 때는 `pnpm exec tsx --test tests/<파일>.test.ts`
- `pnpm run dev viewer --host 127.0.0.1`: 화면 변경이 자동 반영되는 개발 서버 (기본 포트 4317)
- `pnpm run viewer --host 127.0.0.1`: 빌드 후 실행
- `pnpm run inspect --url <주소> --evaluator rules-only`: AI 없이 CLI로 URL 검사

## 환경

- Node.js 22.12 이상, pnpm 11.10.0 (`package.json`의 `packageManager`)
- `--host`를 생략하면 `0.0.0.0`으로 열립니다. 대시보드에는 로그인이 없으므로 개발 중에는 `127.0.0.1`을 쓰세요.
- 리뷰 결과와 설정은 기본값으로 `runs/`에 저장되며 git에서 제외됩니다. 이 폴더의 내용을 커밋하지 마세요.

## 구조

- `src/`: URL·이미지 리뷰 엔진, 작업 큐, CLI, 외부 요청 MCP
- `viewer/server/`: 대시보드와 리뷰 API를 제공하는 HTTP 서버
- `viewer/app/`, `viewer/features/`: 대시보드 화면. 공용 컴포넌트는 `viewer/shared/`
- `skills/ui-review/`: Codex 스킬 (선택 기능)
- `tests/`: 엔진·서비스·뷰어 테스트
- 구조 설명과 엔진 흐름은 [docs/](docs/)와 [docs/diagrams/README.md](docs/diagrams/README.md)

## 코드 작성 규칙

- 불리언 변수·필드·매개변수는 접두사를 붙입니다: `is`, `has`, `can`, `should`, `needs`. `loading`, `valid`, `ready` 같은 접두사 없는 이름은 쓰지 않습니다.
- UI를 만들 때는 `viewer/shared/`에서 역할이 맞는 공용 컴포넌트를 먼저 찾아 쓰고, 화면마다 CSS를 새로 덮어쓰지 않습니다.
- 변경을 마치면 `pnpm run typecheck`, `pnpm run viewer:typecheck`, `pnpm test`가 모두 통과해야 합니다. 화면을 바꿨다면 개발 서버를 띄워 브라우저로 직접 확인합니다.

## 공개 저장소 안전 규칙

이 저장소는 공개되어 있고 이력은 되돌릴 수 없습니다. 아래를 지키세요.

- API 키, 토큰, 비밀번호, 쿠키, `.env`, `auth.json`을 커밋하지 마세요.
- 개인 호스트명, 홈 경로, 이메일, 내부 주소를 코드·문서·테스트·커밋 메시지에 쓰지 마세요.
- 실제 회사·서비스 이름, 실제 화면 캡처, 실제 검토 결과를 예시나 테스트 데이터로 쓰지 마세요. 가상 값(`example.com`, `Example Shop`)을 씁니다.
- 로그인 정보가 필요한 테스트는 `fixture-` 같은 명백한 가짜 값을 씁니다.

## 커밋과 PR

- 커밋 메시지는 Conventional Commits 형식입니다: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `ci`, `build`, `perf`, `revert` 중 하나와 짧은 소문자 scope. 예: `fix(viewer): 설정 저장 후 평가자 선택 유지`
- 사용자에게 보이는 동작이 바뀌면 `feat`, 버그와 회귀 수정은 `fix`, 동작 변화 없는 구조 정리는 `refactor`를 씁니다.
- 한 커밋에는 하나의 변경만 담고, 커밋 전에 스테이징한 diff를 확인합니다.
