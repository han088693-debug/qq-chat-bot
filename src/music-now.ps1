# 读取当前 QQ 音乐播放状态（Windows 媒体会话 / GSMTC）。
# 由 src/music-now.js 用 powershell.exe -File 调用，输出一行 JSON。
# 不依赖 QQ 音乐 CDP（QQ 音乐不是 Chromium，没有 9222 调试端口）。
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch {}

function Emit($obj) {
  $obj | ConvertTo-Json -Compress -Depth 4
}

try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null
  $asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
  })[0]
  function Await($op, $type) {
    $task = $asTask.MakeGenericMethod($type).Invoke($null, @($op))
    $task.Wait() | Out-Null
    $task.Result
  }
  $managerType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
  $manager = Await ($managerType::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
  $sessions = @($manager.GetSessions())
  $qq = @($sessions | Where-Object { $_.SourceAppUserModelId -match 'QQMusic' })
  $target = $qq | Where-Object { $_.GetPlaybackInfo().PlaybackStatus -eq 'Playing' } | Select-Object -First 1
  if (-not $target) { $target = $qq | Select-Object -First 1 }
  if (-not $target) {
    Emit ([ordered]@{ ok = $true; hasSession = $false; playing = $false; app = $null; title = ''; artist = ''; album = ''; status = 'NoSession'; positionSec = 0; durationSec = 0 })
    exit 0
  }
  $info = Await ($target.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
  $playback = $target.GetPlaybackInfo()
  $timeline = $target.GetTimelineProperties()
  $status = [string]$playback.PlaybackStatus
  $position = 0.0
  $duration = 0.0
  try { $position = [math]::Round($timeline.Position.TotalSeconds, 1) } catch {}
  try { $duration = [math]::Round($timeline.EndTime.TotalSeconds, 1) } catch {}
  Emit ([ordered]@{
    ok = $true
    hasSession = $true
    playing = ($status -eq 'Playing')
    app = [string]$target.SourceAppUserModelId
    title = [string]$info.Title
    artist = [string]$info.Artist
    album = [string]$info.AlbumTitle
    status = $status
    positionSec = $position
    durationSec = $duration
  })
} catch {
  Emit ([ordered]@{ ok = $false; error = [string]$_.Exception.Message; hasSession = $false; playing = $false })
  exit 0
}
