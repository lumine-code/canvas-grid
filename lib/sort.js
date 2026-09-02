const SORT_DIRECTIONS = new Set(["ascending", "descending", "clear", "cycle"]);

function isSortDirection(direction) {
  return SORT_DIRECTIONS.has(direction);
}

function sortIndicator(direction) {
  if (direction === 1) return " ▲";
  if (direction === -1) return " ▼";
  return "";
}

function contextSortColumn(contextTarget, activeCell) {
  return contextTarget?.zone === "column"
    ? contextTarget.column
    : activeCell.column;
}

module.exports = { contextSortColumn, isSortDirection, sortIndicator };
