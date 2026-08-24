import { DragController } from "../view/DragController.js";

const DEFAULT_AVATAR = "assets/default-avatar.svg";

export function createCardElement(person) {
  const el = document.createElement("div");
  el.className = "person-card";
  el.dataset.id = person.id;
  el.innerHTML = `
    <div class="person-photo"><img src="${DEFAULT_AVATAR}" alt="" draggable="false"></div>
    <div class="person-name"></div>
    <div class="person-tags"></div>
  `;
  applyCardData(el, person);
  return el;
}

export function applyCardData(el, person, photoUrl) {
  el.style.left = `${person.x}px`;
  el.style.top = `${person.y}px`;
  el.querySelector(".person-name").textContent = person.name || "이름 없음";
  el.querySelector(".person-photo img").src = photoUrl || DEFAULT_AVATAR;

  const tagsEl = el.querySelector(".person-tags");
  tagsEl.innerHTML = "";
  for (const tag of person.tags || []) {
    const chip = document.createElement("span");
    chip.className = "tag-chip";
    chip.textContent = tag;
    tagsEl.appendChild(chip);
  }
}

/** 카드 드래그(이동) vs 클릭(선택/편집) 판별을 붙인다. */
export function attachCardDrag(el, { getScale, onDragStart, onMove, onMoveEnd, onClick }) {
  return new DragController(el, {
    onDragStart: () => onDragStart && onDragStart(),
    // e(포인터 이벤트)도 같이 넘겨서, 화면에 고정된 휴지통 위에 커서가 있는지 등을
    // 화면 좌표(clientX/Y) 기준으로 판단할 수 있게 한다.
    onDragMove: (dx, dy, e) => onMove(dx / getScale(), dy / getScale(), e),
    onDragEnd: (e) => onMoveEnd && onMoveEnd(e),
    onClick,
  });
}
