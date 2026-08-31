/**
 * 카드를 손으로 옮길 때 자동으로 달라붙는(스냅) 표준 간격 값.
 * 원래는 트리 전체를 한 번에 재배치하는 "자동 정렬" 기능(computeAutoLayout)이 이 값을 기준으로
 * 세대/형제 좌표를 계산했었는데, 그 기능은 별로였어서 빼고 이 상수만 남겼다 — 카드를 손으로
 * 옮길 때의 "템플릿 간격"/"형제 슬롯" 스냅(TreeRenderer._templateSnapCandidates,
 * _familySnapCandidates)이 지금도 이 값을 그대로 가져다 쓴다.
 */
export const ROW_SPACING = 240;
export const COL_SPACING = 170;
