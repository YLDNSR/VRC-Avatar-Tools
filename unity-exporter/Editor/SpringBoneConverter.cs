using System.Collections.Generic;
using System.Linq;
using UniVRM10;
using UnityEditor;
using UnityEngine;
using Object = UnityEngine.Object;

namespace VRCAvatarTools.Exporter
{
    /// <summary>
    /// VRCPhysBone / VRCPhysBoneCollider → VRM 1.0 SpringBone (approximate).
    /// PhysBone fields are read through SerializedObject by name, so this compiles without the
    /// VRChat Dynamics assemblies and falls back to defaults if a field is renamed in a future SDK.
    ///   stiffness = pull × 4, drag = lerp(0.7, 0.2, spring), gravityPower = |gravity|, hitRadius = radius × scale
    /// Limits, immobile, stretch/squish and grab settings are not converted.
    /// </summary>
    internal static class SpringBoneConverter
    {
        sealed class PhysBoneSettings
        {
            public float Pull, Spring, Gravity, Radius;
            public AnimationCurve PullCurve, SpringCurve, RadiusCurve;
            public bool IgnoreMultiChild;
            public Vector3 Endpoint;
        }

        public static void Convert(GameObject copy, Vrm10Instance instance, ExportResult result)
        {
            var physBones = copy.GetComponentsInChildren<MonoBehaviour>(true)
                .Where(c => c != null && c.GetType().Name == "VRCPhysBone")
                .ToList();
            if (physBones.Count == 0) return;

            var colliders = new Dictionary<Object, VRM10SpringBoneCollider>();
            var groups = new Dictionary<string, VRM10SpringBoneColliderGroup>();
            int springs = 0, skippedChains = 0;
            foreach (var pb in physBones)
            {
                if (!pb.enabled) continue;
                var so = new SerializedObject(pb);
                var root = ObjectRef(so, "rootTransform") as Transform;
                if (root == null) root = pb.transform;
                if (!root.IsChildOf(copy.transform)) continue;
                var ignore = new HashSet<Transform>(TransformList(so, "ignoreTransforms"));
                var settings = new PhysBoneSettings
                {
                    Pull = Float(so, "pull", 0.2f),
                    Spring = Float(so, "spring", 0.2f),
                    Gravity = Float(so, "gravity", 0f),
                    Radius = Float(so, "radius", 0f),
                    PullCurve = Curve(so, "pullCurve"),
                    SpringCurve = Curve(so, "springCurve"),
                    RadiusCurve = Curve(so, "radiusCurve"),
                    IgnoreMultiChild = Int(so, "multiChildType", 0) == 0,
                    Endpoint = Vector(so, "endpointPosition"),
                };
                var group = ColliderGroup(copy, instance, so, pb.name, colliders, groups);

                var chains = Chains(root, ignore, settings);
                var maxDepth = 1;
                foreach (var chain in chains)
                {
                    foreach (var t in chain) maxDepth = Mathf.Max(maxDepth, Depth(t, root));
                }

                var index = 0;
                foreach (var chain in chains)
                {
                    if (chain.Count < 2) continue;
                    // VRM allows one spring per joint; bones already used by another PhysBone are skipped.
                    if (chain.Any(t => t.GetComponent<VRM10SpringBoneJoint>() != null)) { skippedChains++; continue; }
                    var spring = new Vrm10InstanceSpringBone.Spring(chains.Count > 1 ? $"{pb.name}.{index++}" : pb.name);
                    if (group != null) spring.ColliderGroups.Add(group);
                    foreach (var t in chain)
                    {
                        var depth = (float)Depth(t, root) / maxDepth;
                        var joint = t.gameObject.AddComponent<VRM10SpringBoneJoint>();
                        joint.m_stiffnessForce = Mathf.Max(0f, Along(settings.Pull, settings.PullCurve, depth) * 4f);
                        joint.m_dragForce = Mathf.Lerp(0.7f, 0.2f, Along(settings.Spring, settings.SpringCurve, depth));
                        joint.m_gravityPower = Mathf.Abs(settings.Gravity);
                        joint.m_gravityDir = settings.Gravity >= 0f ? Vector3.down : Vector3.up;
                        joint.m_jointRadius = Mathf.Max(0f, Along(settings.Radius, settings.RadiusCurve, depth)) * PathUtil.MaxScale(t);
                        spring.Joints.Add(joint);
                    }
                    instance.SpringBone.Springs.Add(spring);
                    springs++;
                }
            }
            result.Info.Add($"PhysBone {physBones.Count}개 → SpringBone {springs}개, 콜라이더 {colliders.Count(x => x.Value != null)}개");
            if (skippedChains > 0) result.Warnings.Add($"다른 PhysBone과 겹치는 체인 {skippedChains}개는 SpringBone으로 옮기지 않았습니다.");
        }

