const DEFAULT_PAGE_SIZE = 200;
const MAX_CACHED_PAGES = 3;
const SAMPLE_ROWS = 200;
const MIN_COLUMN_WIDTH = 48;
const MAX_COLUMN_WIDTH = 480;
const MIN_RESIZED_COLUMN_WIDTH = 24;
const RESIZE_GRIP = 4;
const CELL_PADDING_X = 8;
const MAX_SCROLL_HEIGHT = 10_000_000;
const MAX_COPY_CELLS = 100_000;
const MAX_COPY_BYTES = 16 * 1024 * 1024;
const MAX_FIT_CACHE = 512;

let nextGridId = 1;

function clamp(value, minimum, maximum) {
  return Math.min(Math.max(value, minimum), maximum);
}

function normalizeInteger(value, fallback, minimum = 0) {
  const number = Number(value);
  return Number.isFinite(number)
    ? Math.max(minimum, Math.floor(number))
    : fallback;
}

function normalizeNullableCount(value) {
  return value == null ? null : normalizeInteger(value, 0);
}

function isAbortError(error) {
  return error?.name === "AbortError" || error?.code === "ABORT_ERR";
}

function disposable(callback) {
  return { dispose: callback };
}

function setHiddenAccessibleStyle(element) {
  Object.assign(element.style, {
    position: "absolute",
    width: "1px",
    height: "1px",
    padding: "0",
    margin: "-1px",
    overflow: "hidden",
    clip: "rect(0, 0, 0, 0)",
    clipPath: "inset(50%)",
    whiteSpace: "nowrap",
    border: "0",
  });
}

function formatCell(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(value)) {
    return `[BLOB ${value.length} bytes]`;
  }
  if (value instanceof Uint8Array) return `[BLOB ${value.byteLength} bytes]`;
  return String(value);
}

function utf8ByteLength(value) {
  const text = String(value);
  if (typeof Buffer !== "undefined") return Buffer.byteLength(text, "utf8");
  return new TextEncoder().encode(text).byteLength;
}

function normalizeColumns(columns) {
  return (Array.isArray(columns) ? columns : []).map((column, index) => {
    if (typeof column === "string") {
      return {
        key: index,
        label: column,
        index,
        width: null,
        align: "left",
        formatCell: null,
        paintCell: null,
      };
    }
    const value = column || {};
    return {
      key: value.key ?? index,
      label: String(value.label ?? value.name ?? value.key ?? index + 1),
      index,
      width: Number.isFinite(value.width)
        ? Math.max(MIN_RESIZED_COLUMN_WIDTH, value.width)
        : null,
      align: ["left", "center", "right"].includes(value.align)
        ? value.align
        : "left",
      formatCell:
        typeof value.formatCell === "function"
          ? value.formatCell
          : typeof value.format === "function"
            ? value.format
            : null,
      paintCell: typeof value.paintCell === "function" ? value.paintCell : null,
      sortDirection:
        value.sortDirection === 1 || value.sortDirection === -1
          ? value.sortDirection
          : null,
    };
  });
}

function rowValue(row, column) {
  if (row == null) return undefined;
  return Array.isArray(row) ? row[column.index] : row[column.key];
}

function lowerBound(values, target) {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (values[middle] < target) low = middle + 1;
    else high = middle;
  }
  return low;
}

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

/** A generation-safe, three-page cache around an offset/limit row loader. */
class PagedRowCache {
  constructor({
    fetchRows,
    rowCount = 0,
    pageSize = DEFAULT_PAGE_SIZE,
    onDidChange,
    onDidError,
  } = {}) {
    this.fetchRows = fetchRows;
    this.rowCount = normalizeInteger(rowCount, 0);
    this.pageSize = normalizeInteger(pageSize, DEFAULT_PAGE_SIZE, 1);
    this.onDidChange = onDidChange;
    this.onDidError = onDidError;
    this.entries = new Map();
    this.generation = 0;
    this.clock = 0;
    this.destroyed = false;
  }

  get size() {
    return this.entries.size;
  }

  get loading() {
    for (const entry of this.entries.values()) {
      if (entry.status === "loading") return true;
    }
    return false;
  }

  configure({
    fetchRows = this.fetchRows,
    rowCount = this.rowCount,
    pageSize = this.pageSize,
  } = {}) {
    const nextPageSize = normalizeInteger(pageSize, DEFAULT_PAGE_SIZE, 1);
    const changed =
      fetchRows !== this.fetchRows || nextPageSize !== this.pageSize;
    this.fetchRows = fetchRows;
    this.rowCount = normalizeInteger(rowCount, 0);
    this.pageSize = nextPageSize;
    if (changed) this.clear();
    else this.trimToRowCount();
  }

  trimToRowCount() {
    const lastPage =
      this.rowCount > 0 ? Math.floor((this.rowCount - 1) / this.pageSize) : -1;
    for (const pageIndex of Array.from(this.entries.keys())) {
      if (pageIndex > lastPage) this.deletePage(pageIndex);
    }
  }

  clear() {
    this.generation++;
    for (const pageIndex of Array.from(this.entries.keys()))
      this.deletePage(pageIndex);
    this.onDidChange?.();
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.clear();
  }

  deletePage(pageIndex) {
    const entry = this.entries.get(pageIndex);
    if (!entry) return;
    entry.controller?.abort();
    this.entries.delete(pageIndex);
  }

  pageForRow(rowIndex) {
    return Math.floor(rowIndex / this.pageSize);
  }

  stateForRow(rowIndex) {
    if (rowIndex < 0 || rowIndex >= this.rowCount)
      return { status: "missing", row: undefined };
    const pageIndex = this.pageForRow(rowIndex);
    const entry = this.entries.get(pageIndex);
    if (!entry) return { status: "missing", row: undefined };
    entry.lastUsed = ++this.clock;
    if (entry.status !== "loaded")
      return { status: entry.status, row: undefined, error: entry.error };
    return {
      status: "loaded",
      row: entry.rows[rowIndex - pageIndex * this.pageSize],
    };
  }

  loadedRows(limit = SAMPLE_ROWS) {
    const rows = [];
    for (const pageIndex of Array.from(this.entries.keys()).sort(
      (left, right) => left - right,
    )) {
      const entry = this.entries.get(pageIndex);
      if (entry?.status !== "loaded") continue;
      for (const row of entry.rows) {
        rows.push(row);
        if (rows.length >= limit) return rows;
      }
    }
    return rows;
  }

  retainPages(pageIndexes) {
    if (this.destroyed) return Promise.resolve([]);
    const maxPage =
      this.rowCount > 0 ? Math.floor((this.rowCount - 1) / this.pageSize) : -1;
    const wanted = [];
    for (const value of pageIndexes || []) {
      const pageIndex = normalizeInteger(value, -1, -1);
      if (pageIndex < 0 || pageIndex > maxPage || wanted.includes(pageIndex))
        continue;
      wanted.push(pageIndex);
      if (wanted.length === MAX_CACHED_PAGES) break;
    }
    const wantedSet = new Set(wanted);
    for (const pageIndex of Array.from(this.entries.keys())) {
      if (!wantedSet.has(pageIndex)) this.deletePage(pageIndex);
    }
    return Promise.all(wanted.map((pageIndex) => this.loadPage(pageIndex)));
  }

  evictOne(exceptPage) {
    let candidate = null;
    for (const [pageIndex, entry] of this.entries) {
      if (pageIndex === exceptPage) continue;
      if (!candidate || entry.lastUsed < candidate.entry.lastUsed)
        candidate = { pageIndex, entry };
    }
    if (candidate) this.deletePage(candidate.pageIndex);
  }

  loadPage(pageIndex) {
    if (this.destroyed || pageIndex < 0 || !this.fetchRows)
      return Promise.resolve([]);
    const existing = this.entries.get(pageIndex);
    if (existing) {
      existing.lastUsed = ++this.clock;
      return existing.promise || Promise.resolve(existing.rows || []);
    }
    while (this.entries.size >= MAX_CACHED_PAGES) this.evictOne(pageIndex);

    const offset = pageIndex * this.pageSize;
    if (offset >= this.rowCount) return Promise.resolve([]);
    const limit = Math.min(this.pageSize, this.rowCount - offset);
    const controller = new AbortController();
    const generation = this.generation;
    const entry = {
      status: "loading",
      rows: null,
      error: null,
      controller,
      lastUsed: ++this.clock,
      promise: null,
    };
    this.entries.set(pageIndex, entry);
    this.onDidChange?.();

    entry.promise = Promise.resolve()
      .then(() =>
        this.fetchRows({ offset, limit, pageIndex, signal: controller.signal }),
      )
      .then((result) => {
        const current = this.entries.get(pageIndex);
        if (
          this.destroyed ||
          generation !== this.generation ||
          current !== entry
        )
          return [];
        const rows = Array.isArray(result) ? result : result?.rows;
        if (!Array.isArray(rows))
          throw new TypeError(
            "fetchRows must resolve to an array or {rows: array}",
          );
        entry.status = "loaded";
        entry.rows = rows.slice(0, limit);
        entry.promise = null;
        entry.controller = null;
        this.onDidChange?.();
        return entry.rows;
      })
      .catch((error) => {
        const current = this.entries.get(pageIndex);
        if (
          this.destroyed ||
          generation !== this.generation ||
          current !== entry
        )
          return [];
        if (isAbortError(error) || controller.signal.aborted) {
          this.entries.delete(pageIndex);
          this.onDidChange?.();
          return [];
        }
        entry.status = "error";
        entry.rows = [];
        entry.error = error;
        entry.promise = null;
        entry.controller = null;
        this.onDidError?.(error, { offset, limit, pageIndex });
        this.onDidChange?.();
        return [];
      });
    return entry.promise;
  }

  async row(rowIndex) {
    if (rowIndex < 0 || rowIndex >= this.rowCount) return undefined;
    const pageIndex = this.pageForRow(rowIndex);
    await this.loadPage(pageIndex);
    const state = this.stateForRow(rowIndex);
    if (state.status === "error") throw state.error;
    return state.row;
  }

  whenIdle() {
    const promises = [];
    for (const entry of this.entries.values()) {
      if (entry.promise) promises.push(entry.promise);
    }
    return Promise.all(promises);
  }
}

