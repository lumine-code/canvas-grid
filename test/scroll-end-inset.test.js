const assert = require("node:assert/strict");
const test = require("node:test");
const { CanvasGrid } = require("../lib/canvas-grid");
const GridGeometry = require("../lib/grid-geometry");

function gridModel({
  rows = 100,
  rowHeight = 20,
  viewport = 170,
  cap = Infinity,
} = {}) {
  const grid = Object.create(CanvasGrid.prototype);
  Object.assign(grid, {
    rowCount: rows,
    rowMetrics: {
      totalSize: rows * rowHeight,
      indexAt: (top) => Math.floor(top / rowHeight),
    },
    rowOffset: (row) => row * rowHeight,
    rowSize: () => rowHeight,
    headerHeight: 30,
    rowHeaderWidth: 40,
    totalWidth: 600,
    viewHeight: viewport + 30,
    physicalHeight: Math.min(rows * rowHeight + 30, cap),
    scrollEndInset: 0,
    sizer: {
      style: { height: `${Math.min(rows * rowHeight + 30, cap) - 30}px` },
    },
    handleScroll() {
      this.notifications = (this.notifications || 0) + 1;
    },
  });
  grid.scrollElement = {
    clientWidth: 200,
    clientHeight: viewport,
    scrollLeft: 0,
  };
  let top = 0;
  Object.defineProperty(grid.scrollElement, "scrollTop", {
    get: () =>
      Math.min(
        top,
        Math.max(0, parseFloat(grid.sizer.style.height) - viewport),
      ),
    set: (value) => {
      top = Math.max(
        0,
        Math.min(value, parseFloat(grid.sizer.style.height) - viewport),
      );
    },
  });
  grid.geometry = new GridGeometry(grid);
  return grid;
}

test("last row can be revealed above an overlay without shrinking the drawing viewport", () => {
  const grid = gridModel();
  grid.setScrollEndInset(10);
  grid.scrollRowIntoView(99);
  assert.equal(grid.sizer.style.height, "2010px");
  assert.equal(grid.bodyViewportHeight(), 170);
  assert.equal(grid.safeBodyViewportHeight(), 160);
  assert.equal(grid.rowOffset(100) - grid.logicalScrollTop(), 160);
  assert.equal(grid.scrollElement.scrollTop, grid.physicalMaxScroll());
  assert.equal(grid.physicalMaxScroll(), 1840);
});

test("H toggles remove the tail, preserve a middle position and do nothing for repeated snapshots", () => {
  const grid = gridModel();
  grid.scrollElement.scrollTop = 123;
  assert.equal(grid.setScrollEndInset(10), true);
  assert.equal(grid.logicalScrollTop(), 123);
  const notifications = grid.notifications;
  assert.equal(grid.setScrollEndInset(10), false);
  assert.equal(grid.notifications, notifications);
  grid.setScrollEndInset(0);
  assert.equal(grid.sizer.style.height, "2000px");
  assert.equal(grid.logicalScrollTop(), 123);
  assert.equal(grid.safeBodyViewportHeight(), 170);
});

test("a newly needed tail supplies range without moving an initially non-scrolling list", () => {
  const grid = gridModel({ rows: 11, rowHeight: 15 });
  assert.equal(grid.logicalMaxScroll(), 0);
  grid.setScrollEndInset(10);
  assert.equal(grid.logicalMaxScroll(), 5);
  assert.equal(grid.scrollElement.scrollTop, 0);
  grid.scrollRowIntoView(10);
  assert.equal(grid.scrollElement.scrollTop, 5);
});

test("compressed physical coordinates retain logical positions and reach the safe last-row edge", () => {
  const grid = gridModel({ rows: 2_000_000, cap: 10_000_000 });
  grid.geometry.setScrollState({ logicalTop: 20_000_000 });
  grid.setScrollEndInset(10);
  assert.ok(Math.abs(grid.logicalScrollTop() - 20_000_000) < 0.00001);
  grid.scrollRowIntoView(grid.rowCount - 1);
  assert.ok(
    Math.abs(grid.rowMetrics.totalSize - grid.logicalScrollTop() - 160) <
      0.00001,
  );
  assert.equal(grid.scrollElement.scrollTop, grid.physicalMaxScroll());
  grid.setScrollEndInset(0);
  assert.ok(
    Math.abs(grid.rowMetrics.totalSize - grid.logicalScrollTop() - 170) <
      0.00001,
  );
});

test("a rail larger than the viewport still maps the complete native physical range", () => {
  const grid = gridModel({ viewport: 5 });
  grid.setScrollEndInset(10);
  assert.equal(grid.safeBodyViewportHeight(), 0);
  assert.equal(grid.physicalMaxScroll(), 2005);
  grid.geometry.setScrollState({ logicalTop: grid.logicalMaxScroll() });
  assert.equal(grid.scrollElement.scrollTop, 2005);
});

test("page navigation counts the unobscured rows while drawing retains the full viewport", () => {
  const grid = gridModel({ viewport: 180 });
  assert.equal(grid.pageRowCount(), 9);
  grid.setScrollEndInset(10);
  assert.equal(grid.pageRowCount(), 8);
  assert.equal(grid.bodyViewportHeight(), 180);
});
