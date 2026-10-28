// src/Document.ts
import {
  createGCTracker,
  createReplica,
  generateClientId,
  getText,
  onInput as localInput,
  restoreFromStorage,
  runGC,
  takeSnapshot
} from "./core.js";
import {
  createMembership,
  getClientId
} from "./membership.js";
import { createBuffer, update as update2 } from "./sync.js";
import {
  createTransport,
  createWebSocketTransport
} from "./transport.js";

// src/Subscription.ts
var createSubscription = () => {
  const listeners = /* @__PURE__ */ new Set();
  const subscribe = (fn) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  };
  const emit = (change) => {
    listeners.forEach((fn) => fn(change));
  };
  return { subscribe, emit };
};

// src/inputSnapshot.ts
var transformPosition = (pos, change) => {
  const { index, insert, delete: del } = change;
  if (insert) return pos >= index ? pos + insert.length : pos;
  if (del) {
    if (pos > index + del) return pos - del;
    if (pos > index) return index;
    return pos;
  }
  return pos;
};
var transformSnapshot = (snapshot, change) => {
  const { index, insert, delete: del } = change;
  let { start, end, value } = snapshot;
  if (insert) {
    value = value.slice(0, index) + insert + value.slice(index);
    if (start >= index) start += insert.length;
    if (end >= index) end += insert.length;
  } else if (del) {
    value = value.slice(0, index) + value.slice(index + del);
    if (start > index + del) start -= del;
    else if (start > index) start = index;
    if (end > index + del) end -= del;
    else if (end > index) end = index;
  }
  return { start, end, value };
};
var undoLocalEdit = (newValue, before, inputType, data) => {
  const inserted = inputType === "insertLineBreak" ? "\n" : data ?? "";
  switch (inputType) {
    case "insertText":
    case "insertLineBreak":
    case "insertFromPaste":
      return newValue.slice(0, before.start) + before.value.slice(before.start, before.end) + newValue.slice(before.start + inserted.length);
    case "deleteContentBackward": {
      const deleteLen = before.end - before.start || 1;
      const deleteStart = before.end > before.start ? before.start : before.start - deleteLen;
      return newValue.slice(0, deleteStart) + before.value.slice(deleteStart, deleteStart + deleteLen) + newValue.slice(deleteStart);
    }
    case "deleteContentForward":
    case "deleteByCut": {
      const deleteLen = before.end - before.start || 1;
      return newValue.slice(0, before.start) + before.value.slice(before.start, before.start + deleteLen) + newValue.slice(before.start);
    }
    default:
      return newValue;
  }
};
var diffRegion = (oldVal, newVal) => {
  let start = 0;
  while (start < oldVal.length && start < newVal.length && oldVal[start] === newVal[start]) {
    start++;
  }
  let endOld = oldVal.length;
  let endNew = newVal.length;
  while (endOld > start && endNew > start && oldVal[endOld - 1] === newVal[endNew - 1]) {
    endOld--;
    endNew--;
  }
  return { start, endOld, endNew };
};
var reconcileDriftedBefore = (before, newValue, inputType, data) => {
  const oldVal = before.value;
  const { start, endOld, endNew } = diffRegion(oldVal, newValue);
  if (inputType === "insertText" || inputType === "insertLineBreak" || inputType === "insertFromPaste") {
    const inserted = inputType === "insertLineBreak" ? "\n" : data ?? "";
    const remoteLen = endNew - start - (endOld - start) - inserted.length;
    if (remoteLen > 0) {
      return transformSnapshot(before, {
        index: start,
        insert: newValue.slice(start, start + remoteLen)
      });
    }
    return before;
  }
  if (inputType === "deleteContentBackward" || inputType === "deleteContentForward" || inputType === "deleteByCut") {
    const localLen = before.end - before.start || 1;
    const remoteLen = endOld - start - (endNew - start) - localLen;
    if (remoteLen > 0) {
      return transformSnapshot(before, { index: start, delete: remoteLen });
    }
    return before;
  }
  return before;
};
var reconcileBefore = (before, newValue, inputType, data = null) => {
  const oldVal = before.value;
  if (oldVal === newValue) return before;
  const valueBeforeLocalEdit = undoLocalEdit(newValue, before, inputType, data);
  if (valueBeforeLocalEdit === oldVal) return before;
  return reconcileDriftedBefore(before, newValue, inputType, data);
};

// src/textChange.ts
var toTextChange = (op, index) => {
  if (op.type === "insert") return { index, insert: op.value };
  return { index, delete: 1 };
};
var textChangeFromDiff = (oldVal, newVal) => {
  if (oldVal === newVal) return null;
  let start = 0;
  while (start < oldVal.length && start < newVal.length && oldVal[start] === newVal[start]) {
    start++;
  }
  let endOld = oldVal.length;
  let endNew = newVal.length;
  while (endOld > start && endNew > start && oldVal[endOld - 1] === newVal[endNew - 1]) {
    endOld--;
    endNew--;
  }
  const inserted = newVal.slice(start, endNew);
  if (inserted.length > 0) return { index: start, insert: inserted };
  const deleted = endOld - start;
  if (deleted > 0) return { index: start, delete: deleted };
  return null;
};

