[CmdletBinding()]
param([switch]$KeepTemp)

$ErrorActionPreference = 'Stop'
$scriptRoot = Split-Path $PSScriptRoot -Parent
$installScript = Join-Path $PSScriptRoot 'install.ps1'
$uninstallScript = Join-Path $PSScriptRoot 'uninstall.ps1'
$commonScript = Join-Path $PSScriptRoot 'Deepwork.Install.Common.ps1'
$testRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('deepwork-installer-test-' + [guid]::NewGuid().ToString('N'))
$originalProfile = $env:USERPROFILE
$junctions = New-Object 'System.Collections.Generic.List[string]'

function Assert-Test {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw "TEST FAILED: $Message" }
}

function Write-TestText {
    param([string]$Path, [string]$Text)
    New-Item -ItemType Directory -Force -Path (Split-Path $Path -Parent) | Out-Null
    [System.IO.File]::WriteAllText($Path, $Text, (New-Object System.Text.UTF8Encoding($false)))
}

function Write-TestJson {
    param([string]$Path, [object]$Value)
    Write-TestText -Path $Path -Text (($Value | ConvertTo-Json -Depth 30) + "`r`n")
}

function Invoke-ExpectedFailure {
    param([scriptblock]$Action, [string]$ExpectedPattern)
    $failed = $false
    try { & $Action }
    catch {
        $failed = $true
        Assert-Test -Condition ($_.Exception.Message -match $ExpectedPattern) -Message "failure did not match '$ExpectedPattern': $($_.Exception.Message)"
    }
    Assert-Test -Condition $failed -Message "operation unexpectedly succeeded; expected '$ExpectedPattern'"
}

