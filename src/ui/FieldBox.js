import { DragController } from "../view/DragController.js";

/**
 * "필드" — 인물/텍스트박스를 하나로 묶어서 옮기는 완전히 빈 컨테이너 + 템플릿 자리(점선).
 * 생김새는 텍스트박스와 같은 둥근 사각형 카드(TextBox.js와 같은 패턴)지만 텍스트는 없다.
 */
export function createFieldElement(field) {
  const el = document.createElement("div");
  el.className = "field-box";
  el.dataset.id = field.id;
  el.innerHTML = `
    <div class="field-content"></div>
    <div class="field-resize" title="드래그해서 필드 크기 조절" aria-hidden="true"></div>
  `;
  applyFieldData(el, field);
  return el;
}

/** field.x/y/width/height/templateMode를 DOM에 반영한다(슬롯 자체는 TreeRenderer가 별도로 동기화). */
export function applyFieldData(el, field) {
  el.style.left = `${field.x}px`;
  el.style.top = `${field.y}px`;
  const content = el.querySelector(".field-content");
  content.style.width = `${field.width}px`;
  content.style.height = `${field.height}px`;
  el.classList.toggle("template-editing", !!field.templateMode);
}

/**
 * 필드 이동(드래그) + 클릭. 텍스트박스의 attachTextBoxDrag와 같은 모양이지만, 리사이즈 손잡이뿐
 * 아니라 템플릿 슬롯(.field-slot) 위 클릭도 필드 자신의 드래그/클릭 대상에서 뺀다 — 슬롯은
 * TreeRenderer._addField가 별도 네이티브 클릭 리스너로 추가/삭제를 처리한다.
 */
export function attachFieldDrag(el, { getScale, onDragStart, onMove, onMoveEnd, onClick }) {
  return new DragController(el, {
    filter: (e) => !e.target.closest(".field-resize") && !e.target.closest(".field-slot"),
    onDragStart: () => onDragStart && onDragStart(),
    onDragMove: (dx, dy, e) => onMove(dx / getScale(), dy / getScale(), e),
    onDragEnd: (e) => onMoveEnd && onMoveEnd(e),
    onClick: (e) => onClick && onClick(e),
  });
}

/** 오른쪽 아래 모서리 손잡이 — 텍스트박스와 같은 1:1 리사이즈(배율/스냅 없음, 최소 크기만 clamp). */
export function attachFieldResize(el, { getScale, onResizeStart, onResize, onResizeEnd }) {
  const handle = el.querySelector(".field-resize");
  return new DragController(handle, {
    onDragStart: () => onResizeStart && onResizeStart(),
    onDragMove: (dx, dy) => onResize(dx / getScale(), dy / getScale()),
    onDragEnd: () => onResizeEnd && onResizeEnd(),
  });
}

/** 템플릿 슬롯(점선 자리) DOM 하나. relX/relY는 필드 왼쪽 위 모서리 기준 상대좌표이자 슬롯의
 * "중심"(인물 카드의 x/y가 사진 원 중심인 것과 맞춰서, 실제 인물이 꽂혔을 때 정확히 겹치게). */
export function createSlotElement(slot) {
  const el = document.createElement("div");
  el.className = "field-slot";
  el.dataset.slotId = slot.id;
  applySlotPosition(el, slot);
  return el;
}

export function applySlotPosition(el, slot) {
  el.style.left = `${slot.relX}px`;
  el.style.top = `${slot.relY}px`;
}

/** 슬롯 자체의 드래그(템플릿 수정 중 위치 재조정)와 클릭(템플릿 수정 중엔 삭제, 아니면 필드
 * 사이드바 열기)을 하나의 DragController로 구분해서 넘겨준다 — 실제로 지금 그 동작을 허용할지
 * (예: 템플릿 수정이 꺼져 있으면 드래그 무시)는 호출부(TreeRenderer)가 field.templateMode를
 * 보고 콜백 안에서 판단한다. */
export function attachSlotDrag(el, { getScale, onDragStart, onDragMove, onDragEnd, onClick }) {
  return new DragController(el, {
    onDragStart: () => onDragStart && onDragStart(),
    onDragMove: (dx, dy) => onDragMove(dx / getScale(), dy / getScale()),
    onDragEnd: () => onDragEnd && onDragEnd(),
    onClick: (e) => onClick && onClick(e),
  });
}
