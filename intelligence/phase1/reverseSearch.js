export function reverseImageCandidates(identity) {
  const out = [];

  if (identity?.brand) out.push(identity.brand);
  if (identity?.model) out.push(identity.model);

  if (identity?.colors?.length) {
    out.push(identity.colors.join(" "));
  }

  return out.filter(Boolean);
}
