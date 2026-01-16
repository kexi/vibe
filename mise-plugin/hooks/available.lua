-- hooks/available.lua
-- Returns a list of available versions for vibe
-- Documentation: https://mise.jdx.dev/dev-tools/vfox.html

function PLUGIN:Available(ctx)
    local http = require("http")
    local json = require("json")

    local repo_url = "https://api.github.com/repos/kexi/vibe/releases"

    local resp, err = http.get({
        url = repo_url,
    })

    if err ~= nil then
        error("Failed to fetch versions: " .. err)
    end
    if resp.status_code ~= 200 then
        error("GitHub API returned status " .. resp.status_code .. ": " .. resp.body)
    end

    local releases = json.decode(resp.body)
    local result = {}

    for _, release in ipairs(releases) do
        local isDraft = release.draft or false
        local isPrerelease = release.prerelease or false
        local shouldSkip = isDraft or isPrerelease

        if not shouldSkip then
            local version = release.tag_name
            -- Remove 'v' prefix (v0.8.0 -> 0.8.0)
            local hasVPrefix = version:sub(1, 1) == "v"
            if hasVPrefix then
                version = version:sub(2)
            end

            table.insert(result, {
                version = version,
                note = release.name or nil,
            })
        end
    end

    return result
end
