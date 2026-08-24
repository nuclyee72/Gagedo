/**
 * 관계 데이터를 바탕으로 세대(가로열)를 계산해 자동으로 배치 좌표를 계산한다.
 * 규약: parent-child 관계는 "먼저 클릭한 사람(fromId)이 부모, 나중에 클릭한 사람(toId)이 자식".
 *  - 부모-자식으로 이어진 사람들은 세대가 아래로 1씩 늘어난다(부모 세대 + 1).
 *  - 배우자/형제자매로 이어진 사람들은 같은 세대(같은 가로열)로 맞춘다.
 *  - 같은 세대 안에서는 "부모가 같은 형제 묶음"을 그 부모의 x 중심 바로 아래에 두어, 부모-자식
 *    선이 최대한 가지런하게(수직에 가깝게) 이어지도록 배치한다. 서로 다른 부모를 둔 묶음끼리는
 *    겹치지 않게 좌우로 밀어낸다.
 *
 * 반환값: Map<personId, {x, y}> — 호출한 쪽에서 tree.updatePerson으로 실제 반영한다.
 */
// 자동 정렬의 기본 간격 값. 카드를 손으로 옮길 때의 "템플릿 간격" 스냅(TreeRenderer._familySnapCandidates)도
// 이 값을 그대로 가져다 써서, 수동 배치가 자동 정렬 결과와 어긋나지 않게 한다.
export const ROW_SPACING = 240;
export const COL_SPACING = 170;

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

  const spousePartner = new Map();
  for (const [a, b] of spouseLinks) {
    spousePartner.set(a, b);
    spousePartner.set(b, a);
  }

  // 3) 세대별로 좌표를 정한다. 부모가 같은 자식들을 하나의 "형제 묶음"으로 만들어 그 부모의
  // x 중심 바로 아래에 두고(부모-자식 선이 최대한 가지런해지도록), 서로 다른 부모를 둔 묶음끼리는
  // 겹치지 않게 좌우로 늘어놓는다. 부모 기록이 없는 사람(결혼으로 들어온 배우자 등)은 배우자가
  // 속한 묶음에 바로 옆자리로 끼워 넣고, 그마저 없으면(최상위 세대) 중심 0인 묶음으로 취급한다.
  const rows = new Map();
  for (const p of people) {
    const g = generation.get(p.id) ?? 0;
    if (!rows.has(g)) rows.set(g, []);
    rows.get(g).push(p.id);
  }

  // 자식 쪽 T자 연결선의 트렁크는 "기록된 부모 + 그 배우자"의 중점에서 내려온다(TreeRenderer
  // 참고). 자동 정렬의 묶음 중심도 똑같이 계산해야 트렁크와 자식 묶음이 어긋나지 않는다 —
  // 배우자를 빼고 기록된 부모의 x만 쓰면, 자식이 둘 이상일 때 버스 바가 한쪽으로 치우쳐 보인다.
  const anchorXFor = (parents) => {
    const xs = [];
    const seen = new Set();
    for (const pid of parents) {
      if (positions.has(pid) && !seen.has(pid)) {
        xs.push(positions.get(pid).x);
        seen.add(pid);
      }
      const partner = spousePartner.get(pid);
      if (partner && positions.has(partner) && !seen.has(partner)) {
        xs.push(positions.get(partner).x);
        seen.add(partner);
      }
    }
    return xs.length ? xs.reduce((sum, x) => sum + x, 0) / xs.length : 0;
  };

  const positions = new Map();
  for (const g of [...rows.keys()].sort((a, b) => a - b)) {
    const ids = rows.get(g);

    const clusters = new Map(); // parentSetKey -> { anchorX, members: [] }
    const withoutParents = [];
    for (const id of ids) {
      const parents = [...(childToParents.get(id) || [])].filter((pid) => positions.has(pid));
      if (!parents.length) {
        withoutParents.push(id);
        continue;
      }
      const key = parents.slice().sort().join(",");
      if (!clusters.has(key)) {
        clusters.set(key, { anchorX: anchorXFor(parents), members: [] });
      }
      clusters.get(key).members.push(id);
    }
    for (const cluster of clusters.values()) {
      cluster.members.sort((a, b) => a.localeCompare(b));
    }

    // 부모 기록이 없는 사람: 배우자가 이미 어느 묶음에 있으면 그 옆자리에 끼워 넣고,
    // 아니면(최상위 세대 등) 별도의 "루트" 묶음으로 모은다.
    const rootMembers = [];
    for (const id of withoutParents) {
      const partner = spousePartner.get(id);
      const hostCluster = [...clusters.values()].find((c) => c.members.includes(partner));
      if (hostCluster) {
        hostCluster.members.splice(hostCluster.members.indexOf(partner) + 1, 0, id);
      } else {
        rootMembers.push(id);
      }
    }
    if (rootMembers.length) {
      const ordered = [];
      const placed = new Set();
      for (const id of rootMembers) {
        if (placed.has(id)) continue;
        ordered.push(id);
        placed.add(id);
        const partner = spousePartner.get(id);
        if (partner && rootMembers.includes(partner) && !placed.has(partner)) {
          ordered.push(partner);
          placed.add(partner);
        }
      }
      clusters.set("__root__", { anchorX: 0, members: ordered });
    }

    // 묶음을 부모 중심 x 기준으로 좌에서 우로 나열하되, 서로 겹치면 최소 간격만큼 밀어낸다.
    const clusterList = [...clusters.values()].sort((a, b) => a.anchorX - b.anchorX);
    let rightEdge = null;
    for (const cluster of clusterList) {
      const n = cluster.members.length;
      let startX = cluster.anchorX - ((n - 1) * colSpacing) / 2;
      if (rightEdge !== null && startX < rightEdge + colSpacing) {
        startX = rightEdge + colSpacing;
      }
      cluster.members.forEach((id, idx) => {
        positions.set(id, { x: startX + idx * colSpacing, y: g * rowSpacing });
      });
      rightEdge = startX + (n - 1) * colSpacing;
    }
  }

  return positions;
}
