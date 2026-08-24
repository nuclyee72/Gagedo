import { DragController } from "../view/DragController.js";

/** 사람/관계와 무관하게 캔버스 아무 데나 놓는 자유 텍스트 오브젝트의 DOM. */
export function createTextBoxElement(box) {
  const el = document.createElement("div");
  el.className = "text-box";
  el.dataset.id = box.id;
  el.innerHTML = `
    <div class="text-box-content"></div>
    <div class="text-box-resize" title="드래그해서 글자 크기 조절" aria-hidden="true"></div>
  `;
  applyTextBoxData(el, box);
  return el;
}

/** box.text/fontSize/x/y를 DOM에 반영한다. */
export function applyTextBoxData(el, box) {
  el.style.left = `${box.x}px`;
  el.style.top = `${box.y}px`;
  const content = el.querySelector(".text-box-content");
  content.style.fontSize = `${box.fontSize}px`;
  content.textContent = box.text;
}

/**
 * 박스 이동(드래그) + 클릭 시 편집(사람 카드처럼 오른쪽 사이드바를 여는 건 호출한 쪽의 onClick이
 * 담당). 사람 카드의 attachCardDrag와 같은 모양(DragController를 그대로 반환 — 호출한 쪽이
 * 텍스트 박스가 지워질 때 destroy()해야 한다). 리사이즈 핸들 위는 이동으로 취급하지 않는다.
 */
export function attachTextBoxDrag(el, { getScale, onDragStart, onMove, onMoveEnd, onClick }) {
  return new DragController(el, {
    filter: (e) => !e.target.closest(".text-box-resize"),
    onDragStart: () => onDragStart && onDragStart(),
    onDragMove: (dx, dy, e) => onMove(dx / getScale(), dy / getScale(), e),
    onDragEnd: (e) => onMoveEnd && onMoveEnd(e),
    onClick: () => onClick && onClick(),
  });
}

/**
 * 오른쪽 아래 모서리 핸들로 글자 크기를 조절한다(박스 폭은 em 단위라 글자와 같이 늘어난다).
 * onDragMove의 dx는 "지난 이동 이후"의 증분(누적값이 아님)이므로, 드래그 시작 시점을
 * onResizeStart로 알려줘서 호출한 쪽이 직접 누적하게 한다(사람 카드 드래그와 같은 패턴).
 */
export function attachTextBoxResize(el, { getScale, onResizeStart, onResize, onResizeEnd }) {
  const handle = el.querySelector(".text-box-resize");
  return new DragController(handle, {
    onDragStart: () => onResizeStart && onResizeStart(),
    onDragMove: (dx) => onResize(dx / getScale()),
    onDragEnd: () => onResizeEnd && onResizeEnd(),
  });
}
