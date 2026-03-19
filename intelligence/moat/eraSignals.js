export function inferEra(title="") {
  const t = title.toLowerCase();

  if (t.includes("y2k") || t.includes("2000")) return "2000s";
  if (t.includes("90")) return "90s";

  return "modern";
}
