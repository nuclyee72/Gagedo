import { TreeModel } from "./core/Tree.js";
import { TreeStore } from "./core/db.js";
import { UndoManager } from "./core/UndoManager.js";
import { Camera } from "./view/Camera.js";
import { DragController } from "./view/DragController.js";
import { TreeRenderer } from "./view/TreeRenderer.js";
import { Toolbar } from "./ui/Toolbar.js";
import { InspectorPanel } from "./ui/InspectorPanel.js";
import { downloadTreeSVG, downloadTreePNG } from "./utils/svgExport.js";
import { uuid } from "./utils/uuid.js";

const viewportEl = document.getElementById("viewport");
const stageEl = document.getElementById("stage");
const worldEl = document.getElementById("world");
const linesEl = document.getElementById("lines-layer");
const fieldsEl = document.getElementById("fields-layer");
const toolbarEl = document.getElementById("toolbar");
const inspectorEl = document.getElementById("inspector");
const emptyHintEl = document.getElementById("empty-hint");
const trashEl = document.getElementById("trash-drop");
const cropModalEl = document.getElementById("crop-modal");
const marqueeBoxEl = document.getElementById("marquee-box");
const bulkToolbarEl = document.getElementById("bulk-toolbar");

// style.css의 모바일 분기(@media max-width:640px, 사이드바가 하단 시트로 바뀌는 지점)와
// 반드시 같은 값을 써야 한다 — 여기서만 따로 값이 어긋나면 "CSS는 모바일인데 JS는 데스크톱으로
// 판단"하는 것 같은 불일치가 생긴다.
const MOBILE_BREAKPOINT_MQ = window.matchMedia("(max-width: 640px)");
function isMobileLayout() {
  return MOBILE_BREAKPOINT_MQ.matches;
}

const tree = new TreeModel();
const store = new TreeStore();
const undoMgr = new UndoManager(tree);

// Camera 생성자가 초기 transform을 세팅하면서 onChange를 그 자리에서 바로 한 번 부르는데,
// 그 시점엔 아직 renderer가 없다(바로 아래에서 만들어짐) — let으로 미리 선언만 해두고 콜백
// 안에서는 optional chaining으로 안전하게 참조한다(그 첫 호출 때는 어차피 그려진 선이 없어
// 아무 것도 안 해도 무방).
let renderer;

const camera = new Camera(viewportEl, stageEl, {
  onChange: (view) => {
    tree.view = view;
    viewportEl.style.backgroundPosition = `${view.panX}px ${view.panY}px`;
    viewportEl.style.backgroundSize = `${24 * view.scale}px ${24 * view.scale}px`;
    // 관계선 굵기가 화면 배율과 무관하게 항상 같은 화면 픽셀 두께로 보이도록(확대/축소 시
    // 선만 상대적으로 굵어 보이는 문제 방지).
    renderer?.updateLineScaleForZoom();
  },
});

let connectMode = false;
let connectType = null; // 연결 모드에서 미리 골라둔 관계 유형
let connectPicks = []; // 지금까지 순서대로 고른 인물 id들(또는 슬롯 id들 — 아래 참고)
// 연결 모드 중 첫 클릭이 "인물"이 아니라 "템플릿 슬롯"이면, 그 시퀀스 전체를 템플릿 관계
// 만들기로 취급한다(사람과 슬롯을 섞어 고르는 건 지원하지 않음) — 그 대상 필드 id.
let connectTemplateFieldId = null;

// "+필드"를 누르면 곧바로 만들지 않고, 캔버스에 왼쪽 위에서 시작해 드래그로 크기를 정해
// 그리는 모드로 들어간다(도형 그리기 툴과 같은 방식) — 배경 드래그(backgroundDrag)가
// marqueeState/marqueeBoxEl을 재사용해 사각형을 그리고, 다 그리면 이 값을 다시 끈다.
let fieldDrawMode = false;

const CONNECT_TYPE_NAMES = {
  "parent-child-solo": "부모-자식(부모1)",
  "parent-child": "부모-자식(부모2)",
  spouse: "배우자",
  arrow: "화살표",
  custom: "기타",
};

// 유형별로 몇 명을 골라야 관계가 만들어지는지, 그리고 각 단계에서 보여줄 안내 문구.
const CONNECT_STEP_HINTS = {
  "parent-child-solo": ["부모를 클릭하세요", "자식을 클릭하세요"],
  "parent-child": ["부모1을 클릭하세요", "부모2를 클릭하세요", "자식을 클릭하세요"],
  spouse: ["첫 번째 배우자를 클릭하세요", "두 번째 배우자를 클릭하세요"],
  // 화살표는 방향이 있으므로 "시작(꼬리)"과 "끝(화살촉)"을 분명히 구분해서 안내한다.
  arrow: ["시작(꼬리) 인물을 클릭하세요", "끝(화살촉) 인물을 클릭하세요"],
  custom: ["첫 번째 인물을 클릭하세요", "두 번째 인물을 클릭하세요"],
};

renderer = new TreeRenderer({
  tree,
  worldEl,
  linesEl,
  fieldsEl,
  camera,
  store,
  onCardClick: handleCardClick,
  onLineClick: handleLineClick,
  onTextBoxClick: handleTextBoxClick,
  onFieldClick: handleFieldClick,
  onSlotClick: handleSlotClickForConnect,
  onTemplateSlotClick: handleTemplateSlotClick,
  onTemplateRelationshipClick: handleTemplateRelationshipClick,
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
  getFieldMembers: (field) => renderer._objectsWithinField(field),
  cropModalEl,
});

