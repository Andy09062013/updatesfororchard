# Orchard: slow down other apps while on battery (Windows).
# Lowers the priority of background apps in YOUR session and turns on Windows' Efficiency mode
# (EcoQoS) for them. Never touches the app in front, protected/admin apps, High/Realtime apps,
# or anything on the skip list. Everything is put back when Orchard says "restore", quits, or crashes.
$ErrorActionPreference = 'SilentlyContinue'
try {
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class OrchardThrottle {
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [StructLayout(LayoutKind.Sequential)] struct PPT { public uint Version; public uint ControlMask; public uint StateMask; }
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetProcessInformation(IntPtr h, int cls, ref PPT info, uint size);
  public static uint Foreground() { uint p = 0; GetWindowThreadProcessId(GetForegroundWindow(), out p); return p; }
  // on = Efficiency mode on; off = hand control back to Windows
  public static bool Eco(uint pid, bool on) {
    IntPtr h = OpenProcess(0x0200, false, pid);            // PROCESS_SET_INFORMATION
    if (h == IntPtr.Zero) return false;
    PPT s = new PPT(); s.Version = 1;
    s.ControlMask = on ? 1u : 0u; s.StateMask = on ? 1u : 0u; // PROCESS_POWER_THROTTLING_EXECUTION_SPEED
    bool ok = SetProcessInformation(h, 4, ref s, (uint)Marshal.SizeOf(typeof(PPT))); // ProcessPowerThrottling
    CloseHandle(h);
    return ok;
  }
}
'@
} catch {}

$me = $PID
$mySession = (Get-Process -Id $PID).SessionId
$changed = @{}
$script:lastFg = 0

function Get-FgId { try { return [int][OrchardThrottle]::Foreground() } catch { return 0 } }
function Set-Eco($id, $on) { try { [void][OrchardThrottle]::Eco([uint32]$id, [bool]$on) } catch {} }

function Restore-One($id) {
  $e = $changed[$id]
  if ($e) {
    $p = Get-Process -Id $id -ErrorAction SilentlyContinue
    if ($p -and $p.ProcessName -eq $e.name) {
      try { if ([string]$p.PriorityClass -eq $e.set) { $p.PriorityClass = $e.orig } } catch {}
      Set-Eco $id $false
    }
    $changed.Remove($id)
  }
}
function Restore-All { foreach ($id in @($changed.Keys)) { Restore-One $id } }
function Restore-Name($name) { foreach ($id in @($changed.Keys)) { if ($changed[$id].name -eq $name) { Restore-One $id } } }

function Invoke-Apply($cmd) {
  $target = 'BelowNormal'
  if ($cmd.level -ge 2) { $target = 'Idle' }
  $skip = @{}; foreach ($n in $cmd.exclude) { $skip[([string]$n).ToLower()] = 1 }
  $own = @{};  foreach ($i in $cmd.own) { $own[[int]$i] = 1 }
  $fgId = Get-FgId; $fgName = ''
  if ($fgId -gt 0) { $fp = Get-Process -Id $fgId -ErrorAction SilentlyContinue; if ($fp) { $fgName = $fp.ProcessName } }
  $script:lastFg = $fgId
  # give speed back to anything that's now in front or newly skipped
  foreach ($id in @($changed.Keys)) {
    $n = $changed[$id].name
    if ($n -eq $fgName -or $skip.ContainsKey($n.ToLower())) { Restore-One $id }
  }
  $names = @{}
  foreach ($p in Get-Process) {
    if ($p.Id -eq $me -or $p.Id -le 4 -or $own.ContainsKey($p.Id)) { continue }
    if ($p.SessionId -ne $mySession) { continue }
    $n = $p.ProcessName
    if ($n -eq $fgName -or $skip.ContainsKey($n.ToLower())) { continue }
    $e = $changed[$p.Id]
    if ($e -and $e.name -ne $n) { $changed.Remove($p.Id); $e = $null }   # process id got reused
    if (-not $e) {
      # Store apps (and Windows' own apps) sit behind one shared window host, so we can't tell when
      # they're in front: never slow them
      $path = ''
      try { $path = [string]$p.Path } catch {}
      if ($path -like '*\WindowsApps\*' -or $path -like '*\SystemApps\*' -or $path -like '*\Windows\System32\*' -or $path -like '*\Windows\SysWOW64\*') { continue }
    }
    $cur = $null
    try { $cur = [string]$p.PriorityClass } catch { continue }            # protected/admin app: leave it
    if (-not $cur) { continue }
    if ($e) {
      if ($cur -ne $e.set) { $changed.Remove($p.Id); continue }            # something else changed it: hands off
      if ($e.set -ne $target) { try { $p.PriorityClass = $target; $e.set = $target } catch {} }
      $names[$n] = 1
      continue
    }
    if ($cur -ne 'Normal' -and $cur -ne 'AboveNormal') { continue }      # High/Realtime matter, low ones are already low
    try { $p.PriorityClass = $target } catch { continue }
    Set-Eco $p.Id $true
    $changed[$p.Id] = @{ name = $n; orig = $cur; set = $target }
    $names[$n] = 1
  }
  return @($names.Keys)
}

$reader = New-Object System.IO.StreamReader([Console]::OpenStandardInput())
$out = [Console]::Out
$task = $reader.ReadLineAsync()
while ($true) {
  # while waiting for Orchard, give an app its speed back the moment u switch to it
  while (-not $task.Wait(1500)) {
    if ($changed.Count -gt 0) {
      $f = Get-FgId
      if ($f -ne $script:lastFg) {
        $script:lastFg = $f
        if ($f -gt 0) { $fp = Get-Process -Id $f -ErrorAction SilentlyContinue; if ($fp) { Restore-Name $fp.ProcessName } }
      }
    }
  }
  $line = $task.Result
  if ($null -eq $line) { Restore-All; break }        # Orchard closed or crashed: put everything back
  $task = $reader.ReadLineAsync()
  $cmd = $null
  try { $cmd = $line | ConvertFrom-Json } catch {}
  if (-not $cmd) { continue }
  if ($cmd.op -eq 'apply') {
    $apps = Invoke-Apply $cmd
    $out.WriteLine((@{ op = 'applied'; count = $changed.Count; apps = @($apps) } | ConvertTo-Json -Compress))
  } elseif ($cmd.op -eq 'restore') {
    Restore-All
    $out.WriteLine('{"op":"restored"}')
  } elseif ($cmd.op -eq 'quit') {
    Restore-All
    $out.WriteLine('{"op":"restored"}'); $out.Flush()
    break
  }
  $out.Flush()
}