class CanvasGrid {
  constructor(options = {}) {
    this.options = options;
    this.columns = normalizeColumns(options.columns);
    this.pageSize = normalizeInteger(options.pageSize, DEFAULT_PAGE_SIZE, 1);
    const initialRows = options.windowRows ?? options.rows;
    this.memoryMode = options.windowRows == null && Array.isArray(options.rows);
    this.windowMode =
      this.memoryMode || options.rowCount == null || Array.isArray(initialRows);
    this.windowRows = Array.isArray(initialRows)
      ? options.copyRows === false
        ? initialRows
        : initialRows.slice()
      : [];
    if (
      !this.memoryMode &&
      this.windowRows.length > this.pageSize * MAX_CACHED_PAGES
    ) {
      throw new RangeError(
        `A CanvasGrid window may hold at most ${MAX_CACHED_PAGES} pages`,
      );
    }
    this.baseRow = this.memoryMode
      ? 0
      : this.windowMode
        ? normalizeInteger(options.baseRow, 0)
        : 0;
    this.totalRows = this.memoryMode
      ? this.windowRows.length
      : this.windowMode
        ? normalizeNullableCount(options.totalRows)
        : normalizeInteger(options.rowCount, 0);
    this.rowCount = this.windowMode ? this.windowRows.length : this.totalRows;
    this.hasPrevious = this.windowMode && Boolean(options.hasPrevious);
    this.hasNext = this.windowMode && Boolean(options.hasNext);
    this.requestedPrevious = false;
    this.requestedNext = false;
    this.requestedEnd = false;
    this.pendingNavigation = null;
    this.selections = [];
    this.selection = null;
    this.selectionMode = "cell";
    this.activeOverride = null;
    this.highlights = [];
    this.currentHighlight = null;
    this.highlightRow = null;
    this.focused = false;
    this.destroyed = false;
    this.columnWidthOverrides = new Map();
    this.textFitCache = new Map();
    this.autoColumnWidths = [];
    this.rowHeaderWidthOverride = null;
    this.resizeState = null;
    this.dragging = false;
    this.dragScrollHandle = null;
    this.lastDragPoint = null;
    this.framePending = false;
    this.frameHandle = null;
    this.lastLogicalScrollTop = 0;
    this.selectionCallbacks = new Set();
    this.disposables = [];
    this.requestFrame =
      options.requestAnimationFrame ||
      ((callback) => window.requestAnimationFrame(callback));
    this.cancelFrame =
      options.cancelAnimationFrame ||
      ((handle) => window.cancelAnimationFrame(handle));
    this.getStyle =
      options.getComputedStyle || ((element) => getComputedStyle(element));
    this.getDpr =
      options.getDevicePixelRatio || (() => window.devicePixelRatio || 1);
    this.clipboard =
      options.clipboard ||
      globalThis.lumine?.clipboard ||
      globalThis.navigator?.clipboard;
    this.maxCopyCells = Math.min(
      MAX_COPY_CELLS,
      normalizeInteger(options.maxCopyCells, MAX_COPY_CELLS, 1),
    );
    this.maxCopyBytes = Math.min(
      MAX_COPY_BYTES,
      normalizeInteger(options.maxCopyBytes, MAX_COPY_BYTES, 1),
    );
    this.columnOverscan = normalizeInteger(options.columnOverscan, 2);

    this.buildElement();
    this.ctx = options.context || this.canvas.getContext("2d");
    this.overlayCtx =
      options.overlayContext || this.overlayCanvas.getContext("2d");
    this.cache = new PagedRowCache({
      fetchRows: options.fetchRows,
      rowCount: this.rowCount,
      pageSize: this.pageSize,
      onDidChange: () => this.handleCacheChange(),
      onDidError: (error, page) => options.onError?.(error, page),
    });
    this.readTheme();
    this.ownsRowMetrics = !(options.rowMetrics instanceof AxisMetrics);
    this.rowMetrics =
      options.rowMetrics ||
      new AxisMetrics({
        count: this.rowCount,
        defaultSize: this.rowHeight,
        sizes: options.rowHeights,
      });
    this.syncRowMetrics(options.rowHeights);
    this.computeLayout();
    this.bindEvents();
    this.bindCommands(
      options.commands === false
        ? null
        : options.commands || globalThis.lumine?.commands,
    );
    this.observeResize(options.resizeObserverFactory);
    if (options.observeTheme !== false) this.observeTheme();
    this.resize(options.width, options.height);
    this.updateAria();
  }

  buildElement() {
    this.element = document.createElement("div");
    this.element.className = this.options.className || "canvas-grid";
    this.element.tabIndex = 0;
    this.element.setAttribute("role", "grid");
    this.element.setAttribute(
      "aria-label",
      this.options.ariaLabel || "Data grid",
    );
    this.element.setAttribute("aria-multiselectable", "true");
    this.element.setAttribute(
      "aria-busy",
      this.options.busy ? "true" : "false",
    );
    Object.assign(this.element.style, {
      position: "relative",
      overflow: "auto",
      minWidth: "0",
      minHeight: "0",
      outline: "none",
    });

    this.sizer = document.createElement("div");
    this.sizer.className = "canvas-grid-sizer";
    this.sizer.setAttribute("aria-hidden", "true");
    Object.assign(this.sizer.style, {
      position: "absolute",
      top: "0",
      left: "0",
      pointerEvents: "none",
    });

    this.viewport = document.createElement("div");
    this.viewport.className = "canvas-grid-viewport";
    this.viewport.setAttribute("aria-hidden", "true");
    Object.assign(this.viewport.style, {
      position: "sticky",
      top: "0",
      left: "0",
      display: "block",
      pointerEvents: "none",
    });

    this.canvas = document.createElement("canvas");
    this.canvas.className = "canvas-grid-canvas";
    this.canvas.setAttribute("aria-hidden", "true");
    Object.assign(this.canvas.style, {
      position: "absolute",
      top: "0",
      left: "0",
      display: "block",
    });

    this.overlayCanvas = document.createElement("canvas");
    this.overlayCanvas.className = "canvas-grid-overlay";
    this.overlayCanvas.setAttribute("aria-hidden", "true");
    Object.assign(this.overlayCanvas.style, {
      position: "absolute",
      top: "0",
      left: "0",
      display: "block",
    });
    this.viewport.append(this.canvas, this.overlayCanvas);

    const id = `canvas-grid-active-${nextGridId++}`;
    this.ariaRow = document.createElement("div");
    this.ariaRow.setAttribute("role", "row");
    setHiddenAccessibleStyle(this.ariaRow);
    this.ariaCell = document.createElement("div");
    this.ariaCell.id = id;
    this.ariaCell.setAttribute("role", "gridcell");
    this.ariaCell.setAttribute("aria-selected", "true");
    this.ariaRow.appendChild(this.ariaCell);
    this.element.setAttribute("aria-activedescendant", id);

    this.liveRegion = document.createElement("div");
    this.liveRegion.className = "canvas-grid-live";
    this.liveRegion.setAttribute("role", "status");
    this.liveRegion.setAttribute("aria-live", "polite");
    this.liveRegion.setAttribute("aria-atomic", "true");
    setHiddenAccessibleStyle(this.liveRegion);

    this.element.append(
      this.sizer,
      this.viewport,
      this.ariaRow,
      this.liveRegion,
    );
  }

  observeResize(factory) {
    const create = factory || ((callback) => new ResizeObserver(callback));
    if (typeof create !== "function") return;
    try {
      this.resizeObserver = create(() => this.resize());
      this.resizeObserver?.observe?.(this.element);
    } catch {
      this.resizeObserver = null;
    }
  }

  observeTheme() {
    let pending = false;
    const update = () => {
      if (pending) return;
      pending = true;
      queueMicrotask(() => {
        pending = false;
        if (this.destroyed || !this.element.isConnected) return;
        this.readTheme();
        this.computeLayout();
        this.resize();
      });
    };
    const styles = globalThis.lumine?.styles?.onDidAddStyleElement?.(update);
    const themes = globalThis.lumine?.themes?.onDidChangeActiveThemes?.(update);
    if (styles) this.disposables.push(styles);
    if (themes) this.disposables.push(themes);
  }

  bindEvents() {
    this.handlers = {
      scroll: () => this.handleScroll(),
      focus: () => {
        this.focused = true;
        this.scheduleDraw("overlay");
      },
      blur: () => {
        this.focused = false;
        this.scheduleDraw("overlay");
      },
      mousedown: (event) => this.handleMouseDown(event),
      mousemove: (event) => this.handleMouseMove(event),
      dblclick: (event) => this.handleDoubleClick(event),
      contextmenu: (event) =>
        this.options.onContextMenu?.(
          this.hit(event.clientX, event.clientY, false),
          event,
        ),
      keydown: (event) => this.handleKeyDown(event),
      contextlost: (event) => event.preventDefault(),
      contextrestored: () => {
        if (!this.options.context) this.ctx = this.canvas.getContext("2d");
        if (!this.options.overlayContext)
          this.overlayCtx = this.overlayCanvas.getContext("2d");
        this.textFitCache.clear();
        this.scheduleDraw();
      },
      windowMousemove: (event) => this.handleWindowMouseMove(event),
      windowMouseup: () => this.handleWindowMouseUp(),
      resizeMousemove: (event) => this.handleResizeMove(event),
      resizeMouseup: () => this.handleResizeUp(),
    };
    this.element.addEventListener("scroll", this.handlers.scroll);
    this.element.addEventListener("focus", this.handlers.focus);
    this.element.addEventListener("blur", this.handlers.blur);
    this.element.addEventListener("mousedown", this.handlers.mousedown);
    this.element.addEventListener("mousemove", this.handlers.mousemove);
    this.element.addEventListener("dblclick", this.handlers.dblclick);
    this.element.addEventListener("contextmenu", this.handlers.contextmenu);
    this.element.addEventListener("keydown", this.handlers.keydown);
    this.canvas.addEventListener("contextlost", this.handlers.contextlost);
    this.canvas.addEventListener(
      "contextrestored",
      this.handlers.contextrestored,
    );
    this.overlayCanvas.addEventListener(
      "contextlost",
      this.handlers.contextlost,
    );
    this.overlayCanvas.addEventListener(
      "contextrestored",
      this.handlers.contextrestored,
    );
  }

  bindCommands(commands) {
    if (!commands?.add) return;
    const prefix = this.options.commandPrefix || "canvas-grid";
    const command = (callback) => (event) => {
      event?.stopPropagation?.();
      event?.preventDefault?.();
      callback();
    };
    const move = (row, column, extend = false) =>
      command(() => this.moveActiveSelection(row, column, extend));
    const moveTo = (row, column, extend = false) =>
      command(() => this.moveActiveSelectionTo(row, column, extend));
    const page = (direction, extend = false) =>
      command(() =>
        this.moveActiveSelection(direction * this.pageRowCount(), 0, extend),
      );
    const described = (description, callback) => ({
      description,
      didDispatch: callback,
    });
    const map = {
      "core:move-up": command(() => this.navigate(-1, 0)),
      "core:move-down": command(() => this.navigate(1, 0)),
      "core:move-left": command(() => this.navigate(0, -1)),
      "core:move-right": command(() => this.navigate(0, 1)),
      "core:select-up": move(-1, 0, true),
      "core:select-down": move(1, 0, true),
      "core:select-left": move(0, -1, true),
      "core:select-right": move(0, 1, true),
      "core:move-to-top": moveTo(0, 0),
      "core:move-to-bottom": command(() => this.moveToEnd(false)),
      "core:select-to-top": moveTo(0, 0, true),
      "core:select-to-bottom": command(() => this.moveToEnd(true)),
      "core:confirm": command(() => this.confirmActiveCell()),
      [`${prefix}:grid-page-up`]: described(
        "Move a screenful up through the result.",
        page(-1),
      ),
      [`${prefix}:grid-page-down`]: described(
        "Move a screenful down through the result.",
        page(1),
      ),
      [`${prefix}:grid-select-page-up`]: described(
        "Extend the selection a screenful up.",
        page(-1, true),
      ),
      [`${prefix}:grid-select-page-down`]: described(
        "Extend the selection a screenful down.",
        page(1, true),
      ),
      [`${prefix}:grid-move-to-row-start`]: described(
        "Move to the first cell of the row.",
        moveTo(null, 0),
      ),
      [`${prefix}:grid-move-to-row-end`]: described(
        "Move to the last cell of the row.",
        command(() =>
          this.moveActiveSelectionTo(null, this.columns.length - 1),
        ),
      ),
      [`${prefix}:grid-select-to-row-start`]: described(
        "Extend the selection to the first cell of the row.",
        moveTo(null, 0, true),
      ),
      [`${prefix}:grid-select-to-row-end`]: described(
        "Extend the selection to the last cell of the row.",
        command(() =>
          this.moveActiveSelectionTo(null, this.columns.length - 1, true),
        ),
      ),
      [`${prefix}:grid-select-row`]: described(
        "Select the current row.",
        command(() => this.selectActiveRow()),
      ),
      [`${prefix}:grid-select-column`]: described(
        "Select the current column.",
        command(() => this.selectActiveColumn()),
      ),
    };
    this.commandDisposable = commands.add(this.element, map);
  }

