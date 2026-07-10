export type {
  ComputerExecutor,
  DisplayGeometry,
  FrontmostApp,
  InstalledApp,
  ResolvePrepareCaptureResult,
  RunningApp,
  ScreenshotResult,
} from "./executor";

export type {
  AppGrant,
  CuAppPermTier,
  ComputerUseHostAdapter,
  ComputerUseOverrides,
  ComputerUseSessionContext,
  CoordinateMode,
  CuGrantFlags,
  CuPermissionRequest,
  CuPermissionResponse,
  CuSubGates,
  CuTeachPermissionRequest,
  Logger,
  ResolvedAppRequest,
  ScreenshotDims,
  TeachStepRequest,
  TeachStepResult,
} from "./types";

export { DEFAULT_GRANT_FLAGS } from "./types";

export {
  SENTINEL_BUNDLE_IDS,
  getSentinelCategory,
} from "./sentinelApps";
export type { SentinelCategory } from "./sentinelApps";

export {
  categoryToTier,
  getDefaultTierForApp,
  getDeniedCategory,
  getDeniedCategoryByDisplayName,
  getDeniedCategoryForApp,
  isPolicyDenied,
} from "./deniedApps";
export type { DeniedCategory } from "./deniedApps";

export { isSystemKeyCombo, normalizeKeySequence } from "./keyBlocklist";

export { ALL_SUB_GATES_OFF, ALL_SUB_GATES_ON } from "./subGates";

export { API_RESIZE_PARAMS, targetImageSize } from "./imageResize";
export type { ResizeParams } from "./imageResize";

export { defersLockAcquire, handleToolCall } from "./toolCalls";
export type {
  CuCallTelemetry,
  CuCallToolResult,
  CuErrorKind,
} from "./toolCalls";

export { bindSessionContext, createComputerUseMcpServer } from "./mcpServer";
export { buildComputerUseTools } from "./tools";

export {
  comparePixelAtLocation,
  validateClickTarget,
} from "./pixelCompare";
export type { CropRawPatchFn, PixelCompareResult } from "./pixelCompare";