        static float Along(float value, AnimationCurve curve, float t)
        {
            return curve != null && curve.length > 0 ? value * curve.Evaluate(t) : value;
        }

        static int Depth(Transform t, Transform root)
        {
            var d = 0;
            for (var p = t; p != null && p != root; p = p.parent) d++;
            return d;
        }

        static List<Transform> Children(Transform t, HashSet<Transform> ignore)
        {
            var list = new List<Transform>();
            foreach (Transform c in t)
            {
                if (!ignore.Contains(c)) list.Add(c);
            }
            return list;
        }

        /// <summary>
        /// Splits the PhysBone hierarchy into linear chains (VRM springs cannot branch).
        /// A branching bone ends its chain; each child starts a new one.
        /// </summary>
        static List<List<Transform>> Chains(Transform root, HashSet<Transform> ignore, PhysBoneSettings s)
        {
            var chains = new List<List<Transform>>();

            void Walk(Transform t, List<Transform> chain)
            {
                chain.Add(t);
                var kids = Children(t, ignore);
                if (kids.Count == 1)
                {
                    Walk(kids[0], chain);
                    return;
                }
                if (kids.Count == 0 && s.Endpoint != Vector3.zero)
                {
                    var end = new GameObject(t.name + "_end").transform;
                    end.SetParent(t, false);
                    end.localPosition = s.Endpoint;
                    chain.Add(end);
                }
                chains.Add(chain);
                foreach (var k in kids) Walk(k, new List<Transform>());
            }

            var rootKids = Children(root, ignore);
            if (rootKids.Count > 1 && s.IgnoreMultiChild)
            {
                // Multi Child Type "Ignore": the root itself does not move.
                foreach (var k in rootKids) Walk(k, new List<Transform>());
            }
            else
            {
                Walk(root, new List<Transform>());
            }
            return chains;
        }

        static VRM10SpringBoneColliderGroup ColliderGroup(GameObject copy, Vrm10Instance instance, SerializedObject so, string name,
            Dictionary<Object, VRM10SpringBoneCollider> cache, Dictionary<string, VRM10SpringBoneColliderGroup> groups)
        {
            var prop = so.FindProperty("colliders");
            if (prop == null || !prop.isArray) return null;
            var list = new List<VRM10SpringBoneCollider>();
            for (var i = 0; i < prop.arraySize; i++)
            {
                var src = prop.GetArrayElementAtIndex(i).objectReferenceValue as Component;
                if (src == null) continue;
                if (!cache.TryGetValue(src, out var dst))
                {
                    dst = ConvertCollider(src, copy.transform);
                    cache[src] = dst;
                }
                if (dst != null && !list.Contains(dst)) list.Add(dst);
            }
            if (list.Count == 0) return null;
            var key = string.Join(",", list.Select(c => c.GetInstanceID()).OrderBy(x => x));
            if (groups.TryGetValue(key, out var group)) return group;
            group = copy.AddComponent<VRM10SpringBoneColliderGroup>();
            group.Name = name;
            group.Colliders = list;
            instance.SpringBone.ColliderGroups.Add(group);
            groups[key] = group;
            return group;
        }

