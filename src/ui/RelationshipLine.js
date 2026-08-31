const SVG_NS = "http://www.w3.org/2000/svg";

export const TYPE_LABEL = {
  // 부모-자식/배우자는 선 자체(모양·색)로 이미 구분되니 기본 텍스트를 안 보여준다.
  // 사용자가 라벨을 직접 입력해 넣으면(rel.label) 그건 그대로 표시된다.
  "parent-child-solo": "",
  "parent-child": "",
  spouse: "",
  custom: "",
  arrow: "",
};

// 유형별 기본 색(rel.color가 없을 때만 씀). 선 종류(dash)는 더 이상 유형별 기본값이 없다 —
// rel.lineStyle이 없으면 항상 "실선"이 기본이다(LINE_STYLE_PRESETS의 solid).
// 예전엔 유형마다 기본색이 달라서(기타=회색, 화살표=파랑 등) 색을 따로 안 고르면 관계선끼리
// 괜히 안 어울려 보였다 — 유형 구분은 이미 선 모양/화살촉/라벨로 되니, 기본색은 전부 하나로
// 통일한다(사용자가 사이드바에서 직접 고르면 그 색이 그대로 우선한다).
const DEFAULT_STROKE = "#5b6b8c";
const TYPE_STYLE = {
  "parent-child-solo": { stroke: DEFAULT_STROKE },
  "parent-child": { stroke: DEFAULT_STROKE },
  spouse: { stroke: DEFAULT_STROKE },
  custom: { stroke: DEFAULT_STROKE },
  arrow: { stroke: DEFAULT_STROKE },
};

/** 사이드바에 보여줄 유형 이름(읽기 전용 표시용 — 유형 자체는 바꿀 수 없다). */
export const TYPE_DISPLAY_NAME = {
  "parent-child-solo": "부모-자식(부모1)",
  "parent-child": "부모-자식(부모2)",
  spouse: "배우자",
  custom: "기타",
  arrow: "화살표",
};

/** 선 종류 프리셋 — rel.lineStyle에 이 중 하나의 key를 저장한다(없으면 "solid"가 기본). */
export const LINE_STYLE_PRESETS = {
  solid: { label: "실선", dash: "" },
  dashed: { label: "파선", dash: "9 5" },
  dotted: { label: "점선", dash: "2 4" },
};

/** 사이드바 색상 선택기의 빠른 선택 스와치. rel.color가 없으면(null) 유형 기본색을 그대로 쓴다. */
export const COLOR_PRESETS = ["#5b6b8c", "#d64545", "#e08a3f", "#d6b83f", "#4f9d6d", "#3f6fd6", "#8a5fd6", "#8a8f98"];

/** rel.color가 없을 때 색상 입력창에 보여줄 그 유형의 기본색(네이티브 color input은 빈 값을 못 받아 필요). */
export function defaultColorFor(type) {
  return (TYPE_STYLE[type] || TYPE_STYLE.custom).stroke;
}

const LABEL_HIT_W = 56;
const LABEL_HIT_H = 18;

/** "화살표" 유형 전용 화살촉 — 관계선마다 id를 따로 줘서(rel.id 기반) 여러 화살표가 한 화면에
 * 있어도 marker-end="url(#...)" 참조가 서로 안 겹치게 한다. 색은 이 선 자신의 stroke와 항상
 * 같아야 하므로 applyLineStyle이 매번 이 안의 path fill도 같이 갱신한다. */
function createArrowMarker(relId) {
  const defs = document.createElementNS(SVG_NS, "defs");
  const marker = document.createElementNS(SVG_NS, "marker");
  marker.setAttribute("id", arrowMarkerId(relId));
  marker.setAttribute("viewBox", "0 0 10 10");
  marker.setAttribute("refX", "10");
  marker.setAttribute("refY", "5");
  marker.setAttribute("markerWidth", "6");
  marker.setAttribute("markerHeight", "6");
  // 화살표가 그려지는 방향(선분의 진행 방향)에 맞춰 화살촉이 자동으로 돌아가게 한다.
  marker.setAttribute("orient", "auto-start-reverse");
  const path = document.createElementNS(SVG_NS, "path");
  path.classList.add("rel-arrowhead-path");
  path.setAttribute("d", "M 0 0 L 10 5 L 0 10 Z");
  marker.appendChild(path);
  defs.appendChild(marker);
  return defs;
}

function arrowMarkerId(relId) {
  return `rel-arrowhead-${relId}`;
}

