const { MIN_RESIZED_COLUMN_WIDTH, RESIZE_GRIP } = require("./constants");
const { clamp, lowerBound } = require("./grid-utils");

class GridGeometry {
  constructor(grid) {
    this.grid = grid;
  }

  bodyViewportWidth() {
    const grid = this.grid;
    return Math.max(
      0,
      grid.scrollElement.clientWidth ||
        (grid.viewWidth || 0) - grid.rowHeaderWidth,
    );
  }

  bodyViewportHeight() {
    const grid = this.grid;
    return Math.max(
      0,
      grid.scrollElement.clientHeight ||
        (grid.viewHeight || 0) - grid.headerHeight,
    );
  }

  logicalMaxScroll() {
    return Math.max(
      0,
      this.grid.rowMetrics.totalSize - this.bodyViewportHeight(),
    );
  }

  physicalMaxScroll() {
    const grid = this.grid;
    return Math.max(
      0,
      grid.physicalHeight - grid.headerHeight - this.bodyViewportHeight(),
    );
  }

  logicalScrollTop() {
    const physicalMax = this.physicalMaxScroll();
    if (physicalMax <= 0) return 0;
    return (
      (this.grid.scrollElement.scrollTop / physicalMax) *
      this.logicalMaxScroll()
    );
  }

  physicalScrollTop(logicalTop) {
    const logicalMax = this.logicalMaxScroll();
    if (logicalMax <= 0) return 0;
    return (
      (clamp(logicalTop, 0, logicalMax) / logicalMax) * this.physicalMaxScroll()
    );
  }

  visibleRows() {
    const grid = this.grid;
    if (!grid.viewHeight || grid.rowCount === 0)
      return { firstRow: 0, lastRow: -1 };
    const top = this.logicalScrollTop();
    const bodyHeight = this.bodyViewportHeight();
    return {
      firstRow: clamp(grid.rowMetrics.indexAt(top), 0, grid.rowCount - 1),
      lastRow: clamp(
        grid.rowMetrics.indexAt(top + bodyHeight),
        0,
        grid.rowCount - 1,
      ),
    };
  }

  visibleColumns() {
    const grid = this.grid;
    if (!grid.columns.length) return { firstColumn: 0, lastColumn: -1 };
    const scrollLeft = grid.scrollElement.scrollLeft;
    const left = scrollLeft + grid.rowHeaderWidth;
    const right = left + this.bodyViewportWidth();
    const firstColumn = clamp(
      lowerBound(grid.columnStarts, left + 0.001) - 1,
      0,
      grid.columns.length - 1,
    );
    const lastColumn = clamp(
      lowerBound(grid.columnStarts, right) - 1,
      firstColumn,
      grid.columns.length - 1,
    );
    return { firstColumn, lastColumn };
  }

  bodyRect() {
    const grid = this.grid;
    const x = grid.rowHeaderWidth;
    const y = grid.headerHeight;
    const width = this.bodyViewportWidth();
    const height = this.bodyViewportHeight();
    return {
      x,
      y,
      width,
      height,
      right: x + width,
      bottom: y + height,
      scrollLeft: grid.scrollElement.scrollLeft,
      scrollTop: this.logicalScrollTop(),
    };
  }

  viewportRect() {
    const body = this.bodyRect();
    const element = this.grid.element.getBoundingClientRect();
    const left = element.left + body.x;
    const top = element.top + body.y;
    return {
      x: left,
      y: top,
      left,
      top,
      width: body.width,
      height: body.height,
      right: left + body.width,
      bottom: top + body.height,
      viewportX: body.x,
      viewportY: body.y,
      scrollLeft: body.scrollLeft,
      scrollTop: body.scrollTop,
    };
  }

  cellRect(row, column) {
    const grid = this.grid;
    if (
      !Number.isInteger(row) ||
      !Number.isInteger(column) ||
      row < 0 ||
      row >= grid.rowCount ||
      column < 0 ||
      column >= grid.columns.length
    )
      return null;
    const viewportX = grid.columnStarts[column] - grid.scrollElement.scrollLeft;
    const viewportY =
      grid.headerHeight + grid.rowOffset(row) - this.logicalScrollTop();
    const width = grid.columnWidths[column];
    const height = grid.rowSize(row);
    const body = this.bodyRect();
    return this.clientRect({
      width,
      height,
      viewportX,
      viewportY,
      row: grid.absoluteRow(row),
      windowRow: row,
      column,
      visible:
        viewportX + width > body.x &&
        viewportX < body.right &&
        viewportY + height > body.y &&
        viewportY < body.bottom,
    });
  }

  columnRect(column) {
    const grid = this.grid;
    if (
      !Number.isInteger(column) ||
      column < 0 ||
      column >= grid.columns.length
    )
      return null;
    const viewportX = grid.columnStarts[column] - grid.scrollElement.scrollLeft;
    const viewportY = 0;
    const width = grid.columnWidths[column];
    const height = grid.headerHeight;
    const body = this.bodyRect();
    return this.clientRect({
      viewportX,
      viewportY,
      width,
      height,
      row: null,
      windowRow: null,
      column,
      visible: viewportX + width > body.x && viewportX < body.right,
    });
  }

