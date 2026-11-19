---
name: ui-review
description: URL이나 로컬 이미지를 셀프호스팅 UI Review 서버의 화면별 작업공간에 접수하고, 결과와 수정 후 재검토 이력을 확인할 때 사용한다.
---

# UI Review

이미지를 직접 평가한 대화 답변과 실제 UI Review 엔진 결과를 구분한다. 이 스킬은 별도 모델이 아니라 설치된 `ui-review` MCP로 사용자의 UI Review 서버에 접수하고 저장된 근거를 확인한다.

## 연결

`review_service_status`가 `ready`인지 확인한다. MCP가 없다면 Codex와 서버가 같은 컴퓨터인지 확인하고 설치 안내를 제공한다. 같은 컴퓨터에서는 `pnpm run build` 후 `dist/request-mcp-cli.js`를 stdio MCP로 등록한다. 다른 컴퓨터에서는 Codex 컴퓨터에서 빌드한 뒤 `pnpm run remote:install --ssh-host`에 사용자의 SSH 별칭이나 접속 대상을 지정한다. 사용자 설정은 검토 후 변경하고 설치 위치는 사용자가 제공한 경로를 쓴다.

서버는 MCP와 별도로 서버 컴퓨터에서 `pnpm run viewer --host 127.0.0.1`로 시작한다. 연결이 실패하면 해당 서버 실행 상태를 확인한다. 원격 연결에서는 SSH 키 인증과 포트 포워딩도 확인한다. 접수 완료는 서비스 응답으로 확인한다.

URL은 서버의 브라우저가 연다. 로컬 이미지 경로는 Codex 컴퓨터에서 접근할 수 있어야 한다. 서버 설정 또는 작업에 명시된 평가자를 사용한다.

## 모델 벤치마크

여러 모델에 같은 화면을 제출해 탐지와 비용을 비교하라는 요청에는 UI Review Agent 소스의 `docs/cli.md`에 있는 모델 벤치마크 절차와 `docs/examples/benchmark.json`을 사용한다. 중립적인 검토 목적, 같은 스크린샷, 명시한 모델 목록을 설정한 뒤 `pnpm run benchmark`로 접수한다. 알려진 결함은 설정의 `knownDefects`에 쓰고 검토 목적에는 넣지 않는다. 이미 접수한 비교는 같은 출력 경로로 이어간다. 결과는 `grading.xlsx`를 제공하며, 확보된 비용 근거와 기록이 없는 값을 구분한다.

## 작업공간 검토 접수

