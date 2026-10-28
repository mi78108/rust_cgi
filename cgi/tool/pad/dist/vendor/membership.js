// src/consesous/Ballot.ts
var createBallot = (epoch, proposer) => {
  return {
    epoch,
    proposer
  };
};
var nullBallot = () => {
  return {
    epoch: -1,
    proposer: ""
  };
};
var compareBallot = (a, b) => {
  if (a.epoch !== b.epoch) return a.epoch - b.epoch;
  if (a.proposer < b.proposer) return 1;
  if (a.proposer > b.proposer) return -1;
  return 0;
};

// src/membershipStore/MembershipStore.ts
var createMembershipStore = (initial) => {
  return {
    currentVersion: initial.version,
    membershipRecord: /* @__PURE__ */ new Map([[initial.version, initial]])
  };
};
var commit = (store, membership) => {
  store.membershipRecord.set(membership.version, membership);
  store.currentVersion = membership.version;
};
var get = (store, version) => {
  return store.membershipRecord.get(version) ?? null;
};

// src/membershipStore/MembershipTable.ts
var buildMembership = (version, clientIds) => ({
  version,
  members: [...new Set(clientIds)].sort().map((clientId, i) => ({ clientId, shortId: i }))
});
var addMember = (base, clientId) => {
  const existingIds = base.members.map((m) => m.clientId);
  return buildMembership(base.version + 1, [...existingIds, clientId]);
};
var removeMember = (base, clientId) => {
  const existingIds = base.members.map((m) => m.clientId).filter((id) => id !== clientId);
  return buildMembership(base.version + 1, existingIds);
};
var getShortId = (membership, clientId) => {
  return membership.members.find((m) => m.clientId === clientId)?.shortId ?? null;
};
var getClientId = (membership, shortId) => {
  return membership.members.find((m) => m.shortId === shortId)?.clientId ?? null;
};

// src/consesous/Acceptor.ts
var createAcceptor = (store, broadcast, clientId) => {
  const acceptorState = {
    promisedBallots: /* @__PURE__ */ new Map(),
    acceptedBallots: /* @__PURE__ */ new Map(),
    acceptedMemberships: /* @__PURE__ */ new Map()
  };
  const clearState = () => {
    acceptorState.promisedBallots.clear();
    acceptorState.acceptedBallots.clear();
    acceptorState.acceptedMemberships.clear();
  };
  const onPrepare = (msg) => {
    const promised = acceptorState.promisedBallots.get(msg.version) ?? nullBallot();
    if (compareBallot(msg.ballot, promised) < 0) return;
    acceptorState.promisedBallots.set(msg.version, msg.ballot);
    broadcast({
      type: "PROMISE",
      ballot: msg.ballot,
      version: msg.version,
      senderId: clientId,
      lastAcceptedBallot: acceptorState.acceptedBallots.get(msg.version) ?? null,
      lastAcceptedMembership: acceptorState.acceptedMemberships.get(msg.version) ?? null
    });
  };
  const onAccept = (msg) => {
    const promised = acceptorState.promisedBallots.get(msg.version) ?? nullBallot();
    if (compareBallot(msg.ballot, promised) < 0) return;
    acceptorState.acceptedBallots.set(msg.version, msg.ballot);
    acceptorState.acceptedMemberships.set(msg.version, msg.membership);
    broadcast({
      type: "ACCEPTED",
      ballot: msg.ballot,
      version: msg.version,
      peerId: clientId
    });
  };
  const onCommit = (msg) => {
    commit(store, msg.membership);
    clearState();
  };
  const onMembershipRequest = (msg) => {
    const membership = get(store, msg.version);
    if (membership) {
      broadcast({
        type: "MEMBERSHIP_RESPONSE",
        version: msg.version,
        membership
      });
    }
  };
  return {
    onPrepare,
    onAccept,
    onCommit,
    onMembershipRequest
  };
};

