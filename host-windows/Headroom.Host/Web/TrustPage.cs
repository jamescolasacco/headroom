using System.Net;
using Headroom.Host.Config;
using Headroom.Host.Security;

namespace Headroom.Host.Web;

/// <summary>
/// Served over plain HTTP (port 7080) so a new device can fetch the local CA before it trusts HTTPS.
/// Explains the one-time iOS/macOS/Windows steps, then links to the HTTPS app.
/// </summary>
public static class TrustPage
{
    public static string Render(HttpContext ctx, CertificateManager certs)
    {
        var host = ctx.Request.Host.Host;
        var port = ConfigStore.Current.Port;
        var httpsUrl = $"https://{(host.Contains(':') ? $"[{host}]" : host)}:{port}/";
        var name = WebUtility.HtmlEncode(Services.HostInfo.Name);
        var thumb = certs.CaCertificate.Thumbprint;
        var pretty = string.Join(" ", Enumerable.Range(0, thumb.Length / 4).Select(i => thumb.Substring(i * 4, 4)));
        var ts = certs.TailscaleName != null
            ? $"<div class=\"tip\"><b>Tip:</b> this host also has a Tailscale certificate. On a device signed into your tailnet, open <a href=\"https://{certs.TailscaleName}:{port}/\">https://{certs.TailscaleName}:{port}/</a> — no certificate install needed.</div>"
            : "";
        return $$"""
<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Trust Headroom · {{name}}</title>
<style>
:root{--bg:#0e1116;--fg:#e7ebf0;--muted:#9aa6b2;--card:#171b22;--line:#262c36;--accent:#6aa9ff}
@media (prefers-color-scheme: light){:root{--bg:#f6f7f9;--fg:#14181f;--muted:#5b6672;--card:#fff;--line:#e3e6ea;--accent:#1f6feb} }
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 -apple-system,system-ui,Segoe UI,Roboto,sans-serif}
main{max-width:640px;margin:0 auto;padding:32px 16px}h1{font-size:24px;margin:0 0 4px}p{color:var(--muted)}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px 18px 8px;margin:16px 0}
.card h2{font-size:17px;margin:0 0 8px}ol{padding-left:20px;margin:8px 0 12px}li{margin:6px 0}
a.btn{display:inline-block;background:var(--accent);color:#fff;text-decoration:none;padding:10px 16px;border-radius:10px;font-weight:600;margin:4px 8px 12px 0}
code{font:13px ui-monospace,Menlo,Consolas,monospace;word-break:break-all;color:var(--muted)}.tip{border-left:3px solid var(--accent);padding:8px 12px;margin:16px 0;background:var(--card);border-radius:8px}
</style></head><body><main>
<h1>Connect to {{name}}</h1>
<p>Headroom uses HTTPS so your browser can decode video in hardware. This host signs its own certificate, so each viewing device must trust it once.</p>
{{ts}}
<div class="card"><h2>iPhone / iPad</h2><ol>
<li>In <b>Safari</b>, tap <a href="/headroom-ca.mobileconfig">Download profile</a> and allow it.</li>
<li>Open <b>Settings → General → VPN &amp; Device Management</b>, tap the Headroom profile, and <b>Install</b>.</li>
<li>Open <b>Settings → General → About → Certificate Trust Settings</b> and switch on <b>Headroom Local CA</b>.</li>
<li>Come back and open the app below, then <b>Share → Add to Home Screen</b>.</li></ol>
<a class="btn" href="/headroom-ca.mobileconfig">Download iOS profile</a></div>
<div class="card"><h2>Mac</h2><ol>
<li><a href="/headroom-ca.crt">Download the certificate</a> and open it (Keychain Access).</li>
<li>Double-click <b>Headroom Local CA</b> → Trust → <b>Always Trust</b>.</li></ol>
<a class="btn" href="/headroom-ca.crt">Download certificate</a></div>
<div class="card"><h2>Windows</h2><ol>
<li><a href="/headroom-ca.crt">Download the certificate</a>, open it, click <b>Install Certificate…</b></li>
<li>Choose <b>Current User</b> → <b>Place all certificates in the following store</b> → <b>Trusted Root Certification Authorities</b>.</li></ol>
<a class="btn" href="/headroom-ca.crt">Download certificate</a></div>
<p>Then open <a href="{{httpsUrl}}">{{WebUtility.HtmlEncode(httpsUrl)}}</a></p>
<p>Verify the fingerprint (SHA-1) matches what the host shows:<br><code>{{pretty}}</code></p>
</main></body></html>
""";
    }
}
