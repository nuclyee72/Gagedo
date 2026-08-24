import { loadBitmap } from "../utils/imageUtils.js";

const EDIT_SIZE = 280; // 편집 화면에 보여줄 정사각형 캔버스 크기
const OUTPUT_SIZE = 512; // 최종 저장할 이미지 크기
const MIN_ZOOM = 1;
const MAX_ZOOM = 3;

/**
 * 원형 아바타에 들어갈 사진의 위치(드래그로 이동)와 확대/축소(슬라이더)를 조정하는 모달 편집기.
 * open(source)에 File/Blob을 넘기면, 사용자가 "적용"을 누른 결과 Blob으로(취소하면 null로) resolve된다.
 */
export class ImageCropEditor {
  constructor(modalEl) {
    this.modalEl = modalEl;
    this.canvas = modalEl.querySelector("#crop-canvas");
    this.ctx = this.canvas.getContext("2d");
    this.zoomInput = modalEl.querySelector("#crop-zoom");
    this.applyBtn = modalEl.querySelector('[data-action="crop-apply"]');
    this.cancelBtn = modalEl.querySelector('[data-action="crop-cancel"]');

    this.bitmap = null;
    this.baseScale = 1;
    this.zoom = 1;
    this.offsetX = 0;
    this.offsetY = 0;
    this._dragging = false;
    this._lastX = 0;
    this._lastY = 0;
    this._resolve = null;

    this._wireEvents();
  }

  /** source: File 또는 Blob. 사용자가 취소하면 null, 적용하면 잘라낸 결과 Blob으로 resolve된다. */
  open(source) {
    return new Promise((resolve) => {
      this._resolve = resolve;
      loadBitmap(source).then((bitmap) => {
        this.bitmap = bitmap;
        this.baseScale = Math.max(EDIT_SIZE / bitmap.width, EDIT_SIZE / bitmap.height);
        this.zoom = 1;
        this.offsetX = 0;
        this.offsetY = 0;
        this.zoomInput.value = "1";
        this.modalEl.classList.add("open");
        this._draw();
      });
    });
  }

  _wireEvents() {
    this.canvas.addEventListener("pointerdown", (e) => {
      this._dragging = true;
      this._lastX = e.clientX;
      this._lastY = e.clientY;
      try { this.canvas.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    });
    this.canvas.addEventListener("pointermove", (e) => {
      if (!this._dragging) return;
      this.offsetX += e.clientX - this._lastX;
      this.offsetY += e.clientY - this._lastY;
      this._lastX = e.clientX;
      this._lastY = e.clientY;
      this._clampOffset();
      this._draw();
    });
    const endDrag = () => { this._dragging = false; };
    this.canvas.addEventListener("pointerup", endDrag);
    this.canvas.addEventListener("pointercancel", endDrag);

    this.zoomInput.addEventListener("input", () => {
      this.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, parseFloat(this.zoomInput.value)));
      this._clampOffset();
      this._draw();
    });

    this.applyBtn.addEventListener("click", () => this._finish(true));
    this.cancelBtn.addEventListener("click", () => this._finish(false));
    this.modalEl.addEventListener("click", (e) => {
      if (e.target === this.modalEl) this._finish(false);
    });
  }

  /** 확대/이동해도 이미지가 원 밖으로 빈틈을 보이지 않도록 오프셋 범위를 제한한다. */
  _clampOffset() {
    const scale = this.baseScale * this.zoom;
    const drawnW = this.bitmap.width * scale;
    const drawnH = this.bitmap.height * scale;
    const maxX = Math.max(0, (drawnW - EDIT_SIZE) / 2);
    const maxY = Math.max(0, (drawnH - EDIT_SIZE) / 2);
    this.offsetX = Math.min(maxX, Math.max(-maxX, this.offsetX));
    this.offsetY = Math.min(maxY, Math.max(-maxY, this.offsetY));
  }

  _draw() {
    const scale = this.baseScale * this.zoom;
    const drawnW = this.bitmap.width * scale;
    const drawnH = this.bitmap.height * scale;
    const x = (EDIT_SIZE - drawnW) / 2 + this.offsetX;
    const y = (EDIT_SIZE - drawnH) / 2 + this.offsetY;
    this.ctx.clearRect(0, 0, EDIT_SIZE, EDIT_SIZE);
    this.ctx.drawImage(this.bitmap, x, y, drawnW, drawnH);
  }

  async _finish(applied) {
    this.modalEl.classList.remove("open");
    if (!applied || !this.bitmap) {
      this.bitmap = null;
      const resolve = this._resolve;
      this._resolve = null;
      resolve?.(null);
      return;
    }

    // 편집 화면(EDIT_SIZE)에서 본 그대로를 OUTPUT_SIZE 해상도로 다시 그려서 최종 결과를 만든다.
    const ratio = OUTPUT_SIZE / EDIT_SIZE;
    const scale = this.baseScale * this.zoom * ratio;
    const drawnW = this.bitmap.width * scale;
    const drawnH = this.bitmap.height * scale;
    const x = (OUTPUT_SIZE - drawnW) / 2 + this.offsetX * ratio;
    const y = (OUTPUT_SIZE - drawnH) / 2 + this.offsetY * ratio;

    const outCanvas = document.createElement("canvas");
    outCanvas.width = OUTPUT_SIZE;
    outCanvas.height = OUTPUT_SIZE;
    const outCtx = outCanvas.getContext("2d");
    outCtx.drawImage(this.bitmap, x, y, drawnW, drawnH);

    this.bitmap = null;
    const blob = await new Promise((resolve) => outCanvas.toBlob(resolve, "image/webp", 0.85));
    const resolve = this._resolve;
    this._resolve = null;
    resolve?.(blob);
  }
}