  readTheme() {
    const previousFont = this.font;
    const style = this.getStyle(this.element);
    const value = (name, fallback) =>
      style?.getPropertyValue?.(name)?.trim() || fallback;
    const pixels = (name, fallback) => {
      const parsed = Number.parseFloat(value(name, ""));
      return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
    };
    this.fontSize = Number.parseFloat(style?.fontSize) || 12;
    this.fontFamily = style?.fontFamily || "monospace";
    this.font = `${this.fontSize}px ${this.fontFamily}`;
    if (previousFont && previousFont !== this.font) {
      this.autoColumnWidths = [];
      this.textFitCache.clear();
    }
    this.rowHeight = pixels("--canvas-grid-row-height", 24);
    this.headerHeight = pixels("--canvas-grid-header-height", 28);
    this.colorText = value(
      "--canvas-grid-text-color",
      value("--text-color", style?.color || "#ccc"),
    );
    this.colorMuted = value(
      "--canvas-grid-muted-color",
      value("--text-color-subtle", this.colorText),
    );
    this.colorNull = value("--canvas-grid-null-color", this.colorMuted);
    this.colorBorder = value(
      "--canvas-grid-border-color",
      value("--base-border-color", "rgba(128,128,128,0.35)"),
    );
    this.colorHeader = value(
      "--canvas-grid-header-color",
      value("--background-color-highlight", "#2a2a2a"),
    );
    this.colorAccent = value("--canvas-grid-accent-color", "#4b9cff");
    this.colorHighlight = value(
      "--canvas-grid-highlight-color",
      this.colorAccent,
    );
    this.colorCurrentHighlight = value(
      "--canvas-grid-current-highlight-color",
      this.colorAccent,
    );
    if (this.ownsRowMetrics) this.rowMetrics?.setDefaultSize(this.rowHeight);
  }

  valueText(row, column, rowIndex, resolvedValue) {
    const value = arguments.length >= 4 ? resolvedValue : rowValue(row, column);
    if (column.formatCell)
      return String(column.formatCell(value, row, rowIndex));
    return formatCell(value);
  }

  syncRowMetrics(sizes = this.options.rowHeights) {
    if (!this.rowMetrics) return;
    if (this.rowMetrics.count !== this.rowCount || sizes) {
      this.rowMetrics.setItems(
        this.rowCount,
        sizes || this.rowMetrics.toArray(),
      );
    }
  }

  rowOffset(row) {
    return this.rowMetrics.offsetAt(row);
  }

  rowSize(row) {
    return this.rowMetrics.sizeAt(row);
  }

  setRowSize(row, size) {
    const changed = this.rowMetrics.setSize(row, size);
    if (changed) {
      this.applyColumnWidths();
      this.options.onRowResize?.({
        row: this.absoluteRow(row),
        windowRow: row,
        height: size,
      });
    }
    return changed;
  }

  computeLayout() {
    const ctx = this.ctx;
    if (!ctx) return;
    ctx.font = this.font;
    const largestRow =
      this.totalRows ??
      (this.windowMode ? this.baseRow + this.rowCount : this.rowCount);
    const rowDigits = Math.max(1, String(Math.max(1, largestRow)).length);
    const measuredRowHeader =
      ctx.measureText("9".repeat(rowDigits)).width + CELL_PADDING_X * 2;
    this.rowHeaderWidth =
      this.rowHeaderWidthOverride ?? Math.max(44, Math.ceil(measuredRowHeader));
    const sample = this.windowMode
      ? this.windowRows.slice(0, SAMPLE_ROWS)
      : this.cache?.loadedRows(SAMPLE_ROWS) || [];
    this.columnWidths = this.columns.map((column, columnIndex) => {
      const override = this.columnWidthOverrides.get(columnIndex);
      if (override != null) return override;
      if (column.width != null) return column.width;
      let width = ctx.measureText(column.label).width;
      for (let rowIndex = 0; rowIndex < sample.length; rowIndex++) {
        width = Math.max(
          width,
          ctx.measureText(this.valueText(sample[rowIndex], column, rowIndex))
            .width,
        );
      }
      const measured = clamp(
        Math.ceil(width) + CELL_PADDING_X * 2,
        MIN_COLUMN_WIDTH,
        MAX_COLUMN_WIDTH,
      );
      this.autoColumnWidths[columnIndex] = Math.max(
        this.autoColumnWidths[columnIndex] || 0,
        measured,
      );
      return this.autoColumnWidths[columnIndex];
    });
    this.applyColumnWidths();
  }

  applyColumnWidths() {
    this.columnStarts = [this.rowHeaderWidth];
    let x = this.rowHeaderWidth;
    for (const width of this.columnWidths || []) {
      x += width;
      this.columnStarts.push(x);
    }
    this.totalWidth = x;
    this.logicalHeight = this.headerHeight + this.rowMetrics.totalSize;
    this.physicalHeight = Math.min(this.logicalHeight, MAX_SCROLL_HEIGHT);
    this.sizer.style.width = `${Math.max(1, this.totalWidth)}px`;
    this.sizer.style.height = `${Math.max(1, this.physicalHeight)}px`;
    this.lastVisibleColumnsKey = null;
    this.notifyVisibleColumns();
    this.scheduleDraw();
  }

  setData({
    columns = this.columns,
    rowCount = this.rowCount,
    fetchRows = this.cache.fetchRows,
    pageSize = this.pageSize,
  } = {}) {
    this.memoryMode = false;
    this.windowMode = false;
    this.windowRows = [];
    this.baseRow = 0;
    this.hasPrevious = false;
    this.hasNext = false;
    const normalized = normalizeColumns(columns);
    const shapeChanged =
      normalized.length !== this.columns.length ||
      normalized.some(
        (column, index) =>
          column.key !== this.columns[index]?.key ||
          column.label !== this.columns[index]?.label,
      );
    this.columns = normalized;
    this.rowCount = normalizeInteger(rowCount, 0);
    this.totalRows = this.rowCount;
    this.syncRowMetrics();
    this.pageSize = normalizeInteger(pageSize, DEFAULT_PAGE_SIZE, 1);
    if (shapeChanged || this.rowCount === 0 || this.columns.length === 0) {
      this.columnWidthOverrides.clear();
      this.autoColumnWidths = [];
      this.clearSelection(false);
    } else if (this.selection) {
      this.selection = this.clampSelection(this.selection);
      this.selections = this.selections.map((selection) =>
        this.clampSelection(selection),
      );
    }
    const generation = this.cache.generation;
    this.cache.configure({
      fetchRows,
      rowCount: this.rowCount,
      pageSize: this.pageSize,
    });
    if (generation === this.cache.generation) this.cache.clear();
    this.computeLayout();
    this.updateAria();
    this.requestVisiblePages();
  }

  setRows({ columns = this.columns, rows = [], rowHeights } = {}) {
    if (!Array.isArray(rows))
      throw new TypeError("CanvasGrid rows must be an array");
    this.memoryMode = true;
    this.windowMode = true;
    this.windowRows = this.options.copyRows === false ? rows : rows.slice();
    this.baseRow = 0;
    this.totalRows = rows.length;
    this.rowCount = rows.length;
    this.hasPrevious = false;
    this.hasNext = false;
    this.pendingNavigation = null;
    this.requestedPrevious = false;
    this.requestedNext = false;
    this.requestedEnd = false;
    this.cache.clear();
    this.setColumns(columns);
    this.syncRowMetrics(rowHeights);
    if (!this.rowCount || !this.columns.length) this.clearSelection(false);
    else if (this.selection) {
      this.selection = this.clampSelection(this.selection);
      this.selections = this.selections.map((selection) =>
        this.clampSelection(selection),
      );
    }
    this.computeLayout();
    this.updateAria();
    this.scheduleDraw();
  }

  setColumns(columns) {
    const normalized = normalizeColumns(columns);
    const shapeChanged =
      normalized.length !== this.columns.length ||
      normalized.some(
        (column, index) =>
          column.key !== this.columns[index]?.key ||
          column.label !== this.columns[index]?.label,
      );
    this.columns = normalized;
    if (shapeChanged) {
      this.columnWidthOverrides.clear();
      this.autoColumnWidths = [];
      this.clearSelection(false);
    }
    this.computeLayout();
    this.updateAria();
  }

  /** Replace the keyset-backed logical window. `rows` is capped at three pages. */
  setWindow({
    baseRow = this.baseRow,
    rows = [],
    hasPrevious = false,
    hasNext = false,
    totalRows = this.totalRows,
    columns,
  } = {}) {
    if (!Array.isArray(rows))
      throw new TypeError("CanvasGrid window rows must be an array");
    if (rows.length > this.pageSize * MAX_CACHED_PAGES) {
      throw new RangeError(
        `A CanvasGrid window may hold at most ${MAX_CACHED_PAGES} pages`,
      );
    }
    const oldActive = this.selection
      ? this.baseRow + this.activeCell().row
      : null;
    const pending = this.pendingNavigation;
    if (columns) this.setColumns(columns);
    this.memoryMode = false;
    this.windowMode = true;
    this.cache.clear();
    this.baseRow = normalizeInteger(baseRow, 0);
    this.windowRows = rows.slice();
    this.rowCount = this.windowRows.length;
    this.totalRows = normalizeNullableCount(totalRows);
    this.syncRowMetrics();
    this.hasPrevious = Boolean(hasPrevious);
    this.hasNext = Boolean(hasNext);
    let requestedRow;
    if (pending?.end) {
      requestedRow =
        this.totalRows != null
          ? this.totalRows - 1
          : this.hasNext
            ? null
            : this.baseRow + this.rowCount - 1;
    } else {
      requestedRow = pending?.absoluteRow ?? oldActive;
    }
    const targetInWindow =
      requestedRow != null &&
      requestedRow >= this.baseRow &&
      requestedRow < this.baseRow + this.rowCount;
    const waitingForTarget =
      Boolean(pending) &&
      !targetInWindow &&
      ((pending.direction < 0 && this.hasPrevious) ||
        (pending.direction > 0 && this.hasNext) ||
        (pending.end && this.hasNext));
    this.pendingNavigation = waitingForTarget ? pending : null;
    this.requestedPrevious = waitingForTarget && pending.direction < 0;
    this.requestedNext =
      waitingForTarget && pending.direction > 0 && !pending.end;
    this.requestedEnd = waitingForTarget && Boolean(pending.end);

    if (this.rowCount === 0 || this.columns.length === 0) {
      this.ariaCell.setAttribute("role", "gridcell");
      this.ariaCell.setAttribute("aria-selected", "false");
      this.clearSelection(false);
    } else if (requestedRow != null || waitingForTarget) {
      let localRow = requestedRow == null ? -1 : requestedRow - this.baseRow;
      if (localRow < 0 || localRow >= this.rowCount) {
        const oldLocal = oldActive == null ? -1 : oldActive - this.baseRow;
        localRow =
          oldLocal >= 0 && oldLocal < this.rowCount
            ? oldLocal
            : pending?.direction < 0
              ? 0
              : this.rowCount - 1;
      }
      const column = clamp(
        pending?.column ?? this.activeCell().column,
        0,
        this.columns.length - 1,
      );
      this.startSelection(
        { zone: "body", row: localRow, column },
        false,
        false,
      );
      this.scrollCellIntoView(localRow, column);
    }
    this.computeLayout();
    this.updateAria();
    this.scheduleDraw();
  }

