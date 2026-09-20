using System;
using System.Collections.Generic;

namespace AssetVault.EditorTools
{
    // DTOs mirroring the server JSON (JsonUtility matches names exactly).
    [Serializable]
    public class ImportableDto
    {
        public string name;
        public string path;
        public string rel;
        public string kind;
    }

    [Serializable]
    public class ImportJobDto
    {
        public string id;
        public string assetId;
        public string assetName;
        public string category;
        public string libraryName;
        public string assetFolder;
        public List<string> tags = new List<string>();
        public List<ImportableDto> importables = new List<ImportableDto>();
        public string status;
        public string createdAt;
        public string updatedAt;
        public string note;

        public string DisplayName =>
            string.IsNullOrEmpty(category) ? assetName : $"{libraryName}/{category}/{assetName}";
    }

    [Serializable]
    public class ImportJobsEnvelope
    {
        public bool ok;
        public List<ImportJobDto> jobs = new List<ImportJobDto>();
    }

    [Serializable]
    public class OkEnvelope
    {
        public bool ok;
        public string error;
        public ImportJobDto job;
    }
}