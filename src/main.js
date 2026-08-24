import { TreeModel } from "./core/Tree.js";
import { TreeStore } from "./core/db.js";
import { UndoManager } from "./core/UndoManager.js";
import { Camera } from "./view/Camera.js";
import { DragController } from "./view/DragController.js";
import { TreeRenderer } from "./view/TreeRenderer.js";
import { Toolbar } from "./ui/Toolbar.js";
import { InspectorPanel } from "./ui/InspectorPanel.js";

const viewportEl = document.getElementById("viewport");
const stageEl = document.getElementById("stage");
const worldEl = document.getElementById("world");
const linesEl = document.getElementById("lines-layer");
const toolbarEl = document.getElementById("toolbar");
const inspectorEl = document.getElementById("inspector");
const emptyHintEl = document.getElementById("empty-hint");
const relTypeModal = document.getElementById("rel-type-modal");
const trashEl = document.getElementById("trash-drop");
const cropModalEl = document.getElementById("crop-modal");

const tree = new TreeModel();
const store = new TreeStore();
const undoMgr = new UndoManager(tree);

const camera = new Camera(viewportEl, stageEl, {
  onChange: (view) => {
    tree.view = view;
    viewportEl.style.backgroundPosition = `${view.panX}px ${view.panY}px`;
    viewportEl.style.backgroundSize = `${24 * view.scale}px ${24 * view.scale}px`;
  },
});

let connectMode = false;
let connectType = null; // 연결 모드에서 미리 골라둔 관계 유형
let connectPicks = []; // 지금까지 순서대로 고른 인물 id들

const CONNECT_TYPE_NAMES = {
  "parent-child-solo": "부모-자식(부모1)",
  "parent-child": "부모-자식(부모2)",
  spouse: "배우자",
  custom: "기타",
};

// 유형별로 몇 명을 골라야 관계가 만들어지는지, 그리고 각 단계에서 보여줄 안내 문구.
const CONNECT_STEP_HINTS = {
  "parent-child-solo": ["부모를 클릭하세요", "자식을 클릭하세요"],
  "parent-child": ["부모1을 클릭하세요", "부모2를 클릭하세요", "자식을 클릭하세요"],
  spouse: ["첫 번째 배우자를 클릭하세요", "두 번째 배우자를 클릭하세요"],
  custom: ["첫 번째 인물을 클릭하세요", "두 번째 인물을 클릭하세요"],
};

const renderer = new TreeRenderer({
  tree,
  worldEl,
  linesEl,
  camera,
  store,
  onCardClick: handleCardClick,
  onLineClick: handleLineClick,
  trashEl,
});

const inspector = new InspectorPanel(inspectorEl, {
  tree,
  store,
  onImageChange: (personId, url, photoId) => {
    // photoId가 있으면(파일/드래그/붙여넣기/URL 다운로드 성공) 렌더러의 objectURL 캐시에도
    // 먼저 채워둔다 — 뒤이어 발생하는 person:update가 IndexedDB를 다시 읽으러 가지 않고
    // 바로 이 값을 재사용하게 되어, 카드에 사진이 반영되는 게 지연 없이 즉시 이루어진다.
    if (photoId) renderer.photoUrls.set(photoId, url);
    const el = renderer.cardEls.get(personId);
    el?.querySelector(".person-photo img")?.setAttribute("src", url);
  },
  getAllTags: () => {
    const set = new Set();
    for (const p of tree.people.values()) for (const t of p.tags || []) set.add(t);
    return [...set];
  },
  cropModalEl,
});

