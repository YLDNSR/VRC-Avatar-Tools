using System.Text;
using UnityEngine;

namespace VRCAvatarTools.Exporter
{
    internal static class PathUtil
    {
        /// <summary>Animation-style path ("Armature/Hips/Hat") of t below root; "" for root itself.</summary>
        public static string Relative(Transform t, Transform root)
        {
            if (t == root) return "";
            var sb = new StringBuilder(t.name);
            for (var p = t.parent; p != null && p != root; p = p.parent) sb.Insert(0, p.name + "/");
            return sb.ToString();
        }

        /// <summary>Same lookup rule as UniVRM's Transform.GetFromPath (first child with the name), but returns null.</summary>
        public static Transform Find(Transform root, string path)
        {
            if (string.IsNullOrEmpty(path)) return root;
            var current = root;
            foreach (var name in path.Split('/'))
            {
                Transform next = null;
                foreach (Transform child in current)
                {
                    if (child.name == name) { next = child; break; }
                }
                if (next == null) return null;
                current = next;
            }
            return current;
        }

        /// <summary>VRChat strips objects tagged EditorOnly (and their children) from uploads.</summary>
        public static bool IsEditorOnly(Transform t, Transform root)
        {
            for (var p = t; p != null && p != root; p = p.parent)
            {
                if (p.CompareTag("EditorOnly")) return true;
            }
            return false;
        }

        public static float MaxScale(Transform t)
        {
            var s = t.lossyScale;
            return Mathf.Max(Mathf.Abs(s.x), Mathf.Max(Mathf.Abs(s.y), Mathf.Abs(s.z)));
        }
    }
}