// src/transport.ts
import {
  apply,
  createDeleteOperation,
  createInsertOperation,
  toKey
} from "./core.js";
import {
  addToBuffer,
  canApply,
  flush,
  flushMembership,
  missingOps,
  update
} from "./sync.js";
import {
  isMembershipMessage
} from "./transport.js";
var nodesToOp = (nd, ops) => {
  const operations = [];
  for (const op of ops) {
    const node = nd.nodes.get(toKey(op));
    if (!node) throw new Error(`${op} isn't present`);
    const insertOp = createInsertOperation(
      op,
      node.value,
      node.leftOrigin,
      node.rightOrigin
    );
    if (node.tombstone) operations.push(insertOp, createDeleteOperation(op));
    else operations.push(insertOp);
  }
  return operations;
};
var isOpPresent = (store, op) => {
  const node = store.nodes.get(toKey(op.type === "insert" ? op.id : op.target));
  if (!node) return false;
  if (op.type === "delete") return node.tombstone;
  return true;
};
var handleIncomingOp = (buffer, doc, op, sv, onApplied, transport, syncReqTimerRef) => {
  if (isOpPresent(doc.store, op)) return;
  if (canApply(doc, op)) {
    const index = apply(doc, op);
    onApplied(op, index);
    const appliedOps = flush(buffer, doc, op);
    appliedOps.forEach(({ op: op2, index: index2 }) => onApplied(op2, index2));
    if (op.type === "insert") {
      update(sv, op.id);
    }
  } else {
    addToBuffer(buffer, doc, op);
    scheduleSyncRequest(transport, sv, doc.clientId, syncReqTimerRef);
  }
};
var scheduleSyncRequest = (transport, sv, clientId, syncReqTimerRef) => {
  if (syncReqTimerRef.current) clearTimeout(syncReqTimerRef.current);
  syncReqTimerRef.current = setTimeout(() => {
    syncReqTimerRef.current = void 0;
    transport.send({ type: "sync-request", vector: sv, clientId });
  }, 50);
};
var handleSyncReq = (mineSv, theirSv, transport, timerRef, requestQueue, doc) => {
  if (timerRef.current) return;
  const misingOps = missingOps(mineSv, theirSv);
  const backOffDelay = misingOps.length === 0 ? 2147483647 : -Math.log(Math.random()) / misingOps.length;
  const ops = nodesToOp(doc.store, misingOps);
  timerRef.current = setTimeout(() => {
    transport.send({ type: "sync-response", ops, clientIds: requestQueue });
    requestQueue.length = 0;
    timerRef.current = void 0;
  }, backOffDelay);
};
var handleSyncRes = (buffer, doc, clientIds, opClientId, ops, sv, timerRef, onApplied, transport, syncReqTimerRef) => {
  const isMinePresent = clientIds.includes(opClientId);
  if (isMinePresent) {
    for (const op of ops) {
      handleIncomingOp(
        buffer,
        doc,
        op,
        sv,
        onApplied,
        transport,
        syncReqTimerRef
      );
    }
    return;
  }
  clearTimeout(timerRef.current);
};
var manageTransport = (transport, doc, sv, buffer, onApplied, membership) => {
  const timerRef = { current: void 0 };
  const syncReqTimerRef = { current: void 0 };
  const requestQueue = [];
  let opened = false;
  let joined = false;
  let syncRequested = false;
  const requestInitialSync = () => {
    if (!opened || !joined || syncRequested) return;
    syncRequested = true;
    transport.send({
      type: "sync-request",
      vector: sv,
      clientId: doc.clientId
    });
  };
  transport.onOpen(() => {
    opened = true;
    if (!membership.isJoined()) membership.requestJoin(doc.clientId);
    requestInitialSync();
  });
  membership.onJoined(() => {
    joined = true;
    requestInitialSync();
  });
  transport.onMessage((message) => {
    if (isMembershipMessage(message)) {
      membership.onMessage(message);
      for (const { op, index } of flushMembership(buffer, doc, membership)) {
        if (op.type === "insert") update(sv, op.id);
        onApplied(op, index);
      }
      return;
    }
    if (!membership.isJoined()) return;
    switch (message.type) {
      case "op":
        handleIncomingOp(
          buffer,
          doc,
          message.op,
          sv,
          onApplied,
          transport,
          syncReqTimerRef
        );
        break;
      case "sync-request":
        requestQueue.push(message.clientId);
        handleSyncReq(
          sv,
          message.vector,
          transport,
          timerRef,
          requestQueue,
          doc
        );
        break;
      case "sync-response":
        handleSyncRes(
          buffer,
          doc,
          message.clientIds,
          doc.clientId,
          message.ops,
          sv,
          timerRef,
          onApplied,
          transport,
          syncReqTimerRef
        );
    }
  });
};