const toolbar = new Toolbar(toolbarEl, {
  addPerson: () => {
    const rect = viewportEl.getBoundingClientRect();
    const { x, y } = camera.screenToWorld(rect.left + rect.width / 2, rect.top + rect.height / 2);
    const jitter = () => (Math.random() - 0.5) * 40;
    const person = tree.addPerson({ x: x + jitter(), y: y + jitter() });
    // 모바일에서는 사이드바가 화면 하단 80%를 덮는 시트라, 방금 화면 중앙 근처에 생긴 카드를
    // 바로 가려버린다 — 데스크톱과 달리 자동으로 열지 않고 그냥 만들어만 둔다(원하면 직접 탭).
    if (!isMobileLayout()) handleCardClick(person.id);
  },
  connect: () => {
    if (connectMode) exitConnectMode();
    else toolbar.toggleTypeMenu();
  },
  pickConnectType: (type) => {
    if (fieldDrawMode) exitFieldDrawMode(); // 다른 모드로 넘어가면 필드 그리기 대기는 취소.
    connectType = type;
    connectMode = true;
    connectPicks = [];
    connectTemplateFieldId = null; // 새 시퀀스 시작 — 사람/슬롯 어느 쪽으로도 아직 안 정해짐
    toolbar.setConnectMode(true, connectStatusText());
    viewportEl.classList.add("connect-mode");
    renderer.clearMultiSelection();
    hideBulkToolbar();
  },
  addTextbox: () => {
    const rect = viewportEl.getBoundingClientRect();
    const { x, y } = camera.screenToWorld(rect.left + rect.width / 2, rect.top + rect.height / 2);
    const jitter = () => (Math.random() - 0.5) * 40;
    // 텍스트 박스는 (x,y)가 왼쪽 위 모서리라, 화면 중앙에 "보이도록" 만들려면 기본 크기
    // (Tree.js addTextBox의 기본값 200×50)의 절반만큼 왼쪽/위로 당겨서 놓아야 한다.
    tree.addTextBox({ x: x + jitter() - 100, y: y + jitter() - 25 });
  },
  addField: () => {
    // 다시 누르면 취소(연결 모드의 "&관계" 버튼과 같은 토글 규칙).
    if (fieldDrawMode) { exitFieldDrawMode(); return; }
    if (connectMode) exitConnectMode();
    fieldDrawMode = true;
    viewportEl.classList.add("field-draw-mode");
    renderer.clearMultiSelection();
    hideBulkToolbar();
  },
  zoomIn: () => zoomAtCenter(1.25),
  zoomOut: () => zoomAtCenter(1 / 1.25),
  zoomReset: () => camera.resetView(),
  fit: () => camera.fitToContent(tree.getBounds()),
  undo: () => undoMgr.performUndo(),
  redo: () => undoMgr.performRedo(),
  exportJson: doExport,
  exportSvg: doExportSvgImage,
  exportPng: doExportPngImage,
  import: doImport,
  themeToggle: () => {
    const isDark = document.documentElement.getAttribute("data-theme") === "dark";
    applyTheme(isDark ? "light" : "dark");
  },
});

// 사이드바(#inspector)는 top:0부터 시작하는 대신 툴바 실제 높이만큼 아래에서 시작해야 한다 —
// 안 그러면 툴바/사이드바가 화면 오른쪽 위에서 서로 겹치는데, z-index로 어느 한쪽을 위로 두는
// 순간 반대쪽의 그 자리에 있는 버튼(툴바의 내보내기/가져오기 또는 사이드바의 닫기 ×)이 클릭이
// 안 먹는 문제가 생긴다(실제로 겪음). 툴바 높이는 반응형 레이아웃(모바일 등)에 따라 달라지므로
// ResizeObserver로 실측해 CSS 변수로 넘긴다.
const syncToolbarHeight = () => {
  document.documentElement.style.setProperty("--toolbar-h", `${toolbarEl.getBoundingClientRect().height}px`);
};
new ResizeObserver(syncToolbarHeight).observe(toolbarEl);
syncToolbarHeight();

const THEME_KEY = "gagedo-theme";
function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  toolbar.setThemeIcon(theme === "dark");
  // 모바일 브라우저의 상단 상태 표시줄(주소창 등) 색도 테마에 맞춘다 — index.html의 인라인
  // 스크립트가 첫 페인트 전 초기값을 정하고, 여기서는 토글할 때마다 계속 맞춰준다.
  const themeMeta = document.getElementById("theme-color-meta");
  if (themeMeta) themeMeta.content = theme === "dark" ? "#1c2028" : "#ffffff";
  try { localStorage.setItem(THEME_KEY, theme); } catch { /* 저장 안 돼도(시크릿 모드 등) 화면 전환 자체는 되게 둔다 */ }
}
// index.html의 인라인 스크립트가 깜빡임 방지를 위해 이 스크립트보다 먼저 data-theme를 이미
// 정해뒀다 — 툴바 아이콘을 그 값에 맞춰 동기화한다(여기서 다시 localStorage에 쓸 필요는 없다).
toolbar.setThemeIcon(document.documentElement.getAttribute("data-theme") === "dark");

function zoomAtCenter(factor) {
  const rect = viewportEl.getBoundingClientRect();
  camera.zoomBy(factor, rect.left + rect.width / 2, rect.top + rect.height / 2);
}

// 배경 드래그 = 캔버스 팬(기본) / Shift+배경 드래그 = 마키(사각형) 다중 선택 / 배경 클릭 = 선택 해제
// (카드/텍스트 박스 위에서는 동작하지 않도록 filter로 제외)
let marqueeState = null; // { startX, startY }(화면 좌표) — 마키를 그리는 중일 때만 값이 있음

function updateMarqueeBox(curX, curY) {
  const x = Math.min(marqueeState.startX, curX);
  const y = Math.min(marqueeState.startY, curY);
  marqueeBoxEl.style.left = `${x}px`;
  marqueeBoxEl.style.top = `${y}px`;
  marqueeBoxEl.style.width = `${Math.abs(curX - marqueeState.startX)}px`;
  marqueeBoxEl.style.height = `${Math.abs(curY - marqueeState.startY)}px`;
}

