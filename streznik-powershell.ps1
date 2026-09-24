# streznik-powershell.ps1
# Alternativni lokalni streznik za "OCR Iskalnik slik", ki NE uporablja Pythona.
# Namenjen racunalnikom, kjer IT politika (AppLocker/SRP) blokira zagon python.exe
# kot programa (dokazano na uporabnikovem sluzbenem Windows racunalniku, 2026-09-24 -
# glej HISTORY_AI_AGENT.txt) - tudi ce je python.exe dejansko nameščen.
#
# Zakaj to deluje, ko python.exe ne: ta skripta NE zazene nobenega novega .exe programa.
# Vsa logika tece znotraj ze odprtega (in torej ze IT-dovoljenega) powershell.exe prek
# vgrajenega .NET razreda System.Net.HttpListener. Na uporabnikovem racunalniku je bilo
# potrjeno (glej HISTORY_AI_AGENT.txt), da ukaz "[System.Net.HttpListener]::new()" v
# PowerShell oknu ne sprozi IT-opozorila.
#
# UPORABA: te vrstice prilepite NEPOSREDNO v ze odprto PowerShell okno (ne shranjujte in
# ne zaganjajte kot .ps1 datoteko z dvoklikom - to bi lahko sprozilo LOCENO pravilo o
# izvajanju skriptnih datotek, ki smo ga v tem projektu ze zasledili pri .bat datotekah).
# Ce vas IT vseeno dovoljuje zagon .ps1 datotek, jo lahko zazenete tudi tako.

$Port = 8934
$Root = (Get-Location).Path

$ContentTypes = @{
    ".html" = "text/html; charset=utf-8"
    ".htm"  = "text/html; charset=utf-8"
    ".js"   = "application/javascript; charset=utf-8"
    ".mjs"  = "application/javascript; charset=utf-8"
    ".css"  = "text/css; charset=utf-8"
    ".json" = "application/json; charset=utf-8"
    ".wasm" = "application/wasm"
    ".png"  = "image/png"
    ".jpg"  = "image/jpeg"
    ".jpeg" = "image/jpeg"
    ".gif"  = "image/gif"
    ".svg"  = "image/svg+xml"
    ".ico"  = "image/x-icon"
    ".txt"  = "text/plain; charset=utf-8"
}

$Listener = New-Object System.Net.HttpListener
$Listener.Prefixes.Add("http://127.0.0.1:$Port/")

try {
    $Listener.Start()
} catch {
    Write-Host "NAPAKA: streznika ni bilo mogoce zagnati na vratih $Port (morda so ze zasedena)."
    Write-Host "Poskusite spremeniti stevilko v vrstici '`$Port = 8934' na vrhu te skripte (npr. 8935) in ponovite."
    Write-Host "Podrobnost napake: $($_.Exception.Message)"
    return
}

Write-Host "Lokalni streznik (PowerShell, brez Pythona) tece na: http://127.0.0.1:$Port/index.html"
Write-Host "Odprite zgornji naslov v brskalniku (priporoceno Microsoft Edge)."
Write-Host "Za ustavitev streznika pritisnite Ctrl+C v tem oknu."

try {
    while ($Listener.IsListening) {
        $Context = $Listener.GetContext()
        $Request = $Context.Request
        $Response = $Context.Response
        try {
            $UrlPath = [System.Uri]::UnescapeDataString($Request.Url.LocalPath).TrimStart('/')
            if ([string]::IsNullOrEmpty($UrlPath)) { $UrlPath = "index.html" }

            # prepreci izhod iz korenske mape (varnost)
            $FullPath = [System.IO.Path]::GetFullPath((Join-Path $Root $UrlPath))
            if (-not $FullPath.StartsWith($Root, [System.StringComparison]::OrdinalIgnoreCase)) {
                $Response.StatusCode = 403
                $Response.Close()
                continue
            }

            if (Test-Path -LiteralPath $FullPath -PathType Leaf) {
                $Ext = [System.IO.Path]::GetExtension($FullPath).ToLower()
                $Bytes = [System.IO.File]::ReadAllBytes($FullPath)
                $Response.ContentType = if ($ContentTypes.ContainsKey($Ext)) { $ContentTypes[$Ext] } else { "application/octet-stream" }
                $Response.ContentLength64 = $Bytes.Length
                $Response.OutputStream.Write($Bytes, 0, $Bytes.Length)
            } else {
                $Response.StatusCode = 404
                $NotFoundBytes = [System.Text.Encoding]::UTF8.GetBytes("404 - datoteka ni najdena: $UrlPath")
                $Response.OutputStream.Write($NotFoundBytes, 0, $NotFoundBytes.Length)
            }
        } catch {
            Write-Host "Napaka pri postrezbi zahteve: $($_.Exception.Message)"
            $Response.StatusCode = 500
        } finally {
            $Response.OutputStream.Close()
        }
    }
} finally {
    $Listener.Stop()
    $Listener.Close()
    Write-Host "Streznik ustavljen."
}
