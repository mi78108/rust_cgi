// src/buffer/buffer.ts
import {
  toKey,
  apply
} from "./core.js";

// src/buffer/unresolved.ts
import { getClientId } from "./membership.js";
var UNRESOLVED_PREFIX = "~";
var unresolvedClientId = (version, shortId) => `${UNRESOLVED_PREFIX}${version}:${shortId}`;
var parseUnresolvedClientId = (clientId) => {
  if (!clientId.startsWith(UNRESOLVED_PREFIX)) return null;
  const [version, shortId] = clientId.slice(1).split(":");
  if (version === void 0 || shortId === void 0) return null;
  return { version: Number(version), shortId: Number(shortId) };
};
var idsOf = (op) => op.type === "delete" ? [op.target] : op.rightOrigin === null ? [op.id, op.leftOrigin] : [op.id, op.leftOrigin, op.rightOrigin];
var pendingMembershipVersion = (op) => {
  for (const [clientId] of idsOf(op)) {
    const unresolved = parseUnresolvedClientId(clientId);
    if (unresolved) return unresolved.version;
  }
  return null;
};
var membershipKey = (version) => `${UNRESOLVED_PREFIX}membership:${version}`;
var membershipKeyVersion = (key) => {
  if (!key.startsWith(`${UNRESOLVED_PREFIX}membership:`)) return null;
  return Number(key.slice(key.indexOf(":") + 1));
};
var resolveId = (id, membership) => {
  const unresolved = parseUnresolvedClientId(id[0]);
  if (!unresolved) return id;
  const table = membership.getVersion(unresolved.version);
  if (!table) return id;
  const clientId = getClientId(table, unresolved.shortId);
  return clientId === null ? id : [clientId, id[1]];
};
var resolveOperation = (op, membership) => {
  if (op.type === "delete") {
    return { type: "delete", target: resolveId(op.target, membership) };
  }
  return {
    type: "insert",
    id: resolveId(op.id, membership),
    value: op.value,
    leftOrigin: resolveId(op.leftOrigin, membership),
    rightOrigin: op.rightOrigin === null ? null : resolveId(op.rightOrigin, membership)
  };
};

// src/buffer/buffer.ts
var createBuffer = () => ({
  waiting: /* @__PURE__ */ new Map(),
  buffered: /* @__PURE__ */ new Map(),
  pendingDeletes: /* @__PURE__ */ new Map()
});
var getMissingDeps = (doc, op) => {
  const missing = [];
  if (op.type === "insert") {
    if (!doc.store.nodes.has(toKey(op.leftOrigin)))
      missing.push(toKey(op.leftOrigin));
    if (op.rightOrigin && !doc.store.nodes.has(toKey(op.rightOrigin)))
      missing.push(toKey(op.rightOrigin));
  }
  return missing;
};
var wait = (buffer, dep, op) => {
  if (!buffer.waiting.has(dep)) buffer.waiting.set(dep, /* @__PURE__ */ new Set());
  buffer.waiting.get(dep).add(op);
};
var remember = (buffer, op) => {
  if (op.type === "delete") buffer.pendingDeletes.set(toKey(op.target), op);
  else buffer.buffered.set(toKey(op.id), op);
};
var addToBuffer = (buffer, doc, op) => {
  const version = pendingMembershipVersion(op);
  if (version !== null) {
    remember(buffer, op);
    wait(buffer, membershipKey(version), op);
    return;
  }
  if (op.type === "delete") {
    buffer.pendingDeletes.set(toKey(op.target), op);
    return;
  }
  buffer.buffered.set(toKey(op.id), op);
  for (const dep of getMissingDeps(doc, op)) wait(buffer, dep, op);
};
var flush = (buffer, doc, unblockedKey) => {
  if (unblockedKey.type === "delete") {
    buffer.pendingDeletes.delete(toKey(unblockedKey.target));
    return [];
  }
  return drain(buffer, doc, [
    ...buffer.waiting.get(toKey(unblockedKey.id)) ?? []
  ]);
};
var flushMembership = (buffer, doc, membership) => {
  const unblocked = [];
  for (const [key, ops] of [...buffer.waiting]) {
    const version = membershipKeyVersion(key);
    if (version === null || membership.getVersion(version) === null) continue;
    buffer.waiting.delete(key);
    for (const op of ops) {
      forget(buffer, op);
      const resolved = resolveOperation(op, membership);
      if (pendingMembershipVersion(resolved) !== null) {
        addToBuffer(buffer, doc, resolved);
        continue;
      }
      unblocked.push(resolved);
    }
  }
  return drain(buffer, doc, unblocked);
};
var drain = (buffer, doc, queue) => {
  const operations = [];
  while (queue.length) {
    const op = queue.shift();
    if (!canApply(doc, op)) {
      addToBuffer(buffer, doc, op);
      continue;
    }
    const index = apply(doc, op);
    forget(buffer, op);
    operations.push({ op, index });
    if (op.type === "insert") {
      queue.push(...buffer.waiting.get(toKey(op.id)) ?? []);
    }
  }
  return operations;
};
var forget = (buffer, op) => {
  const deps = [];
  const version = pendingMembershipVersion(op);
  if (version !== null) deps.push(membershipKey(version));
  if (op.type === "delete") {
    buffer.pendingDeletes.delete(toKey(op.target));
  } else {
    buffer.buffered.delete(toKey(op.id));
    deps.push(toKey(op.leftOrigin));
    if (op.rightOrigin) deps.push(toKey(op.rightOrigin));
  }
  for (const dep of deps) {
    const set = buffer.waiting.get(dep);
    if (!set) continue;
    set.delete(op);
    if (set.size === 0) buffer.waiting.delete(dep);
  }
};
var canApply = (doc, op) => {
  if (pendingMembershipVersion(op) !== null) return false;
  if (op.type === "insert") return canApplyInsert(doc, op);
  return canApplyDelete(doc, op);
};
var canApplyDelete = (doc, op) => doc.store.nodes.has(toKey(op.target));
var canApplyInsert = (doc, op) => {
  const leftExists = doc.store.nodes.has(toKey(op.leftOrigin));
  const rightExists = op.rightOrigin === null ? true : doc.store.nodes.has(toKey(op.rightOrigin));
  return leftExists && rightExists;
};

// src/stateVector/stateVector.ts
var update = (sv, id) => {
  const [clientId, clock] = id;
  const current = sv.get(clientId) ?? -1;
  if (clock > current) sv.set(clientId, clock);
};
var missingOps = (mineSv, theirSv) => {
  const missingOps2 = [];
  mineSv.forEach((myClock, clientId) => {
    const theirClock = theirSv.get(clientId) ?? -1;
    for (let clock = theirClock + 1; clock <= myClock; clock++) {
      missingOps2.push([clientId, clock]);
    }
  });
  return missingOps2;
};
export {
  addToBuffer,
  canApply,
  createBuffer,
  flush,
  flushMembership,
  membershipKey,
  missingOps,
  parseUnresolvedClientId,
  pendingMembershipVersion,
  resolveOperation,
  unresolvedClientId,
  update
};