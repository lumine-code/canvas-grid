const {
  AxisMetrics,
  CanvasGrid,
  PagedRowCache,
  MAX_CACHED_PAGES,
  formatCell,
  lowerBound,
} = require("../lib/canvas-grid");

describe("AxisMetrics", () => {
  it("updates variable sizes and finds items through prefix sums", () => {
    const metrics = new AxisMetrics({ count: 4, defaultSize: 20 });
    expect(metrics.totalSize).toBe(80);
    expect(metrics.offsetAt(3)).toBe(60);
    expect(metrics.indexAt(59)).toBe(2);
    expect(metrics.indexAt(60)).toBe(3);

    metrics.setSize(1, 35);
    expect(metrics.toArray()).toEqual([undefined, 35, undefined, undefined]);
    expect(metrics.offsetAt(2)).toBe(55);
    expect(metrics.totalSize).toBe(95);
    expect(metrics.indexAt(54)).toBe(1);
    expect(metrics.indexAt(55)).toBe(2);
  });

  it("rebuilds deterministically across insert, delete, reorder, and default changes", () => {
    const metrics = new AxisMetrics({
      count: 3,
      defaultSize: 10,
      sizes: [12, null, 18],
    });
    metrics.insert(1, 2, [7, null]);
    expect(
      Array.from({ length: metrics.count }, (_, index) =>
        metrics.sizeAt(index),
      ),
    ).toEqual([12, 7, 10, 10, 18]);
    expect(metrics.delete(2, 1)).toEqual([undefined]);
    metrics.reorder([3, 0, 2, 1]);
    expect(
      Array.from({ length: metrics.count }, (_, index) =>
        metrics.sizeAt(index),
      ),
    ).toEqual([18, 12, 10, 7]);
    metrics.setDefaultSize(16);
    expect(metrics.sizeAt(2)).toBe(16);
    expect(metrics.totalSize).toBe(53);
  });

  it("matches a direct model through randomized point updates and lookups", () => {
    let seed = 0x5eed;
    const random = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0x100000000;
    };
    const expected = new Array(256).fill(24);
    const metrics = new AxisMetrics({
      count: expected.length,
      defaultSize: 24,
    });
    for (let operation = 0; operation < 1000; operation++) {
      const index = Math.floor(random() * expected.length);
      const size = 8 + Math.floor(random() * 64);
      expected[index] = size;
      metrics.setSize(index, size);
      const probe = random() * expected.reduce((sum, value) => sum + value, 0);
      let directIndex = 0;
      let offset = expected[0];
      while (directIndex < expected.length - 1 && offset <= probe) {
        directIndex++;
        offset += expected[directIndex];
      }
      expect(metrics.indexAt(probe)).toBe(directIndex);
    }
    expect(metrics.totalSize).toBe(
      expected.reduce((sum, value) => sum + value, 0),
    );
  });
});

function frameQueue() {
  let nextId = 1;
  const callbacks = new Map();
  return {
    request(callback) {
      const id = nextId++;
      callbacks.set(id, callback);
      return id;
    },
    cancel(id) {
      callbacks.delete(id);
    },
    flush() {
      let passes = 0;
      while (callbacks.size && passes++ < 20) {
        const pending = Array.from(callbacks.values());
        callbacks.clear();
        pending.forEach((callback) => callback());
      }
      if (callbacks.size)
        throw new Error("Animation frame queue did not settle");
    },
    get size() {
      return callbacks.size;
    },
  };
}

function fakeContext() {
  const calls = { fillText: [], fillRect: [], strokeRect: [] };
  return {
    calls,
    font: "",
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    globalAlpha: 1,
    textBaseline: "",
    measureText: (text) => ({ width: String(text).length * 6 }),
    setTransform() {},
    clearRect() {},
    fillRect(...args) {
      calls.fillRect.push(args);
    },
    fillText(text, ...args) {
      calls.fillText.push([String(text), ...args]);
    },
    strokeRect(...args) {
      calls.strokeRect.push(args);
    },
    save() {},
    restore() {},
    beginPath() {},
    rect() {},
    clip() {},
    moveTo() {},
    lineTo() {},
    stroke() {},
  };
}

