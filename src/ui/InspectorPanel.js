import { fetchRawImageBlob } from "../utils/imageUtils.js";
import { uuid } from "../utils/uuid.js";
import { ImageCropEditor } from "./ImageCropEditor.js";
import { TYPE_DISPLAY_NAME, LINE_STYLE_PRESETS, COLOR_PRESETS, defaultColorFor } from "./RelationshipLine.js";

const DEFAULT_AVATAR = "assets/default-avatar.svg";

/** 사진 모양 선택지 — shape 값은 PersonCard.js의 .shape-* 클래스, style.css의 실제 모양과 맞춘다. */
const PHOTO_SHAPES = [
  { shape: "circle", title: "원형" },
  { shape: "square", title: "네모" },
  { shape: "rounded", title: "모서리 둥근 네모" },
];

/** 선택한 인물/텍스트 박스/관계선의 내용을 편집하는 우측 패널. */
export class InspectorPanel {
  constructor(el, { tree, store, onImageChange, getAllTags, cropModalEl, getFieldMembers }) {
    this.el = el;
    this.tree = tree;
    this.store = store;
    // 필드의 "새 요소 추가 잠금"을 켜는 순간 지금 그 위에 올라가 있는 멤버를 스냅샷으로 고정해야
    // 하는데, 그 판정(TreeRenderer._objectsWithinField, 기하학적 겹침)은 렌더러 쪽에 있어서
    // main.js가 이 콜백으로 연결해준다.
    this.getFieldMembers = getFieldMembers;
    this.onImageChange = onImageChange;
    this.getAllTags = getAllTags;
    this.person = null;
    this.textBox = null;
    this.relationship = null;
    this.field = null;
    this.templateSlot = null; // 템플릿 슬롯(점선 자리) 사이드바 대상
    this.templateSlotFieldId = null;
    this.templateRel = null; // 템플릿 관계(슬롯끼리 그은 안내선) 사이드바 대상
    this.templateRelFieldId = null;
    // "person" | "textbox" | "relationship" | "field" | "template-slot" | "template-rel"
    // — 지금 사이드바가 어느 걸 보여주고 있는지.
    this.mode = null;
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
      this._syncTextBoxBgButton();
    });

    // 관계선도 마찬가지 — 캔버스에서 라벨을 그 자리 즉석 편집(_startLabelEdit)해도 사이드바에
    // 열려 있는 라벨 입력창이 바로 따라와야 한다.
    tree.onChange((type, payload) => {
      if (type !== "relationship:update") return;
      if (this.mode !== "relationship" || !this.relationship || this.relationship.id !== payload.id) return;
      this.relationship = payload;
      const labelEl = this.el.querySelector(".rel-label");
      if (labelEl && document.activeElement !== labelEl) labelEl.value = payload.label || "";
      this._syncRelationshipColorAndStyle(payload);
      this._syncArrowControls(payload);
    });

    // 필드도 마찬가지 — 캔버스 쪽 상호작용(템플릿 모드 중 슬롯 추가/삭제 등)으로 field가 바뀌면
    // 사이드바에 열려 있는 토글 버튼 상태도 같이 따라와야 한다.
    tree.onChange((type, payload) => {
      if (type !== "field:update") return;
      if (this.mode !== "field" || !this.field || this.field.id !== payload.id) return;
      this.field = payload;
      this._syncFieldControls();
    });
  }

  _buildPersonSkeleton() {
    this.el.innerHTML = `
      <div class="inspector-header">
        <strong>인물 정보</strong>
        <button type="button" class="inspector-close" aria-label="닫기">×</button>
      </div>
      <label>이름
        <div class="f-name-row">
          <input type="text" class="f-name" placeholder="이름">
          <button type="button" class="f-lock-btn" title="위치 잠금" aria-label="위치 잠금">🔓</button>
        </div>
      </label>
      <label>사진</label>
      <div class="photo-drop" tabindex="0" title="클릭해서 파일 선택 · 드래그해서 놓기 · Ctrl+V로 붙여넣기">
        <img class="photo-drop-preview" src="${DEFAULT_AVATAR}" alt="">
      </div>
      <div class="f-photo-row">
        <input type="text" class="f-photo-url" placeholder="이미지">
        <button type="button" class="f-photo-edit" hidden title="이미지 수정" aria-label="이미지 수정">✏️</button>
      </div>
      <input type="file" accept="image/*" class="f-photo-file" style="display:none">
      <details class="p-attr-section">
        <summary><span class="p-attr-arrow">▸</span> 속성</summary>
        <label>사진 모양</label>
        <div class="p-shape-options">
          ${PHOTO_SHAPES.map(({ shape, title }) => `
            <button type="button" class="p-shape-btn" data-shape="${shape}" title="${title}">
              <span class="p-shape-preview shape-${shape}"></span>
            </button>
          `).join("")}
        </div>
        <label>테두리 색상</label>
        <div class="rel-color-swatches p-border-swatches">
          ${COLOR_PRESETS.map((c) => `<button type="button" class="rel-color-swatch" data-color="${c}" style="background:${c}" title="${c}"></button>`).join("")}
        </div>
        <div class="rel-color-custom-row">
          <input type="color" class="p-border-color rel-color-input" title="직접 고르기">
          <button type="button" class="p-border-reset rel-color-reset">기본값</button>
        </div>
        <label>테두리 굵기 <span class="p-border-width-value"></span>
          <input type="range" class="p-border-width" min="0" max="10" step="1">
        </label>
      </details>
      <label>태그
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

    this.el.querySelector(".f-lock-btn").addEventListener("click", () => {
      if (!this.person) return;
      this._patch({ locked: !this.person.locked });
      this._syncLockButton();
    });

    this.el.querySelector(".f-notes").addEventListener("input", (e) => {
      this._patch({ notes: e.target.value });
    });

    this._wirePhotoInput();
    this._wirePhotoShapeInput();
    this._wireBorderInput();

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

  /** 사진 모양(원/네모/둥근 네모) 선택 — 카드의 사진뿐 아니라 사이드바 업로드 박스도 같은
   * 모양으로 미리 보여준다. */
  _wirePhotoShapeInput() {
    for (const btn of this.el.querySelectorAll(".p-shape-btn")) {
      btn.addEventListener("click", () => {
        this._patch({ photoShape: btn.dataset.shape });
        this._syncPhotoShapeControls();
      });
    }
  }

  _syncPhotoShapeControls() {
    const shape = this.person?.photoShape || "circle";
    for (const btn of this.el.querySelectorAll(".p-shape-btn")) {
      btn.classList.toggle("active", btn.dataset.shape === shape);
    }
    const dropzone = this.el.querySelector(".photo-drop");
    dropzone.classList.remove("shape-circle", "shape-square", "shape-rounded", "shape-diamond");
    dropzone.classList.add(`shape-${shape}`);
  }

  /** 이름 옆 좌물쇠 — 잠기면 캔버스에서 드래그로 위치를 못 옮긴다(TreeRenderer.js가 검사). */
  _syncLockButton() {
    const locked = !!this.person?.locked;
    const btn = this.el.querySelector(".f-lock-btn");
    btn.textContent = locked ? "🔒" : "🔓";
    btn.classList.toggle("active", locked);
    btn.title = locked ? "잠김 — 눌러서 풀기" : "위치 잠금";
  }

  /** 사진 원 테두리 색/굵기 — 관계선 색상 선택기와 같은 스와치+커스텀 색상+기본값 되돌리기 구성. */
  _wireBorderInput() {
    // 스와치 활성 표시/색상 입력값처럼 "파생된" UI 상태는 _patch만으로는 안 바뀌므로(이름/메모와
    // 달리 입력창이 곧 값 자체가 아님) 값을 바꿀 때마다 직접 다시 동기화해준다.
    for (const sw of this.el.querySelectorAll(".p-border-swatches .rel-color-swatch")) {
      sw.addEventListener("click", () => {
        this._patch({ borderColor: sw.dataset.color });
        this._syncBorderControls(this.person);
      });
    }
    this.el.querySelector(".p-border-color").addEventListener("input", (e) => {
      this._patch({ borderColor: e.target.value });
      this._syncBorderControls(this.person);
    });
    this.el.querySelector(".p-border-reset").addEventListener("click", () => {
      this._patch({ borderColor: null });
      this._syncBorderControls(this.person);
    });
    this.el.querySelector(".p-border-width").addEventListener("input", (e) => {
      this._patch({ borderWidth: parseInt(e.target.value, 10) });
      this.el.querySelector(".p-border-width-value").textContent = `${e.target.value}px`;
    });
  }

  /** 테두리 스와치의 "선택됨" 표시 + 색상/굵기 입력값을 person에 맞춰 갱신한다. */
  _syncBorderControls(person) {
    const DEFAULT_WIDTH = 3; // style.css의 .person-photo 기본 굵기(3px)와 맞춘 값
    const colorInput = this.el.querySelector(".p-border-color");
    // 기본값(null)일 땐 실제 테마 변수(--panel-bg)의 현재 값을 보여준다(다크/라이트에 따라 다름).
    // CSS 커스텀 프로퍼티는 계산되지 않고 style.css에 적힌 hex 문자열 그대로 돌아온다.
    const themeDefault = getComputedStyle(document.documentElement).getPropertyValue("--panel-bg").trim();
    colorInput.value = person.borderColor || themeDefault || "#ffffff";
    for (const sw of this.el.querySelectorAll(".p-border-swatches .rel-color-swatch")) {
      sw.classList.toggle("active", !!person.borderColor && sw.dataset.color === person.borderColor);
    }
    const width = person.borderWidth ?? DEFAULT_WIDTH;
    this.el.querySelector(".p-border-width").value = width;
    this.el.querySelector(".p-border-width-value").textContent = `${width}px`;
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
    this._syncLockButton();
    this._syncPhotoShapeControls();
    this._syncBorderControls(person);
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
    this._syncTextBoxBgButton();
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
      <label class="toggle-row">
        <span>배경</span>
        <button type="button" class="tb-bg-btn" title="끄면 카드 배경/테두리 없이 순수한 텍스트만 보여요">ON</button>
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

    this.el.querySelector(".tb-bg-btn").addEventListener("click", () => {
      if (!this.textBox) return;
      // 예전 데이터엔 background 필드가 아예 없을 수 있어(기본값 true로 취급) !== false로 판정한다.
      const current = this.textBox.background !== false;
      this.tree.updateTextBox(this.textBox.id, { background: !current });
    });

    this.el.querySelector(".tb-delete").addEventListener("click", () => {
      if (!this.textBox) return;
      if (confirm("이 텍스트 박스를 삭제할까요?")) {
        this.tree.removeTextBox(this.textBox.id);
        this.close();
      }
    });
  }

  _syncTextBoxBgButton() {
    const btn = this.el.querySelector(".tb-bg-btn");
    const on = this.textBox?.background !== false;
    btn.textContent = on ? "ON" : "OFF";
    btn.classList.toggle("active", on);
  }

  /** 인물/텍스트 박스처럼, 관계선을 클릭했을 때도 사이드바를 띄워서 라벨/색/선 종류를 고칠 수 있게 한다. */
  openRelationship(rel) {
    if (this.mode !== "relationship") {
      this._buildRelationshipSkeleton();
      this.mode = "relationship";
    }
    this.person = null;
    this.textBox = null;
    this.relationship = rel;
    this.el.querySelector(".rel-type-display").textContent = TYPE_DISPLAY_NAME[rel.type] || rel.type;
    this.el.querySelector(".rel-label").value = rel.label || "";
    this._syncRelationshipColorAndStyle(rel); // .rel-linestyle 값도 여기서 같이 채운다(중복 방지)
    this._syncArrowControls(rel);
    this.el.classList.add("open");
  }

  /** 화살표 유형일 때만 보이는 컨트롤(단방향/양방향, 방향 바꾸기) — 다른 유형은 방향 개념이
   * 없으므로(부모-자식/배우자/기타는 선 자체가 방향을 안 나타냄) 이 구획 전체를 숨긴다. */
  _syncArrowControls(rel) {
    const section = this.el.querySelector(".rel-arrow-section");
    if (!section) return;
    const isArrow = rel.type === "arrow";
    section.hidden = !isArrow;
    if (!isArrow) return;
    const kindEl = this.el.querySelector(".rel-arrow-kind");
    if (kindEl) kindEl.value = rel.bidirectional ? "both" : "one";
  }

  /** 색상 스와치의 "선택됨" 표시 + 네이티브 color input 값을 rel에 맞춰 갱신한다. */
  _syncRelationshipColorAndStyle(rel) {
    const colorInput = this.el.querySelector(".rel-color-input");
    if (colorInput && document.activeElement !== colorInput) colorInput.value = rel.color || defaultColorFor(rel.type);
    for (const sw of this.el.querySelectorAll(".rel-color-swatch")) {
      sw.classList.toggle("active", !!rel.color && sw.dataset.color === rel.color);
    }
    const linestyleEl = this.el.querySelector(".rel-linestyle");
    if (linestyleEl && document.activeElement !== linestyleEl) linestyleEl.value = rel.lineStyle || "solid";
  }

  _buildRelationshipSkeleton() {
    this.el.innerHTML = `
      <div class="inspector-header">
        <strong>관계 정보</strong>
        <button type="button" class="inspector-close" aria-label="닫기">×</button>
      </div>
      <label>유형</label>
      <div class="rel-type-display"></div>
      <div class="rel-arrow-section" hidden>
        <label>화살표 종류
          <select class="rel-arrow-kind">
            <option value="one">단방향</option>
            <option value="both">양방향</option>
          </select>
        </label>
        <button type="button" class="rel-arrow-flip">↔ 방향 바꾸기</button>
      </div>
      <label>라벨
        <input type="text" class="rel-label" placeholder="예: 장남, 재혼 등">
      </label>
      <label>색상</label>
      <div class="rel-color-swatches">
        ${COLOR_PRESETS.map((c) => `<button type="button" class="rel-color-swatch" data-color="${c}" style="background:${c}" title="${c}"></button>`).join("")}
      </div>
      <div class="rel-color-custom-row">
        <input type="color" class="rel-color-input" title="직접 고르기">
        <button type="button" class="rel-color-reset">기본값</button>
      </div>
      <label>선 종류
        <select class="rel-linestyle">
          ${Object.entries(LINE_STYLE_PRESETS).map(([key, { label }]) => `<option value="${key}">${label}</option>`).join("")}
        </select>
      </label>
      <button type="button" class="rel-delete">이 관계선 삭제</button>
    `;

    this.el.querySelector(".inspector-close").onclick = () => this.close();

    this.el.querySelector(".rel-label").addEventListener("input", (e) => {
      if (!this.relationship) return;
      this.tree.updateRelationship(this.relationship.id, { label: e.target.value });
    });

    this.el.querySelector(".rel-arrow-kind").addEventListener("change", (e) => {
      if (!this.relationship) return;
      this.tree.updateRelationship(this.relationship.id, { bidirectional: e.target.value === "both" });
    });

    // fromId/toId를 서로 바꿔서 화살표가 가리키는 방향을 뒤집는다(양방향이면 시각적으로는
    // 표가 안 나지만, 나중에 단방향으로 바꿨을 때를 위해 어느 쪽이 "시작"인지는 계속 바뀐다).
    this.el.querySelector(".rel-arrow-flip").addEventListener("click", () => {
      if (!this.relationship) return;
      const { fromId, toId } = this.relationship;
      this.tree.updateRelationship(this.relationship.id, { fromId: toId, toId: fromId });
    });

    for (const sw of this.el.querySelectorAll(".rel-color-swatch")) {
      sw.addEventListener("click", () => {
        if (!this.relationship) return;
        this.tree.updateRelationship(this.relationship.id, { color: sw.dataset.color });
      });
    }

    this.el.querySelector(".rel-color-input").addEventListener("input", (e) => {
      if (!this.relationship) return;
      this.tree.updateRelationship(this.relationship.id, { color: e.target.value });
    });

    this.el.querySelector(".rel-color-reset").addEventListener("click", () => {
      if (!this.relationship) return;
      this.tree.updateRelationship(this.relationship.id, { color: null });
    });

    this.el.querySelector(".rel-linestyle").addEventListener("change", (e) => {
      if (!this.relationship) return;
      // "기본값"(비어있는 선택지) 자체가 없어졌으므로 여기 값은 항상 solid/dashed/dotted 중 하나다.
      this.tree.updateRelationship(this.relationship.id, { lineStyle: e.target.value });
    });

    this.el.querySelector(".rel-delete").addEventListener("click", () => {
      if (!this.relationship) return;
      if (confirm("이 관계선을 삭제할까요?")) {
        this.tree.removeRelationship(this.relationship.id);
        this.close();
      }
    });
  }

  /** 템플릿 슬롯을 클릭했을 때(템플릿 수정 중이어도) 사이드바를 띄운다 — 예전엔 클릭하면 바로
   * 삭제 확인창이 떴는데, 인물/텍스트박스/관계선/필드와 똑같이 사이드바를 통해서만 지우게 한다. */
  openTemplateSlot(fieldId, slot) {
    if (this.mode !== "template-slot") {
      this._buildTemplateSlotSkeleton();
      this.mode = "template-slot";
    }
    this.person = null;
    this.textBox = null;
    this.relationship = null;
    this.field = null;
    this.templateRel = null;
    this.templateSlotFieldId = fieldId;
    this.templateSlot = slot;
    this.el.classList.add("open");
  }

  _buildTemplateSlotSkeleton() {
    this.el.innerHTML = `
      <div class="inspector-header">
        <strong>템플릿 자리</strong>
        <button type="button" class="inspector-close" aria-label="닫기">×</button>
      </div>
      <p class="field-hint">이 자리는 실제 인물을 드래그해 꽂을 수 있는 템플릿 슬롯입니다. 템플릿 수정이 켜진 동안 드래그로 위치를 옮길 수 있어요.</p>
      <button type="button" class="tslot-delete">이 템플릿 자리 삭제</button>
    `;

    this.el.querySelector(".inspector-close").onclick = () => this.close();

    this.el.querySelector(".tslot-delete").addEventListener("click", () => {
      if (!this.templateSlot) return;
      if (confirm("이 템플릿 자리를 삭제할까요? 여기 걸린 템플릿 관계도 함께 지워집니다.")) {
        this.tree.removeTemplateSlot(this.templateSlotFieldId, this.templateSlot.id);
        this.close();
      }
    });
  }

  /** 템플릿 슬롯끼리 그은 "관계"(안내선)를 클릭했을 때 사이드바를 띄운다 — 실제 관계선과 거의
   * 같은 항목(라벨/색/선 종류/화살표 방향)을 편집할 수 있고, 양쪽 슬롯이 채워져 실제 관계선이
   * 돼 있으면(materializedRelIds) 그 값도 바로 같이 반영된다(Tree.updateTemplateRelationship). */
  openTemplateRelationship(fieldId, tr) {
    if (this.mode !== "template-rel") {
      this._buildTemplateRelSkeleton();
      this.mode = "template-rel";
    }
    this.person = null;
    this.textBox = null;
    this.relationship = null;
    this.field = null;
    this.templateSlot = null;
    this.templateRelFieldId = fieldId;
    this.templateRel = tr;
    this.el.querySelector(".trel-type-display").textContent = TYPE_DISPLAY_NAME[tr.type] || tr.type;
    this.el.querySelector(".trel-label").value = tr.label || "";
    this._syncTemplateRelColorAndStyle(tr);
    this._syncTemplateRelArrowControls(tr);
    this.el.classList.add("open");
  }

  _syncTemplateRelArrowControls(tr) {
    const section = this.el.querySelector(".trel-arrow-section");
    if (!section) return;
    const isArrow = tr.type === "arrow";
    section.hidden = !isArrow;
    if (!isArrow) return;
    const kindEl = this.el.querySelector(".trel-arrow-kind");
    if (kindEl) kindEl.value = tr.bidirectional ? "both" : "one";
  }

  _syncTemplateRelColorAndStyle(tr) {
    const colorInput = this.el.querySelector(".trel-color-input");
    if (colorInput && document.activeElement !== colorInput) colorInput.value = tr.color || defaultColorFor(tr.type);
    for (const sw of this.el.querySelectorAll(".trel-color-swatches .rel-color-swatch")) {
      sw.classList.toggle("active", !!tr.color && sw.dataset.color === tr.color);
    }
    const linestyleEl = this.el.querySelector(".trel-linestyle");
    if (linestyleEl && document.activeElement !== linestyleEl) linestyleEl.value = tr.lineStyle || "solid";
  }

  _buildTemplateRelSkeleton() {
    this.el.innerHTML = `
      <div class="inspector-header">
        <strong>템플릿 관계</strong>
        <button type="button" class="inspector-close" aria-label="닫기">×</button>
      </div>
      <label>유형</label>
      <div class="trel-type-display"></div>
      <div class="trel-arrow-section" hidden>
        <label>화살표 종류
          <select class="trel-arrow-kind">
            <option value="one">단방향</option>
            <option value="both">양방향</option>
          </select>
        </label>
        <button type="button" class="trel-arrow-flip">↔ 방향 바꾸기</button>
      </div>
      <label>라벨
        <input type="text" class="trel-label" placeholder="예: 장남, 재혼 등">
      </label>
      <label>색상</label>
      <div class="rel-color-swatches trel-color-swatches">
        ${COLOR_PRESETS.map((c) => `<button type="button" class="rel-color-swatch" data-color="${c}" style="background:${c}" title="${c}"></button>`).join("")}
      </div>
      <div class="rel-color-custom-row">
        <input type="color" class="trel-color-input" title="직접 고르기">
        <button type="button" class="trel-color-reset">기본값</button>
      </div>
      <label>선 종류
        <select class="trel-linestyle">
          ${Object.entries(LINE_STYLE_PRESETS).map(([key, { label }]) => `<option value="${key}">${label}</option>`).join("")}
        </select>
      </label>
      <p class="field-hint">양쪽(또는 세) 슬롯에 실제 인물이 모두 채워지면 이 설정 그대로 진짜 관계선이 됩니다.</p>
      <button type="button" class="trel-delete">이 템플릿 관계 삭제</button>
    `;

    this.el.querySelector(".inspector-close").onclick = () => this.close();

    this.el.querySelector(".trel-label").addEventListener("input", (e) => {
      if (!this.templateRel) return;
      this.tree.updateTemplateRelationship(this.templateRelFieldId, this.templateRel.id, { label: e.target.value });
    });

    this.el.querySelector(".trel-arrow-kind").addEventListener("change", (e) => {
      if (!this.templateRel) return;
      this.tree.updateTemplateRelationship(this.templateRelFieldId, this.templateRel.id, { bidirectional: e.target.value === "both" });
    });

    // 슬롯 순서(slotIds)를 뒤집어서 화살표 방향을 바꾼다 — 실제 관계선의 fromId/toId 뒤집기와 같은 원리.
    this.el.querySelector(".trel-arrow-flip").addEventListener("click", () => {
      if (!this.templateRel) return;
      const [a, b] = this.templateRel.slotIds;
      this.tree.updateTemplateRelationship(this.templateRelFieldId, this.templateRel.id, { slotIds: [b, a] });
    });

    for (const sw of this.el.querySelectorAll(".trel-color-swatches .rel-color-swatch")) {
      sw.addEventListener("click", () => {
        if (!this.templateRel) return;
        this.tree.updateTemplateRelationship(this.templateRelFieldId, this.templateRel.id, { color: sw.dataset.color });
      });
    }

    this.el.querySelector(".trel-color-input").addEventListener("input", (e) => {
      if (!this.templateRel) return;
      this.tree.updateTemplateRelationship(this.templateRelFieldId, this.templateRel.id, { color: e.target.value });
    });

    this.el.querySelector(".trel-color-reset").addEventListener("click", () => {
      if (!this.templateRel) return;
      this.tree.updateTemplateRelationship(this.templateRelFieldId, this.templateRel.id, { color: null });
    });

    this.el.querySelector(".trel-linestyle").addEventListener("change", (e) => {
      if (!this.templateRel) return;
      this.tree.updateTemplateRelationship(this.templateRelFieldId, this.templateRel.id, { lineStyle: e.target.value });
    });

    this.el.querySelector(".trel-delete").addEventListener("click", () => {
      if (!this.templateRel) return;
      if (confirm("이 템플릿 관계를 삭제할까요?")) {
        this.tree.removeTemplateRelationship(this.templateRelFieldId, this.templateRel.id);
        this.close();
      }
    });
  }

  /** 인물/텍스트박스/관계선처럼, 필드를 클릭했을 때 사이드바를 띄운다 — 완전히 빈 컨테이너라
   * 이름/텍스트 입력창은 없고, 템플릿 수정/잠금 토글과 삭제 버튼만 둔다. */
  openField(field) {
    if (this.mode !== "field") {
      this._buildFieldSkeleton();
      this.mode = "field";
    }
    this.person = null;
    this.textBox = null;
    this.relationship = null;
    this.templateSlot = null;
    this.templateRel = null;
    this.field = field;
    this._syncFieldControls();
    this.el.classList.add("open");
  }

  _buildFieldSkeleton() {
    this.el.innerHTML = `
      <div class="inspector-header">
        <strong>필드</strong>
        <button type="button" class="inspector-close" aria-label="닫기">×</button>
      </div>
      <label class="toggle-row">
        <span>템플릿 수정</span>
        <button type="button" class="field-template-btn" title="켜면 템플릿 자리를 추가·이동·삭제할 수 있어요">OFF</button>
      </label>
      <button type="button" class="field-template-add" hidden>+ 템플릿 추가</button>
      <p class="field-hint">템플릿 수정이 켜진 동안 "+ 템플릿 추가"로 인물 자리(점선)를 만들고, 드래그해서 위치를 옮기거나 클릭하면 삭제할 수 있어요.</p>
      <label class="toggle-row">
        <span>포함된 인물 잠금</span>
        <button type="button" class="field-lock-btn" title="켜면 포함된 오브젝트는 필드를 옮겨야만 같이 움직여요(개별 이동 불가)">🔓</button>
      </label>
      <label class="toggle-row">
        <span>새 요소 추가 잠금</span>
        <button type="button" class="field-addlock-btn" title="켜는 순간의 멤버로 고정 — 그 뒤로 필드 위에 새로 올라오는 오브젝트는 필드 것으로 안 쳐요">🔓</button>
      </label>
      <label class="toggle-row">
        <span>필드 위치 잠금</span>
        <button type="button" class="field-self-lock-btn" title="켜면 이 필드 자신을 드래그(단독/마키 모두)로 못 옮겨요">🔓</button>
      </label>
      <details class="p-attr-section">
        <summary><span class="p-attr-arrow">▸</span> 속성</summary>
        <label>배경색</label>
        <div class="field-bg-swatches rel-color-swatches">
          ${COLOR_PRESETS.map((c) => `<button type="button" class="rel-color-swatch" data-color="${c}" style="background:${c}" title="${c}"></button>`).join("")}
        </div>
        <div class="rel-color-custom-row">
          <input type="color" class="field-bg-color" title="직접 고르기">
          <button type="button" class="field-bg-reset">기본값</button>
        </div>
        <label>테두리색</label>
        <div class="field-border-swatches rel-color-swatches">
          ${COLOR_PRESETS.map((c) => `<button type="button" class="rel-color-swatch" data-color="${c}" style="background:${c}" title="${c}"></button>`).join("")}
        </div>
        <div class="rel-color-custom-row">
          <input type="color" class="field-border-color" title="직접 고르기">
          <button type="button" class="field-border-reset">기본값</button>
        </div>
        <label>테두리 굵기 <span class="field-border-width-value"></span>
          <input type="range" class="field-border-width" min="0" max="10" step="1">
        </label>
        <label>테두리 모양
          <select class="field-borderstyle">
            ${Object.entries(LINE_STYLE_PRESETS).map(([key, { label }]) => `<option value="${key}">${label}</option>`).join("")}
          </select>
        </label>
      </details>
      <button type="button" class="field-delete">이 필드 삭제</button>
    `;

    this.el.querySelector(".inspector-close").onclick = () => this.close();

    this.el.querySelector(".field-template-btn").addEventListener("click", () => {
      if (!this.field) return;
      this.tree.updateField(this.field.id, { templateMode: !this.field.templateMode });
    });

    // 새 템플릿 자리는 왼쪽 위부터 격자로 순서대로 놓는다(무작위로 흩뿌리면 이미 있던 슬롯이나
    // 인물과 우연히 겹쳐서 찾기/잡기 힘든 자리에 생길 수 있음) — 정확한 위치는 템플릿 수정 중
    // 드래그로 옮기면 된다("템플릿 위치 이동"). 간격(SPACING)은 슬롯 지름(--photo-size 96px)
    // 보다 넉넉히 둬서 슬롯끼리는 항상 안 겹치게 한다.
    this.el.querySelector(".field-template-add").addEventListener("click", () => {
      if (!this.field) return;
      const SPACING = 110;
      const cols = Math.max(1, Math.floor(this.field.width / SPACING));
      const index = this.field.templateSlots.length;
      const relX = 60 + (index % cols) * SPACING;
      const relY = 60 + Math.floor(index / cols) * SPACING;
      this.tree.updateField(this.field.id, {
        templateSlots: [...this.field.templateSlots, { id: uuid(), relX, relY }],
      });
    });

    this.el.querySelector(".field-lock-btn").addEventListener("click", () => {
      if (!this.field) return;
      this.tree.updateField(this.field.id, { locked: !this.field.locked });
    });

    this.el.querySelector(".field-addlock-btn").addEventListener("click", () => {
      if (!this.field) return;
      if (this.field.addLocked) {
        this.tree.updateField(this.field.id, { addLocked: false });
        return;
      }
      // 켜는 순간 지금 이 필드 위에 올라가 있는 멤버를 스냅샷으로 고정한다 — 그 뒤로 새로
      // 겹치는 오브젝트는(이 목록에 없는 한) 필드 것으로 인정되지 않는다.
      const members = this.getFieldMembers ? this.getFieldMembers(this.field) : { people: [], textBoxes: [] };
      this.tree.updateField(this.field.id, {
        addLocked: true,
        lockedMemberIds: [...members.people, ...members.textBoxes],
      });
    });

    this.el.querySelector(".field-self-lock-btn").addEventListener("click", () => {
      if (!this.field) return;
      this.tree.updateField(this.field.id, { selfLocked: !this.field.selfLocked });
    });

    this._wireFieldDecorationInputs();

    this.el.querySelector(".field-delete").addEventListener("click", () => {
      if (!this.field) return;
      if (confirm("이 필드를 삭제할까요? 안에 있던 인물/텍스트박스는 그대로 남습니다.")) {
        this.tree.removeField(this.field.id);
        this.close();
      }
    });
  }

  /** 필드 배경색/테두리색·굵기·모양 — 인물 사진 테두리(스와치+커스텀 색상+기본값 되돌리기)와
   * 같은 구성을 배경/테두리 두 벌로 반복한다. */
  _wireFieldDecorationInputs() {
    for (const sw of this.el.querySelectorAll(".field-bg-swatches .rel-color-swatch")) {
      sw.addEventListener("click", () => {
        if (!this.field) return;
        this.tree.updateField(this.field.id, { bgColor: sw.dataset.color });
        this._syncFieldDecorationControls();
      });
    }
    this.el.querySelector(".field-bg-color").addEventListener("input", (e) => {
      if (!this.field) return;
      this.tree.updateField(this.field.id, { bgColor: e.target.value });
      this._syncFieldDecorationControls();
    });
    this.el.querySelector(".field-bg-reset").addEventListener("click", () => {
      if (!this.field) return;
      this.tree.updateField(this.field.id, { bgColor: null });
      this._syncFieldDecorationControls();
    });

    for (const sw of this.el.querySelectorAll(".field-border-swatches .rel-color-swatch")) {
      sw.addEventListener("click", () => {
        if (!this.field) return;
        this.tree.updateField(this.field.id, { borderColor: sw.dataset.color });
        this._syncFieldDecorationControls();
      });
    }
    this.el.querySelector(".field-border-color").addEventListener("input", (e) => {
      if (!this.field) return;
      this.tree.updateField(this.field.id, { borderColor: e.target.value });
      this._syncFieldDecorationControls();
    });
    this.el.querySelector(".field-border-reset").addEventListener("click", () => {
      if (!this.field) return;
      this.tree.updateField(this.field.id, { borderColor: null });
      this._syncFieldDecorationControls();
    });
    this.el.querySelector(".field-border-width").addEventListener("input", (e) => {
      if (!this.field) return;
      this.tree.updateField(this.field.id, { borderWidth: parseInt(e.target.value, 10) });
      this.el.querySelector(".field-border-width-value").textContent = `${e.target.value}px`;
    });
    this.el.querySelector(".field-borderstyle").addEventListener("change", (e) => {
      if (!this.field) return;
      this.tree.updateField(this.field.id, { borderStyle: e.target.value });
    });
  }

  /** 배경/테두리 스와치의 "선택됨" 표시 + 색상/굵기/모양 입력값을 field에 맞춰 갱신한다. */
  _syncFieldDecorationControls() {
    const DEFAULT_BORDER_WIDTH = 1.5; // style.css의 .field-content 기본 굵기와 맞춘 값
    const field = this.field;
    if (!field) return;

    // 기본값(null)일 땐 실제 테마 변수의 현재 값을 보여준다(다크/라이트에 따라 다름).
    const surfaceDefault = getComputedStyle(document.documentElement).getPropertyValue("--surface").trim();
    const bgInput = this.el.querySelector(".field-bg-color");
    bgInput.value = field.bgColor || surfaceDefault || "#ffffff";
    for (const sw of this.el.querySelectorAll(".field-bg-swatches .rel-color-swatch")) {
      sw.classList.toggle("active", !!field.bgColor && sw.dataset.color === field.bgColor);
    }

    const borderDefault = getComputedStyle(document.documentElement).getPropertyValue("--border").trim();
    const borderInput = this.el.querySelector(".field-border-color");
    borderInput.value = field.borderColor || borderDefault || "#000000";
    for (const sw of this.el.querySelectorAll(".field-border-swatches .rel-color-swatch")) {
      sw.classList.toggle("active", !!field.borderColor && sw.dataset.color === field.borderColor);
    }

    const width = field.borderWidth ?? DEFAULT_BORDER_WIDTH;
    this.el.querySelector(".field-border-width").value = width;
    this.el.querySelector(".field-border-width-value").textContent = `${width}px`;

    this.el.querySelector(".field-borderstyle").value = field.borderStyle || "dashed";
  }

  _syncFieldControls() {
    const templateOn = !!this.field?.templateMode;
    const templateBtn = this.el.querySelector(".field-template-btn");
    templateBtn.textContent = templateOn ? "ON" : "OFF";
    templateBtn.classList.toggle("active", templateOn);
    this.el.querySelector(".field-template-add").hidden = !templateOn;

    const lockBtn = this.el.querySelector(".field-lock-btn");
    const locked = !!this.field?.locked;
    lockBtn.textContent = locked ? "🔒" : "🔓";
    lockBtn.classList.toggle("active", locked);
    lockBtn.title = locked ? "잠김 — 눌러서 풀기" : "포함된 인물 잠금";

    const addLockBtn = this.el.querySelector(".field-addlock-btn");
    const addLocked = !!this.field?.addLocked;
    addLockBtn.textContent = addLocked ? "🔒" : "🔓";
    addLockBtn.classList.toggle("active", addLocked);
    addLockBtn.title = addLocked ? "잠김 — 눌러서 풀기" : "새 요소 추가 잠금";

    const selfLockBtn = this.el.querySelector(".field-self-lock-btn");
    const selfLocked = !!this.field?.selfLocked;
    selfLockBtn.textContent = selfLocked ? "🔒" : "🔓";
    selfLockBtn.classList.toggle("active", selfLocked);
    selfLockBtn.title = selfLocked ? "잠김 — 눌러서 풀기" : "필드 위치 잠금";

    this._syncFieldDecorationControls();
  }

  close() {
    this.person = null;
    this.textBox = null;
    this.relationship = null;
    this.field = null;
    this.templateSlot = null;
    this.templateRel = null;
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
