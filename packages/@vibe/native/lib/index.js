/**
 * @vibe/native - Native clone operations
 *
 * Provides Copy-on-Write cloning using:
 * - macOS: clonefile() on APFS
 * - Linux: FICLONE ioctl on Btrfs/XFS
 */

const path = require("path");

let native = null;
let loadError = null;

// Try to load the native module using node-gyp-build
// This handles prebuilds, local builds, and debug builds automatically
try {
  native = require("node-gyp-build")(path.join(__dirname, ".."));
} catch (e) {
  loadError = e;
}

/**
 * Check if native clone operations are available
 * @returns {boolean}
 */
function isAvailable() {
  if (!native) return false;
  try {
    return native.isAvailable();
  } catch {
    return false;
  }
}

/**
 * Check if directory cloning is supported
 * - macOS clonefile: true (supports directories)
 * - Linux FICLONE: false (files only)
 * @returns {boolean}
 */
function supportsDirectory() {
  if (!native) return false;
  try {
    return native.supportsDirectory();
  } catch {
    return false;
  }
}

/**
 * Get the current platform
 * @returns {string} "darwin", "linux", or "unknown"
 */
function getPlatform() {
  if (!native) return "unknown";
  try {
    return native.getPlatform();
  } catch {
    return "unknown";
  }
}

/**
 * Clone a file using native Copy-on-Write
 * @param {string} src - Source file path
 * @param {string} dest - Destination file path
 * @returns {Promise<void>}
 */
async function cloneFile(src, dest) {
  if (!native) {
    throw new Error(
      loadError
        ? `Native module not available: ${loadError.message}`
        : "Native module not loaded"
    );
  }

  return new Promise((resolve, reject) => {
    try {
      native.clone(src, dest);
      resolve();
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Clone a directory using native Copy-on-Write
 * Note: Only supported on macOS (clonefile). Linux FICLONE does not support directories.
 * @param {string} src - Source directory path
 * @param {string} dest - Destination directory path
 * @returns {Promise<void>}
 */
async function cloneDirectory(src, dest) {
  if (!supportsDirectory()) {
    throw new Error("Directory cloning not supported on this platform");
  }
  return cloneFile(src, dest);
}

/**
 * Get the load error if native module failed to load
 * @returns {Error|null}
 */
function getLoadError() {
  return loadError;
}

module.exports = {
  isAvailable,
  supportsDirectory,
  getPlatform,
  cloneFile,
  cloneDirectory,
  getLoadError,
};