// src/consesous/Proposer.ts
var INITIAL_JITTER = () => Math.random() * 100;
var RETRY_JITTER = () => Math.random() * 500;
var PREPARE_TIMEOUT = 2e3;
var BATCH_WINDOW = 200;
var createProposer = (store, broadcast, clientId) => {
  const proposerState = {
    promises: /* @__PURE__ */ new Map(),
    acceptances: [],
    retryTimer: null,
    epoch: -1,
    joinReqBatch: [],
    leaveReqBatch: [],
    proposalTimer: null,
    proposedMembership: null,
    acceptSent: false
  };
  const clearRetry = () => {
    if (proposerState.retryTimer !== null) {
      clearTimeout(proposerState.retryTimer);
      proposerState.retryTimer = null;
    }
  };
  const clearProposalTimer = () => {
    if (proposerState.proposalTimer !== null) {
      clearTimeout(proposerState.proposalTimer);
      proposerState.proposalTimer = null;
    }
  };
  const quorum = () => {
    const current = get(store, store.currentVersion);
    if (!current || current.members.length === 0) return 1;
    const proposed = proposerState.proposedMembership;
    const count = proposed ? Math.min(current.members.length, proposed.members.length) : current.members.length;
    if (count === 0) return 1;
    return Math.floor(count / 2) + 1;
  };
  const startProposal = (proposedMembership, isRetry = false) => {
    proposerState.epoch++;
    const ballot = createBallot(proposerState.epoch, clientId);
    proposerState.promises.clear();
    proposerState.acceptances = [];
    proposerState.acceptSent = false;
    proposerState.proposedMembership = proposedMembership;
    broadcast({
      type: "PREPARE",
      ballot,
      version: proposedMembership.version
    });
    if (isRetry) return;
    clearRetry();
    proposerState.retryTimer = setTimeout(() => {
      proposerState.retryTimer = null;
      if (proposerState.proposedMembership === proposedMembership) {
        startProposal(proposedMembership, true);
      }
    }, PREPARE_TIMEOUT + RETRY_JITTER());
  };
  const scheduleProposal = () => {
    if (proposerState.proposalTimer) return;
    const currentMembership = get(store, store.currentVersion);
    if (!currentMembership) return;
    const rank = currentMembership.members.findIndex(
      (m) => m.clientId === clientId
    );
    proposerState.proposalTimer = setTimeout(() => {
      proposerState.proposalTimer = null;
      const latest = get(store, store.currentVersion);
      if (!latest) {
        proposerState.joinReqBatch = [];
        proposerState.leaveReqBatch = [];
        return;
      }
      const removals = new Set(proposerState.leaveReqBatch);
      const joins = proposerState.joinReqBatch.filter((id) => !removals.has(id));
      proposerState.joinReqBatch = [];
      proposerState.leaveReqBatch = [];
      const clientIds = [
        ...latest.members.map((member) => member.clientId).filter((id) => !removals.has(id)),
        ...joins
      ];
      const sameSize = clientIds.length === latest.members.length;
      const sameSet = sameSize && latest.members.every((member) => clientIds.includes(member.clientId));
      if (sameSet) return;
      const proposed = buildMembership(latest.version + 1, clientIds);
      startProposal(proposed);
    }, Math.max(0, rank) * 500 + INITIAL_JITTER() + BATCH_WINDOW);
  };
  const onJoinRequest = (msg) => {
    const currentMembership = get(store, store.currentVersion);
    if (!currentMembership) return;
    if (!proposerState.joinReqBatch.includes(msg.clientId)) {
      proposerState.joinReqBatch.push(msg.clientId);
    }
    proposerState.leaveReqBatch = proposerState.leaveReqBatch.filter(
      (id) => id !== msg.clientId
    );
    scheduleProposal();
  };
  const onLeaveRequest = (msg) => {
    const currentMembership = get(store, store.currentVersion);
    if (!currentMembership) return;
    if (!currentMembership.members.some((m) => m.clientId === msg.clientId)) {
      return;
    }
    if (!proposerState.leaveReqBatch.includes(msg.clientId)) {
      proposerState.leaveReqBatch.push(msg.clientId);
    }
    proposerState.joinReqBatch = proposerState.joinReqBatch.filter(
      (id) => id !== msg.clientId
    );
    scheduleProposal();
  };
  const revive = (revivedId) => {
    const hadPendingLeave = proposerState.leaveReqBatch.includes(revivedId);
    proposerState.leaveReqBatch = proposerState.leaveReqBatch.filter(
      (id) => id !== revivedId
    );
    const proposed = proposerState.proposedMembership;
    const current = get(store, store.currentVersion);
    if (!proposed || !current) return hadPendingLeave;
    const currentHas = current.members.some((m) => m.clientId === revivedId);
    const proposedHas = proposed.members.some((m) => m.clientId === revivedId);
    if (!currentHas || proposedHas) return hadPendingLeave;
    const joins = [...proposerState.joinReqBatch];
    const leaves = [...proposerState.leaveReqBatch];
    cancel();
    for (const id of joins) {
      onJoinRequest({ type: "JOIN_REQUEST", clientId: id });
    }
    for (const id of leaves) {
      onLeaveRequest({ type: "LEAVE", clientId: id });
    }
    return true;
  };
  const onPromise = (msg) => {
    const proposed = proposerState.proposedMembership;
    if (!proposed) return;
    if (msg.version !== proposed.version) return;
    if (msg.ballot.epoch !== proposerState.epoch || msg.ballot.proposer !== clientId) {
      return;
    }
    proposerState.promises.set(msg.senderId, msg);
    if (proposerState.promises.size < quorum()) return;
    if (proposerState.acceptSent) return;
    clearRetry();
    clearProposalTimer();
    let highestAcceptedBallot = null;
    let carriedMembership = null;
    for (const promise of proposerState.promises.values()) {
      if (!promise.lastAcceptedBallot || !promise.lastAcceptedMembership) {
        continue;
      }
      if (highestAcceptedBallot === null || compareBallot(promise.lastAcceptedBallot, highestAcceptedBallot) > 0) {
        highestAcceptedBallot = promise.lastAcceptedBallot;
        carriedMembership = promise.lastAcceptedMembership;
      }
    }
    const membership = carriedMembership ?? proposed;
    proposerState.proposedMembership = membership;
    proposerState.acceptSent = true;
    broadcast({
      type: "ACCEPT",
      ballot: createBallot(proposerState.epoch, clientId),
      version: membership.version,
      membership
    });
  };
  const onAccepted = (msg) => {
    const proposed = proposerState.proposedMembership;
    if (!proposed) return;
    if (!proposerState.acceptSent) return;
    if (msg.version !== proposed.version) return;
    if (msg.ballot.epoch !== proposerState.epoch || msg.ballot.proposer !== clientId) {
      return;
    }
    if (!proposerState.acceptances.includes(msg.peerId)) {
      proposerState.acceptances.push(msg.peerId);
    }
    if (proposerState.acceptances.length < quorum()) return;
    clearRetry();
    clearProposalTimer();
    broadcast({
      type: "COMMIT",
      version: proposed.version,
      membership: proposed
    });
    broadcast({
      type: "JOIN_RESPONSE",
      membership: proposed
    });
    proposerState.proposedMembership = null;
    proposerState.promises.clear();
    proposerState.acceptances = [];
    proposerState.acceptSent = false;
  };
  const cancel = () => {
    clearProposalTimer();
    clearRetry();
    proposerState.joinReqBatch = [];
    proposerState.leaveReqBatch = [];
    proposerState.proposedMembership = null;
    proposerState.promises.clear();
    proposerState.acceptances = [];
    proposerState.acceptSent = false;
  };
  return {
    onJoinRequest,
    onLeaveRequest,
    onPromise,
    onAccepted,
    revive,
    cancel
  };
};