  rowRect(row) {
    const grid = this.grid;
    if (!Number.isInteger(row) || row < 0 || row >= grid.rowCount) return null;
    const viewportX = 0;
    const viewportY =
      grid.headerHeight + grid.rowOffset(row) - this.logicalScrollTop();
    const width = grid.rowHeaderWidth;
    const height = grid.rowSize(row);
    const body = this.bodyRect();
    return this.clientRect({
      viewportX,
      viewportY,
      width,
      height,
      row: grid.absoluteRow(row),
      windowRow: row,
      column: null,
      visible: viewportY + height > body.y && viewportY < body.bottom,
    });
  }

  clientRect(rect) {
    const element = this.grid.element.getBoundingClientRect();
    const left = element.left + rect.viewportX;
    const top = element.top + rect.viewportY;
    return {
      x: left,
      y: top,
      left,
      top,
      width: rect.width,
      height: rect.height,
      right: left + rect.width,
      bottom: top + rect.height,
      ...rect,
    };
  }

  scrollState() {
    const grid = this.grid;
    return {
      left: grid.scrollElement.scrollLeft,
      top: grid.scrollElement.scrollTop,
      logicalTop: this.logicalScrollTop(),
      maxLeft: Math.max(
        0,
        grid.totalWidth - grid.rowHeaderWidth - this.bodyViewportWidth(),
      ),
      maxTop: this.physicalMaxScroll(),
      logicalMaxTop: this.logicalMaxScroll(),
    };
  }

  setScrollState(state = {}) {
    const grid = this.grid;
    if (state.left != null) {
      grid.scrollElement.scrollLeft = clamp(
        Number(state.left) || 0,
        0,
        Math.max(
          0,
          grid.totalWidth - grid.rowHeaderWidth - this.bodyViewportWidth(),
        ),
      );
    }
    if (state.logicalTop != null) {
      grid.scrollElement.scrollTop = this.physicalScrollTop(state.logicalTop);
    } else if (state.top != null) {
      grid.scrollElement.scrollTop = clamp(
        Number(state.top) || 0,
        0,
        this.physicalMaxScroll(),
      );
    }
    return this.scrollState();
  }

  columnAtContentX(contentX) {
    const grid = this.grid;
    if (!grid.columns.length) return -1;
    return clamp(
      lowerBound(grid.columnStarts, contentX + 0.001) - 1,
      0,
      grid.columns.length - 1,
    );
  }

  pointInScrollbar(clientX, clientY) {
    const scrollElement = this.grid.scrollElement;
    const rect = scrollElement.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    if (x < 0 || y < 0 || x > rect.width || y > rect.height) return false;
    const clientWidth = scrollElement.clientWidth || rect.width;
    const clientHeight = scrollElement.clientHeight || rect.height;
    return (
      x >= scrollElement.clientLeft + clientWidth ||
      y >= scrollElement.clientTop + clientHeight
    );
  }

  hit(clientX, clientY, shouldClamp = false) {
    const grid = this.grid;
    if (!grid.rowCount || !grid.columns.length) return null;
    const rect = grid.element.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    if (
      !shouldClamp &&
      (x < 0 || y < 0 || x > grid.viewWidth || y > grid.viewHeight)
    )
      return null;
    if (!shouldClamp && this.pointInScrollbar(clientX, clientY)) return null;
    const row = clamp(
      grid.rowMetrics.indexAt(
        Math.max(y, grid.headerHeight) -
          grid.headerHeight +
          this.logicalScrollTop(),
      ),
      0,
      grid.rowCount - 1,
    );
    const contentX =
      Math.max(x, grid.rowHeaderWidth) + grid.scrollElement.scrollLeft;
    const column = this.columnAtContentX(contentX);
    let zone = "body";
    if (x < grid.rowHeaderWidth && y < grid.headerHeight) zone = "corner";
    else if (x < grid.rowHeaderWidth) zone = "row";
    else if (y < grid.headerHeight) zone = "column";
    return { zone, row, column };
  }

  resizeHit(clientX, clientY) {
    const grid = this.grid;
    if (!grid.columnStarts || this.pointInScrollbar(clientX, clientY))
      return null;
    const rect = grid.element.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    if (
      grid.options.resizableRows &&
      x < grid.rowHeaderWidth &&
      y >= grid.headerHeight
    ) {
      const contentY = y - grid.headerHeight + this.logicalScrollTop();
      const row = grid.rowMetrics.indexAt(Math.max(0, contentY - RESIZE_GRIP));
      const edge =
        grid.headerHeight + grid.rowOffset(row + 1) - this.logicalScrollTop();
      if (Math.abs(y - edge) <= RESIZE_GRIP) return { row };
      return null;
    }
    if (y >= grid.headerHeight || grid.options.resizableColumns === false)
      return null;
    if (Math.abs(x - grid.rowHeaderWidth) <= RESIZE_GRIP)
      return { rowHeader: true };
    const contentX = x + grid.scrollElement.scrollLeft;
    const boundary = lowerBound(grid.columnStarts, contentX - RESIZE_GRIP);
    for (
      let index = Math.max(1, boundary - 1);
      index < Math.min(grid.columnStarts.length, boundary + 2);
      index++
    ) {
      if (Math.abs(contentX - grid.columnStarts[index]) <= RESIZE_GRIP)
        return { column: index - 1 };
    }
    return null;
  }

  minimumColumnWidth() {
    return MIN_RESIZED_COLUMN_WIDTH;
  }
}

module.exports = GridGeometry;
