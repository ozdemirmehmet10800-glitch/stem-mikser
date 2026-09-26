<#
.SYNOPSIS
    Stem Mikser API duman testi (PowerShell 5.1).

.DESCRIPTION
    Token'i $env:USERPROFILE\stem-mikser-token.txt dosyasindan okur ve HICBIR
    yerde ekrana basmaz. Token komut satirina da girmez: curl.exe'ye -K ile
    gecici bir yapilandirma dosyasi veriliyor, boylece islem listesinde de
    gorunmez.

    curl yerine curl.exe kullaniliyor: PowerShell 5.1'de curl,
    Invoke-WebRequest'in takma adidir ve -D, -r, -F bayraklarini tanimaz.

.PARAMETER BaseUrl
    API adresi, ornek: https://xxx--stem-mikser-dev.modal.run

.PARAMETER UploadFile
    Verilirse yeni sarki yukleme testi de yapilir. Zaten islenmis bir dosya
    ver (ornek sarki.mp3): o zaman mevcut id doner ve GPU harcanmaz.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File tests\api_smoke.ps1 -BaseUrl https://...
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string] $BaseUrl,

    [string] $UploadFile,

    [string] $TokenFile = (Join-Path $env:USERPROFILE 'stem-mikser-token.txt'),

    # Suresi gecmis ama DOGRU imzali bir link uretmek icin gerekli. Yoksa o
    # kontrol atlanir: imza exp'i de kapsadigi icin anahtar olmadan gecerli
    # bir "suresi gecmis" imza uretilemez.
    [string] $SigningKeyFile = (Join-Path $env:USERPROFILE 'stem-mikser-signing-key.txt')
)

$ErrorActionPreference = 'Stop'
$BaseUrl = $BaseUrl.TrimEnd('/')

# Konsol UTF-8 olmazsa Turkce basliklar ve etiketler bozuk gorunur.
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$script:Pass = 0
$script:Fail = 0
$script:Skip = 0
$script:TempFiles = New-Object System.Collections.ArrayList

function Write-Result {
    param([string] $Name, [bool] $Ok, [string] $Detail)
    if ($Ok) {
        $script:Pass++
        Write-Host ('GEÇTİ  ' + $Name) -ForegroundColor Green
    }
    else {
        $script:Fail++
        Write-Host ('KALDI  ' + $Name) -ForegroundColor Red
    }
    if ($Detail) { Write-Host ('       ' + $Detail) -ForegroundColor DarkGray }
}

function Write-Skipped {
    param([string] $Name, [string] $Reason)
    $script:Skip++
    Write-Host ('ATLANDI ' + $Name) -ForegroundColor Yellow
    Write-Host ('       ' + $Reason) -ForegroundColor DarkGray
}

function New-TempFile {
    $path = [System.IO.Path]::GetTempFileName()
    [void] $script:TempFiles.Add($path)
    return $path
}

# --- token -----------------------------------------------------------------

