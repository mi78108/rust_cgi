// src/ids/ClientId.ts
var generateClientId = () => {
  return crypto.randomUUID();
};

// src/ids/OperationId.ts
var toKey = (id) => `${id[0]}:${id[1]}`;
var generateOperationId = (clientId, counter) => {
  return [clientId, counter];
};

// src/ids/RootId.ts
var ROOT_ID = ["ROOT", 0];

// src/ids/compare.ts
var compareClientId = (a, b) => {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
};
var compareOperationId = (a, b) => {
  if (a[1] < b[1]) return -1;
  if (a[1] > b[1]) return 1;
  return compareClientId(a[0], b[0]);
};

// src/operations/insert.ts
var createInsertOperation = (id, value, leftOrigin, rightOrigin = null) => {
  return { type: "insert", id, value, leftOrigin, rightOrigin };
};

// src/operations/delete.ts
var createDeleteOperation = (target) => {
  return { type: "delete", target };
};

// src/skipList/skipListNode.ts
var createSkipListNode = (refCrdtKey, height) => {
  return {
    refCrdtKey,
    height,
    next: Array(height).fill(null),
    span: Array(height).fill(0)
  };
};

// src/skipList/skipList.ts
var MAX_HEIGHT = 32;
var P = 0.5;
var randomHeight = () => {
  let height = 1;
  while (Math.random() < P && height < MAX_HEIGHT) height++;
  return height;
};
var isBetween = (pred, end, target) => {
  let cur = pred.next[0];
  while (cur && cur !== end) {
    if (cur === target) return true;
    cur = cur.next[0] ?? null;
  }
  return false;
};
var findPredecessor = (sl, index) => {
  const update = Array.from(
    { length: MAX_HEIGHT },
    () => sl.head
  );
  const rankAt = Array.from({ length: MAX_HEIGHT }, () => 0);
  let x = sl.head;
  let rank = 0;
  for (let level = MAX_HEIGHT - 1; level >= 0; level--) {
    while (x.next[level] && rank + x.span[level] <= index) {
      rank += x.span[level];
      x = x.next[level];
    }
    update[level] = x;
    rankAt[level] = rank;
  }
  return { update, rankAt };
};
var createSkipList = () => {
  const head = createSkipListNode(toKey(ROOT_ID), MAX_HEIGHT);
  const nodeMap = /* @__PURE__ */ new Map([[toKey(ROOT_ID), head]]);
  return { head, length: 0, nodeMap };
};
var findByIndex = (sl, targetIndex) => {
  if (targetIndex < 0 || targetIndex >= sl.length) return null;
  let x = sl.head;
  let rank = 0;
  for (let level = MAX_HEIGHT - 1; level >= 0; level--) {
    while (x.next[level] && rank + x.span[level] <= targetIndex) {
      rank += x.span[level];
      x = x.next[level];
    }
  }
  return x.next[0] ?? null;
};
var findIndex = (sl, id) => {
  const key = toKey(id);
  let index = 0;
  let current = sl.head.next[0] ?? null;
  while (current) {
    if (current.refCrdtKey === key) return index;
    index++;
    current = current.next[0] ?? null;
  }
  return -1;
};
var insert = (sl, index, refCrdtId) => {
  const { update, rankAt } = findPredecessor(sl, index);
  const height = randomHeight();
  const newNode = createSkipListNode(toKey(refCrdtId), height);
  sl.nodeMap.set(toKey(refCrdtId), newNode);
  for (let level = 0; level < height; level++) {
    const pred = update[level];
    const split = index - rankAt[level];
    newNode.next[level] = pred.next[level];
    newNode.span[level] = pred.span[level] - split;
    pred.span[level] = split + 1;
    pred.next[level] = newNode;
  }
  for (let level = height; level < MAX_HEIGHT; level++) {
    update[level].span[level]++;
  }
  sl.length++;
  return newNode;
};
var findPredecessorsOf = (sl, target) => {
  const update = Array.from(
    { length: MAX_HEIGHT },
    () => sl.head
  );
  let x = sl.head;
  for (let level = MAX_HEIGHT - 1; level >= 0; level--) {
    while (x.next[level] && x.next[level] !== target) {
      const next = x.next[level];
      if (isBetween(x, next, target)) break;
      x = next;
    }
    update[level] = x;
  }
  return update;
};
var remove = (sl, refCrdtId) => {
  const key = toKey(refCrdtId);
  const target = sl.nodeMap.get(key);
  if (!target || target === sl.head) return false;
  const update = findPredecessorsOf(sl, target);
  const targetHeight = target.height;
  for (let level = 0; level < MAX_HEIGHT; level++) {
    const pred = update[level];
    if (level < targetHeight && pred.next[level] === target) {
      pred.span[level] += target.span[level] - 1;
      pred.next[level] = target.next[level] ?? null;
    } else if (level >= targetHeight) {
      pred.span[level]--;
    }
  }
  sl.nodeMap.delete(key);
  sl.length--;
  return true;
};

