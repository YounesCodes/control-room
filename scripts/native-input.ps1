param(
  [ValidateSet('clipboard-read','clipboard-write','key','focus','double-click','scale','resolution-read','resolution-modes','resolution-set','layout-read','layout-load','layout-set','layout-unload','italian-text')][string]$Action,
  [string]$Value,
  [int]$X,
  [int]$Y,
  [int]$ApplicationId,
  [string]$ParentLayout
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Windows.Forms
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class ControlRoomNativeInput {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct DisplayMode {
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=32)] public string DeviceName;
    public ushort SpecVersion, DriverVersion, Size, DriverExtra;
    public uint Fields;
    public int PositionX, PositionY;
    public uint Orientation, FixedOutput;
    public short Color, Duplex, YResolution, TTOption, Collate;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=32)] public string FormName;
    public ushort LogPixels;
    public uint BitsPerPel, PelsWidth, PelsHeight, DisplayFlags, Frequency;
    public uint ICMMethod, ICMIntent, MediaType, DitherType, Reserved1, Reserved2, PanningWidth, PanningHeight;
  }
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern bool EnumDisplaySettings(string device, int mode, ref DisplayMode settings);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern int ChangeDisplaySettingsEx(string device, ref DisplayMode settings, IntPtr window, uint flags, IntPtr extra);
  public static DisplayMode Resolution() {
    var mode = new DisplayMode { Size=(ushort)Marshal.SizeOf(typeof(DisplayMode)) };
    if (mode.Size != 220 || !EnumDisplaySettings(null, -1, ref mode)) throw new InvalidOperationException("Could not read the native display mode");
    return mode;
  }
  public static void SetResolution(uint width, uint height) {
    var mode = Resolution();
    if (mode.PelsWidth == width && mode.PelsHeight == height) return;
    mode.Fields=0x180000; // DM_PELSWIDTH | DM_PELSHEIGHT
    mode.PelsWidth=width; mode.PelsHeight=height;
    int test=ChangeDisplaySettingsEx(null, ref mode, IntPtr.Zero, 2, IntPtr.Zero); // CDS_TEST
    if (test != 0) throw new InvalidOperationException("Display does not support the required resolution: " + test);
    int applied=ChangeDisplaySettingsEx(null, ref mode, IntPtr.Zero, 0, IntPtr.Zero);
    if (applied != 0) throw new InvalidOperationException("Could not apply the session display resolution: " + applied);
    var actual=Resolution();
    if (actual.PelsWidth != width || actual.PelsHeight != height) throw new InvalidOperationException("The requested display resolution was not applied");
  }
  public static DisplayMode[] Resolutions() {
    var modes = new System.Collections.Generic.List<DisplayMode>();
    var current = Resolution();
    for (int index=0; ; index++) {
      var mode = new DisplayMode { Size=(ushort)Marshal.SizeOf(typeof(DisplayMode)) };
      if (!EnumDisplaySettings(null, index, ref mode)) break;
      if (mode.BitsPerPel == current.BitsPerPel && (mode.DisplayFlags & 2) == 0 && !modes.Exists(found => found.PelsWidth == mode.PelsWidth && found.PelsHeight == mode.PelsHeight)) modes.Add(mode);
    }
    return modes.ToArray();
  }
  [StructLayout(LayoutKind.Sequential)] public struct Point { public int X; public int Y; }
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern IntPtr GetDesktopWindow();
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr window, uint flags);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr window, ref Point point);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint x, uint y, uint data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, IntPtr process);
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct GuiThreadInfo {
    public uint Size, Flags;
    public IntPtr Active, Focus, Capture, MenuOwner, MoveSize, Caret;
    public Rect CaretRect;
  }
  [DllImport("user32.dll", SetLastError=true)] private static extern bool GetGUIThreadInfo(uint thread, ref GuiThreadInfo info);
  public static IntPtr FocusedWindow() {
    var info = new GuiThreadInfo { Size=(uint)Marshal.SizeOf(typeof(GuiThreadInfo)) };
    if (!GetGUIThreadInfo(0, ref info)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    return info.Focus;
  }
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
  'resolution-modes' {
    $modes = @([ControlRoomNativeInput]::Resolutions() | ForEach-Object { @{ width=$_.PelsWidth; height=$_.PelsHeight } })
    [Console]::Write((ConvertTo-Json -InputObject $modes -Compress))
  }
  { $_ -in 'resolution-read','resolution-set' } {
    if ($Action -eq 'resolution-set') {
      if ($Value -notmatch '^(\d+)x(\d+)$') { throw 'Expected a physical display resolution' }
      [ControlRoomNativeInput]::SetResolution([uint32]$Matches[1], [uint32]$Matches[2])
    }
    $mode = [ControlRoomNativeInput]::Resolution()
    [Console]::Write((@{ width=$mode.PelsWidth; height=$mode.PelsHeight } | ConvertTo-Json -Compress))
  }
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
    $focused = [ControlRoomNativeInput]::FocusedWindow()
    if ([ControlRoomNativeInput]::GetAncestor($focused, 2) -ne $application.MainWindowHandle) { throw 'Focus the application before reading its keyboard layout' }
    $thread = [ControlRoomNativeInput]::GetWindowThreadProcessId($focused, [IntPtr]::Zero)
    $parentThread = [ControlRoomNativeInput]::GetWindowThreadProcessId($application.MainWindowHandle, [IntPtr]::Zero)
    $count = [ControlRoomNativeInput]::GetKeyboardLayoutList(0, $null)
    $layouts = [IntPtr[]]::new($count)
    [void][ControlRoomNativeInput]::GetKeyboardLayoutList($count, $layouts)
    $state = @{ current = [ControlRoomNativeInput]::GetKeyboardLayout($thread).ToInt64().ToString(); parent = [ControlRoomNativeInput]::GetKeyboardLayout($parentThread).ToInt64().ToString(); loaded = @($layouts | ForEach-Object { $_.ToInt64().ToString() }) }
    [Console]::Write(($state | ConvertTo-Json -Compress))
  }
  'layout-load' {
    $layout = [ControlRoomNativeInput]::LoadKeyboardLayout('00000410', 0)
    if ($layout -eq [IntPtr]::Zero) { throw 'Italian keyboard layout is unavailable' }
    [Console]::Write($layout.ToInt64().ToString())
  }
  'layout-set' {
    $application = Get-Process -Id $ApplicationId
    $focused = [ControlRoomNativeInput]::FocusedWindow()
    if ([ControlRoomNativeInput]::GetAncestor($focused, 2) -ne $application.MainWindowHandle) { throw 'Focus the application before changing its keyboard layout' }
    $thread = [ControlRoomNativeInput]::GetWindowThreadProcessId($focused, [IntPtr]::Zero)
    $layout = [IntPtr]([long]$Value)
    if ($layout -eq [IntPtr]::Zero) { throw 'Italian keyboard layout is unavailable' }
    $parent = if ($ParentLayout) { [IntPtr]([long]$ParentLayout) } else { $layout }
    if (![ControlRoomNativeInput]::PostMessage($application.MainWindowHandle, 0x50, [IntPtr]::Zero, $parent)) { throw 'Could not request the parent keyboard layout' }
    if (![ControlRoomNativeInput]::PostMessage($focused, 0x50, [IntPtr]::Zero, $layout)) { throw 'Could not request the focused WebView keyboard layout' }
    $deadline = [DateTime]::UtcNow.AddSeconds(5)
    # Windows may sign-extend or substitute the high word of the HKL. Verify the
    # requested language on the thread that actually receives keyboard input.
    $language = $layout.ToInt64() -band 0xffff
    while (([ControlRoomNativeInput]::GetKeyboardLayout($thread).ToInt64() -band 0xffff) -ne $language -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 50 }
    $actual = [ControlRoomNativeInput]::GetKeyboardLayout($thread).ToInt64()
    if (($actual -band 0xffff) -ne $language) { throw "The WebView did not adopt keyboard layout $Value; actual=$actual; inputThread=$thread" }
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
    do {
      $combo = $root.FindFirst([Windows.Automation.TreeScope]::Descendants, $condition)
      if (!$combo) {
        # Settings builds use different IDs for the Scale combo. Select by its
        # accessible percentage value, scoped to the Settings process.
        $settings = Get-Process -Name SystemSettings -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($settings) {
          $comboCondition = [Windows.Automation.AndCondition]::new(
            [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ControlTypeProperty, [Windows.Automation.ControlType]::ComboBox),
            [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ProcessIdProperty, $settings.Id)
          )
          $candidates = $root.FindAll([Windows.Automation.TreeScope]::Descendants, $comboCondition)
          $scales = @($candidates | Where-Object {
            $pattern = $null
            if ($_.TryGetCurrentPattern([Windows.Automation.SelectionPattern]::Pattern, [ref]$pattern)) {
              $chosen = $pattern.Current.GetSelection()
              $chosen.Count -eq 1 -and $chosen[0].Current.Name -match '^\d+%'
            } else { $false }
          })
          if ($scales.Count -eq 1) { $combo = $scales[0] }
        }
      }
      if (!$combo) { Start-Sleep -Milliseconds 100 }
    } until ($combo -or [DateTime]::UtcNow -gt $deadline)
    if (!$combo) {
      $combos = $root.FindAll([Windows.Automation.TreeScope]::Descendants, [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ControlTypeProperty, [Windows.Automation.ControlType]::ComboBox))
      $available = @($combos | ForEach-Object { @{ name=$_.Current.Name; id=$_.Current.AutomationId } }) | ConvertTo-Json -Compress
      throw "The Windows Display Scale control is unavailable to UI Automation; available combos=$available"
    }
    $selection = $combo.GetCurrentPattern([Windows.Automation.SelectionPattern]::Pattern).Current.GetSelection()
    $original = [int]([regex]::Match($selection[0].Current.Name, '^\d+').Value)
    if ($Value) {
      $combo.GetCurrentPattern([Windows.Automation.ExpandCollapsePattern]::Pattern).Expand()
      $choiceDeadline = [DateTime]::UtcNow.AddSeconds(5)
      do {
        $items = $root.FindAll([Windows.Automation.TreeScope]::Descendants, [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ControlTypeProperty, [Windows.Automation.ControlType]::ListItem))
        $item = $items | Where-Object { $_.Current.Name -match "^$([regex]::Escape($Value))%" } | Select-Object -First 1
        if (!$item) { Start-Sleep -Milliseconds 50 }
      } until ($item -or [DateTime]::UtcNow -gt $choiceDeadline)
      if (!$item) { throw "The display does not offer $Value% scale" }
      $item.GetCurrentPattern([Windows.Automation.SelectionItemPattern]::Pattern).Select()
    }
    # XAML islands and ApplicationFrameHost do not consistently expose
    # WindowPattern or Process.MainWindowHandle. Find the control's real HWND
    # ancestor and request its ordinary close; never target the desktop.
    $walker = [Windows.Automation.TreeWalker]::ControlViewWalker
    $window = $combo
    $closeHandle = [IntPtr]::Zero
    while ($window) {
      if ($window.Current.NativeWindowHandle) {
        $candidate = [ControlRoomNativeInput]::GetAncestor([IntPtr]$window.Current.NativeWindowHandle, 2)
        if ($candidate -ne [IntPtr]::Zero -and $candidate -ne [ControlRoomNativeInput]::GetDesktopWindow()) { $closeHandle = $candidate; break }
      }
      $window = $walker.GetParent($window)
    }
    if ($closeHandle -eq [IntPtr]::Zero -or ![ControlRoomNativeInput]::PostMessage($closeHandle, 0x10, [IntPtr]::Zero, [IntPtr]::Zero)) { throw 'Could not close the Display Settings window' }
    [Console]::Write($original)
  }
}
