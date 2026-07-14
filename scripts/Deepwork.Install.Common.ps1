Set-StrictMode -Version 2.0

function Get-DeepworkFullPath {
    param([Parameter(Mandatory = $true)][string]$Path)
    return [System.IO.Path]::GetFullPath($Path).TrimEnd('\')
}

function Test-DeepworkContainedPath {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Root,
        [switch]$AllowRoot
    )
    $fullPath = Get-DeepworkFullPath $Path
    $fullRoot = Get-DeepworkFullPath $Root
    if ($fullPath.Equals($fullRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        return [bool]$AllowRoot
    }
    return $fullPath.StartsWith($fullRoot + '\', [System.StringComparison]::OrdinalIgnoreCase)
}

function Assert-DeepworkContainedPath {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Root,
        [switch]$AllowRoot
    )
    if (-not (Test-DeepworkContainedPath -Path $Path -Root $Root -AllowRoot:$AllowRoot)) {
        throw "Refusing path outside the managed root: $(Get-DeepworkFullPath $Path)"
    }
}

function Assert-DeepworkNoReparseAncestors {
    param([Parameter(Mandatory = $true)][string]$Path)
    $fullPath = Get-DeepworkFullPath $Path
    $volumeRoot = [System.IO.Path]::GetPathRoot($fullPath)
    if ([string]::IsNullOrWhiteSpace($volumeRoot)) { throw "Path is not rooted: $Path" }
    $current = $volumeRoot.TrimEnd('\') + '\'
    $relative = $fullPath.Substring($volumeRoot.Length)
    foreach ($segment in ($relative -split '[\\/]' | Where-Object { $_ })) {
        $current = Join-Path $current $segment
        if (Test-Path -LiteralPath $current) {
            $item = Get-Item -Force -LiteralPath $current
            if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "Refusing reparse point in path: $current"
            }
        }
    }
}

function Assert-DeepworkNoReparseTree {
    param([Parameter(Mandatory = $true)][string]$Path)
    $fullPath = Get-DeepworkFullPath $Path
    Assert-DeepworkNoReparseAncestors $fullPath
    if (-not (Test-Path -LiteralPath $fullPath)) { return }
    $rootItem = Get-Item -Force -LiteralPath $fullPath
    if (($rootItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Refusing reparse-point tree root: $fullPath"
    }
    if (-not $rootItem.PSIsContainer) { return }

    $queue = New-Object 'System.Collections.Generic.Queue[string]'
    $queue.Enqueue($fullPath)
    while ($queue.Count -gt 0) {
        $directory = $queue.Dequeue()
        foreach ($item in @(Get-ChildItem -Force -LiteralPath $directory)) {
            if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "Refusing link or reparse point inside copied/removed tree: $($item.FullName)"
            }
            if ($item.PSIsContainer) { $queue.Enqueue($item.FullName) }
        }
    }
}

function Assert-DeepworkSingleLinkFile {
    param([Parameter(Mandatory = $true)][string]$Path)
    $fullPath = Get-DeepworkFullPath $Path
    if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) { return }
    if (-not ('DeepworkNativeFileInfo' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

[StructLayout(LayoutKind.Sequential)]
public struct DeepworkByHandleFileInformation {
    public uint FileAttributes;
    public System.Runtime.InteropServices.ComTypes.FILETIME CreationTime;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastAccessTime;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWriteTime;
    public uint VolumeSerialNumber;
    public uint FileSizeHigh;
    public uint FileSizeLow;
    public uint NumberOfLinks;
    public uint FileIndexHigh;
    public uint FileIndexLow;
}

public static class DeepworkNativeFileInfo {
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool GetFileInformationByHandle(
        IntPtr handle,
        out DeepworkByHandleFileInformation information);
}
'@
    }
    $stream = $null
    try {
        $share = [System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete
        $stream = New-Object System.IO.FileStream($fullPath, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, $share)
        $information = New-Object DeepworkByHandleFileInformation
        $ok = [DeepworkNativeFileInfo]::GetFileInformationByHandle($stream.SafeFileHandle.DangerousGetHandle(), [ref]$information)
        if (-not $ok) {
            $errorCode = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
            throw "Could not verify hardlink count for protected file (Win32 $errorCode): $fullPath"
        }
        if ($information.NumberOfLinks -ne 1) {
            throw "Refusing hardlinked protected file: $fullPath"
        }
    }
    finally {
        if ($null -ne $stream) { $stream.Dispose() }
    }
}

function Assert-DeepworkSafeFile {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Root
    )
    $fullPath = Get-DeepworkFullPath $Path
    Assert-DeepworkContainedPath -Path $fullPath -Root $Root -AllowRoot:$false
    Assert-DeepworkNoReparseAncestors $fullPath
    if (Test-Path -LiteralPath $fullPath) {
        $item = Get-Item -Force -LiteralPath $fullPath
        if ($item.PSIsContainer) { throw "Expected a file but found a directory: $fullPath" }
        if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Refusing reparse-point file: $fullPath"
        }
        Assert-DeepworkSingleLinkFile $fullPath
    }
}