// src/consesous/types.ts
var isMembershipMessage = (msg) => {
  if (typeof msg !== "object" || msg === null) return false;
  const type = msg.type;
  return [
    "JOIN_REQUEST",
    "JOIN_RESPONSE",
    "LEAVE",
    "PREPARE",
    "PROMISE",
    "ACCEPT",
    "ACCEPTED",
    "COMMIT",
    "MEMBERSHIP_REQUEST",
    "MEMBERSHIP_RESPONSE",
    "HEARTBEAT"
  ].includes(type ?? "");
};

// src/presence/presence.ts
var DEFAULT_TIMEOUT_MS = 1e4;
var createPresence = () => /* @__PURE__ */ new Map();
var updatePresence = (presence, entry) => {
  const existing = presence.get(entry.clientId);
  if (existing && entry.timestamp <= existing.timestamp) return false;
  presence.set(entry.clientId, entry);
  return true;
};
var mergePresence = (a, b) => {
  const result = new Map(a);
  for (const entry of b.values()) updatePresence(result, entry);
  return result;
};
var evictStale = (presence, timeoutMs = DEFAULT_TIMEOUT_MS, now = Date.now()) => {
  const evicted = [];
  for (const [clientId, entry] of presence) {
    if (now - entry.receivedAt >= timeoutMs) {
      presence.delete(clientId);
      evicted.push(clientId);
    }
  }
  return evicted;
};
var toPeerPresence = (presence) => {
  const peers = /* @__PURE__ */ new Map();
  for (const entry of presence.values()) {
    peers.set(entry.clientId, {
      clientId: entry.clientId,
      cursor: entry.cursor,
      name: entry.name,
      color: entry.color
    });
  }
  return peers;
};
var createPresenceTracker = (options) => {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = options.now ?? Date.now;
  const entries = createPresence();
  const update = (entry) => updatePresence(entries, entry);
  return {
    entries,
    update,
    merge: (other) => {
      let changed = false;
      for (const entry of other.values()) {
        if (update({ ...entry, receivedAt: now() })) changed = true;
      }
      return changed;
    },
    remove: (clientId) => entries.delete(clientId),
    evictStale: (at = now()) => evictStale(entries, timeoutMs, at),
    snapshot: () => toPeerPresence(entries),
    fromHeartbeat: (input) => update({
      clientId: input.clientId,
      cursor: input.presence.cursor,
      name: input.presence.name,
      color: input.presence.color,
      timestamp: input.timestamp,
      receivedAt: now(),
      membershipVersion: input.membershipVersion,
      sv: input.sv
    })
  };
};

