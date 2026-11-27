# A small window of the test's own for test/ui/screen.cjs: a button and a text box, on top of
# everything, away from the banner's place at the top of the screen. What happens to it is written
# to a file the test reads back - the only proof a click really reached a window. It closes itself
# after five minutes whatever happens, so a test that dies cannot leave it behind for long.
param([string]$title, [string]$out, [int]$x = 160, [int]$y = 260)
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type -Namespace CaTest -Name Dpi -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();'
# Physical pixels, as the screen helper uses: otherwise the rectangles written below are scaled.
[CaTest.Dpi]::SetProcessDPIAware() | Out-Null
# Sized by the screen (u is 1% of its height), so a 4K screen shows it as big as a 1080p one does.
$u = [Math]::Max(8, [Windows.Forms.Screen]::PrimaryScreen.Bounds.Height / 100)
$px = { param($n) [int][Math]::Round($n * $u) }
$log = { param($s) [IO.File]::AppendAllText($out, $s + "`n", [Text.Encoding]::UTF8) }
$f = New-Object Windows.Forms.Form
$f.Text = $title; $f.TopMost = $true; $f.StartPosition = 'Manual'; $f.ShowInTaskbar = $true; $f.AutoScaleMode = 'None'
$f.Location = New-Object Drawing.Point($x, $y); $f.ClientSize = New-Object Drawing.Size((& $px 64), (& $px 30))
$f.BackColor = [Drawing.Color]::FromArgb(246, 244, 238); $f.Font = New-Object Drawing.Font('Segoe UI', [float](2.4 * $u), [Drawing.GraphicsUnit]::Pixel)
$b = New-Object Windows.Forms.Button; $b.Text = 'Press me'; $b.Location = New-Object Drawing.Point((& $px 3), (& $px 3)); $b.Size = New-Object Drawing.Size((& $px 24), (& $px 9))
$t = New-Object Windows.Forms.TextBox; $t.Location = New-Object Drawing.Point((& $px 3), (& $px 18)); $t.Width = (& $px 56)
$n = New-Object Windows.Forms.Label; $n.Location = New-Object Drawing.Point((& $px 30), (& $px 6)); $n.AutoSize = $true; $n.Text = 'Not pressed yet'
$f.Controls.AddRange(@($b, $t, $n))
$script:presses = 0
$b.Add_Click({ $script:presses++; $n.Text = "Pressed $($script:presses)x"; & $log 'clicked' })
$t.Add_TextChanged({ & $log ('text:' + $t.Text) })
$f.Add_Shown({
  $r = $b.RectangleToScreen($b.ClientRectangle); $q = $t.RectangleToScreen($t.ClientRectangle); $w = $f.Bounds
  & $log ('ready:' + (@($r.X, $r.Y, $r.Width, $r.Height, $q.X, $q.Y, $q.Width, $q.Height, $w.X, $w.Y, $w.Width, $w.Height) -join ','))
  $f.Activate()
})
$tm = New-Object Windows.Forms.Timer; $tm.Interval = 300000; $tm.Add_Tick({ $f.Close() }); $tm.Start()
[Windows.Forms.Application]::Run($f)
