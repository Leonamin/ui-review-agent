# 셀프호스팅과 Codex 연결

Codex 연결은 선택 사항입니다. 대시보드만 쓴다면 아래 "서버 설치"와 "대시보드 열기와 평가자 설정"까지만 진행하면 되고, Codex를 쓰지 않는다면 "다른 컴퓨터의 Codex 연결" 이후는 건너뛰어도 됩니다.

리뷰 서버는 URL을 열고 평가를 실행하며, 캡처와 보고서를 저장합니다. Codex 스킬은 설치된 요청 MCP로 작업을 접수합니다. 두 컴퓨터에서 사용하는 경우, MCP는 SSH 포트 포워딩으로 서버에 연결하고 Codex 컴퓨터에 있는 이미지를 읽어 서버에 업로드합니다.

## 서버 설치

서버에 Node.js 22.12 이상과 pnpm 11.10.0을 설치하고, 공개 저장소에서 받은 소스 디렉터리에서 실행합니다. Linux에서 Chromium 시스템 라이브러리가 빠져 있다면 `pnpm exec playwright install --with-deps chromium`을 사용하고, 브라우저는 서비스 실행 계정에서 사용할 수 있도록 설치하세요.

```sh
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
pnpm run viewer --host 127.0.0.1 --port 4317
```

서버에서 `curl -fsS http://127.0.0.1:4317/api/review-service`를 실행해 응답의 `status`가 `ready`인지 확인합니다. 위 실행은 포그라운드에서 동작합니다. 계속 운영하려면 계정에 맞는 서비스 관리자로 같은 앱을 실행하고 작업 디렉터리를 소스 디렉터리로 지정하세요. 뷰어를 미리 빌드하면 시작할 때 다시 빌드할 필요가 없습니다.

```sh
pnpm run viewer:build
pnpm exec tsx viewer/server/main.ts --host 127.0.0.1 --port 4317
```

기본 저장 위치는 소스 디렉터리의 `runs/`입니다. 별도 볼륨이나 데이터 디렉터리를 쓰려면 `--runs /absolute/path/to/review-data`를 추가합니다. 서비스 계정에는 해당 위치의 쓰기 권한이 필요합니다. 업데이트할 때 기존 디렉터리를 다시 지정하면 보고서, 작업, 설정을 이어서 사용할 수 있습니다.

대시보드에는 별도 로그인이 없으므로 위 명령처럼 루프백에 바인딩하고, 접속을 허용할 사용자만 SSH 키를 등록하세요.

## 대시보드 열기와 평가자 설정

