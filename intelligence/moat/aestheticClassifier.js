const aesthetics = {
  y2k: ["wrap", "oval", "chrome", "sport", "futuristic"],
  vintage: ["retro", "vintage", "90s"],
  gorpcore: ["outdoor","hiking","technical"],
  archive: ["rare","archive","runway"]
};

export function classifyAesthetic(title="") {
  const t = title.toLowerCase();

  for (const [k,words] of Object.entries(aesthetics)) {
    if (words.some(w=>t.includes(w))) return k;
  }

  return "unknown";
}
