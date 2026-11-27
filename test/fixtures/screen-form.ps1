# A small window of the test's own for test/ui/screen.cjs: a button and a text box, on top of
# everything, away from the banner's place at the top of the screen. What happens to it is written
# to a file the test reads back - the only proof a click really reached a window. It closes itself
# after five minutes whatever happens, so a test that dies cannot leave it behind for long.
param([string]$title, [string]$out, [int]$x = 160, [int]$y = 260)
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type -Namespace CaTest -Name Dpi -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();'
# Physical pixels, as the screen helper uses: otherwise the rectangles written below are scaled.
[CaTest.Dpi]::SetProcessDPIAware() | Out-Null
$log = { param($s) [IO.File]::AppendAllText($out, $s + "`n", [Text.Encoding]::UTF8) }
$f = New-Object Windows.Forms.Form
$f.Text = $title; $f.TopMost = $true; $f.StartPosition = 'Manual'; $f.ShowInTaskbar = $true
$f.Location = New-Object Drawing.Point($x, $y); $f.ClientSize = New-Object Drawing.Size(640, 300)
$f.BackColor = [Drawing.Color]::FromArgb(246, 244, 238); $f.Font = New-Object Drawing.Font('Segoe UI', 14)
$b = New-Object Windows.Forms.Button; $b.Text = 'Press me'; $b.Location = New-Object Drawing.Point(30, 30); $b.Size = New-Object Drawing.Size(240, 90)
$t = New-Object Windows.Forms.TextBox; $t.Location = New-Object Drawing.Point(30, 170); $t.Width = 560
$n = New-Object Windows.Forms.Label; $n.Location = New-Object Drawing.Point(300, 60); $n.AutoSize = $true; $n.Text = 'Not pressed yet'
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