  refresh() {
    if (this.windowMode) {
      this.options.onRefreshWindow?.({
        baseRow: this.baseRow,
        rows: this.windowRows.slice(),
        hasPrevious: this.hasPrevious,
        hasNext: this.hasNext,
      });
      return;
    }
    this.cache.clear();
    this.requestVisiblePages();
  }

  handleCacheChange() {
    if (this.destroyed) return;
    this.element.setAttribute(
      "aria-busy",
      this.cache.loading ? "true" : "false",
    );
    this.computeLayout();
    this.updateAria();
    this.scheduleDraw();
  }

  resize(width, height) {
    if (this.destroyed) return;
    const nextWidth = normalizeInteger(width, this.element.clientWidth);
    const nextHeight = normalizeInteger(height, this.element.clientHeight);
    if (nextWidth <= 0 || nextHeight <= 0 || !this.ctx || !this.overlayCtx)
      return;
    if (!this.themeReadAttached && this.element.isConnected) {
      this.themeReadAttached = true;
      this.readTheme();
      this.computeLayout();
    }
    this.viewWidth = nextWidth;
    this.viewHeight = nextHeight;
    this.dpr = Math.max(1, Number(this.getDpr()) || 1);
    this.canvas.width = Math.round(nextWidth * this.dpr);
    this.canvas.height = Math.round(nextHeight * this.dpr);
    this.canvas.style.width = `${nextWidth}px`;
    this.canvas.style.height = `${nextHeight}px`;
    this.overlayCanvas.width = Math.round(nextWidth * this.dpr);
    this.overlayCanvas.height = Math.round(nextHeight * this.dpr);
    this.overlayCanvas.style.width = `${nextWidth}px`;
    this.overlayCanvas.style.height = `${nextHeight}px`;
    this.viewport.style.width = `${nextWidth}px`;
    this.viewport.style.height = `${nextHeight}px`;
    this.requestVisiblePages();
    this.notifyVisibleColumns();
    this.scheduleDraw();
  }

  logicalMaxScroll() {
    return Math.max(0, this.logicalHeight - (this.viewHeight || 0));
  }

  physicalMaxScroll() {
    return Math.max(0, this.physicalHeight - (this.viewHeight || 0));
  }

  logicalScrollTop() {
    const physicalMax = this.physicalMaxScroll();
    if (physicalMax <= 0) return 0;
    return (this.element.scrollTop / physicalMax) * this.logicalMaxScroll();
  }

  physicalScrollTop(logicalTop) {
    const logicalMax = this.logicalMaxScroll();
    if (logicalMax <= 0) return 0;
    return (
      (clamp(logicalTop, 0, logicalMax) / logicalMax) * this.physicalMaxScroll()
    );
  }

  visibleRange() {
    if (!this.viewHeight || this.rowCount === 0)
      return { firstRow: 0, lastRow: -1 };
    const top = this.logicalScrollTop();
    const bodyHeight = Math.max(0, this.viewHeight - this.headerHeight);
    return {
      firstRow: clamp(this.rowMetrics.indexAt(top), 0, this.rowCount - 1),
      lastRow: clamp(
        this.rowMetrics.indexAt(top + bodyHeight),
        0,
        this.rowCount - 1,
      ),
    };
  }

  desiredPages() {
    if (this.windowMode) return [];
    const { firstRow, lastRow } = this.visibleRange();
    if (lastRow < firstRow || this.rowCount === 0) return [];
    const firstPage = Math.floor(firstRow / this.pageSize);
    const lastPage = Math.floor(lastRow / this.pageSize);
    const pages = [];
    for (
      let page = firstPage;
      page <= lastPage && pages.length < MAX_CACHED_PAGES;
      page++
    )
      pages.push(page);
    const direction =
      this.logicalScrollTop() >= this.lastLogicalScrollTop ? 1 : -1;
    for (let distance = 1; pages.length < MAX_CACHED_PAGES; distance++) {
      const after = lastPage + distance;
      const before = firstPage - distance;
      const page = direction >= 0 ? after : before;
      const fallback = direction >= 0 ? before : after;
      const maxPage = Math.floor((this.rowCount - 1) / this.pageSize);
      if (page >= 0 && page <= maxPage && !pages.includes(page))
        pages.push(page);
      else if (
        fallback >= 0 &&
        fallback <= maxPage &&
        !pages.includes(fallback)
      )
        pages.push(fallback);
      else break;
    }
    return pages;
  }

  requestVisiblePages() {
    if (this.windowMode) return Promise.resolve([]);
    if (!this.cache || !this.viewHeight) return Promise.resolve([]);
    const pages = this.desiredPages();
    this.lastLogicalScrollTop = this.logicalScrollTop();
    return this.cache.retainPages(pages);
  }

  whenIdle() {
    return this.windowMode ? Promise.resolve([]) : this.cache.whenIdle();
  }

  handleScroll() {
    if (this.windowMode) this.maybeRequestWindow();
    else this.requestVisiblePages();
    this.notifyVisibleColumns();
    this.scheduleDraw();
  }

  rowState(rowIndex) {
    if (rowIndex < 0 || rowIndex >= this.rowCount)
      return { status: "missing", row: undefined };
    if (this.windowMode)
      return { status: "loaded", row: this.windowRows[rowIndex] };
    return this.cache.stateForRow(rowIndex);
  }

  async rowAt(rowIndex) {
    if (this.windowMode) return this.windowRows[rowIndex];
    return this.cache.row(rowIndex);
  }

  absoluteRow(rowIndex) {
    return this.windowMode ? this.baseRow + rowIndex : rowIndex;
  }

  maybeApplyWindow(result) {
    if (result && Array.isArray(result.rows) && !this.destroyed)
      this.setWindow(result);
    return result;
  }

  requestBoundary(direction, reason = "keyboard", extend = false) {
    if (!this.windowMode) return false;
    const previous = direction < 0;
    if ((previous && !this.hasPrevious) || (!previous && !this.hasNext))
      return false;
    const callback = previous
      ? this.options.onNeedPrevious
      : this.options.onNeedNext;
    if (typeof callback !== "function") return false;
    const requestedKey = previous ? "requestedPrevious" : "requestedNext";
    if (this[requestedKey]) return true;
    this[requestedKey] = true;
    const active = this.activeCell();
    if (reason === "keyboard") {
      this.pendingNavigation = {
        absoluteRow: previous ? this.baseRow - 1 : this.baseRow + this.rowCount,
        column: active.column,
        direction,
        extend,
      };
    }
    const context = {
      direction,
      reason,
      baseRow: this.baseRow,
      rows: this.windowRows.slice(),
      pageSize: this.pageSize,
      activeRow: this.absoluteRow(active.row),
      activeColumn: active.column,
    };
    try {
      const result = callback?.(context);
      if (result?.then) {
        result
          .then((windowState) => this.maybeApplyWindow(windowState))
          .catch((error) => {
            this[requestedKey] = false;
            this.options.onError?.(error, { direction, reason });
          });
      } else this.maybeApplyWindow(result);
    } catch (error) {
      this[requestedKey] = false;
      this.options.onError?.(error, { direction, reason });
    }
    return true;
  }

  maybeRequestWindow() {
    if (!this.windowMode || !this.viewHeight || this.rowCount === 0) return;
    const logicalTop = this.logicalScrollTop();
    const bodyHeight = Math.max(0, this.viewHeight - this.headerHeight);
    const logicalBottom = logicalTop + bodyHeight;
    if (logicalTop <= this.rowSize(0)) this.requestBoundary(-1, "scroll");
    if (
      logicalBottom >=
      this.rowMetrics.totalSize - this.rowSize(this.rowCount - 1)
    ) {
      this.requestBoundary(1, "scroll");
    }
  }

  scheduleDraw(layer = "all") {
    if (layer === "overlay") this.overlayDirty = true;
    else {
      this.baseDirty = true;
      this.overlayDirty = true;
    }
    if (this.destroyed || this.framePending || !this.ctx || !this.overlayCtx)
      return;
    this.framePending = true;
    this.frameHandle = this.requestFrame(() => {
      this.framePending = false;
      this.frameHandle = null;
      if (this.baseDirty) this.drawBase();
      if (this.overlayDirty) this.drawOverlay();
      this.baseDirty = false;
      this.overlayDirty = false;
    });
  }

  invalidate(layer = "all") {
    this.scheduleDraw(layer);
  }

  fitText(text, maximumWidth) {
    if (maximumWidth <= 0) return "";
    const key = `${maximumWidth}\0${text}`;
    if (this.textFitCache.has(key)) {
      const cached = this.textFitCache.get(key);
      this.textFitCache.delete(key);
      this.textFitCache.set(key, cached);
      return cached;
    }
    let fitted;
    if (this.ctx.measureText(text).width <= maximumWidth) {
      fitted = text;
    } else {
      const ellipsis = "…";
      let low = 0;
      let high = text.length;
      while (low < high) {
        const middle = (low + high + 1) >> 1;
        if (
          this.ctx.measureText(text.slice(0, middle) + ellipsis).width <=
          maximumWidth
        )
          low = middle;
        else high = middle - 1;
      }
      fitted = low > 0 ? text.slice(0, low) + ellipsis : ellipsis;
    }
    this.textFitCache.set(key, fitted);
    if (this.textFitCache.size > MAX_FIT_CACHE) {
      this.textFitCache.delete(this.textFitCache.keys().next().value);
    }
    return fitted;
  }

  visibleColumns() {
    if (!this.columns.length) return { firstColumn: 0, lastColumn: -1 };
    const scrollLeft = this.element.scrollLeft;
    const left = scrollLeft + this.rowHeaderWidth;
    const right = scrollLeft + this.viewWidth;
    const firstColumn = clamp(
      lowerBound(this.columnStarts, left + 0.001) - 1,
      0,
      this.columns.length - 1,
    );
    const lastColumn = clamp(
      lowerBound(this.columnStarts, right) - 1,
      firstColumn,
      this.columns.length - 1,
    );
    return { firstColumn, lastColumn };
  }

