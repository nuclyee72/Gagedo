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
        <button type="button" data-action="connect" class="toggle">&amp;관계</button>
      </div>
      <div class="toolbar-group">
        <button type="button" data-action="zoom-out" aria-label="축소">－</button>
        <button type="button" data-action="zoom-reset">100%</button>
        <button type="button" data-action="zoom-in" aria-label="확대">＋</button>
        <button type="button" data-action="fit" title="전체보기" aria-label="전체보기">⛶</button>
      </div>
      <div class="toolbar-group">
        <button type="button" data-action="auto-arrange" title="세대별로 가로열을 맞춰 자동으로 정렬합니다">🧩 정렬</button>
      </div>
      <div class="toolbar-group">
        <button type="button" data-action="undo" title="실행취소" aria-label="실행취소">↶</button>
        <button type="button" data-action="redo" title="다시실행" aria-label="다시실행">↷</button>
      </div>
      <div class="toolbar-group toolbar-group-right">
        <button type="button" data-action="export">내보내기</button>
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
  }

  /** typeLabel: 연결 모드가 켜져 있는 동안 미리 골라둔 관계 유형 이름(버튼에 표시용). */
  setConnectMode(active, typeLabel) {
    const btn = this.el.querySelector('[data-action="connect"]');
    btn.classList.toggle("active", active);
    btn.textContent = active && typeLabel ? `& ${typeLabel} 연결 중` : "&관계";
  }

  setSaveState(text) {
    this.el.querySelector('[data-role="save-indicator"]').textContent = text;
  }
}

function toCamel(s) {
  return s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}
