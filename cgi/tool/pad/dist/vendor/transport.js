// src/index.ts
import { isMembershipMessage } from "./membership.js";

// src/codec/buffer.ts
var createWriter = (capacity = 64) => ({
  buf: new Uint8Array(capacity),
  offset: 0
});
var ensureCapacity = (writer, needed) => {
  if (writer.offset + needed <= writer.buf.length) return;
  const next = new Uint8Array(
    Math.max(writer.buf.length * 2, writer.offset + needed)
  );
  next.set(writer.buf.subarray(0, writer.offset));
  writer.buf = next;
};
var toBytes = (writer) => writer.buf.slice(0, writer.offset);
var createReader = (buf) => ({
  buf,
  offset: 0
});
var assertReadable = (reader, length) => {
  if (length < 0 || reader.offset + length > reader.buf.length) {
    throw new Error("Unexpected end of binary message");
  }
};
var writeU8 = (writer, value) => {
  ensureCapacity(writer, 1);
  writer.buf[writer.offset++] = value;
};
var readU8 = (reader) => {
  assertReadable(reader, 1);
  return reader.buf[reader.offset++];
};
var writeBytes = (writer, bytes) => {
  ensureCapacity(writer, bytes.length);
  writer.buf.set(bytes, writer.offset);
  writer.offset += bytes.length;
};
var readBytes = (reader, length) => {
  assertReadable(reader, length);
  const bytes = reader.buf.slice(reader.offset, reader.offset + length);
  reader.offset += length;
  return bytes;
};
var assertFullyRead = (reader) => {
  if (reader.offset !== reader.buf.length) {
    throw new Error("Unexpected trailing bytes in binary message");
  }
};

// src/codec/idCodec.ts
var uuidOnlyCodec = {
  encodeVersion: () => 0,
  shortIdOf: () => null,
  clientIdOf: () => null,
  hasVersion: () => true
};

// src/codec/membership.ts
import {
  buildMembership
} from "./membership.js";

// src/codec/tags.ts
var WIRE_VERSION = 3;
var MSG_OP = 1;
var MSG_SYNC_REQUEST = 2;
var MSG_SYNC_RESPONSE = 3;
var MSG_MEMBERSHIP = 4;
var OP_INSERT = 17;
var OP_INSERT_NO_RIGHT = 18;
var OP_DELETE = 19;
var OP_ID_ROOT = 0;
var OP_ID_UUID = 1;
var OP_ID_SHORT = 2;
var MEM_JOIN_REQUEST = 1;
var MEM_JOIN_RESPONSE = 2;
var MEM_LEAVE = 3;
var MEM_PREPARE = 4;
var MEM_PROMISE = 5;
var MEM_ACCEPT = 6;
var MEM_ACCEPTED = 7;
var MEM_COMMIT = 8;
var MEM_MEMBERSHIP_REQUEST = 9;
var MEM_MEMBERSHIP_RESPONSE = 10;
var MEM_HEARTBEAT = 11;