export function createLineElement(rel) {
  const g = document.createElementNS(SVG_NS, "g");
  g.classList.add("rel-line");
  g.dataset.id = rel.id;

  // <line> 대신 <polyline>을 써서, 배우자가 있는 부모-자식 관계일 때 T자(꺾인선) 모양도 그릴 수 있게 한다.
  const hit = document.createElementNS(SVG_NS, "polyline");
  hit.classList.add("rel-line-hit");

  const visible = document.createElementNS(SVG_NS, "polyline");
  visible.classList.add("rel-line-visible");

  if (rel.type === "arrow") g.appendChild(createArrowMarker(rel.id));

  // 기본 라벨 텍스트가 비어 있어도(부모-자식/배우자/형제자매) 그 자리를 클릭해 커스텀 라벨을
  // 넣을 수 있도록, 보이지 않는 고정 크기 클릭 영역을 텍스트와 별도로 둔다.
  const labelHit = document.createElementNS(SVG_NS, "rect");
  labelHit.classList.add("rel-line-label-hit");
  labelHit.setAttribute("width", LABEL_HIT_W);
  labelHit.setAttribute("height", LABEL_HIT_H);

  const label = document.createElementNS(SVG_NS, "text");
  label.classList.add("rel-line-label");

  g.append(hit, visible, labelHit, label);
  applyLineStyle(g, rel);
  return g;
}

export function applyLineStyle(g, rel) {
  const style = TYPE_STYLE[rel.type] || TYPE_STYLE.custom;
  const visible = g.querySelector(".rel-line-visible");
  // rel.color가 있으면(사이드바에서 사용자가 직접 고른 값) 유형 기본색 대신 그걸 쓴다.
  const color = rel.color || style.stroke;
  visible.setAttribute("stroke", color);
  visible.setAttribute("stroke-width", "2.5");
  // 선 종류는 이제 유형별 기본값이 없다 — rel.lineStyle이 없으면 항상 "실선"이 기본이다.
  const dasharray = LINE_STYLE_PRESETS[rel.lineStyle || "solid"].dash;
  if (dasharray) visible.setAttribute("stroke-dasharray", dasharray);
  else visible.removeAttribute("stroke-dasharray");

  if (rel.type === "arrow") {
    visible.setAttribute("marker-end", `url(#${arrowMarkerId(rel.id)})`);
    const arrowPath = g.querySelector(".rel-arrowhead-path");
    if (arrowPath) arrowPath.setAttribute("fill", color); // 화살촉도 선과 항상 같은 색
  } else {
    visible.removeAttribute("marker-end");
  }

  const label = g.querySelector(".rel-line-label");
  label.textContent = rel.label || TYPE_LABEL[rel.type] || "";
}

/**
 * points: [{x,y}, ...]
 *  - 2개: 직선(배우자/형제자매/기타, 배우자 없는 부모-자식)
 *  - 4개: T자 꺾인선(배우자가 있는 부모-자식) — [부부 중점, 트렁크 끝(버스 y), 버스 끝(자식 x, 버스 y), 자식]
 * 라벨은 4점일 땐 "버스 구간"(트렁크 끝~버스 끝)의 중점에 둔다 — 형제자매마다 자식 x가 달라 서로 안
 * 겹치고, 자식 카드/스텁과도 충분히 떨어져 있다. 2점일 땐 그 유일한 구간의 중점에 둔다.
 * 구간이 가로면 위로, 세로면 옆으로 살짝 띄워서 선 자체와 겹치지 않게 한다.
 */
export function updateLinePosition(g, points) {
  const pointStr = points.map((p) => `${p.x},${p.y}`).join(" ");
  for (const el of g.querySelectorAll("polyline")) el.setAttribute("points", pointStr);

  const [a, b] = points.length === 4 ? [points[1], points[2]] : [points[0], points[points.length - 1]];
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  const horizontal = Math.abs(b.x - a.x) >= Math.abs(b.y - a.y);

  const label = g.querySelector(".rel-line-label");
  const labelHit = g.querySelector(".rel-line-label-hit");
  let lx, ly;
  if (horizontal) {
    lx = mx;
    ly = my - 8;
    label.setAttribute("x", lx);
    label.setAttribute("y", ly);
    label.style.textAnchor = "middle";
    label.style.dominantBaseline = "auto";
    labelHit.setAttribute("x", lx - LABEL_HIT_W / 2);
    labelHit.setAttribute("y", ly - LABEL_HIT_H + 4);
  } else {
    lx = mx + 10;
    ly = my;
    label.setAttribute("x", lx);
    label.setAttribute("y", ly);
    label.style.textAnchor = "start";
    label.style.dominantBaseline = "middle";
    labelHit.setAttribute("x", lx - 4);
    labelHit.setAttribute("y", ly - LABEL_HIT_H / 2);
  }
}