function New-DeepworkSafeDirectory {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$ContainmentRoot,
        [switch]$AllowRoot
    )
    $fullPath = Get-DeepworkFullPath $Path
    Assert-DeepworkContainedPath -Path $fullPath -Root $ContainmentRoot -AllowRoot:$AllowRoot
    Assert-DeepworkNoReparseAncestors $fullPath
    if (Test-Path -LiteralPath $fullPath) {
        $item = Get-Item -Force -LiteralPath $fullPath
        if (-not $item.PSIsContainer) { throw "Expected directory but found file: $fullPath" }
    }
    else {
        New-Item -ItemType Directory -Force -Path $fullPath | Out-Null
    }
    Assert-DeepworkNoReparseAncestors $fullPath
    return $fullPath
}

function Write-DeepworkBytesAtomic {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][AllowEmptyCollection()][byte[]]$Bytes,
        [Parameter(Mandatory = $true)][string]$Root
    )
    $fullPath = Get-DeepworkFullPath $Path
    $parent = Split-Path $fullPath -Parent
    New-DeepworkSafeDirectory -Path $parent -ContainmentRoot $Root -AllowRoot | Out-Null
    Assert-DeepworkSafeFile -Path $fullPath -Root $Root
    $temporary = Join-Path $parent ('.deepwork-tmp-' + [guid]::NewGuid().ToString('N'))
    $replaceBackup = Join-Path $parent ('.deepwork-replace-' + [guid]::NewGuid().ToString('N'))
    Assert-DeepworkSafeFile -Path $temporary -Root $Root
    Assert-DeepworkSafeFile -Path $replaceBackup -Root $Root
    try {
        [System.IO.File]::WriteAllBytes($temporary, $Bytes)
        Assert-DeepworkSafeFile -Path $temporary -Root $Root
        Assert-DeepworkSafeFile -Path $fullPath -Root $Root
        if (Test-Path -LiteralPath $fullPath) {
            # Windows PowerShell 5.1 does not bind a null File.Replace backup path
            # correctly. A same-directory throwaway backup keeps the replacement
            # atomic and is removed only after the replacement has completed.
            [System.IO.File]::Replace($temporary, $fullPath, $replaceBackup)
        }
        else {
            [System.IO.File]::Move($temporary, $fullPath)
        }
    }
    finally {
        if (Test-Path -LiteralPath $temporary) {
            Assert-DeepworkSafeFile -Path $temporary -Root $Root
            [System.IO.File]::Delete($temporary)
        }
        if (Test-Path -LiteralPath $replaceBackup) {
            Assert-DeepworkSafeFile -Path $replaceBackup -Root $Root
            [System.IO.File]::Delete($replaceBackup)
        }
    }
}

function Write-DeepworkTextAtomic {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [AllowEmptyString()][string]$Text,
        [Parameter(Mandatory = $true)][string]$Root
    )
    $encoding = New-Object System.Text.UTF8Encoding($false)
    Write-DeepworkBytesAtomic -Path $Path -Bytes $encoding.GetBytes([string]$Text) -Root $Root
}