const toolbar = new Toolbar(toolbarEl, {
  addPerson: () => {
    const rect = viewportEl.getBoundingClientRect();
    const { x, y } = camera.screenToWorld(rect.left + rect.width / 2, rect.top + rect.height / 2);
    const jitter = () => (Math.random() - 0.5) * 40;
    const person = tree.addPerson({ x: x + jitter(), y: y + jitter() });
    handleCardClick(person.id);
  },
  connect: () => {
    if (connectMode) exitConnectMode();
    else enterConnectMode();
  },
  addTextbox: () => {
    const rect = viewportEl.getBoundingClientRect();
    const { x, y } = camera.screenToWorld(rect.left + rect.width / 2, rect.top + rect.height / 2);
    const jitter = () => (Math.random() - 0.5) * 40;
    tree.addTextBox({ x: x + jitter(), y: y + jitter() });
  },
  zoomIn: () => zoomAtCenter(1.25),
  zoomOut: () => zoomAtCenter(1 / 1.25),
  zoomReset: () => camera.resetView(),
  fit: () => camera.fitToContent(tree.getBounds()),
  undo: () => undoMgr.performUndo(),
  redo: () => undoMgr.performRedo(),
  export: doExport,
  import: doImport,
  themeToggle: () => {
    const isDark = document.documentElement.getAttribute("data-theme") === "dark";
    applyTheme(isDark ? "light" : "dark");
  },
});

const THEME_KEY = "gagedo-theme";
function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  toolbar.setThemeIcon(theme === "dark");
  try { localStorage.setItem(THEME_KEY, theme); } catch { /* 저장 안 돼도(시크릿 모드 등) 화면 전환 자체는 되게 둔다 */ }
}
// index.html의 인라인 스크립트가 깜빡임 방지를 위해 이 스크립트보다 먼저 data-theme를 이미
// 정해뒀다 — 툴바 아이콘을 그 값에 맞춰 동기화한다(여기서 다시 localStorage에 쓸 필요는 없다).
toolbar.setThemeIcon(document.documentElement.getAttribute("data-theme") === "dark");

function zoomAtCenter(factor) {
  const rect = viewportEl.getBoundingClientRect();
  camera.zoomBy(factor, rect.left + rect.width / 2, rect.top + rect.height / 2);
}

// 배경 드래그 = 캔버스 팬 / 배경 클릭 = 선택 해제 (카드/텍스트 박스 위에서는 동작하지 않도록 filter로 제외)
const backgroundDrag = new DragController(viewportEl, {
  filter: (e) => !e.target.closest(".person-card") && !e.target.closest(".text-box"),
  onDragStart: () => camera.setTransforming(true),
  onDragMove: (dx, dy) => camera.pan(dx, dy),
  onDragEnd: () => camera.setTransforming(false),
  onClick: () => {
    if (connectMode) return;
    renderer.setSelected(null);
    inspector.close();
  },
});
camera.onPinchStart = () => backgroundDrag.cancelDrag();

function handleCardClick(id) {
  if (connectMode) {
    const idx = connectPicks.indexOf(id);
    if (idx !== -1) {
      // 이미 고른 사람을 다시 클릭하면 그 선택만 취소한다(순서 중 아무 단계에서나 되돌릴 수 있게).
      connectPicks.splice(idx, 1);
    } else {
      connectPicks.push(id);
    }
    renderer.setSelectedMany(connectPicks);

    const required = (CONNECT_STEP_HINTS[connectType] || []).length || 2;
    if (connectPicks.length >= required) {
      finalizeConnection(connectType, connectPicks);
      connectPicks = [];
      renderer.setSelectedMany([]);
    }
    toolbar.setConnectMode(true, connectStatusText());
    return;
  }
  renderer.setSelected(id);
  const person = tree.people.get(id);
  if (person) inspector.open(person);
}

/** 유형별로 고른 인물 순서를 실제 관계(들)로 바꾼다. */
function finalizeConnection(type, picks) {
  if (type === "parent-child") {
    // 부모1, 부모2, 자식 순서 — 두 부모 사이에 배우자 관계가 없으면 만들어 두고(이미 있으면
    // addRelationship이 중복으로 보고 조용히 무시한다), 자식 선은 그 특정 배우자를 명시해 이어서
    // (viaSpouseId) 부모가 배우자를 여럿 두고 있어도 어느 부부 선에서 내려오는지 헷갈리지 않게 한다.
    const [parent1, parent2, child] = picks;
    tree.addRelationship({ fromId: parent1, toId: parent2, type: "spouse" });
    tree.addRelationship({ fromId: parent1, toId: child, type: "parent-child", viaSpouseId: parent2 });
  } else if (type === "parent-child-solo") {
    const [parent, child] = picks;
    tree.addRelationship({ fromId: parent, toId: child, type: "parent-child-solo" });
  } else {
    const [a, b] = picks;
    tree.addRelationship({ fromId: a, toId: b, type });
  }
}

