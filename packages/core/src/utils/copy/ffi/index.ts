export type { FFIResult, NativeClone } from "./types.ts";
export { DARWIN_ERROR_CODES, LINUX_ERROR_CODES, shouldFallback } from "./types.ts";
export { getNativeClone, isFFIAvailable } from "./detector.ts";
export { DarwinClone } from "./darwin.ts";
export { LinuxClone } from "./linux.ts";
