/**
 * 관계 데이터를 바탕으로 세대(가로열)를 계산해 자동으로 배치 좌표를 계산한다.
 * 규약: parent-child 관계는 "먼저 클릭한 사람(fromId)이 부모, 나중에 클릭한 사람(toId)이 자식".
 *  - 부모-자식으로 이어진 사람들은 세대가 아래로 1씩 늘어난다(부모 세대 + 1).
 *  - 배우자/형제자매로 이어진 사람들은 같은 세대(같은 가로열)로 맞춘다.
 *  - 같은 세대 안에서는 "부모 쌍이 같은 형제 묶음"을 그 부모 쌍의 x 중심 바로 아래에 두어, 부모-자식
 *    선이 최대한 가지런하게(수직에 가깝게) 이어지도록 배치한다. 서로 다른 부모(쌍)를 둔 묶음끼리는
 *    겹치지 않게 좌우로 밀어낸다.
 *  - 한 사람에게 배우자가 둘 이상(재혼 등)이면 그 사람을 가운데 두고 배우자를 좌우로 벌려 배치하고,
 *    각 배우자와의 자식 수에 맞춰 그 배우자 쪽 간격을 넉넉히 벌려서(트렁크가 항상 그 자식 묶음의
 *    정중앙에 오도록) 부모-자식 세로선이 기울지 않고 곧게 떨어지게 한다.
 *
 * 반환값: Map<personId, {x, y}> — 호출한 쪽에서 tree.updatePerson으로 실제 반영한다.
 */
// 자동 정렬의 기본 간격 값. 카드를 손으로 옮길 때의 "템플릿 간격" 스냅(TreeRenderer._templateSnapCandidates)도
// 이 값을 그대로 가져다 써서, 수동 배치가 자동 정렬 결과와 어긋나지 않게 한다.
export const ROW_SPACING = 240;
export const COL_SPACING = 170;

const EMPTY_SET = new Set();

