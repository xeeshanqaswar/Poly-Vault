using System;
using System.Collections.Generic;
using UnityEditor;
using UnityEngine;
using UnityEngine.Networking;

namespace AssetVault.EditorTools
{
    /// <summary>
    /// Minimal async HTTP for editor scripts. Requests are driven by
    /// <see cref="EditorApplication.update"/> so they complete on the main thread
    /// without blocking the UI.
    /// </summary>
    public static class AssetVaultWeb
    {
        // Callback(ok, textOrError). "ok" == HTTP success, "textOrError" is the
        // response body on success or the web request error string on failure.
        private sealed class Pending
        {
            public UnityWebRequest Request;
            public Action<bool, string> Callback;
        }

        private static readonly List<Pending> PendingRequests = new List<Pending>();
        private static bool _hooked;

        private static void EnsureHooked()
        {
            if (_hooked) return;
            _hooked = true;
            EditorApplication.update -= Tick;
            EditorApplication.update += Tick;
        }

        public static void GetJson(string url, Action<bool, string> done)
        {
            var req = UnityWebRequest.Get(url);
            req.timeout = 15;
            Start(req, done);
        }

        public static void PostJson(string url, string jsonBody, Action<bool, string> done)
        {
            var req = new UnityWebRequest(url, UnityWebRequest.kHttpVerbPOST);
            var bytes = System.Text.Encoding.UTF8.GetBytes(jsonBody);
            req.uploadHandler = new UploadHandlerRaw(bytes);
            req.downloadHandler = new DownloadHandlerBuffer();
            req.SetRequestHeader("Content-Type", "application/json");
            req.timeout = 15;
            Start(req, done);
        }

        private static void Start(UnityWebRequest req, Action<bool, string> done)
        {
            EnsureHooked();
            req.SendWebRequest();
            PendingRequests.Add(new Pending { Request = req, Callback = done });
        }

        private static void Tick()
        {
            if (PendingRequests.Count == 0) return;
            for (int i = PendingRequests.Count - 1; i >= 0; i--)
            {
                var p = PendingRequests[i];
                if (!p.Request.isDone) continue;

                bool ok = p.Request.result == UnityWebRequest.Result.Success;
                string textOrError = ok
                    ? p.Request.downloadHandler.text
                    : (p.Request.error ?? "Request failed");

                PendingRequests.RemoveAt(i);
                try
                {
                    p.Callback?.Invoke(ok, textOrError);
                }
                catch (Exception e)
                {
                    Debug.LogError($"[Poly Vault] callback threw: {e}");
                }
                p.Request.Dispose();
            }
        }
    }
}