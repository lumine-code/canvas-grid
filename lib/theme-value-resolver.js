// Custom properties retain CSS expressions and units. Resolve them through a
// normal property before passing lengths or colors to the canvas renderer.
function createThemeValueResolver(element, fontSize) {
  const document = element.ownerDocument;
  const probe = element.isConnected ? document.createElement("div") : null;
  if (probe) {
    probe.style.cssText =
      "all:initial;position:absolute;visibility:hidden;pointer-events:none;display:block;color:inherit;";
    probe.style.fontSize = `${fontSize}px`;
    element.appendChild(probe);
  }
  const computedStyle = () => document.defaultView.getComputedStyle(probe);

  return {
    pixels(value, fallback) {
      let resolved;
      if (probe) {
        probe.style.height = `${fallback}px`;
        probe.style.height = value;
        resolved = computedStyle().height;
      } else {
        // The first attached resize rereads the theme. Detached initialization
        // can use absolute lengths, but must not mistake em/rem for pixels.
        resolved = /^\d*\.?\d+px$/.test(value) ? value : "";
      }
      const parsed = Number.parseFloat(resolved);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
    },
    color(value, fallback) {
      if (!probe) return value || fallback;
      probe.style.color = fallback;
      probe.style.color = value;
      return computedStyle().color || fallback;
    },
    destroy() {
      probe?.remove();
    },
  };
}

module.exports = createThemeValueResolver;
