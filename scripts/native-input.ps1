param(
  [ValidateSet('clipboard-read','clipboard-write','key','focus','double-click','scale')][string]$Action,
  [string]$Value,
  [int]$X,
  [int]$Y
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Windows.Forms
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class ControlRoomNativeInput {
  [StructLayout(LayoutKind.Sequential)] public struct Point { public int X; public int Y; }
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr window, ref Point point);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint x, uint y, uint data, UIntPtr extra);
}
'@
switch ($Action) {
  'clipboard-read' { [Console]::Write([Windows.Forms.Clipboard]::GetText()) }
  'clipboard-write' { $text = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Value)); if ($text.Length) { [Windows.Forms.Clipboard]::SetText($text) } else { [Windows.Forms.Clipboard]::Clear() } }
  'key' { [Windows.Forms.SendKeys]::SendWait($Value) }
  'focus' { $application = Get-Process -Id ([int]$Value); if (![ControlRoomNativeInput]::SetForegroundWindow($application.MainWindowHandle)) { throw 'Could not focus the native application' } }
  'double-click' {
    [void][ControlRoomNativeInput]::SetThreadDpiAwarenessContext([IntPtr](-4))
    $application = Get-Process -Id ([int]$Value)
    $point = [ControlRoomNativeInput+Point]::new(); $point.X = $X; $point.Y = $Y
    if (![ControlRoomNativeInput]::ClientToScreen($application.MainWindowHandle, [ref]$point)) { throw 'Client coordinates are unavailable' }
    if (![ControlRoomNativeInput]::SetCursorPos($point.X, $point.Y)) { throw 'Could not move the OS pointer' }
    foreach ($click in 1..2) { [ControlRoomNativeInput]::mouse_event(2,0,0,0,[UIntPtr]::Zero); [ControlRoomNativeInput]::mouse_event(4,0,0,0,[UIntPtr]::Zero); Start-Sleep -Milliseconds 70 }
  }
  'scale' {
    Add-Type -AssemblyName UIAutomationClient
    Add-Type -AssemblyName UIAutomationTypes
    Start-Process 'ms-settings:display'
    $deadline = [DateTime]::UtcNow.AddSeconds(15)
    $root = [Windows.Automation.AutomationElement]::RootElement
    $condition = [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::AutomationIdProperty, 'SystemSettings_Display_Scaling_Value')
    do { $combo = $root.FindFirst([Windows.Automation.TreeScope]::Descendants, $condition); if (!$combo) { Start-Sleep -Milliseconds 100 } } until ($combo -or [DateTime]::UtcNow -gt $deadline)
    if (!$combo) { throw 'The Windows Display Scale control is unavailable to UI Automation' }
    $selection = $combo.GetCurrentPattern([Windows.Automation.SelectionPattern]::Pattern).GetCurrentSelection()
    $original = [int]([regex]::Match($selection[0].Current.Name, '^\d+').Value)
    if ($Value) {
      $combo.GetCurrentPattern([Windows.Automation.ExpandCollapsePattern]::Pattern).Expand()
      $items = $root.FindAll([Windows.Automation.TreeScope]::Descendants, [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ControlTypeProperty, [Windows.Automation.ControlType]::ListItem))
      $item = $items | Where-Object { $_.Current.Name -match "^$([regex]::Escape($Value))%" } | Select-Object -First 1
      if (!$item) { throw "The display does not offer $Value% scale" }
      $item.GetCurrentPattern([Windows.Automation.SelectionItemPattern]::Pattern).Select()
    }
    # Close the Settings window we opened, leaving Control Room available.
    $walker = [Windows.Automation.TreeWalker]::ControlViewWalker
    $window = $combo
    while ($window -and $window.Current.ControlType -ne [Windows.Automation.ControlType]::Window) { $window = $walker.GetParent($window) }
    if ($window) { $window.GetCurrentPattern([Windows.Automation.WindowPattern]::Pattern).Close() }
    [Console]::Write($original)
  }
}
