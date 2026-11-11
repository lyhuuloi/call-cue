# live-captions.ps1 - feeds Windows 11 Live Captions into the call-cue page.
#
# Reads the Live Captions window through UI Automation (on this machine) and serves the
# current caption at http://127.0.0.1:8766/live.json. The call-cue page polls it and picks
# answer cards from it. Nothing is sent anywhere else. Each finished sentence is also
# appended to call-transcript-YYYYMMDD-HHmm.txt next to this script.
#
#   1. Turn on Live Captions:  Win + Ctrl + L
#   2. Start call-cue:          node server.mjs --open
#   3. Run this:                powershell -ExecutionPolicy Bypass -File captions\live-captions.ps1
#
# Stop with Ctrl+C. -MockCaptionFile reads the caption from a text file instead (for testing).
param([int]$Port = 8766, [int]$PagePort = 8765, [string]$MockCaptionFile, [switch]$NoTranscript)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

$isWin = [Environment]::OSVersion.Platform -eq 'Win32NT'
if ($isWin) {
    Add-Type -AssemblyName UIAutomationClient
    Add-Type -AssemblyName UIAutomationTypes
}

function Find-CaptionWindows {
    $AE = [System.Windows.Automation.AutomationElement]
    $TS = [System.Windows.Automation.TreeScope]
    $byClass = New-Object System.Windows.Automation.PropertyCondition($AE::ClassNameProperty, 'LiveCaptionsDesktopWindow')
    $wins = @($AE::RootElement.FindAll($TS::Children, $byClass))
    if ($wins.Count -eq 0) {
        foreach ($p in @(Get-Process -Name LiveCaptions -ErrorAction SilentlyContinue)) {
            if ($p.MainWindowHandle -ne [IntPtr]::Zero) { $wins += $AE::FromHandle($p.MainWindowHandle) }
        }
    }
    # Visible windows first: after Live Captions is turned off and on, an old hidden window can linger.
    return @($wins | Sort-Object { try { [bool]$_.Current.IsOffscreen } catch { $true } })
}

function Read-CaptionText($win) {
    $AE = [System.Windows.Automation.AutomationElement]
    $TS = [System.Windows.Automation.TreeScope]
    $byId = New-Object System.Windows.Automation.PropertyCondition($AE::AutomationIdProperty, 'CaptionsTextBlock')
    $el = $win.FindFirst($TS::Descendants, $byId)
    if ($el) { return [string]$el.Current.Name }
    # Fallback: the longest text element in the Live Captions window.
    $byType = New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, [System.Windows.Automation.ControlType]::Text)
    $best = ''
    foreach ($t in $win.FindAll($TS::Descendants, $byType)) {
        $n = [string]$t.Current.Name
        if ($n.Length -gt $best.Length) { $best = $n }
    }
    if ($best.Length -ge 20) { return $best }
    return $null
}

function Get-CaptionState {
    if ($MockCaptionFile) { return @{ status = 'ok'; caption = [System.IO.File]::ReadAllText($MockCaptionFile) } }
    if (-not $isWin) { return @{ status = 'not_windows'; caption = '' } }
    # Look the window up again on every read: toggling Live Captions opens a new window,
    # and a remembered element keeps returning old or empty text.
    $wins = @(Find-CaptionWindows)
    if ($wins.Count -eq 0) {
        if (Get-Process -Name LiveCaptions -ErrorAction SilentlyContinue) { return @{ status = 'no_text_element'; caption = '' } }
        return @{ status = 'no_live_captions'; caption = '' }
    }
    foreach ($w in $wins) {
        try {
            $text = Read-CaptionText $w
            if ($null -ne $text) { return @{ status = 'ok'; caption = $text } }
        } catch { }
    }
    return @{ status = 'no_text_element'; caption = '' }
}

$statusText = @{
    'ok'               = 'OK: reading Live Captions (you can toggle Live Captions; this picks it up again).'
    'no_live_captions' = 'Live Captions is not running. Press Win + Ctrl + L.'
    'no_text_element'  = 'Live Captions is open but has no text yet (waiting for speech).'
    'reconnecting'     = 'Reconnecting to Live Captions...'
    'not_windows'      = 'This is not Windows: serving an empty feed.'
}

$listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, $Port)
try { $listener.Start() } catch {
    Write-Host "Port $Port is busy (is this already running in another window?)." -ForegroundColor Yellow
    exit 1
}
Write-Host "Caption feed: http://127.0.0.1:$Port/live.json  (open call-cue at http://127.0.0.1:$PagePort/)" -ForegroundColor Green
Write-Host 'Keep this window open during the call. Stop: Ctrl+C.'

$utf8 = New-Object System.Text.UTF8Encoding($false)
$utf8Bom = New-Object System.Text.UTF8Encoding($true)
$ascii = [System.Text.Encoding]::ASCII
$transcript = $null
if (-not $NoTranscript) {
    $transcript = Join-Path $here ('call-transcript-{0:yyyyMMdd-HHmm}.txt' -f (Get-Date))
    Write-Host "Transcript: $transcript" -ForegroundColor Green
}
# Only the call-cue page may read the feed from a browser.
$allowedOrigins = @("http://127.0.0.1:$PagePort", "http://localhost:$PagePort")