export function computeAutoLayout(tree, { rowSpacing = ROW_SPACING, colSpacing = COL_SPACING } = {}) {
  const people = [...tree.people.values()];
  if (!people.length) return new Map();

  const parentToChildren = new Map();
  const childToParents = new Map();
  const spouseLinks = [];
  const siblingLinks = [];

  for (const rel of tree.relationships.values()) {
    // parent-child-solo("부모-자식(부모1)")도 세대/정렬 계산에서는 parent-child와 똑같이 다룬다 —
    // 차이는 선을 그리는 방식(TreeRenderer)에만 있다.
    if (rel.type === "parent-child" || rel.type === "parent-child-solo") {
      if (!parentToChildren.has(rel.fromId)) parentToChildren.set(rel.fromId, new Set());
      parentToChildren.get(rel.fromId).add(rel.toId);
      if (!childToParents.has(rel.toId)) childToParents.set(rel.toId, new Set());
      childToParents.get(rel.toId).add(rel.fromId);
    } else if (rel.type === "spouse") {
      spouseLinks.push([rel.fromId, rel.toId]);
    } else if (rel.type === "sibling") {
      siblingLinks.push([rel.fromId, rel.toId]);
    }
  }

  // 1) 세대 계산: indegree 0(부모 없음)인 사람을 0세대로 두고, 부모-자식 간선을 따라 최장 경로로 전파한다.
  const generation = new Map();
  const indegree = new Map(people.map((p) => [p.id, 0]));
  for (const children of parentToChildren.values()) {
    for (const childId of children) indegree.set(childId, (indegree.get(childId) || 0) + 1);
  }
  const queue = people.filter((p) => (indegree.get(p.id) || 0) === 0).map((p) => p.id);
  for (const id of queue) generation.set(id, 0);
  const maxIter = people.length * 4 + 10;
  let guard = 0;
  for (let head = 0; head < queue.length && guard < maxIter; head++, guard++) {
    const id = queue[head];
    const children = parentToChildren.get(id);
    if (!children) continue;
    const candidate = (generation.get(id) || 0) + 1;
    for (const childId of children) {
      if ((generation.get(childId) ?? -1) < candidate) {
        generation.set(childId, candidate);
        queue.push(childId);
      }
    }
  }
  for (const p of people) if (!generation.has(p.id)) generation.set(p.id, 0);

  // 2) 배우자/형제자매는 같은 세대로 통일(간단히 여러 번 전파해 수렴시킨다).
  // 부모-자식 간선으로 세대가 실제로 "확정"된 사람(childToParents에 있는 사람)과, 그런 간선이
  // 전혀 없어 그냥 기본값 0으로 깔린 사람(예: 집안에 결혼으로 들어온 배우자)을 구분해서,
  // 확정된 쪽의 세대를 안 확정된 쪽이 따라가게 한다. 그냥 min을 쓰면 실제로는 자식 세대인 사람이
  // (부모 기록이 없을 뿐인) 배우자의 기본 0세대에 끌려 올라가는 문제가 생긴다.
  const anchored = childToParents; // has(id) → 부모-자식 간선으로 세대가 정해진 사람
  const unify = (links) => {
    for (let pass = 0; pass < 3; pass++) {
      for (const [a, b] of links) {
        if (!generation.has(a) || !generation.has(b)) continue;
        const aAnchored = anchored.has(a);
        const bAnchored = anchored.has(b);
        let g;
        if (aAnchored && !bAnchored) g = generation.get(a);
        else if (bAnchored && !aAnchored) g = generation.get(b);
        else g = Math.min(generation.get(a), generation.get(b));
        generation.set(a, g);
        generation.set(b, g);
      }
    }
  };
  unify(spouseLinks);
  unify(siblingLinks);

  // 배우자는 한 명이 아닐 수 있다(재혼 등) — personId -> 배우자 id 배열(등록 순서)로 여러 명을 담는다.
  const spousesOf = new Map();
  for (const [a, b] of spouseLinks) {
    if (!spousesOf.has(a)) spousesOf.set(a, []);
    if (!spousesOf.has(b)) spousesOf.set(b, []);
    spousesOf.get(a).push(b);
    spousesOf.get(b).push(a);
  }

  // "부모 쌍"(부모 + 그 배우자) 별 자식 수 — 배우자를 얼마나 떨어뜨려야 그 자식 묶음이 트렁크
  // 정중앙에 딱 맞는지 미리 계산해두는 데 쓴다. viaSpouseId가 명시된(=이번 세션에서 만든 "부모-
  // 자식(부모2)") 관계만 대상으로 한다 — 어느 두 사람의 자식 수인지 애매하지 않은 경우만.
  const childCountByCoupleKey = new Map(); // "id1~id2"(정렬) -> Set<childId>
  for (const rel of tree.relationships.values()) {
    if (rel.type !== "parent-child" || !rel.viaSpouseId) continue;
    const key = [rel.fromId, rel.viaSpouseId].sort().join("~");
    if (!childCountByCoupleKey.has(key)) childCountByCoupleKey.set(key, new Set());
    childCountByCoupleKey.get(key).add(rel.toId);
  }
  /** hub와 spouse 사이에 둘 자식 수 기반 간격 — 자식이 없으면 기본 한 칸(colSpacing). */
  const gapFor = (idA, idB) => {
    const key = [idA, idB].sort().join("~");
    const n = (childCountByCoupleKey.get(key) || EMPTY_SET).size;
    const width = Math.max(0, n - 1) * colSpacing;
    return width + colSpacing;
  };

  // 자식마다 "어느 부모 쌍" 소속인지 판단할 때 쓸 대표 관계(가장 먼저 찾은 것 하나) — 한 자식에게
  // 이론상 여러 부모-자식 관계가 걸려 있어도(드묾) 레이아웃 묶음 배정은 하나만 기준으로 한다.
  const primaryParentRelOf = new Map();
  for (const rel of tree.relationships.values()) {
    if (rel.type !== "parent-child" && rel.type !== "parent-child-solo") continue;
    if (!primaryParentRelOf.has(rel.toId)) primaryParentRelOf.set(rel.toId, rel);
  }

  // 3) 세대별로 좌표를 정한다. "부모 쌍이 같은 형제 묶음"을 그 부모 쌍의 x 중심 바로 아래에 두고,
  // 서로 다른 부모(쌍)를 둔 묶음끼리는 겹치지 않게 좌우로 늘어놓는다. 부모 기록이 없는 사람(결혼으로
  // 들어온 배우자, 최상위 세대 등)은 배우자가 이미 속한 묶음이 있으면 그 옆자리에(자식 수에 맞춰
  // 넉넉한 간격으로) 끼워 넣고, 그마저 없으면 자기들끼리 새 묶음을 만든다.
  const rows = new Map();
  for (const p of people) {
    const g = generation.get(p.id) ?? 0;
    if (!rows.has(g)) rows.set(g, []);
    rows.get(g).push(p.id);
  }

  const positions = new Map();

  const anchorXForIds = (ids) => {
    const xs = ids.filter((pid) => positions.has(pid)).map((pid) => positions.get(pid).x);
    return xs.length ? xs.reduce((sum, x) => sum + x, 0) / xs.length : 0;
  };

  for (const g of [...rows.keys()].sort((a, b) => a - b)) {
    const ids = rows.get(g);

    const clusters = new Map(); // coupleKey -> { anchorX, members: [id...], customGaps?: Map<pairKey, gap> }
    const withoutParents = [];
    for (const id of ids) {
      const rel = primaryParentRelOf.get(id);
      if (!rel) {
        withoutParents.push(id);
        continue;
      }
      let anchorIds;
      if (rel.type === "parent-child-solo") {
        anchorIds = [rel.fromId]; // 부모1: 배우자와 무관하게 항상 그 부모 한 명만 기준
      } else if (rel.viaSpouseId) {
        anchorIds = [rel.fromId, rel.viaSpouseId]; // 부모2: 그 특정 부부만 기준(재혼 시 서로 구분됨)
      } else {
        anchorIds = [rel.fromId, ...(spousesOf.get(rel.fromId) || [])]; // viaSpouseId 없는 예전 데이터 추측
      }
      anchorIds = anchorIds.filter((pid) => positions.has(pid));
      if (!anchorIds.length) {
        withoutParents.push(id);
        continue;
      }
      const key = anchorIds.slice().sort().join("~");
      if (!clusters.has(key)) clusters.set(key, { anchorX: anchorXForIds(anchorIds), members: [] });
      clusters.get(key).members.push(id);
    }
    for (const cluster of clusters.values()) {
      cluster.members.sort((a, b) => a.localeCompare(b));
    }

    // 부모 위치가 없는 사람(결혼으로 들어온 배우자 등): 배우자 중 하나가 이미 어느 묶음에 속해
    // 있으면 그 옆에 끼워 넣는다. 첫 번째 배우자는 기존처럼 오른쪽에, 두 번째부터는 왼쪽에 번갈아
    // 끼워 넣어 허브(이미 배치된 쪽)를 가운데 두고 배우자가 좌우로 뻗어나가게 한다. 자식이 있는
    // 배우자 쪽은 gapFor()로 그 자식 수만큼 간격을 넉넉히 벌려, 나중에 자식 묶음이 겹침 방지로
    // 밀려나 트렁크가 기울어지는 일 없이 처음부터 자식 묶음 정중앙에 오게 한다.
    const leftover = new Set(withoutParents);
    const insertedCountFor = new Map(); // hubId -> 지금까지 끼워 넣은 배우자 수
    const tryAttach = (id) => {
      for (const partner of spousesOf.get(id) || []) {
        const host = [...clusters.values()].find((c) => c.members.includes(partner));
        if (!host) continue;
        const seq = insertedCountFor.get(partner) || 0;
        insertedCountFor.set(partner, seq + 1);
        const idx = host.members.indexOf(partner);
        if (seq === 0) host.members.splice(idx + 1, 0, id);
        else host.members.splice(idx, 0, id);
        host.customGaps = host.customGaps || new Map();
        host.customGaps.set([id, partner].sort().join("~"), gapFor(id, partner));
        return true;
      }
      return false;
    };
    let changed = true;
    while (changed) {
      changed = false;
      for (const id of [...leftover]) {
        if (tryAttach(id)) {
          leftover.delete(id);
          changed = true;
        }
      }
    }

    // 여기까지도 못 붙은 사람들은 서로하고만 이어져 있는(완전히 독립된) 뿌리 그룹 — 각자 자기들끼리
    // 새 묶음을 만든다(허브 + 배우자를 좌우로, 같은 규칙으로).
    const placed = new Set();
    let rootIdx = 0;
    for (const id of leftover) {
      if (placed.has(id)) continue;
      const members = [id];
      placed.add(id);
      const customGaps = new Map();
      let seq = 0;
      for (const partner of spousesOf.get(id) || []) {
        if (!leftover.has(partner) || placed.has(partner)) continue;
        placed.add(partner);
        const idx = members.indexOf(id);
        if (seq === 0) members.splice(idx + 1, 0, partner);
        else members.splice(idx, 0, partner);
        customGaps.set([id, partner].sort().join("~"), gapFor(id, partner));
        seq++;
      }
      clusters.set(`__root${rootIdx++}__`, { anchorX: 0, members, customGaps });
    }

    // 묶음을 부모(쌍) 중심 x 기준으로 좌에서 우로 나열하되, 서로 겹치면 최소 간격만큼 밀어낸다.
    // 묶음 내부는 이제 고정 colSpacing이 아니라 인접 쌍별 customGaps(있으면)를 써서 폭을 계산한다.
    const clusterList = [...clusters.values()].sort((a, b) => a.anchorX - b.anchorX);
    let rightEdge = null;
    for (const cluster of clusterList) {
      const members = cluster.members;
      const gaps = cluster.customGaps;
      const offsets = [0];
      for (let i = 1; i < members.length; i++) {
        let gap = colSpacing;
        if (gaps) {
          const pairKey = [members[i - 1], members[i]].sort().join("~");
          if (gaps.has(pairKey)) gap = gaps.get(pairKey);
        }
        offsets.push(offsets[i - 1] + gap);
      }
      const blockWidth = offsets[offsets.length - 1]; // offsets[0]=0이 항상 최솟값(간격은 항상 양수)
      let startX = cluster.anchorX - blockWidth / 2;
      if (rightEdge !== null && startX < rightEdge + colSpacing) {
        startX = rightEdge + colSpacing;
      }
      members.forEach((id, idx) => {
        positions.set(id, { x: startX + offsets[idx], y: g * rowSpacing });
      });
      rightEdge = startX + blockWidth;
    }
  }

  return positions;
}
