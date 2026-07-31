export { projectVectors } from "./projection/project.ts";
export type { ProjectOptions, ProjectionResult } from "./projection/project.ts";
export { randomProjection } from "./projection/reduce.ts";
export { colorByField, CATEGORICAL, DEFAULT_RGB } from "./color.ts";
export type { ColorResult, FieldValue } from "./color.ts";
// Renderer lives behind ./render to keep the DOM/Three dependency optional.
