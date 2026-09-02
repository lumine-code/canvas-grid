const { clamp, normalizeInteger } = require("./grid-utils");

/** Variable-size axis geometry backed by a Fenwick prefix-sum tree. */
class AxisMetrics {
  constructor({ count = 0, defaultSize = 0, sizes = [] } = {}) {
    this.defaultSize = this.normalizeSize(defaultSize);
    this.overrides = new Array(normalizeInteger(count, 0));
    for (let index = 0; index < this.overrides.length; index++) {
      const size = sizes[index];
      if (size != null) this.overrides[index] = this.normalizeSize(size);
    }
    this.rebuild();
  }

  normalizeSize(size) {
    const value = Number(size);
    return Number.isFinite(value) ? Math.max(0, value) : 0;
  }

  get count() {
    return this.overrides.length;
  }

  sizeAt(index) {
    if (index < 0 || index >= this.count) return 0;
    return this.overrides[index] ?? this.defaultSize;
  }

  setSize(index, size) {
    if (index < 0 || index >= this.count) return false;
    const oldSize = this.sizeAt(index);
    this.overrides[index] = size == null ? undefined : this.normalizeSize(size);
    const delta = this.sizeAt(index) - oldSize;
    for (
      let treeIndex = index + 1;
      treeIndex < this.tree.length;
      treeIndex += treeIndex & -treeIndex
    ) {
      this.tree[treeIndex] += delta;
    }
    return delta !== 0;
  }

  setDefaultSize(size) {
    const value = this.normalizeSize(size);
    if (value === this.defaultSize) return false;
    this.defaultSize = value;
    this.rebuild();
    return true;
  }

  setItems(count, sizes = []) {
    this.overrides = new Array(normalizeInteger(count, 0));
    for (let index = 0; index < this.count; index++) {
      if (sizes[index] != null)
        this.overrides[index] = this.normalizeSize(sizes[index]);
    }
    this.rebuild();
  }

  insert(index, count = 1, sizes = []) {
    const start = clamp(normalizeInteger(index, this.count), 0, this.count);
    const amount = normalizeInteger(count, 1, 1);
    const inserted = Array.from({ length: amount }, (_, offset) => {
      const size = sizes[offset];
      return size == null ? undefined : this.normalizeSize(size);
    });
    this.overrides.splice(start, 0, ...inserted);
    this.rebuild();
  }

  delete(index, count = 1) {
    if (!this.count) return [];
    const start = clamp(normalizeInteger(index, 0), 0, this.count);
    const removed = this.overrides.splice(start, normalizeInteger(count, 1, 1));
    this.rebuild();
    return removed;
  }

  reorder(indices) {
    if (!Array.isArray(indices) || indices.length !== this.count) {
      throw new RangeError(
        "AxisMetrics reorder must contain one index per item",
      );
    }
    const previous = this.overrides;
    this.overrides = indices.map((index) => previous[index]);
    this.rebuild();
  }

  offsetAt(index) {
    let cursor = clamp(normalizeInteger(index, 0), 0, this.count);
    let sum = 0;
    while (cursor > 0) {
      sum += this.tree[cursor];
      cursor -= cursor & -cursor;
    }
    return sum;
  }

  indexAt(offset) {
    if (!this.count) return -1;
    const target = clamp(Number(offset) || 0, 0, this.totalSize);
    let index = 0;
    let sum = 0;
    let bit = 1;
    while (bit << 1 <= this.count) bit <<= 1;
    for (; bit !== 0; bit >>= 1) {
      const next = index + bit;
      if (next <= this.count && sum + this.tree[next] <= target) {
        index = next;
        sum += this.tree[next];
      }
    }
    return Math.min(index, this.count - 1);
  }

  get totalSize() {
    return this.offsetAt(this.count);
  }

  toArray() {
    return this.overrides.slice();
  }

  rebuild() {
    this.tree = new Float64Array(this.count + 1);
    for (let treeIndex = 1; treeIndex < this.tree.length; treeIndex++) {
      this.tree[treeIndex] += this.sizeAt(treeIndex - 1);
      const parent = treeIndex + (treeIndex & -treeIndex);
      if (parent < this.tree.length) this.tree[parent] += this.tree[treeIndex];
    }
  }
}

module.exports = AxisMetrics;
