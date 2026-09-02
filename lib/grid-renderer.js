const { CELL_PADDING_X } = require("./constants");
const { rowValue } = require("./grid-utils");
const { sortIndicator } = require("./sort");

function clipBody(grid, ctx) {
  const viewport = grid.geometry.bodyRect();
  ctx.beginPath();
  ctx.rect(viewport.x, viewport.y, viewport.width, viewport.height);
  ctx.clip();
}

function selectionContainsRow(selections, row) {
  return selections.some(
    (selection) => row >= selection.r0 && row <= selection.r1,
  );
}

function selectionContainsColumn(selections, column) {
  return selections.some(
    (selection) => column >= selection.c0 && column <= selection.c1,
  );
}

const rendererMethods = {
  draw() {
    this.drawBase();
    this.drawOverlay();
    this.baseDirty = false;
    this.overlayDirty = false;
  },

  drawBase() {
    if (!this.ctx || !this.viewWidth || !this.viewHeight) return;
    const ctx = this.ctx;
    const width = this.viewWidth;
    const height = this.viewHeight;
    const scrollLeft = this.scrollElement.scrollLeft;
    const scrollTop = this.logicalScrollTop();
    const { firstRow, lastRow } = this.visibleRange();
    const { firstColumn, lastColumn } = this.visibleColumns();

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.font = this.font;
    ctx.textBaseline = "middle";

    ctx.save();
    clipBody(this, ctx);
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
  },

  drawOverlay() {
    if (!this.overlayCtx || !this.viewWidth || !this.viewHeight) return;
    const ctx = this.overlayCtx;
    const width = this.viewWidth;
    const height = this.viewHeight;
    const scrollLeft = this.scrollElement.scrollLeft;
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
    clipBody(this, ctx);
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
      this.drawSelectionHeaders(
        ctx,
        firstRow,
        lastRow,
        scrollTop,
        width,
        height,
        selections,
      );
      this.drawActiveOutline(ctx, scrollLeft, scrollTop);
    }
  },

  drawSelectionHeaders(
    ctx,
    firstRow,
    lastRow,
    scrollTop,
    width,
    height,
    selections,
  ) {
    ctx.save();
    ctx.globalAlpha = 0.15;
    ctx.fillStyle = this.colorAccent;
    ctx.beginPath();
    ctx.rect(
      0,
      this.headerHeight,
      this.rowHeaderWidth,
      height - this.headerHeight,
    );
    ctx.clip();
    for (let row = firstRow; row <= lastRow; row++) {
      if (!selectionContainsRow(selections, row)) continue;
      const top = this.headerHeight + this.rowOffset(row) - scrollTop;
      ctx.fillRect(0, top, this.rowHeaderWidth, this.rowSize(row));
    }
    ctx.restore();

    const { firstColumn, lastColumn } = this.visibleColumns();
    ctx.save();
    ctx.globalAlpha = 0.15;
    ctx.fillStyle = this.colorAccent;
    ctx.beginPath();
    ctx.rect(
      this.rowHeaderWidth,
      0,
      width - this.rowHeaderWidth,
      this.headerHeight,
    );
    ctx.clip();
    for (let column = firstColumn; column <= lastColumn; column++) {
      if (!selectionContainsColumn(selections, column)) continue;
      const left = this.columnStarts[column] - this.scrollElement.scrollLeft;
      ctx.fillRect(left, 0, this.columnWidths[column], this.headerHeight);
    }
    ctx.restore();
  },

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
  },

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
      if (selectionContainsRow(selections, rowIndex)) {
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
  },

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
      if (selectionContainsColumn(selections, columnIndex)) {
        ctx.save();
        ctx.globalAlpha = 0.15;
        ctx.fillStyle = this.colorAccent;
        ctx.fillRect(x, 0, this.columnWidths[columnIndex], this.headerHeight);
        ctx.restore();
      }
      ctx.fillStyle = this.colorText;
      const label = `${this.columns[columnIndex].label}${sortIndicator(
        this.columns[columnIndex].sortDirection,
      )}`;
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
  },

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
  },

  drawActiveOutline(ctx, scrollLeft, scrollTop) {
    if (!this.focused || !this.selection || this.selectionMode !== "cell")
      return;
    const active = this.activeCell();
    const x = this.columnStarts[active.column] - scrollLeft;
    const rowHeight = this.rowSize(active.row);
    const y = this.headerHeight + this.rowOffset(active.row) - scrollTop;
    ctx.save();
    clipBody(this, ctx);
    ctx.strokeStyle = this.colorAccent;
    ctx.lineWidth = 2;
    ctx.strokeRect(
      x + 1,
      y + 1,
      this.columnWidths[active.column] - 2,
      rowHeight - 2,
    );
    ctx.restore();
  },
};

function installGridRenderer(prototype) {
  for (const [name, method] of Object.entries(rendererMethods)) {
    Object.defineProperty(prototype, name, {
      configurable: true,
      writable: true,
      value: method,
    });
  }
}

module.exports = installGridRenderer;
