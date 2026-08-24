import { DragController } from "../view/DragController.js";

/** 사람/관계와 무관하게 캔버스 아무 데나 놓는 자유 텍스트 오브젝트의 DOM. */
export function createTextBoxElement(box) {
  const el = document.createElement("div");
  el.className = "text-box";
  el.dataset.id = box.id;
  el.innerHTML = `
    <div class="text-box-content" spellcheck="false"></div>
    <div class="text-box-resize" title="드래그해서 글자 크기 조절" aria-hidden="true"></div>
  `;
  applyTextBoxData(el, box);
  return el;
}

/** box.text/fontSize/x/y를 DOM에 반영한다. 지금 편집 중인 콘텐츠는 건드리지 않는다(커서 튐 방지). */
export function applyTextBoxData(el, box) {
  el.style.left = `${box.x}px`;
  el.style.top = `${box.y}px`;
  const content = el.querySelector(".text-box-content");
  content.style.fontSize = `${box.fontSize}px`;
  if (document.activeElement !== content) {
    content.textContent = box.text;
  }
}

/**
 * 박스 이동(드래그) + 클릭 시 편집 모드 진입. 사람 카드의 attachCardDrag와 같은 모양(DragController를
 * 그대로 반환 — 호출한 쪽이 텍스트 박스가 지워질 때 destroy()해야 한다).
 * 리사이즈 핸들 위나 지금 편집 중일 땐 이동으로 취급하지 않는다.
 */
export function attachTextBoxDrag(el, { getScale, onDragStart, onMove, onMoveEnd, onClick }) {
  const content = el.querySelector(".text-box-content");
  return new DragController(el, {
    filter: (e) => !e.target.closest(".text-box-resize") && !content.isContentEditable,
    onDragStart: () => onDragStart && onDragStart(),
    onDragMove: (dx, dy, e) => onMove(dx / getScale(), dy / getScale(), e),
    onDragEnd: (e) => onMoveEnd && onMoveEnd(e),
    onClick: () => onClick && onClick(),
  });
}

/** 오른쪽 아래 모서리 핸들로 글자 크기를 조절한다(박스 폭은 em 단위라 글자와 같이 늘어난다). */
export function attachTextBoxResize(el, { getScale, onResize, onResizeEnd }) {
  const handle = el.querySelector(".text-box-resize");
  return new DragController(handle, {
    onDragMove: (dx) => onResize(dx / getScale()),
    onDragEnd: () => onResizeEnd && onResizeEnd(),
  });
}

/**
 * 콘텐츠를 contenteditable로 바꿔 바로 타이핑할 수 있게 한다. blur되면 커밋, Escape면 원래
 * 텍스트로 되돌린다. Enter는 막지 않아 여러 줄(줄바꿈)을 그대로 쓸 수 있다.
 */
export function startTextEdit(el, originalText, onCommit) {
  const content = el.querySelector(".text-box-content");
  if (content.isContentEditable === true) return;
  content.contentEditable = "true";
  el.classList.add("editing");
  content.focus();
  const range = document.createRange();
  range.selectNodeContents(content);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);

  let done = false;
  const finish = (commit) => {
    if (done) return;
    done = true;
    content.contentEditable = "false";
    el.classList.remove("editing");
    if (commit) onCommit(content.textContent);
    else content.textContent = originalText;
  };
  const onKeydown = (e) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    content.removeEventListener("keydown", onKeydown);
    finish(false);
    content.blur();
  };
  content.addEventListener("blur", () => finish(true), { once: true });
  content.addEventListener("keydown", onKeydown);
}
