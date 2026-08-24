import { fetchRawImageBlob } from "../utils/imageUtils.js";
import { uuid } from "../utils/uuid.js";
import { ImageCropEditor } from "./ImageCropEditor.js";

const DEFAULT_AVATAR = "assets/default-avatar.svg";

/** 선택한 인물의 이름/사진/태그(속성)/메모를 편집하는 우측 패널. */
export class InspectorPanel {
  constructor(el, { tree, store, onImageChange, getAllTags, cropModalEl }) {
    this.el = el;
    this.tree = tree;
    this.store = store;
    this.onImageChange = onImageChange;
    this.getAllTags = getAllTags;
    this.person = null;
    this.textBox = null;
    this.mode = null; // "person" | "textbox" — 지금 사이드바가 어느 걸 보여주고 있는지
    this.cropEditor = new ImageCropEditor(cropModalEl);
    this._buildPersonSkeleton();
    this.mode = "person";

    // 텍스트 박스는 사이드바를 연 채로도 캔버스의 모서리 핸들로 글자 크기를 바꿀 수 있어서(둘 다
    // 같은 걸 조작하는 두 가지 방법), 그쪽에서 바뀐 값을 사이드바 입력창에도 바로 반영해줘야 한다.
    tree.onChange((type, payload) => {
      if (type !== "textbox:update") return;
      if (this.mode !== "textbox" || !this.textBox || this.textBox.id !== payload.id) return;
      this.textBox = payload;
      const textEl = this.el.querySelector(".tb-text");
      const fontEl = this.el.querySelector(".tb-fontsize");
      // 지금 사용자가 타이핑 중인 입력창은 건드리지 않는다(커서 위치가 튀는 걸 막기 위해).
      if (textEl && document.activeElement !== textEl) textEl.value = payload.text || "";
      if (fontEl && document.activeElement !== fontEl) fontEl.value = payload.fontSize;
    });
  }

  _buildPersonSkeleton() {
    this.el.innerHTML = `
      <div class="inspector-header">
        <strong>인물 정보</strong>
        <button type="button" class="inspector-close" aria-label="닫기">×</button>
      </div>
      <label>이름
        <input type="text" class="f-name" placeholder="이름">
      </label>
      <label>사진</label>
      <div class="photo-drop" tabindex="0" title="클릭해서 파일 선택 · 드래그해서 놓기 · Ctrl+V로 붙여넣기">
        <img class="photo-drop-preview" src="${DEFAULT_AVATAR}" alt="">
      </div>
      <input type="text" class="f-photo-url" placeholder="이미지">
      <button type="button" class="f-photo-edit" hidden>이미지 수정</button>
      <input type="file" accept="image/*" class="f-photo-file" style="display:none">
      <label>속성(태그)
        <input type="text" class="f-tag-input" placeholder="태그 입력 후 Enter" list="tag-suggestions">
        <datalist id="tag-suggestions"></datalist>
      </label>
      <div class="f-tags"></div>
      <label>메모
        <textarea class="f-notes" rows="3" placeholder="예시 텍스트"></textarea>
      </label>
      <button type="button" class="f-delete">이 인물 삭제</button>
    `;

    this.el.querySelector(".inspector-close").onclick = () => this.close();

    this.el.querySelector(".f-name").addEventListener("input", (e) => {
      this._patch({ name: e.target.value });
    });

    this.el.querySelector(".f-notes").addEventListener("input", (e) => {
      this._patch({ notes: e.target.value });
    });

    this._wirePhotoInput();

    this.el.querySelector(".f-tag-input").addEventListener("keydown", (e) => {
      if (e.key !== "Enter" || !e.target.value.trim() || !this.person) return;
      e.preventDefault();
      const value = e.target.value.trim();
      const tags = [...(this.person.tags || [])];
      if (!tags.includes(value)) tags.push(value);
      this._patch({ tags });
      e.target.value = "";
      this._renderTags();
    });

    this.el.querySelector(".f-delete").addEventListener("click", () => {
      if (!this.person) return;
      if (confirm("이 인물을 삭제할까요? 연결된 관계선도 함께 삭제됩니다.")) {
        this.tree.removePerson(this.person.id);
        this.close();
      }
    });
  }

