param(
  [ValidateSet('clipboard-read','clipboard-write','key','focus','double-click','scale','layout-read','layout-set','layout-unload','italian-text')][string]$Action,
  [string]$Value,
  [int]$X,
  [int]$Y,
  [int]$ApplicationId
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
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr window, uint flags);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr window, ref Point point);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint x, uint y, uint data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, IntPtr process);
  [DllImport("user32.dll")] public static extern IntPtr GetKeyboardLayout(uint thread);
  [DllImport("user32.dll")] public static extern int GetKeyboardLayoutList(int count, [Out] IntPtr[] list);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr LoadKeyboardLayout(string id, uint flags);
  [DllImport("user32.dll")] public static extern bool UnloadKeyboardLayout(IntPtr layout);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr window, uint message, IntPtr first, IntPtr second);
  [StructLayout(LayoutKind.Sequential)] public struct KeyInput { public ushort Key, Scan; public uint Flags, Time; public UIntPtr Extra; }
  [StructLayout(LayoutKind.Sequential)] public struct MouseInput { public int X, Y; public uint Data, Flags, Time; public UIntPtr Extra; }
  [StructLayout(LayoutKind.Explicit)] public struct InputData { [FieldOffset(0)] public KeyInput Keyboard; [FieldOffset(0)] public MouseInput Mouse; }
  [StructLayout(LayoutKind.Sequential)] public struct Input { public uint Type; public InputData Data; }
  [DllImport("user32.dll", SetLastError=true)] private static extern uint SendInput(uint count, Input[] input, int size);
  public static void Scan(ushort scan, bool shifted) {
    var events = new System.Collections.Generic.List<Input>();
    if (shifted) events.Add(new Input { Type=1, Data=new InputData { Keyboard=new KeyInput { Scan=0x2a, Flags=8 } } });
    events.Add(new Input { Type=1, Data=new InputData { Keyboard=new KeyInput { Scan=scan, Flags=8 } } });
    events.Add(new Input { Type=1, Data=new InputData { Keyboard=new KeyInput { Scan=scan, Flags=10 } } });
    if (shifted) events.Add(new Input { Type=1, Data=new InputData { Keyboard=new KeyInput { Scan=0x2a, Flags=10 } } });
    if (SendInput((uint)events.Count, events.ToArray(), Marshal.SizeOf(typeof(Input))) != events.Count) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
  }

}
'@
switch ($Action) {
  'clipboard-read' { [Console]::Write([Windows.Forms.Clipboard]::GetText()) }
  'clipboard-write' { if ($Value) { [Windows.Forms.Clipboard]::SetText([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Value))) } else { [Windows.Forms.Clipboard]::Clear() } }
  'key' { [Windows.Forms.SendKeys]::SendWait($Value) }
  'focus' {
    $application = Get-Process -Id ([int]$Value)
    if (![ControlRoomNativeInput]::SetForegroundWindow($application.MainWindowHandle)) { throw 'Could not focus the native application' }
    $deadline = [DateTime]::UtcNow.AddSeconds(3)
    do {
      $foreground = [ControlRoomNativeInput]::GetAncestor([ControlRoomNativeInput]::GetForegroundWindow(), 2)
      if ($foreground -eq $application.MainWindowHandle) { break }
      Start-Sleep -Milliseconds 20
    } while ([DateTime]::UtcNow -lt $deadline)
    if ($foreground -ne $application.MainWindowHandle) { throw 'The OS foreground window does not belong to the native application' }
  }
  'double-click' {
    [void][ControlRoomNativeInput]::SetThreadDpiAwarenessContext([IntPtr](-4))
    $application = Get-Process -Id ([int]$Value)
    $point = [ControlRoomNativeInput+Point]::new(); $point.X = $X; $point.Y = $Y
    if (![ControlRoomNativeInput]::ClientToScreen($application.MainWindowHandle, [ref]$point)) { throw 'Client coordinates are unavailable' }
    if (![ControlRoomNativeInput]::SetCursorPos($point.X, $point.Y)) { throw 'Could not move the OS pointer' }
    foreach ($click in 1..2) { [ControlRoomNativeInput]::mouse_event(2,0,0,0,[UIntPtr]::Zero); [ControlRoomNativeInput]::mouse_event(4,0,0,0,[UIntPtr]::Zero); Start-Sleep -Milliseconds 70 }
  }
  'layout-read' {
    $application = Get-Process -Id $ApplicationId
    $thread = [ControlRoomNativeInput]::GetWindowThreadProcessId($application.MainWindowHandle, [IntPtr]::Zero)
    $count = [ControlRoomNativeInput]::GetKeyboardLayoutList(0, $null)
    $layouts = [IntPtr[]]::new($count)
    [void][ControlRoomNativeInput]::GetKeyboardLayoutList($count, $layouts)
    $state = @{ current = [ControlRoomNativeInput]::GetKeyboardLayout($thread).ToInt64().ToString(); loaded = @($layouts | ForEach-Object { $_.ToInt64().ToString() }) }
    [Console]::Write(($state | ConvertTo-Json -Compress))
  }
  'layout-set' {
    $application = Get-Process -Id $ApplicationId
    $thread = [ControlRoomNativeInput]::GetWindowThreadProcessId($application.MainWindowHandle, [IntPtr]::Zero)
    $layout = if ($Value -eq 'it') { [ControlRoomNativeInput]::LoadKeyboardLayout('00000410', 0) } else { [IntPtr]([long]$Value) }
    if ($layout -eq [IntPtr]::Zero) { throw 'Italian keyboard layout is unavailable' }
    if (![ControlRoomNativeInput]::PostMessage($application.MainWindowHandle, 0x50, [IntPtr]::Zero, $layout)) { throw 'Could not request the native keyboard layout' }
    $deadline = [DateTime]::UtcNow.AddSeconds(5)
    while ([ControlRoomNativeInput]::GetKeyboardLayout($thread) -ne $layout -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 50 }
    if ([ControlRoomNativeInput]::GetKeyboardLayout($thread) -ne $layout) { throw 'The application did not adopt the requested keyboard layout' }
    [Console]::Write($layout.ToInt64().ToString())
  }
  'layout-unload' { if (![ControlRoomNativeInput]::UnloadKeyboardLayout([IntPtr]([long]$Value))) { throw 'Could not unload the temporary Italian input source' } }
  'italian-text' { [ControlRoomNativeInput]::Scan(0x1a, $false); [ControlRoomNativeInput]::Scan(0x1a, $true) }
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
