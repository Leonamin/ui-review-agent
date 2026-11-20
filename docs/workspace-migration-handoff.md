# 작업공간 실행 상태 전환 인수인계

합성 복제본에서 v2 후보를 저장 상태로 사용해 기존 보고서 조회와 대기 검토 재개를 검증했습니다. 공개 소스의 기본 실행은 v1을 사용합니다. 설치와 실행은 [셀프호스팅 안내](self-hosting.md)를 따릅니다.

## 현재 상태

- 작업공간 API에서 검토를 접수·시작·재시도할 수 있습니다. 공개 응답은 `requestId`와 `attemptId`로 검토를 식별합니다.
- 공개본에는 작업공간·보고서 탐색과 결과 탭, 세로 스크롤 검토, 두 화면 스타일 비교, 폼 컨트롤 상단 정렬 검사가 포함돼 있습니다. [작업공간 화면](../viewer/features/workspaces/WorkspacePage.tsx), [세로 스크롤](../src/vertical-scroll.ts), [스타일 비교](cli.md), [폼 정렬 검사](../src/browser.ts)
- [변환기](../src/workspace-state-converter.ts)는 v1 스냅샷을 읽고 v2 후보를 메모리에서 만듭니다. 작업공간 요청, 시도, 보고서 소유권, 중복 제출 방지 기록을 변환하고 해석하지 못한 참조를 집계합니다.
- [보고서 검사](../src/workspace-state-audit.ts)는 복제본의 보고서 ID와 상대 경로, 소속과 숨김 상태, 보고서·캡처 해시를 대조합니다. [합성 테스트](../tests/workspace-state-converter.test.ts)는 이전·현재 회차가 섞인 데이터, 손상된 참조, 대기 시도의 ID, CLI의 재현성과 읽기 전용 동작을 검증합니다. [검사 테스트](../tests/workspace-state-audit.test.ts)는 보고서·캡처 확인과 복제본 경계를 검증합니다.

## 읽기 전용 검증 실행

합성 데이터가 담긴 격리된 `runs` 복제본으로 실행합니다. 복제본에는 `.review-service/state.json`과 참조된 보고서·캡처가 있어야 합니다.

```sh
pnpm run workspace:migration:dry-run --runs /path/to/isolated-copy
```

출력의 `hasPassed`는 변환·파일 검증 결과입니다. `cutoverBlockers`는 실행 중인 시도처럼 전환 전에 확인할 조건을 별도로 표시합니다. 기본 실행은 후보 상태를 파일에 저장하지 않습니다. 저장된 절대 캡처 경로를 복제본 안으로 대응시켜야 하는 경우 `--original-runs-root`를 함께 지정할 수 있습니다.

## 오프라인 전환과 복구

아래 예시는 서비스가 정지된 복제본에서 실행합니다. 전체 데이터 디렉터리와 기존 릴리스의 백업을 먼저 보관합니다. 출력 파일은 새 경로에만 작성되며, 검사 실패 또는 전환 차단 항목이 있으면 생성되지 않습니다.

```sh
pnpm exec tsx src/workspace-state-migration-cli.ts --runs /path/to/offline-copy --to 2 --output /path/to/offline-copy/.review-service/state.v2.json
pnpm exec tsx src/workspace-state-migration-cli.ts --runs /path/to/offline-copy --to 1 --output /path/to/offline-copy/.review-service/state.v1.json
```

첫 번째 명령은 v1 상태를, 두 번째 명령은 현재 v2 상태를 입력으로 사용합니다. `hasWritten`, `cutoverBlockers`, 입력·출력 해시를 확인한 뒤 서비스가 정지된 상태에서 해당 후보를 `state.json`으로 원자적으로 교체합니다. v2로 시작할 때 뷰어에 `--workspace-state-version 2`를 전달합니다. v1으로 돌아갈 때는 현재 v2의 신규 요청·시도까지 포함한 v1 후보를 설치한 뒤 기본 옵션으로 실행합니다. 보고서, 캡처, 설정은 같은 데이터 디렉터리에 유지합니다.

```sh
pnpm exec tsx --test --test-name-pattern='offline cutover and rollback' tests/workspace-state-runtime.test.ts
```

합성 복제본에서 v2 전환 후 접수한 요청의 ID·시도 이력·보고서 ID·소속 및 파일 내용이 v1 복구 후 유지됐습니다. 동일 제출의 재전송으로 발생한 추가 실행은 0건이었습니다. 실행 중인 시도가 있으면 후보를 만들지 않았고, 기존 파일 경로를 출력으로 지정하면 거부했습니다.