function rectsIntersect(a, b) {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

// 마키를 그리는 도중에도(드롭하기 전부터) 지금 박스 안에 걸린 대상들을 실시간으로 미리 보여준다 —
// 잠기지 않은 건 선택 표시(테두리 glow)를, 잠긴 건 "어차피 이번엔 안 움직인다"는 걸 바로 알 수
// 있게 흐리게+자물쇠로 다르게 보여준다. 실제 다중선택 확정(renderer.multiSelected)은 여전히
// 마우스를 뗄 때(finalizeMarquee)만 일어나고, 이건 그 전까지의 순수 시각 미리보기일 뿐이라
// 별도의 엘리먼트 목록으로 직접 추적해서 정리한다.
let marqueeHoverEls = [];

function updateMarqueeHoverPreview() {
  const rect = marqueeBoxEl.getBoundingClientRect();
  const nextEls = [];
  for (const [id, el] of renderer.cardEls) {
    if (!rectsIntersect(rect, el.getBoundingClientRect())) continue;
    const locked = !!renderer.tree.people.get(id)?.locked;
    el.classList.toggle("drag-locked-preview", locked);
    el.classList.toggle("marquee-hover", !locked);
    nextEls.push(el);
  }
  for (const [id, el] of renderer.textBoxEls) {
    if (!rectsIntersect(rect, el.getBoundingClientRect())) continue;
    const locked = !!renderer.tree.textBoxes.get(id)?.locked;
    el.classList.toggle("drag-locked-preview", locked);
    el.classList.toggle("marquee-hover", !locked);
    nextEls.push(el);
  }
  for (const [id, el] of renderer.fieldEls) {
    if (!rectsIntersect(rect, el.getBoundingClientRect())) continue;
    // field.locked(내용물 잠금)가 아니라 selfLocked(필드 자신의 위치 잠금)를 봐야 한다 — 마키
    // 그룹 드래그에서 실제로 걸러지는 건 selfLocked 쪽이므로(_beginGroupDrag) 미리보기도 맞춰야 함.
    const locked = !!renderer.tree.fields.get(id)?.selfLocked;
    el.classList.toggle("drag-locked-preview", locked);
    el.classList.toggle("marquee-hover", !locked);
    nextEls.push(el);
  }
  const nextSet = new Set(nextEls);
  for (const el of marqueeHoverEls) {
    if (!nextSet.has(el)) el.classList.remove("marquee-hover", "drag-locked-preview");
  }
  marqueeHoverEls = nextEls;
}

function clearMarqueeHoverPreview() {
  for (const el of marqueeHoverEls) el.classList.remove("marquee-hover", "drag-locked-preview");
  marqueeHoverEls = [];
}

/** 마키 사각형과 겹치는 인물/텍스트박스를 모아 다중 선택으로 확정한다. 딱 하나만 걸리면 그냥
 * 평범한 단일 선택(사이드바 열기)으로 처리해서, "카드 하나만 작게 둘러싼" 경우를 클릭과
 * 비슷하게 느끼게 한다. */
function finalizeMarquee() {
  const rect = marqueeBoxEl.getBoundingClientRect();
  marqueeBoxEl.classList.remove("visible");
  marqueeState = null;
  clearMarqueeHoverPreview();

  const peopleIds = [];
  for (const [id, el] of renderer.cardEls) {
    if (rectsIntersect(rect, el.getBoundingClientRect())) peopleIds.push(id);
  }
  const textBoxIds = [];
  for (const [id, el] of renderer.textBoxEls) {
    if (rectsIntersect(rect, el.getBoundingClientRect())) textBoxIds.push(id);
  }
  const fieldIds = [];
  for (const [id, el] of renderer.fieldEls) {
    if (rectsIntersect(rect, el.getBoundingClientRect())) fieldIds.push(id);
  }

  const total = peopleIds.length + textBoxIds.length + fieldIds.length;
  if (total >= 2) {
    renderer.setSelected(null);
    renderer.setSelectedTextBox(null);
    renderer.setSelectedLine(null);
    renderer.setSelectedField(null);
    inspector.close();
    renderer.setMultiSelection({ people: peopleIds, textBoxes: textBoxIds, fields: fieldIds });
    updateBulkToolbar();
  } else if (total === 1) {
    renderer.clearMultiSelection();
    hideBulkToolbar();
    if (peopleIds.length) handleCardClick(peopleIds[0]);
    else if (textBoxIds.length) handleTextBoxClick(textBoxIds[0]);
    else handleFieldClick(fieldIds[0]);
  } else {
    renderer.clearMultiSelection();
    hideBulkToolbar();
  }
}

function exitFieldDrawMode() {
  fieldDrawMode = false;
  viewportEl.classList.remove("field-draw-mode");
}

// 필드 리사이즈 최소 크기(TreeRenderer.js._addField의 MIN_W/MIN_H와 맞춘 값)와 같은 기준으로
// clamp한다 — 드래그로 너무 작게(거의 클릭 수준으로) 그려도 다루기 힘든 필드가 되지 않도록.
const MIN_DRAWN_FIELD_W = 120;
const MIN_DRAWN_FIELD_H = 90;

/** 마키와 같은 사각형(marqueeBoxEl)을 드래그로 그려서 그 크기·위치 그대로 필드를 만든다
 * ("왼쪽 위부터 시작해서 드래그로 생성"). */
function finalizeFieldDraw() {
  const rect = marqueeBoxEl.getBoundingClientRect();
  marqueeBoxEl.classList.remove("visible");
  marqueeState = null;
  exitFieldDrawMode();

  const topLeft = camera.screenToWorld(rect.left, rect.top);
  const bottomRight = camera.screenToWorld(rect.right, rect.bottom);
  const width = Math.max(MIN_DRAWN_FIELD_W, bottomRight.x - topLeft.x);
  const height = Math.max(MIN_DRAWN_FIELD_H, bottomRight.y - topLeft.y);
  const field = tree.addField({ x: topLeft.x, y: topLeft.y, width, height });
  handleFieldClick(field.id);
}

function updateBulkToolbar() {
  const count = renderer.getMultiSelectionCount();
  if (count < 2) {
    hideBulkToolbar();
    return;
  }
  bulkToolbarEl.classList.add("visible");
  bulkToolbarEl.querySelector(".bulk-toolbar-count").textContent = `${count}개 선택됨`;
  const allLocked = renderer.isSelectionFullyLocked();
  const lockBtn = bulkToolbarEl.querySelector('[data-action="bulk-lock"]');
  // 아이콘은 "누르면 뭐가 될지"가 아니라 "지금 상태가 뭔지"를 보여준다 — 사이드바의 개별
  // 잠금 버튼(.f-lock-btn, 잠기면 🔒/풀리면 🔓)과 같은 규칙으로 통일.
  lockBtn.textContent = allLocked ? "🔒" : "🔓";
  lockBtn.title = allLocked ? "전체 잠김 — 눌러서 풀기" : "선택 잠금";
  lockBtn.classList.toggle("active", allLocked);
}

function hideBulkToolbar() {
  bulkToolbarEl.classList.remove("visible");
}

bulkToolbarEl.querySelector('[data-action="bulk-lock"]').addEventListener("click", () => {
  const allLocked = renderer.isSelectionFullyLocked();
  renderer.setLockedForSelection(!allLocked);
  updateBulkToolbar();
});

const backgroundDrag = new DragController(viewportEl, {
  filter: (e) => !e.target.closest(".person-card") && !e.target.closest(".text-box") && !e.target.closest(".field-box"),
  onDragStart: (e) => {
    // 필드 그리기 모드가 켜져 있으면(방금 "+필드"를 눌렀음) shift 여부와 무관하게 그 사각형
    // 그리기가 최우선이다 — 마키 선택과 같은 박스(marqueeState/marqueeBoxEl)를 그대로 재사용한다.
    // 시작점은 e.clientX/Y가 아니라 backgroundDrag.startX/Y(실제 pointerdown 지점)를 써야 한다
    // — onDragStart(e)의 e는 "5px 임계값을 막 넘긴 그 순간"의 pointermove라 실제 누른 지점과
    // 몇 px 어긋나는데, 마키 선택 때는 무해했지만(대충 걸리기만 하면 됨) 필드는 그 사각형
    // 크기·위치가 그대로 결과물이 되므로 오차가 그대로 드러난다(실제로 겪음).
    if (fieldDrawMode || e.shiftKey) {
      marqueeState = { startX: backgroundDrag.startX, startY: backgroundDrag.startY };
      marqueeBoxEl.classList.add("visible");
      updateMarqueeBox(e.clientX, e.clientY);
    } else {
      camera.setTransforming(true);
    }
  },
  onDragMove: (dx, dy, e) => {
    if (marqueeState) {
      updateMarqueeBox(e.clientX, e.clientY);
      // 필드를 그리는 중엔 카드/텍스트박스 마키 미리보기(선택 강조)를 보여줄 이유가 없다.
      if (!fieldDrawMode) updateMarqueeHoverPreview();
    } else {
      camera.pan(dx, dy);
    }
  },
  onDragEnd: () => {
    if (marqueeState) {
      if (fieldDrawMode) finalizeFieldDraw();
      else finalizeMarquee();
    } else {
      camera.setTransforming(false);
    }
  },
  onClick: (e) => {
    if (fieldDrawMode) {
      // 드래그 없이 그냥 클릭만 했으면 기본 크기(260×180)로, 클릭한 지점을 왼쪽 위 모서리
      // 삼아 만든다("왼쪽 위부터 시작").
      const { x, y } = camera.screenToWorld(e.clientX, e.clientY);
      const field = tree.addField({ x, y });
      exitFieldDrawMode();
      handleFieldClick(field.id);
      return;
    }
    if (connectMode) return;
    renderer.setSelected(null);
    renderer.setSelectedTextBox(null);
    renderer.setSelectedLine(null);
    renderer.setSelectedField(null);
    renderer.clearMultiSelection();
    hideBulkToolbar();
    inspector.close();
  },
});
camera.onPinchStart = () => backgroundDrag.cancelDrag();

function handleCardClick(id) {
  if (connectMode) {
    // 이번 연결 시퀀스가 이미 "템플릿 슬롯끼리 잇기"로 시작됐으면(첫 클릭이 슬롯), 사람과
    // 슬롯을 섞어 고르는 걸 지원하지 않으므로 사람 클릭은 무시한다.
    if (connectTemplateFieldId) return;
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
      // 관계 하나를 만들고 나면 계속 연결 모드에 머무르지 않고 자동으로 빠져나간다(예전엔 같은
      // 유형으로 계속 이어붙일 수 있게 켜진 채로 뒀는데, 매번 다시 "&관계"를 눌러야 하는 편이
      // "체크가 안 풀린다"는 혼란이 없다).
      exitConnectMode();
      return;
    }
    toolbar.setConnectMode(true, connectStatusText());
    return;
  }
  renderer.setSelected(id);
  renderer.setSelectedTextBox(null);
  renderer.setSelectedLine(null);
  renderer.setSelectedField(null);
  renderer.clearMultiSelection();
  hideBulkToolbar();
  const person = tree.people.get(id);
  if (person) inspector.open(person);
}

