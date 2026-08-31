import { createCardElement, applyCardData, attachCardDrag } from "../ui/PersonCard.js";
import { createLineElement, applyLineStyle, updateLinePosition, TYPE_LABEL } from "../ui/RelationshipLine.js";
import { createTextBoxElement, applyTextBoxData, attachTextBoxDrag, attachTextBoxResize } from "../ui/TextBox.js";
import { ROW_SPACING, COL_SPACING } from "../core/AutoLayout.js";

const SVG_NS = "http://www.w3.org/2000/svg";

// 드래그 중인 카드가 다른 카드/템플릿 칸에 "달라붙는" 스냅(클리핑) 판정 거리 — 화면 픽셀 기준
// (camera.scale로 나눠 월드 좌표로 환산해서 씀). 예전엔 8이라 너무 빡빡해서(살짝만 어긋나도 안
// 붙음) 잘 안 달라붙는다는 피드백이 있어 키웠다.
const SNAP_THRESHOLD_PX = 14;

/** TreeModel의 변화를 구독해 사람 카드(DOM)와 관계선(SVG)을 동기화한다. */
export class TreeRenderer {
  constructor({ tree, worldEl, linesEl, camera, store, onCardClick, onLineClick, onTextBoxClick, trashEl }) {
    this.tree = tree;
    this.worldEl = worldEl;
    this.linesEl = linesEl;
    this.camera = camera;
    this.store = store;
    this.onCardClick = onCardClick;
    this.onLineClick = onLineClick;
    this.onTextBoxClick = onTextBoxClick;
    this.trashEl = trashEl;

    this.cardEls = new Map();
    this.cardDrags = new Map(); // personId -> DragController (카드 삭제 시 destroy()로 정리해야 함)
    this.lineEls = new Map();
    this.photoUrls = new Map(); // photoId -> objectURL 캐시

    this.textBoxEls = new Map();
    this.textBoxDrags = new Map(); // textBoxId -> { moveDrag, resizeDrag } (둘 다 destroy() 필요)

    // 마키(배경 Shift+드래그)로 한 번에 여러 개를 고른 상태 — 사이드바를 여는 단일 선택과는 별개다.
    this.multiSelected = { people: new Set(), textBoxes: new Set() };
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
    for (const drags of this.textBoxDrags.values()) { drags.moveDrag.destroy(); drags.resizeDrag.destroy(); }
    this.worldEl.innerHTML = "";
    this.linesEl.innerHTML = "";
    this.cardEls.clear();
    this.cardDrags.clear();
    this.lineEls.clear();
    this.textBoxEls.clear();
    this.textBoxDrags.clear();
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
    this._groupDragState = null;
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

  /** 사람 카드의 setSelected와 같은 역할 — 텍스트 박스 쪽 선택 강조(사이드바가 열려 있는 대상). */
  setSelectedTextBox(id) {
    for (const [bid, el] of this.textBoxEls) el.classList.toggle("selected", bid === id);
  }

  /** 사람 카드의 setSelected와 같은 역할 — 관계선 쪽 선택 강조(사이드바가 열려 있는 대상). */
  setSelectedLine(id) {
    for (const [rid, el] of this.lineEls) el.classList.toggle("selected", rid === id);
  }

  /** 배경을 Shift+드래그해서 만든 마키 사각형 안에 들어온 인물/텍스트박스를 한꺼번에 선택 상태로
   * 만든다 — 사이드바(단일 선택)와는 별개라, 이게 켜져 있으면 사이드바는 닫혀 있고 대신 상단
   * 벌크 툴바가 뜬다(main.js가 관리). */
  setMultiSelection({ people = [], textBoxes = [] } = {}) {
    this.multiSelected.people = new Set(people);
    this.multiSelected.textBoxes = new Set(textBoxes);
    for (const [pid, el] of this.cardEls) el.classList.toggle("selected", this.multiSelected.people.has(pid));
    for (const [bid, el] of this.textBoxEls) el.classList.toggle("selected", this.multiSelected.textBoxes.has(bid));
  }

  clearMultiSelection() {
    if (!this.multiSelected.people.size && !this.multiSelected.textBoxes.size) return;
    for (const pid of this.multiSelected.people) this.cardEls.get(pid)?.classList.remove("selected");
    for (const bid of this.multiSelected.textBoxes) this.textBoxEls.get(bid)?.classList.remove("selected");
    this.multiSelected.people.clear();
    this.multiSelected.textBoxes.clear();
  }

  getMultiSelectionCount() {
    return this.multiSelected.people.size + this.multiSelected.textBoxes.size;
  }

  /** 지금 마키로 골라둔 대상들(잠긴 것도 포함) 전체를 한 번에 잠그거나 푼다. */
  setLockedForSelection(locked) {
    for (const id of this.multiSelected.people) this.tree.updatePerson(id, { locked });
    for (const id of this.multiSelected.textBoxes) this.tree.updateTextBox(id, { locked });
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
    return this.getMultiSelectionCount() > 0;
  }

  /** 마키 선택 인원이 2명 이상일 때, 그중 하나를 드래그하면 전체가 같은 만큼 같이 움직인다 —
   * 잠긴 대상은 처음 좌표를 기록 대상에서 빼서 그것만 안 움직이게 한다(선택 자체는 유지).
   * anchorId/anchorType: 실제로 손으로 잡아 끄는 대상 — 그룹 전체는 서로 상대 위치를 유지한 채
   * 통째로 움직이되, 스냅(자동 클리핑)은 이 anchor 하나만 기준으로 검사해서 그 결과(스냅으로
   * 보정된 만큼)를 그룹 전체에 동일하게 더해준다("이 카드를 스냅에 맞추면 나머지도 딱 붙어 따라
   * 온다"는 느낌). anchor가 텍스트박스면(원래도 텍스트박스는 스냅이 없었으므로) 스냅 없이 그냥
   * 델타만 적용한다. */
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
    }