        static VRM10SpringBoneCollider ConvertCollider(Component src, Transform copyRoot)
        {
            var so = new SerializedObject(src);
            var t = ObjectRef(so, "rootTransform") as Transform;
            if (t == null) t = src.transform;
            // Never touch objects outside the temporary copy.
            if (!t.IsChildOf(copyRoot)) return null;
            var shape = Int(so, "shapeType", 0); // 0 Sphere, 1 Capsule, 2 Plane
            var radius = Float(so, "radius", 0.05f);
            var height = Float(so, "height", 0f);
            var position = Vector(so, "position");
            var rotation = Quat(so, "rotation");
            var inside = Bool(so, "insideBounds", false);

            var c = t.gameObject.AddComponent<VRM10SpringBoneCollider>();
            c.Offset = position;
            // VRM collider radii are not scaled by the node; PhysBone radii are.
            c.Radius = radius * PathUtil.MaxScale(t);
            c.ColliderType = inside ? VRM10SpringBoneColliderTypes.SphereInside : VRM10SpringBoneColliderTypes.Sphere;
            if (shape == 1)
            {
                // PhysBone capsule: height includes both caps, along the rotated local Y axis.
                var half = Mathf.Max(0f, height * 0.5f - radius);
                if (half > 0f)
                {
                    var axis = rotation * Vector3.up * half;
                    c.ColliderType = inside ? VRM10SpringBoneColliderTypes.CapsuleInside : VRM10SpringBoneColliderTypes.Capsule;
                    c.Offset = position + axis;
                    c.Tail = position - axis;
                }
            }
            else if (shape == 2)
            {
                c.ColliderType = VRM10SpringBoneColliderTypes.Plane;
                c.Normal = rotation * Vector3.up;
            }
            return c;
        }

        // --- SerializedObject helpers (null-safe, typed fallbacks) ---

        static float Float(SerializedObject so, string name, float fallback)
        {
            var p = so.FindProperty(name);
            return p != null && p.propertyType == SerializedPropertyType.Float ? p.floatValue : fallback;
        }

        static int Int(SerializedObject so, string name, int fallback)
        {
            var p = so.FindProperty(name);
            if (p == null) return fallback;
            return p.propertyType == SerializedPropertyType.Enum || p.propertyType == SerializedPropertyType.Integer ? p.intValue : fallback;
        }

        static bool Bool(SerializedObject so, string name, bool fallback)
        {
            var p = so.FindProperty(name);
            return p != null && p.propertyType == SerializedPropertyType.Boolean ? p.boolValue : fallback;
        }

        static Vector3 Vector(SerializedObject so, string name)
        {
            var p = so.FindProperty(name);
            return p != null && p.propertyType == SerializedPropertyType.Vector3 ? p.vector3Value : Vector3.zero;
        }

        static Quaternion Quat(SerializedObject so, string name)
        {
            var p = so.FindProperty(name);
            return p != null && p.propertyType == SerializedPropertyType.Quaternion ? p.quaternionValue : Quaternion.identity;
        }

        static AnimationCurve Curve(SerializedObject so, string name)
        {
            var p = so.FindProperty(name);
            return p != null && p.propertyType == SerializedPropertyType.AnimationCurve ? p.animationCurveValue : null;
        }

        static Object ObjectRef(SerializedObject so, string name)
        {
            var p = so.FindProperty(name);
            return p != null && p.propertyType == SerializedPropertyType.ObjectReference ? p.objectReferenceValue : null;
        }

        static IEnumerable<Transform> TransformList(SerializedObject so, string name)
        {
            var p = so.FindProperty(name);
            if (p == null || !p.isArray) yield break;
            for (var i = 0; i < p.arraySize; i++)
            {
                if (p.GetArrayElementAtIndex(i).objectReferenceValue is Transform t) yield return t;
            }
        }
    }
}