// src/codec/varint.ts
var writeVarint = (writer, value) => {
  if (!Number.isSafeInteger(value) || value < 0 || value > 4294967295) {
    throw new Error(`Value is outside uint32 range: ${value}`);
  }
  let remaining = value;
  while (remaining >= 128) {
    writeU8(writer, remaining % 128 | 128);
    remaining = Math.floor(remaining / 128);
  }
  writeU8(writer, remaining);
};
var readVarint = (reader) => {
  let result = 0;
  let multiplier = 1;
  for (let index = 0; index < 5; index++) {
    const byte = readU8(reader);
    result += (byte & 127) * multiplier;
    if ((byte & 128) === 0) {
      if (result > 4294967295) throw new Error("Varint exceeds uint32 range");
      return result;
    }
    multiplier *= 128;
  }
  throw new Error("Varint exceeds uint32 range");
};
var writeUint53 = (writer, value) => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Value is outside uint53 range: ${value}`);
  }
  writeVarint(writer, Math.floor(value / 4294967296));
  writeVarint(writer, value % 4294967296);
};
var readUint53 = (reader) => {
  const high = readVarint(reader);
  const low = readVarint(reader);
  return high * 4294967296 + low;
};

// src/codec/utf8.ts
var encoder = new TextEncoder();
var decoder = new TextDecoder("utf-8", { fatal: true });
var HIGH_START = 55296;
var LOW_START = 56320;
var SURROGATE_END = 57343;
var isHighSurrogate = (unit) => unit >= HIGH_START && unit < LOW_START;
var isLowSurrogate = (unit) => unit >= LOW_START && unit <= SURROGATE_END;
var hasLoneSurrogate = (value) => {
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (isHighSurrogate(unit)) {
      if (!isLowSurrogate(value.charCodeAt(index + 1))) return true;
      index++;
    } else if (isLowSurrogate(unit)) {
      return true;
    }
  }
  return false;
};
var encodeWtf8 = (value) => {
  const bytes = [];
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit < 128) {
      bytes.push(unit);
      continue;
    }
    if (unit < 2048) {
      bytes.push(192 | unit >> 6, 128 | unit & 63);
      continue;
    }
    if (isHighSurrogate(unit)) {
      const next = value.charCodeAt(index + 1);
      if (isLowSurrogate(next)) {
        const codePoint = 65536 + (unit - HIGH_START << 10) + (next - LOW_START);
        bytes.push(
          240 | codePoint >> 18,
          128 | codePoint >> 12 & 63,
          128 | codePoint >> 6 & 63,
          128 | codePoint & 63
        );
        index++;
        continue;
      }
    }
    bytes.push(
      224 | unit >> 12,
      128 | unit >> 6 & 63,
      128 | unit & 63
    );
  }
  return new Uint8Array(bytes);
};
var decodeWtf8 = (bytes) => {
  let out = "";
  for (let index = 0; index < bytes.length; ) {
    const byte = bytes[index];
    if (byte < 128) {
      out += String.fromCharCode(byte);
      index += 1;
      continue;
    }
    if (byte < 224) {
      out += String.fromCharCode(
        (byte & 31) << 6 | bytes[index + 1] & 63
      );
      index += 2;
      continue;
    }
    if (byte < 240) {
      out += String.fromCharCode(
        (byte & 15) << 12 | (bytes[index + 1] & 63) << 6 | bytes[index + 2] & 63
      );
      index += 3;
      continue;
    }
    const codePoint = (byte & 7) << 18 | (bytes[index + 1] & 63) << 12 | (bytes[index + 2] & 63) << 6 | bytes[index + 3] & 63;
    out += String.fromCodePoint(codePoint);
    index += 4;
  }
  return out;
};
var writeUtf8 = (writer, value) => {
  const bytes = hasLoneSurrogate(value) ? encodeWtf8(value) : encoder.encode(value);
  writeVarint(writer, bytes.length);
  writeBytes(writer, bytes);
};
var readUtf8 = (reader) => {
  const bytes = readBytes(reader, readVarint(reader));
  try {
    return decoder.decode(bytes);
  } catch {
    return decodeWtf8(bytes);
  }
};

// src/codec/uuid.ts
var UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
var uuidToBytes = (uuid) => {
  if (!UUID_PATTERN.test(uuid)) throw new Error(`Invalid client UUID: ${uuid}`);
  const hex = uuid.replaceAll("-", "");
  const bytes = new Uint8Array(16);
  for (let index = 0; index < bytes.length; index++) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
};
var bytesToUuid = (bytes) => {
  if (bytes.length !== 16) throw new Error("A UUID must contain 16 bytes");
  const hex = Array.from(
    bytes,
    (byte) => byte.toString(16).padStart(2, "0")
  ).join("");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20)
  ].join("-");
};
var writeUuid = (writer, clientId) => {
  writeBytes(writer, uuidToBytes(clientId));
};
var readUuid = (reader) => bytesToUuid(readBytes(reader, 16));

// src/codec/membership.ts
var writeBallot = (writer, ballot) => {
  writeVarint(writer, ballot.epoch);
  writeUuid(writer, ballot.proposer);
};
var readBallot = (reader) => ({
  epoch: readVarint(reader),
  proposer: readUuid(reader)
});
var writeOptionalBallot = (writer, ballot) => {
  if (ballot === null) {
    writeU8(writer, 0);
    return;
  }
  writeU8(writer, 1);
  writeBallot(writer, ballot);
};
var readOptionalBallot = (reader) => {
  const flag = readU8(reader);
  if (flag === 0) return null;
  if (flag === 1) return readBallot(reader);
  throw new Error(`Invalid optional ballot flag: ${flag}`);
};
var writeMembership = (writer, membership) => {
  writeVarint(writer, membership.version);
  writeVarint(writer, membership.members.length);
  for (const member of membership.members) {
    writeUuid(writer, member.clientId);
  }
};
var readMembership = (reader) => {
  const version = readVarint(reader);
  const count = readVarint(reader);
  const clientIds = [];
  for (let index = 0; index < count; index++) {
    clientIds.push(readUuid(reader));
  }
  return buildMembership(version, clientIds);
};
var writeOptionalMembership = (writer, membership) => {
  if (membership === null) {
    writeU8(writer, 0);
    return;
  }
  writeU8(writer, 1);
  writeMembership(writer, membership);
};
var readOptionalMembership = (reader) => {
  const flag = readU8(reader);
  if (flag === 0) return null;
  if (flag === 1) return readMembership(reader);
  throw new Error(`Invalid optional membership flag: ${flag}`);
};
var encodeMembershipMessage = (writer, message) => {
  switch (message.type) {
    case "JOIN_REQUEST":
      writeU8(writer, MEM_JOIN_REQUEST);
      writeUuid(writer, message.clientId);
      break;
    case "JOIN_RESPONSE":
      writeU8(writer, MEM_JOIN_RESPONSE);
      writeMembership(writer, message.membership);
      break;
    case "LEAVE":
      writeU8(writer, MEM_LEAVE);
      writeUuid(writer, message.clientId);
      break;
    case "PREPARE":
      writeU8(writer, MEM_PREPARE);
      writeBallot(writer, message.ballot);
      writeVarint(writer, message.version);
      break;
    case "PROMISE":
      writeU8(writer, MEM_PROMISE);
      writeBallot(writer, message.ballot);
      writeVarint(writer, message.version);
      writeUuid(writer, message.senderId);
      writeOptionalBallot(writer, message.lastAcceptedBallot);
      writeOptionalMembership(writer, message.lastAcceptedMembership);
      break;
    case "ACCEPT":
      writeU8(writer, MEM_ACCEPT);
      writeBallot(writer, message.ballot);
      writeVarint(writer, message.version);
      writeMembership(writer, message.membership);
      break;
    case "ACCEPTED":
      writeU8(writer, MEM_ACCEPTED);
      writeBallot(writer, message.ballot);
      writeVarint(writer, message.version);
      writeUuid(writer, message.peerId);
      break;
    case "COMMIT":
      writeU8(writer, MEM_COMMIT);
      writeVarint(writer, message.version);
      writeMembership(writer, message.membership);
      break;
    case "MEMBERSHIP_REQUEST":
      writeU8(writer, MEM_MEMBERSHIP_REQUEST);
      writeVarint(writer, message.version);
      writeUuid(writer, message.requesterId);
      break;
    case "MEMBERSHIP_RESPONSE":
      writeU8(writer, MEM_MEMBERSHIP_RESPONSE);
      writeVarint(writer, message.version);
      writeMembership(writer, message.membership);
      break;
    case "HEARTBEAT": {
      writeU8(writer, MEM_HEARTBEAT);
      writeUuid(writer, message.clientId);
      writeVarint(writer, message.membershipVersion);
      writeUint53(writer, message.timestamp);
      writeVarint(writer, message.presence.cursor);
      writeUtf8(writer, message.presence.name);
      writeUtf8(writer, message.presence.color);
      const entries = Object.entries(message.sv);
      writeVarint(writer, entries.length);
      for (const [clientId, clock] of entries) {
        writeUuid(writer, clientId);
        writeVarint(writer, clock);
      }
      break;
    }
    default: {
      const _exhaustive = message;
      throw new Error(`Unknown membership message: ${_exhaustive.type}`);
    }
  }
};
var decodeMembershipMessage = (reader) => {
  const tag = readU8(reader);
  switch (tag) {
    case MEM_JOIN_REQUEST:
      return { type: "JOIN_REQUEST", clientId: readUuid(reader) };
    case MEM_JOIN_RESPONSE:
      return { type: "JOIN_RESPONSE", membership: readMembership(reader) };
    case MEM_LEAVE:
      return { type: "LEAVE", clientId: readUuid(reader) };
    case MEM_PREPARE:
      return {
        type: "PREPARE",
        ballot: readBallot(reader),
        version: readVarint(reader)
      };
    case MEM_PROMISE:
      return {
        type: "PROMISE",
        ballot: readBallot(reader),
        version: readVarint(reader),
        senderId: readUuid(reader),
        lastAcceptedBallot: readOptionalBallot(reader),
        lastAcceptedMembership: readOptionalMembership(reader)
      };
    case MEM_ACCEPT:
      return {
        type: "ACCEPT",
        ballot: readBallot(reader),
        version: readVarint(reader),
        membership: readMembership(reader)
      };
    case MEM_ACCEPTED:
      return {
        type: "ACCEPTED",
        ballot: readBallot(reader),
        version: readVarint(reader),
        peerId: readUuid(reader)
      };
    case MEM_COMMIT:
      return {
        type: "COMMIT",
        version: readVarint(reader),
        membership: readMembership(reader)
      };
    case MEM_MEMBERSHIP_REQUEST:
      return {
        type: "MEMBERSHIP_REQUEST",
        version: readVarint(reader),
        requesterId: readUuid(reader)
      };
    case MEM_MEMBERSHIP_RESPONSE:
      return {
        type: "MEMBERSHIP_RESPONSE",
        version: readVarint(reader),
        membership: readMembership(reader)
      };
    case MEM_HEARTBEAT: {
      const clientId = readUuid(reader);
      const membershipVersion = readVarint(reader);
      const timestamp = readUint53(reader);
      const presence = {
        cursor: readVarint(reader),
        name: readUtf8(reader),
        color: readUtf8(reader)
      };
      const count = readVarint(reader);
      const sv = {};
      for (let index = 0; index < count; index++) {
        sv[readUuid(reader)] = readVarint(reader);
      }
      return {
        type: "HEARTBEAT",
        clientId,
        membershipVersion,
        timestamp,
        presence,
        sv
      };
    }
    default:
      throw new Error(`Unknown membership message tag: ${tag}`);
  }
};

// src/codec/operationId.ts
import { ROOT_ID } from "./core.js";
import { unresolvedClientId } from "./sync.js";
var encodeClientId = (writer, clientId, codec) => {
  if (clientId === ROOT_ID[0]) {
    writeU8(writer, OP_ID_ROOT);
    return;
  }
  const shortId = codec.shortIdOf(clientId);
  if (shortId !== null) {
    writeU8(writer, OP_ID_SHORT);
    writeVarint(writer, shortId);
    return;
  }
  writeU8(writer, OP_ID_UUID);
  writeUuid(writer, clientId);
};
var decodeClientId = (reader, membershipVersion, codec) => {
  const tag = readU8(reader);
  if (tag === OP_ID_ROOT) return ROOT_ID[0];
  if (tag === OP_ID_SHORT) {
    const shortId = readVarint(reader);
    return codec.clientIdOf(membershipVersion, shortId) ?? unresolvedClientId(membershipVersion, shortId);
  }
  if (tag === OP_ID_UUID) return readUuid(reader);
  throw new Error(`Unknown client ID tag: ${tag}`);
};
var encodeOperationId = (writer, id, codec) => {
  const [clientId, clock] = id;
  encodeClientId(writer, clientId, codec);
  writeVarint(writer, clock);
};
var decodeOperationId = (reader, membershipVersion, codec) => {
  const clientId = decodeClientId(reader, membershipVersion, codec);
  return [clientId, readVarint(reader)];
};

// src/codec/operation.ts
var encodeOperation = (op, codec = uuidOnlyCodec) => {
  const writer = createWriter();
  if (op.type === "delete") {
    writeU8(writer, OP_DELETE);
    encodeOperationId(writer, op.target, codec);
    return toBytes(writer);
  }
  writeU8(writer, op.rightOrigin === null ? OP_INSERT_NO_RIGHT : OP_INSERT);
  encodeOperationId(writer, op.id, codec);
  writeUtf8(writer, op.value);
  encodeOperationId(writer, op.leftOrigin, codec);
  if (op.rightOrigin !== null) encodeOperationId(writer, op.rightOrigin, codec);
  return toBytes(writer);
};
var decodeOperation = (bytes, membershipVersion = 0, codec = uuidOnlyCodec) => {
  const reader = createReader(bytes);
  const tag = readU8(reader);
  let operation;
  if (tag === OP_DELETE) {
    operation = {
      type: "delete",
      target: decodeOperationId(reader, membershipVersion, codec)
    };
  } else if (tag === OP_INSERT || tag === OP_INSERT_NO_RIGHT) {
    operation = {
      type: "insert",
      id: decodeOperationId(reader, membershipVersion, codec),
      value: readUtf8(reader),
      leftOrigin: decodeOperationId(reader, membershipVersion, codec),
      rightOrigin: tag === OP_INSERT ? decodeOperationId(reader, membershipVersion, codec) : null
    };
  } else {
    throw new Error(`Unknown operation tag: ${tag}`);
  }
  assertFullyRead(reader);
  return operation;
};
var writeOperation = (writer, op, codec) => {
  const bytes = encodeOperation(op, codec);
  writeVarint(writer, bytes.length);
  writeBytes(writer, bytes);
};
var readOperation = (reader, membershipVersion, codec) => decodeOperation(readBytes(reader, readVarint(reader)), membershipVersion, codec);

// src/codec/stateVector.ts
var encodeStateVector = (writer, vector, codec) => {
  writeVarint(writer, vector.size);
  for (const [clientId, clock] of vector) {
    encodeClientId(writer, clientId, codec);
    writeVarint(writer, clock);
  }
};
var decodeStateVector = (reader, membershipVersion, codec) => {
  const vector = /* @__PURE__ */ new Map();
  const count = readVarint(reader);
  for (let index = 0; index < count; index++) {
    const clientId = decodeClientId(reader, membershipVersion, codec);
    vector.set(clientId, readVarint(reader));
  }
  return vector;
};

// src/codec/message.ts
var noteMembershipVersion = (membershipVersion, codec) => {
  if (codec.hasVersion && !codec.hasVersion(membershipVersion)) {
    codec.onMissingVersion?.(membershipVersion);
  }
};
var encodeMessage = (message, codec = uuidOnlyCodec) => {
  const writer = createWriter();
  writeU8(writer, WIRE_VERSION);
  if (message.type === "op") {
    writeU8(writer, MSG_OP);
    writeVarint(writer, codec.encodeVersion());
    const operation = encodeOperation(message.op, codec);
    writeVarint(writer, operation.length);
    writeBytes(writer, operation);
  } else if (message.type === "sync-request") {
    writeU8(writer, MSG_SYNC_REQUEST);
    writeVarint(writer, codec.encodeVersion());
    encodeStateVector(writer, message.vector, codec);
    encodeClientId(writer, message.clientId, codec);
  } else if (message.type === "sync-response") {
    writeU8(writer, MSG_SYNC_RESPONSE);
    writeVarint(writer, codec.encodeVersion());
    writeVarint(writer, message.ops.length);
    for (const operation of message.ops)
      writeOperation(writer, operation, codec);
    writeVarint(writer, message.clientIds.length);
    for (const clientId of message.clientIds) {
      encodeClientId(writer, clientId, codec);
    }
  } else {
    writeU8(writer, MSG_MEMBERSHIP);
    encodeMembershipMessage(writer, message);
  }
  return toBytes(writer);
};
var decodeMessage = (bytes, codec = uuidOnlyCodec) => {
  const reader = createReader(bytes);
  const version = readU8(reader);
  if (version !== WIRE_VERSION) {
    throw new Error(`Unsupported wire version: ${version}`);
  }
  const tag = readU8(reader);
  let message;
  if (tag === MSG_OP) {
    const membershipVersion = readVarint(reader);
    noteMembershipVersion(membershipVersion, codec);
    const operationBytes = readBytes(reader, readVarint(reader));
    message = {
      type: "op",
      op: decodeOperation(operationBytes, membershipVersion, codec)
    };
  } else if (tag === MSG_SYNC_REQUEST) {
    const membershipVersion = readVarint(reader);
    noteMembershipVersion(membershipVersion, codec);
    message = {
      type: "sync-request",
      vector: decodeStateVector(reader, membershipVersion, codec),
      clientId: decodeClientId(reader, membershipVersion, codec)
    };
  } else if (tag === MSG_SYNC_RESPONSE) {
    const membershipVersion = readVarint(reader);
    noteMembershipVersion(membershipVersion, codec);
    const ops = [];
    const operationCount = readVarint(reader);
    for (let index = 0; index < operationCount; index++) {
      ops.push(readOperation(reader, membershipVersion, codec));
    }
    const clientIds = [];
    const clientCount = readVarint(reader);
    for (let index = 0; index < clientCount; index++) {
      clientIds.push(decodeClientId(reader, membershipVersion, codec));
    }
    message = { type: "sync-response", ops, clientIds };
  } else if (tag === MSG_MEMBERSHIP) {
    message = decodeMembershipMessage(reader);
  } else {
    throw new Error(`Unknown message tag: ${tag}`);
  }
  assertFullyRead(reader);
  return message;
};

// src/codec/persistence.ts
import {
  ROOT_ID as ROOT_ID2,
  toKey
} from "./core.js";
var PERSIST_VERSION = 1;
var fromKey = (key) => {
  if (key === toKey(ROOT_ID2)) return ROOT_ID2;
  const sep = key.lastIndexOf(":");
  if (sep <= 0) throw new Error(`Invalid operation key: ${key}`);
  const clock = Number(key.slice(sep + 1));
  if (!Number.isInteger(clock) || clock < 0) {
    throw new Error(`Invalid operation key clock: ${key}`);
  }
  return [key.slice(0, sep), clock];
};
var writeOptionalOperationId = (writer, id) => {
  if (id === null) {
    writeU8(writer, 0);
    return;
  }
  writeU8(writer, 1);
  encodeOperationId(writer, id, uuidOnlyCodec);
};
var readOptionalOperationId = (reader) => {
  const flag = readU8(reader);
  if (flag === 0) return null;
  if (flag === 1) return decodeOperationId(reader, 0, uuidOnlyCodec);
  throw new Error(`Invalid optional operation id flag: ${flag}`);
};
var writeOptionalOperationKey = (writer, key) => {
  if (key === null) {
    writeU8(writer, 0);
    return;
  }
  writeU8(writer, 1);
  encodeOperationId(writer, fromKey(key), uuidOnlyCodec);
};
var readOptionalOperationKey = (reader) => {
  const flag = readU8(reader);
  if (flag === 0) return null;
  if (flag === 1) {
    return toKey(decodeOperationId(reader, 0, uuidOnlyCodec));
  }
  throw new Error(`Invalid optional operation key flag: ${flag}`);
};
var writeStoreNode = (writer, node) => {
  encodeOperationId(writer, node.id, uuidOnlyCodec);
  writeUtf8(writer, node.value);
  writeU8(writer, node.tombstone ? 1 : 0);
  writeOptionalOperationId(writer, node.leftOrigin);
  writeOptionalOperationId(writer, node.rightOrigin);
  writeOptionalOperationKey(writer, node.nextKey);
};
var readStoreNode = (reader) => ({
  id: decodeOperationId(reader, 0, uuidOnlyCodec),
  value: readUtf8(reader),
  tombstone: readU8(reader) === 1,
  leftOrigin: readOptionalOperationId(reader),
  rightOrigin: readOptionalOperationId(reader),
  nextKey: readOptionalOperationKey(reader)
});
var writeSkipListNode = (writer, node) => {
  encodeOperationId(writer, fromKey(node.refCrdtKey), uuidOnlyCodec);
  writeVarint(writer, node.height);
  if (node.nextKeys.length !== node.height || node.span.length !== node.height) {
    throw new Error("Skip list node height does not match nextKeys/span length");
  }
  for (const key of node.nextKeys) writeOptionalOperationKey(writer, key);
  for (const span of node.span) writeVarint(writer, span);
};
var readSkipListNode = (reader) => {
  const refCrdtKey = toKey(decodeOperationId(reader, 0, uuidOnlyCodec));
  const height = readVarint(reader);
  const nextKeys = [];
  for (let index = 0; index < height; index++) {
    nextKeys.push(readOptionalOperationKey(reader));
  }
  const span = [];
  for (let index = 0; index < height; index++) {
    span.push(readVarint(reader));
  }
  return { refCrdtKey, height, nextKeys, span };
};
var encodeDocumentSnapshot = (snapshot) => {
  if (snapshot.version !== 1) {
    throw new Error(`Unsupported snapshot version: ${snapshot.version}`);
  }
  const writer = createWriter();
  writeU8(writer, PERSIST_VERSION);
  writeUuid(writer, snapshot.clientId);
  writeVarint(writer, snapshot.counter);
  writeVarint(writer, snapshot.nodes.length);
  for (const node of snapshot.nodes) writeStoreNode(writer, node);
  writeVarint(writer, snapshot.skipListLength);
  writeVarint(writer, snapshot.skipListNodes.length);
  for (const node of snapshot.skipListNodes) writeSkipListNode(writer, node);
  encodeStateVector(
    writer,
    new Map(Object.entries(snapshot.stateVector)),
    uuidOnlyCodec
  );
  return toBytes(writer);
};
var decodeDocumentSnapshot = (bytes) => {
  const reader = createReader(bytes);
  const version = readU8(reader);
  if (version !== PERSIST_VERSION) {
    throw new Error(`Unsupported persistence version: ${version}`);
  }
  const clientId = readUuid(reader);
  const counter = readVarint(reader);
  const nodeCount = readVarint(reader);
  const nodes = [];
  for (let index = 0; index < nodeCount; index++) {
    nodes.push(readStoreNode(reader));
  }
  const skipListLength = readVarint(reader);
  const skipCount = readVarint(reader);
  const skipListNodes = [];
  for (let index = 0; index < skipCount; index++) {
    skipListNodes.push(readSkipListNode(reader));
  }
  const stateVector = Object.fromEntries(
    decodeStateVector(reader, 0, uuidOnlyCodec)
  );
  assertFullyRead(reader);
  return {
    version: 1,
    clientId,
    counter,
    nodes,
    skipListNodes,
    skipListLength,
    stateVector
  };
};
var encodeDelta = (ops) => {
  const writer = createWriter();
  writeU8(writer, PERSIST_VERSION);
  writeVarint(writer, ops.length);
  for (const op of ops) writeOperation(writer, op, uuidOnlyCodec);
  return toBytes(writer);
};
var decodeDelta = (bytes) => {
  const reader = createReader(bytes);
  const version = readU8(reader);
  if (version !== PERSIST_VERSION) {
    throw new Error(`Unsupported persistence version: ${version}`);
  }
  const count = readVarint(reader);
  const ops = [];
  for (let index = 0; index < count; index++) {
    ops.push(readOperation(reader, 0, uuidOnlyCodec));
  }
  assertFullyRead(reader);
  return ops;
};
var nodeBuffer = globalThis.Buffer;
var bytesToBase64 = (bytes) => {
  if (nodeBuffer) {
    return nodeBuffer.from(bytes).toString("base64");
  }
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};
var base64ToBytes = (value) => {
  if (nodeBuffer) {
    return new Uint8Array(nodeBuffer.from(value, "base64"));
  }
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
};

// src/transport.ts
var createTransport = (raw, options = {}) => {
  const codec = options.idCodec ?? uuidOnlyCodec;
  return {
    connect: raw.connect,
    disconnect: raw.disconnect,
    send(message) {
      raw.send(encodeMessage(message, codec));
    },
    onMessage(cb) {
      return raw.onMessage((data) => cb(decodeMessage(data, codec)));
    },
    onOpen: raw.onOpen,
    onClose: raw.onClose
  };
};

// src/webSocketTransport/WebSocketTransport.ts
var defaultOptions = {
  reconnect: true,
  reconnectMinDelay: 1e3,
  reconnectMaxDelay: 3e4
};
var toUint8Array = (data) => {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  throw new Error("Unsupported WebSocket message type");
};
var createWebSocketTransport = (url, options = {}) => {
  const { reconnect, reconnectMinDelay, reconnectMaxDelay } = {
    ...defaultOptions,
    ...options
  };
  let socket = null;
  let closedIntentionally = false;
  let reconnectAttempt = 0;
  let reconnectTimer;
  const pendingSend = [];
  const messageListeners = /* @__PURE__ */ new Set();
  const openListeners = /* @__PURE__ */ new Set();
  const closeListeners = /* @__PURE__ */ new Set();
  const subscribe = (listeners, cb) => {
    listeners.add(cb);
    return () => {
      listeners.delete(cb);
    };
  };
  const isOpen = () => socket?.readyState === WebSocket.OPEN;
  const flushPending = () => {
    while (pendingSend.length > 0 && isOpen()) {
      socket.send(pendingSend.shift());
    }
  };
  const clearReconnectTimer = () => {
    if (reconnectTimer !== void 0) {
      clearTimeout(reconnectTimer);
      reconnectTimer = void 0;
    }
  };
  const scheduleReconnect = () => {
    if (!reconnect || closedIntentionally) return;
    clearReconnectTimer();
    const delay = Math.min(
      reconnectMinDelay * 2 ** reconnectAttempt,
      reconnectMaxDelay
    );
    reconnectAttempt++;
    reconnectTimer = setTimeout(connectInternal, delay);
  };
  const connectInternal = () => {
    if (socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING) {
      return;
    }
    socket = new WebSocket(url);
    socket.binaryType = "arraybuffer";
    socket.addEventListener("open", () => {
      reconnectAttempt = 0;
      flushPending();
      openListeners.forEach((cb) => cb());
    });
    socket.addEventListener("message", (event) => {
      const data = toUint8Array(event.data);
      messageListeners.forEach((cb) => cb(data));
    });
    socket.addEventListener("close", () => {
      socket = null;
      closeListeners.forEach((cb) => cb());
      scheduleReconnect();
    });
  };
  if (typeof document !== "undefined" && reconnect) {
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && !closedIntentionally && !isOpen() && socket?.readyState !== WebSocket.CONNECTING) {
        reconnectAttempt = 0;
        clearReconnectTimer();
        connectInternal();
      }
    });
  }
  return {
    connect() {
      closedIntentionally = false;
      connectInternal();
    },
    disconnect() {
      closedIntentionally = true;
      clearReconnectTimer();
      pendingSend.length = 0;
      socket?.close();
    },
    send(data) {
      if (isOpen()) {
        socket.send(data);
        return;
      }
      if (closedIntentionally) {
        throw new Error("Transport not connected");
      }
      pendingSend.push(data);
      if (reconnect && !socket && reconnectTimer === void 0) {
        reconnectAttempt = 0;
        connectInternal();
      }
    },
    onMessage(cb) {
      return subscribe(messageListeners, cb);
    },
    onOpen(cb) {
      return subscribe(openListeners, cb);
    },
    onClose(cb) {
      return subscribe(closeListeners, cb);
    }
  };
};
export {
  MEM_ACCEPT,
  MEM_ACCEPTED,
  MEM_COMMIT,
  MEM_HEARTBEAT,
  MEM_JOIN_REQUEST,
  MEM_JOIN_RESPONSE,
  MEM_LEAVE,
  MEM_MEMBERSHIP_REQUEST,
  MEM_MEMBERSHIP_RESPONSE,
  MEM_PREPARE,
  MEM_PROMISE,
  MSG_MEMBERSHIP,
  MSG_OP,
  MSG_SYNC_REQUEST,
  MSG_SYNC_RESPONSE,
  OP_DELETE,
  OP_ID_ROOT,
  OP_ID_SHORT,
  OP_ID_UUID,
  OP_INSERT,
  OP_INSERT_NO_RIGHT,
  PERSIST_VERSION,
  WIRE_VERSION,
  base64ToBytes,
  bytesToBase64,
  createTransport,
  createWebSocketTransport,
  decodeDelta,
  decodeDocumentSnapshot,
  decodeMembershipMessage,
  decodeMessage,
  decodeOperation,
  encodeDelta,
  encodeDocumentSnapshot,
  encodeMembershipMessage,
  encodeMessage,
  encodeOperation,
  isMembershipMessage,
  readVarint,
  uuidOnlyCodec,
  writeVarint
};