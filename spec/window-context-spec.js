const { CanvasGrid } = require("../lib/canvas-grid");

describe("CanvasGrid document ownership", () => {
  let grid;
  beforeEach(() => {
    jasmine.useRealClock();
    jasmine.attachToDOM(lumine.workspace.getElement());
  });
  afterEach(async () => {
    grid?.destroy();
    await lumine.workspace.discardEditorWindows();
  });
  it("rebinds observers, frames and window pointer listeners after adoption", async () => {
    grid = new CanvasGrid({
      columns: [{ key: 0 }],
      rows: [["one"], ["two"]],
      width: 240,
      height: 100,
    });
    lumine.workspace.getElement().appendChild(grid.element);
    grid.setSelections([{ r0: 1, r1: 1, c0: 0, c1: 0 }]);
    const oldObserver = grid.resizeObserver;
    const release = spyOn(oldObserver, "disconnect").and.callThrough();
    const extra = await lumine.workspace.openEditorWindow({ show: false });
    const document = extra.getDocument();
    const frames = spyOn(
      document.defaultView,
      "requestAnimationFrame",
    ).and.returnValue(700);
    document.adoptNode(grid.element);
    extra.getElement().appendChild(grid.element);
    grid.bindDocument();
    expect(release).toHaveBeenCalled();
    expect(grid.resizeObserver).not.toBe(oldObserver);
    expect(grid.presentationWindow).toBe(document.defaultView);
    expect(grid.selection.r0).toBe(1);
    grid.scheduleDraw();
    expect(frames).toHaveBeenCalled();
    const moved = spyOn(grid, "handleWindowMouseMove").and.callThrough();
    grid.dragging = true;
    document.defaultView.addEventListener(
      "mousemove",
      grid.handlers.windowMousemove,
    );
    window.dispatchEvent(new MouseEvent("mousemove"));
    expect(moved).not.toHaveBeenCalled();
    document.defaultView.dispatchEvent(
      new document.defaultView.MouseEvent("mousemove"),
    );
    expect(moved).toHaveBeenCalled();
    grid.bindDocument(window.document);
    expect(grid.presentationWindow).toBe(window);
  });
});
