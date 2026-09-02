# canvas-grid

Render large tabular datasets in an interactive canvas grid.

The grid keeps its DOM fixed while drawing only the visible rows and columns. It supports in-memory rows, offset-backed paging and explicit keyset windows without coupling the renderer to an application framework.

## Features

- **Bounded rendering**: a scroll sizer and two sticky canvases cover arbitrarily large logical grids without creating one element per cell.
- **Flexible data**: use an in-memory row array, an asynchronous offset loader or a keyset window managed by the host.
- **Fast geometry**: prefix-sum axis metrics provide variable item sizes, offset queries and hit-testing without scanning an axis.
- **Interaction**: keyboard navigation, rectangular multi-selection, resizing and bounded clipboard export are available through a host-neutral API.
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

## Exports

- `CanvasGrid`: the canvas surface, interaction state and optional row cache.
- `AxisMetrics`: variable-size axis geometry backed by prefix sums.
- `PagedRowCache`: a generation-safe three-page offset cache.

## Contributing

Got ideas, found a bug, or want to help? Open an issue or send a pull request.
