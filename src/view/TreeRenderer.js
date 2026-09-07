import { createCardElement, applyCardData, attachCardDrag } from "../ui/PersonCard.js";
import { createLineElement, applyLineStyle, updateLinePosition, TYPE_LABEL } from "../ui/RelationshipLine.js";
import { createTextBoxElement, applyTextBoxData, attachTextBoxDrag, attachTextBoxResize } from "../ui/TextBox.js";
import {
  createFieldElement, applyFieldData, attachFieldDrag, attachFieldResize, createSlotElement,
  applySlotPosition, attachSlotDrag, createTemplateRelLineElement, applyTemplateRelLineData,
} from "../ui/FieldBox.js";
import { ROW_SPACING, COL_SPACING } from "../core/AutoLayout.js";
import { uuid } from "../utils/uuid.js";

const SVG_NS = "http://www.w3.org/2000/svg";

// 드래그 중인 카드가 다른 카드/템플릿 칸에 "달라붙는" 스냅(클리핑) 판정 거리 — 화면 픽셀 기준
// (camera.scale로 나눠 월드 좌표로 환산해서 씀). 예전엔 8이라 너무 빡빡해서(살짝만 어긋나도 안
// 붙음) 잘 안 달라붙는다는 피드백이 있어 키웠다.
const SNAP_THRESHOLD_PX = 14;

// 관계선 굵기를 "화면 픽셀 기준"으로 일정하게 유지하기 위한 목표값들.
// #stage의 CSS transform(scale)이 SVG(#lines-layer) 전체를 사진처럼 통째로 확대/축소하므로,
// stroke-width(월드 좌표계 값)도 그 배율만큼 같이 줄어든다 — 많이 축소하면 실제 렌더링 폭이
// 1 화면 픽셀보다 작아지는데, 브라우저는 그렇게 가늘게는 못 그리고 최소 폭 근처로 "올림"해서
// 그려버린다. 그 결과 카드는 계속 작아지는데 선만 상대적으로 안 가늘어져 오히려 굵어 보이는
// 문제가 있었다(특히 여러 선이 가까이 몰려 있으면 더 두드러짐). SVG의 vector-effect:
// non-scaling-stroke는 SVG 내부(viewBox 등) transform만 상쇄하고 이런 CSS transform까지는
// 상쇄하지 못해서(직접 확인함) 쓸모가 없었다 — 그래서 배율이 바뀔 때마다 "목표 화면 폭 ÷ 배율"을
// 직접 계산해 stroke-width에 넣어준다(카드가 작아지는 만큼 선도 똑같이, 끝까지 가늘어짐).
const LINE_TARGET_SCREEN_PX = 1.5;
const LINE_SELECTED_TARGET_SCREEN_PX = 3;
const LINE_HIT_TARGET_SCREEN_PX = 16; // 보이지 않는 클릭 판정 폭도 화면 기준으로 일정하게

/** TreeModel의 변화를 구독해 사람 카드(DOM)와 관계선(SVG)을 동기화한다. */
export class TreeRenderer {
  constructor({
    tree, worldEl, linesEl, fieldsEl, camera, store, onCardClick, onLineClick, onTextBoxClick,
    onFieldClick, onSlotClick, onTemplateSlotClick, onTemplateRelationshipClick, trashEl,
  }) {
    this.tree = tree;
    this.worldEl = worldEl;
    this.linesEl = linesEl;
    this.fieldsEl = fieldsEl;
    this.camera = camera;
    this.store = store;
    this.onCardClick = onCardClick;
    this.onLineClick = onLineClick;
    this.onTextBoxClick = onTextBoxClick;
    this.onFieldClick = onFieldClick;
    // "&관계" 연결 모드 중 슬롯 클릭을 가로챌지 여부 — main.js가 판단해 true(처리함)/false(평소
    // 대로 사이드바 열기)를 돌려준다.
    this.onSlotClick = onSlotClick;
    // 템플릿 슬롯/템플릿 관계(안내선)를 클릭했을 때 그 전용 사이드바를 열어달라는 요청 — 예전엔
    // 클릭하면 곧바로 삭제 확인창이 떴는데, 다른 오브젝트처럼 사이드바를 통해서만 지우게 한다.
    this.onTemplateSlotClick = onTemplateSlotClick;
    this.onTemplateRelationshipClick = onTemplateRelationshipClick;
    this.trashEl = trashEl;

    this.cardEls = new Map();
    this.cardDrags = new Map(); // personId -> DragController (카드 삭제 시 destroy()로 정리해야 함)
    this.lineEls = new Map();
    this.photoUrls = new Map(); // photoId -> objectURL 캐시

    this.textBoxEls = new Map();
    this.textBoxDrags = new Map(); // textBoxId -> { moveDrag, resizeDrag } (둘 다 destroy() 필요)

    this.fieldEls = new Map();
    this.fieldDrags = new Map(); // fieldId -> { moveDrag, resizeDrag }
    this.slotDrags = new Map(); // slotId -> DragController (템플릿 자리 하나하나의 드래그/클릭)
    this._fieldDragState = null; // 필드 자신의 드래그(그 위 오브젝트를 기하학적으로 쓸어담아 함께 이동) 중일 때만 값이 있음

    // 마키(배경 Shift+드래그)로 한 번에 여러 개를 고른 상태 — 사이드바를 여는 단일 선택과는 별개다.
    this.multiSelected = { people: new Set(), textBoxes: new Set(), fields: new Set() };
    this._groupDragState = null; // 여럿을 한꺼번에 옮기는 중일 때만 값이 있음(begin~/update~/commit~GroupDrag)

    this._editingRelId = null; // 지금 텍스트를 편집 중인 관계선 id(한 번에 하나만)

    // "화살표" 관계선의 화살촉을 카드 중심이 아니라 사진 원 가장자리에 그리기 위한 반지름.
    // 다른 관계선은 중심까지 그어도 카드가 그 위에 덮여서 자연히 안 보이지만, 화살촉은 카드
    // 밖으로 튀어나와야 보이므로 이 값만큼 끝점을 당긴다. --photo-size(style.css)와 항상
    // 같은 값이어야 하므로 하드코딩하지 않고 실제 CSS 변수 계산값에서 읽는다.
    const photoSizePx = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--photo-size"));
    this._photoRadius = (Number.isFinite(photoSizePx) ? photoSizePx : 96) / 2;

    tree.onChange((type, payload) => this._handle(type, payload));
    linesEl.addEventListener("click", (e) => {
      // 텍스트가 비어 있는(기본 라벨을 없앤) 관계선도 그 자리를 클릭해 라벨을 넣을 수 있도록,
      // 보이는 텍스트뿐 아니라 보이지 않는 라벨 클릭 영역(.rel-line-label-hit)도 함께 확인한다.
      const labelEl = e.target.closest(".rel-line-label, .rel-line-label-hit");
      if (labelEl) {
        const g = labelEl.closest(".rel-line");
        if (g) {
          // 라벨을 클릭해도(선 자체를 클릭했을 때와 마찬가지로) 사이드바가 함께 열리게 해서,
          // 어디를 클릭하든 일관되게 편집 패널로 이어지게 한다. 그 자리 즉석 편집(_startLabelEdit)은
          // 보너스 단축 경로로 그대로 남겨둔다 — 값이 tree.relationships를 통해 사이드바와 항상 같이 맞는다.
          this.onLineClick(g.dataset.id);
          this._startLabelEdit(g.dataset.id);
        }
        return;
      }
      const g = e.target.closest(".rel-line");
      if (g) this.onLineClick(g.dataset.id);
    });
  }