  notifyVisibleColumns() {
    if (
      typeof this.options.onVisibleColumnsChange !== "function" ||
      !this.viewWidth
    )
      return;
    const { firstColumn, lastColumn } = this.visibleColumns();
    if (lastColumn < firstColumn) return;
    const start = Math.max(0, firstColumn - this.columnOverscan);
    const end = Math.min(
      this.columns.length,
      lastColumn + this.columnOverscan + 1,
    );
    const key = `${start}:${end}:${firstColumn}:${lastColumn}`;
    if (key === this.lastVisibleColumnsKey) return;
    this.lastVisibleColumnsKey = key;
    this.options.onVisibleColumnsChange({
      start,
      end,
      visibleStart: firstColumn,
      visibleEnd: lastColumn + 1,
      columns: this.columns.slice(start, end),
    });
  }

  draw() {
    this.drawBase();
    this.drawOverlay();
    this.baseDirty = false;
    this.overlayDirty = false;
  }

  drawBase() {
    if (!this.ctx || !this.viewWidth || !this.viewHeight) return;
    const ctx = this.ctx;
    const width = this.viewWidth;
    const height = this.viewHeight;
    const scrollLeft = this.element.scrollLeft;
    const scrollTop = this.logicalScrollTop();
    const { firstRow, lastRow } = this.visibleRange();
    const { firstColumn, lastColumn } = this.visibleColumns();

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.font = this.font;
    ctx.textBaseline = "middle";

    ctx.save();
    ctx.beginPath();
    ctx.rect(
      this.rowHeaderWidth,
      this.headerHeight,
      width - this.rowHeaderWidth,
      height - this.headerHeight,
    );
    ctx.clip();
    for (let rowIndex = firstRow; rowIndex <= lastRow; rowIndex++) {
      const rowHeight = this.rowSize(rowIndex);
      const y = this.headerHeight + this.rowOffset(rowIndex) - scrollTop;
      const state = this.rowState(rowIndex);
      for (
        let columnIndex = firstColumn;
        columnIndex <= lastColumn;
        columnIndex++
      ) {
        const x = this.columnStarts[columnIndex] - scrollLeft;
        const cellWidth = this.columnWidths[columnIndex];
        const column = this.columns[columnIndex];
        const rawValue =
          state.status === "loaded" ? rowValue(state.row, column) : undefined;
        const text =
          state.status === "loaded"
            ? this.valueText(state.row, column, rowIndex)
            : state.status === "error"
              ? "Error"
              : "…";
        const painter = column.paintCell || this.options.paintCell;
        if (painter && state.status === "loaded") {
          ctx.save();
          ctx.beginPath();
          ctx.rect(x, y, cellWidth, rowHeight);
          ctx.clip();
          painter(ctx, {
            rect: { x, y, width: cellWidth, height: rowHeight },
            value: rawValue,
            text,
            record: state.row,
            row: this.absoluteRow(rowIndex),
            windowRow: rowIndex,
            column: columnIndex,
            columnDefinition: column,
          });
          ctx.restore();
        } else {
          ctx.fillStyle =
            rawValue == null && state.status === "loaded"
              ? this.colorNull
              : this.colorText;
          ctx.textAlign = column.align;
          const textX =
            column.align === "right"
              ? x + cellWidth - CELL_PADDING_X
              : column.align === "center"
                ? x + cellWidth / 2
                : x + CELL_PADDING_X;
          const lines = String(text).split(/\r\n|\n|\r/);
          const lineHeight = this.fontSize + 2;
          const visibleLines = Math.max(
            1,
            Math.floor((rowHeight - 4) / lineHeight),
          );
          const firstLineY =
            lines.length === 1 ? y + rowHeight / 2 : y + lineHeight / 2 + 2;
          for (
            let line = 0;
            line < Math.min(lines.length, visibleLines);
            line++
          ) {
            ctx.fillText(
              this.fitText(lines[line], cellWidth - CELL_PADDING_X * 2),
              textX,
              firstLineY + line * lineHeight,
            );
          }
          ctx.textAlign = "left";
        }
      }
    }
    this.drawGridLines(
      ctx,
      firstRow,
      lastRow,
      firstColumn,
      lastColumn,
      scrollLeft,
      scrollTop,
      width,
      height,
    );
    ctx.restore();

    this.drawRowHeaders(ctx, firstRow, lastRow, scrollTop, width, height, []);
    this.drawColumnHeaders(ctx, firstColumn, lastColumn, scrollLeft, width, []);
    this.drawCorner(ctx);
  }

  drawOverlay() {
    if (!this.overlayCtx || !this.viewWidth || !this.viewHeight) return;
    const ctx = this.overlayCtx;
    const width = this.viewWidth;
    const height = this.viewHeight;
    const scrollLeft = this.element.scrollLeft;
    const scrollTop = this.logicalScrollTop();
    const selections = this.focused ? this.normalizedSelections() : [];
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    if (
      !selections.length &&
      !this.highlights.length &&
      this.highlightRow == null &&
      !this.resizeState
    )
      return;

    ctx.save();
    ctx.beginPath();
    ctx.rect(
      this.rowHeaderWidth,
      this.headerHeight,
      width - this.rowHeaderWidth,
      height - this.headerHeight,
    );
    ctx.clip();
    if (this.highlightRow != null) {
      const windowRow = this.windowMode
        ? this.highlightRow - this.baseRow
        : this.highlightRow;
      if (windowRow >= 0 && windowRow < this.rowCount) {
        const top = this.headerHeight + this.rowOffset(windowRow) - scrollTop;
        ctx.save();
        ctx.globalAlpha = 0.24;
        ctx.fillStyle = this.colorHighlight;
        ctx.fillRect(
          this.rowHeaderWidth,
          top,
          width - this.rowHeaderWidth,
          this.rowSize(windowRow),
        );
        ctx.restore();
      }
    }
    for (const highlight of this.highlights) {
      if (
        highlight.row < 0 ||
        highlight.row >= this.rowCount ||
        highlight.column < 0 ||
        highlight.column >= this.columns.length
      )
        continue;
      const left = this.columnStarts[highlight.column] - scrollLeft;
      const top = this.headerHeight + this.rowOffset(highlight.row) - scrollTop;
      const current =
        this.currentHighlight?.row === highlight.row &&
        this.currentHighlight?.column === highlight.column;
      ctx.save();
      ctx.globalAlpha = current ? 0.5 : 0.28;
      ctx.fillStyle = current
        ? this.colorCurrentHighlight
        : this.colorHighlight;
      ctx.fillRect(
        left,
        top,
        this.columnWidths[highlight.column],
        this.rowSize(highlight.row),
      );
      ctx.restore();
    }
    ctx.globalAlpha = 0.22;
    ctx.fillStyle = this.colorAccent;
    for (const selection of selections) {
      const left = this.columnStarts[selection.c0] - scrollLeft;
      const right = this.columnStarts[selection.c1 + 1] - scrollLeft;
      const top = this.headerHeight + this.rowOffset(selection.r0) - scrollTop;
      const bottom =
        this.headerHeight + this.rowOffset(selection.r1 + 1) - scrollTop;
      ctx.fillRect(left, top, right - left, bottom - top);
    }
    ctx.restore();

    if (this.resizeState) {
      ctx.save();
      ctx.strokeStyle = this.colorAccent;
      ctx.lineWidth = 1;
      ctx.beginPath();
      if (this.resizeState.hit.row != null) {
        const y =
          this.headerHeight +
          this.rowOffset(this.resizeState.hit.row + 1) -
          scrollTop;
        ctx.moveTo(0, Math.round(y) + 0.5);
        ctx.lineTo(width, Math.round(y) + 0.5);
      } else {
        const x = this.resizeState.hit.rowHeader
          ? this.rowHeaderWidth
          : this.columnStarts[this.resizeState.hit.column + 1] - scrollLeft;
        ctx.moveTo(Math.round(x) + 0.5, 0);
        ctx.lineTo(Math.round(x) + 0.5, height);
      }
      ctx.stroke();
      ctx.restore();
    }

    if (selections.length) {
      const { firstRow, lastRow } = this.visibleRange();
      this.drawRowHeaders(
        ctx,
        firstRow,
        lastRow,
        scrollTop,
        width,
        height,
        selections,
      );
      const { firstColumn, lastColumn } = this.visibleColumns();
      this.drawColumnHeaders(
        ctx,
        firstColumn,
        lastColumn,
        scrollLeft,
        width,
        selections,
      );
      this.drawActiveOutline(ctx, scrollLeft, scrollTop);
    }
  }

  drawGridLines(
    ctx,
    firstRow,
    lastRow,
    firstColumn,
    lastColumn,
    scrollLeft,
    scrollTop,
    width,
    height,
  ) {
    if (lastRow < firstRow || lastColumn < firstColumn) return;
    ctx.strokeStyle = this.colorBorder;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (
      let columnIndex = firstColumn;
      columnIndex <= lastColumn + 1;
      columnIndex++
    ) {
      const x = Math.round(this.columnStarts[columnIndex] - scrollLeft) + 0.5;
      ctx.moveTo(x, this.headerHeight);
      ctx.lineTo(x, height);
    }
    for (let rowIndex = firstRow; rowIndex <= lastRow + 1; rowIndex++) {
      const y =
        Math.round(this.headerHeight + this.rowOffset(rowIndex) - scrollTop) +
        0.5;
      ctx.moveTo(this.rowHeaderWidth, y);
      ctx.lineTo(width, y);
    }
    ctx.stroke();
  }

