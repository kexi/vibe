/**
 * Native clone operations for Node.js
 *
 * macOS: Uses clonefile() for Copy-on-Write cloning on APFS
 * Linux: Uses FICLONE ioctl for Copy-on-Write cloning on Btrfs/XFS
 */

#define NAPI_VERSION 8
#include <node_api.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdbool.h>
#include <errno.h>
#include <limits.h>

#ifndef PATH_MAX
#define PATH_MAX 4096
#endif

/* Buffer sizes and permission constants */
#define ERROR_MSG_BUFFER_SIZE 256
#define ARG_ERROR_MSG_SIZE 128
#define DEFAULT_FILE_MODE 0644  /* rw-r--r-- */

#ifdef __DARWIN__
#include <copyfile.h>
#include <sys/clonefile.h>
#endif

#ifdef __LINUX__
#include <fcntl.h>
#include <unistd.h>
#include <sys/ioctl.h>
#include <linux/fs.h>

#ifndef FICLONE
#define FICLONE _IOW(0x94, 9, int)
#endif
#endif

/**
 * Helper to throw JavaScript error with errno information
 */
static napi_value throw_errno_error(napi_env env, const char* operation, int err) {
  char message[ERROR_MSG_BUFFER_SIZE];
  snprintf(message, sizeof(message), "%s failed: %s (errno %d)", operation, strerror(err), err);

  napi_value error_obj;
  napi_value error_msg;
  napi_value error_code;

  napi_create_string_utf8(env, message, NAPI_AUTO_LENGTH, &error_msg);
  napi_create_error(env, NULL, error_msg, &error_obj);
  napi_create_int32(env, err, &error_code);
  napi_set_named_property(env, error_obj, "errno", error_code);

  napi_throw(env, error_obj);
  return NULL;
}

/**
 * Helper to validate and get string argument
 * Returns true on success, false on failure (with error thrown)
 */
static bool get_string_arg(napi_env env, napi_value value, char* buffer, size_t buffer_size, size_t* length, const char* arg_name) {
  napi_valuetype type;
  napi_status status;

  status = napi_typeof(env, value, &type);
  if (status != napi_ok || type != napi_string) {
    char error_msg[ARG_ERROR_MSG_SIZE];
    snprintf(error_msg, sizeof(error_msg), "%s must be a string", arg_name);
    napi_throw_type_error(env, NULL, error_msg);
    return false;
  }

  status = napi_get_value_string_utf8(env, value, buffer, buffer_size, length);
  if (status != napi_ok) {
    char error_msg[ARG_ERROR_MSG_SIZE];
    snprintf(error_msg, sizeof(error_msg), "Failed to read %s string", arg_name);
    napi_throw_error(env, NULL, error_msg);
    return false;
  }

  // Validate path is not empty
  if (*length == 0) {
    char error_msg[ARG_ERROR_MSG_SIZE];
    snprintf(error_msg, sizeof(error_msg), "%s cannot be empty", arg_name);
    napi_throw_error(env, NULL, error_msg);
    return false;
  }

  return true;
}

#ifdef __DARWIN__
/**
 * macOS: Clone file or directory using clonefile()
 *
 * clonefile(src, dst, flags) creates a copy-on-write clone.
 * Works on APFS filesystems for both files and directories.
 */
static napi_value darwin_clonefile(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);

  if (argc < 2) {
    napi_throw_error(env, NULL, "clonefile requires 2 arguments: src, dest");
    return NULL;
  }

  char src[PATH_MAX];
  char dest[PATH_MAX];
  size_t src_len, dest_len;

  // Validate and get source path
  if (!get_string_arg(env, argv[0], src, PATH_MAX, &src_len, "src")) {
    return NULL;
  }

  // Validate and get destination path
  if (!get_string_arg(env, argv[1], dest, PATH_MAX, &dest_len, "dest")) {
    return NULL;
  }

  int result = clonefile(src, dest, 0);

  if (result != 0) {
    return throw_errno_error(env, "clonefile", errno);
  }

  napi_value undefined;
  napi_get_undefined(env, &undefined);
  return undefined;
}

/**
 * macOS: Check if clonefile is available (always true on macOS 10.12+)
 */
static napi_value darwin_is_available(napi_env env, napi_callback_info info) {
  napi_value result;
  napi_get_boolean(env, true, &result);
  return result;
}

/**
 * macOS: Check if directory cloning is supported (true for clonefile)
 */
