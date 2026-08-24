/**
 * 화면 팬/줌 컨트롤러.
 * Adv_Sudoku_Maker(src/ui/BoardRenderer.js)의 조작 로직을 그대로 이식:
 *  - 휠: 커서 아래 논리 좌표를 앵커로 고정한 채 RAF로 부드럽게(LERP) 확대/축소
 *  - 핀치: 두 포인터 간 거리 비율로 확대/축소, 중점을 앵커로 사용
 *  - 배율 범위는 clamp, 팬은 DragController가 별도로 처리(캔버스 배경 드래그)
 *
 * setTransforming(true/false): 팬/줌이 "진행 중"인 동안만 #stage에 will-change:transform을
 * 걸고, 멈추면 곧바로 뗀다. will-change를 항상 걸어두면 브라우저가 확대/축소할 때마다 다시
 * 그리지 않고 이미 래스터화된 화면을 그냥 GPU로 늘리거나 줄이기만 해서, 축소해서 볼 때 특히
 * 전체적으로 흐릿하게 보인다 — 조작이 멈춘 뒤에는 원래 해상도로 다시 그리게 해서 선명하게 만든다.
 */
const MIN_SCALE = 0.2;
const MAX_SCALE = 3;
const LERP = 0.18;
const SETTLE_EPSILON = 0.0004;

export class Camera {
  constructor(viewportEl, stageEl, opts = {}) {
    this.viewport = viewportEl;
    this.stage = stageEl;
    this.panX = opts.panX ?? 0;
    this.panY = opts.panY ?? 0;
    this.scale = opts.scale ?? 1;
    this._onChange = opts.onChange || (() => {});
    this.onPinchStart = null; // 외부에서 배경 드래그(pan)를 취소시키는 데 사용

    this._targetScale = this.scale;
    this._anchorClientX = 0;
    this._anchorClientY = 0;
    this._anchorWorldX = 0;
    this._anchorWorldY = 0;
    this._raf = null;

    this._apply();
    this._bindWheel();
    this._bindPinch();
  }

  screenToWorld(clientX, clientY) {
    const rect = this.viewport.getBoundingClientRect();
    return {
      x: (clientX - rect.left - this.panX) / this.scale,
      y: (clientY - rect.top - this.panY) / this.scale,
    };
  }

  worldToScreen(x, y) {
    const rect = this.viewport.getBoundingClientRect();
    return {
      x: rect.left + this.panX + x * this.scale,
      y: rect.top + this.panY + y * this.scale,
    };
  }

  pan(dx, dy) {
    this.panX += dx;
    this.panY += dy;
    this._apply();
  }

  /** 팬/줌이 진행 중인 동안만 true로 — 끝나면 반드시 false로 돌려 화면을 선명하게 되돌린다. */
  setTransforming(active) {
    this.stage.classList.toggle("is-transforming", active);
  }

  setScaleAt(clientX, clientY, newScale) {
    newScale = clamp(newScale, MIN_SCALE, MAX_SCALE);
    const rect = this.viewport.getBoundingClientRect();
    const worldX = (clientX - rect.left - this.panX) / this.scale;
    const worldY = (clientY - rect.top - this.panY) / this.scale;
    this.scale = newScale;
    this.panX = clientX - rect.left - worldX * newScale;
    this.panY = clientY - rect.top - worldY * newScale;
    this._apply();
  }

  zoomBy(factor, clientX, clientY) {
    this.setScaleAt(clientX, clientY, this.scale * factor);
  }

  resetView() {
    this.panX = 0;
    this.panY = 0;
    this.scale = 1;
    this._apply();
  }

  /** bounds(월드 좌표계) 전체가 화면에 들어오도록 맞춘다(부드럽게 애니메이션). 좌우 여백을
   *  위아래보다 조금 더 둬서(paddingX > paddingY) 카드가 화면 가장자리에 바짝 붙어 보이지 않게 한다. */
  fitToContent(bounds, { paddingX = 140, paddingY = 100, animate = true } = {}) {
    if (!bounds) return this.resetView();
    const rect = this.viewport.getBoundingClientRect();
    const w = Math.max(1, bounds.maxX - bounds.minX);
    const h = Math.max(1, bounds.maxY - bounds.minY);
    const scale = clamp(
      Math.min((rect.width - paddingX * 2) / w, (rect.height - paddingY * 2) / h),
      MIN_SCALE,
      MAX_SCALE
    );
    const cx = (bounds.minX + bounds.maxX) / 2;
    const cy = (bounds.minY + bounds.maxY) / 2;
    const targetPanX = rect.width / 2 - cx * scale;
    const targetPanY = rect.height / 2 - cy * scale;
    if (!animate) {
      this.panX = targetPanX;
      this.panY = targetPanY;
      this.scale = scale;
      this._apply();
      return;
    }
    this._animateTo(targetPanX, targetPanY, scale);
  }

