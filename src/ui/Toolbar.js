export class Toolbar {
  constructor(el, handlers = {}) {
    this.el = el;
    this.handlers = handlers;
    this._render();
  }

  _render() {
    this.el.innerHTML = `
      <div class="toolbar-group">
        <button type="button" data-action="add-person">+인물</button>
        <div class="connect-dropdown">
          <button type="button" data-action="connect" class="toggle">&amp;관계</button>
          <div class="connect-type-menu">
            <button type="button" data-type="parent-child-solo">부모-자식(부모1)</button>
            <button type="button" data-type="parent-child">부모-자식(부모2)</button>
            <button type="button" data-type="spouse">배우자</button>
            <button type="button" data-type="custom">기타</button>
          </div>
        </div>
        <button type="button" data-action="add-textbox">텍스트</button>
      </div>
      <div class="toolbar-group">
        <button type="button" data-action="zoom-out" aria-label="축소">－</button>
        <button type="button" data-action="zoom-reset">100%</button>
        <button type="button" data-action="zoom-in" aria-label="확대">＋</button>
        <button type="button" data-action="fit" title="전체보기" aria-label="전체보기">⛶</button>
      </div>
      <div class="toolbar-group">
        <button type="button" data-action="undo" title="실행취소" aria-label="실행취소">↶</button>
        <button type="button" data-action="redo" title="다시실행" aria-label="다시실행">↷</button>
      </div>
      <div class="toolbar-group toolbar-group-right">
        <button type="button" data-action="theme-toggle" title="다크 모드 전환" aria-label="다크 모드 전환">🌙</button>
      </div>
      <div class="toolbar-group">
        <button type="button" data-action="export">내보내기</button>
        <button type="button" data-action="export-image">이미지 저장</button>
        <label class="file-btn">가져오기<input type="file" accept="application/json" data-action="import"></label>
      </div>
      <span class="save-indicator" data-role="save-indicator">저장됨</span>
    `;

    this.el.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-action]");
      if (!btn) return;
      const handler = this.handlers[toCamel(btn.dataset.action)];
      handler && handler(e);
    });

    this.el.querySelector('input[data-action="import"]').addEventListener("change", (e) => {
      const file = e.target.files[0];
      e.target.value = "";
      if (file) this.handlers.import && this.handlers.import(file);
    });

    // "&관계" 버튼 바로 아래 세로 드롭다운으로 유형을 고른다(예전엔 화면 중앙 모달이었음).
    // 유형 버튼은 data-type만 갖고 data-action은 없어서 위 위임 리스너와 안 겹친다.
    this.el.querySelector(".connect-type-menu").addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-type]");
      if (!btn) return;
      this.closeTypeMenu();
      this.handlers.pickConnectType && this.handlers.pickConnectType(btn.dataset.type);
    });

    // 드롭다운 바깥을 클릭하면(유형을 안 고르고) 닫는다.
    document.addEventListener("click", (e) => {
      if (!e.target.closest(".connect-dropdown")) this.closeTypeMenu();
    });
  }

  openTypeMenu() {
    this.el.querySelector(".connect-dropdown").classList.add("open");
  }

  closeTypeMenu() {
    this.el.querySelector(".connect-dropdown").classList.remove("open");
  }

  toggleTypeMenu() {
    this.el.querySelector(".connect-dropdown").classList.toggle("open");
  }

  /** typeLabel: 연결 모드가 켜져 있는 동안 미리 골라둔 관계 유형 이름(버튼에 표시용). */
  setConnectMode(active, typeLabel) {
    const btn = this.el.querySelector('[data-action="connect"]');
    btn.classList.toggle("active", active);
    btn.textContent = active && typeLabel ? `& ${typeLabel} 연결 중` : "&관계";
    // 연결 모드가 켜지거나 꺼지는 순간엔 유형 고르는 드롭다운이 열려 있을 이유가 없으니 같이 닫는다.
    this.closeTypeMenu();
  }

  setSaveState(text) {
    this.el.querySelector('[data-role="save-indicator"]').textContent = text;
  }

  /** isDark: 지금 다크 모드가 켜져 있는지 — 버튼엔 눌렀을 때 바뀔 "다음" 모드의 아이콘을 보여준다. */
  setThemeIcon(isDark) {
    this.el.querySelector('[data-action="theme-toggle"]').textContent = isDark ? "☀️" : "🌙";
  }
}

function toCamel(s) {
  return s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}
