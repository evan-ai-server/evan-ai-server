export function clusterListings(items) {

  const clusters = {};

  for (const it of items) {

    const key = (it.title || "").slice(0,20);

    if (!clusters[key]) clusters[key] = [];

    clusters[key].push(it);
  }

  return Object.values(clusters);
}