static napi_value darwin_supports_directory(napi_env env, napi_callback_info info) {
  napi_value result;
  napi_get_boolean(env, true, &result);
  return result;
}
#endif

#ifdef __LINUX__
/**
 * Linux: Clone file using FICLONE ioctl
 *
 * FICLONE creates a copy-on-write clone on filesystems that support it
 * (Btrfs, XFS with reflink support). Only works for regular files.
 */
static napi_value linux_ficlone(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);

  if (argc < 2) {
    napi_throw_error(env, NULL, "ficlone requires 2 arguments: src, dest");
    return NULL;
  }

  char src[PATH_MAX];
  char dest[PATH_MAX];
  size_t src_len, dest_len;

  // Validate and get source path
  if (!get_string_arg(env, argv[0], src, PATH_MAX, &src_len, "src")) {
    return NULL;
  }

  // Validate and get destination path
  if (!get_string_arg(env, argv[1], dest, PATH_MAX, &dest_len, "dest")) {
    return NULL;
  }

  // Open source file for reading
  int src_fd = open(src, O_RDONLY);
  if (src_fd < 0) {
    return throw_errno_error(env, "open source", errno);
  }

  // Create/open destination file for writing
  int dest_fd = open(dest, O_WRONLY | O_CREAT | O_TRUNC, DEFAULT_FILE_MODE);
  if (dest_fd < 0) {
    int saved_errno = errno;
    close(src_fd);
    return throw_errno_error(env, "open dest", saved_errno);
  }

  // Perform FICLONE ioctl
  int result = ioctl(dest_fd, FICLONE, src_fd);
  int saved_errno = errno;

  close(src_fd);
  close(dest_fd);

  if (result != 0) {
    // Remove partially created destination file on failure
    unlink(dest);
    return throw_errno_error(env, "ioctl FICLONE", saved_errno);
  }

  napi_value undefined;
  napi_get_undefined(env, &undefined);
  return undefined;
}

/**
 * Linux: Check if FICLONE is available
 * We assume it's available if we're on Linux; actual support depends on filesystem
 */
static napi_value linux_is_available(napi_env env, napi_callback_info info) {
  napi_value result;
  napi_get_boolean(env, true, &result);
  return result;
}

/**
 * Linux: Check if directory cloning is supported (false for FICLONE)
 */
static napi_value linux_supports_directory(napi_env env, napi_callback_info info) {
  napi_value result;
  napi_get_boolean(env, false, &result);
  return result;
}
#endif

/**
 * Get platform name
 */
static napi_value get_platform(napi_env env, napi_callback_info info) {
  napi_value result;
#ifdef __DARWIN__
  napi_create_string_utf8(env, "darwin", NAPI_AUTO_LENGTH, &result);
#elif defined(__LINUX__)
  napi_create_string_utf8(env, "linux", NAPI_AUTO_LENGTH, &result);
#else
  napi_create_string_utf8(env, "unknown", NAPI_AUTO_LENGTH, &result);
#endif
  return result;
}

/**
 * Module initialization
 */
static napi_value Init(napi_env env, napi_value exports) {
  napi_value platform_fn, clone_fn, is_available_fn, supports_dir_fn;

  napi_create_function(env, NULL, 0, get_platform, NULL, &platform_fn);
  napi_set_named_property(env, exports, "getPlatform", platform_fn);

#ifdef __DARWIN__
  napi_create_function(env, NULL, 0, darwin_clonefile, NULL, &clone_fn);
  napi_create_function(env, NULL, 0, darwin_is_available, NULL, &is_available_fn);
  napi_create_function(env, NULL, 0, darwin_supports_directory, NULL, &supports_dir_fn);
#elif defined(__LINUX__)
  napi_create_function(env, NULL, 0, linux_ficlone, NULL, &clone_fn);
  napi_create_function(env, NULL, 0, linux_is_available, NULL, &is_available_fn);
  napi_create_function(env, NULL, 0, linux_supports_directory, NULL, &supports_dir_fn);
#else
  // Unsupported platform - provide stubs that throw
  napi_value unavailable;
  napi_get_boolean(env, false, &unavailable);
  napi_set_named_property(env, exports, "isAvailable", unavailable);
  return exports;
#endif

  napi_set_named_property(env, exports, "clone", clone_fn);
  napi_set_named_property(env, exports, "isAvailable", is_available_fn);
  napi_set_named_property(env, exports, "supportsDirectory", supports_dir_fn);

  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
