/**
 * Pointer Events 기반 범용 "드래그 vs 클릭" 판별기.
 * Adv_Sudoku_Maker(src/ui/DragPanel.js)의 방식을 그대로 이식:
 *  - pointerdown 시점엔 아직 드래그로 확정하지 않음
 *  - pointermove 누적 이동거리가 DRAG_THRESHOLD(5px)를 넘는 순간 드래그로 전환 + pointer capture
 *  - 임계값 이전엔 아무 것도 하지 않다가 pointerup에서 그대로 "클릭"으로 처리
 *  - 캔버스 팬, 카드 이동 등 여러 상호작용에서 재사용한다.
 *
 * pointermove/pointerup은 대상 엘리먼트가 아니라 window에 건다: 아직 pointer capture가
 * 걸리기 전(=임계값을 넘기 전) 첫 이동이 카드 자신의 영역보다 크게 움직이면(빠른 드래그),
 * 커서가 이미 카드 밖으로 나가버려 대상 엘리먼트는 그 이동을 아예 못 받고 드래그 자체가
 * 시작되지 못하는 문제가 있었다. window에 걸면 커서가 어디로 튀든 항상 받는다.
 */
const DRAG_THRESHOLD = 5;
const CLICK_GUARD_MS = 150;

export class DragController {
  constructor(el, handlers = {}) {
    this.el = el;
    this.onDragStart = handlers.onDragStart || (() => {});
    this.onDragMove = handlers.onDragMove || (() => {});
    this.onDragEnd = handlers.onDragEnd || (() => {});
    this.onClick = handlers.onClick || (() => {});
    this.filter = handlers.filter || (() => true);

    this._active = false;
    this._isDrag = false;
    this._startX = 0;
    this._startY = 0;
    this._lastX = 0;
    this._lastY = 0;
    this._pointerId = null;
    this._dragEndedAt = 0;

    this._boundOnDown = this._onDown.bind(this);
    this._boundOnMove = this._onMove.bind(this);
    this._boundOnUp = this._onUp.bind(this);

    el.addEventListener("pointerdown", this._boundOnDown);
    window.addEventListener("pointermove", this._boundOnMove);
    window.addEventListener("pointerup", this._boundOnUp);
    window.addEventListener("pointercancel", this._boundOnUp);
  }

  /**
   * window에 건 리스너는 카드가 DOM에서 사라져도 저절로 정리되지 않는다(window는 절대 GC되지
   * 않으므로) — 카드를 삭제할 때 반드시 이 메서드로 리스너를 해제해야 한다.
   */
  destroy() {
    this.cancelDrag();
    this.el.removeEventListener("pointerdown", this._boundOnDown);
    window.removeEventListener("pointermove", this._boundOnMove);
    window.removeEventListener("pointerup", this._boundOnUp);
    window.removeEventListener("pointercancel", this._boundOnUp);
  }

  /** 방금 드래그가 끝났는지(클릭 오인식 방지용) */
  wasDragging() {
    return performance.now() - this._dragEndedAt < CLICK_GUARD_MS;
  }

  /** 외부(예: 핀치 줌 시작)에서 진행 중인 드래그를 조용히 중단시킬 때 사용 */
  cancelDrag() {
    if (!this._active) return;
    this._active = false;
    this._isDrag = false;
    if (this._pointerId !== null) {
      try { this.el.releasePointerCapture(this._pointerId); } catch { /* ignore */ }
    }
    this._pointerId = null;
  }

  _onDown(e) {
    if (!this.filter(e)) return;
    this._active = true;
    this._isDrag = false;
    this._pointerId = e.pointerId;
    this._startX = this._lastX = e.clientX;
    this._startY = this._lastY = e.clientY;
  }

  _onMove(e) {
    if (!this._active || e.pointerId !== this._pointerId) return;
    if (!this._isDrag) {
      const total = Math.hypot(e.clientX - this._startX, e.clientY - this._startY);
      if (total <= DRAG_THRESHOLD) return;
      this._isDrag = true;
      try { this.el.setPointerCapture(this._pointerId); } catch { /* ignore */ }
      this.onDragStart(e);
    }
    const dx = e.clientX - this._lastX;
    const dy = e.clientY - this._lastY;
    this._lastX = e.clientX;
    this._lastY = e.clientY;
    this.onDragMove(dx, dy, e);
  }

  _onUp(e) {
    if (!this._active || e.pointerId !== this._pointerId) return;
    this._active = false;
    if (this._isDrag) {
      this._isDrag = false;
      this._dragEndedAt = performance.now();
      try { this.el.releasePointerCapture(this._pointerId); } catch { /* ignore */ }
      this.onDragEnd(e);
    } else {
      this.onClick(e);
    }
    this._pointerId = null;
  }
}
