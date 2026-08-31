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
    borderColor = null, borderWidth = null, photoShape = "circle", locked = false,
  } = {}) {
    const person = {
      id: uuid(), name, photoId, photoUrl, tags: [...tags], x, y, notes,
      borderColor, borderWidth, // 사진 테두리 커스텀(색/굵기) — null이면 기본값(테마 색/3px) 사용
      photoShape, // "circle" | "square" | "rounded"
      locked, // true면 드래그로 위치를 못 옮긴다(TreeRenderer._addCard가 검사)
    };
    this.people.set(person.id, person);
    this._emit("person:add", person);
    return person;
  }

  updatePerson(id, patch) {
    const person = this.people.get(id);
    if (!person) return;
    Object.assign(person, patch);
    this._emit("person:update", person);
  }

  removePerson(id) {
    if (!this.people.delete(id)) return;
    for (const [relId, rel] of this.relationships) {
      // "부모-자식(부모2)"는 rel.fromId(부모1)/rel.toId(자식) 뿐 아니라 rel.viaSpouseId(부모2)도
      // 참조한다 — 부모2(배우자) 쪽이 지워지면 그 관계선은 더 이상 "이 부부의 자식"이라는 의미가
      // 없어지므로(부부 관계선 자체도 이 조건 없이 fromId/toId로 이미 같이 지워짐), 자식과의
      // 연결선도 함께 지운다. 자식 인물이나 부모1은 그대로 남는다 — 지워지는 건 이 관계선뿐이다.
      if (rel.fromId === id || rel.toId === id || rel.viaSpouseId === id) this.relationships.delete(relId);
    }
    this._emit("person:remove", id);
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

  addTextBox({ x = 0, y = 0, text = "텍스트", fontSize = 20, width = 200, height = 50 } = {}) {
    // width/height는 fontSize와 무관한 독립된 값이다 — 모서리로 크기를 조절해도 글자 크기는
    // 안 바뀌고(사이드바에서만 바꿈), 상자 크기만 바뀐다.
    const box = { id: uuid(), x, y, text, fontSize, width, height, locked: false };
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

  getBounds() {
    if (!this.people.size && !this.textBoxes.size) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of this.people.values()) {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y);
      maxY = Math.max(maxY, p.y);
    }
    // 텍스트 박스는 (x,y)가 중심이 아니라 왼쪽 위 모서리라, 점 하나로만 취급하면 상자의 나머지
    // 부분(오른쪽/아래쪽으로 width/height만큼)이 통째로 빠진다 — "전체보기"/이미지 저장에서 박스가
    // 잘려 보이던 원인. 오른쪽 아래 모서리(x+width, y+height)까지 반드시 포함시킨다.
    for (const b of this.textBoxes.values()) {
      const w = b.width ?? 200;
      const h = b.height ?? 50;
      minX = Math.min(minX, b.x);
      maxX = Math.max(maxX, b.x + w);
      minY = Math.min(minY, b.y);
      maxY = Math.max(maxY, b.y + h);
    }
    return { minX, minY, maxX, maxY };
  }

  toJSON() {
    return {
      people: [...this.people.values()],
      relationships: [...this.relationships.values()],
      textBoxes: [...this.textBoxes.values()],
      view: this.view,
    };
  }

  /** data(JSON)로 모델 전체를 교체한다. (가져오기 / 실행취소·다시실행에서 사용) */
  loadJSON(data) {
    this.people = new Map((data.people || []).map((p) => [p.id, p]));
    this.relationships = new Map((data.relationships || []).map((r) => [r.id, r]));
    this.textBoxes = new Map((data.textBoxes || []).map((b) => [b.id, b]));
    this.view = data.view || { panX: 0, panY: 0, scale: 1 };
    this._emit("reset", null);
  }
}
