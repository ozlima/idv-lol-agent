param(
    [Parameter(Mandatory=$true)]
    [string]$ExePath,

    [Parameter(Mandatory=$true)]
    [string]$PngPath
)

Add-Type -AssemblyName System.Drawing

$source = [System.Drawing.Image]::FromFile($PngPath)
$sizes = @(16, 24, 32, 48, 64, 128, 256)
$images = New-Object System.Collections.Generic.List[byte[]]

foreach ($size in $sizes) {
    $bitmap = New-Object System.Drawing.Bitmap $size, $size
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.Clear([System.Drawing.Color]::Transparent)
    $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $graphics.DrawImage($source, 0, 0, $size, $size)

    $stream = New-Object System.IO.MemoryStream
    $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
    $images.Add($stream.ToArray())

    $stream.Dispose()
    $graphics.Dispose()
    $bitmap.Dispose()
}

$source.Dispose()

$iconPath = [System.IO.Path]::ChangeExtension($ExePath, ".ico")
$fs = [System.IO.File]::Open($iconPath, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write)
$writer = New-Object System.IO.BinaryWriter $fs

$writer.Write([uint16]0)
$writer.Write([uint16]1)
$writer.Write([uint16]$images.Count)

$offset = 6 + (16 * $images.Count)
foreach ($i in 0..($images.Count - 1)) {
    $size = $sizes[$i]
    $bytes = $images[$i]
    $writer.Write([byte]($(if ($size -eq 256) { 0 } else { $size })))
    $writer.Write([byte]($(if ($size -eq 256) { 0 } else { $size })))
    $writer.Write([byte]0)
    $writer.Write([byte]0)
    $writer.Write([uint16]1)
    $writer.Write([uint16]32)
    $writer.Write([uint32]$bytes.Length)
    $writer.Write([uint32]$offset)
    $offset += $bytes.Length
}

foreach ($bytes in $images) {
    $writer.Write($bytes)
}

$writer.Dispose()
$fs.Dispose()

Add-Type @"
using System;
using System.Runtime.InteropServices;

public static class ResourceUpdater
{
    [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
    public static extern IntPtr BeginUpdateResource(string pFileName, bool bDeleteExistingResources);

    [DllImport("kernel32.dll", SetLastError=true)]
    public static extern bool UpdateResource(IntPtr hUpdate, IntPtr lpType, IntPtr lpName, ushort wLanguage, byte[] lpData, uint cbData);

    [DllImport("kernel32.dll", SetLastError=true)]
    public static extern bool EndUpdateResource(IntPtr hUpdate, bool fDiscard);
}
"@

$handle = [ResourceUpdater]::BeginUpdateResource($ExePath, $false)
if ($handle -eq [IntPtr]::Zero) {
    throw "Nao foi possivel abrir o executavel para atualizar recursos."
}

$group = New-Object System.IO.MemoryStream
$groupWriter = New-Object System.IO.BinaryWriter $group
$groupWriter.Write([uint16]0)
$groupWriter.Write([uint16]1)
$groupWriter.Write([uint16]$images.Count)

foreach ($i in 0..($images.Count - 1)) {
    $size = $sizes[$i]
    $bytes = $images[$i]
    $id = $i + 1

    $groupWriter.Write([byte]($(if ($size -eq 256) { 0 } else { $size })))
    $groupWriter.Write([byte]($(if ($size -eq 256) { 0 } else { $size })))
    $groupWriter.Write([byte]0)
    $groupWriter.Write([byte]0)
    $groupWriter.Write([uint16]1)
    $groupWriter.Write([uint16]32)
    $groupWriter.Write([uint32]$bytes.Length)
    $groupWriter.Write([uint16]$id)

    $ok = [ResourceUpdater]::UpdateResource($handle, [IntPtr]3, [IntPtr]$id, 0, $bytes, $bytes.Length)
    if (-not $ok) {
        [void][ResourceUpdater]::EndUpdateResource($handle, $true)
        throw "Falha ao gravar recurso de icone $id."
    }
}

$groupBytes = $group.ToArray()
$ok = [ResourceUpdater]::UpdateResource($handle, [IntPtr]14, [IntPtr]1, 0, $groupBytes, $groupBytes.Length)
if (-not $ok) {
    [void][ResourceUpdater]::EndUpdateResource($handle, $true)
    throw "Falha ao gravar grupo de icones."
}

$ok = [ResourceUpdater]::EndUpdateResource($handle, $false)
if (-not $ok) {
    throw "Falha ao finalizar atualizacao de recursos."
}

Write-Host "Icone aplicado em $ExePath"
Write-Host "ICO gerado em $iconPath"