// src/store/Node.ts
var createNode = (id, value, tombstone, leftOrigin, rightOrigin) => {
  return { id, value, tombstone, leftOrigin, rightOrigin, next: null };
};

// src/store/NodeStore.ts
var keyMatchHelper = (id1, id2) => {
  if (id1 && id2) return toKey(id1) === toKey(id2);
  if (typeof id1 !== typeof id2) return false;
  return true;
};
var isDescendantOf = (candidate, ancestor, nd) => {
  if (!candidate || !ancestor) return false;
  let current = candidate;
  while (current !== null) {
    if (keyMatchHelper(current, ancestor)) return true;
    const node = nd.nodes.get(toKey(current));
    if (!node) return false;
    current = node.leftOrigin;
  }
  return false;
};
var createNodeStore = (root) => {
  const nodes = /* @__PURE__ */ new Map();
  nodes.set(toKey(ROOT_ID), root);
  return { root, nodes };
};
var insert2 = (nd, op) => {
  const leftOriginNode = nd.nodes.get(toKey(op.leftOrigin));
  if (!leftOriginNode)
    throw new Error(`Operation ${op.id} cannot be merged yet!`);
  const rightOriginNode = op.rightOrigin ? (() => {
    const node = nd.nodes.get(toKey(op.rightOrigin));
    if (!node)
      throw new Error(
        `Operation ${op.id} cannot be merged yet \u2014 rightOrigin missing`
      );
    return node;
  })() : null;
  let prev = leftOriginNode;
  let scan = leftOriginNode.next;
  while (scan !== null && !keyMatchHelper(scan.id, rightOriginNode?.id)) {
    const sameOrigin = keyMatchHelper(scan.leftOrigin, op.leftOrigin);
    const nestedDeeper = !sameOrigin && isDescendantOf(scan.leftOrigin, op.leftOrigin, nd);
    const outsideRange = !sameOrigin && !nestedDeeper;
    if (outsideRange) break;
    if (sameOrigin && compareOperationId(op.id, scan.id) < 0) break;
    prev = scan;
    scan = scan.next;
  }
  const newNode = createNode(
    op.id,
    op.value,
    false,
    op.leftOrigin,
    op.rightOrigin
  );
  newNode.next = prev.next;
  prev.next = newNode;
  nd.nodes.set(toKey(newNode.id), newNode);
};
var remove2 = (nd, op) => {
  const node = nd.nodes.get(toKey(op.target));
  if (!node) {
    throw new Error(`node ${toKey(op.target)} not found`);
  }
  node.tombstone = true;
};
var getText = (nd) => {
  let result = "";
  let current = nd.root.next;
  while (current !== null) {
    if (!current.tombstone) {
      result += current.value;
    }
    current = current.next;
  }
  return result;
};

// src/store/gc.ts
var DEFAULT_GC_GRACE_MS = 3e4;
var createGCTracker = () => ({
  candidates: /* @__PURE__ */ new Map()
});
var referencedKeys = (store) => {
  const refs = /* @__PURE__ */ new Set();
  for (const node of store.nodes.values()) {
    if (node.leftOrigin) refs.add(toKey(node.leftOrigin));
    if (node.rightOrigin) refs.add(toKey(node.rightOrigin));
  }
  return refs;
};
var buildPrevMap = (store) => {
  const prevOf = /* @__PURE__ */ new Map();
  let current = store.root;
  while (current?.next) {
    prevOf.set(toKey(current.next.id), current);
    current = current.next;
  }
  return prevOf;
};
var runGC = (store, frontier, tracker, options = {}) => {
  const gracePeriodMs = options.gracePeriodMs ?? DEFAULT_GC_GRACE_MS;
  const now = options.now ?? Date.now();
  const refs = referencedKeys(store);
  const prevOf = buildPrevMap(store);
  const removed = [];
  const rootKey = toKey(ROOT_ID);
  for (const [key, node] of [...store.nodes]) {
    if (key === rootKey) continue;
    if (!node.tombstone) {
      tracker.candidates.delete(key);
      continue;
    }
    const [clientId, clock] = node.id;
    const safeUpTo = frontier.get(clientId) ?? -1;
    if (clock > safeUpTo || refs.has(key)) {
      tracker.candidates.delete(key);
      continue;
    }
    const eligibleAt = tracker.candidates.get(key);
    if (eligibleAt === void 0) {
      tracker.candidates.set(key, now);
      continue;
    }
    if (now - eligibleAt < gracePeriodMs) continue;
    const prev = prevOf.get(key);
    if (prev) {
      prev.next = node.next;
      if (node.next) prevOf.set(toKey(node.next.id), prev);
    }
    prevOf.delete(key);
    store.nodes.delete(key);
    tracker.candidates.delete(key);
    removed.push(key);
  }
  return removed;
};

