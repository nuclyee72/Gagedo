import { uuid } from "../utils/uuid.js";

/**
 * 가계도 데이터 모델. Person(사람)과 Relationship(관계) 컬렉션을 들고 있으며,
 * 변경이 생길 때마다 등록된 리스너에게 알린다. (렌더러 / 자동저장 / 실행취소가 각자 구독)
 */
export class TreeModel {
  constructor() {
    this.people = new Map(); // id -> Person
    this.relationships = new Map(); // id -> Relationship
    this.textBoxes = new Map(); // id -> TextBox (사람/관계와 무관한 자유 메모용 텍스트 오브젝트)
    this.fields = new Map(); // id -> Field (인물을 묶는 컨테이너 + 템플릿 자리)
    this.view = { panX: 0, panY: 0, scale: 1 };
    this._listeners = new Set();
  }

  onChange(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  _emit(type, payload) {
    for (const fn of this._listeners) fn(type, payload);
  }

  /**
   * 나머지 필드(photoId 등)는 전부 "인물 추가" 버튼 기준 기본값 그대로 옵션으로 뒀다 —
   * 복사/붙여넣기(main.js pasteClipboard)가 다른 인물의 모든 속성을 그대로 복제해 한 번에
   * 만들 때 여기 다 채워 넣는다(따로 addPerson 후 updatePerson을 또 호출할 필요 없이).
   */
  addPerson({
    x = 0, y = 0, name = "이름 없음", photoId = null, photoUrl = null, tags = [], notes = "",
    borderColor = null, borderWidth = null, photoShape = "circle", locked = false, slotOf = null,
  } = {}) {
    const person = {
      id: uuid(), name, photoId, photoUrl, tags: [...tags], x, y, notes,
      borderColor, borderWidth, // 사진 테두리 커스텀(색/굵기) — null이면 기본값(테마 색/3px) 사용
      photoShape, // "circle" | "square" | "rounded"
      locked, // true면 드래그로 위치를 못 옮긴다(TreeRenderer._addCard가 검사)
      slotOf, // { fieldId, slotId } | null — 지금 어느 필드의 어느 템플릿 슬롯에 꽂혀 있는지
    };
    this.people.set(person.id, person);
    this._emit("person:add", person);
    return person;
  }

  /** 인물이 지금 어느 필드의 어느 슬롯에 꽂혀 있는지(slotOf)가 바뀌면, 그 필드(옛 필드/새 필드
   * 둘 다 — 같은 필드 안에서 슬롯만 바꾼 경우도 포함)의 템플릿 관계를 다시 확인해 실제 관계선을
   * 새로 만들거나 지운다("템플릿끼리 그은 관계 — 양쪽 슬롯이 다 채워지면 그 인물들의 진짜
   * 관계선이 되고, 한쪽이 빠지면 다시 템플릿 것으로 돌아간다"). */
  updatePerson(id, patch) {
    const person = this.people.get(id);
    if (!person) return;
    const priorSlotOf = person.slotOf;
    Object.assign(person, patch);
    this._emit("person:update", person);
    if ("slotOf" in patch) {
      if (priorSlotOf?.fieldId) this._resyncFieldTemplateRelationships(priorSlotOf.fieldId);
      if (person.slotOf?.fieldId) this._resyncFieldTemplateRelationships(person.slotOf.fieldId);
    }
  }

  removePerson(id) {
    const person = this.people.get(id);
    if (!person) return;
    const priorSlotOf = person.slotOf;
    this.people.delete(id);
    for (const [relId, rel] of this.relationships) {
      // "부모-자식(부모2)"는 rel.fromId(부모1)/rel.toId(자식) 뿐 아니라 rel.viaSpouseId(부모2)도
      // 참조한다 — 부모2(배우자) 쪽이 지워지면 그 관계선은 더 이상 "이 부부의 자식"이라는 의미가
      // 없어지므로(부부 관계선 자체도 이 조건 없이 fromId/toId로 이미 같이 지워짐), 자식과의
      // 연결선도 함께 지운다. 자식 인물이나 부모1은 그대로 남는다 — 지워지는 건 이 관계선뿐이다.
      if (rel.fromId === id || rel.toId === id || rel.viaSpouseId === id) this.relationships.delete(relId);
    }
    this._emit("person:remove", id);
    // 슬롯에 꽂혀 있던 인물 자체가 삭제되면 그 슬롯도 다시 빈 자리가 된 것 — 빼낼 때와 똑같이
    // 그 슬롯이 걸린 템플릿 관계의 실제 관계선을 정리한다.
    if (priorSlotOf?.fieldId) this._resyncFieldTemplateRelationships(priorSlotOf.fieldId);
  }

  /** 주어진 필드의 그 슬롯을 지금 차지하고 있는 인물(없으면 null). */
  personInSlot(fieldId, slotId) {
    for (const p of this.people.values()) {
      if (p.slotOf?.fieldId === fieldId && p.slotOf?.slotId === slotId) return p;
    }
    return null;
  }

  /**
   * viaSpouseId: "부모-자식(부모2)" 관계에서, fromId(부모)의 배우자가 여럿일 수 있으므로
   * 어느 배우자와의 부부 선을 기준으로 자식 선을 내려그릴지 명시적으로 못박아둔다.
   * (렌더러가 매번 _spousesOf(a.id)[0]로 추측하지 않아도 되게 함)
   */
  addRelationship({ fromId, toId, type = "parent-child", label = "", viaSpouseId = null }) {
    if (!fromId || !toId || fromId === toId) return null;
    const duplicate = [...this.relationships.values()].some(
      (r) => (r.fromId === fromId && r.toId === toId) || (r.fromId === toId && r.toId === fromId)
    );
    if (duplicate) return null;
    const rel = { id: uuid(), fromId, toId, type, label, viaSpouseId };
    this.relationships.set(rel.id, rel);
    this._emit("relationship:add", rel);
    return rel;
  }

  updateRelationship(id, patch) {
    const rel = this.relationships.get(id);
    if (!rel) return;
    Object.assign(rel, patch);
    this._emit("relationship:update", rel);
  }

  removeRelationship(id) {
    if (!this.relationships.delete(id)) return;
    this._emit("relationship:remove", id);
  }

  addTextBox({ x = 0, y = 0, text = "텍스트", fontSize = 20, width = 200, height = 50, background = true } = {}) {
    // width/height는 fontSize와 무관한 독립된 값이다 — 모서리로 크기를 조절해도 글자 크기는
    // 안 바뀌고(사이드바에서만 바꿈), 상자 크기만 바뀐다. background를 끄면 카드 배경/테두리
    // 없이 순수한 텍스트만 떠 있는 라벨처럼 보인다(찾기 쉽도록 마우스오버·선택 시엔 여전히
    // 강조 테두리가 보임 — style.css의 .text-box.no-bg 참고).
    const box = { id: uuid(), x, y, text, fontSize, width, height, locked: false, background };
    this.textBoxes.set(box.id, box);
    this._emit("textbox:add", box);
    return box;
  }

  updateTextBox(id, patch) {
    const box = this.textBoxes.get(id);
    if (!box) return;
    Object.assign(box, patch);
    this._emit("textbox:update", box);
  }

  removeTextBox(id) {
    if (!this.textBoxes.delete(id)) return;
    this._emit("textbox:remove", id);
  }

  /**
   * 필드(Field) — 인물/텍스트박스를 하나로 묶어 옮기는 완전히 빈 컨테이너 + 템플릿 자리.
   * 생김새는 텍스트박스와 같은 모양(왼쪽 위 모서리 + 폭/높이)이지만 텍스트는 없다.
   * templateSlots는 필드 기준 상대좌표({id, relX, relY})라 필드가 움직이면 자동으로 같이
   * 움직인다(따로 갱신할 필요 없음). locked는 person.locked와는 별개 개념 — 켜면 이 필드
   * 위에 있는 오브젝트의 "개별" 드래그만 막고, 필드 자신을 옮기면 여전히 다 같이 움직인다.
   * selfLocked는 반대로 person.locked/textBox.locked와 같은 뜻 — 켜면 필드 "자신"의 위치를
   * (직접 드래그로든, 마키로 묶어 그룹으로든) 못 옮긴다. 리사이즈는 텍스트박스가 locked여도
   * 리사이즈는 막지 않는 것과 같은 원칙으로 selfLocked와 무관하게 항상 가능하다.
   * addLocked는 또 다른 별개 개념 — "이 필드 위에 올라간 것"의 판정(TreeRenderer._objectsWithinField,
   * 필드 드래그로 같이 옮기거나 복사할 때 쓰임)을 켜는 순간의 lockedMemberIds로 고정한다. 켜져
   * 있는 동안은 그 목록에 없는 오브젝트가 나중에 필드 위로 올라와도(단순히 기하학적으로 겹치는
   * 것만으로는) 필드의 "새" 요소로 인정되지 않는다 — 이미 목록에 있던 것만 계속 인정된다.
   * templateRelationships는 슬롯끼리 이어둔 "안내선" — { id, type, slotIds, label, color,
   * lineStyle, bidirectional, materializedRelIds }. type/slotIds 구성은 &관계 연결과 같다
   * (parent-child-solo/spouse/arrow/custom은 slotIds 2개, parent-child(부모2)는 3개 —
   * [부모1, 부모2, 자식] 순서). 양쪽(또는 세) 슬롯에 실제 인물이 다 채워지면 그 인물들 사이의
   * 진짜 relationship이 자동으로 생기고(materializedRelIds에 그 id를 기록), 한 명이라도
   * 빠지면 그 관계선은 지워지고 다시 "템플릿의 것"(안내선)으로 돌아간다 — _resyncFieldTemplateRelationships가
   * updatePerson/removePerson(슬롯 점유 변화)과 updateField(슬롯/템플릿 관계 변화) 때마다 맞춘다.
   */
  addField({
    x = 0, y = 0, width = 260, height = 180, locked = false, selfLocked = false, addLocked = false,
    lockedMemberIds = [], templateMode = false, templateSlots = [], templateRelationships = [],
    bgColor = null, borderColor = null, borderWidth = null, borderStyle = null,
  } = {}) {
    const field = {
      id: uuid(), x, y, width, height, locked, selfLocked, addLocked,
      lockedMemberIds: [...lockedMemberIds],
      templateMode,
      // 배경/테두리 꾸미기 — 전부 null이면 style.css의 기본 모양(점선 테두리 + --surface 배경)
      // 그대로 쓴다. FieldBox.js가 CSS 커스텀 프로퍼티로 적용해서, 선택/호버/템플릿 편집 중
      // 강조 테두리(accent색)는 이 커스텀 색과 무관하게 여전히 그 위에 그대로 보인다.
      bgColor, borderColor, borderWidth, borderStyle,
      templateSlots: templateSlots.map((s) => ({ id: s.id || uuid(), relX: s.relX, relY: s.relY })),
      templateRelationships: templateRelationships.map((tr) => ({
        id: tr.id || uuid(),
        type: tr.type,
        slotIds: [...tr.slotIds],
        label: tr.label || "",
        color: tr.color ?? null,
        lineStyle: tr.lineStyle ?? null,
        bidirectional: !!tr.bidirectional,
        materializedRelIds: [...(tr.materializedRelIds || [])],
      })),
    };
    this.fields.set(field.id, field);
    this._emit("field:add", field);
    this._resyncFieldTemplateRelationships(field.id);
    return field;
  }

  updateField(id, patch) {
    const field = this.fields.get(id);
    if (!field) return;
    Object.assign(field, patch);
    this._emit("field:update", field);
    this._resyncFieldTemplateRelationships(id);
  }

  /** 필드를 지운다. "그 위에 올라가 있는" 인물/텍스트박스가 무엇인지(기하학적 겹침)는 Tree
   * 자신이 판정하지 않는다 — 호출자(TreeRenderer._objectsWithinField)가 지금 이 필드의 멤버를
   * 계산해 people/textBoxes로 넘겨주면, 그것들을 removePerson/removeTextBox로 먼저 지우고
   * (관계선도 removePerson이 알아서 함께 정리) 나서 필드 자신을 지운다 — "필드 삭제 시 포함된
   * 요소도 전부 함께 삭제". 안 넘기면(옛 동작) 필드만 지워지고 안의 인물/텍스트박스는 남는다. */
  removeField(id, { people = [], textBoxes = [] } = {}) {
    if (!this.fields.has(id)) return;
    for (const pid of people) this.removePerson(pid);
    for (const bid of textBoxes) this.removeTextBox(bid);
    this.fields.delete(id);
    // 위에서 안 넘겨준(=지워지지 않은) 인물 중에도 이 필드 슬롯에 꽂혀 있던 게 남아있다면
    // 자유로운 인물로 되돌린다(정보는 그대로 유지) — 슬롯만 있고 멤버 목록엔 없는 사각지대 방지.
    for (const p of this.people.values()) {
      if (p.slotOf?.fieldId === id) p.slotOf = null;
    }
    this._emit("field:remove", id);
  }

  /** 템플릿 자리(슬롯) 하나를 지운다 — 거기 꽂혀 있던 인물은 자유로워지고(정보 유지), 그 슬롯이
   * 걸린 템플릿 관계는(실제 관계선이 돼 있었더라도) 함께 지운다(한쪽 끝이 사라졌으니). */
  removeTemplateSlot(fieldId, slotId) {
    const field = this.fields.get(fieldId);
    if (!field) return;
    const occupant = this.personInSlot(fieldId, slotId);
    if (occupant) {
      occupant.slotOf = null;
      this._emit("person:update", occupant);
    }
    field.templateSlots = field.templateSlots.filter((s) => s.id !== slotId);
    const remaining = [];
    for (const tr of field.templateRelationships || []) {
      if (tr.slotIds.includes(slotId)) {
        for (const relId of tr.materializedRelIds) this.removeRelationship(relId);
      } else {
        remaining.push(tr);
      }
    }
    field.templateRelationships = remaining;
    this._emit("field:update", field);
  }

  /** 템플릿 관계(슬롯끼리 그은 안내선) 하나만 지운다 — 슬롯 자체는 그대로 둔다. */
  removeTemplateRelationship(fieldId, trId) {
    const field = this.fields.get(fieldId);
    if (!field) return;
    const tr = field.templateRelationships?.find((t) => t.id === trId);
    if (!tr) return;
    for (const relId of tr.materializedRelIds) this.removeRelationship(relId);
    field.templateRelationships = field.templateRelationships.filter((t) => t.id !== trId);
    this._emit("field:update", field);
  }

  /** 템플릿 관계의 라벨/색상/선종류/양방향/슬롯 순서(화살표 방향 뒤집기용)를 사이드바에서 바꾼다.
   * 이미 양쪽 슬롯이 채워져 실제 관계선으로 성사돼 있으면(materializedRelIds) 그 관계선에도
   * 같은 라벨/색상/선종류/양방향 값을 곧바로 반영한다 — "템플릿 것이지만 채워지면 인물 것으로
   * 취급"이라는 원칙과 같은 맥락(사용자가 편집한 값이 실제 관계선에도 즉시 보여야 함). slotIds가
   * 바뀌면(방향 뒤집기) 지금 성사 상태를 다시 확인한다 — 방향이 바뀐 화살표는 fromId/toId도
   * 뒤집어야 하므로 기존 관계선을 지우고 새로 만든다. */
  updateTemplateRelationship(fieldId, trId, patch) {
    const field = this.fields.get(fieldId);
    if (!field) return;
    const tr = field.templateRelationships?.find((t) => t.id === trId);
    if (!tr) return;
    Object.assign(tr, patch);
    if (tr.materializedRelIds.length) {
      const stylePatch = {};
      for (const key of ["label", "color", "lineStyle", "bidirectional"]) {
        if (key in patch) stylePatch[key] = patch[key];
      }
      if (Object.keys(stylePatch).length) {
        this.updateRelationship(tr.materializedRelIds[tr.materializedRelIds.length - 1], stylePatch);
      }
    }
    this._emit("field:update", field);
    if ("slotIds" in patch) this._resyncFieldTemplateRelationships(fieldId);
  }

  /** 그 필드의 템플릿 관계 전부를 지금 슬롯 점유 상태에 맞춰 다시 맞춘다 — 양쪽(또는 세) 슬롯이
   * 전부 채워져 있으면 실제 relationship을 만들고(이미 정확히 그 사람들로 만들어져 있으면
   * 그대로 둠), 아니면(비었거나 다른 사람으로 바뀌었으면) 기존 걸 지우고 다시 안내선으로 되돌린다. */
  _resyncFieldTemplateRelationships(fieldId) {
    const field = this.fields.get(fieldId);
    if (!field?.templateRelationships?.length) return;
    for (const tr of field.templateRelationships) {
      const occupants = tr.slotIds.map((slotId) => this.personInSlot(fieldId, slotId));
      const allFilled = occupants.every(Boolean);
      const occupantIds = allFilled ? occupants.map((p) => p.id) : null;
      if (allFilled && this._materializedMatches(tr, occupantIds)) continue; // 이미 정확히 맞음
      for (const relId of tr.materializedRelIds) this.removeRelationship(relId);
      tr.materializedRelIds = allFilled ? this._materializeTemplateRelationship(tr, occupantIds) : [];
    }
    // materializedRelIds 자체는 안 바뀌었어도(예: 한쪽 슬롯만 막 채워져 아직 불완전한 경우)
    // 안내선이 이제 그 슬롯이 아니라 새로 들어온 인물의 위치를 따라가야 하므로, 렌더러가
    // 안내선 좌표를 다시 그리도록 항상 한 번 더 알려준다(TreeRenderer._syncTemplateRelLines).
    this._emit("field:update", field);
  }

  /** tr.materializedRelIds가 지금 occupantIds(빠짐없이 채워졌을 때의 슬롯 순서대로의 인물 id)와
   * 정확히 같은 관계를 가리키고 있는지 확인한다 — 슬롯을 채운 사람이 안 바뀌었으면 관계선을
   * 지웠다 새로 만들 필요 없이 그대로 둔다(불필요한 깜빡임/undo 스택 잡음 방지). */
  _materializedMatches(tr, occupantIds) {
    if (!tr.materializedRelIds.length) return false;
    if (tr.type === "parent-child") {
      const [spouse, pc] = tr.materializedRelIds.map((id) => this.relationships.get(id));
      if (!spouse || !pc) return false;
      const [parent1, parent2, child] = occupantIds;
      return (
        ((spouse.fromId === parent1 && spouse.toId === parent2) || (spouse.fromId === parent2 && spouse.toId === parent1)) &&
        pc.fromId === parent1 && pc.toId === child && pc.viaSpouseId === parent2
      );
    }
    const rel = this.relationships.get(tr.materializedRelIds[0]);
    if (!rel) return false;
    const [a, b] = occupantIds;
    if (rel.fromId === a && rel.toId === b) return true;
    // 화살표는 방향이 의미 있으므로(누가 시작/끝인지) 순서가 바뀌면 다른 관계로 취급한다.
    return tr.type !== "arrow" && rel.fromId === b && rel.toId === a;
  }

  /** occupantIds(슬롯 순서대로의 인물 id)로 tr.type에 맞는 실제 관계선을 만들고, 만들어진
   * relationship id들을 반환한다(나중에 슬롯이 비면 이 id들을 지운다). 이미 두 사람 사이에
   * (템플릿과 무관하게) 관계선이 있었다면 addRelationship이 조용히 무시(null)하므로, 그 경우엔
   * 이 템플릿이 "소유"하는 관계선이 없는 셈 치고 건드리지 않는다(나중에 슬롯을 빼도 그 원래
   * 관계선은 안 지워짐). */
  _materializeTemplateRelationship(tr, occupantIds) {
    const created = [];
    if (tr.type === "parent-child") {
      const [parent1, parent2, child] = occupantIds;
      const spouseRel = this.addRelationship({ fromId: parent1, toId: parent2, type: "spouse" });
      if (spouseRel) created.push(spouseRel.id);
      const pcRel = this.addRelationship({ fromId: parent1, toId: child, type: "parent-child", viaSpouseId: parent2 });
      if (pcRel) created.push(pcRel.id);
    } else if (tr.type === "parent-child-solo") {
      const [parent, child] = occupantIds;
      const rel = this.addRelationship({ fromId: parent, toId: child, type: "parent-child-solo" });
      if (rel) created.push(rel.id);
    } else {
      const [a, b] = occupantIds;
      const rel = this.addRelationship({ fromId: a, toId: b, type: tr.type });
      if (rel) created.push(rel.id);
    }
    // 템플릿에 저장해둔 라벨/색/선 종류/양방향 등 커스텀 값은, 실질적인 마지막 관계선
    // (부모-자식(부모2)면 부모-자식 쪽)에 마저 입힌다.
    if (created.length && (tr.label || tr.color || tr.lineStyle || tr.bidirectional)) {
      this.updateRelationship(created[created.length - 1], {
        label: tr.label, color: tr.color, lineStyle: tr.lineStyle, bidirectional: tr.bidirectional,
      });
    }
    return created;
  }

  getBounds() {
    if (!this.people.size && !this.textBoxes.size && !this.fields.size) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of this.people.values()) {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y);
      maxY = Math.max(maxY, p.y);
    }
    // 텍스트 박스/필드는 (x,y)가 중심이 아니라 왼쪽 위 모서리라, 점 하나로만 취급하면 상자의
    // 나머지 부분(오른쪽/아래쪽으로 width/height만큼)이 통째로 빠진다 — "전체보기"/이미지
    // 저장에서 박스가 잘려 보이던 원인. 오른쪽 아래 모서리(x+width, y+height)까지 포함시킨다.
    for (const b of this.textBoxes.values()) {
      const w = b.width ?? 200;
      const h = b.height ?? 50;
      minX = Math.min(minX, b.x);
      maxX = Math.max(maxX, b.x + w);
      minY = Math.min(minY, b.y);
      maxY = Math.max(maxY, b.y + h);
    }
    for (const f of this.fields.values()) {
      minX = Math.min(minX, f.x);
      maxX = Math.max(maxX, f.x + f.width);
      minY = Math.min(minY, f.y);
      maxY = Math.max(maxY, f.y + f.height);
    }
    return { minX, minY, maxX, maxY };
  }

  toJSON() {
    return {
      people: [...this.people.values()],
      relationships: [...this.relationships.values()],
      textBoxes: [...this.textBoxes.values()],
      fields: [...this.fields.values()],
      view: this.view,
    };
  }

  /** data(JSON)로 모델 전체를 교체한다. (가져오기 / 실행취소·다시실행에서 사용) */
  loadJSON(data) {
    this.people = new Map((data.people || []).map((p) => [p.id, p]));
    this.relationships = new Map((data.relationships || []).map((r) => [r.id, r]));
    this.textBoxes = new Map((data.textBoxes || []).map((b) => [b.id, b]));
    this.fields = new Map((data.fields || []).map((f) => [f.id, f]));
    this.view = data.view || { panX: 0, panY: 0, scale: 1 };
    this._emit("reset", null);
  }
}
