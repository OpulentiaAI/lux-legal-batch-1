export function withLegacyNames(tools, overrides = {}) {
  for (const name of Object.keys(tools)) {
    if (!name.startsWith('opulent_')) continue;
    Object.defineProperty(tools, `devin_${name.slice(8)}`, { value: overrides[name] ?? tools[name] });
  }
  return tools;
}
