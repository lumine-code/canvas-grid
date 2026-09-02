const { clamp } = require("./grid-utils");

function clampCell(row, column, rowCount, columnCount) {
  return {
    row: clamp(row, 0, Math.max(0, rowCount - 1)),
    column: clamp(column, 0, Math.max(0, columnCount - 1)),
  };
}

function clampSelection(selection, rowCount, columnCount) {
  const first = clampCell(selection.r0, selection.c0, rowCount, columnCount);
  const last = clampCell(selection.r1, selection.c1, rowCount, columnCount);
  return { r0: first.row, c0: first.column, r1: last.row, c1: last.column };
}

function normalizeSelection(selection) {
  return {
    r0: Math.min(selection.r0, selection.r1),
    r1: Math.max(selection.r0, selection.r1),
    c0: Math.min(selection.c0, selection.c1),
    c1: Math.max(selection.c0, selection.c1),
  };
}

function selectionFromHit(hit, rowCount, columnCount) {
  if (hit.zone === "corner") {
    return {
      mode: "all",
      selection: { r0: 0, c0: 0, r1: rowCount - 1, c1: columnCount - 1 },
    };
  }
  if (hit.zone === "row") {
    return {
      mode: "row",
      selection: { r0: hit.row, c0: 0, r1: hit.row, c1: columnCount - 1 },
    };
  }
  if (hit.zone === "column") {
    return {
      mode: "column",
      selection: { r0: 0, c0: hit.column, r1: rowCount - 1, c1: hit.column },
    };
  }
  return {
    mode: "cell",
    selection: { r0: hit.row, c0: hit.column, r1: hit.row, c1: hit.column },
  };
}

function orientSelectionToActive(selection, active) {
  if (!selection) return active;
  const normalized = normalizeSelection(selection);
  const rowAtEdge =
    active.row === normalized.r0 || active.row === normalized.r1;
  const columnAtEdge =
    active.column === normalized.c0 || active.column === normalized.c1;
  if (!rowAtEdge || !columnAtEdge) return active;
  selection.r0 = active.row === normalized.r0 ? normalized.r1 : normalized.r0;
  selection.c0 =
    active.column === normalized.c0 ? normalized.c1 : normalized.c0;
  selection.r1 = active.row;
  selection.c1 = active.column;
  return null;
}

module.exports = {
  clampCell,
  clampSelection,
  normalizeSelection,
  orientSelectionToActive,
  selectionFromHit,
};
