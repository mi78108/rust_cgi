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
    /**
     * anchorKey → 它的直接子节点数组（未排序）
     *
     * ★ 索引 —— 没有它 childrenOf() 每次都要扫全表 this.nodes，
     *   而 textIndex() 会对每个节点调一次 childrenOf() →
     *   一次 textIndex() 就是 O(n²)。粘贴几 KB 文本会卡死。
     *
     *   有了索引: childrenOf() O(1) 拿到数组（排序另算），
     *   textIndex() 变成 O(n)。
     *
     * @type {Map<string, object[]>}
     */
    this.children = new Map();
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

  /**
   * 某个 anchor 下的直接子节点（含墓碑），按 id **逆序**排列。
   *
   * 为什么是逆序？
   *
   * RGA 的标准语义是"next 链"：插到节点 N 之后 = 插在 N 的**原有后继之前**。
   * 这里用"anchor + 同层排序"来模拟 next 链 —— anchor 是 N，新节点就是 N 的
   * 子节点，跟 N 原有的子节点平级。
   *
   * 要表达"新插的排在前"，同层就必须**逆序**排（后到的 id 大的排前面）。
   * 正序的话，新节点会排到原有子节点**后面** → 插在中间却跑到了末尾。
   *
   *   已有 "AB"，在 A 和 B 之间插 X：
   *     anchor = A，X 与 B 都是 A 的子节点
   *     逆序: X(seq2) 在 B(seq1) 前 → "AXB"  ✓
   *     正序: B 在 X 前             → "ABX"  ✗
   *
   * 链式输入不受影响（"abc" 每个字符 anchor 指向前一个，是父子链不是兄弟）：
   *   a(anchor=ROOT) → b(anchor=a) → c(anchor=b) → 渲染仍是 "abc" ✓
   *
   * 并发收敛也不受影响 —— 逆序只是换了一种确定性的 tie-break 约定
   * （并发同锚插入时正序得 "ab"，逆序得 "ba"，两边一致即可）。
   */
  childrenOf(id) {
    const key = idKey(id);
    const list = this.children.get(key);
    if (!list) return [];
    // 逆序排 —— 但数组通常已经是"后加的在后面"，所以倒着读就是逆序，
    // 不用每次都 sort（sort 是 O(k log k)，粘贴时每个节点都调一次）。
    //
    // ★ 前提: 同一 anchor 下的节点 id 严格递增（后加的 id 更大）。
    //   单个客户端的 seq 单调递增 ✓；跨客户端并发插入时 id 可能不是单调的，
    //   那种情况退化成真排序 —— 见下面的判断。
    if (this._sortedChildren === false) {
      return list.slice().sort((a, b) => compareId(b.id, a.id));
    }
    return list.slice().reverse();
  }

  /** 登记一个新节点到它 anchor 的子节点列表 */
  _addChild(node) {
    if (!node.left) return;
    const key = idKey(node.left);
    let list = this.children.get(key);
    if (!list) {
      list = [];
      this.children.set(key, list);
    }
    // 追加到末尾 —— 同一 anchor 下后加的 id 更大, 倒着读就是正确的逆序。
    //
    // 但跨客户端并发插入时 id 不保证单调 —— 那时列表不再单调,
    // 标记 _sortedChildren=false 让 childrenOf 退化成真排序。
    const last = list[list.length - 1];
    if (last && compareId(node.id, last.id) < 0) {
      this._sortedChildren = false;
    }
    list.push(node);
  }

  /** 可见文本 */
  getText() {
    let out = '';
    for (const node of this.childrenOf(ROOT_ID)) {
      out += this.visibleOf(node);
    }
    return out;
  }

  /**
   * 一个节点的可见文本（自己 + 子树）。
   *
   * ★ 用显式栈迭代，不用递归 ——
   *   链式输入（每个字符 anchor 指向前一个）会形成 N 层深的树，
   *   递归深度 = 树深。JS 引擎递归上限约 1 万层（实测 node 爆栈在 12518 帧），
   *   所以一个 2 万字的文档 getText() 就直接 RangeError。
   *   迭代版本没有深度上限。
   */
  visibleOf(node) {
    let out = '';
    // 栈里存"待展开的子节点列表"，每个元素是一个 children 数组 + 游标。
    const stack = [{ list: this.childrenOf(node.id), i: 0 }];
    // 根节点自己的文本先输出
    if (!node.tomb) out += node.v;
    while (stack.length) {
      const top = stack[stack.length - 1];
      if (top.i >= top.list.length) { stack.pop(); continue; }
      const child = top.list[top.i++];
      if (!child.tomb) out += child.v;
      // 把这个节点的孩子压栈 —— 先压的先处理，保证深度优先 + 同层顺序
      stack.push({ list: this.childrenOf(child.id), i: 0 });
    }
    return out;
  }

  /**
   * 可见文本 → 每字符对应的节点。
   * 返回 [{ ch, node }]，用于把光标位置换算成 CRDT 锚点。
   *
   * ★ 同样用显式栈迭代（理由同 visibleOf）——
   *   而且它跟 getText() 走的是**同一套遍历**，
   *   保证"渲染出来的文本"和"光标换算用的索引"永远一致。
   *
   * ★ 每个**节点**一项（不是每个 UTF-16 code unit）。
   *   一个节点的 v 可能是多个 code unit（比如 emoji 是代理对 = 2 个 unit），
   *   所以这里用 `for (const ch of node.v)` 按 code point 展开。
   *
   * ★ 由此带来的单位不一致（下面 anchorAt 处理）：
   *     textIndex() 的下标 = code point 序号
   *     ta.selectionStart  = UTF-16 code unit 序号
   *     有 emoji 时两者不等（比如 "a中😀b" → 4 vs 5）。
   */
  textIndex() {
    const list = [];
    const stack = [{ list: this.childrenOf(ROOT_ID), i: 0 }];
    while (stack.length) {
      const top = stack[stack.length - 1];
      if (top.i >= top.list.length) { stack.pop(); continue; }
      const node = top.list[top.i++];
      if (!node.tomb) {
        for (const ch of node.v) list.push({ ch, node });
      }
      stack.push({ list: this.childrenOf(node.id), i: 0 });
    }
    return list;
  }

  /**
   * 插入位置 → anchor（"插在谁后面"）。
   *   pos = 0 → ROOT
   *   pos = n → 第 n 个字符所在节点（插在它后面）
   *
   * ★ **pos 的单位是 UTF-16 code unit** —— 因为它来自
   *   `ta.selectionStart`（浏览器 API 就是这个单位）。
   *
   *   但 textIndex() 返回的是**按 code point 展开**的列表，两者单位不同：
   *   "a中😀b" → textIndex 4 项，JS 字符串 length 5（emoji 占 2 个 unit）。
   *
   *   直接用 list[pos-1] 会错位：pos=3（emoji 代理对中间）时
   *   list[2] 是 emoji 自己 → 插到 emoji 后面（应该是 emoji 前面）。
   *
   *   所以这里不能按 code point 序号取，要按**累计的 UTF-16 长度**定位。
   */
  anchorAt(pos) {
    const list = this.textIndex();
    if (pos <= 0) return ROOT_ID;

    // 累加 UTF-16 长度，找到 pos 落在哪个 code point 上
    let units = 0;
    let prevId = null;               // 上一个字符的**节点 id**（不是节点对象）
    for (const item of list) {
      const next = units + item.ch.length;   // ch.length 是 UTF-16 unit 数
      if (pos <= next) {
        // pos 落在这个字符的范围内
        //   pos == next  → 光标在这个字符**之后** → anchor = 它自己
        //   pos <  next  → 光标在这个字符**中间**（只可能是代理对）
        //                  → 应该在它**前面** → anchor = 上一个字符
        return pos === next ? item.node.id : (prevId || ROOT_ID);
      }
      units = next;
      prevId = item.node.id;
    }

    // pos 超出末尾 → anchor = 最后一个字符
    return list.length ? list[list.length - 1].node.id : ROOT_ID;
  }

  /**
   * [start, start+len) 区间的字符分别属于哪些节点（去重，保持顺序）
   *
   * ★ start / len 的单位也是 UTF-16 code unit（来自 selectionStart/End）。
   */
  nodesInRange(start, len) {
    const list = this.textIndex();
    const out = [];
    const seen = new Set();
    const end = start + len;
    let units = 0;
    for (const item of list) {
      const next = units + item.ch.length;
      // 与 [start, end) 有交集 → 这个字符被选中
      if (next > start && units < end) {
        const k = idKey(item.node.id);
        if (!seen.has(k)) { seen.add(k); out.push(item.node); }
      }
      units = next;
      if (units >= end) break;
    }
    return out;
  }

  /**
   * 节点 id → 当前可见偏移（UTF-16 code unit）。
   *
   * ★ 这是 anchorAt() 的**逆运算** —— 用于把「远端上报的光标锚点」
   *   换算成「本地文档里的位置」。
   *
   * 为什么需要它：光标位置如果只用**数字偏移**表示，那么别人在
   * 你光标**前面**插入一个字符，你的偏移就得 +1 —— 但那个数字
   *   是「别人的文档」里的数字，跟你的文档对不上，光标就会漂移。
   *
   *   用**节点 id**（CRDT 字符身份）表示就沒这个问题 ——
   *   节点 id 是全局唯一的，插删都不影响它。
   *
   * @param {string|Array} nodeId  节点 id（[clientId, seq] 或其字符串形式）
   * @returns {number} 偏移；节点不存在（被删/没见过）返回 -1
   */
  offsetOfNode(nodeId) {
    if (!nodeId) return -1;
    // nodeId 可能是数组 [clientId, seq]（JSON 传输后仍是数组），
    // 也可能是 "clientId:seq" 字符串形式 —— 两种都支持。
    const key = Array.isArray(nodeId) ? idKey(nodeId) : String(nodeId);
    const list = this.textIndex();
    let units = 0;
    for (const item of list) {
      // 光标在「这个字符之前」→ 它的偏移就是当前累计长度
      if (idKey(item.node.id) === key) return units;
      units += item.ch.length;
    }
    return -1;
  }

  /**
   * 节点 id → 光标位置（该字符**之后**的偏移）。
   *
   * ★ **这才是 anchorAt() 的真正逆运算**。
   *
   *   anchorAt(pos)  返回「光标前面那个字符」的节点 id ——
   *                  光标是**紧跟在那个字符后面**的。
   *   offsetOfNode(id) 返回那个字符的**起始**偏移（字符自己占的那一格）。
   *
   *   所以 offsetOfNode(anchorAt(pos)) = pos - 1（字符宽度）——
   *   **偏左一个字符**！用 anchor 还原光标位置必须用这个方法。
   *
   *   实测（"ABCDE\nFGHIJ"，光标 offset 8）：
   *     anchorAt(8)          = ["c1", 7]
   *     offsetOfNode(...)    = 7    ← 偏左一个字符（错）
   *     cursorOffsetOfNode() = 8    ← 正确
   *
   * @param {string|Array} nodeId 节点 id（[clientId, seq] 或其字符串形式）
   * @returns {number} 光标偏移；节点不存在返回 -1
   */
  cursorOffsetOfNode(nodeId) {
    if (!nodeId) return -1;
    const key = Array.isArray(nodeId) ? idKey(nodeId) : String(nodeId);
    // ROOT —— 光标在文档最开头（anchorAt(0) 的返回值）
    if (key === idKey(ROOT_ID)) return 0;
    const list = this.textIndex();
    let units = 0;
    for (const item of list) {
      // 光标在这个字符**之后** → 偏移 = 累计长度 + 这个字符的宽度
      if (idKey(item.node.id) === key) return units + item.ch.length;
      units += item.ch.length;
    }
    return -1;
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
    const node = {
      id: op.id,
      v: op.v ?? '',
      tomb: false,
      left: op.l,
    };
    this.nodes.set(idKey(op.id), node);
    // ★ 登记到 anchor 的子节点索引 —— 少了这行 childrenOf() 恒为空，
    //   整个文档渲染成空白（nodes 有数据但索引没数据）。
    this._addChild(node);
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