function fakeStyle(overrides = {}) {
  const values = {
    "--canvas-grid-row-height": "20px",
    "--canvas-grid-header-height": "20px",
    "--canvas-grid-accent-color": "rgb(1, 2, 3)",
    "--canvas-grid-null-color": "rgb(4, 5, 6)",
    "--text-color": "rgb(220, 220, 220)",
    "--text-color-subtle": "rgb(140, 140, 140)",
    "--base-border-color": "rgb(80, 80, 80)",
    "--pane-item-background-color": "rgb(20, 20, 20)",
    "--background-color-highlight": "rgb(35, 35, 35)",
    ...overrides,
  };
  return {
    fontSize: "12px",
    fontFamily: "monospace",
    color: values["--text-color"],
    getPropertyValue(name) {
      return values[name] || "";
    },
  };
}

function commandHarness() {
  const harness = {
    map: null,
    disposed: false,
    add(_element, map) {
      harness.map = map;
      return { dispose: () => (harness.disposed = true) };
    },
    dispatch(name) {
      const entry = harness.map[name];
      const callback = typeof entry === "function" ? entry : entry.didDispatch;
      callback({ stopPropagation() {}, preventDefault() {} });
    },
  };
  return harness;
}

function createGrid(options = {}) {
  const frames = frameQueue();
  const context = fakeContext();
  const overlayContext = fakeContext();
  const commands = commandHarness();
  let resizeDisconnected = false;
  const grid = new CanvasGrid({
    columns: [
      { key: "a", label: "A", width: 60 },
      { key: "b", label: "B", width: 70 },
    ],
    rowCount: null,
    windowRows: [],
    width: 240,
    height: 100,
    context,
    overlayContext,
    className: "sqlite-view-grid",
    commandPrefix: "sqlite-view",
    commands,
    requestAnimationFrame: (callback) => frames.request(callback),
    cancelAnimationFrame: (id) => frames.cancel(id),
    getComputedStyle: () => fakeStyle(),
    getDevicePixelRatio: () => 2,
    resizeObserverFactory: () => ({
      observe() {},
      disconnect() {
        resizeDisconnected = true;
      },
    }),
    observeTheme: false,
    ...options,
  });
  let scrollTop = 0;
  let scrollLeft = 0;
  Object.defineProperties(grid.element, {
    scrollTop: {
      configurable: true,
      get: () => scrollTop,
      set(value) {
        scrollTop = Number(value) || 0;
      },
    },
    scrollLeft: {
      configurable: true,
      get: () => scrollLeft,
      set(value) {
        scrollLeft = Number(value) || 0;
      },
    },
  });
  grid.element.getBoundingClientRect = () => ({
    left: 0,
    top: 0,
    right: 240,
    bottom: 100,
    width: 240,
    height: 100,
  });
  frames.flush();
  return {
    grid,
    frames,
    context,
    overlayContext,
    commands,
    resizeWasDisconnected: () => resizeDisconnected,
  };
}

describe("PagedRowCache", () => {
  it("keeps at most three requested pages", async () => {
    const calls = [];
    const cache = new PagedRowCache({
      rowCount: 100,
      pageSize: 5,
      fetchRows: ({ offset, limit, pageIndex }) => {
        calls.push({ offset, limit, pageIndex });
        return Array.from({ length: limit }, (_, index) => [offset + index]);
      },
    });

    await cache.retainPages([0, 1, 2, 3, 4]);
    expect(cache.size).toBe(MAX_CACHED_PAGES);
    expect(calls.map((call) => call.pageIndex)).toEqual([0, 1, 2]);

    await cache.retainPages([8, 9, 10]);
    expect(cache.size).toBe(MAX_CACHED_PAGES);
    expect(cache.stateForRow(0).status).toBe("missing");
    expect(cache.stateForRow(45).row).toEqual([45]);
    cache.destroy();
  });

  it("ignores a page that resolves after its generation was cleared", async () => {
    let resolvePage;
    const cache = new PagedRowCache({
      rowCount: 20,
      pageSize: 5,
      fetchRows: () => new Promise((resolve) => (resolvePage = resolve)),
    });
    const loading = cache.loadPage(0);
    await Promise.resolve();
    cache.clear();
    resolvePage([["stale"]]);
    await loading;

    expect(cache.stateForRow(0).status).toBe("missing");
    cache.destroy();
  });
});