서버와 브라우저가 같은 컴퓨터에 있으면 [http://127.0.0.1:4317](http://127.0.0.1:4317)을 엽니다. 다른 컴퓨터에서는 `review-server`를 본인의 SSH 설정 별칭이나 `사용자@호스트`로 바꾸고, 다음 명령을 별도 터미널에서 유지합니다.

```sh
ssh -N -o ExitOnForwardFailure=yes \
  -L 127.0.0.1:4317:127.0.0.1:4317 review-server
```

브라우저에서 같은 주소를 엽니다. SSH 서버가 TCP 포워딩을 허용해야 하고, 클라이언트의 포트 4317이 비어 있어야 합니다. 이 브라우저 포워딩은 Codex MCP의 자동 포워딩과 별도로 동작합니다.

대시보드의 **설정**에서 다음 중 사용할 평가자를 설정합니다.

- **Codex CLI, Claude Code CLI, Antigravity CLI** 중 사용할 도구를 서비스 실행 계정에 설치하고 로그인합니다. 백그라운드 서비스에서도 실행 파일을 찾을 수 있도록 `PATH`를 설정합니다.
- **OpenAI 호환 API**를 쓰려면 이미지 입력을 지원하는 모델과 API 주소, 키를 지정합니다. 키는 서버의 `<runs>/.review-service/settings.json`에 파일 권한 `0600`의 평문으로 저장됩니다. `--runs`로 지정한 전체 데이터 디렉터리에는 제출한 이미지와 캡처도 저장됩니다. 해당 디렉터리의 백업과 접근 권한을 관리하세요.

### 평가자 이미지 크기 제한

리뷰는 캡처를 원본 해상도로 전달합니다. 특정 모델과 API 주소에서 지원하는 최대 이미지 너비나 높이를 확인했다면 서버 프로세스의 `UI_REVIEW_PROVIDER_IMAGE_LIMITS` 환경 변수에 제한을 등록할 수 있습니다.

```sh
export UI_REVIEW_PROVIDER_IMAGE_LIMITS='[{"evaluator":"openai-compatible","baseUrl":"https://example.com/v1","model":"example-vision","maxWidthPx":1024,"maxHeightPx":1024}]'
```

`evaluator`는 `codex`, `claude`, `antigravity`, `openai-compatible` 중 하나이며, `model`은 평가에 쓰는 정확한 모델 이름입니다. OpenAI 호환 API에는 대시보드에 저장된 정확한 기본 주소를 지정하며 마지막 슬래시를 생략합니다. CLI 평가자에는 `baseUrl`을 생략합니다. 확인한 너비 `maxWidthPx`, 높이 `maxHeightPx`, 픽셀 수 `maxPixels`를 지정할 수 있습니다. 이 제한을 넘으면 원본 픽셀 단위로 겹치게 나누며, 각 조각은 원본 캡처의 근거 ID와 연결됩니다.

평가자 전송에는 한 호출당 이미지 최대 32개, 전체 20 MiB의 앱 제한이 적용됩니다. 이미지 한 장의 기본 한도는 5 MiB이며, 엔드포인트에서 확인한 값에 맞춰 같은 설정의 `maxImageBytes`로 변경할 수 있습니다. 이미지 한 장의 한도는 전체 20 MiB를 넘을 수 없습니다. 바이트 제한에 닿으면 무손실 재압축을 시도합니다. 이미지 한 장이 여전히 한도를 넘으면 해상도를 유지하면서 추가로 나눕니다. 전체 근거를 전송할 수 없는 경우 검토에서 그 한계를 기록합니다.

## 다른 컴퓨터의 Codex 연결

Codex가 설치된 컴퓨터에 Node.js 22.12 이상, pnpm 11.10.0, OpenSSH가 필요합니다. 먼저 일반 SSH 접속으로 서버 호스트 키를 확인합니다. 아래 명령에서 `review-server`를 자신의 서버로 바꿉니다.

```sh
ssh -o BatchMode=yes review-server true
```

그 컴퓨터에도 서버와 같은 버전의 소스를 받고, 소스 디렉터리에서 실행합니다.

```sh
pnpm install --frozen-lockfile
pnpm run build
pnpm run remote:install --ssh-host review-server \
  --dashboard-url http://127.0.0.1:4317
```

설치기가 Codex의 `ui-review` 스킬과 MCP 설정을 등록합니다. 설치된 소스 디렉터리와 Node 실행 파일은 계속 같은 위치에 두세요. 설치기는 기존 UI Review 스킬이나 설정이 있으면 중단합니다. 그 경우 기존 설정에서 SSH 대상과 설치 경로를 확인한 뒤 갱신하세요. 별도 Codex 설정 디렉터리를 사용하는 경우에는 설치기에 `--codex-home /absolute/path/to/codex`를 추가할 수 있습니다.

MCP는 Codex가 시작할 때 빈 로컬 포트를 선택하고, 서버의 `127.0.0.1:4317`로 연결합니다. Codex가 종료되면 MCP의 포워딩도 닫힙니다. 브라우저에서 결과를 보려면 위의 브라우저 SSH 포워딩을 유지하세요.

### 같은 컴퓨터의 Codex 연결

서버와 Codex를 같은 컴퓨터에서 실행할 때는 소스 디렉터리에서 아래와 같이 스킬을 설치하고 로컬 MCP를 등록합니다. 기존 `ui-review` MCP를 쓰고 있다면 먼저 `codex mcp get ui-review`로 현재 설정을 확인하세요.

```sh
pnpm run build
pnpm run skill:install --target "${CODEX_HOME:-$HOME/.codex}/skills"
codex mcp add ui-review -- "$(command -v node)" \
  "$PWD/dist/request-mcp-cli.js" --service http://127.0.0.1:4317
```

### 같은 컴퓨터의 Claude Code 연결

서버와 Claude Code가 같은 컴퓨터에 있으면 같은 MCP를 Claude Code에도 등록할 수 있습니다. 소스 디렉터리에서 실행합니다.

```sh
pnpm run build
claude mcp add ui-review -- "$(command -v node)" \
  "$PWD/dist/request-mcp-cli.js" --service http://127.0.0.1:4317
pnpm run skill:install --target "$HOME/.claude/skills"
```

`claude mcp add`는 기본적으로 현재 프로젝트에서만 쓰는 설정을 만듭니다. 모든 프로젝트에서 쓰려면 `--scope user`를 추가하세요. 스킬 설치기는 기존 `ui-review` 폴더를 덮어쓰지 않습니다. 설치 후 Claude Code를 새로 시작하면 `ui-review` 스킬을 사용할 수 있습니다.

연결 상태는 새 세션에서 `ui-review`의 `review_service_status` 도구를 호출해 확인합니다. 응답의 `status`가 `ready`여야 합니다.

원격 서버 연결용 설치기(`remote:install`)는 Codex 설정만 만들며 Claude Code는 지원하지 않습니다.

## 연결 확인

1. 새 Codex 세션에서 `$ui-review`로 연결 상태를 확인합니다. MCP 도구 `review_service_status` 응답의 `status`가 `ready`여야 합니다.
2. 같은 세션에서 `$ui-review`로 샘플 리뷰를 요청합니다. 이미지 경로는 **Codex 컴퓨터**에서 내려받은 소스의 실제 절대 경로로 바꿉니다.

   > `$ui-review`로 `/absolute/path/to/ui-review-agent/viewer/public/storybook-screen.png`를 검토해줘. 정보 계층과 주요 버튼이 눈에 잘 띄는지 확인해줘. 완료되면 보고서와 작업 링크를 알려줘.

3. 대시보드에서 같은 작업을 열어 결과의 캡처와 보고서를 확인합니다. 접수가 성공했어도 평가가 실패하면 대시보드에서 실패 원인을 확인하세요. 평가 없이 Chromium과 보고서 저장부터 확인하려면 [CLI 규칙 검사](cli.md)를 사용합니다.

URL을 추가하면 **서버의 Chromium**이 접근합니다. 개발 앱이 Codex 컴퓨터의 `127.0.0.1:3000`에 있으면 아래 역방향 포워딩을 유지한 뒤 리뷰 요청에 `http://127.0.0.1:13000`을 사용합니다. SSH 서버가 역방향 포워딩을 허용해야 합니다.

```sh
ssh -N -o ExitOnForwardFailure=yes \
  -R 127.0.0.1:13000:127.0.0.1:3000 review-server
```

MCP 연결이 실패하면 서버 준비 상태, 비대화형 SSH 키 인증, 포트 포워딩 허용 여부를 차례로 확인합니다. MCP는 서버를 직접 시작하지 않습니다.