## v2 격리 실행 재현

```sh
pnpm exec tsx --test tests/workspace-state-converter.test.ts tests/workspace-state-audit.test.ts tests/workspace-state-runtime.test.ts
```

[실행 테스트](../tests/workspace-state-runtime.test.ts)가 임시 폴더에 합성 v1 상태와 보고서를 작성하고 이를 복제합니다. 복제본의 `.review-service/state.json`에 변환기가 생성한 v2 후보를 저장합니다. `ReviewService`를 `workspaceStateVersion: 2`와 테스트 실행기로 시작한 뒤, 실제 뷰어 HTTP 서버를 `127.0.0.1`의 임시 포트에 엽니다. 테스트가 끝나면 임시 폴더를 삭제합니다.

서비스는 변환기로 후보의 소유권·참조·순서를 대조한 뒤, 기존 뷰어와 워커가 쓰는 메모리 구조로 읽습니다. 큐 변경은 기존 파일 교체 경로에서 v2로 저장합니다. 합성 원본의 상태 파일은 테스트 전후에 바이트 단위로 일치했습니다.

## 격리 검증 결과 (2026-11-20)

| 항목 | 결과 |
| --- | --- |
| 기존 보고서 조회 | 통과. `GET /api/reports`와 `GET /api/reports/:id`에서 같은 작업의 이전·현재 회차, 단독 보고서, 이동된 보고서의 기존 ID와 상대 경로를 확인했습니다. 목록의 작업공간 소속은 기존 배치와 일치했고, 단독 보고서는 소속 없이 표시됐습니다. |
| 휴지통 보고서 | 통과. 보고서 파일이 복제본에 남아 있는 상태에서 목록에서 숨겨지고 상세 API는 `404`를 반환했습니다. |
| 대기 검토 재개 | 통과. `GET /api/review-workspaces/:id`에서 기존 요청·시도 ID를 확인했습니다. 먼저 접수된 두 시도가 저장된 순서대로 `queued → running → completed`로 진행됐습니다. |
| 로그인 입력 대기 | 통과. 앞선 두 시도가 끝난 뒤에도 로그인 시도는 `awaiting-start`, 그 뒤에 의존하는 시도는 `queued`를 유지했습니다. `POST /api/workspace-requests/:id/start`로 합성 로그인 정보를 제공하자 같은 시도가 `queued → running → completed`로 진행됐고 후속 시도도 완료됐습니다. |
| 완료 상태 재시작 | 통과. 테스트 실행기는 네 시도 ID를 각각 한 번씩 순서대로 받았습니다. 완료 상태를 v2로 저장한 뒤 서비스 재시작 시 추가 실행은 0건이었고, 저장 파일에 합성 비밀번호는 없었습니다. |
| 시작 실패 조건 | 통과. 기본 실행으로 v2를 열면 기존과 같이 `Unsupported review state`가 발생합니다. v2 옵션을 사용해도 보고서 소유권의 경로가 불일치하면 `Invalid workspace state v2 candidate`로 중단됩니다. 두 경우 모두 후보 파일이 유지됐습니다. |

## 병렬 워커와 강제 종료 후 재시작 검증 (2026-11-20)

```sh
pnpm exec tsx --test --test-name-pattern='parallel v2 workers recover after SIGKILL' tests/workspace-state-runtime.test.ts
```

[테스트 프로세스](../tests/fixtures/workspace-v2-worker.ts)는 합성 v2 복제본에서 워커 2개와 `127.0.0.1` 뷰어 API를 실행합니다. 두 작업공간에서 각각 한 시도가 실행기에 진입한 뒤, 한 시도만 완료 보고서를 기록하고 두 실행기 모두 반환을 보류합니다. API에서 `running` 2건과 `queued` 1건을 확인한 시점에 테스트 프로세스에 `SIGKILL`을 보냅니다. 종료 신호와 이전 PID가 든 잠금 파일을 확인한 뒤 새 프로세스가 같은 복제본의 잠금을 회수합니다.

| 시도 | 종료 직전 | 재시작 후 | 실행기 호출 횟수 (종료 전 / 재시작 후) |
| --- | --- | --- | --- |
| 실행 중, 보고서 미저장 | `running` | 같은 시도 ID로 `failed`. 중단 사유 기록. | 1 / 0 |
| 실행 중, 완료 보고서 저장 | `running` | 같은 시도 ID로 `completed`. 복구된 보고서의 ID를 상세 API에서 확인. | 1 / 0 |
| 앞선 시도에 의존하는 큐 대기 | `queued` | 같은 시도 ID로 재개해 `completed`. | 0 / 1 |
| 로그인 입력 대기 | `awaiting-start` | 같은 시도 ID로 `awaiting-start` 유지. | 0 / 0 |
| 이전 완료 이력 | `completed` | 동일한 이력 유지. | 0 / 0 |

