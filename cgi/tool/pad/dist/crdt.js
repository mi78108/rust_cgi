// crdt.js — RGA (Replicated Growable Array) 树形 CRDT
//
// 纯数据层，不碰网络、不碰 DOM。所有副本应用同一组 op 后收敛到同一状态。
//
// ─────────────────────────────────────────────────────────────
// 数据结构
//
//   节点: { id: [clientId, seq], v: "字", tomb: bool, left: id|null }
//
//   id = [clientId, seq]，clientId 唯一，seq 在该 client 内单调递增。
//   文档是一棵有序树，ROOT 是虚拟根 (id = ["ROOT", 0])。
//   每个节点记着"我插在谁后面"（left），形成插入树。
//
// ─────────────────────────────────────────────────────────────
// 顺序怎么定（收敛的核心）
//
// RGA 的经典做法：每个节点维护一个 next 指针链，
// 插入时在链上找位置。链的顺序由"锚点 + 兄弟排序"共同决定。
//
// 这里用**层序 (level order)** 渲染 —— 比链式更简单且一样收敛：
//
//   1. 文档的可见顺序 = 对 ROOT 的子树做"按 anchor 分组 + 组内按 id 排序"
//   2. 每个节点的子节点（anchor == 自己）按 id 字典序排
//   3. 兄弟节点之间还要跟"更深的后代"交错 —— 这是 RGA 的难点
//
// 简化方案（仍然收敛，代价是极端交错场景下顺序与"直觉"不同）：
//   visible(node) = node.v + 依次拼接 visible(child) 按 id 排序
//   顶层：按 ROOT 的子节点 id 排序依次拼
//
//   两个客户端同时在锚点 L 后插入 A、B → 两者都是 L 的子节点
//   → 按 id 字典序排 → 两边顺序一致 ✅
//
//   若 A 插入后又在其后插入 A2（A2 的 anchor 是 A），
//   则 A2 是 A 的子节点，渲染时紧跟 A → 与"A2 插在 A 后面"的直觉一致 ✅
//
// ─────────────────────────────────────────────────────────────
// 墓碑 (tombstone)
//
// 删除只打墓碑，不真删。因为并发场景下：
//   客户端 1 删了 X，客户端 2 还没收到这条时又在 X 后面插了 Y。
//   如果真删 X，Y 会挂到 X 的父节点上 → 内容复活/错位。
//   墓碑保证位置不变，只是文本不显示。
//
// ─────────────────────────────────────────────────────────────

export const ROOT_ID = ['ROOT', 0];

/** id 全序比较：先 clientId 字典序，再 seq。
 *  必须对任意两个不同 id 都能分出大小，否则收敛会破。 */
export function compareId(a, b) {
  if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
  if (a[1] !== b[1]) return a[1] < b[1] ? -1 : 1;
  return 0;
}

export function idKey(id) {
  return id[0] + ':' + id[1];
}

export function sameId(a, b) {
  return !!a && !!b && a[0] === b[0] && a[1] === b[1];
}

// ─────────────────────────────────────────────────────────────
// Doc
// ─────────────────────────────────────────────────────────────

export class Doc {
  constructor() {
    /** @type {Map<string, object>} idKey → node */
    this.nodes = new Map();
    this.nodes.set(idKey(ROOT_ID), {
      id: ROOT_ID, v: '', tomb: false, left: null,
    });
    /** 已应用过的 op id —— 幂等 */
    this.applied = new Set();
    /** anchor 还没到的 insert op —— 等依赖到了再应用 */
    this.pending = new Map();
    /** op 应用回调 */
    this.onApply = null;
  }

  // ── 查询 ────────────────────────────────────────────────

  get(id) {
    return this.nodes.get(idKey(id)) || null;
  }

  /** 某个 anchor 下的直接子节点（含墓碑），按 id 排序 */
  childrenOf(id) {
    const out = [];
    const key = idKey(id);
    for (const n of this.nodes.values()) {
      if (n.left && idKey(n.left) === key) out.push(n);
    }
    out.sort((a, b) => compareId(a.id, b.id));
    return out;
  }

  /** 可见文本 */
  getText() {
    let out = '';
    for (const node of this.childrenOf(ROOT_ID)) {
      out += this.visibleOf(node);
    }
    return out;
  }

  /** 一个节点的可见文本（自己 + 子树） */
  visibleOf(node) {
    let out = node.tomb ? '' : node.v;
    for (const child of this.childrenOf(node.id)) {
      out += this.visibleOf(child);
    }
    return out;
  }

  /**
   * 可见文本 → 每字符对应的节点。
   * 返回 [{ ch, node }]，用于把光标位置换算成 CRDT 锚点。
   */
  textIndex() {
    const list = [];
    const walk = (node) => {
      if (!node.tomb) {
        for (const ch of node.v) list.push({ ch, node });
      }
      for (const child of this.childrenOf(node.id)) walk(child);
    };
    for (const node of this.childrenOf(ROOT_ID)) walk(node);
    return list;
  }

  /**
   * 插入位置 → anchor（"插在谁后面"）。
   *   pos = 0 → ROOT
   *   pos = n → 第 n 个字符所在节点（插在它后面）
   */
  anchorAt(pos) {
    const list = this.textIndex();
    if (pos <= 0) return ROOT_ID;
    if (pos > list.length) {
      return list.length ? list[list.length - 1].node.id : ROOT_ID;
    }
    return list[pos - 1].node.id;
  }

