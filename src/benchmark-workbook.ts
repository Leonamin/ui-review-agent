import {createHash} from 'node:crypto';
import {link, mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import dataValidation, {type DataValidationSheetOptions} from '@onparallel/write-excel-file-data-validation';
import sharp from 'sharp';
import writeXlsx, {type Cell, type CellObject, type Image, type SheetData, type Row} from 'write-excel-file/node';
import {getCellAddress} from 'write-excel-file/utility';
import type {BenchmarkResult} from './benchmark.js';

const gradingSheet = '탐지 채점';
const gradingStates = ['유효', '오탐', '중복', '보류'];
const validMatch = '일치';
const navy = '#16374C';
const stripe = '#F1F6FA';
const edit = '#FFF1CE';
const providers = {
  codex: 'Codex CLI',
  claude: 'Claude Code CLI',
  antigravity: 'Antigravity CLI',
  'openai-compatible': 'OpenAI 호환 API',
};
const statuses = {completed: '완료', partial: '부분 완료', failed: '실패', cancelled: '취소'};
const dispositions: Record<string, string> = {confirmed: '확정', 'needs-verification': '추가 확인'};

function band(value: string, width: number, isTitle = false, height = isTitle ? 36 : 24): Row {
  return [{
    value,
    columnSpan: width,
    backgroundColor: isTitle ? navy : stripe,
    textColor: isTitle ? '#FFFFFF' : navy,
    fontWeight: isTitle ? 'bold' : undefined,
    fontSize: isTitle ? 17 : undefined,
    wrap: true,
    alignVertical: 'center',
    height,
  }];
}

function header(values: string[]): Row {
  return values.map(value => ({
    value, backgroundColor: navy, textColor: '#FFFFFF', fontWeight: 'bold', wrap: true, alignVertical: 'center', height: 30,
  }));
}

function body(cells: Cell[], index: number, height = 24): Row {
  const backgroundColor = index % 2 === 0 ? stripe : '#FFFFFF';
  return cells.map(value => ({
    backgroundColor, alignVertical: 'center', wrap: true, height,
    ...(typeof value === 'object' && value !== null ? value : {value: value ?? undefined}),
  }));
}

function formatted(value: number | undefined, format: string): CellObject {
  return {value, type: Number, format};
}

function formula(value: string): CellObject {
  return {value, type: 'Formula'};
}

function heightFor(text: string, width: number, minHeight = 24): number {
  const lines = text.split('\n').reduce((count, line) => count + Math.max(1, Math.ceil(line.length / width)), 0);
  return Math.min(408, Math.max(minHeight, 14 * lines + 12));
}

function listValidation(fromRow: number, toRow: number, fromColumn: number, toColumn: number, values: string[]) {
  return {
    cellRange: {from: {row: fromRow, column: fromColumn}, to: {row: toRow, column: toColumn}},
    validation: {type: 'list' as const, values, error: '목록에서 값을 선택해 주세요.'},
  };
}

function grading(result: BenchmarkResult, image: Image) {
  const matches = result.knownDefects;
  const tableWidth = 7 + matches.length;
  const table: SheetData = [
    band(result.name + ' 탐지 채점', tableWidth + 2, true),
    band(matches.length
      ? '판정을 선택하고, 유효한 지적에 해당하는 알려진 결함 열마다 일치를 표시합니다.'
      : '판정을 선택합니다. 알려진 결함을 등록하면 누락도 집계할 수 있습니다.', tableWidth),
    ...matches.map(defect => band(defect.id + '  ' + defect.description, tableWidth, false, heightFor(defect.description, 88))),
    header(['실행', '지적 ID', 'Agent 판정', '지적 제목', '관찰 근거', '채점', ...matches.map(defect => defect.id), '채점 메모']),
  ];
  const headerRow = table.length;
  const entries = result.runs.flatMap(run => run.findings.map((finding, index) => ({
    code: run.code,
    finding,
    order: createHash('sha256').update(JSON.stringify([result.screenshot.sha256, run.code, finding.id, index])).digest('hex'),
  }))).sort((a, b) => a.order.localeCompare(b.order));
  const inputCell = {backgroundColor: edit};
  for (const [index, {code, finding}] of entries.entries()) {
    const facts = finding.facts.join('\n');
    table.push(body([
      code, finding.id, dispositions[finding.disposition] ?? finding.disposition, finding.title, facts, inputCell,
      ...matches.map(() => inputCell), inputCell,
    ], index, Math.max(heightFor(facts, 31, 40), heightFor(finding.title, 18, 40))));
  }
  const lastScoreRow = table.length;
  if (!entries.length) table.push(band('채점할 지적이 없습니다. 실행별 상태는 요약에서 확인할 수 있습니다.', tableWidth));
  const suggestions = result.runs.flatMap(run => run.suggestions.map(suggestion => ({code: run.code, suggestion})));
  if (suggestions.length) {
    table.push([], band('개선 제안 참고 · 탐지 건수 제외', tableWidth));
    for (const [index, {code, suggestion}] of suggestions.entries()) {
      table.push(body([code, suggestion.id, '개선 제안', suggestion.title, suggestion.observation], index, heightFor(suggestion.observation, 31, 38)));
    }
  }
  const firstScoreRow = headerRow + 1;
  const validation: DataValidationSheetOptions['dataValidation'] = [];
  if (entries.length) {
    validation.push(listValidation(firstScoreRow, lastScoreRow, 6, 6, gradingStates));
    if (matches.length) validation.push(listValidation(firstScoreRow, lastScoreRow, 7, 6 + matches.length, [validMatch]));
  }
  return {
    data: table,
    sheet: gradingSheet,
    columns: [13, 22, 17, 39, 56, 13, ...matches.map(() => 12), 26, 3, 39].map(width => ({width})),
    dataValidation: validation,
    images: [{...image, anchor: {row: 3, column: tableWidth + 2}}],
    stickyRowsCount: headerRow <= 10 ? headerRow : 0,
    showGridLines: false,
    firstScoreRow,
    lastScoreRow,
  };
}

function summary(result: BenchmarkResult, firstScoreRow: number, lastScoreRow: number): SheetData {
  const data: SheetData = [
    band(result.name + ' 벤치마크', 14, true),
    band('원시 탐지는 보고서에 표시된 지적 수입니다. 탐지 채점에서 판정과 결함 일치 여부를 입력하면 집계가 갱신됩니다.', 14),
    band('누락 건수는 성공한 실행에 한해 채점을 마친 뒤 표시됩니다. 비용은 보고값 또는 단가 기준 추정치입니다.', 14),
    header(['실행', '실행 경로', '요청 모델', '상태', '원시 탐지', '유효', '오탐', '중복', '채점 대기',
      '알려진 탐지', '알려진 누락', '소요(초)', '추정 USD', '추정 크레딧']),
  ];
  const range = (index: number) => {
    const column = getCellAddress(0, index - 1).slice(0, -1);
    return "'" + gradingSheet + "'!$" + column + '$' + firstScoreRow + ':$' + column + '$' + lastScoreRow;
  };
  for (const [index, run] of result.runs.entries()) {
    const rowNumber = data.length + 1;
    const isComplete = run.status === 'completed';
    const hasDetails = run.findings.length > 0;
    const countBy = (grade: string, extra = '') =>
      'COUNTIFS(' + range(1) + ',$A' + rowNumber + ',' + range(6) + ',"' + grade + '"' + extra + ')';
    const count = (grade: string) => hasDetails ? formula(countBy(grade)) : 0;
    const isKnownScorable = isComplete && result.knownDefects.length > 0;
    const knownMatches = result.knownDefects.map((_, i) =>
      '--(' + countBy('유효', ',' + range(7 + i) + ',"' + validMatch + '"') + '>0)');
    const completedKnownMatches = 'J' + rowNumber;
    const remainingScores = 'I' + rowNumber;
    const absent = result.knownDefects.length + '-' + completedKnownMatches;
    data.push(body([
      run.code, providers[run.evaluator], run.model, statuses[run.status],
      isComplete || hasDetails ? run.findings.length : null,
      isComplete || hasDetails ? count('유효') : null,
      isComplete || hasDetails ? count('오탐') : null,
      isComplete || hasDetails ? count('중복') : null,
      hasDetails ? formula('E' + rowNumber + '-SUM(F' + rowNumber + ':H' + rowNumber + ')') : isComplete ? 0 : null,
      isKnownScorable ? hasDetails ? formula(knownMatches.join('+')) : 0 : null,
      isKnownScorable ? hasDetails
        ? formula('IF(OR(' + remainingScores + '=0,' + absent + '=0),' + absent + ',"")')
        : result.knownDefects.length : null,
      formatted(run.durationMs === undefined ? undefined : run.durationMs / 1000, '0.0'),
      formatted(run.cost?.unit === 'USD' ? run.cost.amount : undefined, '$0.000000'),
      formatted(run.cost?.unit === 'credits' ? run.cost.amount : undefined, '0.000'),
    ], index, 28));
  }
  return data;
}

function execution(result: BenchmarkResult): SheetData {
  const {screenshot} = result;
  const data: SheetData = [
    band('실행 기록과 사용량', 15, true),
    band('입력  ' + screenshot.fileName + '  ·  ' + screenshot.width + ' × ' + screenshot.height + '  ·  SHA-256 ' + screenshot.sha256, 15),
    band(screenshot.evidenceSha256 ? '평가기 전달 이미지 SHA-256  ' + screenshot.evidenceSha256 : '평가기 전달 이미지 해시  미확인', 15),
    band('검토 목적  ' + result.purpose, 15, false, heightFor(result.purpose, 155)),
    band('조건  ' + result.conditions.pipeline + '  ·  요청 추론 강도 ' + result.conditions.reasoningEffort + '  ·  평가 제한 ' + result.conditions.timeoutSeconds + '초  ·  ' + result.createdAt, 15),
    band('비용 근거와 단위는 제공 결과에 따라 다릅니다. 빈 비용 셀은 산출에 필요한 값이 확인되지 않은 실행입니다.', 15),
    header(['실행', '실행 경로', '요청 모델', '확인 모델', '상태', '입력 토큰', '캐시 생성', '캐시 읽기', '출력 토큰',
      '비용 추정', '단위', '비용 근거', '실행 메모', '보고서 주소', '보고서 ID']),
  ];
  for (const [index, run] of result.runs.entries()) {
    const metadata = [
      run.actualReasoningEffort && '확인 추론 강도 ' + run.actualReasoningEffort,
      run.callCount !== undefined && '평가 호출 ' + run.callCount + '회',
      run.omittedFindingCount !== undefined && '보고서 미표시 지적 ' + run.omittedFindingCount + '건',
    ].filter(Boolean).join('  ·  ');
    const notes = [metadata, ...run.notes].filter(Boolean).join('\n');
    data.push(body([
      run.code, providers[run.evaluator], run.model, run.actualModel ?? null, statuses[run.status],
      formatted(run.usage?.inputTokens, '#,##0'), formatted(run.usage?.cacheCreationInputTokens, '#,##0'),
      formatted(run.usage?.cacheReadInputTokens, '#,##0'), formatted(run.usage?.outputTokens, '#,##0'),
      formatted(run.cost?.amount, '0.000000'), run.cost?.unit,
      run.cost ? (run.cost.basis === 'reported-estimate' ? '보고 추정치' : '단가 환산') + '\n' + run.cost.source : null,
      notes || null, run.reportUrl ?? null, run.reportId ?? null,
    ], index, heightFor(notes, 27, 44)));
  }
  return data;
}

/** Export a model-blind grading workbook. Existing files can contain human scoring and are preserved. */
export async function exportBenchmarkWorkbook(result: BenchmarkResult, path: string): Promise<void> {
  const {data: png, info} = await sharp(result.screenshot.path).rotate().png().toBuffer({resolveWithObject: true});
  const scale = Math.min(1, 284 / info.width, 590 / info.height);
  const {firstScoreRow, lastScoreRow, ...gradingOptions} = grading(result, {
    content: png, contentType: 'image/png', width: info.width * scale, height: info.height * scale,
    dpi: 96, anchor: {row: 3, column: 9}, title: '공통 입력 이미지',
  });
  const bytes = await writeXlsx([
    {
      sheet: '요약', data: summary(result, firstScoreRow, lastScoreRow), showGridLines: false, stickyRowsCount: 4,
      columns: [13, 21, 28, 12, 12, 9, 9, 9, 12, 13, 13, 13, 15, 15].map(width => ({width})),
    },
    gradingOptions,
    {
      sheet: '실행 기록', data: execution(result), showGridLines: false, stickyRowsCount: 7,
      columns: [13, 21, 28, 28, 12, 13, 12, 12, 12, 15, 11, 36, 42, 52, 32].map(width => ({width})),
    },
  ], {fontFamily: 'Arial', fontSize: 11, features: [dataValidation]}).toBuffer();
  await mkdir(dirname(path), {recursive: true});
  const stage = await mkdtemp(join(dirname(path), '.benchmark-xlsx-'));
  try {
    const stagedPath = join(stage, 'workbook.xlsx');
    await writeFile(stagedPath, bytes, {mode: 0o600});
    await link(stagedPath, path);
  } finally {
    await rm(stage, {force: true, recursive: true});
  }
}