/** 툴바 버튼에 "지금 몇 번째 인물을 고를 차례인지" 안내를 보여준다. */
function connectStatusText() {
  const hints = CONNECT_STEP_HINTS[connectType] || [];
  const hint = hints[connectPicks.length];
  const base = CONNECT_TYPE_NAMES[connectType];
  return hint ? `${base} · ${hint}` : base;
}

function handleLineClick(relId) {
  if (!tree.relationships.get(relId)) return;
  if (confirm("이 관계선을 삭제할까요?")) tree.removeRelationship(relId);
}

/** "관계 연결" 클릭 시 사람을 고르기 전에 관계 유형부터 먼저 고르게 한다. */
function enterConnectMode() {
  relTypeModal.classList.add("open");
  const cleanup = () => {
    relTypeModal.classList.remove("open");
    relTypeModal.onclick = null;
  };
  relTypeModal.onclick = (e) => {
    const btn = e.target.closest("button[data-type]");
    if (btn) {
      connectType = btn.dataset.type;
      connectMode = true;
      connectPicks = [];
      toolbar.setConnectMode(true, connectStatusText());
      viewportEl.classList.add("connect-mode");
      cleanup();
    } else if (e.target.dataset.action === "cancel" || e.target === relTypeModal) {
      cleanup();
    }
  };
}

function exitConnectMode() {
  connectMode = false;
  connectType = null;
  connectPicks = [];
  toolbar.setConnectMode(false);
  viewportEl.classList.remove("connect-mode");
  renderer.setSelectedMany([]);
}

async function doExport() {
  const data = await store.exportJSON(tree);
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `family-tree-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

async function doImport(file) {
  if (!confirm("현재 가계도를 덮어씁니다. 계속할까요?")) return;
  try {
    const data = JSON.parse(await file.text());
    // 가져올 데이터가 지금 세션에서 쓰던 photoId를 우연히 재사용해도(예: 사진을 바꾼 뒤 예전
    // 내보내기 파일을 다시 불러오는 경우) 캐시된 옛 이미지가 아니라 반드시 새로 읽어오게 한다.
    renderer.photoUrls.clear();
    await store.importJSON(data, tree);
    camera.fitToContent(tree.getBounds());
  } catch (err) {
    console.error(err);
    alert("파일을 읽는 중 문제가 발생했습니다. 올바른 가계도 JSON 파일인지 확인해주세요.");
  }
}

function updateEmptyHint() {
  emptyHintEl.style.display = tree.people.size ? "none" : "flex";
}
tree.onChange(updateEmptyHint);

// 어떤 경로로든(휴지통 드래그 등) 인물이 삭제되면, 그 인물이 지금 인스펙터에 열려 있던 경우 닫는다.
tree.onChange((type, payload) => {
  if (type === "person:remove" && inspector.person?.id === payload) inspector.close();
});

let saveTimer = null;
tree.onChange(() => {
  toolbar.setSaveState("저장 중…");
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    await store.saveAll(tree);
    toolbar.setSaveState("저장됨");
  }, 500);
});

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  relTypeModal.classList.remove("open");
  relTypeModal.onclick = null;
  if (connectMode) exitConnectMode();
  inspector.close();
  renderer.setSelected(null);
});

async function init() {
  const data = await store.loadAll();
  tree.loadJSON(data); // "reset" 이벤트를 통해 renderer.renderAll()이 이미 트리거된다
  camera.fitToContent(tree.getBounds(), { animate: false }); // 첫 로드는 애니메이션 없이 바로 맞춘다
  updateEmptyHint();
  toolbar.setSaveState("저장됨");
}

init();
