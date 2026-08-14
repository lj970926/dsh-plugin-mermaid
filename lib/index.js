// Host half: no-op. All work happens in the browser.
export const name = "dsh-plugin-mermaid";
export function apply(ctx) {
  ctx.logger?.info?.("dsh-plugin-mermaid: host half loaded (no-op)");
}