function Copy-DeepworkFileAtomic {
    param(
        [Parameter(Mandatory = $true)][string]$Source,
        [Parameter(Mandatory = $true)][string]$Destination,
        [Parameter(Mandatory = $true)][string]$DestinationRoot,
        [switch]$RejectSourceHardlinks
    )
    $fullSource = Get-DeepworkFullPath $Source
    Assert-DeepworkNoReparseAncestors $fullSource
    if (-not (Test-Path -LiteralPath $fullSource -PathType Leaf)) { throw "Source file is missing: $fullSource" }
    if ($RejectSourceHardlinks) { Assert-DeepworkSingleLinkFile $fullSource }
    $bytes = [System.IO.File]::ReadAllBytes($fullSource)
    Write-DeepworkBytesAtomic -Path $Destination -Bytes $bytes -Root $DestinationRoot
}

function Copy-DeepworkTree {
    param(
        [Parameter(Mandatory = $true)][string]$Source,
        [Parameter(Mandatory = $true)][string]$Destination,
        [Parameter(Mandatory = $true)][string]$DestinationRoot
    )
    $fullSource = Get-DeepworkFullPath $Source
    $fullDestination = Get-DeepworkFullPath $Destination
    Assert-DeepworkNoReparseTree $fullSource
    if (-not (Test-Path -LiteralPath $fullSource -PathType Container)) { throw "Source directory is missing: $fullSource" }
    if (Test-Path -LiteralPath $fullDestination) { throw "Tree destination already exists: $fullDestination" }
    New-DeepworkSafeDirectory -Path $fullDestination -ContainmentRoot $DestinationRoot | Out-Null

    $queue = New-Object 'System.Collections.Generic.Queue[object]'
    $queue.Enqueue(@($fullSource, $fullDestination))
    while ($queue.Count -gt 0) {
        $pair = $queue.Dequeue()
        foreach ($item in @(Get-ChildItem -Force -LiteralPath $pair[0])) {
            if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "Refusing link or reparse point while copying: $($item.FullName)"
            }
            $target = Join-Path $pair[1] $item.Name
            if ($item.PSIsContainer) {
                New-DeepworkSafeDirectory -Path $target -ContainmentRoot $DestinationRoot | Out-Null
                $queue.Enqueue(@($item.FullName, $target))
            }
            else {
                Copy-DeepworkFileAtomic -Source $item.FullName -Destination $target -DestinationRoot $DestinationRoot
            }
        }
    }
}

function Remove-DeepworkSafeFile {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Root
    )
    $fullPath = Get-DeepworkFullPath $Path
    Assert-DeepworkSafeFile -Path $fullPath -Root $Root
    if (Test-Path -LiteralPath $fullPath) { [System.IO.File]::Delete($fullPath) }
}

function Remove-DeepworkSafeTree {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Root
    )
    $fullPath = Get-DeepworkFullPath $Path
    Assert-DeepworkContainedPath -Path $fullPath -Root $Root -AllowRoot:$false
    Assert-DeepworkNoReparseTree $fullPath
    if (Test-Path -LiteralPath $fullPath) {
        Remove-Item -LiteralPath $fullPath -Force -Recurse
    }
}

function Move-DeepworkSafeTree {
    param(
        [Parameter(Mandatory = $true)][string]$Source,
        [Parameter(Mandatory = $true)][string]$Destination,
        [Parameter(Mandatory = $true)][string]$Root
    )
    $fullSource = Get-DeepworkFullPath $Source
    $fullDestination = Get-DeepworkFullPath $Destination
    Assert-DeepworkContainedPath -Path $fullSource -Root $Root -AllowRoot:$false
    Assert-DeepworkContainedPath -Path $fullDestination -Root $Root -AllowRoot:$false
    Assert-DeepworkNoReparseTree $fullSource
    Assert-DeepworkNoReparseAncestors $fullDestination
    if (Test-Path -LiteralPath $fullDestination) { throw "Move destination already exists: $fullDestination" }
    New-DeepworkSafeDirectory -Path (Split-Path $fullDestination -Parent) -ContainmentRoot $Root -AllowRoot | Out-Null
    Assert-DeepworkNoReparseTree $fullSource
    Assert-DeepworkNoReparseAncestors $fullDestination
    [System.IO.Directory]::Move($fullSource, $fullDestination)
}

