# tools/hid-caps.ps1
# Read the REAL report lengths of every HID interface (HidD_GetPreparsedData + HidP_GetCaps).
#
#   powershell -ExecutionPolicy Bypass -File tools/hid-caps.ps1
#   powershell -ExecutionPolicy Bypass -File tools/hid-caps.ps1 -Vid 9741 -Json
#
# Why: Windows WriteFile requires the buffer length to be EXACTLY Caps.OutputReportByteLength
# (report-id byte included). A wrong length fails with ERROR_INVALID_FUNCTION (1), which is the
# usual reason a node-hid shim "sends fine but the device never answers".
# Put the numbers into src/hid-profiles.json as outLen / inLen / featLen (they already include the
# report-id byte; the shim passes body-only data, so hid-service subtracts 1 when padding).
#
# Requires Windows PowerShell 5.1+ with Add-Type (FullLanguage mode). ASCII-only on purpose:
# Windows PowerShell reads BOM-less files as ANSI, so non-ASCII comments break parsing.
param(
  [int]$Vid = 9741,
  [switch]$Json
)

$src = @'
using System;
using System.Runtime.InteropServices;
public static class HidCaps {
  [StructLayout(LayoutKind.Sequential)]
  public struct HIDP_CAPS {
    public ushort Usage; public ushort UsagePage;
    public ushort InputReportByteLength; public ushort OutputReportByteLength; public ushort FeatureReportByteLength;
    [MarshalAs(UnmanagedType.ByValArray, SizeConst=17)] public ushort[] Reserved;
    public ushort NumberLinkCollectionNodes;
    public ushort NumberInputButtonCaps; public ushort NumberInputValueCaps; public ushort NumberInputDataIndices;
    public ushort NumberOutputButtonCaps; public ushort NumberOutputValueCaps; public ushort NumberOutputDataIndices;
    public ushort NumberFeatureButtonCaps; public ushort NumberFeatureValueCaps; public ushort NumberFeatureDataIndices;
  }
  [DllImport("hid.dll", SetLastError=true)] static extern bool HidD_GetPreparsedData(IntPtr h, out IntPtr pp);
  [DllImport("hid.dll", SetLastError=true)] static extern int HidP_GetCaps(IntPtr p, out HIDP_CAPS c);
  [DllImport("hid.dll", SetLastError=true)] static extern bool HidD_FreePreparsedData(IntPtr p);
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr sa, uint disp, uint flags, IntPtr tmpl);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr h);

  public static object Read(string path) {
    // System-owned interfaces (\\KBD, mouse) refuse GENERIC_WRITE -> retry read-only.
    IntPtr h = CreateFileW(path, 0xC0000000, 0x03, IntPtr.Zero, 3, 0, IntPtr.Zero);
    if (h == IntPtr.Zero || h == new IntPtr(-1)) h = CreateFileW(path, 0x80000000, 0x03, IntPtr.Zero, 3, 0, IntPtr.Zero);
    if (h == IntPtr.Zero || h == new IntPtr(-1)) return new { path = path, error = "CreateFile failed err=" + Marshal.GetLastWin32Error() };
    try {
      IntPtr pp;
      if (!HidD_GetPreparsedData(h, out pp)) return new { path = path, error = "GetPreparsedData err=" + Marshal.GetLastWin32Error() };
      try {
        HIDP_CAPS c; int st = HidP_GetCaps(pp, out c);
        if (st != 0x00110000) return new { path = path, error = "HidP_GetCaps status=0x" + st.ToString("X8") };
        return new { path = path, usage = c.Usage, usagePage = c.UsagePage,
          inLen = c.InputReportByteLength, outLen = c.OutputReportByteLength, featLen = c.FeatureReportByteLength,
          inValues = c.NumberInputValueCaps, outValues = c.NumberOutputValueCaps, featValues = c.NumberFeatureValueCaps,
          collections = c.NumberLinkCollectionNodes };
      } finally { HidD_FreePreparsedData(pp); }
    } finally { CloseHandle(h); }
  }
}
'@
Add-Type -TypeDefinition $src -ErrorAction Stop

$root = Split-Path -Parent $PSScriptRoot
$js = "const H=require('node-hid');for(const d of H.devices())if(!$Vid||d.vendorId===$Vid)console.log(JSON.stringify(d))"
$paths = (node -e $js) | ForEach-Object { $_ | ConvertFrom-Json }

$rows = foreach ($d in $paths) {
  $c = [HidCaps]::Read($d.path)
  $colName = '?'
  if ($d.path -match 'Col\d+') { $colName = $matches.Value }
  elseif ($d.path -match 'MI_\d+') { $colName = $matches.Value }
  New-Object psobject -Property @{
    Col       = $colName
    usagePage = ('0x{0:X4}' -f $d.usagePage)
    usage     = ('0x{0:X4}' -f $d.usage)
    inLen     = $c.inLen
    outLen    = $c.outLen
    featLen   = $c.featLen
    nodes     = $c.collections
    err       = $c.error
    product   = $d.product
  }
}
if ($Json) { $rows | ConvertTo-Json -Depth 3 }
else { $rows | Sort-Object Col | Format-Table Col, usagePage, usage, inLen, outLen, featLen, nodes, err, product -AutoSize | Out-String -Width 220 }