if (-not (Test-Path $TokenFile)) {
    Write-Host "Token dosyasi yok: $TokenFile" -ForegroundColor Red
    Write-Host "Olusturmak icin (token'i tirnak icine koy):" -ForegroundColor Yellow
    Write-Host "  Set-Content -Path `"$TokenFile`" -Value '<token>' -NoNewline"
    exit 2
}
$token = (Get-Content $TokenFile -Raw).Trim()
if (-not $token) {
    Write-Host "Token dosyasi bos: $TokenFile" -ForegroundColor Red
    exit 2
}

# Token'i komut satirina koymuyoruz: curl yapilandirma dosyasina yaziyoruz.
$authConfig = New-TempFile
Set-Content -Path $authConfig -Value ('header = "Authorization: Bearer ' + $token + '"') -Encoding ASCII

# --- curl sarmalayici ------------------------------------------------------

function Invoke-Api {
    param(
        [string[]] $CurlArgs,
        [switch] $NoAuth,
        [string] $OutFile
    )
    $headerFile = New-TempFile
    if (-not $OutFile) { $OutFile = New-TempFile }

    $all = @('-s', '-S', '--max-time', '120', '-D', $headerFile, '-o', $OutFile,
             '-w', '%{http_code}')
    if (-not $NoAuth) { $all += @('-K', $authConfig) }
    $all += $CurlArgs

    $codeText = (& curl.exe @all) 2>$null
    $code = 0
    [void] [int]::TryParse(($codeText | Select-Object -Last 1), [ref] $code)

    $headers = ''
    if (Test-Path $headerFile) { $headers = Get-Content $headerFile -Raw }

    return [pscustomobject] @{
        Code     = $code
        Headers  = if ($headers) { $headers } else { '' }
        BodyFile = $OutFile
        Length   = if (Test-Path $OutFile) { (Get-Item $OutFile).Length } else { 0 }
    }
}

function Get-Json {
    param([pscustomobject] $Response)
    if (-not (Test-Path $Response.BodyFile)) { return $null }
    # -Encoding UTF8 SART: PowerShell 5.1'de Get-Content varsayilan olarak
    # sistem ANSI kod sayfasini (tr-TR'de cp1254) kullanir ve UTF-8 govdeyi
    # bozar - "Turkce" yerine "TÃ¼rkÃ§e" gorunmesinin sebebi buydu. API'nin
    # sakladigi veri dogru; hata yalnizca burada, okumadaydi.
    $raw = Get-Content $Response.BodyFile -Raw -Encoding UTF8
    if (-not $raw) { return $null }
    try { return $raw | ConvertFrom-Json } catch { return $null }
}

function Get-HeaderValue {
    param([string] $Headers, [string] $Name)
    foreach ($line in ($Headers -split "`r?`n")) {
        if ($line -match ('^(?i)' + [regex]::Escape($Name) + '\s*:\s*(.+)$')) {
            return $Matches[1].Trim()
        }
    }
    return $null
}

function Get-Hmac {
    param([string] $Key, [string] $Message)
    $hmac = New-Object System.Security.Cryptography.HMACSHA256
    $hmac.Key = [System.Text.Encoding]::UTF8.GetBytes($Key)
    $bytes = $hmac.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($Message))
    $hmac.Dispose()
    return (($bytes | ForEach-Object { $_.ToString('x2') }) -join '')
}

# ==========================================================================

Write-Host ''
Write-Host "Stem Mikser API duman testi" -ForegroundColor Cyan
Write-Host "  adres : $BaseUrl"
Write-Host "  token : $TokenFile (okundu, gosterilmiyor)"
Write-Host ''

try {
    # --- 1. yetkilendirme --------------------------------------------------
    $response = Invoke-Api -CurlArgs @("$BaseUrl/health") -NoAuth
    Write-Result 'Token olmadan /health 401 veriyor' ($response.Code -eq 401) `
        ("HTTP " + $response.Code)

    $response = Invoke-Api -CurlArgs @("$BaseUrl/health")
    $health = Get-Json $response
    Write-Result 'Token ile /health 200 veriyor' `
        (($response.Code -eq 200) -and ($health -ne $null) -and $health.ok) `
        ("HTTP " + $response.Code + ", fastapi " + $health.fastapi)

    # --- 2. sarki listesi --------------------------------------------------
    $response = Invoke-Api -CurlArgs @("$BaseUrl/songs")
    $list = Get-Json $response
    $hasList = ($response.Code -eq 200) -and ($list -ne $null) -and ($list.songs -ne $null)
    Write-Result 'Sarki listesi donuyor' $hasList `
        ("HTTP " + $response.Code + ", " + @($list.songs).Count + " sarki")

    $song = $null
    if ($hasList) {
        $song = @($list.songs) | Where-Object { $_.state -eq 'done' } | Select-Object -First 1
    }
    if (-not $song) {
        Write-Host ''
        Write-Host "Durumu 'done' olan sarki yok; dosyaya bagli kontroller yapilamaz." -ForegroundColor Red
        Write-Host "Once bir sarki isleyin: modal run backend\app.py --path sarki.mp3"
        exit 1
    }
    $songId = $song.id
    Write-Host ''
    Write-Host ("  test sarkisi: " + $song.title + "  (" + $songId.Substring(0, 12) + "...)") -ForegroundColor Cyan
    Write-Host ''

    # --- 3. durum + akorlar ------------------------------------------------
    $response = Invoke-Api -CurlArgs @("$BaseUrl/songs/$songId")
    $detail = Get-Json $response
    $okStatus = ($response.Code -eq 200) -and ($detail.status -ne $null) -and
                ($detail.status.state -eq 'done')
    Write-Result 'Sarki durumu okunuyor' $okStatus `
        ("HTTP " + $response.Code + ", durum " + $detail.status.state)

    $chordCount = 0
    if ($detail.chords -ne $null) { $chordCount = @($detail.chords.chords).Count }
    $okChords = ($detail.chords -ne $null) -and ($chordCount -gt 0) -and
                ($detail.chords.bpm -ne $null)
    Write-Result 'Akorlar donuyor (bpm + akor listesi)' $okChords `
        ("bpm " + $detail.chords.bpm + ", ton " + $detail.chords.key + ", " +
         $chordCount + " akor, " + @($detail.chords.downbeats).Count + " downbeat")

    $stemName = 'vocals'
    if ($detail.status.stems) {
        $stems = @($detail.status.stems)
        if ($stems -notcontains $stemName) { $stemName = $stems[0] }
    }
    $stemUrl = "$BaseUrl/songs/$songId/stems/$stemName.m4a"

    # --- 4. Range ----------------------------------------------------------
    $response = Invoke-Api -CurlArgs @('-H', 'Range: bytes=0-1023', $stemUrl)
    $contentRange = Get-HeaderValue $response.Headers 'Content-Range'
    $acceptRanges = Get-HeaderValue $response.Headers 'Accept-Ranges'
    $okRange = ($response.Code -eq 206) -and
               ($contentRange -like 'bytes 0-1023/*') -and
               ($response.Length -eq 1024)
    Write-Result 'Range istegi 206 + Content-Range veriyor' $okRange `
        ("HTTP " + $response.Code + ", Content-Range: " + $contentRange +
         ", govde " + $response.Length + " bayt, Accept-Ranges: " + $acceptRanges)

    # Ortadan bir dilim: offset gercekten uygulaniyor mu
    $response = Invoke-Api -CurlArgs @('-H', 'Range: bytes=2048-3071', $stemUrl)
    $contentRange = Get-HeaderValue $response.Headers 'Content-Range'
    Write-Result 'Ortadan dilim de dogru' `
        (($response.Code -eq 206) -and ($contentRange -like 'bytes 2048-3071/*') -and
         ($response.Length -eq 1024)) `
        ("Content-Range: " + $contentRange + ", govde " + $response.Length + " bayt")

    # --- 5. karsilanamaz Range --------------------------------------------
    $response = Invoke-Api -CurlArgs @('-H', 'Range: bytes=99999999-', $stemUrl)
    $contentRange = Get-HeaderValue $response.Headers 'Content-Range'
    Write-Result 'Karsilanamaz Range 416 veriyor' `
        (($response.Code -eq 416) -and ($contentRange -like 'bytes */*')) `
        ("HTTP " + $response.Code + ", Content-Range: " + $contentRange)

    # --- 6. imzali link + WAV indirme -------------------------------------
    $response = Invoke-Api -CurlArgs @('-X', 'POST',
        "$BaseUrl/songs/$songId/download-link?name=$stemName&format=wav")
    $link = Get-Json $response
    $okLink = ($response.Code -eq 200) -and ($link -ne $null) -and ($link.url) -and
              ($link.expires_at -gt 0)
    Write-Result 'Imzali indirme linki uretiliyor' $okLink `
        ("HTTP " + $response.Code + ", gecerlilik " + $link.ttl + " sn")

    if ($okLink) {
        # Imzali URL token ISTEMEDEN calismali (<a> etiketi header gonderemez)
        $wavFile = New-TempFile
        $response = Invoke-Api -CurlArgs @($link.url) -NoAuth -OutFile $wavFile
        $magic = ''
        if ((Test-Path $wavFile) -and ((Get-Item $wavFile).Length -ge 12)) {
            $head = [System.IO.File]::ReadAllBytes($wavFile)[0..11]
            $magic = [System.Text.Encoding]::ASCII.GetString($head[0..3]) +
                     [System.Text.Encoding]::ASCII.GetString($head[8..11])
        }
        Write-Result 'WAV token olmadan, imzayla iniyor' `
            (($response.Code -eq 200) -and ($magic -eq 'RIFFWAVE')) `
            ("HTTP " + $response.Code + ", " +
             [math]::Round($response.Length / 1MB, 2) + " MB, sihirli sayi '" + $magic + "'")

        # --- 7. bozuk imza ------------------------------------------------
        # Degistirme metni AYRI degiskende: -replace 'desen', 'a' + 'b'
        # yazilirsa PowerShell bunu 3 ogeli sanip
        # "The -ireplace operator allows only two elements to follow it" diyor.
        $badSignature = 'sig=' + ('de' * 32)
        $badUrl = $link.url -replace 'sig=[0-9a-f]+', $badSignature
        $response = Invoke-Api -CurlArgs @($badUrl) -NoAuth
        $body = Get-Json $response
        Write-Result 'Bozuk imza 403 veriyor' `
            (($response.Code -eq 403) -and ($body.detail -like '*mza*')) `
            ("HTTP " + $response.Code + ", detay: " + $body.detail)
    }

    # --- 8. suresi gecmis ama DOGRU imza ----------------------------------
    if (Test-Path $SigningKeyFile) {
        $signingKey = (Get-Content $SigningKeyFile -Raw).Trim()
        # Get-Date -UFormat %s yerine bu: ondalik ayirici kulture bagli degil
        # (tr-TR'de virgul/nokta karisikligi [double]::Parse'i patlatabilir).
        $expired = [int] [DateTimeOffset]::UtcNow.ToUnixTimeSeconds() - 60
        $message = $songId + '|' + $stemName + '|wav|' + $expired
        $signature = Get-Hmac -Key $signingKey -Message $message
        $expiredUrl = "$BaseUrl/songs/$songId/download/$stemName" +
                      "?format=wav&exp=$expired&sig=$signature"
        $response = Invoke-Api -CurlArgs @($expiredUrl) -NoAuth
        $body = Get-Json $response
        # Detayin "suresi gecmis" olmasi onemli: imza dogrulamayi GECTI,
        # yani gercekten son kullanma dali test edildi.
        Write-Result 'Suresi gecmis (dogru imzali) link 403 veriyor' `
            (($response.Code -eq 403) -and ($body.detail -like '*suresi*')) `
            ("HTTP " + $response.Code + ", detay: " + $body.detail)
    }
    else {
        Write-Skipped 'Suresi gecmis (dogru imzali) link 403 veriyor' `
            ("Imzalama anahtari yok: $SigningKeyFile. Imza exp'i de kapsadigi " +
             "icin anahtar olmadan gecerli bir 'suresi gecmis' imza uretilemez.")
    }

    # --- 9. DELETE: var olmayan id ----------------------------------------
    # Mevcut sarki BILEREK silinmiyor.
    $missingId = ('0' * 64)
    $response = Invoke-Api -CurlArgs @('-X', 'DELETE', "$BaseUrl/songs/$missingId")
    Write-Result 'Var olmayan id DELETE 404 veriyor' ($response.Code -eq 404) `
        ("HTTP " + $response.Code)

    # --- 10. opsiyonel yukleme --------------------------------------------
    if ($UploadFile) {
        if (-not (Test-Path $UploadFile)) {
            Write-Skipped 'Sarki yukleme' "Dosya bulunamadi: $UploadFile"
        }
        else {
            $response = Invoke-Api -CurlArgs @('-F', ('file=@' + $UploadFile),
                                               "$BaseUrl/songs")
            $upload = Get-Json $response
            Write-Result 'Sarki yukleme id donuyor' `
                (($response.Code -eq 200) -and ($upload.id)) `
                ("HTTP " + $response.Code + ", id " +
                 $(if ($upload.id) { $upload.id.Substring(0, 12) + '...' } else { '-' }) +
                 ", mevcut mu: " + $upload.existing)

            if ($upload.id) {
                $response = Invoke-Api -CurlArgs @('-F', ('file=@' + $UploadFile),
                                                   "$BaseUrl/songs")
                $again = Get-Json $response
                Write-Result 'Ayni dosya tekrar islenmiyor (sha256 tekillestirme)' `
                    (($response.Code -eq 200) -and ($again.id -eq $upload.id) -and
                     ($again.existing -eq $true)) `
                    ("ayni id: " + [bool]($again.id -eq $upload.id) +
                     ", existing: " + $again.existing)
            }
        }
    }
    else {
        Write-Skipped 'Sarki yukleme' `
            '-UploadFile <yol> ile acilir (islenmis bir dosya verin, GPU harcanmaz)'
    }
}
finally {
    foreach ($path in $script:TempFiles) {
        Remove-Item $path -Force -ErrorAction SilentlyContinue
    }
}

Write-Host ''
Write-Host ('=' * 60)
Write-Host ("gecen: {0}   kalan: {1}   atlanan: {2}" -f $script:Pass, $script:Fail, $script:Skip)
if ($script:Fail -gt 0) { exit 1 }
exit 0
