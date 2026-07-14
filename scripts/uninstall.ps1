[CmdletBinding()]
param(
    [string]$InstallRoot = (Join-Path $env:USERPROFILE '.codeium\windsurf\deepwork-runtime')
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Deepwork.Install.Common.ps1')

function Remove-OneCanonicalEntry {
    param([object[]]$Entries, [object]$Needle)
    $needleJson = ConvertTo-DeepworkCanonicalJson $Needle
    $removed = $false
    $result = New-Object 'System.Collections.Generic.List[object]'
    foreach ($entry in @($Entries)) {
        if (-not $removed -and (ConvertTo-DeepworkCanonicalJson $entry) -eq $needleJson) {
            $removed = $true
            continue
        }
        $result.Add($entry)
    }
    return [pscustomobject]@{ entries = $result.ToArray(); removed = $removed }
}

function Resolve-PredecessorBackup {
    param([object]$Predecessor)
    if (-not $Predecessor.existed) { return $null }
    if ([string]::IsNullOrWhiteSpace([string]$Predecessor.backup)) {
        throw 'Ownership manifest says a predecessor existed but does not identify its backup.'
    }
    $backup = Resolve-DeepworkRelativeManagedPath -RelativePath $Predecessor.backup -Root $windsurfRoot
    Assert-DeepworkNoReparseAncestors $backup
    if (-not (Test-Path -LiteralPath $backup)) { throw "Required predecessor backup is missing: $backup" }
    return $backup
}

function Restore-OwnedFile {
    param([string]$Target, [object]$Predecessor)
    Assert-DeepworkSafeFile -Path $Target -Root $windsurfRoot
    if ($Predecessor.existed) {
        $backup = Resolve-PredecessorBackup $Predecessor
        Assert-DeepworkSafeFile -Path $backup -Root $windsurfRoot
        Copy-DeepworkFileAtomic -Source $backup -Destination $Target -DestinationRoot $windsurfRoot -RejectSourceHardlinks
    }
    elseif (Test-Path -LiteralPath $Target) {
        Remove-DeepworkSafeFile -Path $Target -Root $windsurfRoot
    }
}

function Restore-OwnedTree {
    param([string]$Target, [object]$Predecessor, [string]$Label)
    Assert-DeepworkContainedPath -Path $Target -Root $windsurfRoot -AllowRoot:$false
    if ($Predecessor.existed) {
        $backup = Resolve-PredecessorBackup $Predecessor
        Assert-DeepworkNoReparseTree $backup
        $stage = Join-Path $uninstallBackupRoot ('restore-' + $Label + '-' + [guid]::NewGuid().ToString('N'))
        Copy-DeepworkTree -Source $backup -Destination $stage -DestinationRoot $windsurfRoot
        if (Test-Path -LiteralPath $Target) { Remove-DeepworkSafeTree -Path $Target -Root $windsurfRoot }
        Move-DeepworkSafeTree -Source $stage -Destination $Target -Root $windsurfRoot
    }
    elseif (Test-Path -LiteralPath $Target) {
        Remove-DeepworkSafeTree -Path $Target -Root $windsurfRoot
    }
}

function Get-PredecessorJson {
    param([object]$Predecessor)
    if (-not $Predecessor.existed) { return [pscustomobject]@{} }
    $backup = Resolve-PredecessorBackup $Predecessor
    $value = Read-DeepworkJsonFile -Path $backup -Root $windsurfRoot
    if ($null -eq $value) { return [pscustomobject]@{} }
    return $value
}

function Save-UninstallBackupFile {
    param([string]$Path, [string]$Label)
    if (-not (Test-Path -LiteralPath $Path)) { return }
    Assert-DeepworkSafeFile -Path $Path -Root $windsurfRoot
    $target = Join-Path $uninstallBackupRoot ($Label + '-' + [guid]::NewGuid().ToString('N'))
    Copy-DeepworkFileAtomic -Source $Path -Destination $target -DestinationRoot $windsurfRoot -RejectSourceHardlinks
}

function Test-NoObjectProperties {
    param([object]$Object)
    return $null -eq $Object -or @($Object.PSObject.Properties).Count -eq 0
}

$profileRoot = Get-DeepworkFullPath $env:USERPROFILE
$codeiumRoot = Get-DeepworkFullPath (Join-Path $profileRoot '.codeium')
$windsurfRoot = Get-DeepworkFullPath (Join-Path $codeiumRoot 'windsurf')
$InstallRoot = Get-DeepworkFullPath $InstallRoot
Assert-DeepworkContainedPath -Path $InstallRoot -Root $windsurfRoot -AllowRoot:$false
Assert-DeepworkNoReparseAncestors $windsurfRoot
if (-not (Test-Path -LiteralPath $windsurfRoot -PathType Container)) {
    throw "Windsurf configuration root does not exist: $windsurfRoot"
}

$manifestPath = Join-Path $windsurfRoot 'deepwork-install.json'
$manifest = Read-DeepworkJsonFile -Path $manifestPath -Root $windsurfRoot
if ($null -eq $manifest -or $manifest.schemaVersion -ne 1 -or $manifest.product -ne 'deepwork-windsurf') {
    throw 'No valid Deepwork ownership manifest exists. Nothing will be deleted.'
}
$manifestInstallRoot = Resolve-DeepworkRelativeManagedPath -RelativePath $manifest.installRoot -Root $windsurfRoot
if (-not $manifestInstallRoot.Equals($InstallRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'Requested runtime path does not match the ownership manifest.'
}
$ownerBackupRoot = Resolve-DeepworkRelativeManagedPath -RelativePath $manifest.ownershipBackupRoot -Root $windsurfRoot
Assert-DeepworkNoReparseTree $ownerBackupRoot

$uninstallBackupRoot = Join-Path $windsurfRoot ("deepwork-backups\uninstall-$(Get-Date -Format 'yyyyMMdd-HHmmss')-$([guid]::NewGuid().ToString('N'))")
New-DeepworkSafeDirectory -Path $uninstallBackupRoot -ContainmentRoot $windsurfRoot | Out-Null
$incomplete = New-Object 'System.Collections.Generic.List[string]'
$hooksHandled = $true

# Restore or leave the skill according to its exact installed/predecessor fingerprint.
$skillState = $manifest.artifacts.skill
$skillTarget = Resolve-DeepworkRelativeManagedPath -RelativePath $skillState.path -Root $windsurfRoot
$skillHandled = $false
if (-not (Test-Path -LiteralPath $skillTarget)) {
    $skillHandled = -not [bool]$skillState.predecessor.existed
}
else {
    Assert-DeepworkNoReparseTree $skillTarget
    $currentSkillHash = Get-DeepworkTreeHash $skillTarget
    if ($currentSkillHash -eq $skillState.installedHash) {
        Restore-OwnedTree -Target $skillTarget -Predecessor $skillState.predecessor -Label 'skill'
        $skillHandled = $true
    }
    elseif ($skillState.predecessor.existed) {
        $skillBackup = Resolve-PredecessorBackup $skillState.predecessor
        if ($currentSkillHash -eq (Get-DeepworkTreeHash $skillBackup)) { $skillHandled = $true }
    }
}
if (-not $skillHandled) {
    $incomplete.Add("Skill was modified or replaced, so it was left untouched: $skillTarget")
}

# Restore workflows only if they still match the exact bytes installed by Deepwork.
foreach ($workflowState in @($manifest.artifacts.workflows)) {
    $target = Resolve-DeepworkRelativeManagedPath -RelativePath $workflowState.path -Root $windsurfRoot
    $handled = $false
    if (-not (Test-Path -LiteralPath $target)) {
        $handled = -not [bool]$workflowState.predecessor.existed
    }
    else {
        Assert-DeepworkSafeFile -Path $target -Root $windsurfRoot
        $currentHash = Get-DeepworkFileHash $target
        if ($currentHash -eq $workflowState.installedHash) {
            Save-UninstallBackupFile -Path $target -Label 'workflow-current'
            Restore-OwnedFile -Target $target -Predecessor $workflowState.predecessor
            $handled = $true
        }
        elseif ($workflowState.predecessor.existed) {
            $backup = Resolve-PredecessorBackup $workflowState.predecessor
            if ($currentHash -eq (Get-DeepworkFileHash $backup)) { $handled = $true }
        }
    }
    if (-not $handled) { $incomplete.Add("Workflow was modified or replaced, so it was left untouched: $target") }
}

# Replace only the exact owned marker block, preserving unrelated edits made later.
$rulesState = $manifest.artifacts.globalRules
$rulesPath = Resolve-DeepworkRelativeManagedPath -RelativePath $rulesState.path -Root $windsurfRoot
$rulesHandled = $false
if (-not (Test-Path -LiteralPath $rulesPath)) {
    $rulesHandled = $null -eq $rulesState.previousManagedBlock
}
else {
    Assert-DeepworkSafeFile -Path $rulesPath -Root $windsurfRoot
    $rulesText = [System.IO.File]::ReadAllText($rulesPath)
    $match = [regex]::Match($rulesText, '(?s)<!-- deepwork:start -->.*?<!-- deepwork:end -->')
    if (-not $match.Success) {
        $rulesHandled = $null -eq $rulesState.previousManagedBlock
    }
    elseif ($match.Value -ceq [string]$rulesState.installedBlock) {
        Save-UninstallBackupFile -Path $rulesPath -Label 'rules-current'
        $replacement = if ($null -eq $rulesState.previousManagedBlock) { '' } else { [string]$rulesState.previousManagedBlock }
        $restoredRules = $rulesText.Substring(0, $match.Index) + $replacement + $rulesText.Substring($match.Index + $match.Length)
        if (-not $rulesState.predecessor.existed -and [string]::IsNullOrWhiteSpace($restoredRules)) {
            Remove-DeepworkSafeFile -Path $rulesPath -Root $windsurfRoot
        }
        else {
            Write-DeepworkTextAtomic -Path $rulesPath -Text $restoredRules -Root $windsurfRoot
        }
        $rulesHandled = $true
    }
    elseif ($match.Value -ceq [string]$rulesState.previousManagedBlock) {
        $rulesHandled = $true
    }
}
if (-not $rulesHandled) { $incomplete.Add("Managed global-rules block was edited, so it was left untouched: $rulesPath") }

# Remove exactly one copy of each hook entry that this installation inserted.
$hooksState = $manifest.artifacts.hooks
$hooksPath = Resolve-DeepworkRelativeManagedPath -RelativePath $hooksState.path -Root $windsurfRoot
if (Test-Path -LiteralPath $hooksPath) {
    Assert-DeepworkSafeFile -Path $hooksPath -Root $windsurfRoot
    $hooksConfig = Read-DeepworkJsonFile -Path $hooksPath -Root $windsurfRoot
    if ($null -eq $hooksConfig) { $hooksConfig = [pscustomobject]@{} }
    $originalHooksConfig = Get-PredecessorJson $hooksState.predecessor
    $changed = $false
    if ($hooksConfig.PSObject.Properties['hooks']) {
        foreach ($hookState in @($hooksState.entries)) {
            if (-not $hookState.inserted) { continue }
            $event = [string]$hookState.event
            if (-not $hooksConfig.hooks.PSObject.Properties[$event]) { continue }
            $removal = Remove-OneCanonicalEntry -Entries @($hooksConfig.hooks.$event) -Needle $hookState.entry
            if ($removal.removed) {
                $hooksConfig.hooks.$event = @($removal.entries)
                $changed = $true
            }
            else {
                $ownedCommand = [string]$hookState.entry.command
                $similarManagedEntry = @($hooksConfig.hooks.$event | Where-Object {
                    [string]$_.command -eq $ownedCommand -or [string]$_.command -like '*deepwork-runtime*deepwork-hook.cmd*'
                }).Count -gt 0
                if ($similarManagedEntry) { $hooksHandled = $false }
            }
            $originalHadEvent = $originalHooksConfig.PSObject.Properties['hooks'] -and $originalHooksConfig.hooks.PSObject.Properties[$event]
            if (@($hooksConfig.hooks.$event).Count -eq 0 -and -not $originalHadEvent) {
                $hooksConfig.hooks.PSObject.Properties.Remove($event)
            }
        }
        $originalHadHooks = $null -ne $originalHooksConfig.PSObject.Properties['hooks']
        if ((Test-NoObjectProperties $hooksConfig.hooks) -and -not $originalHadHooks) {
            $hooksConfig.PSObject.Properties.Remove('hooks')
        }
    }
    if ($changed) {
        Save-UninstallBackupFile -Path $hooksPath -Label 'hooks-current'
        if ($hooksState.predecessor.existed -and
            (ConvertTo-DeepworkCanonicalJson $hooksConfig) -eq (ConvertTo-DeepworkCanonicalJson $originalHooksConfig)) {
            Restore-OwnedFile -Target $hooksPath -Predecessor $hooksState.predecessor
        }
        elseif (-not $hooksState.predecessor.existed -and (Test-NoObjectProperties $hooksConfig)) {
            Remove-DeepworkSafeFile -Path $hooksPath -Root $windsurfRoot
        }
        else {
            Write-DeepworkJsonAtomic -Path $hooksPath -Value $hooksConfig -Root $windsurfRoot
        }
    }
}
if (-not $hooksHandled) {
    $incomplete.Add("A managed hook entry was edited, so it was left untouched: $hooksPath")
}

# Restore the prior deepwork MCP entry only while the current value is provably ours.
$mcpState = $manifest.artifacts.mcp
$mcpPath = Resolve-DeepworkRelativeManagedPath -RelativePath $mcpState.path -Root $windsurfRoot
$mcpHandled = $false
if (-not (Test-Path -LiteralPath $mcpPath)) {
    $mcpHandled = -not [bool]$mcpState.predecessorEntryExisted
}
else {
    Assert-DeepworkSafeFile -Path $mcpPath -Root $windsurfRoot
    $mcpConfig = Read-DeepworkJsonFile -Path $mcpPath -Root $windsurfRoot
    if ($null -eq $mcpConfig) { $mcpConfig = [pscustomobject]@{} }
    $originalMcpConfig = Get-PredecessorJson $mcpState.predecessor
    if ($mcpConfig.PSObject.Properties['mcpServers'] -and $mcpConfig.mcpServers.PSObject.Properties['deepwork']) {
        $currentEntry = $mcpConfig.mcpServers.deepwork
        if ((ConvertTo-DeepworkCanonicalJson $currentEntry) -eq (ConvertTo-DeepworkCanonicalJson $mcpState.entry)) {
            Save-UninstallBackupFile -Path $mcpPath -Label 'mcp-current'
            if ($mcpState.predecessorEntryExisted) {
                Set-DeepworkObjectProperty -Object $mcpConfig.mcpServers -Name 'deepwork' -Value $mcpState.predecessorEntry
            }
            else {
                $mcpConfig.mcpServers.PSObject.Properties.Remove('deepwork')
            }
            $originalHadServers = $null -ne $originalMcpConfig.PSObject.Properties['mcpServers']
            if ((Test-NoObjectProperties $mcpConfig.mcpServers) -and -not $originalHadServers) {
                $mcpConfig.PSObject.Properties.Remove('mcpServers')
            }
            if ($mcpState.predecessor.existed -and
                (ConvertTo-DeepworkCanonicalJson $mcpConfig) -eq (ConvertTo-DeepworkCanonicalJson $originalMcpConfig)) {
                Restore-OwnedFile -Target $mcpPath -Predecessor $mcpState.predecessor
            }
            elseif (-not $mcpState.predecessor.existed -and (Test-NoObjectProperties $mcpConfig)) {
                Remove-DeepworkSafeFile -Path $mcpPath -Root $windsurfRoot
            }
            else {
                Write-DeepworkJsonAtomic -Path $mcpPath -Value $mcpConfig -Root $windsurfRoot
            }
            $mcpHandled = $true
        }
        elseif ($mcpState.predecessorEntryExisted -and
            (ConvertTo-DeepworkCanonicalJson $currentEntry) -eq (ConvertTo-DeepworkCanonicalJson $mcpState.predecessorEntry)) {
            $mcpHandled = $true
        }
    }
    else {
        $mcpHandled = -not [bool]$mcpState.predecessorEntryExisted
    }
}
if (-not $mcpHandled) { $incomplete.Add("The deepwork MCP entry was modified, so it was left untouched: $mcpPath") }

# The runtime is removed only when its private ownership marker matches the manifest.
$runtimeHandled = $false
if (-not (Test-Path -LiteralPath $InstallRoot)) {
    $runtimeHandled = $true
}
else {
    Assert-DeepworkNoReparseTree $InstallRoot
    $markerPath = Resolve-DeepworkRelativeManagedPath -RelativePath $manifest.artifacts.runtime.marker -Root $windsurfRoot
    if (Test-Path -LiteralPath $markerPath -PathType Leaf) {
        $marker = Read-DeepworkJsonFile -Path $markerPath -Root $windsurfRoot
        if ($marker.product -eq 'deepwork-windsurf' -and $marker.installId -eq $manifest.installId) {
            Remove-DeepworkSafeTree -Path $InstallRoot -Root $windsurfRoot
            $runtimeHandled = $true
        }
    }
}
if (-not $runtimeHandled) { $incomplete.Add("Runtime ownership could not be proven, so it was left untouched: $InstallRoot") }

if ($incomplete.Count -eq 0) {
    Save-UninstallBackupFile -Path $manifestPath -Label 'manifest-current'
    Remove-DeepworkSafeFile -Path $manifestPath -Root $windsurfRoot
    Write-Host 'Deepwork uninstalled. Predecessors and unrelated configuration were preserved.'
    Write-Host "Safety backup: $uninstallBackupRoot"
    Write-Host "Original predecessor backup retained at: $ownerBackupRoot"
}
else {
    foreach ($message in $incomplete) { Write-Warning $message }
    throw 'Uninstall was intentionally incomplete. The ownership manifest and backups were retained; resolve the listed modified artifacts and run uninstall again.'
}
