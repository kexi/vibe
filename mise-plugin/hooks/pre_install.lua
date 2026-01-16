-- hooks/pre_install.lua
-- Returns download information for a specific version
-- Documentation: https://mise.jdx.dev/dev-tools/vfox.html

local function get_platform()
    local os_name = RUNTIME.osType:lower()
    local arch = RUNTIME.archType

    -- vibe asset naming: vibe-{os}-{arch}
    -- OS: darwin, linux, windows
    -- Arch: x64, arm64
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

    return platform
end

function PLUGIN:PreInstall(ctx)
    local version = ctx.version
    local platform = get_platform()

    -- Build asset name: vibe-{os}-{arch}{ext}
    local asset_name = "vibe-" .. platform.os .. "-" .. platform.arch .. platform.ext

    -- Build download URL
    local url = "https://github.com/kexi/vibe/releases/download/v" .. version .. "/" .. asset_name

    return {
        version = version,
        url = url,
    }
end
