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

  // 테두리 색/굵기 커스텀 — border 대신 outline(개별 longhand)을 쓴다: outline은 이 엘리먼트의
  // overflow:hidden에 안 잘리고, outline-offset을 굵기의 절반만큼 음수로 주면 원래 원 둘레를
  // 중심으로 안쪽·바깥쪽 절반씩 대칭으로 걸쳐서 "안팎 모두 커지는" 느낌이 된다(테두리가 두꺼워질
  // 때 사진 쪽으로만 파고드는 border-box 방식과 다름). 굵기가 바뀔 때마다 -offset도 함께
  // 다시 계산해야 항상 중앙 정렬이 유지된다. 값이 없으면(null) 빈 문자열로 인라인 스타일을 지워
  // style.css의 기본값(테마 색 3px, offset -1.5px)으로 되돌아가게 한다.
  const photo = el.querySelector(".person-photo");
  photo.style.outlineColor = person.borderColor || "";
  if (person.borderWidth) {
    photo.style.outlineWidth = `${person.borderWidth}px`;
    photo.style.outlineOffset = `${-person.borderWidth / 2}px`;
  } else {
    photo.style.outlineWidth = "";
    photo.style.outlineOffset = "";
  }

  // 사진 모양(원/네모/둥근 네모) — .shape-*는 style.css에 정의되어 있고, 사이드바의 모양 미리보기
  // 아이콘(.p-shape-preview)도 같은 클래스를 재사용한다. shape-diamond는 더 이상 선택지가 아니지만
  // (스타일도 삭제됨) 예전에 그 모양으로 저장된 데이터를 불러왔을 때 남은 클래스를 정리하기 위해
  // remove 목록엔 그대로 둔다.
  photo.classList.remove("shape-circle", "shape-square", "shape-rounded", "shape-diamond");
  photo.classList.add(`shape-${person.photoShape || "circle"}`);

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