// src/Document.ts
var colorFromId = (clientId) => {
  let hash = 0;
  for (let index = 0; index < clientId.length; index++) {
    hash = hash * 31 + clientId.charCodeAt(index) >>> 0;
  }
  const hue = hash % 360;
  return `hsl(${hue} 70% 45%)`;
};
var captureSnapshot = (el) => ({
  start: el.selectionStart,
  end: el.selectionEnd,
  value: el.value
});
var createWeavo = (urlOrTransport, options = {}) => {
  const restored = options.initial ? restoreFromStorage(options.initial.snapshot, options.initial.delta ?? []) : null;
  const clientId = options.clientId ?? generateClientId();
  const doc = restored?.doc ?? createReplica(clientId);
  const sv = restored?.stateVector ?? /* @__PURE__ */ new Map();
  const buffer = createBuffer();
  const rawTransport = typeof urlOrTransport === "string" ? createWebSocketTransport(urlOrTransport) : urlOrTransport;
  const displayName = options.name ?? clientId.slice(0, 8);
  const displayColor = options.color ?? colorFromId(clientId);
  let presenceName = displayName;
  let presenceColor = displayColor;
  let boundEl = null;
  let membership;
  const transport = createTransport(rawTransport, {
    idCodec: {
      encodeVersion: () => membership.getCurrent()?.version ?? 0,
      shortIdOf: (id) => membership.shortIdOf(id),
      clientIdOf: (version, shortId) => {
        const table = membership.getVersion(version);
        return table ? getClientId(table, shortId) : null;
      },
      hasVersion: (version) => membership.getVersion(version) !== null,
      onMissingVersion: (version) => membership.requestMembership(version)
    }
  });
  membership = createMembership((message) => transport.send(message), {
    clientId,
    getPresence: () => ({
      cursor: boundEl?.selectionStart ?? 0,
      name: presenceName,
      color: presenceColor
    }),
    getStateVector: () => Object.fromEntries(sv),
    ...options.foundingGraceMs !== void 0 ? { foundingGraceMs: options.foundingGraceMs } : {},
    ...options.initialMembers !== void 0 ? { initialMembers: options.initialMembers } : {},
    ...options.initialVersion !== void 0 ? { initialVersion: options.initialVersion } : {},
    ...options.heartbeatIntervalMs !== void 0 ? { heartbeatIntervalMs: options.heartbeatIntervalMs } : {},
    ...options.presenceTimeoutMs !== void 0 ? { presenceTimeoutMs: options.presenceTimeoutMs } : {},
    ...options.removalTimeoutMs !== void 0 ? { removalTimeoutMs: options.removalTimeoutMs } : {}
  });
  const subscription = createSubscription();
  const gcTracker = createGCTracker();
  const gcGracePeriodMs = options.gcGracePeriodMs ?? options.removalTimeoutMs ?? 3e4;
  const sweepGC = () => {
    runGC(doc.store, membership.computeGCFrontier(), gcTracker, {
      gracePeriodMs: gcGracePeriodMs
    });
  };
  membership.onPresence(() => {
    sweepGC();
  });
  let before = null;
  let pendingInput = false;
  let composition = null;
  const emitChange = (change) => subscription.emit(change);
  const applyRemoteToBound = (prevText, newText) => {
    const change = textChangeFromDiff(prevText, newText);
    if (!change) return;
    if (boundEl) {
      const selectionStart = boundEl.selectionStart;
      const selectionEnd = boundEl.selectionEnd;
      boundEl.value = newText;
      boundEl.selectionStart = transformPosition(selectionStart, change);
      boundEl.selectionEnd = transformPosition(selectionEnd, change);
      if (before) before = transformSnapshot(before, change);
    }
    emitChange(change);
  };
  const notifyOp = (op) => options.onOp?.(op);
  const onApplied = (op, index) => {
    notifyOp(op);
    if (composition) {
      const change = toTextChange(op, index);
      composition.docStart = transformPosition(composition.docStart, change);
      composition.docEnd = transformPosition(composition.docEnd, change);
      emitChange(change);
      return;
    }
    const prevText = boundEl?.value ?? "";
    applyRemoteToBound(prevText, getText(doc.store));
  };
  const processLocalInput = (event, snapshot) => {
    if (!membership.isJoined()) return;
    const applied = localInput(event, doc, snapshot);
    if (!applied) return;
    applied.forEach(({ op, index }) => {
      if (op.type === "insert") {
        update2(sv, op.id);
      }
      notifyOp(op);
      emitChange(toTextChange(op, index));
      transport.send({ type: "op", op });
    });
  };
  const resolveDelete = (snapshot, currentValue) => {
    const removed = textChangeFromDiff(snapshot.value, currentValue);
    if (!removed || !removed.delete) return null;
    return {
      start: removed.index,
      end: removed.index + removed.delete,
      value: snapshot.value
    };
  };
  const commitComposition = (comp) => {
    const el = boundEl;
    if (!el) return;
    const tailLength = comp.value.length - comp.end;
    const composedEnd = Math.max(comp.start, el.value.length - tailLength);
    const composed = el.value.slice(comp.start, composedEnd);
    if (composed.length > 0 || comp.docEnd > comp.docStart) {
      processLocalInput(
        new InputEvent("input", { inputType: "insertText", data: composed }),
        { start: comp.docStart, end: comp.docEnd, value: getText(doc.store) }
      );
    }
    applyRemoteToBound(el.value, getText(doc.store));
    before = captureSnapshot(el);
  };
  manageTransport(transport, doc, sv, buffer, onApplied, membership);
  transport.connect();
  const bind = (el) => {
    boundEl = el;
    const text = getText(doc.store);
    if (text) {
      el.value = text;
      before = captureSnapshot(el);
    }
    let unsubJoined;
    if (!membership.isJoined()) {
      el.readOnly = true;
      unsubJoined = membership.onJoined(() => {
        el.readOnly = false;
        unsubJoined?.();
        unsubJoined = void 0;
      });
    } else {
      el.readOnly = false;
    }
    const onKeyDown = (event) => {
      if (composition) return;
      if (event.key === "Backspace" || event.key === "Delete") {
        before = captureSnapshot(el);
        pendingInput = true;
      }
    };
    const onBeforeInput = (event) => {
      if (!membership.isJoined()) {
        event.preventDefault();
        return;
      }
      if (composition) return;
      before = captureSnapshot(event.target);
      pendingInput = true;
    };
    const onInput = (event) => {
      const inputEvent = event;
      if (composition || inputEvent.inputType === "insertCompositionText") {
        return;
      }
      if (!before) return;
      if (inputEvent.inputType.startsWith("delete")) {
        const range = resolveDelete(before, el.value);
        if (range) {
          processLocalInput(
            new InputEvent("input", { inputType: "deleteContentForward" }),
            range
          );
        }
        before = captureSnapshot(el);
        pendingInput = false;
        return;
      }
      const snapshot = reconcileBefore(
        before,
        el.value,
        inputEvent.inputType,
        inputEvent.data
      );
      before = snapshot;
      processLocalInput(inputEvent, snapshot);
      pendingInput = false;
    };
    const onCompositionStart = () => {
      if (!membership.isJoined()) return;
      composition = {
        value: el.value,
        start: el.selectionStart,
        end: el.selectionEnd,
        docStart: el.selectionStart,
        docEnd: el.selectionEnd
      };
      pendingInput = false;
    };
    const onCompositionEnd = () => {
      const comp = composition;
      composition = null;
      if (comp) commitComposition(comp);
    };
    const refreshSnapshot = () => {
      if (pendingInput || composition) return;
      before = captureSnapshot(el);
    };
    el.addEventListener("keydown", onKeyDown, true);
    el.addEventListener("beforeinput", onBeforeInput);
    el.addEventListener("input", onInput);
    el.addEventListener("compositionstart", onCompositionStart);
    el.addEventListener("compositionend", onCompositionEnd);
    el.addEventListener("click", refreshSnapshot);
    el.addEventListener("select", refreshSnapshot);
    el.addEventListener("keyup", refreshSnapshot);
    return () => {
      unsubJoined?.();
      el.removeEventListener("keydown", onKeyDown, true);
      el.removeEventListener("beforeinput", onBeforeInput);
      el.removeEventListener("input", onInput);
      el.removeEventListener("compositionstart", onCompositionStart);
      el.removeEventListener("compositionend", onCompositionEnd);
      el.removeEventListener("click", refreshSnapshot);
      el.removeEventListener("select", refreshSnapshot);
      el.removeEventListener("keyup", refreshSnapshot);
      if (boundEl === el) boundEl = null;
      composition = null;
    };
  };
  return {
    bind,
    textSubscribe: subscription.subscribe,
    onPresence: membership.onPresence,
    getPresence: () => membership.getPresence(),
    setIdentity: (identity) => {
      if (identity.name !== void 0) presenceName = identity.name;
      if (identity.color !== void 0) presenceColor = identity.color;
    },
    snapshot: () => takeSnapshot(doc, sv),
    disconnect: () => {
      membership.leave();
      transport.disconnect();
    },
    membership
  };
};
export {
  createWeavo
};