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
        <div class="toolbar-dropdown connect-dropdown">
          <button type="button" data-action="connect" class="toggle">&amp;관계</button>
          <div class="toolbar-dropdown-menu connect-type-menu">
            <button type="button" data-type="parent-child-solo">부모-자식(부모1)</button>
            <button type="button" data-type="parent-child">부모-자식(부모2)</button>
            <button type="button" data-type="spouse">배우자</button>
            <button type="button" data-type="arrow">화살표</button>
            <button type="button" data-type="custom">기타</button>
          </div>
        </div>
        <button type="button" data-action="add-textbox">텍스트</button>
      </div>
      <div class="toolbar-group toolbar-zoom-group">
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
        <div class="toolbar-dropdown io-dropdown">
          <button type="button" data-action="io-menu" title="내보내기/가져오기" aria-label="내보내기/가져오기">💾</button>
          <div class="toolbar-dropdown-menu io-menu-list">
            <button type="button" data-io="export-json">JSON으로 내보내기</button>
            <button type="button" data-io="export-svg">SVG로 저장</button>
            <button type="button" data-io="export-png">PNG로 저장</button>
            <label class="file-btn">가져오기<input type="file" accept="application/json" data-action="import"></label>
          </div>
        </div>
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

    // 💾 버튼 자체는 토글만 담당(생성/가져오기 로직은 없음) — 데이터 액션 위임 리스너에는
    // 대응하는 핸들러가 없어도(io-menu) 무해하니 별도 리스너로 직접 처리한다.
    this.el.querySelector('[data-action="io-menu"]').addEventListener("click", () => this.toggleIoMenu());

    // 내보내기 형식 3개(JSON/SVG/PNG) 버튼 — data-io만 갖고 data-action은 없어서 위 위임과 안 겹친다.
    this.el.querySelector(".io-menu-list").addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-io]");
      if (!btn) return;
      this.closeIoMenu();
      const handler = this.handlers[toCamel(btn.dataset.io)];
      handler && handler();
    });

    // "가져오기" 라벨을 누르는 순간(실제 파일 선택 전이라도) 메뉴부터 닫는다 — 파일 선택창은
    // OS 모달이라 그 뒤에 드롭다운이 계속 열려 보이면 어색하다.
    this.el.querySelector(".io-menu-list .file-btn").addEventListener("click", () => this.closeIoMenu());

    // 드롭다운 바깥을 클릭하면(고르지 않고) 각각 닫는다.
    document.addEventListener("click", (e) => {
      if (!e.target.closest(".connect-dropdown")) this.closeTypeMenu();
      if (!e.target.closest(".io-dropdown")) this.closeIoMenu();
    });
  }

  openTypeMenu() {
    const dropdown = this.el.querySelector(".connect-dropdown");
    dropdown.classList.add("open");
    this._positionMobileMenu(dropdown);
  }

  closeTypeMenu() {
    this.el.querySelector(".connect-dropdown").classList.remove("open");
  }

  toggleTypeMenu() {
    const dropdown = this.el.querySelector(".connect-dropdown");
    dropdown.classList.toggle("open");
    if (dropdown.classList.contains("open")) this._positionMobileMenu(dropdown);
  }

  closeIoMenu() {
    this.el.querySelector(".io-dropdown").classList.remove("open");
  }

  toggleIoMenu() {
    const dropdown = this.el.querySelector(".io-dropdown");
    dropdown.classList.toggle("open");
    if (dropdown.classList.contains("open")) this._positionMobileMenu(dropdown);
  }

  /**
   * 모바일(폭 640px 이하)에서 드롭다운 메뉴 위치를 직접 계산해 넣는다 — #toolbar가 좁은 화면에서
   * 가로 스크롤(overflow-x:auto)이 되는데, CSS 규칙상 overflow-x가 visible이 아니면 overflow-y도
   * 강제로 auto가 되어서(브라우저가 자동으로 맞춤) .toolbar-dropdown-menu가 버튼 아래로 튀어나온
   * 부분이 그대로 잘려 안 보이는 문제가 있었다. 데스크톱처럼 position:absolute로 두면 이 클리핑을
   * 피할 수 없으므로, 모바일에서는 style.css가 position:fixed로 바꿔두고 여기서 버튼의 실제 화면
   * 좌표를 재서 인라인 top/left로 넣어준다(fixed는 조상의 overflow 클리핑에 안 걸림). 데스크톱
   * 폭이면(또는 다시 데스크톱으로 돌아오면) 인라인 값을 지워 CSS의 원래 계산식으로 되돌린다.
   */
  _positionMobileMenu(dropdownEl) {
    const menu = dropdownEl.querySelector(".toolbar-dropdown-menu");
    if (!menu) return;
    if (!window.matchMedia("(max-width: 640px)").matches) {
      menu.style.top = "";
      menu.style.left = "";
      return;
    }
    const btn = dropdownEl.querySelector(":scope > button");
    if (!btn) return;
    const btnRect = btn.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect(); // .open으로 이미 display:flex라 실제 크기를 잴 수 있음
    const margin = 6;
    let left = btnRect.left;
    if (left + menuRect.width > window.innerWidth - margin) left = window.innerWidth - menuRect.width - margin;
    if (left < margin) left = margin;
    menu.style.top = `${btnRect.bottom + margin}px`;
    menu.style.left = `${left}px`;
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