// src/presence/gcFrontier.ts
var clockOf = (sv, clientId) => {
  if (sv instanceof Map) return sv.get(clientId) ?? -1;
  return sv[clientId] ?? -1;
};
var computeGCFrontier = (mySv, presence, myClientId) => {
  const frontier = /* @__PURE__ */ new Map();
  const myEntries = mySv instanceof Map ? mySv : new Map(Object.entries(mySv));
  for (const [clientId, myClock] of myEntries) {
    let min = myClock;
    for (const entry of presence.values()) {
      if (entry.clientId === myClientId) continue;
      min = Math.min(min, clockOf(entry.sv, clientId));
    }
    if (min >= 0) frontier.set(clientId, min);
  }
  return frontier;
};

// src/presence/liveness.ts
var DEFAULT_PRESENCE_TIMEOUT_MS = 1e4;
var DEFAULT_REMOVAL_TIMEOUT_MS = 3e4;
var createLivenessTracker = (options = {}) => {
  const presenceTimeoutMs = options.presenceTimeoutMs ?? DEFAULT_PRESENCE_TIMEOUT_MS;
  const removalTimeoutMs = options.removalTimeoutMs ?? DEFAULT_REMOVAL_TIMEOUT_MS;
  const now = options.now ?? Date.now;
  const entries = /* @__PURE__ */ new Map();
  const touch = (clientId, at = now()) => {
    entries.set(clientId, { lastSeen: at, status: "alive" });
    return "alive";
  };
  const remove = (clientId) => entries.delete(clientId);
  const seed = (clientIds, at = now()) => {
    for (const clientId of clientIds) {
      if (!entries.has(clientId)) {
        entries.set(clientId, { lastSeen: at, status: "alive" });
      }
    }
  };
  const syncMembers = (clientIds, at = now()) => {
    const keep = new Set(clientIds);
    const dropped = [];
    for (const clientId of entries.keys()) {
      if (!keep.has(clientId)) {
        entries.delete(clientId);
        dropped.push(clientId);
      }
    }
    seed(clientIds, at);
    return dropped;
  };
  const sweep = (at = now()) => {
    const suspected = [];
    const expired = [];
    for (const [clientId, entry] of entries) {
      const age = at - entry.lastSeen;
      if (age >= removalTimeoutMs) {
        expired.push(clientId);
        continue;
      }
      if (age >= presenceTimeoutMs) {
        if (entry.status !== "suspect") {
          entry.status = "suspect";
          suspected.push(clientId);
        }
      }
    }
    return { suspected, expired };
  };
  return {
    entries,
    touch,
    remove,
    seed,
    syncMembers,
    sweep,
    get: (clientId) => entries.get(clientId)
  };
};