    // 모델 좌표만 갱신한다(가벼움) — 실제 DOM 반영(카드/텍스트박스 위치 + 영향받는 관계선 다시
    // 그리기)은 _scheduleGroupVisualUpdate가 프레임당 한 번으로 묶어서 처리한다.
    for (const [id, start] of g.positions) {
      const nx = start.x + g.dx + snapDx;
      const ny = start.y + g.dy + snapDy;
      if (start.type === "person") {
        const p = this.tree.people.get(id);
        if (p) { p.x = nx; p.y = ny; }
      } else {
        const b = this.tree.textBoxes.get(id);
        if (b) { b.x = nx; b.y = ny; }
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
        } else {
          const b = this.tree.textBoxes.get(id);
          const el = this.textBoxEls.get(id);
          if (b && el) {
            el.style.left = `${b.x}px`;
            el.style.top = `${b.y}px`;
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
        else this.tree.removeTextBox(id);
      }
      this.clearMultiSelection();
      return;
    }
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

    const drag = attachCardDrag(el, {
      getScale: () => this.camera.scale,
      onDragStart: () => {
        if (person.locked) return; // 잠긴 인물은 드래그로 못 옮긴다 — 휴지통 힌트도 안 보여준다.
        // 마키로 2개 이상 골라둔 상태에서 그중 하나를 끌면, 그 묶음 전체가 같이 움직인다.
        if (this.multiSelected.people.has(person.id) && this.getMultiSelectionCount() >= 2) {
          this._beginGroupDrag(person.id, "person");
        } else {
          rawX = person.x;
          rawY = person.y;
        }
        this._showTrash();
      },
      onMove: (dx, dy, e) => {
        if (person.locked) return;
        if (this._groupDragState) {
          this._updateGroupDrag(dx, dy);
        } else {
          rawX += dx;
          rawY += dy;
          const snapped = this._computeSnap(rawX, rawY, person);
          person.x = snapped.x;
          person.y = snapped.y;
          this._setGuide("h", snapped.guideY);
          this._setGuide("v", snapped.guideX);
          this._setExtraGuides(snapped.extraGuides);
          this._scheduleVisualUpdate(person, el);
        }
        this._setTrashArmed(e && this._isOverTrash(e.clientX, e.clientY));
      },
      onMoveEnd: (e) => {
        if (person.locked) return;
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
        this.tree.updatePerson(person.id, { x: person.x, y: person.y });
      },
      onClick: () => this.onCardClick(person.id),
    });

    this.worldEl.appendChild(el);
    this.cardEls.set(person.id, el);
    this.cardDrags.set(person.id, drag);
  }