function Get-DeepworkFileHash {
    param([Parameter(Mandatory = $true)][string]$Path)
    Assert-DeepworkNoReparseAncestors $Path
    return (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant()
}

function Get-DeepworkTreeHash {
    param([Parameter(Mandatory = $true)][string]$Path)
    $fullPath = Get-DeepworkFullPath $Path
    Assert-DeepworkNoReparseTree $fullPath
    $lines = New-Object 'System.Collections.Generic.List[string]'
    $queue = New-Object 'System.Collections.Generic.Queue[string]'
    $queue.Enqueue($fullPath)
    while ($queue.Count -gt 0) {
        $directory = $queue.Dequeue()
        foreach ($item in @(Get-ChildItem -Force -LiteralPath $directory | Sort-Object Name)) {
            $relative = $item.FullName.Substring($fullPath.Length).TrimStart('\').Replace('\', '/')
            if ($item.PSIsContainer) {
                $lines.Add("D $relative")
                $queue.Enqueue($item.FullName)
            }
            else {
                $lines.Add("F $relative $(Get-DeepworkFileHash $item.FullName)")
            }
        }
    }
    $encoding = New-Object System.Text.UTF8Encoding($false)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $digest = $sha.ComputeHash($encoding.GetBytes(($lines -join "`n")))
        return ([System.BitConverter]::ToString($digest)).Replace('-', '').ToLowerInvariant()
    }
    finally { $sha.Dispose() }
}

function Read-DeepworkJsonFile {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Root
    )
    Assert-DeepworkSafeFile -Path $Path -Root $Root
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    $raw = [System.IO.File]::ReadAllText((Get-DeepworkFullPath $Path))
    if ([string]::IsNullOrWhiteSpace($raw)) { return $null }
    try { return $raw | ConvertFrom-Json }
    catch { throw "Refusing invalid JSON at $Path" }
}

function Write-DeepworkJsonAtomic {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][object]$Value,
        [Parameter(Mandatory = $true)][string]$Root
    )
    $json = $Value | ConvertTo-Json -Depth 100
    Write-DeepworkTextAtomic -Path $Path -Text ($json + "`r`n") -Root $Root
}

function ConvertTo-DeepworkCanonicalJson {
    param([AllowNull()][object]$Value)
    if ($null -eq $Value) { return 'null' }
    return ($Value | ConvertTo-Json -Depth 100 -Compress)
}

function Set-DeepworkObjectProperty {
    param(
        [Parameter(Mandatory = $true)][object]$Object,
        [Parameter(Mandatory = $true)][string]$Name,
        [AllowNull()][object]$Value
    )
    if ($Object.PSObject.Properties[$Name]) { $Object.$Name = $Value }
    else { $Object | Add-Member -NotePropertyName $Name -NotePropertyValue $Value }
}

function Get-DeepworkRelativeManagedPath {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Root
    )
    $fullPath = Get-DeepworkFullPath $Path
    $fullRoot = Get-DeepworkFullPath $Root
    Assert-DeepworkContainedPath -Path $fullPath -Root $fullRoot -AllowRoot:$false
    return $fullPath.Substring($fullRoot.Length + 1)
}

function Resolve-DeepworkRelativeManagedPath {
    param(
        [Parameter(Mandatory = $true)][string]$RelativePath,
        [Parameter(Mandatory = $true)][string]$Root
    )
    if ([System.IO.Path]::IsPathRooted($RelativePath)) { throw "Expected relative managed path: $RelativePath" }
    $resolved = Get-DeepworkFullPath (Join-Path $Root $RelativePath)
    Assert-DeepworkContainedPath -Path $resolved -Root $Root -AllowRoot:$false
    return $resolved
}
