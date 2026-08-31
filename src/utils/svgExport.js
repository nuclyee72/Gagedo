import { createCardElement, applyCardData } from "../ui/PersonCard.js";
import { createTextBoxElement } from "../ui/TextBox.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const XHTML_NS = "http://www.w3.org/1999/xhtml";
const PADDING = 80;

// 내보낸 SVG 파일이 style.css 없이도(다른 곳에서 열어도) 똑같이 보이도록 값을 그대로 박아 넣을
// CSS 커스텀 프로퍼티 목록.
const THEME_VARS = [
  "--bg", "--panel-bg", "--surface", "--border", "--text", "--muted", "--accent",
  "--accent-soft", "--accent-hover", "--accent-glow", "--danger", "--viewport-bg",
  "--viewport-dot", "--shadow", "--panel-shadow", "--modal-shadow", "--overlay",
  "--snap-accent-2", "--card-w", "--photo-size",
];

function resolveVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

/** photoId(업로드된 사진)면 Blob을 데이터 URI로, 없으면 photoUrl(외부 링크) 또는 기본 아바타를 쓴다.
 * 내보낸 파일은 독립된 하나의 파일이어야 하므로(다른 곳에서 열어도 깨지지 않게) blob:/상대경로 대신
 * 전부 데이터 URI나 완전한 URL로 바꾼다. */
async function resolvePhotoForExport(person, store, defaultAvatarDataUrl) {
  if (person.photoId) {
    try {
      const blob = await store.getImage(person.photoId);
      if (blob) return await blobToDataURL(blob);
    } catch {
      // 못 읽으면 기본 아바타로 폴백
    }
  }
  if (person.photoUrl) return person.photoUrl;
  return defaultAvatarDataUrl;
}

async function fetchDefaultAvatarDataUrl() {
  try {
    const res = await fetch("assets/default-avatar.svg");
    const text = await res.text();
    return `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(text)))}`;
  } catch {
    return ""; // 못 가져와도 내보내기 자체는 계속 진행 — 사진 없는 사람은 그냥 빈 원으로 보임
  }
}

/** style.css 전체를 그대로 가져와 <style>에 심고, 지금 켜진 테마의 실제 계산값으로 변수를 한 번
 * 더 덮어쓴다 — 파일을 나중에 다른 문서/뷰어에서 열어도(:root 매칭 여부와 무관하게) 내보낸 시점의
 * 배색이 그대로 고정되도록 :root와 svg 선택자 둘 다에 박아 넣는다. */
async function buildEmbeddedCss() {
  let base = "";
  try {
    const res = await fetch("style.css");
    base = await res.text();
  } catch {
    // 못 가져와도(예: file:// 등) 최소한 아래 변수 오버라이드만으로 색은 맞게 나온다
  }
  const overrides = THEME_VARS.map((v) => `${v}: ${resolveVar(v)};`).join(" ");
  return `${base}\n:root, svg { ${overrides} }`;
}

/**
 * 지금 가계도 전체를 하나의 독립 SVG 파일로 만든다(벡터라 아무리 확대해도 선/글자가 안 깨짐 —
 * 사진만 원본 해상도 그대로인 래스터). 관계선은 이미 화면에 정확히 그려진 SVG를 그대로 복제해
 * 재사용하고(좌표 계산을 새로 하지 않음), 인물 카드/텍스트 박스는 <foreignObject>에 실제 카드
 * DOM(PersonCard.js/TextBox.js가 만드는 것과 완전히 같은 마크업)을 그대로 담아 CSS로 그린다.
 * 빈 트리면 null을 반환한다.
 */
export async function buildTreeSVG({ tree, renderer, store }) {
  const bounds = tree.getBounds();
  if (!bounds) return null;

  const minX = bounds.minX - PADDING;
  const minY = bounds.minY - PADDING;
  const width = bounds.maxX - bounds.minX + PADDING * 2;
  const height = bounds.maxY - bounds.minY + PADDING * 2;

  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("xmlns", SVG_NS);
  svg.setAttribute("xmlns:xhtml", XHTML_NS);
  svg.setAttribute("data-theme", document.documentElement.getAttribute("data-theme") || "light");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("width", String(Math.round(width)));
  svg.setAttribute("height", String(Math.round(height)));

  const style = document.createElementNS(SVG_NS, "style");
  style.textContent = await buildEmbeddedCss();
  svg.appendChild(style);

  const bg = document.createElementNS(SVG_NS, "rect");
  bg.setAttribute("x", "0");
  bg.setAttribute("y", "0");
  bg.setAttribute("width", String(width));
  bg.setAttribute("height", String(height));
  bg.setAttribute("fill", resolveVar("--viewport-bg") || "#ffffff");
  svg.appendChild(bg);

  // 관계선 — 라이브 렌더러가 이미 정확히 그려둔 걸 그대로 복제한다(라벨 즉석편집용 보이지 않는
  // 클릭 영역, 지금 선택된 상태 표시는 정적 이미지에 필요 없으니 제거).
  const linesGroup = document.createElementNS(SVG_NS, "g");
  linesGroup.setAttribute("transform", `translate(${-minX}, ${-minY})`);
  for (const g of renderer.linesEl.querySelectorAll(".rel-line")) {
    const clone = g.cloneNode(true);
    clone.classList.remove("selected");
    for (const hit of clone.querySelectorAll(".rel-line-hit, .rel-line-label-hit")) hit.remove();
    linesGroup.appendChild(clone);
  }
  svg.appendChild(linesGroup);

  // 인물 카드 + 텍스트 박스 — 하나의 foreignObject 안에 실제 DOM을 그대로 담는다.
  const fo = document.createElementNS(SVG_NS, "foreignObject");
  fo.setAttribute("x", "0");
  fo.setAttribute("y", "0");
  fo.setAttribute("width", String(width));
  fo.setAttribute("height", String(height));
  const host = document.createElementNS(XHTML_NS, "div");
  host.setAttribute("style", "position:relative; width:100%; height:100%;");

  const defaultAvatar = await fetchDefaultAvatarDataUrl();
  for (const person of tree.people.values()) {
    const photoUrl = await resolvePhotoForExport(person, store, defaultAvatar);
    const el = createCardElement(person);
    applyCardData(el, person, photoUrl);
    // world 좌표를 그대로 쓰면 이 foreignObject의 원점(0,0)과 안 맞으므로 (minX,minY)만큼 당긴다.
    el.style.left = `${person.x - minX}px`;
    el.style.top = `${person.y - minY}px`;
    host.appendChild(el);
  }
  for (const box of tree.textBoxes.values()) {
    const el = createTextBoxElement(box);
    el.querySelector(".text-box-resize")?.remove(); // 조작용 손잡이는 정적 이미지에 필요 없음
    el.style.left = `${box.x - minX}px`;
    el.style.top = `${box.y - minY}px`;
    host.appendChild(el);
  }
  fo.appendChild(host);
  svg.appendChild(fo);

  return svg;
}

/** buildTreeSVG의 결과를 실제로 다운로드한다. */
export async function downloadTreeSVG({ tree, renderer, store }, filename) {
  const svg = await buildTreeSVG({ tree, renderer, store });
  if (!svg) return false;
  const xml = new XMLSerializer().serializeToString(svg);
  const blob = new Blob([`<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n${xml}`], {
    type: "image/svg+xml;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
  return true;
}
