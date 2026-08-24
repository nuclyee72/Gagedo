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

  addPerson({ x = 0, y = 0, name = "이름 없음" } = {}) {
    const person = { id: uuid(), name, photoId: null, photoUrl: null, tags: [], x, y, notes: "" };
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
      if (rel.fromId === id || rel.toId === id) this.relationships.delete(relId);
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

  addTextBox({ x = 0, y = 0, text = "텍스트", fontSize = 20 } = {}) {
    const box = { id: uuid(), x, y, text, fontSize };
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
    const pts = [...this.people.values(), ...this.textBoxes.values()];
    if (!pts.length) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of pts) {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y);
      maxY = Math.max(maxY, p.y);
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
