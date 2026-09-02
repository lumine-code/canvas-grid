# canvas-grid

Render large tabular datasets in an interactive canvas grid.

The grid keeps its DOM fixed while drawing only the visible rows and columns. It supports in-memory rows, offset-backed paging and explicit keyset windows without coupling the renderer to an application framework.

## Features

- **Bounded rendering**: an inset scrollport and two fixed canvases cover arbitrarily large logical grids without creating one element per cell or placing scrollbars over pinned headers.
- **Flexible data**: use an in-memory row array, an asynchronous offset loader or a keyset window managed by the host.
- **Fast geometry**: prefix-sum axis metrics provide variable item sizes, offset queries and hit-testing without scanning an axis.
- **Interaction**: spreadsheet-style anchor and active-cell navigation, row and column header selection, optional Alt-click sorting, resizing and bounded clipboard export are available through a host-neutral API.
- **Accessible focus**: an active-descendant mirror and live region expose the focused cell while the canvases remain hidden from assistive technology.
- **Host adapters**: commands, clipboard, theme events, notifications and animation scheduling can be injected by the consumer.

## Usage

```js
const { CanvasGrid } = require("@lumine-code/canvas-grid");

const grid = new CanvasGrid({
  columns: ["Name", "Value"],
  rows: [
    ["alpha", 1],
    ["beta", 2],
  ],
  ariaLabel: "Values",
});

document.body.appendChild(grid.element);
```

Call `destroy()` before discarding a grid. Consumers that use paged data should also treat every `fetchRows` signal as authoritative and stop work when it is aborted.

Pass `rowCount` with `fetchRows({offset, limit, signal})` for offset paging, or `baseRow`, `windowRows`, `hasPrevious`, `hasNext` and boundary callbacks for a host-managed keyset window. An ordinary `rows` array selects the unbounded in-memory mode. Set `copyRows: false` only when the host owns the outer array and keeps its row objects stable.

Columns may define `formatCell(value, row, rowIndex)` for plain text or `paintCell(context, details)` for custom synchronous drawing. Painters receive a clipped context and must not retain it. Use `rowMetrics` to share an `AxisMetrics` instance with a model that owns variable row heights.

In Lumine, the renderer inherits the shared `--data-grid-*` theme tokens for dimensions and semantic colors. A host can override one grid locally with the corresponding `--canvas-grid-*` token without changing the editor-wide table style.

## Exports

- `CanvasGrid`: the canvas surface, interaction state and optional row cache.
- `AxisMetrics`: variable-size axis geometry backed by prefix sums.
- `PagedRowCache`: a generation-safe three-page offset cache.

## Contributing

Got ideas to make this package better, found a bug, or want to help add new features? Just drop your thoughts on GitHub. Any feedback is welcome!
