using System;
using System.Linq;
using System.Reflection;
using UnityEngine;

namespace VRCAvatarTools.Exporter
{
    /// <summary>
    /// Runs the same avatar preprocessing as a VRChat upload on a temporary copy: the VRChat SDK's
    /// IVRCSDKPreprocessAvatarCallback hooks (NDMF → Modular Avatar, Avatar Optimizer, …, VRCFury,
    /// EditorOnly removal). Called through reflection so the exporter compiles without those packages.
    /// </summary>
    internal static class UploadBuild
    {
        static Type FindType(string fullName)
        {
            foreach (var a in AppDomain.CurrentDomain.GetAssemblies())
            {
                var t = a.GetType(fullName, false);
                if (t != null) return t;
            }
            return null;
        }

        static MethodInfo Static(Type t, string name, int args)
        {
            return t?.GetMethods(BindingFlags.Public | BindingFlags.Static)
                .FirstOrDefault(m => m.Name == name && m.GetParameters().Length == args);
        }

        /// <summary>True when the copy went through the VRChat SDK (or NDMF) build hooks.</summary>
        public static bool Process(GameObject copy, ExportResult result)
        {
            var callbacks = FindType("VRC.SDKBase.Editor.BuildPipeline.VRCBuildPipelineCallbacks");
            var preprocess = Static(callbacks, "OnPreprocessAvatar", 1);
            if (preprocess != null)
            {
                // Like the SDK (and NDMF's Apply on Play): the copy carries a "(Clone)" suffix while the
                // original stays in the scene; some hooks (VRCFury) rely on that.
                var name = copy.name;
                copy.name = name + "(Clone)";
                try
                {
                    var ok = preprocess.Invoke(null, new object[] { copy });
                    if (ok is bool b && !b) throw new InvalidOperationException("VRChat SDK 빌드 전처리(OnPreprocessAvatar)가 실패했습니다. 콘솔 오류를 확인하세요.");
                }
                catch (TargetInvocationException e)
                {
                    throw new InvalidOperationException("VRChat SDK 빌드 전처리 실패: " + (e.InnerException?.Message ?? e.Message), e.InnerException ?? e);
                }
                finally
                {
                    copy.name = name;
                }
                result.Info.Add("업로드와 같은 빌드 처리 적용 (VRChat SDK 전처리: NDMF·Modular Avatar 등)");
                return true;
            }

            var ndmf = Static(FindType("nadena.dev.ndmf.AvatarProcessor"), "ProcessAvatar", 1);
            if (ndmf != null && ndmf.GetParameters()[0].ParameterType == typeof(GameObject))
            {
                try
                {
                    ndmf.Invoke(null, new object[] { copy });
                }
                catch (TargetInvocationException e)
                {
                    throw new InvalidOperationException("NDMF 빌드 실패: " + (e.InnerException?.Message ?? e.Message), e.InnerException ?? e);
                }
                result.Info.Add("NDMF 빌드 적용 (Modular Avatar 등)");
                return true;
            }
            result.Warnings.Add("VRChat SDK 빌드 전처리 API를 찾지 못해 원본 구성 그대로 내보냅니다 (Modular Avatar 등이 반영되지 않을 수 있음).");
            return false;
        }

        /// <summary>Lets the hooks clean up (NDMF deletes its temporary generated assets).</summary>
        public static void Cleanup()
        {
            try
            {
                var callbacks = FindType("VRC.SDKBase.Editor.BuildPipeline.VRCBuildPipelineCallbacks");
                var post = Static(callbacks, "OnPostprocessAvatar", 0);
                if (post != null) { post.Invoke(null, null); return; }
                Static(FindType("nadena.dev.ndmf.AvatarProcessor"), "CleanTemporaryAssets", 0)?.Invoke(null, null);
            }
            catch (Exception e)
            {
                Debug.LogWarning("[VRC Avatar Tools Exporter] cleanup: " + e.Message);
            }
        }
    }
}