  drawRowHeaders(
    ctx,
    firstRow,
    lastRow,
    scrollTop,
    _width,
    height,
    selections,
  ) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(
      0,
      this.headerHeight,
      this.rowHeaderWidth,
      height - this.headerHeight,
    );
    ctx.clip();
    ctx.fillStyle = this.colorHeader;
    ctx.fillRect(
      0,
      this.headerHeight,
      this.rowHeaderWidth,
      height - this.headerHeight,
    );
    for (let rowIndex = firstRow; rowIndex <= lastRow; rowIndex++) {
      const rowHeight = this.rowSize(rowIndex);
      const y = this.headerHeight + this.rowOffset(rowIndex) - scrollTop;
      if (
        selections.some(
          (selection) => rowIndex >= selection.r0 && rowIndex <= selection.r1,
        )
      ) {
        ctx.save();
        ctx.globalAlpha = 0.15;
        ctx.fillStyle = this.colorAccent;
        ctx.fillRect(0, y, this.rowHeaderWidth, rowHeight);
        ctx.restore();
      }
      ctx.fillStyle = this.colorMuted;
      const state = this.rowState(rowIndex);
      const label = this.options.formatRowHeader
        ? this.options.formatRowHeader({
            row: this.absoluteRow(rowIndex),
            windowRow: rowIndex,
            record: state.row,
          })
        : this.absoluteRow(rowIndex) + 1;
      ctx.fillText(String(label), CELL_PADDING_X, y + rowHeight / 2);
    }
    ctx.restore();
  }

  drawColumnHeaders(
    ctx,
    firstColumn,
    lastColumn,
    scrollLeft,
    width,
    selections,
  ) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(
      this.rowHeaderWidth,
      0,
      width - this.rowHeaderWidth,
      this.headerHeight,
    );
    ctx.clip();
    ctx.fillStyle = this.colorHeader;
    ctx.fillRect(
      this.rowHeaderWidth,
      0,
      width - this.rowHeaderWidth,
      this.headerHeight,
    );
    for (
      let columnIndex = firstColumn;
      columnIndex <= lastColumn;
      columnIndex++
    ) {
      const x = this.columnStarts[columnIndex] - scrollLeft;
      if (
        selections.some(
          (selection) =>
            columnIndex >= selection.c0 && columnIndex <= selection.c1,
        )
      ) {
        ctx.save();
        ctx.globalAlpha = 0.15;
        ctx.fillStyle = this.colorAccent;
        ctx.fillRect(x, 0, this.columnWidths[columnIndex], this.headerHeight);
        ctx.restore();
      }
      ctx.fillStyle = this.colorText;
      const label = `${this.columns[columnIndex].label}${
        this.columns[columnIndex].sortDirection === 1
          ? " ▲"
          : this.columns[columnIndex].sortDirection === -1
            ? " ▼"
            : ""
      }`;
      ctx.fillText(
        this.fitText(
          label,
          this.columnWidths[columnIndex] - CELL_PADDING_X * 2,
        ),
        x + CELL_PADDING_X,
        this.headerHeight / 2,
      );
    }
    ctx.restore();
  }

  drawCorner(ctx) {
    ctx.fillStyle = this.colorHeader;
    ctx.fillRect(0, 0, this.rowHeaderWidth, this.headerHeight);
    ctx.strokeStyle = this.colorBorder;
    ctx.beginPath();
    ctx.moveTo(Math.round(this.rowHeaderWidth) + 0.5, 0);
    ctx.lineTo(Math.round(this.rowHeaderWidth) + 0.5, this.viewHeight);
    ctx.moveTo(0, Math.round(this.headerHeight) + 0.5);
    ctx.lineTo(this.viewWidth, Math.round(this.headerHeight) + 0.5);
    ctx.stroke();
  }

  drawActiveOutline(ctx, scrollLeft, scrollTop) {
    if (!this.focused || !this.selection || this.selectionMode !== "cell")
      return;
    const active = this.activeCell();
    const x = this.columnStarts[active.column] - scrollLeft;
    const rowHeight = this.rowSize(active.row);
    const y = this.headerHeight + this.rowOffset(active.row) - scrollTop;
    ctx.strokeStyle = this.colorAccent;
    ctx.lineWidth = 2;
    ctx.strokeRect(
      x + 1,
      y + 1,
      this.columnWidths[active.column] - 2,
      rowHeight - 2,
    );
  }

  gridSize() {
    return { rows: this.rowCount, columns: this.columns.length };
  }

  clampCell(row, column) {
    return {
      row: clamp(row, 0, Math.max(0, this.rowCount - 1)),
      column: clamp(column, 0, Math.max(0, this.columns.length - 1)),
    };
  }

  clampSelection(selection) {
    const first = this.clampCell(selection.r0, selection.c0);
    const last = this.clampCell(selection.r1, selection.c1);
    return { r0: first.row, c0: first.column, r1: last.row, c1: last.column };
  }

  activeCell() {
    if (this.activeOverride)
      return this.clampCell(
        this.activeOverride.row,
        this.activeOverride.column,
      );
    if (!this.selection) return { row: 0, column: 0 };
    if (this.selectionMode === "row")
      return this.clampCell(this.selection.r1, 0);
    if (this.selectionMode === "column")
      return this.clampCell(0, this.selection.c1);
    if (this.selectionMode === "all") return { row: 0, column: 0 };
    return this.clampCell(this.selection.r1, this.selection.c1);
  }

  normalizedSelections() {
    return this.selections.map((selection) => ({
      r0: Math.min(selection.r0, selection.r1),
      r1: Math.max(selection.r0, selection.r1),
      c0: Math.min(selection.c0, selection.c1),
      c1: Math.max(selection.c0, selection.c1),
    }));
  }

  selectionFromHit(hit) {
    if (hit.zone === "corner")
      return {
        mode: "all",
        selection: {
          r0: 0,
          c0: 0,
          r1: this.rowCount - 1,
          c1: this.columns.length - 1,
        },
      };
    if (hit.zone === "row")
      return {
        mode: "row",
        selection: {
          r0: hit.row,
          c0: 0,
          r1: hit.row,
          c1: this.columns.length - 1,
        },
      };
    if (hit.zone === "column")
      return {
        mode: "column",
        selection: {
          r0: 0,
          c0: hit.column,
          r1: this.rowCount - 1,
          c1: hit.column,
        },
      };
    return {
      mode: "cell",
      selection: { r0: hit.row, c0: hit.column, r1: hit.row, c1: hit.column },
    };
  }

  startSelection(hit, append = false, announce = true) {
    if (this.rowCount === 0 || this.columns.length === 0) return;
    const result = this.selectionFromHit(hit);
    this.activeOverride = null;
    this.selectionMode = result.mode;
    this.selection = result.selection;
    this.selections = append
      ? [...this.selections, this.selection]
      : [this.selection];
    this.selectionChanged(announce);
  }

  extendSelection(hit, announce = true) {
    if (!this.selection) return this.startSelection(hit, false, announce);
    this.activeOverride = null;
    if (this.selectionMode === "row") {
      this.selection.r1 = hit.row;
      this.selection.c0 = 0;
      this.selection.c1 = this.columns.length - 1;
    } else if (this.selectionMode === "column") {
      this.selection.c1 = hit.column;
      this.selection.r0 = 0;
      this.selection.r1 = this.rowCount - 1;
    } else if (this.selectionMode !== "all") {
      this.selection.r1 = hit.row;
      this.selection.c1 = hit.column;
    }
    this.selectionChanged(announce);
  }

  clearSelection(announce = true) {
    this.activeOverride = null;
    this.selection = null;
    this.selections = [];
    if (announce) this.liveRegion.textContent = "Selection cleared";
    this.selectionChanged(false);
  }

  selectionChanged(announce = true) {
    this.updateAria();
    if (announce) this.announceSelection();
    const snapshot = this.normalizedSelections().map((selection) => ({
      ...selection,
      r0: this.absoluteRow(selection.r0),
      r1: this.absoluteRow(selection.r1),
      windowR0: selection.r0,
      windowR1: selection.r1,
    }));
    const active = this.publicActiveCell();
    for (const callback of this.selectionCallbacks) callback(snapshot, active);
    this.options.onSelectionChange?.(snapshot, active);
    this.scheduleDraw("overlay");
  }

  setSelections(
    selections = [],
    active = null,
    { mode = "cell", announce = false } = {},
  ) {
    this.selectionMode = mode;
    this.selections = selections.map((selection) =>
      this.clampSelection({
        r0: selection.r0,
        c0: selection.c0,
        r1: selection.r1,
        c1: selection.c1,
      }),
    );
    this.selection = this.selections.at(-1) || null;
    this.activeOverride = active
      ? this.clampCell(active.row, active.column)
      : null;
    this.updateAria();
    if (announce) this.announceSelection();
    this.scheduleDraw("overlay");
  }

  setHighlights(highlights = [], current = null) {
    this.highlights = highlights.map((cell) => ({
      row: cell.row ?? cell.r,
      column: cell.column ?? cell.c,
    }));
    this.currentHighlight = current
      ? { row: current.row ?? current.r, column: current.column ?? current.c }
      : null;
    this.scheduleDraw("overlay");
  }

  setHighlightRow(row = null) {
    this.highlightRow = row;
    this.scheduleDraw("overlay");
  }

  selectCells(cells = []) {
    if (!cells.length) return;
    const selections = cells.map((cell) => ({
      r0: cell.row ?? cell.r,
      c0: cell.column ?? cell.c,
      r1: cell.row ?? cell.r,
      c1: cell.column ?? cell.c,
    }));
    const last = selections.at(-1);
    this.setSelections(selections, { row: last.r1, column: last.c1 });
    const first = selections[0];
    this.scrollCellIntoView(first.r0, first.c0);
  }

  revealCell(cell) {
    if (!cell) return;
    const row = cell.row ?? cell.r;
    const column = cell.column ?? cell.c;
    this.moveActiveSelectionTo(row, column);
  }

  captureState() {
    return {
      selection: this.selection ? { ...this.selection } : null,
      selections: this.selections.map((selection) => ({ ...selection })),
      selectionMode: this.selectionMode,
      active: this.activeOverride ? { ...this.activeOverride } : null,
      scrollTop: this.element.scrollTop,
      scrollLeft: this.element.scrollLeft,
    };
  }

  restoreState(state) {
    if (!state) return;
    this.selection = state.selection
      ? this.clampSelection(state.selection)
      : null;
    this.selections = (state.selections || []).map((selection) =>
      this.clampSelection(selection),
    );
    this.selectionMode = state.selectionMode || "cell";
    this.activeOverride = state.active
      ? this.clampCell(state.active.row, state.active.column)
      : null;
    this.element.scrollTop = Number(state.scrollTop) || 0;
    this.element.scrollLeft = Number(state.scrollLeft) || 0;
    this.updateAria();
    this.scheduleDraw();
  }

  onDidChangeSelection(callback) {
    this.selectionCallbacks.add(callback);
    return disposable(() => this.selectionCallbacks.delete(callback));
  }

  announceSelection() {
    if (!this.selection) return;
    const selection = this.normalizedSelections().at(-1);
    const firstRow = this.absoluteRow(selection.r0);
    const lastRow = this.absoluteRow(selection.r1);
    const rows =
      firstRow === lastRow
        ? `row ${firstRow + 1}`
        : `rows ${firstRow + 1} to ${lastRow + 1}`;
    const columns =
      selection.c0 === selection.c1
        ? `column ${this.columns[selection.c0]?.label || selection.c0 + 1}`
        : `columns ${this.columns[selection.c0]?.label || selection.c0 + 1} to ${this.columns[selection.c1]?.label || selection.c1 + 1}`;
    this.liveRegion.textContent = `Selected ${rows}, ${columns}`;
  }

  updateAria() {
    this.element.setAttribute("aria-rowcount", String(this.totalRows ?? -1));
    this.element.setAttribute("aria-colcount", String(this.columns.length));
    const active = this.activeCell();
    if (this.rowCount === 0 || this.columns.length === 0) {
      this.ariaCell.removeAttribute("aria-rowindex");
      this.ariaCell.removeAttribute("aria-colindex");
      this.ariaCell.textContent = "No rows";
      return;
    }
    const column = this.columns[active.column];
    const state = this.rowState(active.row);
    const text =
      column && state.status === "loaded"
        ? this.valueText(state.row, column, active.row)
        : "Loading";
    const absoluteRow = this.absoluteRow(active.row);
    this.ariaCell.setAttribute(
      "aria-selected",
      this.selection ? "true" : "false",
    );
    if (this.selectionMode === "column") {
      this.ariaCell.setAttribute("role", "columnheader");
      this.ariaCell.removeAttribute("aria-rowindex");
      this.ariaCell.setAttribute("aria-colindex", String(active.column + 1));
      this.ariaCell.textContent = `Column ${column?.label || active.column + 1}`;
      return;
    }
    if (this.selectionMode === "row") {
      this.ariaCell.setAttribute("role", "rowheader");
      this.ariaCell.setAttribute("aria-rowindex", String(absoluteRow + 1));
      this.ariaCell.removeAttribute("aria-colindex");
      this.ariaCell.textContent = `Row ${absoluteRow + 1}`;
      return;
    }
    this.ariaCell.setAttribute("role", "gridcell");
    this.ariaCell.setAttribute("aria-rowindex", String(absoluteRow + 1));
    this.ariaCell.setAttribute("aria-colindex", String(active.column + 1));
    const total = this.totalRows == null ? "an unknown total" : this.totalRows;
    this.ariaCell.textContent = `${column?.label || `Column ${active.column + 1}`}, row ${absoluteRow + 1} of ${total}: ${text}`;
  }

  publicActiveCell() {
    const active = this.activeCell();
    return {
      row: this.absoluteRow(active.row),
      column: active.column,
      windowRow: active.row,
    };
  }

  pageRowCount() {
    const { firstRow, lastRow } = this.visibleRange();
    return Math.max(1, lastRow - firstRow);
  }

  moveActiveSelection(deltaRow, deltaColumn, extend = false) {
    if (this.rowCount === 0 || this.columns.length === 0) return;
    const active = this.activeCell();
    const targetRow = active.row + deltaRow;
    if (targetRow < 0 && this.requestBoundary(-1, "keyboard", extend)) return;
    if (
      targetRow >= this.rowCount &&
      this.requestBoundary(1, "keyboard", extend)
    )
      return;
    this.moveActiveSelectionTo(
      active.row + deltaRow,
      active.column + deltaColumn,
      extend,
    );
  }

  moveToEnd(extend = false) {
    if (
      this.windowMode &&
      typeof this.options.onRequestEnd === "function" &&
      (this.totalRows == null || this.baseRow + this.rowCount < this.totalRows)
    ) {
      if (this.requestedEnd) return;
      this.requestedEnd = true;
      const active = this.activeCell();
      this.pendingNavigation = {
        absoluteRow: this.totalRows == null ? null : this.totalRows - 1,
        column: this.columns.length - 1,
        direction: 1,
        extend,
        end: true,
      };
      const context = {
        baseRow: this.baseRow,
        rows: this.windowRows.slice(),
        pageSize: this.pageSize,
        totalRows: this.totalRows,
        activeRow: this.absoluteRow(active.row),
        activeColumn: active.column,
      };
      try {
        const result = this.options.onRequestEnd?.(context);
        if (result?.then) {
          result
            .then((windowState) => this.maybeApplyWindow(windowState))
            .catch((error) => {
              this.requestedEnd = false;
              this.options.onError?.(error, { reason: "end" });
            });
        } else this.maybeApplyWindow(result);
      } catch (error) {
        this.requestedEnd = false;
        this.options.onError?.(error, { reason: "end" });
      }
      return;
    }
    this.moveActiveSelectionTo(
      this.rowCount - 1,
      this.columns.length - 1,
      extend,
    );
  }

  moveActiveSelectionTo(row, column, extend = false) {
    if (this.rowCount === 0 || this.columns.length === 0) return;
    const active = this.activeCell();
    const target = this.clampCell(
      row == null ? active.row : row,
      column == null ? active.column : column,
    );
    const hit = { zone: "body", row: target.row, column: target.column };
    if (extend && this.selection) this.extendSelection(hit);
    else this.startSelection(hit);
    this.scrollCellIntoView(target.row, target.column);
    this.requestVisiblePages();
  }

  navigate(deltaRow, deltaColumn) {
    if (this.rowCount === 0 || this.columns.length === 0) return;
    if (!this.selection) return this.moveActiveSelection(deltaRow, deltaColumn);
    const active = this.activeCell();
    if (this.selectionMode === "all") {
      if (deltaColumn > 0) this.selectColumnAt(0);
      else if (deltaRow > 0) this.selectRowAt(0);
      return;
    }
    if (this.selectionMode === "row") {
      if (deltaRow < 0 && active.row === 0) this.selectAll();
      else if (deltaRow !== 0) this.selectRowAt(active.row + deltaRow);
      else if (deltaColumn > 0) this.moveActiveSelectionTo(active.row, 0);
      return;
    }
    if (this.selectionMode === "column") {
      if (deltaColumn < 0 && active.column === 0) this.selectAll();
      else if (deltaColumn !== 0)
        this.selectColumnAt(active.column + deltaColumn);
      else if (deltaRow > 0) this.moveActiveSelectionTo(0, active.column);
      return;
    }
    if (deltaColumn < 0 && active.column === 0) this.selectRowAt(active.row);
    else if (deltaRow < 0 && active.row === 0)
      this.selectColumnAt(active.column);
    else this.moveActiveSelection(deltaRow, deltaColumn);
  }

  selectRowAt(row) {
    if (!this.rowCount || !this.columns.length) return;
    if (row < 0 && this.requestBoundary(-1, "keyboard")) return;
    if (row >= this.rowCount && this.requestBoundary(1, "keyboard")) return;
    const target = this.clampCell(row, 0);
    this.startSelection({ zone: "row", row: target.row, column: 0 });
    this.scrollRowIntoView(target.row);
  }

  selectColumnAt(column) {
    if (!this.rowCount || !this.columns.length) return;
    const target = this.clampCell(0, column);
    this.startSelection({ zone: "column", row: 0, column: target.column });
    this.scrollColumnIntoView(target.column);
  }

  selectAll() {
    if (!this.rowCount || !this.columns.length) return;
    this.startSelection({ zone: "corner", row: 0, column: 0 });
  }

  selectActiveRow() {
    this.selectRowAt(this.activeCell().row);
  }

  selectActiveColumn() {
    this.selectColumnAt(this.activeCell().column);
  }

  scrollRowIntoView(row) {
    if (!this.viewHeight) return;
    const top = this.logicalScrollTop();
    const cellTop = this.rowOffset(row);
    const cellBottom = cellTop + this.rowSize(row);
    const bodyHeight = this.viewHeight - this.headerHeight;
    let target = top;
    if (cellTop < top) target = cellTop;
    else if (cellBottom > top + bodyHeight) target = cellBottom - bodyHeight;
    this.element.scrollTop = this.physicalScrollTop(target);
  }

  scrollColumnIntoView(column) {
    if (!this.viewWidth || !this.columnStarts) return;
    const left = this.columnStarts[column];
    const right = this.columnStarts[column + 1];
    if (left - this.element.scrollLeft < this.rowHeaderWidth) {
      this.element.scrollLeft = Math.max(0, left - this.rowHeaderWidth);
    } else if (right - this.element.scrollLeft > this.viewWidth) {
      this.element.scrollLeft = right - this.viewWidth;
    }
  }

  scrollCellIntoView(row, column) {
    this.scrollRowIntoView(row);
    this.scrollColumnIntoView(column);
  }

  columnAtContentX(contentX) {
    if (!this.columns.length) return -1;
    return clamp(
      lowerBound(this.columnStarts, contentX + 0.001) - 1,
      0,
      this.columns.length - 1,
    );
  }

  hit(clientX, clientY, shouldClamp = false) {
    if (!this.rowCount || !this.columns.length) return null;
    const rect = this.element.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    if (
      !shouldClamp &&
      (x < 0 || y < 0 || x > this.viewWidth || y > this.viewHeight)
    )
      return null;
    const row = clamp(
      this.rowMetrics.indexAt(
        Math.max(y, this.headerHeight) -
          this.headerHeight +
          this.logicalScrollTop(),
      ),
      0,
      this.rowCount - 1,
    );
    const contentX = Math.max(x, this.rowHeaderWidth) + this.element.scrollLeft;
    const column = this.columnAtContentX(contentX);
    let zone = "body";
    if (x < this.rowHeaderWidth && y < this.headerHeight) zone = "corner";
    else if (x < this.rowHeaderWidth) zone = "row";
    else if (y < this.headerHeight) zone = "column";
    return { zone, row, column };
  }

  resizeHit(clientX, clientY) {
    if (!this.columnStarts) return null;
    const rect = this.element.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    if (
      this.options.resizableRows &&
      x < this.rowHeaderWidth &&
      y >= this.headerHeight
    ) {
      const contentY = y - this.headerHeight + this.logicalScrollTop();
      const row = this.rowMetrics.indexAt(Math.max(0, contentY - RESIZE_GRIP));
      const edge =
        this.headerHeight + this.rowOffset(row + 1) - this.logicalScrollTop();
      if (Math.abs(y - edge) <= RESIZE_GRIP) return { row };
      return null;
    }
    if (y >= this.headerHeight) return null;
    if (Math.abs(x - this.rowHeaderWidth) <= RESIZE_GRIP)
      return { rowHeader: true };
    const contentX = x + this.element.scrollLeft;
    const boundary = lowerBound(this.columnStarts, contentX - RESIZE_GRIP);
    for (
      let index = Math.max(1, boundary - 1);
      index < Math.min(this.columnStarts.length, boundary + 2);
      index++
    ) {
      if (Math.abs(contentX - this.columnStarts[index]) <= RESIZE_GRIP)
        return { column: index - 1 };
    }
    return null;
  }

  handleMouseMove(event) {
    if (this.resizeState || this.dragging) return;
    const resize = this.resizeHit(event.clientX, event.clientY);
    this.element.style.cursor =
      resize?.row != null ? "row-resize" : resize ? "col-resize" : "";
    if (resize) {
      this.element.title = "";
      return;
    }
    const hit = this.hit(event.clientX, event.clientY, false);
    if (!hit || hit.zone !== "body") {
      this.element.title = "";
      return;
    }
    const state = this.rowState(hit.row);
    if (state.status !== "loaded") {
      this.element.title = "";
      return;
    }
    const text = this.valueText(state.row, this.columns[hit.column], hit.row);
    this.ctx.font = this.font;
    this.element.title =
      this.ctx.measureText(text).width >
      this.columnWidths[hit.column] - CELL_PADDING_X * 2
        ? text
        : "";
  }

  handleMouseDown(event) {
    if (event.button !== 0) return;
    const resize = this.resizeHit(event.clientX, event.clientY);
    if (resize) {
      this.resizeState = {
        hit: resize,
        startX: event.clientX,
        startY: event.clientY,
        startSize:
          resize.row != null
            ? this.rowSize(resize.row)
            : resize.rowHeader
              ? this.rowHeaderWidth
              : this.columnWidths[resize.column],
      };
      window.addEventListener("mousemove", this.handlers.resizeMousemove);
      window.addEventListener("mouseup", this.handlers.resizeMouseup);
      event.preventDefault();
      return;
    }
    this.element.focus({ preventScroll: true });
    const hit = this.hit(event.clientX, event.clientY, false);
    if (!hit) return this.clearSelection();
    if (this.options.onPointerDown?.(hit, event) === false) {
      event.preventDefault();
      return;
    }
    if (event.shiftKey && this.selection) this.extendSelection(hit);
    else
      this.startSelection(
        hit,
        Boolean((event.ctrlKey || event.metaKey) && this.selections.length),
      );
    this.dragging = true;
    window.addEventListener("mousemove", this.handlers.windowMousemove);
    window.addEventListener("mouseup", this.handlers.windowMouseup);
    event.preventDefault();
  }

  handleWindowMouseMove(event) {
    if (!this.dragging) return;
    this.lastDragPoint = { clientX: event.clientX, clientY: event.clientY };
    const hit = this.hit(event.clientX, event.clientY, true);
    if (hit) this.extendSelection(hit, false);
    this.scheduleDragScroll();
  }

  handleWindowMouseUp() {
    if (!this.dragging) return;
    this.dragging = false;
    this.lastDragPoint = null;
    if (this.dragScrollHandle != null) {
      this.cancelFrame(this.dragScrollHandle);
      this.dragScrollHandle = null;
    }
    window.removeEventListener("mousemove", this.handlers.windowMousemove);
    window.removeEventListener("mouseup", this.handlers.windowMouseup);
    this.announceSelection();
  }

  scheduleDragScroll() {
    if (this.dragScrollHandle != null || !this.dragging || !this.lastDragPoint)
      return;
    const rect = this.element.getBoundingClientRect();
    const threshold = Math.max(16, this.options.dragScrollThreshold || 32);
    const speed = Math.max(1, this.options.dragScrollSpeed || 20);
    const axisDelta = (position, start, end) => {
      if (position < start + threshold)
        return -speed * Math.min(1, (start + threshold - position) / threshold);
      if (position > end - threshold)
        return speed * Math.min(1, (position - (end - threshold)) / threshold);
      return 0;
    };
    const deltaX = axisDelta(this.lastDragPoint.clientX, rect.left, rect.right);
    const deltaY = axisDelta(this.lastDragPoint.clientY, rect.top, rect.bottom);
    if (!deltaX && !deltaY) return;
    this.dragScrollHandle = this.requestFrame(() => {
      this.dragScrollHandle = null;
      if (!this.dragging || !this.lastDragPoint) return;
      const oldLeft = this.element.scrollLeft;
      const oldTop = this.element.scrollTop;
      this.element.scrollLeft = clamp(
        oldLeft + deltaX,
        0,
        Math.max(0, this.totalWidth - this.viewWidth),
      );
      this.element.scrollTop = clamp(
        oldTop + deltaY,
        0,
        this.physicalMaxScroll(),
      );
      if (
        this.element.scrollLeft === oldLeft &&
        this.element.scrollTop === oldTop
      )
        return;
      this.handleScroll();
      const hit = this.hit(
        this.lastDragPoint.clientX,
        this.lastDragPoint.clientY,
        true,
      );
      if (hit) this.extendSelection(hit, false);
      this.scheduleDragScroll();
    });
  }

  handleResizeMove(event) {
    if (!this.resizeState) return;
    if (this.resizeState.hit.row != null) {
      const height = Math.max(
        this.options.minimumRowHeight || 8,
        this.resizeState.startSize + event.clientY - this.resizeState.startY,
      );
      this.rowMetrics.setSize(this.resizeState.hit.row, height);
      this.applyColumnWidths();
      return;
    }
    const width = Math.max(
      MIN_RESIZED_COLUMN_WIDTH,
      this.resizeState.startSize + event.clientX - this.resizeState.startX,
    );
    if (this.resizeState.hit.rowHeader) {
      this.rowHeaderWidthOverride = width;
      this.rowHeaderWidth = width;
    } else {
      this.columnWidthOverrides.set(this.resizeState.hit.column, width);
      this.columnWidths[this.resizeState.hit.column] = width;
    }
    this.applyColumnWidths();
  }

  handleResizeUp() {
    const completed = this.resizeState;
    this.resizeState = null;
    window.removeEventListener("mousemove", this.handlers.resizeMousemove);
    window.removeEventListener("mouseup", this.handlers.resizeMouseup);
    if (completed?.hit.row != null) {
      const row = completed.hit.row;
      this.options.onRowResize?.({
        row: this.absoluteRow(row),
        windowRow: row,
        height: this.rowSize(row),
      });
    } else if (completed?.hit.rowHeader) {
      this.options.onColumnResize?.({
        rowHeader: true,
        width: this.rowHeaderWidth,
      });
    } else if (completed?.hit.column != null) {
      const index = completed.hit.column;
      this.options.onColumnResize?.({
        index,
        column: this.columns[index],
        width: this.columnWidths[index],
      });
    }
  }

  handleDoubleClick(event) {
    const hit = this.hit(event.clientX, event.clientY, false);
    if (hit && typeof this.options.onDoubleClick === "function") {
      this.options.onDoubleClick(hit, event);
      return;
    }
    if (hit?.zone === "column") {
      this.startSelection(hit);
      this.confirmActiveCell();
    } else if (hit?.zone === "body") {
      this.startSelection(hit);
      this.confirmActiveCell();
    }
  }

  handleKeyDown(event) {
    if (
      (event.ctrlKey || event.metaKey) &&
      String(event.key).toLowerCase() === "c" &&
      this.selections.length
    ) {
      this.copySelection();
      event.preventDefault();
      event.stopImmediatePropagation?.();
    }
  }

  async confirmActiveCell() {
    if (!this.selection) return;
    const active = this.activeCell();
    if (this.selectionMode === "column") {
      this.options.onSort?.(this.columns[active.column], active.column);
      return;
    }
    let row;
    try {
      row = await this.rowAt(active.row);
    } catch (error) {
      this.options.onError?.(error, {
        operation: "confirm",
        row: this.absoluteRow(active.row),
      });
      return;
    }
    if (this.destroyed) return;
    this.options.onConfirm?.({
      row: this.absoluteRow(active.row),
      windowRow: active.row,
      column: active.column,
      columnDefinition: this.columns[active.column],
      value: rowValue(row, this.columns[active.column]),
      record: row,
    });
  }

  reportCopyLimit(reason, details) {
    const information = {
      reason,
      maxCells: this.maxCopyCells,
      maxBytes: this.maxCopyBytes,
      ...details,
    };
    this.liveRegion.textContent = "The selection is too large to copy";
    if (typeof this.options.onCopyLimit === "function") {
      this.options.onCopyLimit(information);
    } else {
      const error = new RangeError(
        reason === "cells"
          ? `The selection exceeds the ${this.maxCopyCells}-cell copy limit`
          : `The selection exceeds the ${this.maxCopyBytes}-byte copy limit`,
      );
      if (typeof this.options.onError === "function") {
        this.options.onError(error, { operation: "copy", ...information });
      } else {
        globalThis.lumine?.notifications?.addWarning?.(
          "Selection is too large to copy",
          {
            description: error.message,
          },
        );
      }
    }
  }

  async copySelection() {
    const selections = this.normalizedSelections();
    if (!selections.length) return null;
    const cellCount = selections.reduce(
      (count, selection) =>
        count +
        (selection.r1 - selection.r0 + 1) * (selection.c1 - selection.c0 + 1),
      0,
    );
    if (cellCount > this.maxCopyCells) {
      this.reportCopyLimit("cells", { cells: cellCount, bytes: 0 });
      return null;
    }
    const lines = [];
    let byteCount = 0;
    for (const selection of selections) {
      for (let rowIndex = selection.r0; rowIndex <= selection.r1; rowIndex++) {
        let row;
        try {
          row = await this.rowAt(rowIndex);
        } catch (error) {
          this.options.onError?.(error, {
            operation: "copy",
            row: this.absoluteRow(rowIndex),
          });
          this.requestVisiblePages();
          return null;
        }
        if (this.destroyed) return null;
        const cells = [];
        for (
          let columnIndex = selection.c0;
          columnIndex <= selection.c1;
          columnIndex++
        ) {
          const column = this.columns[columnIndex];
          let value = rowValue(row, column);
          if (typeof this.options.resolveCell === "function") {
            try {
              value = await this.options.resolveCell({
                absoluteRow: this.absoluteRow(rowIndex),
                windowRow: rowIndex,
                column,
                columnIndex,
                record: row,
                value,
              });
            } catch (error) {
              this.options.onError?.(error, {
                operation: "copy",
                row: this.absoluteRow(rowIndex),
                column: columnIndex,
              });
              this.requestVisiblePages();
              return null;
            }
          }
          const text = this.valueText(row, column, rowIndex, value);
          byteCount += utf8ByteLength(text) + (cells.length ? 1 : 0);
          if (byteCount > this.maxCopyBytes) {
            this.reportCopyLimit("bytes", {
              cells: cellCount,
              bytes: byteCount,
            });
            this.requestVisiblePages();
            return null;
          }
          cells.push(text);
        }
        if (lines.length) byteCount += 1;
        if (byteCount > this.maxCopyBytes) {
          this.reportCopyLimit("bytes", { cells: cellCount, bytes: byteCount });
          this.requestVisiblePages();
          return null;
        }
        lines.push(cells.join("\t"));
      }
    }
    const text = lines.join("\n");
    if (typeof this.clipboard?.write === "function") this.clipboard.write(text);
    else await this.clipboard?.writeText?.(text);
    this.requestVisiblePages();
    return text;
  }

  focus() {
    this.element.focus({ preventScroll: true });
  }

  setBusy(busy) {
    this.element.setAttribute("aria-busy", busy ? "true" : "false");
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.frameHandle != null) this.cancelFrame(this.frameHandle);
    if (this.dragScrollHandle != null) this.cancelFrame(this.dragScrollHandle);
    this.resizeObserver?.disconnect?.();
    this.commandDisposable?.dispose?.();
    for (const item of this.disposables) item.dispose?.();
    this.cache.destroy();
    this.element.removeEventListener("scroll", this.handlers.scroll);
    this.element.removeEventListener("focus", this.handlers.focus);
    this.element.removeEventListener("blur", this.handlers.blur);
    this.element.removeEventListener("mousedown", this.handlers.mousedown);
    this.element.removeEventListener("mousemove", this.handlers.mousemove);
    this.element.removeEventListener("dblclick", this.handlers.dblclick);
    this.element.removeEventListener("contextmenu", this.handlers.contextmenu);
    this.element.removeEventListener("keydown", this.handlers.keydown);
    this.canvas.removeEventListener("contextlost", this.handlers.contextlost);
    this.canvas.removeEventListener(
      "contextrestored",
      this.handlers.contextrestored,
    );
    this.overlayCanvas.removeEventListener(
      "contextlost",
      this.handlers.contextlost,
    );
    this.overlayCanvas.removeEventListener(
      "contextrestored",
      this.handlers.contextrestored,
    );
    window.removeEventListener("mousemove", this.handlers.windowMousemove);
    window.removeEventListener("mouseup", this.handlers.windowMouseup);
    window.removeEventListener("mousemove", this.handlers.resizeMousemove);
    window.removeEventListener("mouseup", this.handlers.resizeMouseup);
    this.selectionCallbacks.clear();
    this.textFitCache.clear();
    this.element.remove();
  }
}

module.exports = {
  AxisMetrics,
  CanvasGrid,
  PagedRowCache,
  MAX_CACHED_PAGES,
  MAX_COPY_CELLS,
  MAX_COPY_BYTES,
  formatCell,
  lowerBound,
};