통과. 두 작업공간의 요청·시도 ID와 상태를 종료 직전과 재시작 후 API 및 저장 파일에서 대조했습니다. 수동 재시도 전까지 실행기 호출은 총 3건이었고 중복 실행과 재개 가능한 큐 항목의 누락은 0건이었습니다. 보고서 없이 중단된 시도는 실패 이력으로 남아 별도 재시도가 필요합니다. 합성 원본 상태 파일은 바이트 단위로 일치했습니다.

## 강제 종료로 실패한 시도의 재시도·취소·중복 제출 (2026-11-20)

위 재현 명령은 같은 복제본에서 재시작 검증 직후 다음 뷰어 API 검증을 이어서 실행합니다.

| 동작 | 결과 |
| --- | --- |
| 실패 시도 재시도 (`POST /api/workspace-requests/:id/retry`) | 동일 제출 ID와 실패 시도 ID를 동시에 두 번 보내도 같은 요청에 새 시도 ID 하나만 추가됐습니다. 새 시도는 한 번 실행돼 `completed`가 됐고, 기존 완료·실패 이력은 유지됐습니다. 동일 제출 ID로 대상 시도 ID를 바꾸면 `409`를 반환했습니다. |
| 최초 요청 중복 제출 (`POST /api/review-workspaces/:id/reviews`) | 동일 제출 ID와 입력을 동시에 두 번 보내면 같은 요청·시도 ID를 반환했습니다. 동일 제출 ID로 대상 URL을 바꾸면 `409`를 반환했습니다. |
| 실행 중·큐 대기 취소 (`POST /api/workspace-requests/:id/cancel`) | 두 시도 모두 같은 ID로 `cancelled`가 됐습니다. 실행 중 시도의 실행기는 중단 신호를 받았고, 큐 대기 시도의 실행기 호출은 0건이었습니다. 같은 취소를 반복하면 동일 결과를 반환했고, 재시도 전의 오래된 시도 ID로 취소하면 `409`를 반환했습니다. |
| v2 재시작 후 재전송 | 완료된 재시도와 취소된 두 요청에 기존 제출을 다시 보내도 같은 요청·시도 ID와 상태를 반환했습니다. 시도 추가와 실행기 추가 호출은 각각 0건이었습니다. |

합성 요청 `e1c0df2f-5c9c-4838-a0b3-f147dd656d11`의 한 실행에서 확인한 시도 이력입니다. 재현 명령은 실행할 때마다 새 합성 ID를 출력합니다.

| 시도 | ID | 최종 상태 |
| --- | --- | --- |
| 이전 완료 | `aa8a31d8-b339-4230-9451-3234e7aa6e5d` | `completed` |
| 강제 종료 | `b0d0efc5-487e-4fa3-8a94-f42bda7efd4a` | `failed` |
| 재시도 | `5c2d7ecf-483c-4d8d-b37a-5fb1b0ee37b9` | `completed` |

통과. 전체 실행기 호출 5건의 시도 ID를 대조해 중복 실행 0건을 확인했습니다. 최종 이력은 재시작 후 API와 v2 저장 파일에서 일치했습니다.

변환·파일 검사 5개, v2 실행 검사 3개, 엔진·뷰어 타입 검사가 통과했습니다. 회귀 테스트는 localhost 제약에 따라 LAN 접속 검사 1개를 제외했고, 실행한 403개가 모두 통과했습니다.

```sh
pnpm run typecheck
pnpm run viewer:typecheck
pnpm exec tsx --test --test-skip-pattern='wildcard listener accepts its LAN address' tests/*.test.ts
```

## 남은 검증과 제약

- v2는 명시적 실행 옵션으로 사용합니다. 저장마다 변환기를 호출하므로 대규모 상태의 성능은 별도 확인이 필요합니다.
- 상태 파일 쓰기 도중 중단·쓰기 실패, 로그인 정보를 사용 중인 시도의 재시작, 만료된 휴지통 정리는 v2에서 별도 검증이 필요합니다.
- 합성 로그인 입력의 전달까지 확인했습니다. 실제 로그인·브라우저 캡처·평가자 호출·운영 환경은 검증 범위 밖입니다.
- 운영 전환에서는 실제 복제본의 검사와 백업을 별도로 확인해야 합니다.