  /** panX/panY/scale을 목표 값까지 짧게 애니메이션(ease-out)한다. 전체보기처럼 "한 번에 툭"
   *  움직이면 어지러운 조작을 부드러운 이동으로 바꿀 때 쓴다. */
  _animateTo(targetPanX, targetPanY, targetScale, duration = 420) {
    if (this._fitRaf) cancelAnimationFrame(this._fitRaf);
    const startPanX = this.panX;
    const startPanY = this.panY;
    const startScale = this.scale;
    const startTime = performance.now();
    this.setTransforming(true);
    const step = (now) => {
      const t = Math.min(1, (now - startTime) / duration);
      const eased = 1 - Math.pow(1 - t, 3); // ease-out cubic
      this.panX = startPanX + (targetPanX - startPanX) * eased;
      this.panY = startPanY + (targetPanY - startPanY) * eased;
      this.scale = startScale + (targetScale - startScale) * eased;
      this._apply();
      if (t < 1) {
        this._fitRaf = requestAnimationFrame(step);
      } else {
        this.panX = targetPanX;
        this.panY = targetPanY;
        this.scale = targetScale;
        this._apply();
        this.setTransforming(false);
        this._fitRaf = null;
      }
    };
    this._fitRaf = requestAnimationFrame(step);
  }

  _apply() {
    this.stage.style.transform = `translate(${this.panX}px, ${this.panY}px) scale(${this.scale})`;
    this._onChange({ panX: this.panX, panY: this.panY, scale: this.scale });
  }

  _bindWheel() {
    this.viewport.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        if (this._raf === null) {
          // 새 줌 제스처 시작 시점의 앵커(월드 좌표)를 캡처
          const w = this.screenToWorld(e.clientX, e.clientY);
          this._anchorWorldX = w.x;
          this._anchorWorldY = w.y;
          this._targetScale = this.scale;
          this.setTransforming(true);
        }
        this._anchorClientX = e.clientX;
        this._anchorClientY = e.clientY;
        this._targetScale = clamp(this._targetScale * Math.pow(0.999, e.deltaY), MIN_SCALE, MAX_SCALE);
        if (this._raf === null) this._tick();
      },
      { passive: false }
    );
  }

  _tick() {
    const diff = this._targetScale - this.scale;
    if (Math.abs(diff) < SETTLE_EPSILON) {
      this.scale = this._targetScale;
      this._applyAnchored();
      this._raf = null;
      this.setTransforming(false);
      return;
    }
    this.scale += diff * LERP;
    this._applyAnchored();
    this._raf = requestAnimationFrame(() => this._tick());
  }

  _applyAnchored() {
    const rect = this.viewport.getBoundingClientRect();
    this.panX = this._anchorClientX - rect.left - this._anchorWorldX * this.scale;
    this.panY = this._anchorClientY - rect.top - this._anchorWorldY * this.scale;
    this._apply();
  }

  _bindPinch() {
    const pointers = new Map();
    let startDist = 0;
    let startScale = 1;
    let anchorWorldX = 0;
    let anchorWorldY = 0;

    const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

    this.viewport.addEventListener("pointerdown", (e) => {
      if (e.pointerType !== "touch") return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 2) {
        this.onPinchStart && this.onPinchStart();
        this.setTransforming(true);
        const [a, b] = [...pointers.values()];
        startDist = dist(a, b) || 1;
        startScale = this.scale;
        const m = mid(a, b);
        const w = this.screenToWorld(m.x, m.y);
        anchorWorldX = w.x;
        anchorWorldY = w.y;
      }
    });

    this.viewport.addEventListener("pointermove", (e) => {
      if (!pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size !== 2) return;
      const [a, b] = [...pointers.values()];
      const newScale = clamp(startScale * (dist(a, b) / startDist), MIN_SCALE, MAX_SCALE);
      const m = mid(a, b);
      const rect = this.viewport.getBoundingClientRect();
      this.scale = newScale;
      this.panX = m.x - rect.left - anchorWorldX * newScale;
      this.panY = m.y - rect.top - anchorWorldY * newScale;
      this._apply();
    });

    const release = (e) => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) this.setTransforming(false);
    };
    this.viewport.addEventListener("pointerup", release);
    this.viewport.addEventListener("pointercancel", release);
  }
}

function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}
