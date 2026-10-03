/** PI_MODEL accepts "provider/model" or a bare Anthropic model ID. Default: Claude Opus 5.5. */
export function modelSpec(value = process.env.PI_MODEL) {
  const spec = value?.trim() || "anthropic/claude-opus-5-5";
  const [provider, id] = spec.includes("/") ? spec.split("/", 2) as [string, string] : ["anthropic", spec];
  return { provider, id, label: `${provider}/${id}` };
}