  /** [start, start+len) 区间的字符分别属于哪些节点（去重，保持顺序） */
  nodesInRange(start, len) {
    const list = this.textIndex();
    const out = [];
    const seen = new Set();
    for (let i = start; i < start + len && i < list.length; i++) {
      const n = list[i].node;
      const k = idKey(n.id);
      if (!seen.has(k)) { seen.add(k); out.push(n); }
    }
    return out;
  }

  // ── 应用 op ──────────────────────────────────────────────

  /**
   * 应用 op。幂等。
   * @returns {boolean} 是否真的应用了
   */
  apply(op) {
    if (!op || !op.id) return false;
    // 幂等键要带上 op 类型 ——
    // 插入 op 和删除 op 指向同一个节点 id，但它们是两个不同的操作，
    // 不能共用一个幂等键（否则删除会被当成"已应用"而丢掉）。
    const key = op.t + ':' + idKey(op.id);
    if (this.applied.has(key)) return false;

    let ok = false;
    if (op.t === 'i') {
      ok = this.applyInsert(op);
      if (!ok && !this.get(op.id)) {
        // anchor 还没到 → 挂起等依赖，别丢
        this.pending.set('i:' + idKey(op.id), op);
        return false;
      }
    } else if (op.t === 'd') {
      ok = this.applyDelete(op);
      if (!ok) {
        // 被删的节点还没到 → 挂起
        this.pending.set('d:' + idKey(op.id), op);
        return false;
      }
    }

    if (!ok) return false;
    this.applied.add(key);
    if (this.onApply) this.onApply(op);
    this.drainPending();
    return true;
  }

  /**
   * 依赖未满足的 op 先进 pending，等 anchor 到了再重试。
   * 没有这一步的话，乱序送达会让 op 永久丢失 → 副本发散。
   */
  drainPending() {
    if (!this.pending.size) return;
    // 反复尝试，直到没有新进展（anchor 可能多级依赖）
    for (let round = 0; round < 100; round++) {
      let progress = false;
      for (const [key, op] of this.pending) {
        const ok = op.t === 'i' ? this.applyInsert(op) : this.applyDelete(op);
        if (ok) {
          this.pending.delete(key);
          this.applied.add(op.t + ':' + idKey(op.id));
          if (this.onApply) this.onApply(op);
          progress = true;
        }
      }
      if (!progress) break;
    }
  }

  applyInsert(op) {
    if (!this.get(op.l)) return false;      // anchor 还没到 → 等
    if (this.get(op.id)) return false;      // 已存在
    this.nodes.set(idKey(op.id), {
      id: op.id,
      v: op.v ?? '',
      tomb: false,
      left: op.l,
    });
    return true;
  }

  applyDelete(op) {
    const node = this.get(op.id);
    if (!node) return false;
    node.tomb = true;
    return true;
  }

  // ── 序列化 ──────────────────────────────────────────────

  /** 导出全部 op（快照 / 发给新客户端） */
  toOps() {
    const out = [];
    const seen = new Set();
    for (const node of this.nodes.values()) {
      if (sameId(node.id, ROOT_ID)) continue;
      if (node.tomb) {
        out.push({ t: 'd', id: node.id });
      } else {
        out.push({ t: 'i', id: node.id, v: node.v, l: node.left });
      }
      seen.add('i:' + idKey(node.id));
    }
    // 挂起中的 op 也要带上 —— 否则新客户端拿到的快照缺东西
    for (const [key, op] of this.pending) {
      if (!seen.has(key)) out.push(op);
    }
    // 按插入依赖排序：anchor 必须先于使用者
    out.sort((a, b) => {
      if (a.t === 'i' && b.t === 'i') {
        // anchor 在前的先
        const ak = idKey(a.l), bk = idKey(b.l);
        if (ak !== bk) {
          const aHasB = this.isDescendantOf(b.id, a.id);
          const bHasA = this.isDescendantOf(a.id, b.id);
          if (aHasB) return 1;
          if (bHasA) return -1;
        }
        return compareId(a.id, b.id);
      }
      return a.t === 'i' ? -1 : 1;
    });
    return out;
  }

  /** candidate 是否是 ancestor 的后代 */
  isDescendantOf(candidate, ancestor) {
    if (!candidate || !ancestor) return false;
    if (sameId(candidate, ancestor)) return true;
    let cur = this.get(candidate);
    let guard = 0;
    while (cur && cur.left && guard++ < 100000) {
      if (sameId(cur.left, ancestor)) return true;
      cur = this.get(cur.left);
    }
    return false;
  }
}

// ─────────────────────────────────────────────────────────────
// 光标位置变换
// ─────────────────────────────────────────────────────────────

/**
 * 远端 op 应用后，本地光标要跟着挪，否则打字会插错位置。
 *
 * @param {number} pos    本地光标位置
 * @param {number} start  变更起点
 * @param {number} len    >0 = 删除了 len 个字符；<0 = 插入了 -len 个字符
 */
export function transformPosition(pos, start, len) {
  if (len < 0) {
    const k = -len;
    return pos >= start ? pos + k : pos;
  }
  if (len > 0) {
    if (pos <= start) return pos;
    if (pos >= start + len) return pos - len;
    return start;
  }
  return pos;
}
