-- hooks/post_install.lua
-- Performs additional setup after installation
-- Documentation: https://mise.jdx.dev/dev-tools/vfox.html

local function get_downloaded_filename()
    local os_name = RUNTIME.osType:lower()
    local arch = RUNTIME.archType

    -- vibe asset naming: vibe-{os}-{arch}
    local platform_map = {
        ["darwin"] = {
            ["amd64"] = { os = "darwin", arch = "x64", ext = "" },
            ["arm64"] = { os = "darwin", arch = "arm64", ext = "" },
        },
        ["linux"] = {
            ["amd64"] = { os = "linux", arch = "x64", ext = "" },
            ["arm64"] = { os = "linux", arch = "arm64", ext = "" },
        },
        ["windows"] = {
            ["amd64"] = { os = "windows", arch = "x64", ext = ".exe" },
        },
    }

    local os_map = platform_map[os_name]
    if os_map == nil then
        error("Unsupported operating system: " .. os_name)
    end

    local platform = os_map[arch]
    if platform == nil then
        error("Unsupported architecture: " .. arch .. " on " .. os_name)
    end

    return "vibe-" .. platform.os .. "-" .. platform.arch .. platform.ext
end

-- Shell-escape a string to prevent command injection
local function shell_escape(s)
    return "'" .. s:gsub("'", "'\\''") .. "'"
end

function PLUGIN:PostInstall(ctx)
    local sdkInfo = ctx.sdkInfo[PLUGIN.name]
    local path = sdkInfo.path

    -- Determine source and destination file names
    local os_name = RUNTIME.osType:lower()
    local isWindows = os_name == "windows"

    local srcFilename = get_downloaded_filename()
    local destFilename = "vibe"
    if isWindows then
        destFilename = "vibe.exe"
    end

    local binDir = path .. "/bin"
    local srcFile = path .. "/" .. srcFilename
    local destFile = binDir .. "/" .. destFilename

    -- Create bin directory (platform-specific)
    local mkdirResult
    if isWindows then
        mkdirResult = os.execute("if not exist " .. shell_escape(binDir) .. " mkdir " .. shell_escape(binDir))
    else
        mkdirResult = os.execute("mkdir -p " .. shell_escape(binDir))
    end
    if mkdirResult ~= 0 then
        error("Failed to create bin directory")
    end

    -- Move binary to bin/ and rename (platform-specific)
    local mvResult
    if isWindows then
        mvResult = os.execute("move " .. shell_escape(srcFile) .. " " .. shell_escape(destFile))
    else
        mvResult = os.execute("mv " .. shell_escape(srcFile) .. " " .. shell_escape(destFile))
    end
    if mvResult ~= 0 then
        error("Failed to move vibe binary to bin/")
    end

    -- Set executable permission on Unix systems
    local isUnix = not isWindows
    if isUnix then
        local chmodResult = os.execute("chmod +x " .. shell_escape(destFile))
        if chmodResult ~= 0 then
            error("Failed to set executable permission on vibe")
        end
    end

    -- Verify installation (platform-specific null device)
    local nullDevice = isWindows and "NUL" or "/dev/null"
    local testResult = os.execute(shell_escape(destFile) .. " --version > " .. nullDevice .. " 2>&1")
    if testResult ~= 0 then
        error("vibe installation verification failed")
    end
end
