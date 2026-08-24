const SNAPSHOT_DEBOUNCE_MS = 400;

/**
 * 트리 모델 전체를 스냅샷(JSON 문자열)으로 찍어 undo/redo 스택에 쌓는다.
 * 드래그 이동·연속 타이핑처럼 짧은 시간 안에 몰아치는 변경은 하나의 되돌리기 단위로 묶는다:
 * 새로운 "변경 묶음"이 시작될 때만 그 직전 상태를 undo 스택에 push 하고,
 * 이후 SNAPSHOT_DEBOUNCE_MS 동안 변경이 없으면 그 시점 상태를 "직전 상태"로 확정한다.
 */
export class UndoManager {
  constructor(tree, { limit = 50 } = {}) {
    this.tree = tree;
    this.limit = limit;
    this.undoStack = [];
    this.redoStack = [];
    this._restoring = false;
    this._timer = null;
    this._lastSnapshot = this._snapshot();

    tree.onChange(() => {
      if (this._restoring) return;
      if (this._timer === null) {
        this.undoStack.push(this._lastSnapshot);
        if (this.undoStack.length > this.limit) this.undoStack.shift();
        this.redoStack.length = 0;
      }
      clearTimeout(this._timer);
      this._timer = setTimeout(() => {
        this._lastSnapshot = this._snapshot();
        this._timer = null;
      }, SNAPSHOT_DEBOUNCE_MS);
    });
  }

  _snapshot() {
    return JSON.stringify(this.tree.toJSON());
  }

  canUndo() {
    return this.undoStack.length > 0;
  }

  canRedo() {
    return this.redoStack.length > 0;
  }

  performUndo() {
    if (!this.undoStack.length) return;
    const current = this._snapshot();
    const prev = this.undoStack.pop();
    this.redoStack.push(current);
    this._restore(prev);
  }

  performRedo() {
    if (!this.redoStack.length) return;
    const current = this._snapshot();
    const next = this.redoStack.pop();
    this.undoStack.push(current);
    this._restore(next);
  }

  _restore(snapshotStr) {
    clearTimeout(this._timer);
    this._timer = null;
    this._restoring = true;
    this.tree.loadJSON(JSON.parse(snapshotStr));
    this._restoring = false;
    this._lastSnapshot = snapshotStr;
  }
}