/** 인물 카드와 똑같이, 텍스트 박스를 클릭하면 오른쪽 사이드바를 띄워 내용/글자 크기를 고치게 한다. */
function handleTextBoxClick(id) {
  if (connectMode) return; // 텍스트 박스는 관계 연결 대상이 아니다.
  const box = tree.textBoxes.get(id);
  if (!box) return;
  renderer.setSelected(null);
  renderer.setSelectedTextBox(id);
  renderer.setSelectedLine(null);
  renderer.setSelectedField(null);
  renderer.clearMultiSelection();
  hideBulkToolbar();
  inspector.openTextBox(box);
}

/** 인물/텍스트 박스와 똑같이, 필드를 클릭하면 오른쪽 사이드바를 띄워 템플릿/잠금을 고치게 한다. */
function handleFieldClick(id) {
  if (connectMode) return; // 필드는 관계 연결 대상이 아니다.
  const field = tree.fields.get(id);
  if (!field) return;
  renderer.setSelected(null);
  renderer.setSelectedTextBox(null);
  renderer.setSelectedLine(null);
  renderer.setSelectedField(id);
  renderer.clearMultiSelection();
  hideBulkToolbar();
  inspector.openField(field);
}

/** 템플릿 슬롯을 클릭하면(연결 모드 중이 아닐 때) 그 슬롯 전용 사이드바를 연다 — 예전엔 클릭하면
 * 곧바로 삭제 확인창이 떴는데, 다른 오브젝트처럼 사이드바를 통해서만(그 안의 삭제 버튼으로)
 * 지우게 한다. */