// src/documents/Document.ts
var createReplica = (clientId) => {
  const rootNode = createNode(ROOT_ID, "", false, null, null);
  return {
    clientId,
    counter: 0,
    store: createNodeStore(rootNode),
    skipList: createSkipList()
  };
};

// src/documents/apply.ts
var apply = (doc, op) => {
  if (op.type === "insert") {
    insert2(doc.store, op);
    const idxOfLeft = findIndex(doc.skipList, op.leftOrigin);
    insert(doc.skipList, idxOfLeft + 1, op.id);
    return idxOfLeft + 1;
  }
  const index = findIndex(doc.skipList, op.target);
  remove2(doc.store, op);
  remove(doc.skipList, op.target);
  return index;
};

// src/documents/localApply.ts
var buildOpFromLocalInput = (doc, insertedText, insertedLength, deletedLength, position) => {
  const applied = [];
  for (let i = 0; i < deletedLength; i++) {
    const op = buildOp(doc, position, "del");
    // [pad 本地补丁] buildOp 在删无可删时返回 null (见 buildOp 里的说明)
    if (!op) break;
    applied.push({ op, index: apply(doc, op) });
  }
  for (let i = 0; i < insertedLength; i++) {
    const op = buildOp(doc, position + i, "ins", insertedText[i]);
    if (!op) break;
    applied.push({ op, index: apply(doc, op) });
    doc.counter++;
  }
  return applied;
};
var onBeforeInput = (e, before) => {
  const target = e.target;
  before = {
    start: target.selectionStart,
    end: target.selectionEnd,
    value: target.value
  };
};
var onInput = (e, doc, before) => {
  if (!before) return null;
  const deletedLength = before.end - before.start;
  const insertedText = e.inputType === "insertLineBreak" ? "\n" : e.data ?? "";
  switch (e.inputType) {
    case "insertText":
    case "insertLineBreak":
    case "insertFromPaste": {
      return buildOpFromLocalInput(
        doc,
        insertedText,
        insertedText.length,
        deletedLength,
        before.start
      );
    }
    case "deleteContentBackward":
    case "deleteContentForward":
    case "deleteByCut": {
      const deleteCount = deletedLength > 0 ? deletedLength : 1;
      const deletePosition = deletedLength > 0 ? before.start : e.inputType === "deleteContentBackward" ? before.start - 1 : before.start;
      return buildOpFromLocalInput(doc, "", 0, deleteCount, deletePosition);
    }
    default:
      return null;
  }
};
var buildOp = (doc, position, type, content = null) => {
  if (type === "ins") {
    const predIndex = position - 1;
    const slNodePred = predIndex < 0 ? doc.skipList.head : findByIndex(doc.skipList, predIndex);
    if (!slNodePred) throw new Error("no node found");
    const nodeLeft = doc.store.nodes.get(slNodePred.refCrdtKey);
    if (!nodeLeft) throw new Error("no node found");
    const nodeRight = slNodePred.next[0] ? doc.store.nodes.get(slNodePred.next[0].refCrdtKey) : null;
    const opId = generateOperationId(doc.clientId, doc.counter);
    const op = createInsertOperation(
      opId,
      content,
      nodeLeft.id,
      nodeRight?.id
    );
    return op;
  } else {
    const slNodePred = findByIndex(doc.skipList, position);
    // [pad 本地补丁] 上游 bug: 光标在文档开头时按退格, deletePosition 算出 -1,
    // findByIndex 的 targetIndex < 0 守卫直接返回 null, 这里就抛 "no node found"。
    // 实际语义应该是「光标前面没有字符可删」→ 什么都不做, 而不是抛异常。
    // 返回 null 让调用方 (onInput -> buildOpFromLocalInput) 当作无操作。
    if (!slNodePred) return null;
    const node = doc.store.nodes.get(slNodePred.refCrdtKey);
    if (!node) throw new Error("no node found");
    const op = createDeleteOperation(node.id);
    return op;
  }
};

