import { createCardElement, applyCardData, attachCardDrag } from "../ui/PersonCard.js";
import { createLineElement, applyLineStyle, updateLinePosition, TYPE_LABEL } from "../ui/RelationshipLine.js";
import { ROW_SPACING, COL_SPACING } from "../core/AutoLayout.js";

const SVG_NS = "http://www.w3.org/2000/svg";

/** TreeModel의 변화를 구독해 사람 카드(DOM)와 관계선(SVG)을 동기화한다. */
export class TreeRenderer {
  constructor({ tree, worldEl, linesEl, camera, store, onCardClick, onLineClick, trashEl }) {
    this.tree = tree;
    this.worldEl = worldEl;
    this.linesEl = linesEl;
    this.camera = camera;
    this.store = store;
    this.onCardClick = onCardClick;
    this.onLineClick = onLineClick;
    this.trashEl = trashEl;

    this.cardEls = new Map();
    this.cardDrags = new Map(); // personId -> DragController (카드 삭제 시 destroy()로 정리해야 함)
    this.lineEls = new Map();
    this.photoUrls = new Map(); // photoId -> objectURL 캐시

    this._editingRelId = null; // 지금 텍스트를 편집 중인 관계선 id(한 번에 하나만)

    tree.onChange((type, payload) => this._handle(type, payload));
    linesEl.addEventListener("click", (e) => {
      // 텍스트가 비어 있는(기본 라벨을 없앤) 관계선도 그 자리를 클릭해 라벨을 넣을 수 있도록,
      // 보이는 텍스트뿐 아니라 보이지 않는 라벨 클릭 영역(.rel-line-label-hit)도 함께 확인한다.
      const labelEl = e.target.closest(".rel-line-label, .rel-line-label-hit");
      if (labelEl) {
        const g = labelEl.closest(".rel-line");
        if (g) this._startLabelEdit(g.dataset.id);
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
    this.worldEl.innerHTML = "";
    this.linesEl.innerHTML = "";
    this.cardEls.clear();
    this.cardDrags.clear();
    this.lineEls.clear();
    // linesEl을 통째로 비웠으니, 스냅 가이드 엘리먼트도 DOM에서 떨어져 나갔다 — 참조를 들고 있으면
    // 다음 번엔 그 죽은 엘리먼트에다 속성만 바꾸고 화면엔 안 나타나는 버그가 생기므로 같이 지운다.
    this._snapGuideH = null;
    this._snapGuideV = null;
    this._extraGuideEls = null;
    for (const person of this.tree.people.values()) await this._addCard(person);
    for (const rel of this.tree.relationships.values()) this._addLine(rel);
  }

  setSelected(id) {
    for (const [pid, el] of this.cardEls) el.classList.toggle("selected", pid === id);
  }

  /** 관계 연결 모드처럼 한 번에 여러 명(부모1/부모2/자식 등)을 순서대로 고르는 동안 다중 강조할 때 쓴다. */
  setSelectedMany(ids) {
    const set = new Set(ids);
    for (const [pid, el] of this.cardEls) el.classList.toggle("selected", set.has(pid));
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
        rawX = person.x;
        rawY = person.y;
        this._showTrash();
      },
      onMove: (dx, dy, e) => {
        rawX += dx;
        rawY += dy;
        const snapped = this._computeSnap(rawX, rawY, person);
        person.x = snapped.x;
        person.y = snapped.y;
        this._setGuide("h", snapped.guideY);
        this._setGuide("v", snapped.guideX);
        this._setExtraGuides(snapped.extraGuides);
        this._scheduleVisualUpdate(person, el);
        this._setTrashArmed(e && this._isOverTrash(e.clientX, e.clientY));
      },
      onMoveEnd: (e) => {
        this._hideSnapGuides();
        this._flushVisualUpdate(person, el);
        const droppedOnTrash = e && this._isOverTrash(e.clientX, e.clientY);
        this._hideTrash();
        if (droppedOnTrash) {
          if (confirm("이 인물을 삭제할까요? 연결된 관계선도 함께 삭제됩니다.")) {
            this.tree.removePerson(person.id);
            return;
          }
        }
        this.tree.updatePerson(person.id, { x: person.x, y: person.y });
      },
      onClick: () => this.onCardClick(person.id),
    });

    this.worldEl.appendChild(el);
    this.cardEls.set(person.id, el);
    this.cardDrags.set(person.id, drag);
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
  _computeSnap(rawX, rawY, person) {
    const excludeId = person.id;
    const threshold = 8 / this.camera.scale;
    let bestY = null;
    let bestYDist = threshold;
    let bestYAnchor = null; // 이 스냅이 "누구/어디" 기준인지 — 있으면 점선으로 보여준다.
    let bestX = null;
    let bestXDist = threshold;
    let bestXAnchor = null;
    for (const other of this.tree.people.values()) {
      if (other.id === excludeId) continue;
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
    const family = this._familySnapCandidates(person);
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
    const template = this._templateSnapCandidates(person);
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

    const extraGuides = [];
    if (bestXAnchor) extraGuides.push({ x1: bestXAnchor.x, y1: bestXAnchor.y, x2: x, y2: y });
    if (bestYAnchor && (!bestXAnchor || bestYAnchor.x !== bestXAnchor.x || bestYAnchor.y !== bestXAnchor.y)) {
      extraGuides.push({ x1: bestYAnchor.x, y1: bestYAnchor.y, x2: x, y2: y });
    }

    return { x, y, guideX: bestX, guideY: bestY, extraGuides };
  }

  /**
   * person이 "부모-자식(부모2)" 관계의 자식이고 부모 두 명을 모두 확인할 수 있으면, 그 부모 쌍을
   * 기준으로 한 가로(x)/세로(y) 스냅 후보를 만든다 — 자동 정렬이 형제들을 배치하는 규칙과 같은
   * 지점들이라, 손으로 옮겨도 "자동 정렬했을 때의 자리"에 자연스럽게 달라붙는다("클리핑").
   *   1) 부모 선(부부 사이 구간)의 정중앙 — "선의 중심"
   *   2) 그 구간을 (형제 수)등분한 지점들 — "n등분된곳" (자신을 포함한 형제 수만큼 등분)
   * 세로(y)는 부모 세대보다 정확히 한 세대(ROW_SPACING) 아래인 지점.
   * (표준 칸 간격 스냅은 이제 _templateSnapCandidates가 모든 인물 기준으로 따로 처리한다.)
   */
  _familySnapCandidates(person) {
    let rel = null;
    for (const r of this.tree.relationships.values()) {
      if (r.type === "parent-child" && r.toId === person.id) {
        rel = r;
        break;
      }
    }
    if (!rel) return null;
    const parent1 = this.tree.people.get(rel.fromId);
    const parent2 = this._partnerFor(rel, parent1);
    if (!parent1 || !parent2) return null;

    const n = this._siblingGroup(rel).length; // 이 사람 자신도 포함된, 이 부모 쌍의 전체 자식 수
    const trunkX = (parent1.x + parent2.x) / 2;
    const parentY = (parent1.y + parent2.y) / 2;

    const xCandidates = [{ x: trunkX }]; // 1) 선의 중심
    if (n >= 2) {
      for (let k = 1; k < n; k++) {
        xCandidates.push({ x: parent1.x + (parent2.x - parent1.x) * (k / n) }); // 2) n등분점
      }
    }

    const yCandidates = [{ y: parentY + ROW_SPACING }]; // 부모 세대 + 1

    return { xCandidates, yCandidates, trunkX, parentY };
  }

  /**
   * "템플릿 거리" 스냅 — 관계와 상관없이 "모든 인물" 기준으로, 드래그 중인 카드가 다른 어떤 사람
   * 으로부터 자동 정렬과 같은 표준 간격(COL_SPACING 가로 / ROW_SPACING 세로)만큼 떨어진 자리에
   * 오면 달라붙는다. 어느 사람 기준으로 붙었는지 점선으로 보여줄 수 있도록 anchor(그 사람의 좌표)
   * 도 함께 반환한다.
   */
  _templateSnapCandidates(person) {
    const xCandidates = [];
    const yCandidates = [];
    for (const other of this.tree.people.values()) {
      if (other.id === person.id) continue;
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

  _updateLinesFor(personId) {
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
    for (const relId of affected) this._updateLine(relId);
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
      case "reset":
        await this.renderAll();
        break;
    }
  }
}
