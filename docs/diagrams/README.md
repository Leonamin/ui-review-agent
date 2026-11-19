# UI Review 엔진 동작 구조

[오프라인 HTML](engine-flow.html) · [라이트 PNG](engine-flow.png) · [다크 PNG](engine-flow-dark.png)

## 실행 흐름

1. CLI가 URL 또는 이미지 한 장과 목적·모델·전략을 받는다. `pnpm run inspect`는 `tsx src/cli.ts`를 실행한다.
2. 이미지 경로는 파일을 디코딩하고 방향을 보정해 PNG로 정규화한다. URL 경로는 Playwright와 내부 MCP 도구로 화면·DOM·접근성 및 규칙 검사 증거를 수집한다.
3. 전략 A는 종합 평가 한 단계, B는 세 분야별 독립 세션을 순서대로 실행한 뒤 통합, C는 종합 발견 후 동일 증거로 후보를 재판정한다. 정상 호출 기준이며 출력 복구나 URL 추가 관찰로 호출이 늘 수 있다. C는 새 문제를 추가하거나 기존 후보를 상향 확정할 수 없다.
4. 기본 provider인 Codex CLI가 증거와 판정 지침을 AI 서비스에 전달한다. Claude CLI도 선택할 수 있다. 파일·브라우저 도구를 활용해 자율 탐색하는 일반 코딩 세션과 달리 평가 세션의 도구와 외부 문맥을 제한한다.
5. 코드는 스키마, 증거 ID, 주장과 근거 연결 등을 검증한다. 부적합한 출력을 제외하거나 미확인 후보로 낮출 수 있지만, 이미지의 의미가 실제로 맞는지를 독립적으로 증명하지 않는다.
6. 확정 문제, 추가 확인 후보, 이미지의 개선 제안을 분리해 JSON·Markdown에 저장하고 뷰어에서 표시한다.

이미지에서 `추가 확인`은 **필요한 질문과 증거를 기록한 상태**다. 자동 클릭·스크롤·업무 검증은 수행하지 않는다. URL의 선택적 `--verify` 측정 흐름과 C 전략의 모델 재판정은 서로 다르다. URL 수집용 내부 MCP는 외부 에이전트용 리뷰 요청 API와 구분한다. 이 구조도는 엔진 흐름을 설명합니다. 대시보드와 외부 요청 MCP 연결은 [설치 안내](../self-hosting.md)에서 다룹니다.

## 근거 코드

- [CLI](../../src/cli.ts), [실행 스크립트](../../package.json)
- [입력 분기와 URL 수집](../../src/core.ts), [이미지 실행](../../src/image-core.ts), [이미지 정규화](../../src/image-input.ts)
- [판정 지침·전략·출력 검증](../../src/evaluator.ts), [Codex 실행](../../src/codex.ts)
- [출력 계약](../../src/types.ts), [Markdown](../../src/report.ts)

## 재현

`engine-flow.source.html`은 stack-diagram 템플릿을 바탕으로 만든 편집용 HTML이다. `engine-flow.html`에는 폰트와 SVG가 포함되어 있어 열 때 네트워크가 필요 없다. 아이콘 원본은 저장소에 복제하지 않고 출처만 `icon-sources.json`에 남겼다.

```sh
DIAGRAM_SKILL=/absolute/path/to/stack-diagram
python3 "$DIAGRAM_SKILL/scripts/fetch_icons.py" /tmp/ui-review-diagram-icons \
  input:lucide/terminal evidence:lucide/scan-eye strategy:lucide/git-branch \
  openai validator:lucide/shield-check report:lucide/panels-top-left policy:lucide/scroll-text
python3 "$DIAGRAM_SKILL/scripts/build.py" docs/diagrams/engine-flow.source.html \
  /tmp/ui-review-diagram-icons docs/diagrams/engine-flow.html --fonts "$DIAGRAM_SKILL/assets/fonts"
```

위 명령의 `DIAGRAM_SKILL`은 stack-diagram 도구의 실제 설치 경로로 바꿉니다. 동봉된 HTML에서 PNG만 다시 만들려면 Python Playwright와 Chromium을 설치한 뒤 `python3 docs/diagrams/render.py`를 실행합니다.

렌더러는 두 테마를 별도 Chromium 페이지에서 2배율로 캡처합니다.

아이콘 출처는 svgl(OpenAI)과 Lucide이며 브랜드 로고를 재색칠하지 않았다. stack-diagram 템플릿은 동봉 MIT 고지, 포함한 Geist·JetBrains Mono 폰트는 동봉 SIL OFL 고지를 따른다. 브랜드 로고의 권리는 각 소유자에게 있다.