- `review_list_projects`, `review_list_workspaces`, `review_get_workspace`로 기존 소속과 검토 목표를 확인한다. 새 프로젝트는 `review_create_project({project:{name,description?}})`, 새 화면은 `review_create_workspace({workspace:{projectId,name,goal}})`로 만든다. 사용자의 검토 목적을 `goal`에 유지한다. URL이 같아도 검토 목적이 다른 화면은 별도 작업공간으로 둔다.
- 한 변경에 목록·상세·편집 화면이 있으면 같은 프로젝트에서 화면별 작업공간을 선택하거나 만든다. 각 화면을 `review_create_workspace_review({workspaceId,submissionId,target,options?})`로 접수하고, 화면 이름과 각 응답의 `dashboardUrl`을 함께 안내한다.
- 화면이나 파일 이름에서 기대 정답을 만들어 넣지 않는다. 기본 `standard`를 사용하며 관찰 수집·판정 분리는 사용자가 이미지 검사 실험을 요청할 때만 `observation-ledger`를 선택한다.
- URL은 `{kind:"url",name,url}`. 로컬 이미지는 먼저 `review_upload_image({imagePath})`로 명시된 절대 경로를 올리고 반환된 `asset.assetId`로 `{kind:"image",name,assetId}`를 만든다. 이미지는 PNG/JPEG/WebP 5MiB·20MP 이내, 자동 개인정보 제거 없음. 사용자 제공 화면에 개인정보가 있으면 비식별 이미지를 마련한다.
- 라이트·다크 동시 검사가 요청되면 URL target 하나에 `themeReview:{mode:"both"}`를 전달한다. 제품에서 적용 상태를 나타내는 CSS 선택자가 확인되면 `themeReview.selectors:{light:"…",dark:"…"}`를 함께 전달할 수 있다. 브라우저 색상 선호도에 반응하는 화면을 확인하는 옵션이며 선택자는 적용 상태 확인에 쓰인다. 작업공간의 첫 URL 검토에도 같은 target 필드를 사용한다.
- URL 기본 검사는 비교 가능한 버튼 행의 외곽 크기 차이를 후보로 남긴다. 제품 디자인 기준을 확인한 경우에만 URL target에 `alignmentContracts:[{groupSelector:"…",itemSelector:"…",crossSize:"equal",alignment:"center"}]`를 지정한다. `itemSelector`는 선택 사항이며, 크기가 의도적으로 다른 그룹은 `crossSize:"mixed"`로 크기 비교를 제외한다. 정렬 방향은 `start`, `center`, `end` 중 필요한 조건만 지정한다.
- 사용자 지정 실행 옵션이 없으면 `options`를 생략해 서버 설정을 사용한다. 별도 실행 설정을 요청하면 `options.evaluator` (`codex`, `claude`, `antigravity`, `openai-compatible`), `options.model`, `options.reasoningEffort`, `options.timeoutSeconds` 중 명시한 값만 전달한다. `options`를 전달하면 미지정 실행 시간 상한은 작업공간 접수 기본값인 1,200초다. API 주소와 키는 서버 대시보드에서 설정한다.
- 입력마다 고유한 `submissionId`를 사용한다. 응답이 끊기면 같은 작업공간에 같은 입력과 ID로 재전송한다. 일부 화면만 접수됐으면 접수된 링크를 유지하고 응답이 불분명한 화면만 확인한다.

## 두 URL의 스타일 비교

두 주소를 주면서 화면 간 UI 일관성이나 디자인 토큰 차이를 확인해 달라고 하면 비교 목적에 맞는 작업공간에서 `review_compare_styles({workspaceId,submissionId,referenceUrl,comparisonUrl})`로 한 쌍을 접수한다. 두 주소는 같은 출처의 서로 다른 URL이어야 한다. CSS 선택자, 검사할 속성, 이미 발견한 위반을 요청하지 않는다. 서버가 두 화면에서 비교할 요소를 찾아 렌더링 값을 측정한다.

`review_create_workspace_review`로 접수할 때는 하나의 URL target에 `url`과 `comparisonUrl`을 지정하고 평가자, 로그인, 테마 옵션은 생략한다. 수정 후 같은 비교를 다시 실행할 때는 같은 작업공간과 두 주소를 유지하고 새 `submissionId`로 접수한다. 대시보드에서도 검토 탭에서 두 화면 스타일 비교를 다시 실행할 수 있다.

MCP에 전용 도구가 없고 현재 체크아웃의 `pnpm run inspect --help`에 `--compare-url`이 있으면, 두 URL에 접근할 수 있는 환경에서 `pnpm run inspect --url 'A' --compare-url 'B'`로 실행할 수 있다. 전용 도구나 CLI 옵션이 없으면 이 비교가 실행되지 않았음을 알린다.

완료된 보고서의 `captures[].deterministicChecks.autoStyleComparison`에서 실제로 비교한 쌍·차이·짝을 찾지 못하거나 측정하지 못한 범위를 읽는다. 측정 차이는 검토 후보로 전달하고, 렌더링 값에서 소스상의 토큰 이름 또는 공용 컴포넌트 사용을 추정하지 않는다. 선택자는 결과 위치를 전달하는 데 사용한다.

## 로그인 후 URL 검토

