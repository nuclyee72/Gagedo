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

// PNG는 래스터라 무한히 확대해도 안 깨지진 않지만(SVG와 달리), 카카오톡 등 일부 메신저·뷰어가
// SVG 미리보기를 잘 못 띄우는 경우를 위한 대안이다 — 그래서 화면 그대로의 해상도가 아니라
// PNG_SCALE배로 키워서 그려, 일반적인 보기/확대 정도에선 흐릿해 보이지 않게 한다.
const PNG_SCALE = 2;
const PNG_MAX_DIMENSION = 8000; // 캔버스 크기 한도(브라우저별 최대 캔버스 크기를 넘지 않도록)

/** buildTreeSVG로 만든 벡터 SVG를 캔버스에 그려 PNG Blob으로 래스터화한다. */
export async function buildTreePNGBlob({ tree, renderer, store }) {
  const svg = await buildTreeSVG({ tree, renderer, store });
  if (!svg) return null;

  const width = parseFloat(svg.getAttribute("width"));
  const height = parseFloat(svg.getAttribute("height"));
  let scale = PNG_SCALE;
  if (width * scale > PNG_MAX_DIMENSION || height * scale > PNG_MAX_DIMENSION) {
    scale = Math.min(PNG_MAX_DIMENSION / width, PNG_MAX_DIMENSION / height);
  }

  const xml = new XMLSerializer().serializeToString(svg);
  // blob: URL로 <img>에 물리면, foreignObject(카드/텍스트박스에 실제 HTML을 담는 부분)가 있는
  // SVG는 캔버스가 "오염(tainted)"돼서 toBlob/toDataURL이 SecurityError로 막힌다(실제로 겪음,
  // 크로스 오리진 리소스가 하나도 없는 순수 로컬 SVG여도 마찬가지 — 브라우저가 foreignObject
  // 자체를 보수적으로 취급하는 것). base64 data: URI로 주면 캔버스가 오염되지 않는다 — 같은
  // 문서 안에서 만든 데이터라는 게 명확해서인 듯하다.
  const dataUrl = `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(xml)))}`;
  const img = await new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("SVG를 이미지로 불러오지 못했습니다."));
    image.src = dataUrl;
  });
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return await new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("PNG 변환에 실패했습니다."))), "image/png");
  });
}

/** buildTreePNGBlob의 결과를 실제로 다운로드한다. */
export async function downloadTreePNG({ tree, renderer, store }, filename) {
  const blob = await buildTreePNGBlob({ tree, renderer, store });
  if (!blob) return false;
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
  return true;
}
