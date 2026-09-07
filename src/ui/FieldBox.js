import { DragController } from "../view/DragController.js";

const SVG_NS = "http://www.w3.org/2000/svg";

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
    <svg class="field-rel-lines" aria-hidden="true"></svg>
    <div class="field-resize-tl" title="드래그해서 필드 크기 조절(왼쪽 위 모서리 기준, 오른쪽 아래는 고정)" aria-hidden="true"></div>
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
  // 템플릿 관계 안내선용 SVG도 .field-content와 정확히 같은 크기·원점(필드 왼쪽 위 모서리
  // 기준)으로 맞춰서, 슬롯의 relX/relY 좌표를 그대로 SVG 좌표로 써도 겹치게 한다.
  const relLines = el.querySelector(".field-rel-lines");
  relLines.setAttribute("width", field.width);
  relLines.setAttribute("height", field.height);
  el.classList.toggle("template-editing", !!field.templateMode);
}

/**
 * 필드 이동(드래그) + 클릭. 텍스트박스의 attachTextBoxDrag와 같은 모양이지만, 리사이즈 손잡이뿐
 * 아니라 템플릿 슬롯(.field-slot) 위 클릭도 필드 자신의 드래그/클릭 대상에서 뺀다 — 슬롯은
 * TreeRenderer._addField가 별도 네이티브 클릭 리스너로 추가/삭제를 처리한다.
 */
export function attachFieldDrag(el, { getScale, onDragStart, onMove, onMoveEnd, onClick }) {
  return new DragController(el, {
    filter: (e) =>
      !e.target.closest(".field-resize") && !e.target.closest(".field-resize-tl") &&
      !e.target.closest(".field-slot") && !e.target.closest(".field-rel-line"),
    onDragStart: () => onDragStart && onDragStart(),
    onDragMove: (dx, dy, e) => onMove(dx / getScale(), dy / getScale(), e),
    onDragEnd: (e) => onMoveEnd && onMoveEnd(e),
    onClick: (e) => onClick && onClick(e),
  });
}

/** 모서리 손잡이(오른쪽 아래 기본, corner:"tl"이면 왼쪽 위) — 텍스트박스와 같은 1:1 리사이즈
 * (배율/스냅 없음, 최소 크기만 clamp). 왼쪽 위 손잡이는 폭/높이뿐 아니라 x/y(고정된 오른쪽
 * 아래를 기준으로 계산)까지 같이 바뀌므로, 그 계산은 호출한 쪽(TreeRenderer)이 맡는다. */
export function attachFieldResize(el, { getScale, onResizeStart, onResize, onResizeEnd, corner = "br" }) {
  const handle = el.querySelector(corner === "tl" ? ".field-resize-tl" : ".field-resize");
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

/**
 * 템플릿 슬롯끼리 그어둔 "관계" 안내선 하나(.field-rel-lines 안에 들어감). 실제 인물 관계선
 * (RelationshipLine.js)처럼 화살촉·라벨까지 갖추지는 않는 단순한 점선 스캐폴드다 — 양쪽 슬롯이
 * 실제 인물로 다 채워지면(materializedRelIds가 생기면) 진짜 관계선(#lines-layer)이 그 자리를
 * 대신 보여주므로 이 안내선은 숨긴다(applyTemplateRelLineData가 처리).
 * 보이는 얇은 선(.field-rel-line-visible) + 클릭하기 쉬운 두꺼운 투명 선(.field-rel-line-hit)
 * 두 겹으로 그린다(실제 관계선의 hit/visible 분리와 같은 이유).
 */
export function createTemplateRelLineElement(tr) {
  const g = document.createElementNS(SVG_NS, "g");
  g.classList.add("field-rel-line");
  g.dataset.trId = tr.id;
  const hit = document.createElementNS(SVG_NS, "polyline");
  hit.classList.add("field-rel-line-hit");
  const visible = document.createElementNS(SVG_NS, "polyline");
  visible.classList.add("field-rel-line-visible");
  g.append(hit, visible);
  return g;
}

/** points: [{x,y}, ...] (필드 기준 상대좌표 — 슬롯 relX/relY 또는 그 슬롯을 채운 인물의
 * 필드-상대 위치). materialized면 실제 관계선이 대신 보여주므로 이 안내선은 숨긴다. */
export function applyTemplateRelLineData(g, points, materialized) {
  g.style.display = materialized ? "none" : "";
  if (materialized) return;
  const pointStr = points.map((p) => `${p.x},${p.y}`).join(" ");
  for (const el of g.querySelectorAll("polyline")) el.setAttribute("points", pointStr);
}