- 사용자가 로그인 후의 화면을 검토하라고 요청하면 URL target에 `shouldWaitForStart: true`를 지정한다. 작업공간의 첫 URL 검토에도 같은 필드를 쓴다. 작업공간 URL 후속 검토에서는 `shouldWaitForStart: true`를 `submission`에 지정한다. 일반 URL 검토는 이 필드를 생략해 바로 접수한다.
- 응답이 `awaiting-start`면 접수된 작업의 대시보드 링크를 안내한다. 사용자는 **검토 시작** 카드에서 **로그인 정보 입력** 또는 **로그인 없이 검토**를 선택한다. 작업공간에서는 이 카드를 요약 탭에 표시한다.
- 일반 URL 실행도 요청한 주소에서 같은 출처의 로그인 폼으로 이동한 것이 확인되면 `awaiting-start`로 전환된다. 실행에 `loginRedirect`가 있으면 사용자가 **로그인하고 원래 화면 검토** 또는 **현재 로그인 화면 검토**를 선택할 수 있도록 대시보드 링크를 안내하고 상태 확인을 멈춘다. 보고서를 읽을 때 요청 URL과 실제 캡처 URL을 확인한다.
- ID·비밀번호와 일회용 코드는 대시보드의 로그인 정보 입력 창에서만 받는다. 대화, `goal`, URL, MCP 입력에는 비밀값을 넣지 않는다. 선택한 인증 방식은 실행마다 지정한다.

## 결과와 재검토

`review_get_workspace({workspaceId})`에서 접수 응답의 `requestId`에 해당하는 요청과 최신 `attempt`를 확인한다. 한 번의 확인 세션은 최대 5회, 최소 5초 간격으로 조회하고 대기 중이면 작업공간의 대시보드 주소를 알려준다. 원격 설치 때 지정한 주소가 있으면 그 주소로 안내하고, 서버의 응답 경로와 작업공간 ID는 유지한다. 무기한 polling하거나 대기 상태를 완료로 표시하지 않는다.

완료 attempt의 `reportId`를 `review_get_report`로 읽고 확정 문제·추가 확인·개선 제안을 구분해 설명한다. `runStatus:partial`은 검사 제한이며 무결함/성공의 근거가 아니다. 모델 요청 이름과 실제 제공 모델 확인 여부도 구분한다.

모드별 `captures[].theme`에서 실제 적용 확인 여부를 읽고, `captures[].deterministicChecks`에서 색 대비와 그룹 정렬을 확인한다. 적용 미확인·캡처 없음·대비 추가 확인을 통과로 간주하지 않는다. 자동 비교에서 나온 크기 차이는 제품 기준이 없으면 불일치 후보로 설명한다.

수정된 화면을 새로 검사하려면 같은 작업공간에 새 `submissionId`로 `review_create_workspace_review`를 접수한다. 변경된 이미지는 새로 업로드한다. 이전 검사 회차와 새 보고서의 근거를 비교해 해결 여부를 확인한다. 기존 보고서를 바탕으로 새 동작을 검증하려면 `review_followup`을 사용한다.

실행 실패 또는 해당 실행의 저장 보고서가 `partial`이고 `evaluation.status=failed`인 AI 평가 실패는 원인을 확인한 뒤 `review_retry_workspace_request({requestId,attemptId,submissionId})`에 최신 시도 ID를 지정해 한 번 재시도한다. 일반 `partial`, 근거 검증 일부 완료, 정상 0건은 재시도 대상이 아니다. URL은 현재 화면을 다시 캡처하고 이미지는 같은 입력을 사용하며 기존 회차의 조건과 이전 보고서를 보존한다. 재시도도 실패하면 원인을 보고하고 멈춘다. 판정이 마음에 들지 않는다는 이유로 반복 호출하지 않는다.

## 저장 화면의 영역과 질문

사용자가 저장된 화면의 특정 부분을 지목하면 `review_get_image_context({reportId,imageId})`로 원본 크기와 `source.sha256`를 확인한다. 수동 선택한 직사각형을 원본 이미지 픽셀 좌표 `{x,y,width,height}`로 변환하고 `review_create_focused({submission})`에 고유 submissionId, reportId, imageId, sourceSha256(조회한 source.sha256), region, comment를 전달한다. 표시 화면의 CSS 좌표를 그대로 쓰거나 선택 영역을 자동 DOM 요소로 바꾸지 않는다. 영역이 모호하면 임의로 확정하지 않는다.

