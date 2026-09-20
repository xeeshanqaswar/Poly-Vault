using System;
using System.IO;
using UnityEditor;
using UnityEngine;

namespace AssetVault.EditorTools
{
    public class AssetVaultWindow : EditorWindow
    {
        private string _url = AssetVaultSettings.ServerUrl;
        private bool _autoSync = AssetVaultSettings.AutoSync;
        private bool _autoImport = AssetVaultSettings.AutoImport;
        private float _interval = AssetVaultSettings.SyncIntervalSeconds;
        private Vector2 _scroll;

        [MenuItem("Window/Poly Vault/Poly Vault", priority = 500)]
        public static void OpenWindow()
        {
            GetWindow<AssetVaultWindow>("Poly Vault");
        }

        [MenuItem("Window/Poly Vault/Sync Now", priority = 501)]
        public static void SyncNow()
        {
            AssetVaultQueue.PollNow();
        }

        private void OnEnable()
        {
            AssetVaultQueue.JobsChanged += OnJobsChanged;
            AssetVaultQueue.PollNow();
        }

        private void OnDisable()
        {
            AssetVaultQueue.JobsChanged -= OnJobsChanged;
        }

        private void OnJobsChanged() { Repaint(); }

        private void OnGUI()
        {
            EditorGUILayout.Space(4);
            DrawSettings();
            DrawActions();
            EditorGUILayout.Space(6);
            DrawJobs();
            DrawFooter();
        }

        private void DrawSettings()
        {
            EditorGUI.BeginChangeCheck();

            _url = EditorGUILayout.TextField("Server URL", _url);
            _autoSync = EditorGUILayout.Toggle("Sync in background", _autoSync);
            _autoImport = EditorGUILayout.Toggle("Auto-import safe jobs", _autoImport);
            _interval = EditorGUILayout.Slider("Sync interval (s)", _interval, 2f, 120f);

            if (EditorGUI.EndChangeCheck())
            {
                AssetVaultSettings.ServerUrl = _url.Trim();
                AssetVaultSettings.AutoSync = _autoSync;
                AssetVaultSettings.AutoImport = _autoImport;
                AssetVaultSettings.SyncIntervalSeconds = _interval;
                AssetVaultQueue.PollNow();
            }

            if (!AssetVaultSettings.AutoSync)
                EditorGUILayout.HelpBox("Background sync is off. Use Window > Poly Vault > Sync Now or re-enable the toggle.", MessageType.Info);
        }

        private void DrawActions()
        {
            using (new EditorGUILayout.HorizontalScope())
            {
                if (GUILayout.Button("Refresh / Sync", GUILayout.Height(24)))
                    AssetVaultQueue.PollNow();

                if (GUILayout.Button("Open import folder", GUILayout.Height(24)))
                {
                    string full = Path.GetFullPath(AssetVaultImporter.ImportRoot);
                    if (Directory.Exists(full)) EditorUtility.RevealInFinder(AssetVaultImporter.ImportRoot);
                    else Debug.Log($"[Poly Vault] Import folder does not exist yet: {AssetVaultImporter.ImportRoot}");
                }

                if (GUILayout.Button("Whitelist help", GUILayout.Height(24)))
                    EditorUtility.DisplayDialog("Poly Vault",
                        "The server only accepts jobs whose asset folder lives inside a registered library.\n\n" +
                        "Serves on port 7100 on 127.0.0.1 by default. Edit the URL above to point at your running Poly Vault desktop app.", "OK");
            }
        }

        private void DrawJobs()
        {
            EditorGUILayout.LabelField("Pending imports", EditorStyles.boldLabel);
            var jobs = AssetVaultQueue.Jobs;

            if (jobs.Count == 0)
            {
                EditorGUILayout.HelpBox(
                    AssetVaultQueue.LastError == null
                        ? "No pending imports. Open the Poly Vault desktop app and click “Import to Unity” on an asset."
                        : $"Cannot reach server: {AssetVaultQueue.LastError}",
                    AssetVaultQueue.LastError == null ? MessageType.Info : MessageType.Warning);
                return;
            }

            _scroll = EditorGUILayout.BeginScrollView(_scroll, GUILayout.Height(320));
            foreach (var job in jobs)
            {
                DrawJob(job);
            }
            EditorGUILayout.EndScrollView();
        }

        private void DrawJob(ImportJobDto job)
        {
            using (new EditorGUILayout.VerticalScope(EditorStyles.helpBox))
            {
                EditorGUILayout.LabelField(job.DisplayName, EditorStyles.boldLabel);

                string meta = string.IsNullOrEmpty(job.createdAt)
                    ? string.Empty
                    : "queued " + job.createdAt.Replace('T', ' ');
                EditorGUILayout.LabelField(meta, EditorStyles.miniLabel);

                var imp = job.importables;
                if (imp != null && imp.Count > 0)
                {
                    foreach (var item in imp)
                    {
                        using (new EditorGUILayout.HorizontalScope())
                        {
                            EditorGUILayout.LabelField($"• {item.name}  ({item.kind})", EditorStyles.miniLabel);
                            if (GUILayout.Button("Reveal", EditorStyles.miniButton, GUILayout.Width(58)))
                            {
                                if (File.Exists(item.path))
                                    EditorUtility.RevealInFinder(item.path);
                                else
                                    Debug.LogWarning($"[Poly Vault] Missing file: {item.path}");
                            }
                        }
                    }
                }

                using (new EditorGUILayout.HorizontalScope())
                {
                    if (GUILayout.Button($"Import “{job.assetName}” now", GUILayout.MinWidth(160)))
                    {
                        AssetVaultImporter.TryImport(job, interactive: true,
                            log: msg => Debug.Log($"[Poly Vault] {msg}"),
                            finished: (msg, ok) =>
                            {
                                Debug.Log($"[Poly Vault] {msg}");
                                AssetVaultQueue.PollNow();
                            });
                    }

                    if (GUILayout.Button("Cancel", GUILayout.Width(70)))
                    {
                        ReportCancel(job);
                    }
                }
            }
        }

        private static void ReportCancel(ImportJobDto job)
        {
            string url = $"{AssetVaultSettings.ServerUrl}/api/unity/import-jobs/{job.id}/failed";
            AssetVaultWeb.PostJson(url, "{\"note\":\"cancelled in Unity\"}", null);
            AssetVaultQueue.PollNow();
        }

        private void DrawFooter()
        {
            EditorGUILayout.Space();
            var poll = AssetVaultQueue.LastPollAt;
            string text = poll == default(DateTime)
                ? "Not synced yet."
                : $"Last sync: {poll.ToLongTimeString()}";

            if (AssetVaultQueue.LastError != null)
            {
                EditorGUILayout.HelpBox($"Server error: {AssetVaultQueue.LastError}", MessageType.Warning);
            }

            EditorGUILayout.LabelField(text + "   —   Import target: " + AssetVaultImporter.ImportRoot, EditorStyles.miniLabel);
        }
    }
}