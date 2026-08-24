/**
 * 업로드한 이미지 파일을 지정한 최대 크기로 리사이즈해 Blob으로 반환한다.
 * 서버 업로드 없이 브라우저 안에서만 처리되며, 결과 Blob은 IndexedDB에 저장된다.
 */
export async function fileToResizedBlob(file, maxSize = 512, quality = 0.85) {
  const bitmap = await loadBitmap(file);
  const scale = Math.min(1, maxSize / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0, w, h);

  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("이미지 변환에 실패했습니다."))),
      "image/webp",
      quality
    );
  });
}

/**
 * 이미지 URL을 원본 그대로 내려받는다(리사이즈/크롭 없이) — 크롭 편집기에 넘기기 위한 용도.
 * 대상 서버가 CORS를 허용하지 않으면 fetch 자체가 실패할 수 있다 — 그 경우 호출한 쪽에서
 * catch해 원본 URL을 그대로 photoUrl로 쓰는 폴백을 처리한다(다운로드/저장은 못 하지만 화면 표시는 된다).
 */
export async function fetchRawImageBlob(url) {
  const res = await fetch(url, { mode: "cors" });
  if (!res.ok) throw new Error(`이미지를 가져오지 못했습니다 (HTTP ${res.status})`);
  const blob = await res.blob();
  if (!blob.type.startsWith("image/")) throw new Error("이미지 파일이 아닙니다.");
  return blob;
}

/** 이미지 URL을 내려받아 리사이즈된 Blob으로 변환한다(크롭 편집기를 거치지 않는 경로에서 사용). */
export async function urlToResizedBlob(url, maxSize = 512, quality = 0.85) {
  const blob = await fetchRawImageBlob(url);
  return fileToResizedBlob(blob, maxSize, quality);
}

export async function loadBitmap(file) {
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(file);
    } catch {
      // 일부 브라우저/포맷에서 실패하면 <img> 경유 방식으로 폴백
    }
  }
  const url = URL.createObjectURL(file);
  try {
    return await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}
