# CLI 검사와 개발

[설치 안내](self-hosting.md#서버-설치)에 따라 의존성과 Chromium을 설치합니다. 단일 화면 검사 명령은 대시보드 서버 없이 실행할 수 있습니다.

## 단일 화면 검사

URL은 CLI를 실행하는 컴퓨터에서 접근 가능한 주소로 바꿉니다. 아래 규칙 검사는 Chromium으로 화면을 열고 결과를 저장하며 AI 평가자 인증 없이 실행됩니다.

```sh
pnpm run inspect --url http://127.0.0.1:3000 --evaluator rules-only
pnpm run inspect --url http://127.0.0.1:3000 --theme both --evaluator rules-only
```

AI 평가를 하려면 기본 평가자 Codex CLI를 설치하고 `codex login`으로 로그인하세요. `--evaluator claude`를 사용하려면 Claude Code CLI를 설치하고 `claude auth login`으로 인증하세요. 이미지 입력은 기본 평가자 또는 Claude를 사용합니다. `pnpm run inspect`의 `--evaluator`는 `codex`, `claude`, `rules-only`만 지원합니다. Codex가 없다면 `rules-only`를 쓰거나, OpenAI 호환 API 같은 다른 평가자는 대시보드 설정에서 선택하세요.

```sh
pnpm run inspect --url http://127.0.0.1:3000 --purpose "상품 목록의 정보 계층 검토"
pnpm run inspect --image viewer/public/storybook-screen.png --purpose "예약 화면의 가독성과 배치 검토"
pnpm run inspect --help
```

한 실행에서 URL과 이미지는 하나만 지정합니다. 기본 결과 경로는 `runs/<runId>/report.md`와 `runs/<runId>/report.json`입니다. 대시보드와 같은 출력 디렉터리를 사용하면 **리뷰 프로젝트 → 관리 → 미연결 보고서**에서 저장된 결과를 열 수 있습니다.

## 여러 화면의 스타일 비교

두 URL만 주면 Chromium이 같은 크기로 두 화면을 열고, 화면에 보이는 입력이나 버튼처럼 비교할 수 있는 요소를 찾아 스타일을 측정합니다. 두 URL은 같은 출처의 서로 다른 주소여야 합니다. 대시보드의 작업공간에서 **화면 스타일 비교**를 선택합니다. **비교 화면 추가**로 기준 URL 하나에 비교 URL을 최대 4개까지 입력할 수 있습니다. URL은 모두 같은 출처에서 서로 다른 주소여야 합니다. 검토 목적은 작업공간의 목표를 사용합니다.

기준 캡처와 측정값을 각 비교에 재사용합니다. 한 보고서에서 반복되는 차이와 화면별 측정값, 캡처, 비교 미확인 범위를 확인할 수 있습니다. 같은 기준 요소에서 같은 CSS 속성과 값 차이가 두 화면 이상에 나타나면 반복 차이로 표시합니다.

연결된 MCP의 `review_compare_styles`에는 `workspaceId`, `submissionId`, `referenceUrl`과 함께 `comparisonUrl` 하나 또는 `comparisonUrls` 배열(2~4개)을 전달합니다. CLI에서는 `--compare-url`을 대상마다 한 번씩 지정합니다.

```sh
pnpm run inspect --url 'http://127.0.0.1:4317/?view=projects' \
  --compare-url 'http://127.0.0.1:4317/?view=report-search' \
  --compare-url 'http://127.0.0.1:4317/?view=trash'
```

기본 자동 비교는 같은 역할과 이름으로 짝을 찾습니다. 이름이 달라도 의미가 분명한 역할이 양쪽에 하나씩만 있으면 비교할 수 있습니다. 검사 결과에 실제 브라우저 값과 두 캡처의 위치, 비교한 범위와 짝을 찾지 못한 요소가 기록됩니다. 발견한 차이는 불일치 후보입니다. 첫 뷰포트에서 검색창·텍스트 입력·셀렉트·버튼·체크박스·라디오·스위치·탭·링크·내비게이션·사이드바 등 지원 역할을 화면당 최대 48개 검사합니다. 같은 이름이라도 선택·비활성 등 드러난 상태가 다르면 짝을 만들지 않습니다. 토큰 이름과 컴포넌트 사용 여부는 UI 코드에서 확인할 수 있습니다.

### 로그인 후 비교

뷰어가 실행 중인 기기의 로컬 대시보드에서는 기준·비교 URL을 넣고 **로그인 후 비교**를 선택합니다. 새 Chromium 창에 직접 로그인하고 기준 화면으로 이동하면 검사가 시작됩니다. CLI에서는 같은 비교 명령에 `--headed --login`을 추가하고, 열린 창에서 로그인 후 터미널에서 Enter를 누릅니다.

검사는 로그인한 Chromium 세션에서 이어집니다. 수집이 시작되면 상태 변경 요청이 차단되고, 세션은 실행이 끝나면 닫힙니다. 로그인 대기는 최대 10분이며, 기준과 비교 URL은 HTTPS 또는 로컬 테스트 주소를 사용합니다.

### 요소를 지정해 다시 비교

특정 요소와 승인된 기준값을 재검사할 때는 선택자와 속성을 직접 지정합니다. 기준 화면은 `--url`, 비교 화면과 각 요소의 CSS 선택자는 `--style-comparison` JSON에 지정합니다. 두 URL은 같은 출처의 서로 다른 주소여야 하고, 각 CSS 선택자는 현재 뷰포트에 보이는 요소 하나만 가리켜야 합니다. 첫 예시는 로컬 뷰어의 프로젝트 검색과 보고서 검색입니다.

```json
{
  "label": "목록 검색 필드",
  "comparisonUrl": "http://127.0.0.1:4317/?view=report-search",
  "reference": {
    "label": "프로젝트 검색",
    "selector": ".review-project-main input[type=search]"
  },
  "comparison": {
    "label": "보고서 검색",
    "selector": ".report-search-main input[type=search]"
  },
  "properties": ["border-top-left-radius", "border-top-color", "padding-left", "height", "font-size"]
}
```

이 예시를 `style-comparison.json`으로 저장하고 뷰어가 실행 중일 때 아래 명령을 실행하세요.

```sh
pnpm run inspect --url 'http://127.0.0.1:4317/?view=projects' \
  --viewport 1440x900 --evaluator rules-only --style-comparison style-comparison.json
```

보고서는 두 화면에서 같은 뷰포트로 측정한 CSS 값과 캡처의 요소 위치를 보여줍니다. 입력 요소는 개인정보 보호를 위해 캡처에서 가려지며, 스타일은 측정값에서 확인할 수 있습니다. 기준 없이 발견한 차이는 불일치 후보로 표시합니다. 승인된 기준이 있는 속성은 양쪽의 `expected`에 브라우저가 계산하는 값을 각각 지정할 수 있습니다. 예를 들어 양쪽에 `"expected": {"border-top-left-radius": "16px"}`를 두면 이 값을 어긴 요소를 기준 위반으로 표시합니다. 의도된 변형은 양쪽에 서로 다른 기준값을 지정하세요. 요소를 특정하거나 측정할 수 없으면 미확인으로 남습니다. 이 비교는 빠른 URL 규칙 검사에서 실행합니다. 보고서에 표시하는 URL은 개인정보 보호를 위해 쿼리와 해시를 생략하므로, 같은 경로에서 화면이 달라지는 경우 각 화면 이름을 구분해서 지정하세요.

지원 속성은 `height`, `min-height`, `font-size`, `font-weight`, `line-height`, `padding-left`, `padding-right`, `border-top-left-radius`, `border-top-color`, `border-top-width`, `background-color`, `color`입니다.

## 모델 벤치마크

서로 다른 평가자가 같은 화면을 얼마나 잘 검토하는지 비교하려면, 검토할 상태를 PNG로 한 번 캡처하세요. 5 MiB, 20 MP 이하의 정지 이미지 한 장을 사용합니다. 벤치마크 명령은 실행 중인 UI Review Agent에 벤치마크 프로젝트를 만들고, 모델별 작업공간에서 같은 스크린샷과 목적의 표준 이미지 리뷰를 한 번씩 접수합니다. 일반 리뷰와 같은 평가기, 큐, 보고서 저장 경로를 사용합니다. 화면 밖 콘텐츠와 실제 조작은 이 캡처로 확인할 수 없습니다.

1. [설정 예시](examples/benchmark.json)를 `docs/examples/benchmark.local.json`으로 복사하세요. `screenshot`을 교체하고 `models`에서 비교할 평가기와 모델 ID를 지정합니다. 스크린샷의 상대경로는 설정 파일 위치를 기준으로 합니다.
2. 필요하면 `name`과 중립적인 `purpose`를 화면에 맞게 수정하세요. 놓친 결함도 세려면 `knownDefects`에 `id`와 `description`을 넣으세요. 예를 들어 `{"id":"G01","description":"확인 버튼이 최초 화면에 표시되지 않음"}`을 등록할 수 있습니다. 알려진 결함은 채점 시트에만 쓰입니다.
3. [평가자 설정](self-hosting.md#대시보드-열기와-평가자-설정)을 마친 서버를 지정하고 아래 명령을 실행하세요. 예시 모델 목록에서는 이미지 입력을 지원하는 모델을 골랐습니다. 서버 계정에서 실제로 사용할 수 있는 모델 ID인지 확인하세요.

```sh
cp docs/examples/benchmark.json docs/examples/benchmark.local.json
# benchmark.local.json에서 스크린샷과 평가기·모델 목록을 수정
pnpm run benchmark --manifest docs/examples/benchmark.local.json \
  --output runs/benchmarks/modal-01 \
  --service http://127.0.0.1:4317 \
  --runs-root /absolute/path/to/review-data
```

`--runs-root`는 서버 프로세스의 `--runs`와 같은 경로입니다. 원본 실행 기록에 접근할 수 있으면 보고서에 보존된 토큰과 비용도 가져옵니다. 다른 컴퓨터에서는 [SSH 포트 포워딩](self-hosting.md#대시보드-열기와-평가자-설정)을 열고 `--service`에 포워딩한 주소를 지정하세요. 원본 접근에는 같은 서버의 SSH 별칭을 `--ssh-host`로, 원격 데이터 경로를 `--runs-root`로 지정합니다. 포워딩 포트가 서버 포트와 다르면 `--forwarded-origin`으로 서버 쪽 주소를 지정하세요. 시트에서 별도 대시보드 주소로 열려면 `--dashboard-origin`을 지정합니다.

원본 파일에 접근할 수 없으면 `--runs-root`를 생략하세요. 서비스가 반환하는 보고서로 채점 시트를 만들고, 얻지 못한 사용량과 비용은 비워 둡니다. 접수 전에 설정과 스크린샷만 확인하려면 명령에 `--dry-run`을 추가하세요.

원격 서비스의 루프백 4317을 내 컴퓨터 14317로 전달하는 예시입니다. 서버의 실제 저장 경로로 `--runs-root`를 바꾸세요.

```sh
# 별도 터미널에서 SSH 포워딩 유지
ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:14317:127.0.0.1:4317 review-server

pnpm run benchmark --manifest docs/examples/benchmark.local.json \
  --output runs/benchmarks/modal-01 \
  --service http://127.0.0.1:14317 --forwarded-origin http://127.0.0.1:4317 \
  --dashboard-origin http://127.0.0.1:14317 \
  --ssh-host review-server --runs-root /absolute/path/to/review-data
```

프로토콜 v1은 같은 스크린샷과 목적, 표준 리뷰, 요청 추론 강도 `medium`, 리뷰 상한 1,200초를 사용합니다. 모델 선택 방식이나 내부 응답 보정은 일반 리뷰의 평가기 동작을 따릅니다. Antigravity는 기본 모델 ID를 사용하며 추론 강도는 별도로 전달됩니다.

작업공간 API로 시작한 실행은 같은 설정과 출력 경로로 다시 실행해 이어갑니다. 기다리는 시간은 `--wait-seconds`로 조정할 수 있습니다. 새 화면이나 모델 목록으로 별도 비교를 하려면 새 출력 경로를 지정하세요. 출력에는 고정한 `screenshot.png`, 재개 상태 `benchmark-state.json`, 작업공간 목록 `benchmark-workspaces.json`, 결과 `benchmark-result.json`, 채점 시트 `grading.xlsx`가 생깁니다. 재실행 시 기존 채점 시트를 보존합니다. 이전 작업 API로 시작한 미완료 벤치마크는 중복 평가를 막기 위해 자동 재접수하지 않습니다. 작성된 보고서는 대시보드에서 열 수 있고 결과 파일을 만든 벤치마크는 기존 결과를 읽습니다.

채점 시트의 **탐지 채점** 탭에서 모델명을 가린 지적별로 유효·오탐·중복·보류와 알려진 결함 일치 여부를 표시합니다. 한 지적에 알려진 결함이 여러 개 들어 있으면 각각 표시할 수 있습니다. **요약**에서 탐지 건수와 채점 결과를 보고, **실행 기록**에서 입력 이미지 해시, 실행 상태, 원본 보고서, 사용량과 비용의 근거를 확인할 수 있습니다. 실패는 모델의 미탐으로 집계하지 않습니다.

보고된 비용이 없고 토큰으로 환산할 수 있다면 모델 항목의 `rates`에 `unit`(`USD` 또는 `credits`), 100만 토큰당 `input`, `cachedInput`, `output`, 그리고 `source`를 지정하세요. 예시에는 Codex Standard 크레딧과 OpenCode Go의 공개 기본 단가가 들어 있습니다. DeepSeek V4.1 Flash 환산치는 시간대 할증을 제외한 기본 단가 비교용입니다. 호환 API에서 다른 요금제를 사용하거나 실제 적용 조건에 가까운 환산이 필요하면 요금제, 속도, 시간대에 맞춰 단가와 근거를 바꾸세요. 환산치와 실제 청구액·차감량은 구분합니다.

## 개발 확인

```sh
pnpm run typecheck
pnpm run viewer:typecheck
pnpm test
pnpm run build
pnpm run viewer:build
```

대시보드 개발 모드는 `pnpm run dev:viewer --host 127.0.0.1`, Storybook은 `pnpm run storybook`으로 시작합니다. 운영 중인 서버와 같은 컴퓨터에서 개발할 때는 개발 서버에 별도 포트와 `--runs` 디렉터리를 지정합니다.