# Write each finished sentence once. Live Captions keeps revising its text, so a sentence
# that is nearly the same as one of the last 15 written is treated as a revision.
$script:seen = New-Object System.Collections.Generic.HashSet[string]
$script:emitted = New-Object System.Collections.Generic.List[string]
$script:lastCaption = ''
function ConvertTo-SentenceKey([string]$s) {
    $k = $s.ToLowerInvariant().Replace('-', ' ')
    $k = [regex]::Replace($k, '[^a-z0-9 ]+', ' ')
    return ([regex]::Replace($k, '\s+', ' ')).Trim()
}
function Get-Similarity([string]$a, [string]$b) {
    # PowerShell names are case-insensitive: $A would overwrite $a.
    $wordsA = @($a.Split(' ') | Select-Object -Unique); $wordsB = @($b.Split(' ') | Select-Object -Unique)
    $n = @($wordsA | Where-Object { $wordsB -contains $_ }).Count
    return $n / [Math]::Max(1, [Math]::Max($wordsA.Count, $wordsB.Count))
}
function Write-NewSentences([string]$cap) {
    if (-not $transcript) { return }
    $cap = ([regex]::Replace($cap, '\s+', ' ')).Trim()
    if ($cap -eq $script:lastCaption) { return }
    $script:lastCaption = $cap
    if (-not $cap) { return }
    $parts = [regex]::Split($cap, '(?<=[.?!])\s+')
    $n = $parts.Count
    if ($n -gt 0 -and $parts[$n - 1] -notmatch '[.?!]$') { $n-- }  # unfinished tail waits
    for ($i = 0; $i -lt $n; $i++) {
        $p = $parts[$i]; $k = ConvertTo-SentenceKey $p
        if ($k.Split(' ').Count -lt 2 -or $script:seen.Contains($k)) { continue }
        $dup = $false
        foreach ($e in $script:emitted) { if ($e -eq $k -or (Get-Similarity $e $k) -ge 0.7) { $dup = $true; break } }
        if ($dup) { continue }
        [System.IO.File]::AppendAllText($transcript, ('[{0:HH:mm:ss}] {1}' -f (Get-Date), $p) + "`r`n", $utf8Bom)
        [void]$script:seen.Add($k)
        $script:emitted.Add($k); if ($script:emitted.Count -gt 15) { $script:emitted.RemoveAt(0) }
    }
}

$state = @{ status = 'starting'; caption = '' }
$lastStatus = ''
$nextPoll = [DateTime]::UtcNow
try {
    while ($true) {
        $now = [DateTime]::UtcNow
        if ($now -ge $nextPoll) {
            try { $state = Get-CaptionState } catch { $state = @{ status = 'reconnecting'; caption = '' } }
            $nextPoll = $now.AddMilliseconds(300)
            if ($state.status -eq 'ok') { try { Write-NewSentences $state.caption } catch { } }
            if ($state.status -ne $lastStatus) {
                $lastStatus = $state.status
                Write-Host ("[{0:HH:mm:ss}] {1}" -f (Get-Date), $statusText[$lastStatus])
            }
        }
        if (-not $listener.Pending()) { Start-Sleep -Milliseconds 30; continue }
        $client = $listener.AcceptTcpClient()
        try {
            $client.ReceiveTimeout = 500
            $ns = $client.GetStream()
            $buf = New-Object byte[] 8192
            $n = 0
            try { $n = $ns.Read($buf, 0, $buf.Length) } catch { $n = 0 }
            if ($n -gt 0) {
                $lines = $ascii.GetString($buf, 0, $n) -split "`r`n"
                $path = ($lines[0] -split ' ')[1]
                $hostOk = $false; $origin = ''
                foreach ($h in $lines) {
                    if ($h -match '^(?i)host:\s*(\S+)') { $hostOk = @("127.0.0.1:$Port", "localhost:$Port") -contains $Matches[1] }
                    if ($h -match '^(?i)origin:\s*(\S+)') { $origin = $Matches[1] }
                }
                $code = '404 Not Found'; $ctype = 'text/plain; charset=utf-8'; $body = $utf8.GetBytes('not found')
                if (-not $hostOk) {
                    $code = '421 Misdirected Request'; $body = $utf8.GetBytes('wrong host')
                } elseif ($path -and $path.StartsWith('/live.json')) {
                    $obj = [ordered]@{
                        ts      = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() / 1000
                        status  = $state.status
                        caption = $state.caption
                    }
                    $body = $utf8.GetBytes(($obj | ConvertTo-Json -Compress))
                    $code = '200 OK'; $ctype = 'application/json; charset=utf-8'
                }
                $cors = ''
                if ($allowedOrigins -contains $origin) { $cors = "Access-Control-Allow-Origin: $origin`r`nVary: Origin`r`n" }
                $hdr = "HTTP/1.1 $code`r`nContent-Type: $ctype`r`nContent-Length: $($body.Length)`r`nCache-Control: no-store`r`n$cors" + "Connection: close`r`n`r`n"
                $hb = $ascii.GetBytes($hdr)
                $ns.Write($hb, 0, $hb.Length)
                $ns.Write($body, 0, $body.Length)
                $ns.Flush()
            }
        } catch {
        } finally {
            $client.Close()
        }
    }
} finally {
    $listener.Stop()
}
