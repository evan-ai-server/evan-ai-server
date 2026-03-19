export function extractVisualFeatures(identity) {
  return {
    colors: identity?.colors || [],
    materials: identity?.materials || [],
    shapes: identity?.styleWords || []
  };
}
