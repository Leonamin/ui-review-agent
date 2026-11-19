import type {LayoutSpacingCheck} from './layout-spacing.js';
import type {AutoStyleComparisonReport} from './automatic-style-comparison.js';
import type {StyleSample} from './style-comparison.js';

export const themeLabels = {light:'라이트 모드',dark:'다크 모드'};
export const contrastLabels = {passed:'통과',violation:'위반',incomplete:'추가 확인',inapplicable:'적용 대상 없음'};
export const alignmentLabels = {passed:'통과',violation:'위반',candidate:'불일치 후보',unverified:'미확인'};
export const styleComparisonLabels = {passed:'통과',violation:'승인 기준 위반',candidate:'차이 후보',unverified:'측정하지 못함'};
export const styleComparisonReasons:Record<Extract<StyleSample,{status:'unverified'}>['reason'],string> = {
 missing:'지정한 요소를 찾지 못했습니다.',
 ambiguous:'선택자와 일치하는 요소가 여러 개입니다.',
 'not-visible':'현재 뷰포트에서 지정한 요소가 보이는 위치를 확인하지 못했습니다.',
 'invalid-selector':'CSS 선택자를 읽을 수 없습니다.',
 'different-url':'요청한 화면이 표시되지 않았습니다.',
 'http-error':'페이지가 HTTP 오류를 반환했습니다.',
 unstable:'캡처 전후 화면 또는 측정값이 바뀌었습니다.',
 unavailable:'화면을 열거나 측정하지 못했습니다.',
};
export const styleComparisonSides={reference:'화면 A',comparison:'화면 B'} as const;
export const styleComparisonMatchLabels={label:'같은 이름과 역할', 'unique-role':'양쪽에 하나뿐인 동일 역할'} as const;
const styleRoleLabels = new Map([
 ['searchbox','검색창'],['textbox','텍스트 입력'],['button','버튼'],['link','링크'],
 ['combobox','선택 상자'],['checkbox','체크박스'],['radio','라디오 버튼'],['switch','스위치'],
 ['tab','탭'],['navigation','탐색 영역'],['complementary','사이드바'],
]);
export const styleComparisonRoleLabel=(role:string)=>styleRoleLabels.get(role)??role;
export const styleComparisonElementLabel=(label:string)=>label||'이름 없는 요소';
type UnpairedStyleElement=AutoStyleComparisonReport['unmatched'][number] & {
 reason?:AutoStyleComparisonReport['unmeasured'][number]['reason'];
};
export function automaticStyleCoverageGroups(report:AutoStyleComparisonReport):{label:string;elements:UnpairedStyleElement[]}[]{
 return [
  {label:'대응 요소 없음',elements:report.unmatched},
  {label:'대응 요소가 모호함',elements:report.ambiguous},
  {label:'측정하지 못함',elements:report.unmeasured},
 ];
}
export const formatMeasurement = new Intl.NumberFormat('ko-KR',{maximumFractionDigits:2}).format;

export function themeStatusLabel(status: 'verified' | 'unverified', scope?: 'page' | 'region'): string {
 if(status==='unverified')return '적용 미확인';
 return scope==='region'?'영역 적용 확인':'적용 확인';
}

export function formatViewportBounds({x,y,width,height}:{x:number;y:number;width:number;height:number}):string {
 return `위치 ${formatMeasurement(x)}, ${formatMeasurement(y)} · 크기 ${formatMeasurement(width)} × ${formatMeasurement(height)} CSS px`;
}

const alignmentReasons = new Map([
 ['group-not-visible','현재 캡처에서 지정한 그룹이 보이지 않습니다.'],
 ['unsupported-group-layout','지정한 그룹은 지원하는 flex 행·열 배치가 아닙니다.'],
 ['member-limit-reached','그룹의 컨트롤 수가 측정 한도를 넘었습니다.'],
 ['fewer-than-two-visible-members','비교할 수 있는 컨트롤이 두 개 미만입니다.'],
 ['ambiguous-nested-members','중첩된 컨트롤의 배치 관계를 확인하지 못했습니다.'],
 ['visible-surface-could-not-be-measured','컨트롤의 보이는 외곽을 측정하지 못했습니다.'],
 ['no-layout-line-with-two-visible-members','두 개 이상의 컨트롤이 놓인 줄을 찾지 못했습니다.'],
 ['group-not-found','지정한 그룹을 찾지 못했습니다.'],
 ['group-limit-reached','지정한 그룹 수가 측정 한도를 넘었습니다.'],
 ['group-query-or-measurement-failed','지정한 그룹의 선택자나 외곽을 확인하지 못했습니다.'],
]);

export const alignmentReasonLabel = (reason:string) => alignmentReasons.get(reason)??reason;

const edgeLabels = {top:'위쪽',right:'오른쪽',bottom:'아래쪽',left:'왼쪽'};

export function spacingCheckLabel(check:LayoutSpacingCheck):string {
 if(check.kind==='control-gap')return `버튼 사이 ${check.axis==='row'?'가로':'세로'} 간격`;
 return `카드 ${edgeLabels[check.edge]} 안쪽 여백`;
}

export function spacingCheckMeasurement({observed,threshold}:LayoutSpacingCheck):string {
 return `측정 ${formatMeasurement(observed)} CSS px · 감지 기준 ${formatMeasurement(threshold)} CSS px 미만`;
}