function Assert-SafeTestCleanupPath {
    param([string]$Path)
    $fullPath = [System.IO.Path]::GetFullPath($Path).TrimEnd('\')
    $fullRoot = [System.IO.Path]::GetFullPath($testRoot).TrimEnd('\')
    if ($fullPath -ne $fullRoot -and -not $fullPath.StartsWith($fullRoot + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing test cleanup outside test root: $fullPath"
    }
}

New-Item -ItemType Directory -Force -Path $testRoot | Out-Null
try {
    # Collision restoration + idempotency.
    $profile = Join-Path $testRoot 'normal-profile'
    $windsurf = Join-Path $profile '.codeium\windsurf'
    New-Item -ItemType Directory -Force -Path (Join-Path $windsurf 'skills\deep-build'), (Join-Path $windsurf 'global_workflows'), (Join-Path $windsurf 'memories') | Out-Null
    Write-TestText -Path (Join-Path $windsurf 'skills\deep-build\original.txt') -Text 'original skill'
    Write-TestText -Path (Join-Path $windsurf 'global_workflows\deep-build.md') -Text 'original deep build workflow'
    Write-TestText -Path (Join-Path $windsurf 'global_workflows\deep-review.md') -Text 'original deep review workflow'
    $originalRules = "user-before`r`n<!-- deepwork:start -->`r`n<previous-owner />`r`n<!-- deepwork:end -->`r`nuser-after`r`n"
    Write-TestText -Path (Join-Path $windsurf 'memories\global_rules.md') -Text $originalRules
    Write-TestJson -Path (Join-Path $windsurf 'hooks.json') -Value ([ordered]@{
        hooks = [ordered]@{ pre_read_code = @([ordered]@{ command = 'user-hook'; show_output = $true }) }
        unrelatedRoot = 'keep-hooks'
    })
    Write-TestJson -Path (Join-Path $windsurf 'mcp_config.json') -Value ([ordered]@{
        mcpServers = [ordered]@{
            deepwork = [ordered]@{ command = 'predecessor-command'; args = @('old') }
            other = [ordered]@{ command = 'other-command' }
        }
        unrelatedRoot = 'keep-mcp'
    })

    $env:USERPROFILE = $profile
    & $installScript
    & $installScript

    $manifestPath = Join-Path $windsurf 'deepwork-install.json'
    Assert-Test (Test-Path -LiteralPath $manifestPath) 'ownership manifest was not written'
    $hooks = Get-Content -Raw -LiteralPath (Join-Path $windsurf 'hooks.json') | ConvertFrom-Json
    foreach ($event in @('pre_read_code', 'pre_write_code', 'pre_run_command', 'pre_mcp_tool_use', 'post_read_code', 'post_write_code', 'post_run_command', 'post_mcp_tool_use', 'post_cascade_response_with_transcript')) {
        $managedCount = @($hooks.hooks.$event | Where-Object { $_.command -like '*deepwork-hook.cmd*' }).Count
        Assert-Test ($managedCount -eq 1) "idempotent install produced $managedCount managed entries for $event"
        $managedEntry = @($hooks.hooks.$event | Where-Object { $_.command -like '*deepwork-hook.cmd*' })[0]
        Assert-Test ([string]$managedEntry.powershell -match '^\$OutputEncoding = New-Object System\.Text\.UTF8Encoding\(\$false\); \[Console\]::OutputEncoding = \$OutputEncoding; \[Console\]::In\.ReadToEnd\(\) \| & ''.*deepwork-hook\.cmd''; exit \$LASTEXITCODE$') "Windows PowerShell hook invocation is missing or unsafe for $event"
    }
    Assert-Test (@($hooks.hooks.pre_read_code | Where-Object { $_.command -eq 'user-hook' }).Count -eq 1) 'unrelated predecessor hook was lost'
    $mcp = Get-Content -Raw -LiteralPath (Join-Path $windsurf 'mcp_config.json') | ConvertFrom-Json
    Assert-Test ($mcp.mcpServers.other.command -eq 'other-command') 'unrelated MCP server was lost'
    Assert-Test ($mcp.mcpServers.deepwork.command -like '*node.exe') 'managed MCP command is not absolute node.exe'

    # Add unrelated post-install changes. Uninstall must retain them while restoring collisions.
    $hooks | Add-Member -NotePropertyName unrelatedAfter -NotePropertyValue 'post-install-hook-data'
    $hooks.hooks | Add-Member -NotePropertyName custom_event -NotePropertyValue @([pscustomobject]@{ command = 'custom-hook' })
    Write-TestJson -Path (Join-Path $windsurf 'hooks.json') -Value $hooks
    $mcp.mcpServers | Add-Member -NotePropertyName after -NotePropertyValue ([pscustomobject]@{ command = 'after-command' })
    $mcp | Add-Member -NotePropertyName unrelatedAfter -NotePropertyValue 'post-install-mcp-data'
    Write-TestJson -Path (Join-Path $windsurf 'mcp_config.json') -Value $mcp
    Add-Content -LiteralPath (Join-Path $windsurf 'memories\global_rules.md') -Value 'post-install-rule'

    & $uninstallScript

    Assert-Test (-not (Test-Path -LiteralPath (Join-Path $windsurf 'deepwork-runtime'))) 'runtime remained after uninstall'
    Assert-Test (-not (Test-Path -LiteralPath $manifestPath)) 'manifest remained after complete uninstall'
    Assert-Test ((Get-Content -Raw -LiteralPath (Join-Path $windsurf 'skills\deep-build\original.txt')) -eq 'original skill') 'predecessor skill was not restored'
    Assert-Test ((Get-Content -Raw -LiteralPath (Join-Path $windsurf 'global_workflows\deep-build.md')) -eq 'original deep build workflow') 'predecessor workflow was not restored'
    $restoredRules = Get-Content -Raw -LiteralPath (Join-Path $windsurf 'memories\global_rules.md')
    Assert-Test ($restoredRules -match '<previous-owner />') 'predecessor managed rule block was not restored'
    Assert-Test ($restoredRules -match 'post-install-rule') 'unrelated post-install rule was lost'
    $restoredHooks = Get-Content -Raw -LiteralPath (Join-Path $windsurf 'hooks.json') | ConvertFrom-Json
    Assert-Test (@($restoredHooks.hooks.pre_read_code | Where-Object { $_.command -eq 'user-hook' }).Count -eq 1) 'predecessor hook was not restored'
    Assert-Test (@($restoredHooks.hooks.PSObject.Properties.Value | ForEach-Object { @($_) } | Where-Object { $_.command -like '*deepwork-hook.cmd*' }).Count -eq 0) 'managed hook survived uninstall'
    Assert-Test ($restoredHooks.hooks.custom_event[0].command -eq 'custom-hook') 'post-install unrelated hook was lost'
    Assert-Test ($restoredHooks.unrelatedAfter -eq 'post-install-hook-data') 'post-install hook root data was lost'
    $restoredMcp = Get-Content -Raw -LiteralPath (Join-Path $windsurf 'mcp_config.json') | ConvertFrom-Json
    Assert-Test ($restoredMcp.mcpServers.deepwork.command -eq 'predecessor-command') 'predecessor deepwork MCP entry was not restored'
    Assert-Test ($restoredMcp.mcpServers.other.command -eq 'other-command') 'unrelated predecessor MCP entry was lost'
    Assert-Test ($restoredMcp.mcpServers.after.command -eq 'after-command') 'post-install MCP entry was lost'

    # A hardlinked config file must fail closed before its other link can be modified.
    $hardProfile = Join-Path $testRoot 'hardlink-profile'
    $hardWindsurf = Join-Path $hardProfile '.codeium\windsurf'
    New-Item -ItemType Directory -Force -Path $hardWindsurf | Out-Null
    $outsideHooks = Join-Path $hardProfile 'outside-hooks.json'
    Write-TestJson -Path $outsideHooks -Value ([ordered]@{ hooks = [ordered]@{}; sentinel = 'hardlink-safe' })
    $hardHooks = Join-Path $hardWindsurf 'hooks.json'
    New-Item -ItemType HardLink -Path $hardHooks -Target $outsideHooks | Out-Null
    $outsideBefore = (Get-FileHash -Algorithm SHA256 -LiteralPath $outsideHooks).Hash
    $env:USERPROFILE = $hardProfile
    Invoke-ExpectedFailure -ExpectedPattern 'hardlinked protected file' -Action { & $installScript }
    Assert-Test (((Get-FileHash -Algorithm SHA256 -LiteralPath $outsideHooks).Hash) -eq $outsideBefore) 'hardlink target content changed'
    Assert-Test (-not (Test-Path -LiteralPath (Join-Path $hardWindsurf 'deepwork-install.json'))) 'manifest was written after hardlink rejection'
    Assert-Test (-not (Test-Path -LiteralPath (Join-Path $hardWindsurf 'deepwork-runtime'))) 'runtime remained after hardlink rollback'

    # A junction in a destination ancestor must fail closed without touching its target.
    $junctionProfile = Join-Path $testRoot 'junction-profile'
    $junctionWindsurf = Join-Path $junctionProfile '.codeium\windsurf'
    $junctionOutside = Join-Path $junctionProfile 'outside-skills'
    New-Item -ItemType Directory -Force -Path $junctionWindsurf, $junctionOutside | Out-Null
    Write-TestText -Path (Join-Path $junctionOutside 'sentinel.txt') -Text 'junction-safe'
    $skillsJunction = Join-Path $junctionWindsurf 'skills'
    New-Item -ItemType Junction -Path $skillsJunction -Target $junctionOutside | Out-Null
    $junctions.Add($skillsJunction)
    $env:USERPROFILE = $junctionProfile
    Invoke-ExpectedFailure -ExpectedPattern 'reparse point' -Action { & $installScript }
    Assert-Test ((Get-Content -Raw -LiteralPath (Join-Path $junctionOutside 'sentinel.txt')) -eq 'junction-safe') 'junction target was modified'
    Assert-Test (-not (Test-Path -LiteralPath (Join-Path $junctionWindsurf 'deepwork-install.json'))) 'manifest was written after junction rejection'
    Assert-Test (-not (Test-Path -LiteralPath (Join-Path $junctionWindsurf 'deepwork-runtime'))) 'runtime remained after junction rollback'

    # The recursive source-tree guard itself rejects nested junctions.
    . $commonScript
    $emptySource = Join-Path $testRoot 'empty-source.txt'
    $emptyDestination = Join-Path $testRoot 'empty-destination.txt'
    [System.IO.File]::WriteAllBytes($emptySource, [byte[]]@())
    Copy-DeepworkFileAtomic -Source $emptySource -Destination $emptyDestination -DestinationRoot $testRoot
    Assert-Test ((Get-Item -LiteralPath $emptyDestination).Length -eq 0) 'atomic copy rejected or changed an empty predecessor file'
    $sourceProbe = Join-Path $testRoot 'source-tree-probe'
    $sourceOutside = Join-Path $testRoot 'source-tree-outside'
    New-Item -ItemType Directory -Force -Path $sourceProbe, $sourceOutside | Out-Null
    $sourceJunction = Join-Path $sourceProbe 'nested-link'
    New-Item -ItemType Junction -Path $sourceJunction -Target $sourceOutside | Out-Null
    $junctions.Add($sourceJunction)
    Invoke-ExpectedFailure -ExpectedPattern 'reparse point|link' -Action { Assert-DeepworkNoReparseTree $sourceProbe }

    Write-Host 'Installer tests passed: double install, collision restoration, unrelated-entry preservation, absolute hook probe, empty-file copy, hardlink rejection, junction rejection, and recursive source-link rejection.'
}
finally {
    $env:USERPROFILE = $originalProfile
    if (-not $KeepTemp) {
        foreach ($junction in $junctions) {
            if (Test-Path -LiteralPath $junction) {
                Assert-SafeTestCleanupPath $junction
                $junctionItem = Get-Item -Force -LiteralPath $junction
                Assert-Test (($junctionItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) 'cleanup target stopped being a junction'
                [System.IO.Directory]::Delete([System.IO.Path]::GetFullPath($junction), $false)
            }
        }
        if (Test-Path -LiteralPath $testRoot) {
            Assert-SafeTestCleanupPath $testRoot
            Remove-Item -LiteralPath $testRoot -Force -Recurse
        }
    }
    else { Write-Host "Test files retained at: $testRoot" }
}