function handleTemplateSlotClick(fieldId, slot) {
  renderer.setSelected(null);
  renderer.setSelectedTextBox(null);
  renderer.setSelectedLine(null);
  renderer.setSelectedField(null);
  renderer.clearMultiSelection();
  hideBulkToolbar();
  inspector.openTemplateSlot(fieldId, slot);
}

/** 템플릿 관계(슬롯끼리 그은 안내선)를 클릭하면 그 전용 사이드바를 연다 — 라벨/색/선 종류/방향을
 * 고칠 수 있고, 삭제도 그 사이드바의 버튼으로 한다(클릭 즉시 삭제 확인이 뜨던 예전 동작 대신). */
function handleTemplateRelationshipClick(fieldId, tr) {
  if (connectMode) return; // 연결 모드 중엔(고르는 대상과 안 헷갈리게) 무시한다.
  renderer.setSelected(null);
  renderer.setSelectedTextBox(null);
  renderer.setSelectedLine(null);
  renderer.setSelectedField(null);
  renderer.clearMultiSelection();
  hideBulkToolbar();
  inspector.openTemplateRelationship(fieldId, tr);
}

// ---------- Ctrl+C/Ctrl+V 복사·붙여넣기(인물/텍스트박스/필드) ----------
// clipboard: 마지막으로 복사한 내용의 스냅샷(id는 안 담음, 붙여넣을 때마다 새 id로 다시 만든다).
// pasteCount: 같은 복사 내용을 여러 번 붙여넣을 때마다 조금씩 더 벌어지게(겹쳐 보이지 않게) 세는 값 —
// 새로 복사할 때마다 0으로 되돌린다.
let clipboard = null;
let pasteCount = 0;
const PASTE_OFFSET = 40; // 붙여넣을 때마다 원본에서 이만큼(월드 좌표) 대각선으로 띄운다.

/** 지금 선택된 것(마키 다중선택 2개 이상, 또는 사이드바에 열려 있는 인물/텍스트박스/필드 하나)을
 * 복사한다. 다중선택이면 그 안에서 서로 이어진 관계선(양쪽 다 선택 범위 안에 있는 것)도 같이
 * 담아서, 붙여넣을 때 내부 연결까지 그대로 살아있게 한다. 필드가 포함되면 그 순간 필드 위에
 * "올라가 있는" 인물/텍스트박스도 (아직 안 골라져 있었다면) 함께 담는다 — "필드 복사 시 템플릿
 * 및 포함된 인물들까지 전부 복사됨". */
function copySelectionToClipboard() {
  if (connectMode) return; // 연결 모드 중엔(고르는 중인 대상과 헷갈리지 않게) 복사하지 않는다.
  let peopleIds = [];
  let textBoxIds = [];
  let fieldIds = [];
  if (renderer.getMultiSelectionCount() >= 2) {
    peopleIds = [...renderer.multiSelected.people];
    textBoxIds = [...renderer.multiSelected.textBoxes];
    fieldIds = [...renderer.multiSelected.fields];
  } else if (inspector.mode === "person" && inspector.person) {
    peopleIds = [inspector.person.id];
  } else if (inspector.mode === "textbox" && inspector.textBox) {
    textBoxIds = [inspector.textBox.id];
  } else if (inspector.mode === "field" && inspector.field) {
    fieldIds = [inspector.field.id];
  } else {
    return; // 관계선 사이드바가 열려 있거나 아무것도 선택 안 된 상태 — 복사할 대상이 없다.
  }

  const peopleIdSet = new Set(peopleIds);
  const textBoxIdSet = new Set(textBoxIds);
  for (const fieldId of fieldIds) {
    const field = tree.fields.get(fieldId);
    if (!field) continue;
    const contained = renderer._objectsWithinField(field);
    for (const id of contained.people) {
      if (peopleIdSet.has(id)) continue; // 마키로 이미 따로 골라져 있었으면 중복으로 안 담는다.
      peopleIdSet.add(id);
      peopleIds.push(id);
    }
    for (const id of contained.textBoxes) {
      if (textBoxIdSet.has(id)) continue;
      textBoxIdSet.add(id);
      textBoxIds.push(id);
    }
  }

  const relationships = [];
  for (const rel of tree.relationships.values()) {
    if (
      peopleIdSet.has(rel.fromId) &&
      peopleIdSet.has(rel.toId) &&
      (!rel.viaSpouseId || peopleIdSet.has(rel.viaSpouseId))
    ) {
      relationships.push({ ...rel });
    }
  }

  clipboard = {
    people: peopleIds.map((id) => ({ ...tree.people.get(id) })),
    textBoxes: textBoxIds.map((id) => ({ ...tree.textBoxes.get(id) })),
    fields: fieldIds.map((id) => {
      const f = tree.fields.get(id);
      return {
        ...f,
        templateSlots: f.templateSlots.map((s) => ({ ...s })),
        templateRelationships: (f.templateRelationships || []).map((tr) => ({
          ...tr, slotIds: [...tr.slotIds], materializedRelIds: [...(tr.materializedRelIds || [])],
        })),
      };
    }),
    relationships,
  };
  pasteCount = 0;
}

/** clipboard에 담긴 내용을 전부 새 id로 다시 만들어 붙여넣고, 방금 만든 것들을 곧바로
 * 선택 상태로 만든다(붙이자마자 바로 옮길 수 있게). */