// src/membership.ts
var DEFAULT_FOUNDING_GRACE_MS = 750;
var DEFAULT_HEARTBEAT_INTERVAL_MS = 2e3;
var DEFAULT_PRESENCE_TIMEOUT_MS2 = 1e4;
var DEFAULT_REMOVAL_TIMEOUT_MS2 = 3e4;
var defaultPresence = () => ({
  cursor: 0,
  name: "",
  color: ""
});
var stateVectorToRecord = (getStateVector) => getStateVector?.() ?? {};
var memberIds = (membership) => membership?.members.map((member) => member.clientId) ?? [];
var createMembership = (broadcast, options) => {
  const { clientId } = options;
  const initialMembers = options.initialMembers ?? [];
  const foundingGraceMs = options.foundingGraceMs ?? DEFAULT_FOUNDING_GRACE_MS;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  const presenceTimeoutMs = options.presenceTimeoutMs ?? DEFAULT_PRESENCE_TIMEOUT_MS2;
  const removalTimeoutMs = options.removalTimeoutMs ?? DEFAULT_REMOVAL_TIMEOUT_MS2;
  const store = createMembershipStore(
    buildMembership(options.initialVersion ?? 0, initialMembers)
  );
  let getPresence = options.getPresence ?? defaultPresence;
  let getStateVector = options.getStateVector;
  const presence = createPresenceTracker({
    clientId,
    timeoutMs: presenceTimeoutMs
  });
  const liveness = createLivenessTracker({
    presenceTimeoutMs,
    removalTimeoutMs
  });
  const joinListeners = /* @__PURE__ */ new Set();
  const presenceListeners = /* @__PURE__ */ new Set();
  let joined = initialMembers.includes(clientId);
  let founding = false;
  let foundingTimer = null;
  let heartbeatTimer = null;
  const clearFoundingTimer = () => {
    if (foundingTimer !== null) {
      clearTimeout(foundingTimer);
      foundingTimer = null;
    }
  };
  const stopHeartbeat = () => {
    if (heartbeatTimer !== null) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  };
  const notifyPresence = () => {
    const snapshot = presence.snapshot();
    for (const listener of presenceListeners) listener(snapshot);
  };
  const dropPresence = (id) => {
    if (!presence.remove(id)) return false;
    notifyPresence();
    return true;
  };
  let handle = () => {
  };
  const outbound = (message) => {
    handle(message);
    broadcast(message);
  };
  const proposer = createProposer(store, outbound, clientId);
  const acceptor = createAcceptor(store, outbound, clientId);
  const queueRemoval = (leavingId) => {
    if (!joined || leavingId === clientId) return;
    const current = get(store, store.currentVersion);
    if (!current?.members.some((member) => member.clientId === leavingId)) {
      return;
    }
    proposer.onLeaveRequest({ type: "LEAVE", clientId: leavingId });
  };
  const applyLivenessSweep = () => {
    if (!joined) return;
    const { suspected, expired } = liveness.sweep();
    let presenceChanged = false;
    for (const id of suspected) {
      if (id === clientId) continue;
      if (presence.remove(id)) presenceChanged = true;
    }
    for (const id of expired) {
      if (id === clientId) continue;
      if (presence.remove(id)) presenceChanged = true;
      queueRemoval(id);
    }
    if (presenceChanged) notifyPresence();
  };
  const onPeerHeartbeat = (message) => {
    const changed = presence.fromHeartbeat(message);
    liveness.touch(message.clientId);
    proposer.revive(message.clientId);
    if (changed) notifyPresence();
    applyLivenessSweep();
  };
  const syncAfterMembershipChange = () => {
    const current = get(store, store.currentVersion);
    const ids = memberIds(current);
    const dropped = liveness.syncMembers(ids);
    let presenceChanged = false;
    for (const id of dropped) {
      if (presence.remove(id)) presenceChanged = true;
    }
    if (presenceChanged) notifyPresence();
  };
  const notifyIfJoined = () => {
    if (joined) return;
    const current = get(store, store.currentVersion);
    if (!current?.members.some((member) => member.clientId === clientId)) {
      return;
    }
    joined = true;
    founding = false;
    clearFoundingTimer();
    liveness.seed(memberIds(current));
    for (const listener of joinListeners) listener(current);
    startHeartbeat();
  };
  const handleSelfRemoval = () => {
    if (!joined) return;
    const current = get(store, store.currentVersion);
    if (!current) return;
    if (current.members.some((member) => member.clientId === clientId)) {
      return;
    }
    joined = false;
    stopHeartbeat();
    presence.remove(clientId);
    liveness.remove(clientId);
    notifyPresence();
    requestJoin(clientId);
  };
  const canRunConsensus = () => joined || founding;
  const beginFounding = (joiningId) => {
    if (joined || founding) return;
    founding = true;
    proposer.onJoinRequest({ type: "JOIN_REQUEST", clientId: joiningId });
  };
  const sendHeartbeat = () => {
    if (!joined) return;
    outbound({
      type: "HEARTBEAT",
      clientId,
      membershipVersion: store.currentVersion,
      timestamp: Date.now(),
      presence: getPresence(),
      sv: stateVectorToRecord(getStateVector)
    });
  };
  const startHeartbeat = () => {
    if (heartbeatTimer !== null || !joined || heartbeatIntervalMs <= 0) return;
    sendHeartbeat();
    heartbeatTimer = setInterval(sendHeartbeat, heartbeatIntervalMs);
  };
  handle = (message) => {
    switch (message.type) {
      case "JOIN_REQUEST": {
        const current = get(store, store.currentVersion);
        const empty = current !== null && current.members.length === 0;
        if (joined) {
          proposer.onJoinRequest(message);
          break;
        }
        if (empty && message.clientId !== clientId) {
          beginFounding(clientId);
          proposer.onJoinRequest(message);
        }
        break;
      }
      case "LEAVE": {
        liveness.remove(message.clientId);
        dropPresence(message.clientId);
        if (joined) {
          proposer.onLeaveRequest(message);
        }
        break;
      }
      case "PREPARE":
        if (canRunConsensus()) acceptor.onPrepare(message);
        break;
      case "PROMISE":
        if (canRunConsensus()) proposer.onPromise(message);
        break;
      case "ACCEPT":
        if (canRunConsensus()) acceptor.onAccept(message);
        break;
      case "ACCEPTED":
        if (canRunConsensus()) proposer.onAccepted(message);
        break;
      case "COMMIT":
        acceptor.onCommit(message);
        proposer.cancel();
        syncAfterMembershipChange();
        notifyIfJoined();
        handleSelfRemoval();
        break;
      case "JOIN_RESPONSE":
        commit(store, message.membership);
        proposer.cancel();
        syncAfterMembershipChange();
        notifyIfJoined();
        handleSelfRemoval();
        break;
      case "MEMBERSHIP_REQUEST":
        if (joined) acceptor.onMembershipRequest(message);
        break;
      case "MEMBERSHIP_RESPONSE":
        commit(store, message.membership);
        syncAfterMembershipChange();
        notifyIfJoined();
        handleSelfRemoval();
        break;
      case "HEARTBEAT":
        if (!joined) break;
        onPeerHeartbeat(message);
        break;
      default:
        break;
    }
  };
  const requestJoin = (joiningId = clientId) => {
    outbound({ type: "JOIN_REQUEST", clientId: joiningId });
    if (!joined && joiningId === clientId && get(store, store.currentVersion)?.members.length === 0 && foundingTimer === null) {
      foundingTimer = setTimeout(() => {
        foundingTimer = null;
        if (joined) return;
        beginFounding(clientId);
      }, foundingGraceMs);
    }
  };
  const requestMembership = (version) => {
    outbound({
      type: "MEMBERSHIP_REQUEST",
      version,
      requesterId: clientId
    });
  };
  const leave = () => {
    if (joined) {
      outbound({ type: "LEAVE", clientId });
    }
    clearFoundingTimer();
    stopHeartbeat();
    proposer.cancel();
    joined = false;
  };
  if (joined) {
    liveness.seed(initialMembers);
    startHeartbeat();
  }
  return {
    clientId,
    store,
    onMessage: handle,
    requestJoin,
    requestMembership,
    leave,
    cancel: () => {
      clearFoundingTimer();
      stopHeartbeat();
      proposer.cancel();
    },
    getCurrent: () => get(store, store.currentVersion),
    getVersion: (version) => get(store, version),
    shortIdOf: (id) => {
      const current = get(store, store.currentVersion);
      return current ? getShortId(current, id) : null;
    },
    clientIdOf: (shortId) => {
      const current = get(store, store.currentVersion);
      return current ? getClientId(current, shortId) : null;
    },
    isJoined: () => joined,
    onJoined: (listener) => {
      joinListeners.add(listener);
      if (joined) {
        const current = get(store, store.currentVersion);
        if (current) listener(current);
      }
      return () => {
        joinListeners.delete(listener);
      };
    },
    getPresence: () => presence.snapshot(),
    computeGCFrontier: () => computeGCFrontier(
      getStateVector?.() ?? {},
      presence.entries,
      clientId
    ),
    onPresence: (listener) => {
      presenceListeners.add(listener);
      listener(presence.snapshot());
      return () => {
        presenceListeners.delete(listener);
      };
    },
    setPresenceSource: (source) => {
      if (source.getPresence) getPresence = source.getPresence;
      if (source.getStateVector) getStateVector = source.getStateVector;
    }
  };
};
export {
  addMember,
  buildMembership,
  commit,
  compareBallot,
  computeGCFrontier,
  createAcceptor,
  createBallot,
  createLivenessTracker,
  createMembership,
  createMembershipStore,
  createPresence,
  createPresenceTracker,
  createProposer,
  evictStale,
  get,
  getClientId,
  getShortId,
  isMembershipMessage,
  mergePresence,
  nullBallot,
  removeMember,
  toPeerPresence,
  updatePresence
};