// src/documents/snapshot.ts
var serializeStore = (store) => {
  const out = [];
  for (const node of store.nodes.values()) {
    out.push({
      id: node.id,
      value: node.value,
      tombstone: node.tombstone,
      leftOrigin: node.leftOrigin,
      rightOrigin: node.rightOrigin,
      nextKey: node.next ? toKey(node.next.id) : null
    });
  }
  return out;
};
var serializeSkipList = (skipList) => {
  const skipListNodes = [];
  for (const node of skipList.nodeMap.values()) {
    skipListNodes.push({
      refCrdtKey: node.refCrdtKey,
      height: node.height,
      nextKeys: node.next.map((n) => n ? n.refCrdtKey : null),
      span: [...node.span]
    });
  }
  return { skipListNodes, skipListLength: skipList.length };
};
var takeSnapshot = (doc, stateVector) => {
  const sv = stateVector instanceof Map ? Object.fromEntries(stateVector) : stateVector;
  const { skipListNodes, skipListLength } = serializeSkipList(doc.skipList);
  return {
    version: 1,
    clientId: doc.clientId,
    counter: doc.counter,
    nodes: serializeStore(doc.store),
    skipListNodes,
    skipListLength,
    stateVector: sv
  };
};
var restoreStore = (nodes) => {
  const byKey = /* @__PURE__ */ new Map();
  for (const raw of nodes) {
    byKey.set(
      toKey(raw.id),
      createNode(
        raw.id,
        raw.value,
        raw.tombstone,
        raw.leftOrigin,
        raw.rightOrigin
      )
    );
  }
  for (const raw of nodes) {
    const node = byKey.get(toKey(raw.id));
    node.next = raw.nextKey ? byKey.get(raw.nextKey) ?? null : null;
  }
  const root = byKey.get(toKey(ROOT_ID));
  if (!root) throw new Error("Snapshot missing ROOT node");
  return { root, nodes: byKey };
};
var restoreSkipList = (skipListNodes, skipListLength) => {
  const nodeMap = /* @__PURE__ */ new Map();
  let head = null;
  for (const raw of skipListNodes) {
    const node = createSkipListNode(raw.refCrdtKey, raw.height);
    node.span = [...raw.span];
    nodeMap.set(raw.refCrdtKey, node);
    if (raw.refCrdtKey === toKey(ROOT_ID)) head = node;
  }
  if (!head) throw new Error("Snapshot missing skip list head");
  for (const raw of skipListNodes) {
    const node = nodeMap.get(raw.refCrdtKey);
    node.next = raw.nextKeys.map(
      (key) => key ? nodeMap.get(key) ?? null : null
    );
  }
  return { head, length: skipListLength, nodeMap };
};
var restoreSnapshot = (snapshot) => {
  if (snapshot.version !== 1) {
    throw new Error(`Unsupported snapshot version: ${snapshot.version}`);
  }
  return {
    doc: {
      clientId: snapshot.clientId,
      counter: snapshot.counter,
      store: restoreStore(snapshot.nodes),
      skipList: restoreSkipList(
        snapshot.skipListNodes,
        snapshot.skipListLength
      )
    },
    stateVector: new Map(Object.entries(snapshot.stateVector))
  };
};
var advanceStateVector = (sv, id) => {
  const [clientId, clock] = id;
  const current = sv.get(clientId) ?? -1;
  if (clock > current) sv.set(clientId, clock);
};
var replayOperations = (doc, stateVector, ops) => {
  for (const op of ops) {
    apply(doc, op);
    if (op.type === "insert") advanceStateVector(stateVector, op.id);
  }
};
var restoreFromStorage = (snapshot, delta = []) => {
  const { doc, stateVector } = restoreSnapshot(snapshot);
  replayOperations(doc, stateVector, delta);
  return { doc, stateVector };
};
export {
  ROOT_ID,
  apply,
  buildOp,
  compareOperationId,
  createDeleteOperation,
  createGCTracker,
  createInsertOperation,
  createNode,
  createNodeStore,
  createReplica,
  createSkipList,
  createSkipListNode,
  findByIndex,
  findIndex,
  generateClientId,
  generateOperationId,
  getText,
  insert2 as insert,
  onBeforeInput,
  onInput,
  remove2 as remove,
  replayOperations,
  restoreFromStorage,
  restoreSnapshot,
  runGC,
  insert as skipListInsert,
  remove as skipListRemove,
  takeSnapshot,
  toKey
};