  /** 관계선의 라벨(부모-자식/배우자 등 텍스트)을 클릭하면 그 자리에서 직접 고쳐 쓸 수 있게 한다. */
  _startLabelEdit(relId) {
    if (this._editingRelId === relId) return; // 이미 이 라벨을 편집 중
    const rel = this.tree.relationships.get(relId);
    const g = this.lineEls.get(relId);
    if (!rel || !g) return;
    const textEl = g.querySelector(".rel-line-label");
    // 실제 렌더링된 텍스트의 bbox를 기준으로 잡아야, 가로/세로 라벨(정렬 기준이 서로 다름)
    // 모두에서 입력창이 원래 텍스트 위치에 정확히 겹친다.
    const bbox = textEl.getBBox();
    const FO_W = Math.max(70, bbox.width + 24);
    const FO_H = Math.max(20, bbox.height + 8);
    const cx = bbox.x + bbox.width / 2;
    const cy = bbox.y + bbox.height / 2;
    const fo = document.createElementNS(SVG_NS, "foreignObject");
    fo.setAttribute("class", "rel-line-label-edit");
    fo.setAttribute("x", cx - FO_W / 2);
    fo.setAttribute("y", cy - FO_H / 2);
    fo.setAttribute("width", FO_W);
    fo.setAttribute("height", FO_H);

    const input = document.createElement("input");
    input.type = "text";
    input.value = rel.label || TYPE_LABEL[rel.type] || "";
    input.addEventListener("click", (e) => e.stopPropagation());
    input.addEventListener("pointerdown", (e) => e.stopPropagation());
    fo.appendChild(input);

    textEl.style.visibility = "hidden";
    g.appendChild(fo);
    this._editingRelId = relId;

    let done = false;
    const cleanup = () => {
      fo.remove();
      textEl.style.visibility = "";
      if (this._editingRelId === relId) this._editingRelId = null;
    };
    const commit = () => {
      if (done) return;
      done = true;
      this.tree.updateRelationship(relId, { label: input.value.trim() });
      cleanup();
    };
    const cancel = () => {
      if (done) return;
      done = true;
      cleanup();
    };

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        input.blur();
      } else if (e.key === "Escape") {
        e.preventDefault();
        cancel();
      }
    });
    input.addEventListener("blur", commit);

    input.focus();
    input.select();
  }

  /**
   * 전체 다시 그리기. 여러 곳(초기 로드/가져오기/실행취소)에서 거의 동시에 호출될 수 있으므로
   * 겹쳐 실행되지 않도록 직렬화한다 — 겹치면 worldEl을 두 번 비우는 사이에 카드가 중복 append된다.
   */
  async renderAll() {
    this._renderChain = (this._renderChain || Promise.resolve()).then(() => this._doRenderAll());
    return this._renderChain;
  }

  async _doRenderAll() {
    for (const drag of this.cardDrags.values()) drag.destroy();
    for (const drags of this.textBoxDrags.values()) { drags.moveDrag.destroy(); drags.resizeDrag.destroy(); drags.resizeDragTL.destroy(); }
    for (const drags of this.fieldDrags.values()) { drags.moveDrag.destroy(); drags.resizeDrag.destroy(); drags.resizeDragTL.destroy(); }
    for (const drag of this.slotDrags.values()) drag.destroy();
    this.worldEl.innerHTML = "";
    this.linesEl.innerHTML = "";
    this.fieldsEl.innerHTML = "";
    this.cardEls.clear();
    this.cardDrags.clear();
    this.lineEls.clear();
    this.textBoxEls.clear();
    this.textBoxDrags.clear();
    this.fieldEls.clear();
    this.fieldDrags.clear();
    this.slotDrags.clear();
    // linesEl을 통째로 비웠으니, 스냅 가이드 엘리먼트도 DOM에서 떨어져 나갔다 — 참조를 들고 있으면
    // 다음 번엔 그 죽은 엘리먼트에다 속성만 바꾸고 화면엔 안 나타나는 버그가 생기므로 같이 지운다.
    this._snapGuideH = null;
    this._snapGuideV = null;
    this._extraGuideEls = null;
    // 전체 다시 그리기 후에는 옛 id를 들고 있던 마키 다중 선택도 더 이상 유효하지 않다(가져오기/
    // 실행취소로 아예 다른 트리가 들어올 수도 있음) — 내부 상태는 여기서 정리하고, main.js가 화면의
    // 벌크 툴바(#bulk-toolbar) 자체를 숨기는 건 각 호출부(doImport 등)에서 따로 처리한다.
    this.multiSelected.people.clear();
    this.multiSelected.textBoxes.clear();
    this.multiSelected.fields.clear();
    this._groupDragState = null;
    // 필드는 "그 위에 인물이 올라가는" 배경 컨테이너라 가장 먼저 그린다(다른 레이어 순서와는
    // 무관 — #fields-layer 자체가 DOM에서 #lines-layer/#world보다 먼저 오므로 항상 맨 아래).
    for (const field of this.tree.fields.values()) this._addField(field);
    for (const person of this.tree.people.values()) await this._addCard(person);
    for (const rel of this.tree.relationships.values()) this._addLine(rel);
    // 텍스트 박스는 사람 카드 위에 겹쳐 놓고 쓰는 경우가 많아, 항상 그 위(DOM 뒤쪽 = 위 레이어)에 오게 마지막에 그린다.
    for (const box of this.tree.textBoxes.values()) this._addTextBox(box);
  }

  setSelected(id) {
    for (const [pid, el] of this.cardEls) el.classList.toggle("selected", pid === id);
  }

  /** 관계 연결 모드처럼 한 번에 여러 명(부모1/부모2/자식 등)을 순서대로 고르는 동안 다중 강조할 때 쓴다. */
  setSelectedMany(ids) {
    const set = new Set(ids);
    for (const [pid, el] of this.cardEls) el.classList.toggle("selected", set.has(pid));
  }

  /** setSelectedMany의 슬롯 버전 — "&관계" 연결 모드로 템플릿 슬롯끼리 순서대로 고르는 동안
   * 지금까지 고른 슬롯들을 강조한다(fieldId로 다른 필드 슬롯과 안 헷갈리게 한정). */
  setSelectedSlots(fieldId, slotIds) {
    const set = new Set(slotIds);
    for (const [fid, el] of this.fieldEls) {
      for (const slotEl of el.querySelectorAll(".field-slot")) {
        slotEl.classList.toggle("picked", fid === fieldId && set.has(slotEl.dataset.slotId));
      }
    }
  }

  /** 사람 카드의 setSelected와 같은 역할 — 텍스트 박스 쪽 선택 강조(사이드바가 열려 있는 대상). */
  setSelectedTextBox(id) {
    for (const [bid, el] of this.textBoxEls) el.classList.toggle("selected", bid === id);
  }

  /** 사람 카드의 setSelected와 같은 역할 — 필드 쪽 선택 강조(사이드바가 열려 있는 대상). */
  setSelectedField(id) {
    for (const [fid, el] of this.fieldEls) el.classList.toggle("selected", fid === id);
  }

  /** 사람 카드의 setSelected와 같은 역할 — 관계선 쪽 선택 강조(사이드바가 열려 있는 대상). */
  setSelectedLine(id) {
    for (const [rid, el] of this.lineEls) {
      el.classList.toggle("selected", rid === id);
      this._applyLineScale(el); // 선택 여부에 따라 목표 굵기(2px/3.5px)가 달라지므로 다시 계산
    }
  }

  /** 배경을 Shift+드래그해서 만든 마키 사각형 안에 들어온 인물/텍스트박스를 한꺼번에 선택 상태로
   * 만든다 — 사이드바(단일 선택)와는 별개라, 이게 켜져 있으면 사이드바는 닫혀 있고 대신 상단
   * 벌크 툴바가 뜬다(main.js가 관리). */
  setMultiSelection({ people = [], textBoxes = [], fields = [] } = {}) {
    this.multiSelected.people = new Set(people);
    this.multiSelected.textBoxes = new Set(textBoxes);
    this.multiSelected.fields = new Set(fields);
    for (const [pid, el] of this.cardEls) el.classList.toggle("selected", this.multiSelected.people.has(pid));
    for (const [bid, el] of this.textBoxEls) el.classList.toggle("selected", this.multiSelected.textBoxes.has(bid));
    for (const [fid, el] of this.fieldEls) el.classList.toggle("selected", this.multiSelected.fields.has(fid));
  }

  clearMultiSelection() {
    if (!this.multiSelected.people.size && !this.multiSelected.textBoxes.size && !this.multiSelected.fields.size) return;
    for (const pid of this.multiSelected.people) this.cardEls.get(pid)?.classList.remove("selected");
    for (const bid of this.multiSelected.textBoxes) this.textBoxEls.get(bid)?.classList.remove("selected");
    for (const fid of this.multiSelected.fields) this.fieldEls.get(fid)?.classList.remove("selected");
    this.multiSelected.people.clear();
    this.multiSelected.textBoxes.clear();
    this.multiSelected.fields.clear();
  }

  getMultiSelectionCount() {
    return this.multiSelected.people.size + this.multiSelected.textBoxes.size + this.multiSelected.fields.size;
  }

  /** 지금 마키로 골라둔 대상들(잠긴 것도 포함) 전체를 한 번에 잠그거나 푼다. 필드는 person.locked/
   * box.locked와 뜻이 정확히 대응하는 selfLocked(필드 "자신"의 위치 잠금)를 쓴다 — field.locked
   * (내용물 잠금)는 사이드바의 "포함된 인물 잠금" 전용 토글로만 다룬다. */
  setLockedForSelection(locked) {
    for (const id of this.multiSelected.people) this.tree.updatePerson(id, { locked });
    for (const id of this.multiSelected.textBoxes) this.tree.updateTextBox(id, { locked });
    for (const id of this.multiSelected.fields) this.tree.updateField(id, { selfLocked: locked });
  }

  /** 지금 마키로 골라둔 대상 중 잠기지 않은 것이 하나라도 있으면 false(= "아직 안 잠김" 상태로
   * 취급) — 벌크 잠금 버튼이 "전부 잠그기"와 "전부 풀기" 중 뭘 다음에 할지 정할 때 쓴다. */
  isSelectionFullyLocked() {
    for (const id of this.multiSelected.people) {
      if (!this.tree.people.get(id)?.locked) return false;
    }
    for (const id of this.multiSelected.textBoxes) {
      if (!this.tree.textBoxes.get(id)?.locked) return false;
    }
    for (const id of this.multiSelected.fields) {
      if (!this.tree.fields.get(id)?.selfLocked) return false;
    }
    return this.getMultiSelectionCount() > 0;
  }

  /** 마키 선택 인원이 2명 이상일 때, 그중 하나를 드래그하면 전체가 같은 만큼 같이 움직인다 —
   * 잠긴 대상은 처음 좌표를 기록 대상에서 빼서 그것만 안 움직이게 한다(선택 자체는 유지).
   * anchorId/anchorType: 실제로 손으로 잡아 끄는 대상 — 그룹 전체는 서로 상대 위치를 유지한 채
   * 통째로 움직이되, 스냅(자동 클리핑)은 이 anchor 하나만 기준으로 검사해서 그 결과(스냅으로
   * 보정된 만큼)를 그룹 전체에 동일하게 더해준다("이 카드를 스냅에 맞추면 나머지도 딱 붙어 따라
   * 온다"는 느낌). anchor가 사람이면 _computeSnap을, 텍스트박스면 _computeTextBoxSnap을 쓴다
   * (둘 다 같은 {x,y,guideX,guideY,extraGuides} 모양을 돌려주므로 아래 로직이 공통으로 처리). */
  _beginGroupDrag(anchorId, anchorType) {
    const positions = new Map(); // id -> { x, y, type }
    const lockedEls = []; // 선택은 됐지만 잠겨 있어 이번 드래그에선 안 움직이는 것들의 DOM
    for (const id of this.multiSelected.people) {
      const p = this.tree.people.get(id);
      if (!p) continue;
      if (p.locked) lockedEls.push(this.cardEls.get(id));
      else positions.set(id, { x: p.x, y: p.y, type: "person" });
    }
    for (const id of this.multiSelected.textBoxes) {
      const b = this.tree.textBoxes.get(id);
      if (!b) continue;
      if (b.locked) lockedEls.push(this.textBoxEls.get(id));
      else positions.set(id, { x: b.x, y: b.y, type: "textbox" });
    }
    for (const id of this.multiSelected.fields) {
      const f = this.tree.fields.get(id);
      if (!f) continue;
      // 마키로 여럿과 함께 골라 그룹으로 끌 때는(필드 혼자 끌 때의 전용 _beginFieldDrag와 달리)
      // 필드 위 오브젝트를 기하학적으로 쓸어담지 않는다 — 그건 별도로 같이 선택되어 있어야 한다.
      // field.locked(내용물 잠금)는 person.locked/box.locked와 다른 개념(그 필드 "위 오브젝트"의
      // 개별 드래그만 막는 것)이라 이걸로는 안 걸러진다 — 대신 person.locked와 정확히 대응하는
      // field.selfLocked(필드 "자신"의 위치 잠금)로 걸러낸다.
      if (f.selfLocked) lockedEls.push(this.fieldEls.get(id));
      else positions.set(id, { x: f.x, y: f.y, type: "field" });
    }
    // 잠겨서 이번엔 안 움직이는 대상은 드래그가 진행되는 동안만 흐리게 + 자물쇠 표시를 띄워서
    // "왜 이것만 안 따라오지?"를 바로 알 수 있게 한다 — 드래그가 끝나면 원래대로 되돌린다.
    for (const el of lockedEls) el?.classList.add("drag-locked-preview");

    // 그룹이 움직이는 동안 다시 그려야 할 관계선을 미리 한 번만 합집합으로 구해 캐싱해둔다 —
    // 예전엔 프레임마다 "멤버 하나당 관계 전체 훑기"를 멤버 수만큼 반복해서(_updateLinesFor를
    // 멤버마다 호출), 사람이 많이 선택된 채로 한 덩어리로 끌면 멤버 수 × 관계 수에 비례해
    // 버벅였다 — 멤버 구성 자체는 드래그 도중 안 바뀌므로 여기서 한 번만 구해두고, 매 프레임엔
    // 이 캐시만 다시 그린다(_scheduleGroupVisualUpdate).
    const affectedLineIds = new Set();
    for (const id of positions.keys()) {
      for (const relId of this._affectedLineIds(id)) affectedLineIds.add(relId);
    }
    // 그룹 멤버 전원의 id — anchor 스냅 계산에서 "나와 같이 끌려가는 멤버"를 후보에서 빼는 데 쓴다.
    const memberIds = new Set(positions.keys());
    this._groupDragState = { positions, dx: 0, dy: 0, anchorId, anchorType, lockedEls, affectedLineIds, memberIds };
  }

  _updateGroupDrag(dxWorld, dyWorld) {
    const g = this._groupDragState;
    if (!g) return;
    g.dx += dxWorld;
    g.dy += dyWorld;

    // anchor(실제로 끈 카드) 하나만 스냅을 검사하고, 그 보정값(snapDx/Dy)을 그룹 전체에 똑같이
    // 더한다 — 각자 따로 스냅하면 서로 다른 지점에 끌려가 그룹 모양이 흐트러지므로.
    let snapDx = 0, snapDy = 0;
    let snapped = null;
    const anchorStart = g.positions.get(g.anchorId);
    if (g.anchorType === "person" && anchorStart) {
      const anchorPerson = this.tree.people.get(g.anchorId);
      if (anchorPerson) {
        const rawX = anchorStart.x + g.dx;
        const rawY = anchorStart.y + g.dy;
        snapped = this._computeSnap(rawX, rawY, anchorPerson, g.memberIds);
        snapDx = snapped.x - rawX;
        snapDy = snapped.y - rawY;
      }
    } else if (g.anchorType === "textbox" && anchorStart) {
      const anchorBox = this.tree.textBoxes.get(g.anchorId);
      if (anchorBox) {
        const rawX = anchorStart.x + g.dx;
        const rawY = anchorStart.y + g.dy;
        snapped = this._computeTextBoxSnap(rawX, rawY, anchorBox, g.memberIds);
        snapDx = snapped.x - rawX;
        snapDy = snapped.y - rawY;
      }
    }

    // 모델 좌표만 갱신한다(가벼움) — 실제 DOM 반영(카드/텍스트박스 위치 + 영향받는 관계선 다시
    // 그리기)은 _scheduleGroupVisualUpdate가 프레임당 한 번으로 묶어서 처리한다.
    for (const [id, start] of g.positions) {
      const nx = start.x + g.dx + snapDx;
      const ny = start.y + g.dy + snapDy;
      if (start.type === "person") {
        const p = this.tree.people.get(id);
        if (p) { p.x = nx; p.y = ny; }
      } else if (start.type === "textbox") {
        const b = this.tree.textBoxes.get(id);
        if (b) { b.x = nx; b.y = ny; }
      } else {
        const f = this.tree.fields.get(id);
        if (f) { f.x = nx; f.y = ny; }
      }
    }
    this._scheduleGroupVisualUpdate();

    if (snapped) {
      this._setGuide("h", snapped.guideY);
      this._setGuide("v", snapped.guideX);
      this._setExtraGuides(snapped.extraGuides);
    } else {
      this._hideSnapGuides();
    }
  }

  /**
   * 그룹 드래그 중 DOM 반영을 프레임당 한 번으로 묶는다 — 개별 카드 드래그의 _scheduleVisualUpdate
   * 와 같은 이유(포인터 이벤트가 화면 주사율보다 훨씬 잦아도 그리기는 프레임당 한 번이면 충분).
   * 다만 개별 카드용 그 함수를 그대로 재사용하지 않는 이유: 그 함수는 "카드 하나당" 호출될 때마다
   * _updateLinesFor(관계 전체 훑기)를 또 하나씩 실행하므로, 그룹 멤버 수만큼 그대로 반복 호출하면
   * (멤버 수 × 관계 수)만큼 매 프레임 느려진다. 여기서는 위치만 멤버 수만큼 쓰고(가벼움), 관계선은
   * _beginGroupDrag가 미리 구해둔 합집합(affectedLineIds)만 한 번씩만 다시 그린다.
   */
  _scheduleGroupVisualUpdate() {
    if (this._groupMoveRaf) return;
    this._groupMoveRaf = requestAnimationFrame(() => {
      this._groupMoveRaf = null;
      const g = this._groupDragState;
      if (!g) return;
      for (const [id, start] of g.positions) {
        if (start.type === "person") {
          const p = this.tree.people.get(id);
          const el = this.cardEls.get(id);
          if (p && el) {
            el.style.left = `${p.x}px`;
            el.style.top = `${p.y}px`;
          }
        } else if (start.type === "textbox") {
          const b = this.tree.textBoxes.get(id);
          const el = this.textBoxEls.get(id);
          if (b && el) {
            el.style.left = `${b.x}px`;
            el.style.top = `${b.y}px`;
          }
        } else {
          const f = this.tree.fields.get(id);
          const el = this.fieldEls.get(id);
          if (f && el) {
            el.style.left = `${f.x}px`;
            el.style.top = `${f.y}px`;
          }
        }
      }
      for (const relId of g.affectedLineIds) this._updateLine(relId);
    });
  }

  /** droppedOnTrash면 그룹 전체(잠기지 않아 실제로 움직인 대상들)를 확인 후 한 번에 지운다 —
   * 아니면 그동안 옮긴 좌표를 전부 커밋한다. */
  _commitGroupDrag(droppedOnTrash) {
    const g = this._groupDragState;
    if (!g) return;
    this._groupDragState = null;
    // 아직 다음 프레임을 기다리는 그룹 DOM 반영이 있다면 취소한다 — 이 시점에 model 값은
    // 이미 최종값이고, 아래에서 tree.updatePerson/updateTextBox(또는 삭제)가 어차피 정확한
    // 최종 상태를 다시 그리므로 뒤늦게 한 번 더 그릴 필요가 없다.
    if (this._groupMoveRaf) {
      cancelAnimationFrame(this._groupMoveRaf);
      this._groupMoveRaf = null;
    }
    // 드래그가 어떻게 끝나든(커밋/취소/삭제) 흐리게+자물쇠 미리보기는 항상 원래대로 되돌린다.
    for (const el of g.lockedEls) el?.classList.remove("drag-locked-preview");
    if (droppedOnTrash) {
      for (const [id, start] of g.positions) {
        if (start.type === "person") this.tree.removePerson(id);
        else if (start.type === "textbox") this.tree.removeTextBox(id);
        else this.tree.removeField(id);
      }
      this.clearMultiSelection();
      return;
    }
    for (const [id, start] of g.positions) {
      if (start.type === "person") {
        const p = this.tree.people.get(id);
        if (p) this.tree.updatePerson(id, { x: p.x, y: p.y });
      } else if (start.type === "textbox") {
        const b = this.tree.textBoxes.get(id);
        if (b) this.tree.updateTextBox(id, { x: b.x, y: b.y });
      } else {
        const f = this.tree.fields.get(id);
        if (f) this.tree.updateField(id, { x: f.x, y: f.y });
      }
    }
  }

  /** photoId(업로드된 Blob)를 우선으로, 없으면 photoUrl(외부 링크)로 폴백한다. */
  async _resolvePhotoUrl(person) {
    if (person.photoId) {
      let url = this.photoUrls.get(person.photoId);
      if (!url) {
        const blob = await this.store.getImage(person.photoId);
        if (blob) {
          url = URL.createObjectURL(blob);
          this.photoUrls.set(person.photoId, url);
        }
      }
      if (url) return url;
    }
    return person.photoUrl || null;
  }

  async _addCard(person) {
    const el = createCardElement(person);
    const photoUrl = await this._resolvePhotoUrl(person);
    applyCardData(el, person, photoUrl);

    // 실제 커서가 추적한 "진짜" 좌표(rawX/Y)를 person.x/y(스냅이 적용될 수 있는 "표시" 좌표)와
    // 분리해서 따로 들고 있는다. 예전엔 스냅되면 person.x/y 자체를 덮어썼는데, 그러면 바로 다음
    // pointermove의 델타가 "이미 스냅된 값" 위에 누적되어 버려서 — 다른 카드와 가까운 위치에서
    // 시작하면(자동 정렬 직후 같은 가로열 형제들처럼 y가 같은 경우 등) 아주 조금만 움직여도 계속
    // 그 자리로 도로 끌려가 사실상 전혀 움직이지 않는 것처럼 보이는 버그가 있었다.
    let rawX = person.x;
    let rawY = person.y;
    // 이번 드래그에서 마지막으로 계산된 스냅 결과의 slotOf(템플릿 슬롯에 꽂혔는지) — onMoveEnd에서
    // person.slotOf로 커밋한다. 슬롯에 안 꽂힌 채 끝나면 null(=자유로운 인물).
    let pendingSlotOf = null;
    // "잠긴 필드 위에 있어서 이번 드래그를 막을지"는 시작 시점(사람이 아직 그 자리에 가만히
    // 있을 때)에만 한 번 확인해서 여기 기억해둔다. onMove마다 person.x/y(드래그로 계속 움직이는
    // "지금" 좌표)로 다시 확인하면, 그냥 지나가는 자유로운 인물이 잠긴 필드 영역을 스쳐 지나가는
    // 순간 그 프레임에 위치 갱신이 막혀버리고 — person.x/y가 그 지점(=잠긴 필드 안)에 멈춘 채로
    // 다음 프레임도 계속 같은 판정이 나와 영원히 거기 갇혀버리는 버그가 있었다("오브젝트가 그
    // 영역 위만 스쳐도 거기 잠김"). 시작할 때 이미 잠긴 필드 위에 있던 경우만 계속 막는다.
    let blockedByLockedField = false;

    const drag = attachCardDrag(el, {
      getScale: () => this.camera.scale,
      onDragStart: () => {
        if (person.locked) return;
        // 잠긴 필드 위에 올라가 있는 인물은 개별 드래그로 못 옮긴다(필드 자신을 옮기는 건 이
        // 체크와 무관 — _beginFieldDrag가 따로 처리) — 휴지통 힌트도 안 보여줌.
        blockedByLockedField = this._isInLockedField(person.x, person.y);
        if (blockedByLockedField) return;
        // 마키로 2개 이상 골라둔 상태에서 그중 하나를 끌면, 그 묶음 전체가 같이 움직인다.
        if (this.multiSelected.people.has(person.id) && this.getMultiSelectionCount() >= 2) {
          this._beginGroupDrag(person.id, "person");
        } else {
          rawX = person.x;
          rawY = person.y;
          // 슬롯에 꽂혀 있던 인물을 다시 끌기 시작하는 순간 곧바로 빼낸다 — 슬롯은 그 즉시 다시
          // 빈 점선으로 보이고, 인물은 자기 정보를 그대로 가진 채 자유로워진다.
          pendingSlotOf = null;
          if (person.slotOf) this.tree.updatePerson(person.id, { slotOf: null });
        }
        this._showTrash();
      },
      onMove: (dx, dy, e) => {
        if (person.locked || blockedByLockedField) return;
        if (this._groupDragState) {
          this._updateGroupDrag(dx, dy);
        } else {
          rawX += dx;
          rawY += dy;
          const snapped = this._computeSnap(rawX, rawY, person);
          person.x = snapped.x;
          person.y = snapped.y;
          pendingSlotOf = snapped.slotOf || null;
          this._setGuide("h", snapped.guideY);
          this._setGuide("v", snapped.guideX);
          this._setExtraGuides(snapped.extraGuides);
          this._scheduleVisualUpdate(person, el);
        }
        this._setTrashArmed(e && this._isOverTrash(e.clientX, e.clientY));
      },
      onMoveEnd: (e) => {
        if (person.locked || blockedByLockedField) return;
        this._hideSnapGuides();
        const droppedOnTrash = e && this._isOverTrash(e.clientX, e.clientY);
        this._hideTrash();
        if (this._groupDragState) {
          this._commitGroupDrag(droppedOnTrash);
          return;
        }
        this._flushVisualUpdate(person, el);
        if (droppedOnTrash) {
          this.tree.removePerson(person.id);
          return;
        }
        this.tree.updatePerson(person.id, { x: person.x, y: person.y, slotOf: pendingSlotOf });
      },
      onClick: () => this.onCardClick(person.id),
    });

    this.worldEl.appendChild(el);
    this.cardEls.set(person.id, el);
    this.cardDrags.set(person.id, drag);
  }

  /** 자유 텍스트 오브젝트 카드 — 인물 카드와는 다른 스냅 기준(다른 텍스트 박스와의 가장자리·중간
   * 정렬, _computeTextBoxSnap)으로 이동 시 클리핑되고, 클릭하면 바로 편집. */
  _addTextBox(box) {
    const el = createTextBoxElement(box);

    let rawX = box.x;
    let rawY = box.y;

    const moveDrag = attachTextBoxDrag(el, {
      getScale: () => this.camera.scale,
      onDragStart: () => {
        if (box.locked) return; // 잠긴 텍스트 박스는 드래그로 못 옮긴다.
        if (this.multiSelected.textBoxes.has(box.id) && this.getMultiSelectionCount() >= 2) {
          this._beginGroupDrag(box.id, "textbox");
        } else {
          rawX = box.x;
          rawY = box.y;
        }
        this._showTrash();
      },
      onMove: (dx, dy, e) => {
        if (box.locked) return;
        if (this._groupDragState) {
          this._updateGroupDrag(dx, dy);
        } else {
          rawX += dx;
          rawY += dy;
          const snapped = this._computeTextBoxSnap(rawX, rawY, box);
          box.x = snapped.x;
          box.y = snapped.y;
          this._setGuide("h", snapped.guideY);
          this._setGuide("v", snapped.guideX);
          this._setExtraGuides(snapped.extraGuides);
          el.style.left = `${box.x}px`;
          el.style.top = `${box.y}px`;
        }
        this._setTrashArmed(e && this._isOverTrash(e.clientX, e.clientY));
      },
      onMoveEnd: (e) => {
        if (box.locked) return;
        this._hideSnapGuides();
        const droppedOnTrash = e && this._isOverTrash(e.clientX, e.clientY);
        this._hideTrash();
        if (this._groupDragState) {
          this._commitGroupDrag(droppedOnTrash);
          return;
        }
        if (droppedOnTrash) {
          this.tree.removeTextBox(box.id);
          return;
        }
        this.tree.updateTextBox(box.id, { x: box.x, y: box.y });
      },
      onClick: () => this.onTextBoxClick && this.onTextBoxClick(box.id),
    });

    // 모서리 핸들은 글자 크기가 아니라 상자의 폭/높이만 1:1로 바꾼다("모서리 위치를 직접 옮기는"
    // 느낌 — 배율/자동 조절 없음). 글자 크기는 사이드바에서만 바꾼다. dx/dy는 매 이동마다
    // "증분"으로 들어오므로(누적값이 아님), 사람 카드의 rawX/rawY와 똑같이 드래그 시작 시점의
    // 값을 기준 삼아 직접 누적해야 한다 — 안 그러면 실제 이동 거리와 무관하게 매 이벤트마다
    // 거의 같은 값 근처에서 오락가락해서 떨리는 것처럼 보이는 버그가 있었다.
    const MIN_W = 40;
    const MIN_H = 24;
    let rawW = box.width ?? 200;
    let rawH = box.height ?? 50;
    const resizeDrag = attachTextBoxResize(el, {
      getScale: () => this.camera.scale,
      onResizeStart: () => {
        // box.width/height가 없는(width/height 필드가 생기기 전에 저장된) 예전 데이터일 수도
        // 있으니, applyTextBoxData가 이미 기본값을 채워 넣은 실제 DOM 값을 기준으로 삼는다.
        const content = el.querySelector(".text-box-content");
        rawW = parseFloat(content.style.width) || box.width || 200;
        rawH = parseFloat(content.style.height) || box.height || 50;
      },
      onResize: (dxWorld, dyWorld) => {
        rawW += dxWorld;
        rawH += dyWorld;
        // 폭/높이 후보 두 갈래(글자 크기 배수 / 다른 텍스트 박스와의 가장자리·중간 정렬) 중
        // 더 가까운 쪽에 달라붙는다("자동 클리핑") — _computeTextBoxResizeSnap이 둘을 한 번에 비교.
        const snapped = this._computeTextBoxResizeSnap(box, rawW, rawH);
        const w = Math.max(MIN_W, Math.round(snapped.w));
        const h = Math.max(MIN_H, Math.round(snapped.h));
        const content = el.querySelector(".text-box-content");
        content.style.width = `${w}px`;
        content.style.height = `${h}px`;
        this._setGuide("h", snapped.guideY);
        this._setGuide("v", snapped.guideX);
      },
      onResizeEnd: () => {
        this._hideSnapGuides();
        const content = el.querySelector(".text-box-content");
        const w = parseFloat(content.style.width) || box.width;
        const h = parseFloat(content.style.height) || box.height;
        this.tree.updateTextBox(box.id, { width: w, height: h });
      },
    });

    // 왼쪽 위 모서리 핸들 — 오른쪽 아래는 고정한 채(anchorRight/Bottom) 반대 방향으로 늘고
    // 줄어든다. 정렬 스냅(_computeTextBoxResizeSnap)은 "내 오른쪽/중간이 상대와 맞는지"를
    // 오른쪽 아래 고정 기준으로 계산하므로 이쪽 핸들엔 그대로 못 쓴다 — 최소 크기 clamp만 적용
    // (필드의 왼쪽 위 손잡이와 같은 범위 축소).
    let tlAnchorRight = box.x + (box.width ?? 200);
    let tlAnchorBottom = box.y + (box.height ?? 50);
    let tlRawX = box.x;
    let tlRawY = box.y;
    const resizeDragTL = attachTextBoxResize(el, {
      getScale: () => this.camera.scale,
      corner: "tl",
      onResizeStart: () => {
        const content = el.querySelector(".text-box-content");
        const curW = parseFloat(content.style.width) || box.width || 200;
        const curH = parseFloat(content.style.height) || box.height || 50;
        const curX = parseFloat(el.style.left) || box.x;
        const curY = parseFloat(el.style.top) || box.y;
        tlAnchorRight = curX + curW;
        tlAnchorBottom = curY + curH;
        tlRawX = curX;
        tlRawY = curY;
      },
      onResize: (dxWorld, dyWorld) => {
        tlRawX += dxWorld;
        tlRawY += dyWorld;
        const w = Math.max(MIN_W, Math.round(tlAnchorRight - tlRawX));
        const h = Math.max(MIN_H, Math.round(tlAnchorBottom - tlRawY));
        // 최소 크기에 걸리면 그만큼 왼쪽 위 좌표도 다시 안쪽으로 당겨서, 오른쪽 아래가 계속
        // 같은 자리에 고정된 것처럼 보이게 한다(커서를 그 이상 움직여도 더 안 줄어들 뿐).
        el.style.left = `${tlAnchorRight - w}px`;
        el.style.top = `${tlAnchorBottom - h}px`;
        const content = el.querySelector(".text-box-content");
        content.style.width = `${w}px`;
        content.style.height = `${h}px`;
      },
      onResizeEnd: () => {
        const content = el.querySelector(".text-box-content");
        const w = parseFloat(content.style.width) || box.width;
        const h = parseFloat(content.style.height) || box.height;
        const x = parseFloat(el.style.left) || box.x;
        const y = parseFloat(el.style.top) || box.y;
        this.tree.updateTextBox(box.id, { x, y, width: w, height: h });
      },
    });

    this.worldEl.appendChild(el);
    this.textBoxEls.set(box.id, el);
    this.textBoxDrags.set(box.id, { moveDrag, resizeDrag, resizeDragTL });
  }

  /**
   * 필드 — 인물/텍스트박스를 묶는 완전히 빈 컨테이너 + 템플릿 자리. 필드 자신을 드래그하면
   * 그 순간 사각형 안에 있는 오브젝트를 기하학적으로 쓸어담아 함께 옮긴다(_beginFieldDrag).
   * 마키로 2개 이상과 함께 골라 그룹으로 끌 때는(이 카드/텍스트박스와 같은 패턴) 대신
   * 기존 _beginGroupDrag를 쓴다 — 그때는 필드 위 오브젝트까지 쓸어담지 않는다(별도로 같이
   * 선택되어 있어야 함, "마키 그룹 드래그"와 "필드 고유 드래그"는 전제가 다름).
   */
  _addField(field) {
    const el = createFieldElement(field);
    this._syncFieldSlots(field, el);
    this._syncTemplateRelLines(field, el);

    const moveDrag = attachFieldDrag(el, {
      getScale: () => this.camera.scale,
      onDragStart: () => {
        // selfLocked(필드 "자신"의 위치 잠금)면 person.locked/box.locked와 똑같이 드래그 자체를
        // 시작하지 않는다 — field.locked(내용물 잠금)와는 별개라 이 체크와 무관하게 적용된다.
        if (field.selfLocked) return;
        if (this.multiSelected.fields.has(field.id) && this.getMultiSelectionCount() >= 2) {
          this._beginGroupDrag(field.id, "field");
        } else {
          this._beginFieldDrag(field);
        }
        this._showTrash();
      },
      onMove: (dx, dy, e) => {
        if (this._groupDragState) this._updateGroupDrag(dx, dy);
        else if (this._fieldDragState) this._updateFieldDrag(dx, dy);
        this._setTrashArmed(e && this._isOverTrash(e.clientX, e.clientY));
      },
      onMoveEnd: (e) => {
        this._hideTrash();
        const droppedOnTrash = e && this._isOverTrash(e.clientX, e.clientY);
        if (this._groupDragState) this._commitGroupDrag(droppedOnTrash);
        else if (this._fieldDragState) this._commitFieldDrag(droppedOnTrash);
      },
      onClick: () => this.onFieldClick && this.onFieldClick(field.id),
    });

    // 리사이즈는 텍스트박스와 같은 1:1 손잡이 방식이지만 정렬 스냅은 없다(v1 범위 축소 —
    // 최소 크기만 clamp).
    const MIN_W = 120;
    const MIN_H = 90;
    let rawW = field.width;
    let rawH = field.height;
    let brResizeBlocked = false; // selfLocked(필드 위치 잠금)이면 리사이즈도 같이 막는다
    const resizeDrag = attachFieldResize(el, {
      getScale: () => this.camera.scale,
      onResizeStart: () => {
        brResizeBlocked = !!field.selfLocked;
        if (brResizeBlocked) return;
        const content = el.querySelector(".field-content");
        rawW = parseFloat(content.style.width) || field.width;
        rawH = parseFloat(content.style.height) || field.height;
      },
      onResize: (dxWorld, dyWorld) => {
        if (brResizeBlocked) return;
        rawW += dxWorld;
        rawH += dyWorld;
        const w = Math.max(MIN_W, Math.round(rawW));
        const h = Math.max(MIN_H, Math.round(rawH));
        const content = el.querySelector(".field-content");
        content.style.width = `${w}px`;
        content.style.height = `${h}px`;
      },
      onResizeEnd: () => {
        if (brResizeBlocked) return;
        const content = el.querySelector(".field-content");
        const w = parseFloat(content.style.width) || field.width;
        const h = parseFloat(content.style.height) || field.height;
        this.tree.updateField(field.id, { width: w, height: h });
      },
    });

    // 왼쪽 위 모서리 핸들 — 오른쪽 아래를 고정한 채(anchorRight/Bottom) 반대 방향으로 늘고
    // 줄어든다. 텍스트박스의 왼쪽 위 손잡이와 같은 원칙(정렬 스냅 없이 최소 크기만 clamp).
    let tlAnchorRight = field.x + field.width;
    let tlAnchorBottom = field.y + field.height;
    let tlRawX = field.x;
    let tlRawY = field.y;
    let tlStartX = field.x; // 리사이즈 시작 시점의 필드 x/y — 슬롯 보정용 델타 계산 기준
    let tlStartY = field.y;
    let tlResizeBlocked = false; // selfLocked(필드 위치 잠금)이면 이 손잡이로도 크기를 못 바꾼다
    const resizeDragTL = attachFieldResize(el, {
      getScale: () => this.camera.scale,
      corner: "tl",
      onResizeStart: () => {
        tlResizeBlocked = !!field.selfLocked;
        if (tlResizeBlocked) return;
        const content = el.querySelector(".field-content");
        const curW = parseFloat(content.style.width) || field.width;
        const curH = parseFloat(content.style.height) || field.height;
        const curX = parseFloat(el.style.left) || field.x;
        const curY = parseFloat(el.style.top) || field.y;
        tlAnchorRight = curX + curW;
        tlAnchorBottom = curY + curH;
        tlRawX = curX;
        tlRawY = curY;
        tlStartX = curX;
        tlStartY = curY;
      },
      onResize: (dxWorld, dyWorld) => {
        if (tlResizeBlocked) return;
        tlRawX += dxWorld;
        tlRawY += dyWorld;
        const w = Math.max(MIN_W, Math.round(tlAnchorRight - tlRawX));
        const h = Math.max(MIN_H, Math.round(tlAnchorBottom - tlRawY));
        // 최소 크기에 걸리면 왼쪽 위 좌표도 그만큼 다시 안쪽으로 당겨서, 오른쪽 아래가 계속
        // 같은 자리에 고정된 것처럼 보이게 한다.
        const newX = tlAnchorRight - w;
        const newY = tlAnchorBottom - h;
        el.style.left = `${newX}px`;
        el.style.top = `${newY}px`;
        const content = el.querySelector(".field-content");
        content.style.width = `${w}px`;
        content.style.height = `${h}px`;
        // 필드의 왼쪽 위 모서리(x/y)가 움직인 만큼, 그 안의 템플릿 슬롯(필드 기준 상대좌표라
        // 부모가 움직이면 같이 딸려 움직여 보임)을 반대로 보정해서 화면상 절대 위치가 그대로
        // 있게 한다 — "왼쪽 위 손잡이를 건드려도 필드 요소들은 안 움직이게".
        const deltaX = newX - tlStartX;
        const deltaY = newY - tlStartY;
        const overrides = {};
        for (const slot of field.templateSlots) {
          const relX = slot.relX - deltaX;
          const relY = slot.relY - deltaY;
          overrides[slot.id] = { x: relX, y: relY };
          const slotEl = el.querySelector(`.field-slot[data-slot-id="${slot.id}"]`);
          if (slotEl) applySlotPosition(slotEl, { relX, relY });
        }
        // 템플릿 관계 안내선도 리사이즈 중 라이브로 보정된 슬롯 위치를 따라오게 한다(위와 같은
        // 이유 — "템플릿 이동시킬 때 선도 같이 움직임").
        this._syncTemplateRelLines(field, el, overrides);
      },
      onResizeEnd: () => {
        if (tlResizeBlocked) return;
        const content = el.querySelector(".field-content");
        const w = parseFloat(content.style.width) || field.width;
        const h = parseFloat(content.style.height) || field.height;
        const x = parseFloat(el.style.left) || field.x;
        const y = parseFloat(el.style.top) || field.y;
        const deltaX = x - tlStartX;
        const deltaY = y - tlStartY;
        // 라이브 프리뷰와 똑같이, 커밋할 때도 슬롯 상대좌표를 반대로 보정해 절대 위치를 지킨다.
        const templateSlots = field.templateSlots.map((s) => ({ ...s, relX: s.relX - deltaX, relY: s.relY - deltaY }));
        this.tree.updateField(field.id, { x, y, width: w, height: h, templateSlots });
      },
    });

    this.fieldsEl.appendChild(el);
    this.fieldEls.set(field.id, el);
    this.fieldDrags.set(field.id, { moveDrag, resizeDrag, resizeDragTL });
  }

  /** field.templateSlots 배열을 실제 DOM(.field-slot)과 맞춘다 — 추가/삭제된 슬롯만 갱신하고,
   * 새로 생긴 슬롯엔 드래그/클릭 컨트롤러를 새로 붙이고 없어진 슬롯 것은 destroy()한다. */
  _syncFieldSlots(field, el) {
    const wantedIds = new Set(field.templateSlots.map((s) => s.id));
    for (const slotEl of el.querySelectorAll(".field-slot")) {
      const slotId = slotEl.dataset.slotId;
      if (!wantedIds.has(slotId)) {
        this.slotDrags.get(slotId)?.destroy();
        this.slotDrags.delete(slotId);
        slotEl.remove();
      }
    }
    for (const slot of field.templateSlots) {
      let slotEl = el.querySelector(`.field-slot[data-slot-id="${slot.id}"]`);
      if (!slotEl) {
        slotEl = createSlotElement(slot);
        el.appendChild(slotEl);
        this._attachSlotDrag(field.id, slot.id, slotEl);
      } else if (!this.slotDrags.has(slot.id)) {
        // "잠깐 없어졌다가 다시 생김" 등의 이유로 컨트롤러가 없는 기존 엘리먼트라면 마저 붙인다.
        this._attachSlotDrag(field.id, slot.id, slotEl);
        applySlotPosition(slotEl, slot);
      } else {
        applySlotPosition(slotEl, slot);
      }
    }
  }

  /** 템플릿 자리(슬롯) 하나의 드래그(템플릿 수정 중 위치 재조정)와 클릭(템플릿 수정 중엔 삭제,
   * 아니면 필드 사이드바 열기)을 처리한다. field.templateMode는 드래그 시작 시점에 실시간으로
   * 확인한다(슬롯 엘리먼트를 새로 만들지 않고도 모드 토글에 바로 반응하도록). */
  _attachSlotDrag(fieldId, slotId, slotEl) {
    let rawRelX = 0; // 커서를 그대로 따라가는 누적값(스냅 미반영, 필드 기준 상대좌표)
    let rawRelY = 0;
    let curRelX = 0; // 실제로 보여주는(스냅이 반영된) 값 — 드래그가 끝나면 이걸 커밋한다
    let curRelY = 0;
    let editing = false; // 이번 드래그가 실제로 위치를 바꾸는 중인지(템플릿 수정 중일 때만)
    const drag = attachSlotDrag(slotEl, {
      getScale: () => this.camera.scale,
      onDragStart: () => {
        const field = this.tree.fields.get(fieldId);
        const slot = field?.templateSlots.find((s) => s.id === slotId);
        editing = !!(field?.templateMode && slot);
        if (!editing) return;
        rawRelX = curRelX = slot.relX;
        rawRelY = curRelY = slot.relY;
      },
      onDragMove: (dx, dy) => {
        if (!editing) return;
        const field = this.tree.fields.get(fieldId);
        if (!field) return;
        rawRelX += dx;
        rawRelY += dy;
        // "템플릿도 다른 인물들과 똑같이 클리핑되게" + "템플릿끼리도 클리핑되게" — 인물 카드와
        // 같은 스냅(같은 행/열, 부모-자식 트렁크, 표준 칸 간격)을 그대로 재사용하되, 다섯 번째
        // 인자(alsoMatchSlotId)로 이 슬롯 자신의 id를 넘겨서 다른 모든 필드의 다른 슬롯들도
        // 인물과 동등하게 같은 행/열·표준 칸 간격 후보에 포함시킨다. 필드 기준 상대좌표를 월드
        // 좌표로 바꿔 계산한 뒤 다시 상대좌표로 되돌린다. 슬롯끼리 서로 "꽂히는"(2차원 정확히
        // 겹치는) 건 의미가 없으므로(그건 실제 인물 전용) excludeIds에 빈 Set을 줘서
        // _computeSlotSnap 분기만 건너뛴다.
        const snapped = this._computeSnap(field.x + rawRelX, field.y + rawRelY, { id: slotId }, new Set(), slotId);
        curRelX = snapped.x - field.x;
        curRelY = snapped.y - field.y;
        applySlotPosition(slotEl, { relX: curRelX, relY: curRelY });
        this._setGuide("h", snapped.guideY);
        this._setGuide("v", snapped.guideX);
        this._setExtraGuides(snapped.extraGuides);
        // 이 슬롯에 걸린 템플릿 관계 안내선도 커밋 전(드래그 중) 라이브 위치를 그대로 따라오게
        // 한다("템플릿 이동시킬 때 선 움직이는 것도 보이게") — field:update는 드래그가 끝나야
        // 나가므로, 그 전까지는 override로 지금 이 슬롯의 미확정 위치를 대신 넘겨준다.
        const fieldEl = this.fieldEls.get(fieldId);
        if (fieldEl) this._syncTemplateRelLines(field, fieldEl, { [slotId]: { x: curRelX, y: curRelY } });
      },
      onDragEnd: () => {
        if (!editing) return;
        editing = false;
        this._hideSnapGuides();
        const field = this.tree.fields.get(fieldId);
        if (!field) return;
        const templateSlots = field.templateSlots.map((s) =>
          s.id === slotId ? { ...s, relX: curRelX, relY: curRelY } : s
        );
        this.tree.updateField(fieldId, { templateSlots });
      },
      onClick: () => {
        // "&관계" 연결 모드 중이면(main.js) 클릭을 슬롯 고르기로 먼저 넘긴다 — 처리했다고
        // (true) 답하면 여기서 끝, 평소의 사이드바 열기 동작은 건너뛴다.
        if (this.onSlotClick && this.onSlotClick(fieldId, slotId)) return;
        // 클릭하면 곧바로 삭제 확인창이 뜨던 예전 동작 대신, 인물/텍스트박스/관계선/필드와
        // 똑같이 이 슬롯 전용 사이드바를 연다(삭제는 그 사이드바의 버튼으로).
        const field = this.tree.fields.get(fieldId);
        const slot = field?.templateSlots.find((s) => s.id === slotId);
        if (field && slot) this.onTemplateSlotClick && this.onTemplateSlotClick(fieldId, slot);
      },
    });
    this.slotDrags.set(slotId, drag);
  }

  /** field.templateRelationships 배열을 실제 SVG(.field-rel-line)와 맞춘다 — 슬롯 위치나
   * 점유 상태(인물이 꽂히거나 빠짐)가 바뀔 때마다 field:update로 다시 불린다
   * (Tree.js._resyncFieldTemplateRelationships 참고). overridePositions({slotId: {x,y}})를
   * 주면 그 슬롯(들)은 tree 값 대신 그 좌표를 쓴다 — 슬롯을 드래그하는 도중처럼 아직 커밋 전인
   * 라이브 위치로 안내선을 실시간으로 따라오게 할 때 쓴다("템플릿 이동시킬 때 선도 같이 움직임"). */
  _syncTemplateRelLines(field, el, overridePositions = null) {
    const svg = el.querySelector(".field-rel-lines");
    const trs = field.templateRelationships || [];
    const wantedIds = new Set(trs.map((tr) => tr.id));
    for (const lineEl of svg.querySelectorAll(".field-rel-line")) {
      if (!wantedIds.has(lineEl.dataset.trId)) lineEl.remove();
    }
    for (const tr of trs) {
      let lineEl = svg.querySelector(`.field-rel-line[data-tr-id="${tr.id}"]`);
      if (!lineEl) {
        lineEl = createTemplateRelLineElement(tr);
        // 클릭하면 곧바로 삭제 확인창이 뜨던 예전 동작 대신, 이 템플릿 관계 전용 사이드바를
        // 연다(라벨/색/선 종류/방향을 고칠 수 있고, 삭제도 그 사이드바의 버튼으로 한다).
        lineEl.addEventListener("click", (e) => {
          e.stopPropagation();
          const liveField = this.tree.fields.get(field.id);
          const liveTr = liveField?.templateRelationships?.find((t) => t.id === tr.id);
          if (liveField && liveTr) this.onTemplateRelationshipClick && this.onTemplateRelationshipClick(field.id, liveTr);
        });
        svg.appendChild(lineEl);
      }
      const points = this._computeTemplateLinePoints(field, tr, overridePositions);
      applyTemplateRelLineData(lineEl, points, (tr.materializedRelIds || []).length > 0);
    }
  }

  /** 템플릿 관계(슬롯끼리 그은 안내선) 하나의 실제 그려질 점들을 계산한다 — 실제 인물 관계선을
   * 그리는 _computeLinePoints와 정확히 같은 규칙(배우자/화살표는 직선, 부모-자식은 자식이
   * 하나면 배우자 선 위 지점→자식 직선, 둘 이상이면 부부 중점 트렁크→버스 바→자식 스텁)을
   * 슬롯 데이터에 그대로 적용한다 — "템플릿끼리 부모-자식(부모2) 했을 때 선이 실제 관계선과
   * 달라 보이던" 문제. 슬롯이 비어 있으면 그 점선 위치를, 채워져 있으면 지금 그 자리를 차지한
   * 인물의(필드 기준 상대) 위치를 쓴다 — "안내선이지만 사람이 채워지면 그 사람을 따라간다". */
  _computeTemplateLinePoints(field, tr, overridePositions = null) {
    const posOf = (slotId) => {
      if (overridePositions?.[slotId]) return overridePositions[slotId];
      const occupant = this._personInSlot(field.id, slotId);
      if (occupant) return { x: occupant.x - field.x, y: occupant.y - field.y };
      const slot = field.templateSlots.find((s) => s.id === slotId);
      return slot ? { x: slot.relX, y: slot.relY } : { x: 0, y: 0 };
    };

    if (tr.type !== "parent-child") {
      // 배우자/화살표/기타 + "부모-자식(부모1)"(솔로)는 항상 단순 직선.
      return [posOf(tr.slotIds[0]), posOf(tr.slotIds[1])];
    }
    const [p1Id, p2Id, childId] = tr.slotIds;
    const a = posOf(p1Id);
    const partner = posOf(p2Id);
    const b = posOf(childId);
    // 같은 부모 슬롯 쌍(순서 무관)을 공유하는 "부모-자식" 템플릿 관계 전부(자기 자신 포함) = 형제자매.
    const siblings = (field.templateRelationships || []).filter((t) =>
      t.type === "parent-child" &&
      ((t.slotIds[0] === p1Id && t.slotIds[1] === p2Id) || (t.slotIds[0] === p2Id && t.slotIds[1] === p1Id))
    );
    if (siblings.length <= 1) {
      const minX = Math.min(a.x, partner.x);
      const maxX = Math.max(a.x, partner.x);
      const dropX = Math.min(maxX, Math.max(minX, b.x));
      const t = partner.x !== a.x ? (dropX - a.x) / (partner.x - a.x) : 0;
      const dropY = a.y + (partner.y - a.y) * t;
      return [{ x: dropX, y: dropY }, { x: b.x, y: b.y }];
    }
    const trunkX = (a.x + partner.x) / 2;
    const trunkY = (a.y + partner.y) / 2;
    const children = siblings.map((s) => posOf(s.slotIds[2]));
    const minChildY = Math.min(...children.map((c) => c.y));
    let busY = trunkY + (minChildY - trunkY) * 0.5;
    if (busY - trunkY < 20) busY = trunkY + 20; // 부모와 너무 가까워지지 않도록 최소 간격 보장
    return [
      { x: trunkX, y: trunkY },
      { x: trunkX, y: busY },
      { x: b.x, y: busY },
      { x: b.x, y: b.y },
    ];
  }

  /** field의 사각형 안에 "올라가 있는" 인물/텍스트박스 id 목록 — 각자의 기준점(인물은 사진 원
   * 중심, 텍스트박스는 상자 중심)이 사각형 안에 들어오면 포함시킨다. 소속을 별도로 계속
   * 관리하지 않고 필드를 드래그하는 매 순간·복사하는 순간에 그때그때 다시 계산한다. */
  _objectsWithinField(field) {
    // addLocked("새 요소 추가 잠금")가 켜져 있으면, 기하학적으로 겹치더라도 그 순간의
    // lockedMemberIds(잠글 때 스냅샷 찍어둔 멤버 목록)에 없는 오브젝트는 "새 멤버"로 인정하지
    // 않는다 — 이미 목록에 있던 것만(계속 겹쳐 있는 한) 그대로 인정된다.
    const memberFilter = field.addLocked ? new Set(field.lockedMemberIds || []) : null;
    const people = [];
    for (const p of this.tree.people.values()) {
      if (memberFilter && !memberFilter.has(p.id)) continue;
      if (p.x >= field.x && p.x <= field.x + field.width && p.y >= field.y && p.y <= field.y + field.height) {
        people.push(p.id);
      }
    }
    const textBoxes = [];
    for (const b of this.tree.textBoxes.values()) {
      if (memberFilter && !memberFilter.has(b.id)) continue;
      const cx = b.x + (b.width ?? 200) / 2;
      const cy = b.y + (b.height ?? 50) / 2;
      if (cx >= field.x && cx <= field.x + field.width && cy >= field.y && cy <= field.y + field.height) {
        textBoxes.push(b.id);
      }
    }
    return { people, textBoxes };
  }

  /** 이 좌표가 "잠긴" 필드 위에 있는지 — person.locked/box.locked와는 별개 개념으로, 이게
   * true면 그 오브젝트의 "개별" 드래그 시작을 막는다(필드 자신을 옮기는 건 여전히 됨). */
  _isInLockedField(x, y) {
    for (const f of this.tree.fields.values()) {
      if (!f.locked) continue;
      if (x >= f.x && x <= f.x + f.width && y >= f.y && y <= f.y + f.height) return true;
    }
    return false;
  }

  /** 필드 자신을 드래그로 옮길 때 — 그 순간 사각형 안의 인물/텍스트박스를 기하학적으로
   * 쓸어담아 함께 옮긴다("위에 올라가 있는 오브젝트는 필드 이동 시 같이 움직임"). 마키 다중선택
   * 그룹 드래그(_beginGroupDrag, 소속이 미리 골라둔 this.multiSelected에서 옴)와는 전제가 달라
   * 별도 상태 머신으로 둔다. 개별 잠금(person.locked/box.locked)된 대상은 기존 그룹 드래그와
   * 동일하게 이번엔 제외(흐리게+자물쇠 미리보기도 재사용). */
  _beginFieldDrag(field) {
    const { people, textBoxes } = this._objectsWithinField(field);
    const positions = new Map(); // id -> { x, y, type }
    const lockedEls = [];
    for (const id of people) {
      const p = this.tree.people.get(id);
      if (!p) continue;
      if (p.locked) lockedEls.push(this.cardEls.get(id));
      else positions.set(id, { x: p.x, y: p.y, type: "person" });
    }
    for (const id of textBoxes) {
      const b = this.tree.textBoxes.get(id);
      if (!b) continue;
      if (b.locked) lockedEls.push(this.textBoxEls.get(id));
      else positions.set(id, { x: b.x, y: b.y, type: "textbox" });
    }
    for (const el of lockedEls) el?.classList.add("drag-locked-preview");

    const affectedLineIds = new Set();
    for (const id of positions.keys()) {
      for (const relId of this._affectedLineIds(id)) affectedLineIds.add(relId);
    }

    this._fieldDragState = {
      fieldId: field.id, startX: field.x, startY: field.y, dx: 0, dy: 0,
      positions, lockedEls, affectedLineIds,
    };
  }

  _updateFieldDrag(dxWorld, dyWorld) {
    const g = this._fieldDragState;
    if (!g) return;
    g.dx += dxWorld;
    g.dy += dyWorld;
    const field = this.tree.fields.get(g.fieldId);
    if (field) {
      field.x = g.startX + g.dx;
      field.y = g.startY + g.dy;
    }
    for (const [id, start] of g.positions) {
      const nx = start.x + g.dx;
      const ny = start.y + g.dy;
      if (start.type === "person") {
        const p = this.tree.people.get(id);
        if (p) { p.x = nx; p.y = ny; }
      } else {
        const b = this.tree.textBoxes.get(id);
        if (b) { b.x = nx; b.y = ny; }
      }
    }
    this._scheduleFieldVisualUpdate();
  }

  /** 필드 드래그 중 DOM 반영을 프레임당 한 번으로 묶는다 — 마키 그룹 드래그의
   * _scheduleGroupVisualUpdate와 같은 이유·같은 패턴. */
  _scheduleFieldVisualUpdate() {
    if (this._fieldMoveRaf) return;
    this._fieldMoveRaf = requestAnimationFrame(() => {
      this._fieldMoveRaf = null;
      const g = this._fieldDragState;
      if (!g) return;
      const field = this.tree.fields.get(g.fieldId);
      const fieldEl = this.fieldEls.get(g.fieldId);
      if (field && fieldEl) {
        fieldEl.style.left = `${field.x}px`;
        fieldEl.style.top = `${field.y}px`;
      }
      for (const [id, start] of g.positions) {
        if (start.type === "person") {
          const p = this.tree.people.get(id);
          const el = this.cardEls.get(id);
          if (p && el) { el.style.left = `${p.x}px`; el.style.top = `${p.y}px`; }
        } else {
          const b = this.tree.textBoxes.get(id);
          const el = this.textBoxEls.get(id);
          if (b && el) { el.style.left = `${b.x}px`; el.style.top = `${b.y}px`; }
        }
      }
      for (const relId of g.affectedLineIds) this._updateLine(relId);
    });
  }

  /** droppedOnTrash면 필드만 지운다(위에 있던 오브젝트는 자유로운 상태로 남음 — removeField가
   * slotOf도 알아서 정리). 아니면 필드 + 함께 옮긴 오브젝트들의 최종 좌표를 전부 커밋한다. */
  _commitFieldDrag(droppedOnTrash) {
    const g = this._fieldDragState;
    if (!g) return;
    this._fieldDragState = null;
    if (this._fieldMoveRaf) {
      cancelAnimationFrame(this._fieldMoveRaf);
      this._fieldMoveRaf = null;
    }
    for (const el of g.lockedEls) el?.classList.remove("drag-locked-preview");
    if (droppedOnTrash) {
      this.tree.removeField(g.fieldId);
      return;
    }
    const field = this.tree.fields.get(g.fieldId);
    if (field) this.tree.updateField(g.fieldId, { x: field.x, y: field.y });
    for (const [id, start] of g.positions) {
      if (start.type === "person") {
        const p = this.tree.people.get(id);
        if (p) this.tree.updatePerson(id, { x: p.x, y: p.y });
      } else {
        const b = this.tree.textBoxes.get(id);
        if (b) this.tree.updateTextBox(id, { x: b.x, y: b.y });
      }
    }
  }

  /**
   * 카드 위치/관계선 갱신을 다음 애니메이션 프레임으로 묶는다.
   * pointermove가 화면 주사율보다 훨씬 자주 발생해도(고주사율 마우스 등) DOM에는 프레임당 한 번만 쓴다.
   */
  _scheduleVisualUpdate(person, el) {
    this._pendingMoves = this._pendingMoves || new Map();
    this._pendingMoves.set(person.id, { person, el });
    if (this._moveRaf) return;
    this._moveRaf = requestAnimationFrame(() => {
      this._moveRaf = null;
      const pending = this._pendingMoves;
      this._pendingMoves = new Map();
      for (const { person, el } of pending.values()) this._flushVisualUpdate(person, el);
    });
  }

  _flushVisualUpdate(person, el) {
    el.style.left = `${person.x}px`;
    el.style.top = `${person.y}px`;
    this._updateLinesFor(person.id);
  }

  /**
   * rawX/rawY(드래그 중인 카드의 "진짜" 커서 추적 좌표)가 다른 카드와 가로(y)/세로(x)로 가까우면
   * 그 값에 붙인 표시 좌표를 반환한다("클리핑"되는 느낌). 화면상 약 8px 이내일 때 반응하도록
   * 줌 배율을 반영한 월드 좌표 임계값을 쓴다. 가로열(같은 세대) 정렬은 y를, 세로열(같은 가계
   * 라인) 정렬은 x를 맞출 때 쓴다.
   *
   * 중요: 이 함수는 rawX/rawY를 읽기만 하고 절대 변형하지 않는다(순수 함수). 예전엔 스냅된
   * 값을 person.x/y에 직접 덮어써서, 다음 pointermove의 이동량이 "이미 스냅되어 되돌아간 값"
   * 위에 누적되는 바람에 — 다른 카드와 y(또는 x)가 같은 위치에서 드래그를 시작하면(자동 정렬
   * 직후 같은 가로열 형제들처럼) 아무리 옮겨도 계속 그 자리로 도로 끌려가 버리는 버그가 있었다.
   * rawX/rawY는 호출한 쪽(카드별 드래그 클로저)이 실제 커서 이동량만으로 계속 누적해야 한다.
   */
  /**
   * excludeIds: person.id 자신 말고 "추가로" 후보에서 빼야 할 id들(그룹 드래그 중인 다른 멤버들).
   * 그룹 전체가 같은 델타로 같이 움직이는 동안엔 서로의 상대 거리가 절대 안 바뀌므로, 뺴놓지
   * 않으면 "옆에 같이 끌려가는 내 그룹 멤버"가 항상 후보에 걸려서(자동 정렬 직후엔 형제끼리
   * 정확히 표준 간격만큼 떨어져 있는 경우가 흔하다) 커서를 어디로 옮기든 그 멤버 쪽으로만
   * 계속 "스냅된 것처럼" 보이고 정작 원하는 외부 기준(다른 가족/템플릿 칸)엔 안 붙는 문제가 있다.
   */
  /**
   * alsoMatchSlotId: 슬롯을 드래그하는 중일 때만 그 슬롯 자신의 id를 넘긴다("템플릿끼리도
   * 클리핑되게") — 이 값이 있으면 다른 모든 필드의 다른 슬롯들도 인물과 완전히 동등한 자격으로
   * 같은 행/열·표준 칸 간격 후보에 포함시킨다(자기 자신은 제외). 인물을 드래그할 때는 이 값을
   * 안 넘기므로(undefined) 기존 그대로 "인물끼리만" 비교한다 — 슬롯과 인물이 서로 다른 스냅
   * 대상 풀을 쓰는 게 아니라, 슬롯 쪽만 "인물 풀 + 슬롯 풀"을 함께 보는 것으로 확장한 것.
   */
  _computeSnap(rawX, rawY, person, excludeIds = null, alsoMatchSlotId = undefined) {
    // 템플릿 슬롯 스냅이 있으면 그게 우선이다 — X/Y가 같이 딱 맞아야 "꽂혔다"는 느낌이 나므로
    // 축별(행/열/가족/템플릿 칸) 후보보다 먼저 2차원 거리로 검사한다. 그룹 드래그(여러 명을 한
    // 번에 옮기는 앵커)에는 적용하지 않는다 — excludeIds가 그 신호(그룹 드래그만 넘겨줌).
    if (!excludeIds) {
      const slotSnap = this._computeSlotSnap(rawX, rawY, person);
      if (slotSnap) return slotSnap;
    }
    const excludeId = person.id;
    const threshold = SNAP_THRESHOLD_PX / this.camera.scale;
    let bestY = null;
    let bestYDist = threshold;
    let bestYAnchor = null; // 이 스냅이 "누구/어디" 기준인지 — 있으면 점선으로 보여준다.
    let bestX = null;
    let bestXDist = threshold;
    let bestXAnchor = null;
    for (const other of this.tree.people.values()) {
      if (other.id === excludeId || excludeIds?.has(other.id)) continue;
      // 같은 y/x로 나란히 맞추는 스냅은 이미 무한 점선 가이드(_setGuide)로 표시되므로 anchor를 따로 안 둔다.
      const dy = Math.abs(other.y - rawY);
      if (dy < bestYDist) {
        bestYDist = dy;
        bestY = other.y;
        bestYAnchor = null;
      }
      const dx = Math.abs(other.x - rawX);
      if (dx < bestXDist) {
        bestXDist = dx;
        bestX = other.x;
        bestXAnchor = null;
      }
    }

    if (alsoMatchSlotId !== undefined) {
      for (const slot of this._slotAbsolutePositions(alsoMatchSlotId)) {
        const dy = Math.abs(slot.y - rawY);
        if (dy < bestYDist) { bestYDist = dy; bestY = slot.y; bestYAnchor = null; }
        const dx = Math.abs(slot.x - rawX);
        if (dx < bestXDist) { bestXDist = dx; bestX = slot.x; bestXAnchor = null; }
      }
    }

    // "부모-자식(부모2)"의 자식이면, 부모 쌍을 기준으로 한 중심/n등분 후보도 함께 검사한다.
    const family = this._familySnapCandidates(person, excludeIds);
    if (family) {
      const anchor = { x: family.trunkX, y: family.parentY };
      for (const c of family.xCandidates) {
        const dx = Math.abs(c.x - rawX);
        if (dx < bestXDist) {
          bestXDist = dx;
          bestX = c.x;
          bestXAnchor = anchor;
        }
      }
      for (const c of family.yCandidates) {
        const dy = Math.abs(c.y - rawY);
        if (dy < bestYDist) {
          bestYDist = dy;
          bestY = c.y;
          bestYAnchor = anchor;
        }
      }
    }

    // 슬롯을 드래그하는 중이면(alsoMatchSlotId), 템플릿 관계로 이어둔 "슬롯판" 부모-자식
    // 트렁크(부모 슬롯 쌍의 중점 — "절반 길이" 지점 — 기준 n등분 자리)도 인물과 완전히 동등하게
    // 검사한다("템플릿끼리도 인물과 똑같이 클리핑").
    if (alsoMatchSlotId !== undefined) {
      const slotFamily = this._slotFamilySnapCandidates(alsoMatchSlotId);
      if (slotFamily) {
        const anchor = { x: slotFamily.trunkX, y: slotFamily.parentY };
        for (const c of slotFamily.xCandidates) {
          const dx = Math.abs(c.x - rawX);
          if (dx < bestXDist) { bestXDist = dx; bestX = c.x; bestXAnchor = anchor; }
        }
        for (const c of slotFamily.yCandidates) {
          const dy = Math.abs(c.y - rawY);
          if (dy < bestYDist) { bestYDist = dy; bestY = c.y; bestYAnchor = anchor; }
        }
      }
    }

    // 템플릿 간격(표준 칸 간격) 스냅은 특정 관계와 상관없이 "모든 인물"(+슬롯 드래그 중이면
    // 다른 슬롯들도) 기준으로 검사한다.
    const template = this._templateSnapCandidates(person, excludeIds, alsoMatchSlotId);
    for (const c of template.xCandidates) {
      const dx = Math.abs(c.x - rawX);
      if (dx < bestXDist) {
        bestXDist = dx;
        bestX = c.x;
        bestXAnchor = c.anchor;
      }
    }
    for (const c of template.yCandidates) {
      const dy = Math.abs(c.y - rawY);
      if (dy < bestYDist) {
        bestYDist = dy;
        bestY = c.y;
        bestYAnchor = c.anchor;
      }
    }

    const x = bestX !== null ? bestX : rawX;
    const y = bestY !== null ? bestY : rawY;

    // 기준점(anchor)에서 스냅된 위치(x,y)까지 한 번에 대각선으로 잇지 않는다 — anchor와 target은
    // 보통 가로/세로 둘 다 다른 지점이라(예: 부모 트렁크는 자식 세대보다 한 줄 위, 템플릿 스냅의
    // 기준 인물은 다른 칸에 있음), 직선으로 이으면 아무 의미 없는 대각선이 그려져 헷갈린다. 대신
    // "가로로 이만큼, 세로로 이만큼"을 보여주는 직각(ㄱ자) 꺾은선 두 토막으로 나눠 그린다 —
    // x 기준은 (기준 y에서 가로로 이동) 다음 (그 x에서 세로로 target y까지), y 기준은 그 반대 순서.
    const extraGuides = [];
    if (bestXAnchor) {
      extraGuides.push({ x1: bestXAnchor.x, y1: bestXAnchor.y, x2: x, y2: bestXAnchor.y });
      extraGuides.push({ x1: x, y1: bestXAnchor.y, x2: x, y2: y });
    }
    if (bestYAnchor && (!bestXAnchor || bestYAnchor.x !== bestXAnchor.x || bestYAnchor.y !== bestXAnchor.y)) {
      extraGuides.push({ x1: bestYAnchor.x, y1: bestYAnchor.y, x2: bestYAnchor.x, y2: y });
      extraGuides.push({ x1: bestYAnchor.x, y1: y, x2: x, y2: y });
    }

    return { x, y, guideX: bestX, guideY: bestY, extraGuides };
  }

  /** 비어있는 템플릿 슬롯 중 (rawX, rawY)에 화면 기준 SNAP_THRESHOLD_PX 이내로 가장 가까운
   * 것을 찾는다(2차원 거리 — 슬롯은 "정확한 자리"라 축별 후보와 달리 X/Y가 함께 맞아야 함).
   * 이미 다른 사람이 차지한 슬롯은 후보에서 뺀다(자기 자신이 이미 꽂혀 있던 슬롯은 허용 —
   * 그 자리에서 살짝 움직였다 제자리로 돌아오는 경우). 필드가 addLocked("새 요소 추가 잠금")면
   * 슬롯에 꽂히는 것도 엄연히 "그 필드의 새 요소가 되는" 일이므로, 잠글 때의 스냅샷
   * (lockedMemberIds)에 없는 사람은 빈 슬롯이어도 후보에서 뺀다(실제로 겪은 버그: 슬롯 스냅은
   * _objectsWithinField의 기하학적 필터를 안 거쳐서 addLocked를 무시하고 새로 꽂혀버렸음). */
  _computeSlotSnap(rawX, rawY, person) {
    const threshold = SNAP_THRESHOLD_PX / this.camera.scale;
    let best = null;
    let bestDist = threshold;
    for (const field of this.tree.fields.values()) {
      if (field.addLocked && !(field.lockedMemberIds || []).includes(person.id)) continue;
      for (const slot of field.templateSlots) {
        const occupant = this._personInSlot(field.id, slot.id);
        if (occupant && occupant.id !== person.id) continue;
        const slotX = field.x + slot.relX;
        const slotY = field.y + slot.relY;
        const dist = Math.hypot(slotX - rawX, slotY - rawY);
        if (dist < bestDist) {
          bestDist = dist;
          best = {
            x: slotX, y: slotY, guideX: null, guideY: null, extraGuides: [],
            slotOf: { fieldId: field.id, slotId: slot.id },
          };
        }
      }
    }
    return best;
  }

  /** 주어진 필드의 그 슬롯을 지금 차지하고 있는 인물(없으면 null). 모델 쪽 로직(Tree.js의
   * personInSlot — 템플릿 관계 자동 성사/해제에도 같이 쓰임)에 그대로 위임한다. */
  _personInSlot(fieldId, slotId) {
    return this.tree.personInSlot(fieldId, slotId);
  }

  /**
   * person이 "부모-자식(부모2)" 관계의 자식이고 부모 두 명을 모두 확인할 수 있으면, 그 부모 쌍을
   * 기준으로 한 가로(x)/세로(y) 스냅 후보를 만든다 — 자동 정렬(AutoLayout.js)이 형제들을 배치하는
   * 규칙과 "정확히 같은" 지점들이라야, 손으로 옮겨도 "자동 정렬했을 때의 자리"에 자연스럽게
   * 달라붙는다("클리핑").
   *
   * AutoLayout.js는 부모 사이의 실제 간격과 무관하게 트렁크(부모 쌍의 x 중점)를 중심으로 형제들을
   * COL_SPACING 고정 간격으로 나열한다(offsets[0]=0에서 시작해 매번 colSpacing씩 더함 → 블록
   * 전체를 trunkX - blockWidth/2 만큼 왼쪽으로 밀어 중앙 정렬). 예전엔 "부모 사이 구간을 형제 수로
   * 등분"하는 다른 공식을 썼는데, 부모 두 사람 사이 거리가 (형제 수-1)*COL_SPACING과 정확히 같지
   * 않으면(거의 항상 그렇다) 후보 지점이 실제 자동 정렬 결과와 어긋나 버려서 — 카드를 정확히 "있어야
   * 할 자리"로 끌고 가도 그 근처에 스냅 후보가 없어 전혀 달라붙지 않는 문제가 있었다. 이제 그 공식을
   * AutoLayout.js와 동일하게 맞춘다: 트렁크 중심으로 COL_SPACING 간격의 n개 슬롯.
   * 세로(y)는 부모 세대보다 정확히 한 세대(ROW_SPACING) 아래인 지점.
   * (표준 칸 간격 스냅은 이제 _templateSnapCandidates가 모든 인물 기준으로 따로 처리한다.)
   */
  _familySnapCandidates(person, excludeIds = null) {
    let rel = null;
    for (const r of this.tree.relationships.values()) {
      if (r.type === "parent-child" && r.toId === person.id) {
        rel = r;
        break;
      }
    }
    if (rel) {
      const parent1 = this.tree.people.get(rel.fromId);
      const parent2 = this._partnerFor(rel, parent1);
      if (!parent1 || !parent2) return null;
      // 부모 중 한 명이라도 지금 같이 그룹으로 끌려가는 중이면(같은 델타로 같이 움직여 트렁크
      // 자체가 매 프레임 같이 이동하므로) 기준으로 못 쓴다 — 그대로 쓰면 "내가 옮기는 그룹 안의
      // 부모"에 늘 붙어있는 것처럼 보여서 실제로는 아무 데도 안 붙는 것과 다름없어진다.
      if (excludeIds && (excludeIds.has(parent1.id) || excludeIds.has(parent2.id))) return null;

      const n = this._siblingGroup(rel).length; // 이 사람 자신도 포함된, 이 부모 쌍의 전체 자식 수
      const trunkX = (parent1.x + parent2.x) / 2;
      const parentY = (parent1.y + parent2.y) / 2;

      // AutoLayout.js와 동일: 트렁크를 중심으로 COL_SPACING 간격, n개 슬롯(형제 수가 짝수든 홀수든
      // 정중앙 기준으로 좌우 대칭).
      const mid = (n - 1) / 2;
      const xCandidates = [];
      for (let i = 0; i < n; i++) {
        xCandidates.push({ x: trunkX + (i - mid) * COL_SPACING });
      }

      const yCandidates = [{ y: parentY + ROW_SPACING }]; // 부모 세대 + 1

      return { xCandidates, yCandidates, trunkX, parentY };
    }

    // "부모-자식(부모1)"(솔로 부모) — AutoLayout.js는 배우자 유무와 상관없이 그 부모 한 명만
    // 기준(anchorIds=[rel.fromId])으로 자식들을 중앙 정렬한다. 예전엔 이 경우 family snap 후보가
    // 아예 없어서(부부 트렁크가 없다는 이유로), 형제가 둘 이상인 솔로 부모 자식은 항상 안 붙었다.
    let soloRel = null;
    for (const r of this.tree.relationships.values()) {
      if (r.type === "parent-child-solo" && r.toId === person.id) {
        soloRel = r;
        break;
      }
    }
    if (!soloRel) return null;
    const parent = this.tree.people.get(soloRel.fromId);
    if (!parent) return null;
    if (excludeIds && excludeIds.has(parent.id)) return null; // 위와 같은 이유(부모가 같이 끌려가는 중).

    const siblings = [];
    for (const r of this.tree.relationships.values()) {
      if (r.type === "parent-child-solo" && r.fromId === soloRel.fromId) siblings.push(r);
    }
    const n = siblings.length;
    const mid = (n - 1) / 2;
    const xCandidates = [];
    for (let i = 0; i < n; i++) {
      xCandidates.push({ x: parent.x + (i - mid) * COL_SPACING });
    }
    const yCandidates = [{ y: parent.y + ROW_SPACING }];

    return { xCandidates, yCandidates, trunkX: parent.x, parentY: parent.y };
  }

  /**
   * _familySnapCandidates의 슬롯 버전 — 이 슬롯이 어떤 필드의 "부모-자식" 템플릿 관계(안내선)
   * 에서 자식 역할이면, 그 부모 슬롯 쌍의 중점("절반 길이" 트렁크)을 기준으로 한 n등분 후보를
   * 계산한다. 인물의 _familySnapCandidates와 정확히 같은 공식(AutoLayout.js 기준 트렁크 중심
   * COL_SPACING 간격 n개 슬롯, 세로는 부모 세대+ROW_SPACING)을 그대로 슬롯 데이터에 적용한 것 —
   * "템플릿끼리도 인물과 완전히 동등하게 클리핑"하기 위함.
   */
  _slotFamilySnapCandidates(slotId) {
    for (const field of this.tree.fields.values()) {
      const trs = field.templateRelationships || [];
      for (const tr of trs) {
        if (tr.type === "parent-child" && tr.slotIds[2] === slotId) {
          const [p1Id, p2Id] = tr.slotIds;
          const p1 = field.templateSlots.find((s) => s.id === p1Id);
          const p2 = field.templateSlots.find((s) => s.id === p2Id);
          if (!p1 || !p2) return null;
          const parent1 = { x: field.x + p1.relX, y: field.y + p1.relY };
          const parent2 = { x: field.x + p2.relX, y: field.y + p2.relY };
          // 같은 부모 슬롯 쌍(순서 무관)을 공유하는 "부모-자식" 템플릿 관계 전부 = 형제 수.
          const siblings = trs.filter((t) =>
            t.type === "parent-child" &&
            ((t.slotIds[0] === p1Id && t.slotIds[1] === p2Id) || (t.slotIds[0] === p2Id && t.slotIds[1] === p1Id))
          );
          const n = siblings.length;
          const trunkX = (parent1.x + parent2.x) / 2;
          const parentY = (parent1.y + parent2.y) / 2;
          const mid = (n - 1) / 2;
          const xCandidates = [];
          for (let i = 0; i < n; i++) xCandidates.push({ x: trunkX + (i - mid) * COL_SPACING });
          const yCandidates = [{ y: parentY + ROW_SPACING }];
          return { xCandidates, yCandidates, trunkX, parentY };
        }
        if (tr.type === "parent-child-solo" && tr.slotIds[1] === slotId) {
          const [pId] = tr.slotIds;
          const p = field.templateSlots.find((s) => s.id === pId);
          if (!p) return null;
          const parent = { x: field.x + p.relX, y: field.y + p.relY };
          const siblings = trs.filter((t) => t.type === "parent-child-solo" && t.slotIds[0] === pId);
          const n = siblings.length;
          const mid = (n - 1) / 2;
          const xCandidates = [];
          for (let i = 0; i < n; i++) xCandidates.push({ x: parent.x + (i - mid) * COL_SPACING });
          const yCandidates = [{ y: parent.y + ROW_SPACING }];
          return { xCandidates, yCandidates, trunkX: parent.x, parentY: parent.y };
        }
      }
    }
    return null;
  }

  /**
   * "템플릿 거리" 스냅 — 관계와 상관없이 "모든 인물" 기준으로, 드래그 중인 카드가 다른 어떤 사람
   * 으로부터 자동 정렬과 같은 표준 간격(COL_SPACING 가로 / ROW_SPACING 세로)만큼 떨어진 자리에
   * 오면 달라붙는다. 어느 사람 기준으로 붙었는지 점선으로 보여줄 수 있도록 anchor(그 사람의 좌표)
   * 도 함께 반환한다. alsoMatchSlotId가 있으면(슬롯을 드래그하는 중) 다른 슬롯들도 같은 자격으로
   * 후보에 더한다("템플릿끼리도 클리핑").
   */
  _templateSnapCandidates(person, excludeIds = null, alsoMatchSlotId = undefined) {
    const xCandidates = [];
    const yCandidates = [];
    for (const other of this.tree.people.values()) {
      if (other.id === person.id || excludeIds?.has(other.id)) continue;
      const anchor = { x: other.x, y: other.y };
      xCandidates.push({ x: other.x + COL_SPACING, anchor });
      xCandidates.push({ x: other.x - COL_SPACING, anchor });
      yCandidates.push({ y: other.y + ROW_SPACING, anchor });
      yCandidates.push({ y: other.y - ROW_SPACING, anchor });
    }
    if (alsoMatchSlotId !== undefined) {
      for (const slot of this._slotAbsolutePositions(alsoMatchSlotId)) {
        const anchor = { x: slot.x, y: slot.y };
        xCandidates.push({ x: slot.x + COL_SPACING, anchor });
        xCandidates.push({ x: slot.x - COL_SPACING, anchor });
        yCandidates.push({ y: slot.y + ROW_SPACING, anchor });
        yCandidates.push({ y: slot.y - ROW_SPACING, anchor });
      }
    }
    return { xCandidates, yCandidates };
  }

  /** 모든 필드의 모든 템플릿 슬롯을 절대(월드) 좌표로 나열한다(excludeSlotId 자신은 뺌) —
   * 슬롯을 드래그할 때 "다른 슬롯"도 인물과 동등하게 같은 행/열·표준 칸 간격 스냅 후보로
   * 쓰기 위한 것("템플릿끼리도 클리핑되게"). */
  _slotAbsolutePositions(excludeSlotId) {
    const list = [];
    for (const field of this.tree.fields.values()) {
      for (const slot of field.templateSlots) {
        if (slot.id === excludeSlotId) continue;
        list.push({ id: slot.id, x: field.x + slot.relX, y: field.y + slot.relY });
      }
    }
    return list;
  }

  /**
   * 텍스트 박스를 옮길 때 다른 텍스트 박스와 "같은 종류"의 기준선(왼쪽↔왼쪽, 오른쪽↔오른쪽,
   * 위↔위, 아래↔아래, 가로 중간↔가로 중간, 세로 중간↔세로 중간)이 가까우면 그 값에 달라붙는다.
   * 사람 카드는 중심점 하나로 취급해 스냅했지만, 텍스트 박스는 실제 폭/높이가 있는 사각형이라
   * 가장자리·중간선까지 비교해야 "정렬"이라는 느낌이 난다(왼쪽↔오른쪽처럼 서로 다른 종류를
   * 엇갈려 맞추는 건 지금은 안 함 — 헷갈릴 수 있어서 같은 종류끼리만).
   * 그와 별개로, 인물 카드의 _templateSnapCandidates와 같은 원칙("일정 거리" 스냅 — 정렬과
   * 무관하게 그냥 표준 간격만큼 떨어진 자리에도 붙음)도 중심점 기준으로 검사한다 — 인물과 같은
   * COL_SPACING/ROW_SPACING 단위를 그대로 써서, 텍스트박스를 인물 옆에 나란히 둬도 같은 격자에
   * 놓이게 한다. 이쪽은 "어느 상대 기준으로 붙었는지" anchor를 같이 반환해 ㄱ자 꺾은선으로
   * 보여준다(_computeSnap의 family/template 후보와 같은 방식).
   * excludeIds: 그룹 드래그 중인 다른 멤버(계속 상대 위치가 고정이라 후보로 부적절)는 제외.
   */
  _computeTextBoxSnap(rawX, rawY, box, excludeIds = null) {
    const threshold = SNAP_THRESHOLD_PX / this.camera.scale;
    const w = box.width ?? 200;
    const h = box.height ?? 50;

    let bestX = null, bestXDist = threshold, guideX = null, bestXAnchor = null;
    let bestY = null, bestYDist = threshold, guideY = null, bestYAnchor = null;

    const myXs = [rawX, rawX + w, rawX + w / 2]; // 왼쪽, 오른쪽, 가로 중간
    const myYs = [rawY, rawY + h, rawY + h / 2]; // 위, 아래, 세로 중간
    const myCenterX = rawX + w / 2;
    const myCenterY = rawY + h / 2;

    for (const other of this.tree.textBoxes.values()) {
      if (other.id === box.id || excludeIds?.has(other.id)) continue;
      const ow = other.width ?? 200;
      const oh = other.height ?? 50;
      const theirXs = [other.x, other.x + ow, other.x + ow / 2];
      const theirYs = [other.y, other.y + oh, other.y + oh / 2];

      for (let i = 0; i < 3; i++) {
        const dx = theirXs[i] - myXs[i];
        if (Math.abs(dx) < bestXDist) {
          bestXDist = Math.abs(dx);
          bestX = rawX + dx; // rawX를 그만큼 밀면 내 i번째 기준선이 상대와 정확히 겹친다
          guideX = theirXs[i];
          bestXAnchor = null; // 무한 점선 정렬 가이드로 이미 보여주므로 꺾은선 anchor는 안 둠
        }
        const dy = theirYs[i] - myYs[i];
        if (Math.abs(dy) < bestYDist) {
          bestYDist = Math.abs(dy);
          bestY = rawY + dy;
          guideY = theirYs[i];
          bestYAnchor = null;
        }
      }

      // "일정 거리" 스냅 — 중심점 기준으로 상대로부터 COL_SPACING(가로)/ROW_SPACING(세로)만큼
      // 떨어진 자리에 오면 붙는다(정렬 여부와 무관).
      const theirCenterX = other.x + ow / 2;
      const theirCenterY = other.y + oh / 2;
      const anchor = { x: theirCenterX, y: theirCenterY };
      for (const targetCenterX of [theirCenterX + COL_SPACING, theirCenterX - COL_SPACING]) {
        const dx = targetCenterX - myCenterX;
        if (Math.abs(dx) < bestXDist) {
          bestXDist = Math.abs(dx);
          bestX = rawX + dx;
          guideX = null;
          bestXAnchor = anchor;
        }
      }
      for (const targetCenterY of [theirCenterY + ROW_SPACING, theirCenterY - ROW_SPACING]) {
        const dy = targetCenterY - myCenterY;
        if (Math.abs(dy) < bestYDist) {
          bestYDist = Math.abs(dy);
          bestY = rawY + dy;
          guideY = null;
          bestYAnchor = anchor;
        }
      }
    }

    const x = bestX !== null ? bestX : rawX;
    const y = bestY !== null ? bestY : rawY;

    // anchor가 있는 스냅("일정 거리")은 사람 카드의 family/template 후보와 같은 방식으로 ㄱ자
    // 꺾은선 두 토막으로 보여준다(대각선으로 바로 잇지 않음 — 의미 없는 사선이라 헷갈림).
    const extraGuides = [];
    const myFinalCenterX = x + w / 2;
    const myFinalCenterY = y + h / 2;
    if (bestXAnchor) {
      extraGuides.push({ x1: bestXAnchor.x, y1: bestXAnchor.y, x2: myFinalCenterX, y2: bestXAnchor.y });
      extraGuides.push({ x1: myFinalCenterX, y1: bestXAnchor.y, x2: myFinalCenterX, y2: myFinalCenterY });
    }
    if (bestYAnchor && (!bestXAnchor || bestYAnchor.x !== bestXAnchor.x || bestYAnchor.y !== bestXAnchor.y)) {
      extraGuides.push({ x1: bestYAnchor.x, y1: bestYAnchor.y, x2: bestYAnchor.x, y2: myFinalCenterY });
      extraGuides.push({ x1: bestYAnchor.x, y1: myFinalCenterY, x2: myFinalCenterX, y2: myFinalCenterY });
    }

    return { x, y, guideX, guideY, extraGuides };
  }

  /**
   * 텍스트 박스 리사이즈(모서리 핸들) 중 폭/높이 후보를 계산한다 — 두 갈래를 한 번에 비교해서
   * 더 가까운 쪽이 이긴다: (1) 기존 "글자 크기 배수" 스냅, (2) 다른 텍스트 박스와의 정렬(내
   * 오른쪽 가장자리 또는 가로 중간이 상대의 왼쪽/오른쪽/가로 중간과 같아지는 폭 — 세로도 동일).
   * 왼쪽 위 모서리는 리사이즈 중 안 움직이므로 "내 왼쪽/위"는 후보에 없다(오른쪽/아래/중간만).
   */
  _computeTextBoxResizeSnap(box, rawW, rawH) {
    // 두 후보 갈래가 서로 다른 임계값을 쓴다 — 글자 크기 배수는 원래부터 6px(화면 기준)로
    // 빡빡하게 잡아뒀던 값이라(사이즈가 조금만 늘어도 자꾸 배수에 걸리면 오히려 불편해서),
    // 이번에 추가한 텍스트박스-끼리 정렬은 인물 카드와 같은 SNAP_THRESHOLD_PX(14)를 쓴다.
    // 하나의 공통 threshold로 합치면 font 배수 쪽이 원래보다 훨씬 헐렁해져 버려서(6→14) 따로 둔다.
    const fontThreshold = 6 / this.camera.scale;
    const alignThreshold = SNAP_THRESHOLD_PX / this.camera.scale;
    const fontUnit = box.fontSize || 16;

    let bestW = null, bestWDist = Infinity, guideX = null;
    let bestH = null, bestHDist = Infinity, guideY = null;

    const fontWCandidate = Math.round(rawW / fontUnit) * fontUnit;
    const fontWDist = Math.abs(fontWCandidate - rawW);
    if (fontWDist <= fontThreshold && fontWDist < bestWDist) { bestWDist = fontWDist; bestW = fontWCandidate; }
    const fontHCandidate = Math.round(rawH / fontUnit) * fontUnit;
    const fontHDist = Math.abs(fontHCandidate - rawH);
    if (fontHDist <= fontThreshold && fontHDist < bestHDist) { bestHDist = fontHDist; bestH = fontHCandidate; }

    const myRight = box.x + rawW, myCenterX = box.x + rawW / 2;
    const myBottom = box.y + rawH, myCenterY = box.y + rawH / 2;
    for (const other of this.tree.textBoxes.values()) {
      if (other.id === box.id) continue;
      const ow = other.width ?? 200;
      const oh = other.height ?? 50;
      for (const targetX of [other.x, other.x + ow, other.x + ow / 2]) {
        const dRight = Math.abs(targetX - myRight);
        if (dRight <= alignThreshold && dRight < bestWDist) { bestWDist = dRight; bestW = targetX - box.x; guideX = targetX; }
        const dCenter = Math.abs(targetX - myCenterX);
        if (dCenter <= alignThreshold && dCenter < bestWDist) { bestWDist = dCenter; bestW = (targetX - box.x) * 2; guideX = targetX; }
      }
      for (const targetY of [other.y, other.y + oh, other.y + oh / 2]) {
        const dBottom = Math.abs(targetY - myBottom);
        if (dBottom <= alignThreshold && dBottom < bestHDist) { bestHDist = dBottom; bestH = targetY - box.y; guideY = targetY; }
        const dCenter = Math.abs(targetY - myCenterY);
        if (dCenter <= alignThreshold && dCenter < bestHDist) { bestHDist = dCenter; bestH = (targetY - box.y) * 2; guideY = targetY; }
      }
    }

    return {
      w: bestW !== null ? bestW : rawW,
      h: bestH !== null ? bestH : rawH,
      guideX,
      guideY,
    };
  }

  _setGuide(axis, value) {
    const key = axis === "h" ? "_snapGuideH" : "_snapGuideV";
    if (value === null) {
      if (this[key]) this[key].style.display = "none";
      return;
    }
    if (!this[key]) {
      const el = document.createElementNS(SVG_NS, "line");
      el.setAttribute("class", "snap-guide");
      if (axis === "h") {
        el.setAttribute("x1", "-100000");
        el.setAttribute("x2", "100000");
      } else {
        el.setAttribute("y1", "-100000");
        el.setAttribute("y2", "100000");
      }
      this.linesEl.appendChild(el);
      this[key] = el;
    }
    const el = this[key];
    if (axis === "h") {
      el.setAttribute("y1", value);
      el.setAttribute("y2", value);
    } else {
      el.setAttribute("x1", value);
      el.setAttribute("x2", value);
    }
    // display를 ""로만 비우면 인라인 스타일이 사라질 뿐, CSS 클래스 쪽의 display:none으로 그대로
    // 떨어져서 실제로는 계속 안 보인다("보이게 했다"고 착각하기 쉬운 버그) — 명시적으로 켜야 한다.
    el.style.display = "inline";
  }

  _hideSnapGuides() {
    if (this._snapGuideH) this._snapGuideH.style.display = "none";
    if (this._snapGuideV) this._snapGuideV.style.display = "none";
    this._setExtraGuides([]);
  }

  /**
   * 중심/n등분/템플릿 간격 스냅 중 하나로 붙었을 때, 그 스냅이 "누구의 어디"를 기준으로 한 것인지
   * 보여주는 점선들 — x축 스냅과 y축 스냅이 서로 다른 기준(예: 부모 쌍의 중점 vs 다른 인물)에서
   * 왔을 수 있어 최대 2개까지 동시에 그릴 수 있다. 엘리먼트를 매번 새로 만들지 않고 풀(pool)처럼
   * 재사용하고, 이번에 안 쓰는 나머지는 숨긴다.
   */
  _setExtraGuides(guides) {
    if (!this._extraGuideEls) this._extraGuideEls = [];
    for (let i = 0; i < guides.length; i++) {
      let el = this._extraGuideEls[i];
      if (!el) {
        el = document.createElementNS(SVG_NS, "line");
        el.setAttribute("class", "family-snap-guide");
        this.linesEl.appendChild(el);
        this._extraGuideEls[i] = el;
      }
      const g = guides[i];
      el.setAttribute("x1", g.x1);
      el.setAttribute("y1", g.y1);
      el.setAttribute("x2", g.x2);
      el.setAttribute("y2", g.y2);
      el.style.display = "inline"; // ""는 CSS 클래스의 display:none으로 되돌아갈 뿐이라 명시적으로 켜야 한다.
    }
    for (let i = guides.length; i < this._extraGuideEls.length; i++) {
      if (this._extraGuideEls[i]) this._extraGuideEls[i].style.display = "none";
    }
  }

  /** 카드 드래그 중에만 화면 아래 가운데 휴지통을 보여준다. */
  _showTrash() {
    this.trashEl?.classList.add("visible");
  }

  _hideTrash() {
    this.trashEl?.classList.remove("visible", "armed");
  }

  _setTrashArmed(armed) {
    this.trashEl?.classList.toggle("armed", !!armed);
  }

  /** 화면 좌표(clientX/Y)가 휴지통(화면에 고정된 UI) 위에 있는지 확인한다. */
  _isOverTrash(clientX, clientY) {
    if (!this.trashEl) return false;
    const r = this.trashEl.getBoundingClientRect();
    return clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom;
  }

  _addLine(rel) {
    const g = createLineElement(rel);
    this.linesEl.appendChild(g);
    this.lineEls.set(rel.id, g);
    this._applyLineScale(g);
    this._updateLine(rel.id);
  }

  /** 이 관계선 하나의 stroke-width를 지금 배율(camera.scale) 기준으로 다시 계산해 넣는다 —
   * applyLineStyle이 stroke-width를 고정값(월드 좌표계)으로 초기화해버리는 모든 경로(생성/색상
   * 변경 등) 뒤에, 그리고 배율 자체가 바뀔 때마다 불러야 한다. */
  _applyLineScale(g) {
    const scale = this.camera.scale || 1;
    const isSelected = g.classList.contains("selected");
    const visible = g.querySelector(".rel-line-visible");
    if (visible) visible.setAttribute("stroke-width", (isSelected ? LINE_SELECTED_TARGET_SCREEN_PX : LINE_TARGET_SCREEN_PX) / scale);
    const hit = g.querySelector(".rel-line-hit");
    if (hit) hit.setAttribute("stroke-width", LINE_HIT_TARGET_SCREEN_PX / scale);
  }

  /** 화면 확대/축소가 바뀔 때마다(main.js가 camera.onChange에서 불러줌) 지금 그려진 관계선
   * 전부의 굵기를 다시 계산한다. */
  updateLineScaleForZoom() {
    for (const g of this.lineEls.values()) this._applyLineScale(g);
  }

  /**
   * "부모-자식(부모1)"(parent-child-solo)은 배우자 유무와 상관없이 항상 부모 카드에서 자식
   * 카드로 곧장 이어지는 가장 단순한 직선이다 — 부부 중 한쪽만 표시하고 싶을 때 쓴다.
   *
   * "부모-자식(부모2)"(parent-child)는 rel.viaSpouseId(없으면 _spousesOf(a.id)[0]로 추측)를
   * 배우자로 삼아, 그 부부 사이에 자식이 하나뿐이면 배우자 선 위에서 자식 바로 위에 해당하는
   * 지점까지 내려오는 완전한 직선을 그린다(중간에 꺾이지 않음, 기울어진 배우자 선도 선형보간으로
   * 정확히 그 위에서 시작). 같은 부부 사이에 자식이 둘 이상이면(형제자매), 자식마다 배우자 선의
   * 다른 지점에서 각자 내려오는 대신 — 부부 중점에서 트렁크가 내려와 자식들 사이의 공용
   * "버스 바(bus line)"에 이어지고, 그 버스 바에서 각 자식에게 짧은 세로 스텁이 갈라지는
   * 표준 가계도(족보) 모양으로 그린다.
   */
  _computeLinePoints(rel, a, b) {
    if (rel.type === "arrow") {
      // 화살촉(marker-end/marker-start)이 카드 밑에 완전히 가려버리지 않도록, 끝점을 사진 원
      // 가장자리까지만 당긴다(다른 유형은 중심까지 그어도 카드가 덮어서 문제없지만, 화살촉은
      // 카드 밖으로 튀어나와야 보이므로 이 유형만 예외). 양방향(bidirectional)이면 양쪽 다 화살촉이
      // 붙으므로 두 끝 모두 당겨야 한다.
      if (rel.bidirectional) {
        return [this._pullBackToPhotoEdge(b, a), this._pullBackToPhotoEdge(a, b)];
      }
      return [{ x: a.x, y: a.y }, this._pullBackToPhotoEdge(a, b)];
    }
    if (rel.type !== "parent-child") {
      return [{ x: a.x, y: a.y }, { x: b.x, y: b.y }];
    }
    // parent-child-solo는 위에서 이미 걸러졌으니, 여기서부터는 항상 "부모2"(배우자 anchoring) 로직.
    const partner = this._partnerFor(rel, a);
    if (!partner) {
      return [{ x: a.x, y: a.y }, { x: b.x, y: b.y }];
    }
    const siblingRels = this._siblingGroup(rel);
    if (siblingRels.length <= 1) {
      const minX = Math.min(a.x, partner.x);
      const maxX = Math.max(a.x, partner.x);
      const dropX = Math.min(maxX, Math.max(minX, b.x));
      const t = partner.x !== a.x ? (dropX - a.x) / (partner.x - a.x) : 0;
      const dropY = a.y + (partner.y - a.y) * t;
      return [
        { x: dropX, y: dropY },
        { x: b.x, y: b.y },
      ];
    }
    // 자식이 둘 이상 — 트렁크(부부 중점 → 버스 y) + 버스 바(트렁크 x → 자식 x) + 자식 스텁.
    const trunkX = (a.x + partner.x) / 2;
    const trunkY = (a.y + partner.y) / 2;
    const children = siblingRels.map((r) => this.tree.people.get(r.toId)).filter(Boolean);
    const minChildY = Math.min(...children.map((c) => c.y));
    let busY = trunkY + (minChildY - trunkY) * 0.5;
    if (busY - trunkY < 20) busY = trunkY + 20; // 부모와 너무 가까워지지 않도록 최소 간격 보장
    return [
      { x: trunkX, y: trunkY },
      { x: trunkX, y: busY },
      { x: b.x, y: busY },
      { x: b.x, y: b.y },
    ];
  }

  /** b를 a 방향으로 사진 반지름만큼 당긴 점을 돌려준다(화살표 유형 전용). 두 사람이 반지름보다
   * 가까이 붙어 있어 부호가 뒤집힐 수 있는 경우엔 0으로 clamp해서 화살촉이 튕겨나가지 않게 한다. */
  _pullBackToPhotoEdge(a, b) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len < 1) return { x: b.x, y: b.y };
    const t = Math.max(0, (len - this._photoRadius) / len);
    return { x: a.x + dx * t, y: a.y + dy * t };
  }

  /** rel(부모-자식/부모2)의 배우자를 찾는다 — viaSpouseId가 있으면 그걸 우선하고, 없으면(예전 데이터) 첫 배우자로 추측한다. */
  _partnerFor(rel, a) {
    if (rel.viaSpouseId) {
      const p = this.tree.people.get(rel.viaSpouseId);
      if (p) return p;
    }
    return this._spousesOf(a.id)[0] || null;
  }

  /** rel과 같은 부모 쌍(순서 무관)을 공유하는 모든 "부모-자식(부모2)" 관계선을 모은다(형제자매 그룹). */
  _parentPairKey(rel) {
    const a = this.tree.people.get(rel.fromId);
    if (!a) return null;
    const partner = this._partnerFor(rel, a);
    if (!partner) return null;
    return [a.id, partner.id].sort().join("|");
  }

  _siblingGroup(rel) {
    const key = this._parentPairKey(rel);
    if (!key) return [rel];
    const group = [];
    for (const r of this.tree.relationships.values()) {
      if (r.type === "parent-child" && this._parentPairKey(r) === key) group.push(r);
    }
    return group;
  }

  _spousesOf(personId) {
    const partners = [];
    for (const r of this.tree.relationships.values()) {
      if (r.type !== "spouse") continue;
      if (r.fromId === personId) {
        const p = this.tree.people.get(r.toId);
        if (p) partners.push(p);
      } else if (r.toId === personId) {
        const p = this.tree.people.get(r.fromId);
        if (p) partners.push(p);
      }
    }
    return partners;
  }

  _updateLine(id) {
    const rel = this.tree.relationships.get(id);
    const g = this.lineEls.get(id);
    if (!rel || !g) return;
    const a = this.tree.people.get(rel.fromId);
    const b = this.tree.people.get(rel.toId);
    if (!a || !b) return;
    updateLinePosition(g, this._computeLinePoints(rel, a, b));
  }

  /** personId 하나가 움직였을 때 다시 그려야 하는 관계선 id 집합을 계산만 한다(그리지는 않음) —
   * 순수 계산 부분을 따로 빼서 _updateLinesFor(단일 이동, 즉시 계산+그리기)와 그룹 드래그
   * (_beginGroupDrag가 멤버 전원에 대해 한 번만 합집합을 구해 캐싱)가 이 로직을 공유하게 한다.
   * 그룹 드래그 중 매 프레임마다 멤버 수 × 관계 수만큼 이 계산을 반복하면(예전 구현) 인원이 많을
   * 때 버벅였다 — 그래서 그룹 쪽은 이 함수를 프레임마다가 아니라 드래그 시작 시 딱 한 번만 쓴다. */
  _affectedLineIds(personId) {
    const affected = new Set();
    for (const rel of this.tree.relationships.values()) {
      if (rel.fromId === personId || rel.toId === personId || rel.viaSpouseId === personId) {
        affected.add(rel.id);
        continue;
      }
      // viaSpouseId 없이 저장된 예전 데이터: 배우자를 옮기면 자식 쪽 선도 함께 갱신되도록 추측해서 잡는다.
      if (rel.type === "parent-child" && !rel.viaSpouseId) {
        const partners = this._spousesOf(rel.fromId);
        if (partners.some((p) => p.id === personId)) affected.add(rel.id);
      }
    }
    // 부모-자식(부모2)는 형제자매끼리 트렁크/버스 바를 공유하므로(자식 하나만 움직여도 버스 y가,
    // 부모가 움직이면 트렁크 x/y가 바뀐다), 위에서 하나라도 걸린 부모 쌍의 나머지 형제 선도 모두
    // 함께 다시 그려야 한다.
    const groupKeys = new Set();
    for (const relId of affected) {
      const rel = this.tree.relationships.get(relId);
      if (rel && rel.type === "parent-child") {
        const key = this._parentPairKey(rel);
        if (key) groupKeys.add(key);
      }
    }
    if (groupKeys.size) {
      for (const rel of this.tree.relationships.values()) {
        if (rel.type === "parent-child" && groupKeys.has(this._parentPairKey(rel))) affected.add(rel.id);
      }
    }
    return affected;
  }

  _updateLinesFor(personId) {
    for (const relId of this._affectedLineIds(personId)) this._updateLine(relId);
  }

  /** 부모-자식(부모2) 선을 전부 다시 그린다 — 형제자매 그룹 구성이 바뀌는(자식/부모 추가·삭제) 시점에 쓴다. */
  _refreshAllParentChildLines() {
    for (const rel of this.tree.relationships.values()) {
      if (rel.type === "parent-child") this._updateLine(rel.id);
    }
  }

  async _handle(type, payload) {
    switch (type) {
      case "person:add":
        await this._addCard(payload);
        break;
      case "person:update": {
        const el = this.cardEls.get(payload.id);
        if (!el) break;
        const photoUrl = await this._resolvePhotoUrl(payload);
        applyCardData(el, payload, photoUrl);
        this._updateLinesFor(payload.id);
        break;
      }
      case "person:remove": {
        this.cardEls.get(payload)?.remove();
        this.cardEls.delete(payload);
        this.cardDrags.get(payload)?.destroy();
        this.cardDrags.delete(payload);
        for (const [relId, g] of [...this.lineEls]) {
          if (!this.tree.relationships.has(relId)) {
            g.remove();
            this.lineEls.delete(relId);
          }
        }
        // 삭제된 사람이 어느 부모-자식(부모2) 그룹의 부모/자식이었다면, 남은 형제 선의
        // 트렁크/버스 바 구조가 바뀔 수 있으므로(예: 자식이 하나만 남으면 단순 직선으로 돌아감) 다시 그린다.
        this._refreshAllParentChildLines();
        break;
      }
      case "relationship:add":
        this._addLine(payload);
        // 부부에게 새 자식이 추가되면, 그 부부의 기존 자식 선도 단순 직선 → 트렁크+버스 바 구조로
        // 함께 바뀌어야 하므로(형제자매가 둘 이상이 되는 순간) 같은 유형의 모든 선을 다시 그린다.
        if (payload.type === "parent-child") this._refreshAllParentChildLines();
        break;
      case "relationship:update": {
        const g = this.lineEls.get(payload.id);
        if (g) {
          applyLineStyle(g, payload);
          this._applyLineScale(g); // applyLineStyle이 되돌려놓은 stroke-width를 화면 배율에 맞게 다시 계산
          this._updateLine(payload.id);
          if (payload.type === "parent-child") this._refreshAllParentChildLines();
        }
        break;
      }
      case "relationship:remove":
        this.lineEls.get(payload)?.remove();
        this.lineEls.delete(payload);
        // 이 시점엔 지워진 관계의 정보를 알 수 없으므로(이미 tree에서 삭제됨), 남은 형제 선이
        // 트렁크/버스 바 구조를 되돌려야 할 수도 있다고 보고 모든 부모-자식(부모2) 선을 다시 그린다.
        this._refreshAllParentChildLines();
        break;
      case "textbox:add":
        this._addTextBox(payload);
        break;
      case "textbox:update": {
        const el = this.textBoxEls.get(payload.id);
        if (el) applyTextBoxData(el, payload);
        break;
      }
      case "textbox:remove": {
        this.textBoxEls.get(payload)?.remove();
        this.textBoxEls.delete(payload);
        const drags = this.textBoxDrags.get(payload);
        if (drags) { drags.moveDrag.destroy(); drags.resizeDrag.destroy(); drags.resizeDragTL.destroy(); }
        this.textBoxDrags.delete(payload);
        break;
      }
      case "field:add":
        this._addField(payload);
        break;
      case "field:update": {
        const el = this.fieldEls.get(payload.id);
        if (el) {
          applyFieldData(el, payload);
          this._syncFieldSlots(payload, el);
          this._syncTemplateRelLines(payload, el);
        }
        break;
      }
      case "field:remove": {
        const fieldEl = this.fieldEls.get(payload);
        for (const slotEl of fieldEl?.querySelectorAll(".field-slot") ?? []) {
          this.slotDrags.get(slotEl.dataset.slotId)?.destroy();
          this.slotDrags.delete(slotEl.dataset.slotId);
        }
        fieldEl?.remove();
        this.fieldEls.delete(payload);
        const drags = this.fieldDrags.get(payload);
        if (drags) { drags.moveDrag.destroy(); drags.resizeDrag.destroy(); drags.resizeDragTL.destroy(); }
        this.fieldDrags.delete(payload);
        break;
      }
      case "reset":
        await this.renderAll();
        break;
    }
  }
}