function pasteClipboard() {
  if (!clipboard || (!clipboard.people.length && !clipboard.textBoxes.length && !clipboard.fields.length)) return;
  pasteCount += 1;
  const dx = PASTE_OFFSET * pasteCount;
  const dy = PASTE_OFFSET * pasteCount;

  const idMap = new Map(); // 원본 인물 id -> 새로 만든 인물 id (관계/슬롯 복원에 필요)
  const newPeopleIds = [];
  for (const p of clipboard.people) {
    const created = tree.addPerson({
      x: p.x + dx,
      y: p.y + dy,
      name: p.name,
      photoId: p.photoId,
      photoUrl: p.photoUrl,
      tags: p.tags,
      notes: p.notes,
      borderColor: p.borderColor,
      borderWidth: p.borderWidth,
      photoShape: p.photoShape,
      locked: false, // 복사본은 항상 잠금 풀린 상태로 시작 — 붙이자마자 바로 옮길 수 있게.
      // slotOf는 아직 원본 필드/슬롯 id를 가리키고 있어 지금은 못 채운다 — 필드까지 다 만든
      // 뒤(아래 fieldIdMap/slotIdMap이 갖춰진 다음) 한 번 더 돌며 새 id로 다시 연결한다.
    });
    idMap.set(p.id, created.id);
    newPeopleIds.push(created.id);
  }

  const textBoxIdMap = new Map(); // 원본 텍스트박스 id -> 새 텍스트박스 id (필드 lockedMemberIds 복원에 필요)
  const newTextBoxIds = [];
  for (const b of clipboard.textBoxes) {
    const created = tree.addTextBox({
      x: b.x + dx, y: b.y + dy, text: b.text, fontSize: b.fontSize, width: b.width, height: b.height,
      background: b.background,
    });
    textBoxIdMap.set(b.id, created.id);
    newTextBoxIds.push(created.id);
  }

  const fieldIdMap = new Map(); // 원본 필드 id -> 새 필드 id
  const slotIdMap = new Map(); // 원본 슬롯 id -> 새 슬롯 id
  const newFieldIds = [];
  for (const f of clipboard.fields) {
    const newSlots = f.templateSlots.map((s) => {
      const newSlot = { id: uuid(), relX: s.relX, relY: s.relY };
      slotIdMap.set(s.id, newSlot.id);
      return newSlot;
    });
    // 템플릿 관계(슬롯끼리 그은 안내선)도 슬롯 id를 새 것으로 다시 연결해 그대로 복제한다 —
    // materializedRelIds는 비워서 새로 붙여넣는다(아래에서 인물 slotOf를 다시 연결하면 tree가
    // 알아서 다시 진짜 관계선으로 성사시켜준다).
    const newTemplateRelationships = (f.templateRelationships || []).map((tr) => ({
      id: uuid(), type: tr.type, slotIds: tr.slotIds.map((sid) => slotIdMap.get(sid)),
      label: tr.label, color: tr.color, lineStyle: tr.lineStyle, bidirectional: tr.bidirectional,
      materializedRelIds: [],
    }));
    // "새 요소 추가 잠금"이 켜져 있었으면 그 스냅샷(lockedMemberIds)도 인물/텍스트박스 각각의
    // 새 id로 다시 연결한다 — 원본 id로 남겨두면(대응하는 새 오브젝트가 없어) 잠금이 사실상
    // 아무것도 안 걸린 것과 같아져 버린다. 이번에 함께 복사되지 않은 원본 멤버는 그냥 빠진다.
    const newLockedMemberIds = (f.lockedMemberIds || [])
      .map((id) => idMap.get(id) || textBoxIdMap.get(id))
      .filter(Boolean);
    const created = tree.addField({
      x: f.x + dx, y: f.y + dy, width: f.width, height: f.height,
      locked: f.locked, selfLocked: f.selfLocked, addLocked: f.addLocked, lockedMemberIds: newLockedMemberIds,
      templateMode: f.templateMode, templateSlots: newSlots, templateRelationships: newTemplateRelationships,
    });
    fieldIdMap.set(f.id, created.id);
    newFieldIds.push(created.id);
  }

  // 인물이 템플릿 슬롯에 꽂혀 있었으면(slotOf), 그 필드도 이번에 함께 복사됐을 때만 새 필드/슬롯
  // id로 다시 연결한다 — 필드 없이 인물만 복사된 경우엔 그냥 자유로운 인물로 붙여넣는다.
  for (const p of clipboard.people) {
    if (!p.slotOf) continue;
    const newFieldId = fieldIdMap.get(p.slotOf.fieldId);
    const newSlotId = slotIdMap.get(p.slotOf.slotId);
    if (newFieldId && newSlotId) {
      tree.updatePerson(idMap.get(p.id), { slotOf: { fieldId: newFieldId, slotId: newSlotId } });
    }
  }

  for (const rel of clipboard.relationships) {
    const created = tree.addRelationship({
      fromId: idMap.get(rel.fromId),
      toId: idMap.get(rel.toId),
      type: rel.type,
      label: rel.label,
      viaSpouseId: rel.viaSpouseId ? idMap.get(rel.viaSpouseId) : null,
    });
    // addRelationship은 color/lineStyle을 받지 않으므로(기본 생성 후 따로 채워야 하는 필드),
    // 원본에 커스텀 값이 있었으면 여기서 마저 옮겨준다.
    if (created && (rel.color || rel.lineStyle)) {
      tree.updateRelationship(created.id, { color: rel.color, lineStyle: rel.lineStyle });
    }
  }

  // 방금 붙여넣은 것들을 곧바로 선택 상태로 — 여러 개면 다중선택(벌크 툴바), 하나면 그 사이드바를 연다.
  renderer.setSelected(null);
  renderer.setSelectedTextBox(null);
  renderer.setSelectedLine(null);
  renderer.setSelectedField(null);
  const total = newPeopleIds.length + newTextBoxIds.length + newFieldIds.length;
  if (total >= 2) {
    renderer.clearMultiSelection();
    inspector.close();
    renderer.setMultiSelection({ people: newPeopleIds, textBoxes: newTextBoxIds, fields: newFieldIds });
    updateBulkToolbar();
  } else if (newPeopleIds.length === 1) {
    renderer.clearMultiSelection();
    hideBulkToolbar();
    handleCardClick(newPeopleIds[0]);
  } else if (newTextBoxIds.length === 1) {
    renderer.clearMultiSelection();
    hideBulkToolbar();
    handleTextBoxClick(newTextBoxIds[0]);
  } else if (newFieldIds.length === 1) {
    renderer.clearMultiSelection();
    hideBulkToolbar();
    handleFieldClick(newFieldIds[0]);
  }
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

/**
 * "&관계" 연결 모드 중 템플릿 슬롯을 클릭했을 때(TreeRenderer가 onSlotClick으로 물어봄) —
 * connectMode가 꺼져 있으면 false를 돌려줘 평소 동작(삭제/사이드바 열기)을 그대로 쓰게 한다.
 * true를 돌려주면 이번 클릭은 "슬롯 고르기"로 소비된 것이니 TreeRenderer가 더 이상 아무것도
 * 안 한다.
 */
function handleSlotClickForConnect(fieldId, slotId) {
  if (!connectMode) return false;
  if (connectTemplateFieldId && connectTemplateFieldId !== fieldId) return true; // 다른 필드 슬롯은 무시(소비만 함)
  if (!connectTemplateFieldId) connectTemplateFieldId = fieldId; // 이번 시퀀스는 슬롯끼리 잇기로 확정
  const idx = connectPicks.indexOf(slotId);
  if (idx !== -1) connectPicks.splice(idx, 1);
  else connectPicks.push(slotId);
  renderer.setSelectedSlots(fieldId, connectPicks);

  const required = (CONNECT_STEP_HINTS[connectType] || []).length || 2;
  if (connectPicks.length >= required) {
    finalizeTemplateConnection(connectType, fieldId, connectPicks);
    exitConnectMode();
    return true;
  }
  toolbar.setConnectMode(true, connectStatusText());
  return true;
}

/** 유형별로 고른 슬롯 순서를 그 필드의 "템플릿 관계"(안내선)로 저장한다 — 양쪽(또는 세) 슬롯이
 * 이미 실제 인물로 채워져 있으면 tree.addField 내부(Tree._resyncFieldTemplateRelationships)가
 * 곧바로 진짜 관계선까지 만들어준다. */
function finalizeTemplateConnection(type, fieldId, slotIds) {
  const field = tree.fields.get(fieldId);
  if (!field) return;
  const newTr = {
    id: uuid(), type, slotIds: [...slotIds], label: "", color: null, lineStyle: null,
    bidirectional: false, materializedRelIds: [],
  };
  tree.updateField(fieldId, { templateRelationships: [...(field.templateRelationships || []), newTr] });
}

/** 인물 카드/텍스트 박스와 똑같이, 관계선을 클릭하면 오른쪽 사이드바를 띄워 라벨/색/선 종류를 고치게 한다. */
function handleLineClick(relId) {
  const rel = tree.relationships.get(relId);
  if (!rel) return;
  renderer.setSelected(null);
  renderer.setSelectedTextBox(null);
  renderer.setSelectedLine(relId);
  renderer.setSelectedField(null);
  renderer.clearMultiSelection();
  hideBulkToolbar();
  inspector.openRelationship(rel);
}

function exitConnectMode() {
  connectMode = false;
  connectType = null;
  connectPicks = [];
  toolbar.setConnectMode(false);
  viewportEl.classList.remove("connect-mode");
  renderer.setSelectedMany([]);
  if (connectTemplateFieldId) renderer.setSelectedSlots(connectTemplateFieldId, []);
  connectTemplateFieldId = null;
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

/** SVG(벡터)로 내보낸다 — 아무리 확대해도 선/글자가 안 깨진다(사진만 원본 해상도 그대로인 래스터). */
async function doExportSvgImage() {
  const ok = await downloadTreeSVG({ tree, renderer, store }, `family-tree-${new Date().toISOString().slice(0, 10)}.svg`);
  if (!ok) alert("내보낼 내용이 없습니다. 인물을 먼저 추가해주세요.");
}

/** PNG(래스터)로 내보낸다 — SVG를 못 받는 곳(일부 메신저 미리보기 등)에 공유하기 좋게. */
async function doExportPngImage() {
  const ok = await downloadTreePNG({ tree, renderer, store }, `family-tree-${new Date().toISOString().slice(0, 10)}.png`);
  if (!ok) alert("내보낼 내용이 없습니다. 인물을 먼저 추가해주세요.");
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
    hideBulkToolbar(); // 옛 트리에서 마키로 골라뒀던 대상은 이제 없으니 벌크 툴바도 같이 접는다
    inspector.close();
  } catch (err) {
    console.error(err);
    alert("파일을 읽는 중 문제가 발생했습니다. 올바른 가계도 JSON 파일인지 확인해주세요.");
  }
}

function updateEmptyHint() {
  emptyHintEl.style.display = tree.people.size ? "none" : "flex";
}
tree.onChange(updateEmptyHint);

// 어떤 경로로든(휴지통 드래그 등) 인물/텍스트 박스가 삭제되면, 그게 지금 인스펙터에 열려 있던
// 경우 닫는다.
tree.onChange((type, payload) => {
  if (type === "person:remove" && inspector.person?.id === payload) inspector.close();
  if (type === "textbox:remove" && inspector.textBox?.id === payload) inspector.close();
  if (type === "relationship:remove" && inspector.relationship?.id === payload) inspector.close();
  if (type === "field:remove") {
    if (inspector.field?.id === payload) inspector.close();
    if (inspector.templateSlotFieldId === payload) inspector.close();
    if (inspector.templateRelFieldId === payload) inspector.close();
  }
  // 템플릿 슬롯/템플릿 관계는 별도 삭제 이벤트가 없다(field:update로 배열만 바뀜) — 지금 사이드바에
  // 열려 있는 대상이 그 배열에서 없어졌으면(다른 경로로 삭제됨) 닫는다.
  if (type === "field:update") {
    if (inspector.mode === "template-slot" && inspector.templateSlotFieldId === payload.id) {
      if (!payload.templateSlots.some((s) => s.id === inspector.templateSlot?.id)) inspector.close();
    }
    if (inspector.mode === "template-rel" && inspector.templateRelFieldId === payload.id) {
      if (!(payload.templateRelationships || []).some((t) => t.id === inspector.templateRel?.id)) inspector.close();
    }
  }
});

// 모바일 하단 시트: 헤더(제목+× 있는 맨 위 줄)를 손가락으로 아래로 당기면 시트 전체가 그대로
// 따라 내려가다가(당겨서 닫기), 일정 거리 이상 당겨지면 닫히고 아니면 원래 자리로 스냅백된다.
// 처음엔 "스크롤이 맨 위(scrollTop 0)면 계속 당길 때 전환" 방식으로 만들었는데, 실제 터치에서
// 브라우저가 첫 이동만으로 이미 "이건 스크롤이다"라고 판단해버려 그 뒤에 부르는 preventDefault가
// 안 먹혀 들쭉날쭉했다(당겨도 안 닫히는 경우가 잦음) — 그래서 헤더 영역만 CSS로 아예 네이티브
// 팬(스크롤)을 원천 차단(touch-action:none)해두고, 그 헤더를 잡았을 때만 이 제스처가 시작되게
// 바꿨다. 헤더 자체가 스크롤 안 되는 요소라 처음부터 경합이 없다(콘텐츠 스크롤 영역은 그대로
// 평범하게 스크롤됨). 헤더는 스크롤 맨 위일 때만 화면에 보이므로("스크롤 내려가면 시트 닫기"의
// 원래 취지) 별도로 scrollTop을 확인할 필요도 없다.
let sheetDrag = null; // { pointerId, startY, dy }
const SHEET_DISMISS_THRESHOLD = 90;

inspectorEl.addEventListener("pointerdown", (e) => {
  if (!isMobileLayout() || !inspectorEl.classList.contains("open")) return;
  if (!e.target.closest(".inspector-header")) return; // 헤더를 잡았을 때만 시작
  if (e.target.closest(".inspector-close")) return; // × 버튼 자체는 평범하게 클릭되게 둔다
  sheetDrag = { pointerId: e.pointerId, startY: e.clientY, dy: 0 };
  inspectorEl.style.transition = "none"; // 드래그 중엔 트랜지션을 꺼서 손가락을 그대로 따라가게
  try { inspectorEl.setPointerCapture(e.pointerId); } catch { /* ignore */ }
});

inspectorEl.addEventListener("pointermove", (e) => {
  if (!sheetDrag || e.pointerId !== sheetDrag.pointerId) return;
  e.preventDefault();
  sheetDrag.dy = Math.max(0, e.clientY - sheetDrag.startY);
  inspectorEl.style.transform = `translateY(${sheetDrag.dy}px)`;
}, { passive: false });

function endSheetDrag(e) {
  if (!sheetDrag || (e && e.pointerId !== sheetDrag.pointerId)) return;
  const { dy } = sheetDrag;
  sheetDrag = null;
  inspectorEl.style.transition = "";
  inspectorEl.style.transform = ""; // 인라인을 지워 .open의 translateY(0)(또는 닫히면 100%)로 되돌아가게
  if (dy > SHEET_DISMISS_THRESHOLD) inspector.close();
}
inspectorEl.addEventListener("pointerup", endSheetDrag);
inspectorEl.addEventListener("pointercancel", endSheetDrag);

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
  if (e.key === "Escape") {
    toolbar.closeTypeMenu();
    if (connectMode) exitConnectMode();
    if (fieldDrawMode) exitFieldDrawMode();
    inspector.close();
    renderer.setSelected(null);
    renderer.setSelectedTextBox(null);
    renderer.setSelectedLine(null);
    renderer.setSelectedField(null);
    renderer.clearMultiSelection();
    hideBulkToolbar();
    return;
  }

  // Ctrl+Z(실행취소) / Ctrl+Y·Ctrl+Shift+Z(다시실행) — 이름/메모/태그 같은 입력창에 포커스가
  // 있을 땐 가로채지 않는다(브라우저 자체의 "글자 입력 되돌리기"가 그대로 동작해야 하므로).
  const isTyping = e.target.matches?.("input, textarea, [contenteditable='true']");
  if (isTyping) return;
  const key = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && key === "z" && !e.shiftKey) {
    e.preventDefault();
    undoMgr.performUndo();
  } else if ((e.ctrlKey || e.metaKey) && (key === "y" || (key === "z" && e.shiftKey))) {
    e.preventDefault();
    undoMgr.performRedo();
  } else if ((e.ctrlKey || e.metaKey) && key === "c") {
    // 텍스트를 따로 드래그해 선택해둔 게 아니라면(브라우저 기본 텍스트 복사와 안 겹치게) 인물/
    // 텍스트박스 복사로 취급한다.
    if (window.getSelection()?.toString()) return;
    copySelectionToClipboard();
  }
  // 붙여넣기(Ctrl+V)는 여기서 안 가로챈다 — 아래 네이티브 "paste" 이벤트 리스너를 쓴다
  // (InspectorPanel의 "클립보드 이미지를 사진으로 붙여넣기" 기능과 같은 이벤트를 보고 서로
  // 안 겹치게 양보하기 위해. 자세한 이유는 그 리스너의 주석 참고).
});

