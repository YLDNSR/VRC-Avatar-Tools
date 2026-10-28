using System;
using System.IO;
using UnityEditor;
using UnityEngine;

namespace VRCAvatarTools.Exporter
{
    /// <summary>Hierarchy right-click → VRC Avatar Tools → Export.</summary>
    public sealed class ExporterWindow : EditorWindow
    {
        const string MenuPath = "GameObject/VRC Avatar Tools/Export";
        const string PrefAuthor = "VRCAvatarTools.Exporter.Author";
        const string PrefDir = "VRCAvatarTools.Exporter.LastDir";
        const string PrefTPose = "VRCAvatarTools.Exporter.TPose";
        const string PrefPhysBones = "VRCAvatarTools.Exporter.PhysBones";
        const string PrefInactive = "VRCAvatarTools.Exporter.Inactive";
        const string PrefBuild = "VRCAvatarTools.Exporter.UploadBuild";
        const string PrefMaterials = "VRCAvatarTools.Exporter.ConvertMaterials";

        [SerializeField] GameObject _avatar;
        string _author;
        bool _tpose, _physBones, _inactive, _build, _materials;
        ExportResult _last;
        string _error;
        Vector2 _scroll;

        [MenuItem(MenuPath, false, 10)]
        static void OpenFromHierarchy(MenuCommand command)
        {
            // Unity runs GameObject/ context items once per selected object; react only once.
            var go = command.context as GameObject;
            if (go != null && Selection.gameObjects.Length > 1 && go != Selection.activeGameObject) return;
            Open(go != null ? go : Selection.activeGameObject);
        }

        [MenuItem(MenuPath, true)]
        static bool CanOpenFromHierarchy() => AvatarExporter.FindAvatarRoot(Selection.activeGameObject) != null;

        [MenuItem("Tools/VRC Avatar Tools/Export")]
        static void OpenFromTools() => Open(Selection.activeGameObject);

        public static void Open(GameObject selected)
        {
            var window = GetWindow<ExporterWindow>(true, "VRC Avatar Tools", true);
            var root = AvatarExporter.FindAvatarRoot(selected);
            if (root != null) window._avatar = root;
            window.minSize = new Vector2(460, 380);
            window.Show();
        }

        void OnEnable()
        {
            _author = EditorPrefs.GetString(PrefAuthor, "");
            _tpose = EditorPrefs.GetBool(PrefTPose, true);
            _physBones = EditorPrefs.GetBool(PrefPhysBones, true);
            _inactive = EditorPrefs.GetBool(PrefInactive, true);
            _build = EditorPrefs.GetBool(PrefBuild, true);
            _materials = EditorPrefs.GetBool(PrefMaterials, true);
        }

        void OnGUI()
        {
            EditorGUILayout.LabelField("VRChat 아바타 → VRM 1.0 + .vavmeta.json", EditorStyles.boldLabel);
            EditorGUILayout.Space();
            _avatar = (GameObject)EditorGUILayout.ObjectField("아바타 (Avatar)", _avatar, typeof(GameObject), true);
            _author = EditorGUILayout.TextField("작성자 (Author)", _author);
            _tpose = EditorGUILayout.ToggleLeft("T포즈로 맞춰서 내보내기 (Make T-Pose)", _tpose);
            _physBones = EditorGUILayout.ToggleLeft("PhysBone → VRM SpringBone 변환", _physBones);
            _inactive = EditorGUILayout.ToggleLeft("꺼진 오브젝트도 포함 (FX 토글용, 뷰어에서 처음엔 숨김)", _inactive);
            _build = EditorGUILayout.ToggleLeft("업로드와 같은 빌드 적용 (Modular Avatar·NDMF 등)", _build);
            _materials = EditorGUILayout.ToggleLeft("lilToon 등 셰이더 → MToon 변환", _materials);

            var root = AvatarExporter.FindAvatarRoot(_avatar);
            if (_avatar != null && root == null)
                EditorGUILayout.HelpBox("VRC Avatar Descriptor가 있는 아바타 루트를 선택하세요.", MessageType.Warning);
            EditorGUILayout.HelpBox("원본 아바타는 바꾸지 않습니다. 임시 복사본을 업로드할 때처럼 빌드해 VRM으로 내보내고, 같은 폴더에 <이름>.vavmeta.json(메뉴·애니메이터)을 씁니다. 플레이 모드가 아닐 때 내보내세요.", MessageType.Info);
            if (EditorApplication.isPlaying) EditorGUILayout.HelpBox("플레이 모드에서는 내보낼 수 없습니다.", MessageType.Warning);

            using (new EditorGUI.DisabledScope(root == null || EditorApplication.isPlaying))
            {
                if (GUILayout.Button("내보내기 (Export)…", GUILayout.Height(30))) Export(root);
            }

            if (_error != null) EditorGUILayout.HelpBox(_error, MessageType.Error);
            if (_last == null) return;
            _scroll = EditorGUILayout.BeginScrollView(_scroll);
            foreach (var line in _last.Info) EditorGUILayout.LabelField(line, EditorStyles.wordWrappedMiniLabel);
            foreach (var line in _last.Warnings) EditorGUILayout.HelpBox(line, MessageType.Warning);
            EditorGUILayout.EndScrollView();
            if (_last.Success && GUILayout.Button("Finder에서 보기 (Reveal)")) EditorUtility.RevealInFinder(_last.VrmPath);
        }

        void Export(GameObject root)
        {
            EditorPrefs.SetString(PrefAuthor, _author ?? "");
            EditorPrefs.SetBool(PrefTPose, _tpose);
            EditorPrefs.SetBool(PrefPhysBones, _physBones);
            EditorPrefs.SetBool(PrefInactive, _inactive);
            EditorPrefs.SetBool(PrefBuild, _build);
            EditorPrefs.SetBool(PrefMaterials, _materials);
            var path = EditorUtility.SaveFilePanel("Export VRM 1.0", EditorPrefs.GetString(PrefDir, ""), AvatarExporter.SafeFileName(root.name) + ".vrm", "vrm");
            if (string.IsNullOrEmpty(path)) return;
            EditorPrefs.SetString(PrefDir, Path.GetDirectoryName(path));

            _last = null;
            _error = null;
            var options = new ExportOptions { Author = _author, MakeTPose = _tpose, ConvertPhysBones = _physBones, IncludeInactive = _inactive, UploadBuild = _build, ConvertMaterials = _materials };
            try
            {
                EditorUtility.DisplayProgressBar("VRC Avatar Tools", "VRM 1.0 내보내는 중…", 0.5f);
                _last = AvatarExporter.Export(root, path, options);
                foreach (var w in _last.Warnings) Debug.LogWarning("[VRC Avatar Tools Exporter] " + w);
            }
            catch (Exception e)
            {
                Debug.LogException(e);
                _error = "내보내기 실패: " + e.Message;
            }
            finally
            {
                EditorUtility.ClearProgressBar();
            }
            Repaint();
        }
    }
}
