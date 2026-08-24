/**
 * IndexedDB 얇은 래퍼. 외부 라이브러리 없이 직접 구현한다.
 * - people / relationships : 가계도 레코드
 * - images                 : 업로드한 사진 Blob (사람 레코드는 photoId만 참조)
 * - meta                   : 뷰 상태(pan/zoom) 등 싱글턴 값
 */
const DB_NAME = "familyTreeDB";
const DB_VERSION = 1;
export const SCHEMA_VERSION = 1;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("people")) db.createObjectStore("people", { keyPath: "id" });
      if (!db.objectStoreNames.contains("relationships")) db.createObjectStore("relationships", { keyPath: "id" });
      if (!db.objectStoreNames.contains("images")) db.createObjectStore("images");
      if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function runTx(db, storeNames, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(storeNames, mode);
    const names = Array.isArray(storeNames) ? storeNames : [storeNames];
    const stores = Object.fromEntries(names.map((n) => [n, t.objectStore(n)]));
    let result;
    Promise.resolve(fn(stores))
      .then((r) => (result = r))
      .catch((err) => {
        try { t.abort(); } catch { /* ignore */ }
        reject(err);
      });
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error("transaction aborted"));
  });
}

export class TreeStore {
  constructor() {
    this._dbPromise = openDB();
  }

  async _db() {
    return this._dbPromise;
  }

  async saveAll(tree) {
    const db = await this._db();
    return runTx(db, ["people", "relationships", "meta"], "readwrite", (s) => {
      s.people.clear();
      s.relationships.clear();
      for (const p of tree.people.values()) s.people.put(p);
      for (const r of tree.relationships.values()) s.relationships.put(r);
      s.meta.put(tree.view, "view");
      s.meta.put(SCHEMA_VERSION, "schemaVersion");
    });
  }

  async loadAll() {
    const db = await this._db();
    return runTx(db, ["people", "relationships", "meta"], "readonly", async (s) => {
      const people = await reqToPromise(s.people.getAll());
      const relationships = await reqToPromise(s.relationships.getAll());
      const view = await reqToPromise(s.meta.get("view"));
      return { people, relationships, view: view || { panX: 0, panY: 0, scale: 1 } };
    });
  }

  async putImage(id, blob) {
    const db = await this._db();
    return runTx(db, ["images"], "readwrite", (s) => s.images.put(blob, id));
  }

  async getImage(id) {
    const db = await this._db();
    return runTx(db, ["images"], "readonly", (s) => reqToPromise(s.images.get(id)));
  }

  async deleteImage(id) {
    const db = await this._db();
    return runTx(db, ["images"], "readwrite", (s) => s.images.delete(id));
  }

  /** 현재 트리를 이미지까지 포함한 하나의 JSON(직렬화 가능 객체)으로 변환한다. */
  async exportJSON(tree) {
    const images = {};
    for (const p of tree.people.values()) {
      if (!p.photoId) continue;
      const blob = await this.getImage(p.photoId);
      if (blob) images[p.photoId] = await blobToDataURL(blob);
    }
    return {
      schemaVersion: SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      people: [...tree.people.values()],
      relationships: [...tree.relationships.values()],
      view: tree.view,
      images,
    };
  }

  /** 내보내기 JSON을 읽어 모델과 IndexedDB를 함께 교체한다. */
  async importJSON(data, tree) {
    // 이미지부터 IndexedDB에 다 써넣은 다음에 tree.loadJSON을 불러야 한다 — loadJSON은 "reset"
    // 이벤트를 동기적으로 쏘고, 그걸 받은 TreeRenderer가 (비동기로) 곧장 각 카드 사진을
    // store.getImage(photoId)로 읽으러 간다. 순서가 반대면 그 시점에 아직 이미지가 안 들어가 있어서
    // 기본 아바타로 그려지고, 그 뒤로는 아무 이벤트도 다시 안 나서 영영 갱신되지 않는 버그가 있었다.
    for (const [id, dataUrl] of Object.entries(data.images || {})) {
      const blob = await dataURLToBlob(dataUrl);
      await this.putImage(id, blob);
    }
    tree.loadJSON(data);
    await this.saveAll(tree);
  }
}

function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

async function dataURLToBlob(dataUrl) {
  const res = await fetch(dataUrl);
  return res.blob();
}