// 인물/텍스트 박스 붙여넣기(Ctrl+V)는 keydown이 아니라 네이티브 "paste" 이벤트로 처리한다 — 그래야
// e.clipboardData로 "지금 진짜 시스템 클립보드에 뭐가 들어있는지"를 직접 볼 수 있어서, 인물 사진으로
// 이미지를 붙여넣으려는 것(InspectorPanel._onPaste, 이미지가 있을 때만 가로챔)과 마주쳐도 서로
// 헷갈리지 않는다 — keydown 시점엔 clipboardData에 접근할 수 없어 "이번 Ctrl+V가 이미지 붙여넣기
// 인지 아닌지"를 미리 알 도리가 없었다(먼저 가로채 버리면 이미지 붙여넣기 자체가 막혀버림).
document.addEventListener("paste", (e) => {
  const isTyping = document.activeElement?.matches?.("input, textarea, [contenteditable='true']");
  if (isTyping) return; // 이름/메모/태그 등 텍스트 입력 중엔 브라우저 기본 붙여넣기 그대로.
  const items = [...(e.clipboardData?.items || [])];
  if (items.some((it) => it.kind === "file" && it.type.startsWith("image/"))) return; // 사진 붙여넣기에 양보.
  pasteClipboard();
});

async function init() {
  const data = await store.loadAll();
  tree.loadJSON(data); // "reset" 이벤트를 통해 renderer.renderAll()이 이미 트리거된다
  camera.fitToContent(tree.getBounds(), { animate: false }); // 첫 로드는 애니메이션 없이 바로 맞춘다
  updateEmptyHint();
  toolbar.setSaveState("저장됨");
}

init();