describe("CanvasGrid", () => {
  let current;

  afterEach(() => {
    current?.grid.destroy();
    current = null;
  });

  it("uses a fixed DOM, a DPR-sized canvas, and an accessible active-cell mirror", () => {
    current = createGrid({
      baseRow: 100,
      windowRows: [
        { a: "alpha", b: "beta" },
        { a: "gamma", b: "delta" },
      ],
      totalRows: null,
    });
    const { grid, context } = current;

    expect(grid.element.classList.contains("sqlite-view-grid")).toBe(true);
    expect(grid.element.children.length).toBe(4);
    expect(grid.viewport.children.length).toBe(2);
    expect(grid.element.getAttribute("role")).toBe("grid");
    expect(grid.element.getAttribute("aria-rowcount")).toBe("-1");
    expect(grid.element.getAttribute("aria-colcount")).toBe("2");
    grid.setBusy(true);
    expect(grid.element.getAttribute("aria-busy")).toBe("true");
    expect(grid.canvas.width).toBe(480);
    expect(grid.canvas.height).toBe(200);
    expect(grid.overlayCanvas.width).toBe(480);
    expect(grid.overlayCanvas.height).toBe(200);
    expect(context.calls.fillRect).not.toContain([0, 0, 240, 100]);

    grid.moveActiveSelectionTo(1, 1);
    expect(grid.ariaCell.getAttribute("aria-rowindex")).toBe("102");
    expect(grid.ariaCell.getAttribute("aria-colindex")).toBe("2");
    expect(grid.ariaCell.textContent).toContain(
      "B, row 102 of an unknown total: delta",
    );
    expect(grid.liveRegion.textContent).toContain("Selected row 102, column B");
  });

  it("sizes the backing canvas correctly at common fractional DPR values", () => {
    for (const dpr of [1, 1.25, 2]) {
      current = createGrid({ getDevicePixelRatio: () => dpr });
      current.grid.resize(240, 100);
      current.frames.flush();
      expect(current.grid.canvas.width).toBe(Math.round(240 * dpr));
      expect(current.grid.canvas.height).toBe(Math.round(100 * dpr));
      current.grid.destroy();
      current = null;
    }
  });

  it("renders only the visible window and finds columns through prefix offsets", () => {
    const rows = Array.from({ length: 20 }, (_, index) => ({
      a: `a${index}`,
      b: `b${index}`,
    }));
    current = createGrid({ windowRows: rows, totalRows: 20, height: 80 });
    const { grid, frames, context } = current;
    grid.resize(240, 80);
    frames.flush();

    const labels = context.calls.fillText.map(([text]) => text);
    expect(labels).toContain("a0");
    expect(labels).toContain("a3");
    expect(labels).not.toContain("a10");
    expect(grid.hit(grid.rowHeaderWidth + 61, 40, false).column).toBe(1);
    expect(grid.columnAtContentX(grid.columnStarts[1])).toBe(1);
  });

  it("accepts an unbounded in-memory row array without treating it as a keyset window", () => {
    const rows = Array.from({ length: 1000 }, (_, index) => ({
      a: index,
      b: index,
    }));
    current = createGrid({
      windowRows: undefined,
      rows,
      copyRows: false,
    });
    expect(current.grid.memoryMode).toBe(true);
    expect(current.grid.rowCount).toBe(1000);
    expect(current.grid.totalRows).toBe(1000);
    expect(current.grid.cache.size).toBe(0);
    expect(current.grid.windowRows).toBe(rows);
  });

  it("uses variable row metrics for layout, hit-testing, selection, and resizing", () => {
    const rowMetrics = new AxisMetrics({
      count: 3,
      defaultSize: 20,
      sizes: [10, 30, 20],
    });
    current = createGrid({
      windowRows: [
        { a: "a0", b: "b0" },
        { a: "a1", b: "b1" },
        { a: "a2", b: "b2" },
      ],
      totalRows: 3,
      rowMetrics,
      resizableRows: true,
    });
    const { grid } = current;
    expect(grid.logicalHeight).toBe(80);
    expect(grid.hit(100, 29, false).row).toBe(0);
    expect(grid.hit(100, 30, false).row).toBe(1);
    expect(grid.setRowSize(1, 45)).toBe(true);
    expect(grid.rowOffset(2)).toBe(55);
    expect(grid.logicalHeight).toBe(95);
  });

  it("resizes rows from gutter boundaries and reports the committed height", () => {
    const resized = [];
    current = createGrid({
      windowRows: [
        { a: "a0", b: "b0" },
        { a: "a1", b: "b1" },
      ],
      totalRows: 2,
      resizableRows: true,
      onRowResize: (event) => resized.push(event),
    });
    const { grid } = current;
    expect(grid.resizeHit(2, 40)).toEqual({ row: 0 });
    grid.handleMouseDown({
      button: 0,
      clientX: 2,
      clientY: 40,
      preventDefault() {},
    });
    grid.handleResizeMove({ clientX: 2, clientY: 52 });
    grid.handleResizeUp();
    expect(grid.rowSize(0)).toBe(32);
    expect(resized.length).toBe(1);
    expect(resized[0]).toEqual(
      jasmine.objectContaining({ row: 0, windowRow: 0, height: 32 }),
    );
  });

  it("auto-scrolls a dragged selection near the viewport edge", () => {
    current = createGrid({
      windowRows: Array.from({ length: 10 }, (_, index) => ({
        a: `a${index}`,
        b: `b${index}`,
      })),
      totalRows: 10,
    });
    const { grid, frames } = current;
    grid.startSelection({ zone: "body", row: 0, column: 0 });
    grid.dragging = true;
    grid.handleWindowMouseMove({ clientX: 100, clientY: 99 });
    frames.flush();
    expect(grid.element.scrollTop).toBeGreaterThan(0);
    expect(grid.normalizedSelections()[0].r1).toBeGreaterThan(0);
    grid.handleWindowMouseUp();
  });

  it("uses the default cursor over native scrollbar areas", () => {
    current = createGrid({
      windowRows: [{ a: "a", b: "b" }],
      totalRows: 1,
    });
    const { grid } = current;
    Object.defineProperties(grid.element, {
      clientWidth: { configurable: true, value: 220 },
      clientHeight: { configurable: true, value: 80 },
    });
    grid.handleMouseMove({ clientX: 230, clientY: 50 });
    expect(grid.element.style.cursor).toBe("default");
    grid.handleMouseMove({ clientX: 100, clientY: 50 });
    expect(grid.element.style.cursor).toBe("");
  });

  it("clips and invokes a custom painter only for visible loaded cells", () => {
    const painter = jasmine.createSpy("painter");
    current = createGrid({
      columns: [{ key: "a", label: "A", width: 60, paintCell: painter }],
      windowRows: [{ a: "painted" }],
      totalRows: 1,
    });
    current.frames.flush();
    expect(painter).toHaveBeenCalled();
    expect(painter.calls.mostRecent().args[1]).toEqual(
      jasmine.objectContaining({
        value: "painted",
        text: "painted",
        row: 0,
        column: 0,
      }),
    );
  });

  it("keeps controlled ranges intact while drawing a separate active cell", () => {
    current = createGrid({
      windowRows: [
        { a: "a0", b: "b0" },
        { a: "a1", b: "b1" },
      ],
      totalRows: 2,
    });
    const { grid, overlayContext } = current;
    grid.setSelections([{ r0: 0, c0: 0, r1: 1, c1: 1 }], { row: 0, column: 1 });
    expect(grid.normalizedSelections()).toEqual([
      { r0: 0, c0: 0, r1: 1, c1: 1 },
    ]);
    expect(grid.activeCell()).toEqual({ row: 0, column: 1 });
    grid.focused = true;
    grid.drawOverlay();
    expect(overlayContext.calls.fillText).toEqual([]);
  });

  it("draws search and row highlights on the overlay canvas", () => {
    current = createGrid({
      windowRows: [{ a: "alpha", b: "beta" }],
      totalRows: 1,
    });
    const { grid, frames, overlayContext } = current;
    const before = overlayContext.calls.fillRect.length;
    grid.setHighlights([{ row: 0, column: 1 }], {
      row: 0,
      column: 1,
    });
    grid.setHighlightRow(0);
    frames.flush();
    expect(overlayContext.calls.fillRect.length).toBeGreaterThan(before);
  });

  it("schedules a complete repaint after a restored canvas context", () => {
    current = createGrid();
    const { grid } = current;
    spyOn(grid, "scheduleDraw");
    grid.canvas.dispatchEvent(new Event("contextrestored"));
    expect(grid.scheduleDraw).toHaveBeenCalled();
  });

  it("caches fitted visible text instead of measuring it on every draw", () => {
    current = createGrid();
    const { grid, context } = current;
    spyOn(context, "measureText").and.callThrough();

    const first = grid.fitText("a value that is wider than its cell", 30);
    const measurements = context.measureText.calls.count();
    const second = grid.fitText("a value that is wider than its cell", 30);

    expect(second).toBe(first);
    expect(context.measureText.calls.count()).toBe(measurements);
  });

  it("reports the visible column tile with bounded overscan", () => {
    const ranges = [];
    current = createGrid({
      columns: Array.from({ length: 20 }, (_, index) => ({
        key: index,
        label: `C${index}`,
        width: 50,
      })),
      windowRows: [Array.from({ length: 20 }, (_, index) => index)],
      totalRows: 1,
      columnOverscan: 1,
      onVisibleColumnsChange: (range) => ranges.push(range),
    });
    const { grid } = current;

    expect(ranges[0].start).toBe(0);
    expect(ranges[0].end).toBeLessThan(20);
    grid.element.scrollLeft = 500;
    grid.handleScroll();
    expect(ranges.at(-1).start).toBeGreaterThan(0);
    expect(ranges.at(-1).columns.length).toBeLessThan(20);
  });

  it("crosses a keyset window with keyboard navigation and requests the real end", () => {
    const requests = [];
    const ends = [];
    current = createGrid({
      baseRow: 10,
      windowRows: [
        { a: "a10", b: "b10" },
        { a: "a11", b: "b11" },
        { a: "a12", b: "b12" },
        { a: "a13", b: "b13" },
        { a: "a14", b: "b14" },
      ],
      height: 60,
      hasNext: true,
      totalRows: null,
      onNeedNext: (context) => {
        requests.push(context);
        return {
          baseRow: 15,
          rows: [
            { a: "a15", b: "b15" },
            { a: "a16", b: "b16" },
          ],
          hasPrevious: true,
          hasNext: true,
          totalRows: null,
        };
      },
      onRequestEnd: (context) => {
        ends.push(context);
        return {
          baseRow: 98,
          rows: [
            { a: "a98", b: "b98" },
            { a: "a99", b: "b99" },
          ],
          hasPrevious: true,
          hasNext: false,
          totalRows: 100,
        };
      },
    });
    const { grid, commands } = current;

    grid.moveActiveSelectionTo(4, 0);
    commands.dispatch("core:move-down");
    expect(requests.length).toBe(1);
    expect(requests[0].activeRow).toBe(14);
    expect(grid.baseRow).toBe(15);
    expect(grid.publicActiveCell()).toEqual({
      row: 15,
      column: 0,
      windowRow: 0,
    });

    commands.dispatch("core:move-to-bottom");
    expect(ends.length).toBe(1);
    expect(grid.baseRow).toBe(98);
    expect(grid.publicActiveCell()).toEqual({
      row: 99,
      column: 1,
      windowRow: 1,
    });
    expect(grid.element.getAttribute("aria-rowcount")).toBe("100");
  });

  it("keeps a keyboard target pending across an intermediate two-page window", () => {
    current = createGrid({
      baseRow: 0,
      windowRows: Array.from({ length: 6 }, (_, index) => ({
        a: index,
        b: index,
      })),
      hasNext: true,
      totalRows: null,
      onNeedNext() {},
    });
    const { grid, commands } = current;
    grid.moveActiveSelectionTo(5, 0);
    commands.dispatch("core:move-down");

    grid.setWindow({
      baseRow: 2,
      rows: Array.from({ length: 4 }, (_, index) => ({
        a: index + 2,
        b: index + 2,
      })),
      hasPrevious: true,
      hasNext: true,
      totalRows: null,
    });
    expect(grid.pendingNavigation.absoluteRow).toBe(6);
    expect(grid.publicActiveCell().row).toBe(5);

    grid.setWindow({
      baseRow: 2,
      rows: Array.from({ length: 6 }, (_, index) => ({
        a: index + 2,
        b: index + 2,
      })),
      hasPrevious: true,
      hasNext: true,
      totalRows: null,
    });
    expect(grid.pendingNavigation).toBeNull();
    expect(grid.publicActiveCell()).toEqual({
      row: 6,
      column: 0,
      windowRow: 4,
    });
  });

  it("deduplicates edge requests until a new window arrives", () => {
    let requests = 0;
    current = createGrid({
      windowRows: Array.from({ length: 10 }, (_, index) => ({
        a: index,
        b: index,
      })),
      hasNext: true,
      totalRows: null,
      height: 60,
      onNeedNext: () => requests++,
    });
    const { grid } = current;
    grid.resize(240, 60);
    grid.element.scrollTop = grid.physicalMaxScroll();
    grid.handleScroll();
    grid.handleScroll();
    expect(requests).toBe(1);
  });

  it("sorts a selected header and copies rectangular selections as TSV", async () => {
    const sorted = [];
    const clipboard = { write: jasmine.createSpy("write") };
    current = createGrid({
      windowRows: [
        { a: "alpha", b: null },
        { a: Buffer.from([1, 2]), b: "omega" },
      ],
      totalRows: 2,
      clipboard,
      onSort: (column, index) => sorted.push([column.label, index]),
    });
    const { grid, commands } = current;

    grid.selectColumnAt(1);
    expect(grid.ariaCell.getAttribute("role")).toBe("columnheader");
    commands.dispatch("core:confirm");
    expect(sorted).toEqual([["B", 1]]);

    grid.moveActiveSelectionTo(0, 0);
    grid.moveActiveSelectionTo(1, 1, true);
    const text = await grid.copySelection();
    expect(text).toBe("alpha\tNULL\n[BLOB 2 bytes]\tomega");
    expect(clipboard.write).toHaveBeenCalledWith(text);

    grid.selectRowAt(0);
    expect(grid.ariaCell.getAttribute("role")).toBe("rowheader");
  });

  it("refuses oversized copies before writing any partial clipboard text", async () => {
    const clipboard = { write: jasmine.createSpy("write") };
    const limits = [];
    current = createGrid({
      windowRows: [
        { a: "alpha", b: "beta" },
        { a: "gamma", b: "delta" },
      ],
      totalRows: 2,
      clipboard,
      maxCopyCells: 3,
      onCopyLimit: (details) => limits.push(details),
    });
    const { grid } = current;
    grid.moveActiveSelectionTo(0, 0);
    grid.moveActiveSelectionTo(1, 1, true);

    expect(await grid.copySelection()).toBeNull();
    expect(limits[0].reason).toBe("cells");
    expect(clipboard.write).not.toHaveBeenCalled();

    limits.length = 0;
    grid.maxCopyCells = 100;
    grid.maxCopyBytes = 5;
    expect(await grid.copySelection()).toBeNull();
    expect(limits[0].reason).toBe("bytes");
    expect(clipboard.write).not.toHaveBeenCalled();
  });

  it("resolves unloaded cells before copying them", async () => {
    const clipboard = { write: jasmine.createSpy("write") };
    const resolver = jasmine
      .createSpy("resolveCell")
      .and.callFake(({ columnIndex }) =>
        Promise.resolve(columnIndex === 0 ? "fetched-a" : "fetched-b"),
      );
    current = createGrid({
      windowRows: [{ a: ["loading"], b: ["loading"] }],
      totalRows: 1,
      clipboard,
      resolveCell: resolver,
    });
    const { grid } = current;
    grid.moveActiveSelectionTo(0, 0);
    grid.moveActiveSelectionTo(0, 1, true);

    expect(await grid.copySelection()).toBe("fetched-a\tfetched-b");
    expect(resolver).toHaveBeenCalledTimes(2);
  });

  it("caps an explicit keyset window at three pages", () => {
    current = createGrid({ pageSize: 2 });
    expect(() =>
      current.grid.setWindow({ rows: Array.from({ length: 7 }, () => []) }),
    ).toThrowError(RangeError);
  });

  it("keeps the optional offset provider bounded to three pages", async () => {
    const pages = [];
    current = createGrid({
      rowCount: 100,
      windowRows: undefined,
      pageSize: 5,
      fetchRows: ({ offset, limit, pageIndex }) => {
        pages.push(pageIndex);
        return Array.from({ length: limit }, (_, index) => ({
          a: offset + index,
          b: pageIndex,
        }));
      },
      height: 60,
    });
    const { grid } = current;
    grid.resize(240, 60);
    await grid.whenIdle();
    expect(grid.cache.size).toBe(MAX_CACHED_PAGES);
    expect(pages.slice(0, 3)).toEqual([0, 1, 2]);

    grid.element.scrollTop = grid.physicalMaxScroll();
    grid.handleScroll();
    await grid.whenIdle();
    expect(grid.cache.size).toBe(MAX_CACHED_PAGES);
    expect(pages).toContain(19);
  });

  it("keeps work bounded for ten million rows and one hundred columns", async () => {
    const requests = [];
    current = createGrid({
      columns: Array.from({ length: 100 }, (_, index) => ({
        key: index,
        label: `Column ${index + 1}`,
        width: 120,
      })),
      rowCount: 10_000_000,
      windowRows: undefined,
      pageSize: 256,
      width: 1920,
      height: 1080,
      fetchRows: ({ offset, limit }) => {
        requests.push({ offset, limit });
        return Array.from({ length: limit }, (_, row) =>
          Array.from(
            { length: 100 },
            (_, column) => `${offset + row}:${column}`,
          ),
        );
      },
    });
    const { grid, frames, context } = current;
    grid.resize(1920, 1080);
    grid.element.scrollTop = grid.physicalMaxScroll();
    grid.handleScroll();
    await grid.whenIdle();
    frames.flush();

    expect(grid.element.children.length).toBe(4);
    expect(grid.cache.size).toBeLessThanOrEqual(MAX_CACHED_PAGES);
    expect(requests.length).toBeLessThanOrEqual(MAX_CACHED_PAGES * 2);
    expect(requests.some(({ offset }) => offset > 9_000_000)).toBe(true);
    expect(grid.physicalHeight).toBeLessThanOrEqual(10_000_000);
    expect(context.calls.fillText.length).toBeLessThan(2000);
  });

  it("cancels scheduled work and observers on idempotent destroy", () => {
    current = createGrid();
    const { grid, commands, resizeWasDisconnected } = current;
    grid.scheduleDraw();
    expect(() => grid.destroy()).not.toThrow();
    expect(() => grid.destroy()).not.toThrow();
    expect(commands.disposed).toBe(true);
    expect(resizeWasDisconnected()).toBe(true);
    current = null;
  });
});

describe("canvas-grid helpers", () => {
  it("formats nulls and binary values without expanding them", () => {
    expect(formatCell(null)).toBe("NULL");
    expect(formatCell(Buffer.from([1, 2, 3]))).toBe("[BLOB 3 bytes]");
  });

  it("finds insertion points in prefix offsets", () => {
    expect(lowerBound([40, 100, 180], 39)).toBe(0);
    expect(lowerBound([40, 100, 180], 100)).toBe(1);
    expect(lowerBound([40, 100, 180], 181)).toBe(3);
  });
});
