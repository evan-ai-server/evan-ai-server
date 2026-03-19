export function fuseIdentity(visionIdentity, textHints = {}, marketHints = {}) {
  return {
    ...visionIdentity,
    ...textHints,
    ...marketHints,
    fusionConfidence:
      (visionIdentity?.confidence || 0.5) * 0.6 +
      (textHints?.confidence || 0.3) * 0.2 +
      (marketHints?.confidence || 0.3) * 0.2
  };
}