집중 재검토도 옵션을 생략하면 서버 기본값을 쓰고, 명시한 `options`는 해당 검토에만 적용한다. `review_get_focused`로 상태와 답변을 확인한다. 사용자 질문은 결함의 증거가 아니며 엔진이 동의하지 않을 수 있다. 이 동작은 원본 전체 이미지와 선택 영역을 함께 재해석하며 실제 페이지에 재접속하거나 동작을 검증하지 않는다. 변경된 UI를 검사하려면 작업공간에서 새 검토를 접수한다. 반복 상태 확인은 위의 제한을 따른다.

집중 재검토 실행 자체가 실패하면 `review_retry_focused`에 최신 실패 attemptId와 새 submissionId를 지정해 한 번 재시도할 수 있다. 완료된 답변이 기대와 다르다는 이유로 재시도하지 않는다.

## 프로젝트와 작업공간의 후속 검증

프로젝트의 로그인 출처나 POST 허용 설정은 `review_list_projects`의 `supabaseAuthBindings`와 `postAllowedHosts`로 확인한다. 변경이 필요하면 각각 `managementLinks.login` 또는 `managementLinks.post`를 안내하고, 사용자가 대시보드에서 변경 내용을 저장하도록 한다. 원격 설치에서 별도 대시보드 주소가 지정돼 있으면 그 주소를 사용하고 링크의 `project`와 `manage` 쿼리는 유지한다. 링크가 없거나 설정 창이 바로 열리지 않으면 프로젝트 상세의 **관리**에서 해당 항목을 열도록 안내한다. 이전 대시보드에서는 프로젝트 본문에 있는 해당 설정을 펼친다. `isUncategorized`인 시스템 프로젝트에는 두 설정을 제공하지 않는다.

사용자가 “이 필터를 조작한 화면도 검증”처럼 실제 행동을 요청하면 `review_followup`에 workspaceId와 `submission:{submissionId,parentReportId,instruction,...}`을 전달한다. 부모는 사용자가 보고 지시한 보고서로 고정한다. 선택 영역이 있으면 `review_get_image_context`에서 확인한 imageId·sourceSha256와 원본 픽셀 region을 함께 전달한다. 저장 이미지에 대한 질문은 기존 focused 경로이며 라이브 동작 검증으로 바꾸지 않는다.

명확한 행동 지시에는 반복 승인창을 요구하지 않는다. 목표가 불명확하거나 허용 범위를 벗어날 때만 확인한다. 자연어 목표를 유지하고 모델 대신 정적인 첫 옵션·좌표를 지정하지 않는다. 명시한 옵션이 없으면 다른 옵션으로 대체하지 않는다. 기본적으로 목표에 관련된 컨트롤·결과를 검토하며 사용자가 영역 안만 요청하면 scopeMode `selected-only`를 지정한다.

이미지 작업공간의 후속 요청도 같은 도구로 접수할 수 있다. 정적 이미지·영역만 평가하며 웹 클릭·탐색 요청은 일부 완료와 준비 이미지 안내로 종료한다. 이미지 평가를 실제 동작 검증으로 보고하지 않는다.

후속 요청은 부모·선택 근거를 바꾸지 않고 작업공간별로 순차 실행한다. `review_get_workspace`에서 requests와 attempts·phase·result 및 연결된 작업공간을 확인한다. 요청 답변이나 planner 완료를 UI 검증 전체 완료로 보고하지 않는다. 실제 평가·동작·비교 근거와 미확인 범위를 구분한다. 제한된 컨텍스트 재사용이나 준비 재생에 실패하면 이미지·설명 보완을 안내하며 이후 동작을 성공했다고 표시하지 않는다.

대기·실행 취소는 `review_cancel_workspace_request`에 최신 attemptId를 지정한다. 실패 재시도는 `review_retry_workspace_request`로 동일 조건을 유지하고, 지시 변경은 새 후속 요청으로 접수한다. 전달이 불확실할 때는 같은 submissionId를 재사용한다. 진행 중인 요청에 새 지시를 몰래 주입하거나 다른 완료 결과로 부모를 자동 변경하지 않는다.
