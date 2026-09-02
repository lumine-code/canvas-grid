const AxisMetrics = require("./axis-metrics");
const {
  CELL_PADDING_X,
  DEFAULT_PAGE_SIZE,
  MAX_CACHED_PAGES,
  MAX_COLUMN_WIDTH,
  MAX_COPY_BYTES,
  MAX_COPY_CELLS,
  MAX_FIT_CACHE,
  MAX_SCROLL_HEIGHT,
  MIN_COLUMN_WIDTH,
  MIN_RESIZED_COLUMN_WIDTH,
  SAMPLE_ROWS,
} = require("./constants");
const GridGeometry = require("./grid-geometry");
const installGridRenderer = require("./grid-renderer");
const {
  clamp,
  disposable,
  formatCell,
  lowerBound,
  normalizeColumns,
  normalizeInteger,
  normalizeNullableCount,
  rowValue,
  setHiddenAccessibleStyle,
  utf8ByteLength,
} = require("./grid-utils");
const PagedRowCache = require("./paged-row-cache");
const {
  clampCell,
  clampSelection,
  normalizeSelection,
  orientSelectionToActive,
  selectionFromHit,
} = require("./selection");
const { contextSortColumn, isSortDirection } = require("./sort");

let nextGridId = 1;

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
    this.scrollCallbacks = new Set();
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
      onDidError: (error, page) => this.options.onError?.(error, page),
    });
    this.readTheme();
    const ownsRowMetrics = !(options.rowMetrics instanceof AxisMetrics);
    const rowMetrics =
      options.rowMetrics ||
      new AxisMetrics({
        count: this.rowCount,
        defaultSize: this.rowHeight,
        sizes: options.rowHeights,
      });
    this.geometry = new GridGeometry(this);
    this.setRowMetrics(rowMetrics, { owned: ownsRowMetrics });
    if (options.rowHeights) this.syncRowMetrics(options.rowHeights);
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
      overflow: "hidden",
      minWidth: "0",
      minHeight: "0",
      outline: "none",
    });

    this.scrollElement = document.createElement("div");
    this.scrollElement.className = "canvas-grid-scroll";
    Object.assign(this.scrollElement.style, {
      position: "absolute",
      right: "0",
      bottom: "0",
      overflow: "auto",
      zIndex: "1",
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
    this.scrollElement.appendChild(this.sizer);

    this.viewport = document.createElement("div");
    this.viewport.className = "canvas-grid-viewport";
    this.viewport.setAttribute("aria-hidden", "true");
    Object.assign(this.viewport.style, {
      position: "absolute",
      top: "0",
      left: "0",
      display: "block",
      pointerEvents: "none",
      zIndex: "0",
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
      this.scrollElement,
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
      contextmenu: (event) => {
        const hit = this.hit(event.clientX, event.clientY, false);
        this.contextTarget = hit;
        this.options.onContextMenu?.(hit, event);
      },
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
    this.scrollElement.addEventListener("scroll", this.handlers.scroll);
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
      event?.stopImmediatePropagation?.();
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
      [`${prefix}:grid-sort-ascending`]: described(
        "Sort the current column in ascending order.",
        command(() => this.requestContextSort("ascending", "command")),
      ),
      [`${prefix}:grid-sort-descending`]: described(
        "Sort the current column in descending order.",
        command(() => this.requestContextSort("descending", "command")),
      ),
      [`${prefix}:grid-clear-sort`]: described(
        "Clear the current sort order.",
        command(() => this.requestContextSort("clear", "command")),
      ),
    };
    this.commandDisposable = commands.add(this.element, map);
  }

  updateOptions(patch = {}) {
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
      throw new TypeError("CanvasGrid options patch must be an object");
    }
    Object.assign(this.options, patch);
    if (Object.hasOwn(patch, "ariaLabel")) {
      this.element.setAttribute("aria-label", patch.ariaLabel || "Data grid");
    }
    if (Object.hasOwn(patch, "busy")) this.setBusy(patch.busy);
    if (Object.hasOwn(patch, "clipboard")) {
      this.clipboard =
        patch.clipboard ||
        globalThis.lumine?.clipboard ||
        globalThis.navigator?.clipboard;
    }
    if (Object.hasOwn(patch, "maxCopyCells")) {
      this.maxCopyCells = Math.min(
        MAX_COPY_CELLS,
        normalizeInteger(patch.maxCopyCells, MAX_COPY_CELLS, 1),
      );
    }
    if (Object.hasOwn(patch, "maxCopyBytes")) {
      this.maxCopyBytes = Math.min(
        MAX_COPY_BYTES,
        normalizeInteger(patch.maxCopyBytes, MAX_COPY_BYTES, 1),
      );
    }
    if (Object.hasOwn(patch, "columnOverscan")) {
      this.columnOverscan = normalizeInteger(patch.columnOverscan, 2);
      this.lastVisibleColumnsKey = null;
      this.notifyVisibleColumns();
    }
    this.updateAria();
    this.scheduleDraw();
    return this;
  }

  setResizable({ columns, rows } = {}) {
    if (columns != null) this.options.resizableColumns = Boolean(columns);
    if (rows != null) this.options.resizableRows = Boolean(rows);
    if (this.resizeState) this.handleResizeUp();
    return {
      columns: this.options.resizableColumns !== false,
      rows: Boolean(this.options.resizableRows),
    };
  }

  readTheme() {
    const previousFont = this.font;
    const style = this.getStyle(this.element);
    const value = (name, fallback) =>
      style?.getPropertyValue?.(name)?.trim() || fallback;
    const gridValue = (name, fallback) =>
      value(`--canvas-grid-${name}`, value(`--data-grid-${name}`, fallback));
    const gridPixels = (name, fallback) => {
      const parsed = Number.parseFloat(gridValue(name, ""));
      return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
    };
    this.fontSize = Number.parseFloat(style?.fontSize) || 12;
    this.fontFamily = style?.fontFamily || "monospace";
    this.font = `${this.fontSize}px ${this.fontFamily}`;
    if (previousFont && previousFont !== this.font) {
      this.autoColumnWidths = [];
      this.textFitCache.clear();
    }
    this.rowHeight = gridPixels("row-height", 24);
    this.headerHeight = gridPixels("header-height", 24);
    this.colorText = gridValue(
      "text-color",
      value("--text-color", style?.color || "#ccc"),
    );
    this.colorMuted = gridValue(
      "muted-color",
      value("--text-color-subtle", this.colorText),
    );
    this.colorNull = gridValue("null-color", this.colorMuted);
    this.colorBorder = gridValue(
      "border-color",
      value("--base-border-color", "rgba(128,128,128,0.35)"),
    );
    this.scrollElement.style.borderTop = `1px solid ${this.colorBorder}`;
    this.scrollElement.style.borderLeft = `1px solid ${this.colorBorder}`;
    this.colorHeader = gridValue(
      "header-color",
      value("--background-color-highlight", "#2a2a2a"),
    );
    this.colorAccent = gridValue(
      "accent-color",
      value("--accent-color", "#4b9cff"),
    );
    this.colorHighlight = gridValue("highlight-color", this.colorAccent);
    this.colorCurrentHighlight = gridValue(
      "current-highlight-color",
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

  setRowMetrics(metrics, { owned = false } = {}) {
    if (!(metrics instanceof AxisMetrics)) {
      throw new TypeError("CanvasGrid row metrics must be an AxisMetrics");
    }
    this.rowMetrics = metrics;
    this.ownsRowMetrics = Boolean(owned);
    if (this.ownsRowMetrics && this.rowHeight != null) {
      this.rowMetrics.setDefaultSize(this.rowHeight);
    }
    if (this.rowMetrics.count !== this.rowCount) {
      this.rowMetrics.setItems(this.rowCount, this.rowMetrics.toArray());
    }
    if (this.columnWidths) this.applyColumnWidths();
    return this.rowMetrics;
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
        height: this.rowSize(row),
      });
    }
    return changed;
  }

  getColumnWidths() {
    return (this.columnWidths || []).slice();
  }

  setColumnWidth(column, width) {
    if (
      !Number.isInteger(column) ||
      column < 0 ||
      column >= this.columns.length
    )
      return false;
    if (width == null) {
      this.columnWidthOverrides.delete(column);
      this.autoColumnWidths[column] = 0;
      this.computeLayout();
    } else {
      const value = Number(width);
      if (!Number.isFinite(value))
        throw new TypeError("CanvasGrid column width must be a finite number");
      const normalized = Math.max(MIN_RESIZED_COLUMN_WIDTH, value);
      this.columnWidthOverrides.set(column, normalized);
      if (this.columnWidths) {
        this.columnWidths[column] = normalized;
        this.applyColumnWidths();
      } else this.computeLayout();
    }
    return true;
  }

  setColumnWidths(widths = []) {
    if (!Array.isArray(widths)) {
      throw new TypeError("CanvasGrid column widths must be an array");
    }
    const normalized = widths.slice(0, this.columns.length).map((width) => {
      if (width == null) return null;
      const value = Number(width);
      if (!Number.isFinite(value)) {
        throw new TypeError("CanvasGrid column widths must be finite numbers");
      }
      return Math.max(MIN_RESIZED_COLUMN_WIDTH, value);
    });
    this.columnWidthOverrides.clear();
    for (let column = 0; column < normalized.length; column++) {
      const width = normalized[column];
      if (width == null) continue;
      this.columnWidthOverrides.set(column, width);
    }
    this.autoColumnWidths = [];
    this.computeLayout();
    return this.getColumnWidths();
  }

  resetColumnWidths() {
    this.clearColumnWidthState();
    this.computeLayout();
    return this.getColumnWidths();
  }

  setRowHeaderWidth(width = null) {
    if (width == null) {
      this.rowHeaderWidthOverride = null;
      this.computeLayout();
    } else {
      const value = Number(width);
      if (!Number.isFinite(value)) {
        throw new TypeError(
          "CanvasGrid row header width must be a finite number",
        );
      }
      this.rowHeaderWidthOverride = Math.max(MIN_RESIZED_COLUMN_WIDTH, value);
      this.rowHeaderWidth = this.rowHeaderWidthOverride;
      if (this.columnWidths) this.applyColumnWidths();
      else this.computeLayout();
    }
    return this.rowHeaderWidth;
  }

  measureText(text) {
    if (!this.ctx) return { width: 0 };
    this.ctx.font = this.font;
    return this.ctx.measureText(String(text));
  }

  getFontMetrics() {
    return {
      css: this.font,
      size: this.fontSize,
      family: this.fontFamily,
      lineHeight: this.fontSize + 2,
    };
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
    this.scrollElement.style.left = `${this.rowHeaderWidth}px`;
    this.scrollElement.style.top = `${this.headerHeight}px`;
    this.sizer.style.width = `${Math.max(1, this.totalWidth - this.rowHeaderWidth)}px`;
    this.sizer.style.height = `${Math.max(1, this.physicalHeight - this.headerHeight)}px`;
    this.lastVisibleColumnsKey = null;
    this.notifyVisibleColumns();
    this.scheduleDraw();
  }

  replaceColumns(columns) {
    const normalized = normalizeColumns(columns);
    const shapeChanged =
      normalized.length !== this.columns.length ||
      normalized.some(
        (column, index) =>
          column.key !== this.columns[index]?.key ||
          column.label !== this.columns[index]?.label,
      );
    this.columns = normalized;
    if (shapeChanged) this.clearColumnWidthState();
    return shapeChanged;
  }

  clearColumnWidthState() {
    this.columnWidthOverrides.clear();
    this.autoColumnWidths = [];
  }

  reconcileSelection(reset = false) {
    if (reset || !this.rowCount || !this.columns.length) {
      this.clearSelection(false);
      return;
    }
    if (!this.selection) return;
    this.selections = this.selections.map((selection) =>
      this.clampSelection(selection),
    );
    this.selection = this.selections.at(-1) || null;
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
    const shapeChanged = this.replaceColumns(columns);
    this.rowCount = normalizeInteger(rowCount, 0);
    this.totalRows = this.rowCount;
    this.syncRowMetrics();
    this.pageSize = normalizeInteger(pageSize, DEFAULT_PAGE_SIZE, 1);
    if (!shapeChanged && (this.rowCount === 0 || this.columns.length === 0)) {
      this.clearColumnWidthState();
    }
    this.reconcileSelection(shapeChanged);
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
    const shapeChanged = this.replaceColumns(columns);
    this.syncRowMetrics(rowHeights);
    this.reconcileSelection(shapeChanged);
    this.computeLayout();
    this.updateAria();
    this.scheduleDraw();
  }

  setColumns(columns) {
    const shapeChanged = this.replaceColumns(columns);
    this.reconcileSelection(shapeChanged);
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
    const oldBaseRow = this.baseRow;
    const oldActive = this.selection ? this.activeCell() : null;
    const oldActiveRow = oldActive ? oldBaseRow + oldActive.row : null;
    let oldSelections = this.selections.map((selection) => ({
      r0: oldBaseRow + selection.r0,
      c0: selection.c0,
      r1: oldBaseRow + selection.r1,
      c1: selection.c1,
    }));
    const oldSelectionMode = this.selectionMode;
    const pending = this.pendingNavigation;
    const shapeChanged = columns ? this.replaceColumns(columns) : false;
    if (shapeChanged) oldSelections = [];
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
      requestedRow = pending?.absoluteRow ?? oldActiveRow;
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
    } else if (!pending && targetInWindow && oldSelections.length) {
      this.setSelections(
        oldSelections.map((selection) => ({
          ...selection,
          r0: selection.r0 - this.baseRow,
          r1: selection.r1 - this.baseRow,
        })),
        {
          row: oldActiveRow - this.baseRow,
          column: oldActive.column,
        },
        { mode: oldSelectionMode },
      );
    } else if (requestedRow != null || waitingForTarget) {
      let localRow = requestedRow == null ? -1 : requestedRow - this.baseRow;
      if (localRow < 0 || localRow >= this.rowCount) {
        const oldLocal =
          oldActiveRow == null ? -1 : oldActiveRow - this.baseRow;
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

  bodyViewportWidth() {
    return this.geometry.bodyViewportWidth();
  }

  bodyViewportHeight() {
    return this.geometry.bodyViewportHeight();
  }

  logicalMaxScroll() {
    return this.geometry.logicalMaxScroll();
  }

  physicalMaxScroll() {
    return this.geometry.physicalMaxScroll();
  }

  logicalScrollTop() {
    return this.geometry.logicalScrollTop();
  }

  physicalScrollTop(logicalTop) {
    return this.geometry.physicalScrollTop(logicalTop);
  }

  getScrollState() {
    return this.geometry.scrollState();
  }

  setScrollState(state) {
    const previousLeft = this.scrollElement.scrollLeft;
    const previousTop = this.scrollElement.scrollTop;
    const result = this.geometry.setScrollState(state);
    if (
      previousLeft !== this.scrollElement.scrollLeft ||
      previousTop !== this.scrollElement.scrollTop
    ) {
      this.handleScroll();
    }
    return result;
  }

  getViewportRect() {
    return this.geometry.viewportRect();
  }

  getCellRect(row, column) {
    return this.geometry.cellRect(row, column);
  }

  getColumnRect(column) {
    return this.geometry.columnRect(column);
  }

  getRowRect(row) {
    return this.geometry.rowRect(row);
  }

  visibleRange() {
    return this.geometry.visibleRows();
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
    const state = this.getScrollState();
    for (const callback of this.scrollCallbacks) callback(state);
    this.options.onScroll?.(state);
  }

  onDidScroll(callback) {
    if (typeof callback !== "function") {
      throw new TypeError("CanvasGrid scroll callback must be a function");
    }
    this.scrollCallbacks.add(callback);
    return disposable(() => this.scrollCallbacks.delete(callback));
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
    const bodyHeight = this.bodyViewportHeight();
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
    return this.geometry.visibleColumns();
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

  gridSize() {
    return { rows: this.rowCount, columns: this.columns.length };
  }

  clampCell(row, column) {
    return clampCell(row, column, this.rowCount, this.columns.length);
  }

  clampSelection(selection) {
    return clampSelection(selection, this.rowCount, this.columns.length);
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
    return this.selections.map(normalizeSelection);
  }

  selectionFromHit(hit) {
    return selectionFromHit(hit, this.rowCount, this.columns.length);
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
      ? this.orientSelectionToActive(
          this.selection,
          this.clampCell(active.row, active.column),
        )
      : null;
    this.updateAria();
    if (announce) this.announceSelection();
    this.scheduleDraw("overlay");
  }

  orientSelectionToActive(selection, active) {
    return orientSelectionToActive(selection, active);
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
      scrollTop: this.scrollElement.scrollTop,
      scrollLeft: this.scrollElement.scrollLeft,
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
    this.scrollElement.scrollTop = Number(state.scrollTop) || 0;
    this.scrollElement.scrollLeft = Number(state.scrollLeft) || 0;
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
    const bodyHeight = this.bodyViewportHeight();
    let target = top;
    if (cellTop < top) target = cellTop;
    else if (cellBottom > top + bodyHeight) target = cellBottom - bodyHeight;
    this.scrollElement.scrollTop = this.physicalScrollTop(target);
  }

  scrollColumnIntoView(column) {
    if (!this.viewWidth || !this.columnStarts) return;
    const left = this.columnStarts[column];
    const right = this.columnStarts[column + 1];
    if (left - this.scrollElement.scrollLeft < this.rowHeaderWidth) {
      this.scrollElement.scrollLeft = Math.max(0, left - this.rowHeaderWidth);
    } else if (
      right - this.scrollElement.scrollLeft >
      this.rowHeaderWidth + this.bodyViewportWidth()
    ) {
      this.scrollElement.scrollLeft =
        right - this.rowHeaderWidth - this.bodyViewportWidth();
    }
  }

  scrollCellIntoView(row, column) {
    this.scrollRowIntoView(row);
    this.scrollColumnIntoView(column);
  }

  columnAtContentX(contentX) {
    return this.geometry.columnAtContentX(contentX);
  }

  pointInScrollbar(clientX, clientY) {
    return this.geometry.pointInScrollbar(clientX, clientY);
  }

  hit(clientX, clientY, shouldClamp = false) {
    return this.geometry.hit(clientX, clientY, shouldClamp);
  }

  resizeHit(clientX, clientY) {
    return this.geometry.resizeHit(clientX, clientY);
  }

  handleMouseMove(event) {
    if (this.resizeState || this.dragging) return;
    if (this.pointInScrollbar(event.clientX, event.clientY)) {
      this.element.style.cursor = "default";
      this.scrollElement.style.cursor = "default";
      this.element.title = "";
      return;
    }
    this.scrollElement.style.cursor = "";
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
    if (this.pointInScrollbar(event.clientX, event.clientY)) return;
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
    if (
      hit.zone === "column" &&
      event.altKey &&
      this.requestSort(hit.column, "cycle", "alt-click")
    ) {
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
    const rect = this.scrollElement.getBoundingClientRect();
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
      const oldLeft = this.scrollElement.scrollLeft;
      const oldTop = this.scrollElement.scrollTop;
      this.scrollElement.scrollLeft = clamp(
        oldLeft + deltaX,
        0,
        Math.max(
          0,
          this.totalWidth - this.rowHeaderWidth - this.bodyViewportWidth(),
        ),
      );
      this.scrollElement.scrollTop = clamp(
        oldTop + deltaY,
        0,
        this.physicalMaxScroll(),
      );
      if (
        this.scrollElement.scrollLeft === oldLeft &&
        this.scrollElement.scrollTop === oldTop
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
      this.setRowHeaderWidth(width);
    } else {
      this.setColumnWidth(this.resizeState.hit.column, width);
    }
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
      this.requestSort(active.column, "cycle", "keyboard");
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

  requestContextSort(direction, source) {
    const column = contextSortColumn(this.contextTarget, this.activeCell());
    return this.requestSort(column, direction, source);
  }

  requestSort(column, direction = "cycle", source = "api") {
    if (
      typeof this.options.onSort !== "function" ||
      !isSortDirection(direction) ||
      column < 0 ||
      column >= this.columns.length
    )
      return false;
    this.options.onSort(this.columns[column], column, { direction, source });
    return true;
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
    this.scrollElement.removeEventListener("scroll", this.handlers.scroll);
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
    this.scrollCallbacks.clear();
    this.textFitCache.clear();
    this.element.remove();
  }
}

installGridRenderer(CanvasGrid.prototype);

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