  /** 파일 선택 / 드래그앤드롭 / 클립보드 붙여넣기 / URL 붙여넣기 — 네 가지 경로를 모두 사진 입력
   * 하나로 연결한다. 원형 박스(.photo-drop)는 클릭/드래그/붙여넣기를, 그 아래 별도 입력창은 URL을
   * 담당한다. */
  _wirePhotoInput() {
    const dropzone = this.el.querySelector(".photo-drop");
    const fileInput = this.el.querySelector(".f-photo-file");
    const urlInput = this.el.querySelector(".f-photo-url");

    dropzone.addEventListener("click", () => fileInput.click());
    dropzone.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileInput.click(); }
    });

    fileInput.addEventListener("change", async (e) => {
      const file = e.target.files[0];
      e.target.value = "";
      if (file) await this._setPhotoFromFile(file);
    });

    dropzone.addEventListener("dragover", (e) => {
      e.preventDefault();
      dropzone.classList.add("dragover");
    });
    dropzone.addEventListener("dragleave", () => dropzone.classList.remove("dragover"));
    dropzone.addEventListener("drop", async (e) => {
      e.preventDefault();
      dropzone.classList.remove("dragover");
      const file = e.dataTransfer?.files?.[0];
      if (file) {
        await this._setPhotoFromFile(file);
        return;
      }
      const url = e.dataTransfer?.getData("text/uri-list") || e.dataTransfer?.getData("text/plain");
      if (url) await this._setPhotoFromUrl(url);
    });

    // 클립보드 이미지 붙여넣기: 인물이 선택된 동안은 어디에 포커스가 있어도 이미지 붙여넣기만 가로챈다.
    // (텍스트만 있는 붙여넣기는 그대로 두어 이름/태그/메모 입력에 영향을 주지 않는다.)
    // _buildPersonSkeleton은 이제(텍스트 박스 모드와 오가며) 여러 번 불릴 수 있으므로, 예전 리스너가
    // 쌓이지 않도록 먼저 떼어낸다 — document에 건 리스너라 DOM이 갈아끼워져도 저절로 안 없어진다.
    if (this._onPaste) document.removeEventListener("paste", this._onPaste);
    this._onPaste = async (e) => {
      if (!this.person) return;
      const items = [...(e.clipboardData?.items || [])];
      const imageItem = items.find((it) => it.kind === "file" && it.type.startsWith("image/"));
      if (!imageItem) return;
      e.preventDefault();
      const file = imageItem.getAsFile();
      if (file) await this._setPhotoFromFile(file);
    };
    document.addEventListener("paste", this._onPaste);

    urlInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); this._applyUrlInput(); }
    });

    this.el.querySelector(".f-photo-edit").addEventListener("click", () => this._editExistingPhoto());
  }

  async _applyUrlInput() {
    const urlInput = this.el.querySelector(".f-photo-url");
    const url = urlInput.value.trim();
    if (!url) return;
    await this._setPhotoFromUrl(url);
    urlInput.value = "";
  }

  /** 새 파일/드래그/붙여넣기 이미지는 위치·크기 조정 편집기를 거친 뒤 저장한다. */
  async _setPhotoFromFile(file) {
    if (!this.person) return;
    const blob = await this.cropEditor.open(file);
    if (!blob) return; // 취소함
    await this._applyPhotoBlob(blob);
  }

  async _setPhotoFromUrl(rawUrl) {
    if (!this.person) return;
    const url = rawUrl.trim();
    if (!url) return;
    try {
      const rawBlob = await fetchRawImageBlob(url);
      const blob = await this.cropEditor.open(rawBlob);
      if (!blob) return; // 취소함
      await this._applyPhotoBlob(blob);
    } catch (err) {
      // CORS 등으로 다운로드가 막히는 이미지 호스트 대응: 링크 자체를 그대로 사진 주소로 사용한다.
      // (내보내기 JSON에는 포함되지 않고, 표시하려면 해당 URL에 계속 접근 가능해야 한다. 픽셀에
      // 접근할 수 없으니 위치·크기 편집기도 적용할 수 없다.)
      console.warn("이미지 다운로드 실패, 링크를 그대로 사용합니다:", err);
      await this._clearOldPhotoBlob();
      this._setPreview(url);
      this.onImageChange(this.person.id, url, null);
      this._patch({ photoId: null, photoUrl: url });
      this._updateEditButtonVisibility();
    }
  }

  /** 이미 저장된 사진의 위치·크기를 다시 조정한다(원본을 다시 올리지 않고 지금 사진을 그대로 편집). */
  async _editExistingPhoto() {
    if (!this.person?.photoId) return;
    const currentBlob = await this.store.getImage(this.person.photoId);
    if (!currentBlob) return;
    const blob = await this.cropEditor.open(currentBlob);
    if (!blob) return; // 취소함
    await this._applyPhotoBlob(blob);
  }

  async _applyPhotoBlob(blob) {
    const id = this.person.photoId || uuid();
    await this.store.putImage(id, blob);
    const previewUrl = URL.createObjectURL(blob);
    this._setPreview(previewUrl);
    // 렌더러 캐시/카드 DOM을 먼저 즉시 갱신한 다음 모델을 갱신한다 — 순서를 바꾸면 모델 변경
    // 이벤트가 먼저 나가면서 렌더러가 이 blob을 IndexedDB에서 한 번 더 비동기로 읽어오게 되어
    // (막 저장한 걸 다시 읽는 불필요한 왕복) 카드에 사진이 반영되는 게 살짝 늦어진다.
    this.onImageChange(this.person.id, previewUrl, id);
    this._patch({ photoId: id, photoUrl: null });
    this._updateEditButtonVisibility();
  }

  /** photoId(업로드된 Blob)로 저장된 사진일 때만 "위치·크기 다시 조정" 버튼을 보여준다.
   * photoUrl(외부 링크, CORS로 다운로드 실패)은 픽셀에 접근할 수 없어 편집기를 열 수 없다. */
  _updateEditButtonVisibility() {
    this.el.querySelector(".f-photo-edit").hidden = !this.person?.photoId;
  }

  async _clearOldPhotoBlob() {
    if (this.person.photoId) {
      try { await this.store.deleteImage(this.person.photoId); } catch { /* ignore */ }
    }
  }

  _setPreview(url) {
    this.el.querySelector(".photo-drop-preview").src = url || DEFAULT_AVATAR;
  }

  _patch(patch) {
    if (!this.person) return;
    this.tree.updatePerson(this.person.id, patch);
  }

  _renderTags() {
    const wrap = this.el.querySelector(".f-tags");
    wrap.innerHTML = "";
    for (const tag of this.person.tags || []) {
      // 칩 전체가 삭제 버튼이다(따로 떠 있는 × 버튼이 아니라, 눌렀을 때 확인 후 지워짐) — ×는
      // 그 자체로 클릭 가능한 버튼이 아니라 그냥 곁들이는 텍스트일 뿐이다.
      const chip = document.createElement("span");
      chip.className = "tag-chip removable";
      chip.tabIndex = 0;
      chip.setAttribute("role", "button");
      chip.title = "클릭하면 이 태그를 삭제합니다";
      const label = document.createElement("span");
      label.textContent = tag;
      const x = document.createElement("span");
      x.className = "tag-chip-x";
      x.textContent = "×";
      chip.append(label, x);
      const removeTag = () => {
        if (!confirm(`"${tag}" 태그를 삭제할까요?`)) return;
        this._patch({ tags: this.person.tags.filter((t) => t !== tag) });
        this._renderTags();
      };
      chip.addEventListener("click", removeTag);
      chip.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); removeTag(); }
      });
      wrap.appendChild(chip);
    }

    const datalist = this.el.querySelector("#tag-suggestions");
    datalist.innerHTML = "";
    for (const tag of this.getAllTags()) {
      const opt = document.createElement("option");
      opt.value = tag;
      datalist.appendChild(opt);
    }
  }

  async open(person) {
    if (this.mode !== "person") {
      this._buildPersonSkeleton();
      this.mode = "person";
    }
    this.textBox = null;
    this.person = person;
    this.el.querySelector(".f-name").value = person.name || "";
    this.el.querySelector(".f-notes").value = person.notes || "";
    this.el.querySelector(".f-photo-url").value = "";
    this._renderTags();
    this._updateEditButtonVisibility();
    this.el.classList.add("open");

    let previewUrl = person.photoUrl || null;
    if (person.photoId) {
      const blob = await this.store.getImage(person.photoId);
      if (blob) previewUrl = URL.createObjectURL(blob);
    }
    this._setPreview(previewUrl);
  }

  /** 인물 카드처럼, 텍스트 박스를 클릭했을 때도 사이드바를 띄워서 내용/글자 크기를 고칠 수 있게 한다. */
  openTextBox(box) {
    if (this.mode !== "textbox") {
      this._buildTextBoxSkeleton();
      this.mode = "textbox";
    }
    this.person = null;
    this.textBox = box;
    this.el.querySelector(".tb-text").value = box.text || "";
    this.el.querySelector(".tb-fontsize").value = box.fontSize;
    this.el.classList.add("open");
  }

  _buildTextBoxSkeleton() {
    this.el.innerHTML = `
      <div class="inspector-header">
        <strong>텍스트 박스</strong>
        <button type="button" class="inspector-close" aria-label="닫기">×</button>
      </div>
      <label>내용
        <textarea class="tb-text" rows="5" placeholder="텍스트 입력"></textarea>
      </label>
      <label>글자 크기
        <input type="number" class="tb-fontsize" min="10" max="72" step="1">
      </label>
      <button type="button" class="tb-delete">이 텍스트 박스 삭제</button>
    `;

    this.el.querySelector(".inspector-close").onclick = () => this.close();

    this.el.querySelector(".tb-text").addEventListener("input", (e) => {
      if (!this.textBox) return;
      this.tree.updateTextBox(this.textBox.id, { text: e.target.value });
    });

    this.el.querySelector(".tb-fontsize").addEventListener("input", (e) => {
      if (!this.textBox) return;
      const next = Math.min(72, Math.max(10, parseInt(e.target.value, 10) || this.textBox.fontSize));
      this.tree.updateTextBox(this.textBox.id, { fontSize: next });
    });

    this.el.querySelector(".tb-delete").addEventListener("click", () => {
      if (!this.textBox) return;
      if (confirm("이 텍스트 박스를 삭제할까요?")) {
        this.tree.removeTextBox(this.textBox.id);
        this.close();
      }
    });
  }

  close() {
    this.person = null;
    this.textBox = null;
    this.el.classList.remove("open");
  }

  /** 다른 경로(예: 실행취소)로 person이 바뀌었을 때 열려있는 패널을 새로고침 */
  refresh(person) {
    if (this.person && this.person.id === person.id) {
      this.person = person;
      this._renderTags();
    }
  }
}
