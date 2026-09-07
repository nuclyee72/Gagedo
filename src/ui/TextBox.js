import { DragController } from "../view/DragController.js";

/** 사람/관계와 무관하게 캔버스 아무 데나 놓는 자유 텍스트 오브젝트의 DOM. */
export function createTextBoxElement(box) {
  const el = document.createElement("div");
  el.className = "text-box";
  el.dataset.id = box.id;
  el.innerHTML = `
    <div class="text-box-content"></div>
    <div class="text-box-resize-tl" title="드래그해서 상자 크기 조절(왼쪽 위 모서리 기준, 오른쪽 아래는 고정)" aria-hidden="true"></div>
    <div class="text-box-resize" title="드래그해서 상자 크기 조절(모서리 위치를 직접 옮기는 느낌)" aria-hidden="true"></div>
  `;
  applyTextBoxData(el, box);
  return el;
}

/** box.text/fontSize/x/y/width/height를 DOM에 반영한다. width/height는 fontSize와 무관하다.
 * (width/height는 이번에 추가된 필드라, 그 전에 저장된 텍스트 박스에는 없을 수 있어 기본값을 둔다.
 * background도 마찬가지로 예전 데이터엔 없을 수 있어 기본값 true — 안 꺼져 있던 걸로 취급.) */
export function applyTextBoxData(el, box) {
  el.style.left = `${box.x}px`;
  el.style.top = `${box.y}px`;
  const content = el.querySelector(".text-box-content");
  content.style.width = `${box.width ?? 200}px`;
  content.style.height = `${box.height ?? 50}px`;
  content.style.fontSize = `${box.fontSize}px`;
  content.textContent = box.text;
  el.classList.toggle("no-bg", box.background === false);
}

/**
 * 박스 이동(드래그) + 클릭 시 편집(사람 카드처럼 오른쪽 사이드바를 여는 건 호출한 쪽의 onClick이
 * 담당). 사람 카드의 attachCardDrag와 같은 모양(DragController를 그대로 반환 — 호출한 쪽이
 * 텍스트 박스가 지워질 때 destroy()해야 한다). 리사이즈 핸들 위는 이동으로 취급하지 않는다.
 */
export function attachTextBoxDrag(el, { getScale, onDragStart, onMove, onMoveEnd, onClick }) {
  return new DragController(el, {
    filter: (e) => !e.target.closest(".text-box-resize") && !e.target.closest(".text-box-resize-tl"),
    onDragStart: () => onDragStart && onDragStart(),
    onDragMove: (dx, dy, e) => onMove(dx / getScale(), dy / getScale(), e),
    onDragEnd: (e) => onMoveEnd && onMoveEnd(e),
    onClick: () => onClick && onClick(),
  });
}

/**
 * 모서리 핸들(오른쪽 아래 기본, corner:"tl"이면 왼쪽 위) — 글자 크기는 그대로 두고 상자의
 * 폭/높이만 바꾼다. 마우스가 움직인 만큼 그대로(배율 없이 1:1) 늘어나서, "모서리를 직접 잡아
 * 옮기는" 느낌이 되게 한다. onDragMove의 dx/dy는 "지난 이동 이후"의 증분(누적값이 아님)이므로,
 * 드래그 시작 시점을 onResizeStart로 알려줘서 호출한 쪽이 직접 누적하게 한다(사람 카드 드래그와
 * 같은 패턴) — 왼쪽 위 핸들은 폭/높이뿐 아니라 x/y(고정된 오른쪽 아래를 기준으로 계산)까지
 * 같이 바뀌므로, 그 계산은 호출한 쪽(TreeRenderer)이 맡는다.
 */
export function attachTextBoxResize(el, { getScale, onResizeStart, onResize, onResizeEnd, corner = "br" }) {
  const handle = el.querySelector(corner === "tl" ? ".text-box-resize-tl" : ".text-box-resize");
  return new DragController(handle, {
    onDragStart: () => onResizeStart && onResizeStart(),
    onDragMove: (dx, dy) => onResize(dx / getScale(), dy / getScale()),
    onDragEnd: () => onResizeEnd && onResizeEnd(),
  });
}
