using System;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using System.Runtime.InteropServices;
using Windows.Media.Control;

// One command per invocation: read a JSON request on stdin, act, write a JSON response on stdout.
// Contract (must match WindowsMediaController on the TS side):
//   in:  { "action": "media_pause", "target": "" }
//   out: { "success": true, "app": "Spotify.exe", "status": "paused" }
//        { "success": false, "error": "NO_MEDIA_SESSION" }
internal static class MediaHelper
{
    private const int TimeoutMs = 2500;

    [DllImport("user32.dll")]
    private static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
    private const byte VK_MEDIA_NEXT_TRACK = 0xB0;
    private const byte VK_MEDIA_PREV_TRACK = 0xB1;
    private const byte VK_MEDIA_PLAY_PAUSE = 0xB3;
    private const uint KEYEVENTF_KEYUP = 0x0002;

    private static async Task<int> Main()
    {
        string raw = await Console.In.ReadToEndAsync();
        string action;
        string target;
        try
        {
            using var doc = JsonDocument.Parse(raw);
            action = doc.RootElement.GetProperty("action").GetString() ?? "";
            target = doc.RootElement.TryGetProperty("target", out var t) ? (t.GetString() ?? "") : "";
        }
        catch
        {
            Fail("ACTION_FAILED");
            return 0;
        }

        try
        {
            await Run(action, target);
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine("[media-helper] exception: " + ex.Message);
            Fail("ACTION_FAILED");
        }
        return 0;
    }

    private static async Task Run(string action, string target)
    {
        var mgr = await WithTimeout(GlobalSystemMediaTransportControlsSessionManager.RequestAsync().AsTask());
        var session = SelectSession(mgr, target, out string selError);
        if (session == null)
        {
            if (selError == "NO_MEDIA_SESSION" && TryMediaKey(action))
            {
                Success("media-key", "unknown");
                return;
            }
            Fail(selError);
            return;
        }

        var info = session.GetPlaybackInfo();
        var controls = info.Controls;
        string status = info.PlaybackStatus.ToString().ToLowerInvariant();

        bool ok;
        switch (action)
        {
            case "media_play":
                if (!controls.IsPlayEnabled) { Fail("ACTION_NOT_SUPPORTED"); return; }
                ok = await WithTimeout(session.TryPlayAsync().AsTask());
                break;
            case "media_pause":
                if (!controls.IsPauseEnabled) { Fail("ACTION_NOT_SUPPORTED"); return; }
                ok = await WithTimeout(session.TryPauseAsync().AsTask());
                break;
            case "media_toggle":
                if (!controls.IsPlayPauseToggleEnabled) { Fail("ACTION_NOT_SUPPORTED"); return; }
                ok = await WithTimeout(session.TryTogglePlayPauseAsync().AsTask());
                break;
            case "media_next":
                if (!controls.IsNextEnabled) { Fail("ACTION_NOT_SUPPORTED"); return; }
                ok = await WithTimeout(session.TrySkipNextAsync().AsTask());
                break;
            case "media_previous":
                if (!controls.IsPreviousEnabled) { Fail("ACTION_NOT_SUPPORTED"); return; }
                ok = await WithTimeout(session.TrySkipPreviousAsync().AsTask());
                break;
            default:
                Fail("ACTION_FAILED");
                return;
        }

        if (ok) Success(session.SourceAppUserModelId, status);
        else Fail("ACTION_FAILED");
    }

    // Target named → first session whose app id contains it; else Windows' current session;
    // else the single Playing session; else ambiguous/none → NO_MEDIA_SESSION.
    private static GlobalSystemMediaTransportControlsSession? SelectSession(
        GlobalSystemMediaTransportControlsSessionManager mgr, string target, out string error)
    {
        error = "";
        var sessions = mgr.GetSessions();
        if (target.Length > 0)
        {
            var needle = target.ToLowerInvariant();
            var match = sessions.FirstOrDefault(s =>
                (s.SourceAppUserModelId ?? "").ToLowerInvariant().Contains(needle));
            if (match == null) { error = "NO_MATCHING_SESSION"; return null; }
            return match;
        }

        var current = mgr.GetCurrentSession();
        if (current != null) return current;

        var playing = sessions.Where(s =>
            s.GetPlaybackInfo().PlaybackStatus
                == GlobalSystemMediaTransportControlsSessionPlaybackStatus.Playing).ToList();
        if (playing.Count == 1) return playing[0];

        error = "NO_MEDIA_SESSION";
        return null;
    }

    // Fallback only for toggle/next/previous (a media key for play/pause is just a toggle).
    private static bool TryMediaKey(string action)
    {
        byte vk;
        switch (action)
        {
            case "media_toggle": vk = VK_MEDIA_PLAY_PAUSE; break;
            case "media_next": vk = VK_MEDIA_NEXT_TRACK; break;
            case "media_previous": vk = VK_MEDIA_PREV_TRACK; break;
            default: return false;
        }
        Console.Error.WriteLine("[media-helper] fallback: media-key " + action);
        keybd_event(vk, 0, 0, UIntPtr.Zero);
        keybd_event(vk, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
        return true;
    }

    private static async Task<T> WithTimeout<T>(Task<T> task)
    {
        var finished = await Task.WhenAny(task, Task.Delay(TimeoutMs));
        if (finished != task) throw new TimeoutException("GSMTC await timed out");
        return await task;
    }

    private static void Success(string? app, string status) =>
        Console.Out.WriteLine(JsonSerializer.Serialize(new { success = true, app = app ?? "", status }));

    private static void Fail(string error) =>
        Console.Out.WriteLine(JsonSerializer.Serialize(new { success = false, error }));
}