  /** 자유 텍스트 오브젝트 카드 — 사람 카드와 달리 스냅 없이 자유 이동, 클릭하면 바로 편집. */
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
          box.x = rawX;
          box.y = rawY;
          el.style.left = `${box.x}px`;
          el.style.top = `${box.y}px`;
        }
        this._setTrashArmed(e && this._isOverTrash(e.clientX, e.clientY));
      },
      onMoveEnd: (e) => {
        if (box.locked) return;
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
        // 상자 폭/높이가 지금 글자 크기(box.fontSize)의 배수에 거의 맞아떨어지면 그 값에 달라붙는다
        // ("자동 클리핑") — 예: 글자 크기가 20이면 40/60/80...에 가까워질 때 정확히 그 값이 된다.
        // 인물 카드 스냅과 같은 방식으로, 화면 기준 오차(줌 배율 반영)를 threshold로 둔다.
        const threshold = 6 / this.camera.scale;
        const snapToFontUnit = (raw) => {
          const unit = box.fontSize || 16;
          const nearest = Math.round(raw / unit) * unit;
          return Math.abs(nearest - raw) <= threshold ? nearest : raw;
        };
        const w = Math.max(MIN_W, Math.round(snapToFontUnit(rawW)));
        const h = Math.max(MIN_H, Math.round(snapToFontUnit(rawH)));
        const content = el.querySelector(".text-box-content");
        content.style.width = `${w}px`;
        content.style.height = `${h}px`;
      },
      onResizeEnd: () => {
        const content = el.querySelector(".text-box-content");
        const w = parseFloat(content.style.width) || box.width;
        const h = parseFloat(content.style.height) || box.height;
        this.tree.updateTextBox(box.id, { width: w, height: h });
      },
    });

    this.worldEl.appendChild(el);
    this.textBoxEls.set(box.id, el);
    this.textBoxDrags.set(box.id, { moveDrag, resizeDrag });
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
  _computeSnap(rawX, rawY, person, excludeIds = null) {
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

    // 템플릿 간격(표준 칸 간격) 스냅은 특정 관계와 상관없이 "모든 인물" 기준으로 검사한다.
    const template = this._templateSnapCandidates(person, excludeIds);
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
   * "템플릿 거리" 스냅 — 관계와 상관없이 "모든 인물" 기준으로, 드래그 중인 카드가 다른 어떤 사람
   * 으로부터 자동 정렬과 같은 표준 간격(COL_SPACING 가로 / ROW_SPACING 세로)만큼 떨어진 자리에
   * 오면 달라붙는다. 어느 사람 기준으로 붙었는지 점선으로 보여줄 수 있도록 anchor(그 사람의 좌표)
   * 도 함께 반환한다.
   */
  _templateSnapCandidates(person, excludeIds = null) {
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
    return { xCandidates, yCandidates };
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
    this._updateLine(rel.id);
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
        if (drags) { drags.moveDrag.destroy(); drags.resizeDrag.destroy(); }
        this.textBoxDrags.delete(payload);
        break;
      }
      case "reset":
        await this.renderAll();
        break;
    }
  }
}
