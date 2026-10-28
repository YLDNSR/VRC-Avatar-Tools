using System;
using System.Collections.Generic;
using System.Linq;
using UnityEngine;
using VRM10.MToon10;
using Object = UnityEngine.Object;

namespace VRCAvatarTools.Exporter
{
    /// <summary>
    /// Replaces lilToon (and other non-glTF) materials on the export copy with VRM 1.0 MToon materials so
    /// the VRM keeps the toon look instead of UniVRM's metallic PBR fallback. Mapping follows lilToon's own
    /// "Convert to MToon": main colour adjustments / 2nd·3rd textures are baked with lilToon's baker shader,
    /// the alpha mask is baked into the main texture alpha, 1st shadow → shade colour and toony/shift (strength
    /// mask baked into the shade texture), rim and MatCap with their masks (see ApplyMatcapAndRim), emission,
    /// normal map and outline.
    /// </summary>
    internal sealed class MaterialConverter
    {
        public const string CarrierName = "__vav_materials";

        readonly Dictionary<Material, Material> _cache = new Dictionary<Material, Material>();
        readonly List<Object> _temporary;
        readonly ExportResult _result;
        readonly Shader _mtoon;
        readonly Shader _lilBaker;
        int _lilToon, _generic, _droppedRims, _droppedMatcaps, _bakedShades;

        public MaterialConverter(List<Object> temporary, ExportResult result)
        {
            _temporary = temporary;
            _result = result;
            _mtoon = Shader.Find("VRM10/MToon10");
            _lilBaker = Shader.Find("Hidden/ltsother_baker");
            if (_mtoon == null) result.Warnings.Add("VRM10/MToon10 셰이더를 찾지 못해 머티리얼을 변환하지 않습니다.");
        }

        public void ConvertRenderers(GameObject root)
        {
            foreach (var r in root.GetComponentsInChildren<Renderer>(true))
            {
                if (!(r is SkinnedMeshRenderer || r is MeshRenderer)) continue;
                var materials = r.sharedMaterials;
                var changed = false;
                for (var i = 0; i < materials.Length; i++)
                {
                    var converted = Convert(materials[i]);
                    if (converted == materials[i]) continue;
                    materials[i] = converted;
                    changed = true;
                }
                if (changed) r.sharedMaterials = materials;
            }
        }

        public void Report()
        {
            if (_lilToon > 0) _result.Info.Add($"lilToon 머티리얼 {_lilToon}개 → MToon 변환");
            if (_generic > 0) _result.Info.Add($"기타 셰이더 머티리얼 {_generic}개 → MToon(기본 색·텍스처만) 변환");
            if (_bakedShades > 0) _result.Info.Add($"그림자 강도 마스크 {_bakedShades}개를 그림자 텍스처에 구움");
            if (_droppedRims + _droppedMatcaps > 0)
                _result.Info.Add($"MatCap·림라이트 마스크가 달라 약한 쪽을 생략: 림 {_droppedRims}개, MatCap {_droppedMatcaps}개 (MToon은 마스크가 하나)");
        }

        /// <summary>
        /// A mesh ("__vav_materials") whose slots hold the materials used by material-swap animations, so they
        /// are written to the VRM. AvatarExporter detaches it from the scene; slot i ↔ sidecar materials[i].
        /// </summary>
        public List<string> AddCarrier(GameObject root, IList<Material> materials)
        {
            var names = new List<string>();
            if (materials.Count == 0) return names;
            var converted = materials.Select(m => Convert(m) ?? m).ToArray();
            var mesh = new Mesh { name = CarrierName };
            _temporary.Add(mesh);
            var vertices = new List<Vector3>();
            var normals = new List<Vector3>();
            var uvs = new List<Vector2>();
            for (var i = 0; i < converted.Length; i++)
            {
                vertices.Add(Vector3.zero);
                vertices.Add(new Vector3(0.0001f, 0f, 0f));
                vertices.Add(new Vector3(0f, 0.0001f, 0f));
                for (var k = 0; k < 3; k++) { normals.Add(Vector3.forward); uvs.Add(Vector2.zero); }
            }
            mesh.SetVertices(vertices);
            mesh.SetNormals(normals);
            mesh.SetUVs(0, uvs);
            mesh.subMeshCount = converted.Length;
            for (var i = 0; i < converted.Length; i++) mesh.SetTriangles(new[] { i * 3, i * 3 + 1, i * 3 + 2 }, i);
            mesh.RecalculateBounds();

            var go = new GameObject(CarrierName);
            go.transform.SetParent(root.transform, false);
            go.AddComponent<MeshFilter>().sharedMesh = mesh;
            go.AddComponent<MeshRenderer>().sharedMaterials = converted;
            foreach (var m in converted) names.Add(m != null ? m.name : "");
            return names;
        }

        public Material Convert(Material src)
        {
            if (src == null || _mtoon == null) return src;
            if (_cache.TryGetValue(src, out var dst)) return dst;
            dst = src;
            var shader = src.shader != null ? src.shader.name : "";
            try
            {
                if (shader.IndexOf("lilToon", StringComparison.OrdinalIgnoreCase) >= 0) { dst = FromLilToon(src, shader); _lilToon++; }
                else if (!KeepAsIs(shader)) { dst = FromGeneric(src, shader); _generic++; }
            }
            catch (Exception e)
            {
                _result.Warnings.Add($"머티리얼 변환 실패 ({src.name}): {e.Message}");
                dst = src;
            }
            _cache[src] = dst;
            return dst;
        }

        static bool KeepAsIs(string shader)
        {
            return shader.StartsWith("Standard", StringComparison.Ordinal) || shader.StartsWith("VRM10/", StringComparison.Ordinal)
                || shader.StartsWith("VRM/", StringComparison.Ordinal) || shader.StartsWith("UniGLTF/", StringComparison.Ordinal)
                || shader.StartsWith("Unlit/", StringComparison.Ordinal) || shader.StartsWith("Universal Render Pipeline/", StringComparison.Ordinal)
                || shader.StartsWith("Hidden/InternalErrorShader", StringComparison.Ordinal);
        }

        Material NewMToon(Material src)
        {
            var m = new Material(_mtoon) { name = src.name };
            _temporary.Add(m);
            return m;
        }

        static float F(Material m, string name, float fallback = 0f) => m.HasProperty(name) ? m.GetFloat(name) : fallback;
        static Color C(Material m, string name, Color fallback) => m.HasProperty(name) ? m.GetColor(name) : fallback;
        static Vector4 V(Material m, string name, Vector4 fallback) => m.HasProperty(name) ? m.GetVector(name) : fallback;
        static Texture T(Material m, string name) => m.HasProperty(name) ? m.GetTexture(name) : null;
        static Color Clamp(Color c) => new Color(Mathf.Clamp01(c.r), Mathf.Clamp01(c.g), Mathf.Clamp01(c.b), Mathf.Clamp01(c.a));

        Material FromLilToon(Material src, string shader)
        {
            var m = NewMToon(src);
            var ctx = new MToon10Context(m);

            bool cutout, transparent;
            if (shader.IndexOf("Multi", StringComparison.Ordinal) >= 0)
            {
                var mode = F(src, "_TransparentMode");
                cutout = Mathf.Approximately(mode, 1f);
                transparent = mode >= 2f;
            }
            else
            {
                cutout = shader.IndexOf("Cutout", StringComparison.Ordinal) >= 0;
                transparent = !cutout && (shader.IndexOf("Trans", StringComparison.Ordinal) >= 0 || shader.IndexOf("Overlay", StringComparison.Ordinal) >= 0
                    || shader.IndexOf("Fur", StringComparison.Ordinal) >= 0 || shader.IndexOf("Gem", StringComparison.Ordinal) >= 0
                    || shader.IndexOf("Refraction", StringComparison.Ordinal) >= 0);
            }
            ctx.AlphaMode = transparent ? MToon10AlphaMode.Transparent : cutout ? MToon10AlphaMode.Cutout : MToon10AlphaMode.Opaque;
            if (transparent && F(src, "_ZWrite") > 0.5f) ctx.TransparentWithZWriteMode = MToon10TransparentWithZWriteMode.On;
            ctx.AlphaCutoff = F(src, "_Cutoff", 0.5f);
            ctx.DoubleSidedMode = F(src, "_Cull", 2f) < 0.5f ? MToon10DoubleSidedMode.On : MToon10DoubleSidedMode.Off;

            // Main colour
            var color = C(src, "_Color", Color.white);
            var main = T(src, "_MainTex");
            var baked = BakeMain(src, main, cutout || transparent);
            ctx.BaseColorTexture = baked != null ? baked : main;
            ctx.BaseColorFactorSrgb = baked != null ? Color.white : Clamp(color);
            if (src.HasProperty("_MainTex"))
            {
                ctx.TextureScale = src.GetTextureScale("_MainTex");
                ctx.TextureOffset = src.GetTextureOffset("_MainTex");
            }

            // 1st shadow → shade colour; lilToon's border/blur (half-lambert 0..1) → MToon 1.0 toony/shift
            if (F(src, "_UseShadow") > 0.5f)
            {
                var strength = F(src, "_ShadowStrength", 1f);
                var sc = C(src, "_ShadowColor", new Color(0.82f, 0.76f, 0.85f, 1f));
                ctx.ShadeColorFactorSrgb = new Color(1f - (1f - sc.r) * strength, 1f - (1f - sc.g) * strength, 1f - (1f - sc.b) * strength, 1f);
                var shadowTex = T(src, "_ShadowColorTex");
                ctx.ShadeColorTexture = shadowTex != null ? shadowTex : ctx.BaseColorTexture;
                // A shadow strength mask (eyes, face, parts that must not darken) is baked into the shade texture.
                var strengthMask = T(src, "_ShadowStrengthMask");
                if (strengthMask != null && shadowTex == null && ctx.BaseColorTexture != null)
                {
                    var tint = ctx.BaseColorFactorSrgb;
                    var shadeTex = BakeShade(src, ctx.BaseColorTexture, strengthMask, ctx.ShadeColorFactorSrgb, tint);
                    if (shadeTex != null)
                    {
                        ctx.ShadeColorTexture = shadeTex;
                        ctx.ShadeColorFactorSrgb = Color.white;
                    }
                }
                var border = F(src, "_ShadowBorder", 0.5f);
                var blur = F(src, "_ShadowBlur", 0.1f);
                var lo = Mathf.Clamp01(border - blur * 0.5f) * 2f - 1f;
                var hi = Mathf.Clamp01(border + blur * 0.5f) * 2f - 1f;
                ctx.ShadingToonyFactor = Mathf.Clamp01(1f - (hi - lo) * 0.5f);
                ctx.ShadingShiftFactor = Mathf.Clamp(-(lo + hi) * 0.5f, -1f, 1f);
            }
            else
            {
                ctx.ShadeColorFactorSrgb = Color.white;
                ctx.ShadeColorTexture = ctx.BaseColorTexture;
                ctx.ShadingToonyFactor = 0.9f;
                ctx.ShadingShiftFactor = 0f;
            }
            ctx.GiEqualizationFactor = 0.9f;

            if (F(src, "_UseBumpMap") > 0.5f && T(src, "_BumpMap") != null)
            {
                ctx.NormalTexture = T(src, "_BumpMap");
                ctx.NormalTextureScale = F(src, "_BumpScale", 1f);
            }

            if (F(src, "_UseEmission") > 0.5f)
            {
                var ec = C(src, "_EmissionColor", Color.white);
                var map = T(src, "_EmissionMap") ?? T(src, "_EmissionBlendMask");
                var linear = ec.linear;
                ctx.EmissiveFactorLinear = new Color(linear.r * ec.a, linear.g * ec.a, linear.b * ec.a, 1f);
                ctx.EmissiveTexture = map;
            }

            ApplyMatcapAndRim(src, ctx);

            if (shader.IndexOf("Outline", StringComparison.Ordinal) >= 0 && F(src, "_OutlineWidth", 0.08f) > 0f)
            {
                ctx.OutlineWidthMode = MToon10OutlineMode.World;
                ctx.OutlineWidthFactor = F(src, "_OutlineWidth", 0.08f) * 0.01f;
                ctx.OutlineColorFactorSrgb = Clamp(C(src, "_OutlineColor", new Color(0.6f, 0.56f, 0.73f, 1f)));
                ctx.OutlineLightingMixFactor = 1f;
                ctx.OutlineWidthMultiplyTexture = T(src, "_OutlineWidthMask");
            }

            var scroll = V(src, "_MainTex_ScrollRotate", Vector4.zero);
            if (scroll != Vector4.zero)
            {
                ctx.UvAnimationScrollXSpeedFactor = scroll.x;
                ctx.UvAnimationScrollYSpeedFactor = scroll.y;
                ctx.UvAnimationRotationSpeedFactor = scroll.w / (Mathf.PI * 2f);
            }
            ctx.Validate();
            return m;
        }

        Material FromGeneric(Material src, string shader)
        {
            var m = NewMToon(src);
            var ctx = new MToon10Context(m);
            var main = T(src, "_MainTex") ?? T(src, "_BaseMap") ?? T(src, "_BaseColorMap");
            var color = src.HasProperty("_Color") ? src.GetColor("_Color") : C(src, "_BaseColor", Color.white);
            var cutout = src.IsKeywordEnabled("_ALPHATEST_ON") || shader.IndexOf("Cutout", StringComparison.OrdinalIgnoreCase) >= 0;
            var transparent = !cutout && (src.renderQueue >= 2900 || shader.IndexOf("Transparent", StringComparison.OrdinalIgnoreCase) >= 0);
            ctx.AlphaMode = transparent ? MToon10AlphaMode.Transparent : cutout ? MToon10AlphaMode.Cutout : MToon10AlphaMode.Opaque;
            ctx.AlphaCutoff = F(src, "_Cutoff", 0.5f);
            var cull = src.HasProperty("_Cull") ? src.GetFloat("_Cull") : F(src, "_CullMode", 2f);
            ctx.DoubleSidedMode = cull < 0.5f ? MToon10DoubleSidedMode.On : MToon10DoubleSidedMode.Off;
            ctx.BaseColorFactorSrgb = Clamp(color);
            ctx.BaseColorTexture = main;
            ctx.ShadeColorFactorSrgb = new Color(0.85f, 0.85f, 0.88f, 1f);
            ctx.ShadeColorTexture = main;
            ctx.ShadingToonyFactor = 0.9f;
            ctx.GiEqualizationFactor = 0.9f;
            if (main != null)
            {
                var name = src.HasProperty("_MainTex") ? "_MainTex" : "_BaseMap";
                if (src.HasProperty(name))
                {
                    ctx.TextureScale = src.GetTextureScale(name);
                    ctx.TextureOffset = src.GetTextureOffset(name);
                }
            }
            ctx.Validate();
            return m;
        }

        /// <summary>
        /// lilToon colour adjustments (HSVG, gradation, main colour) and 2nd/3rd textures are baked with lilToon's
        /// own baker shader; an alpha mask is applied to the alpha channel. Null when the main texture can be used as is.
        /// </summary>
        Texture2D BakeMain(Material src, Texture main, bool usesAlpha)
        {
            if (main == null) return null;
            var hsvg = V(src, "_MainTexHSVG", new Vector4(0, 1, 1, 1));
            var adjust = hsvg != new Vector4(0, 1, 1, 1) || F(src, "_MainGradationStrength") != 0f;
            var use2nd = F(src, "_UseMain2ndTex") > 0.5f && T(src, "_Main2ndTex") != null;
            var use3rd = F(src, "_UseMain3rdTex") > 0.5f && T(src, "_Main3rdTex") != null;
            var alphaMode = usesAlpha ? Mathf.RoundToInt(F(src, "_AlphaMaskMode")) : 0;
            var alphaMask = alphaMode != 0 ? T(src, "_AlphaMask") : null;
            if (!adjust && !use2nd && !use3rd && alphaMask == null) return null;

            var width = Mathf.Min(main.width, 2048);
            var height = Mathf.Min(main.height, 2048);
            var rt = RenderTexture.GetTemporary(width, height, 0, RenderTextureFormat.ARGB32, RenderTextureReadWrite.sRGB);
            var previous = RenderTexture.active;
            Material baker = null;
            try
            {
                if ((adjust || use2nd || use3rd) && _lilBaker != null)
                {
                    baker = new Material(_lilBaker);
                    baker.CopyPropertiesFromMaterial(src);
                    if (!use2nd) baker.SetFloat("_UseMain2ndTex", 0f);
                    if (!use3rd) baker.SetFloat("_UseMain3rdTex", 0f);
                    Graphics.Blit(main, rt, baker);
                }
                else
                {
                    Graphics.Blit(main, rt);
                }
                var tex = new Texture2D(width, height, TextureFormat.RGBA32, true, false) { name = src.name + "_baked" };
                _temporary.Add(tex);
                RenderTexture.active = rt;
                tex.ReadPixels(new Rect(0, 0, width, height), 0, 0);
                tex.Apply();
                if (alphaMask != null) ApplyAlphaMask(src, tex, alphaMask, alphaMode);
                if (baker == null && src.HasProperty("_Color"))
                {
                    // The colour was not baked: multiply it in so BaseColorFactor can stay white.
                    var c = src.GetColor("_Color");
                    if (c != Color.white)
                    {
                        var px = tex.GetPixels32();
                        for (var i = 0; i < px.Length; i++)
                        {
                            px[i] = new Color32((byte)(px[i].r * Mathf.Clamp01(c.r)), (byte)(px[i].g * Mathf.Clamp01(c.g)), (byte)(px[i].b * Mathf.Clamp01(c.b)), (byte)(px[i].a * Mathf.Clamp01(c.a)));
                        }
                        tex.SetPixels32(px);
                        tex.Apply();
                    }
                }
                return tex;
            }
            finally
            {
                RenderTexture.active = previous;
                RenderTexture.ReleaseTemporary(rt);
                if (baker != null) Object.DestroyImmediate(baker);
            }
        }

        sealed class Additive
        {
            public Texture Texture, Mask;
            public Color Factor;
            public float Lighting, Score;
        }

        /// <summary>
        /// MToon draws (MatCap + rim) × one mask (rimMultiplyTexture); lilToon has two MatCaps and a rim, each
        /// with its own mask. The stronger MatCap goes into MToon's slot. When the MatCap's and the rim's masks
        /// differ, only the one adding more light (coverage × strength, measured from the textures) is kept:
        /// otherwise a small masked MatCap (a dark blazer's gold buttons) would cover the whole surface, or a
        /// rim over the whole jacket would be cut down to a small mask. MToon's MatCap is additive: lilToon add /
        /// screen map directly, normal blend at half strength (multiply is skipped).
        /// </summary>
        void ApplyMatcapAndRim(Material src, MToon10Context ctx)
        {
            Additive matcap = null;
            foreach (var suffix in new[] { "", "2nd" })
            {
                var tex = T(src, "_MatCap" + suffix + "Tex");
                if (F(src, "_UseMatCap" + suffix) < 0.5f || tex == null) continue;
                var mode = F(src, "_MatCap" + suffix + "BlendMode", 1f);
                if (Mathf.Approximately(mode, 3f)) continue;
                var mc = C(src, "_MatCap" + suffix + "Color", Color.white);
                var k = Mathf.Clamp01(F(src, "_MatCap" + suffix + "Blend", 1f) * mc.a) * (mode < 0.5f ? 0.5f : 1f);
                var a = new Additive
                {
                    Texture = tex,
                    Mask = T(src, "_MatCap" + suffix + "BlendMask"),
                    Factor = new Color(Mathf.Clamp01(mc.r * k), Mathf.Clamp01(mc.g * k), Mathf.Clamp01(mc.b * k), 1f),
                    Lighting = F(src, "_MatCap" + suffix + "EnableLighting", 1f),
                };
                a.Score = Luminance(a.Factor) * MeanLuminance(tex) * (a.Mask != null ? MeanLuminance(a.Mask) : 1f);
                if (matcap == null || a.Score > matcap.Score) matcap = a;
            }

            Additive rim = null;
            if (F(src, "_UseRim") > 0.5f)
            {
                var rc = C(src, "_RimColor", new Color(0.66f, 0.5f, 0.48f, 1f));
                rim = new Additive
                {
                    Mask = T(src, "_RimColorTex"),
                    Factor = new Color(Mathf.Clamp01(rc.r * rc.a), Mathf.Clamp01(rc.g * rc.a), Mathf.Clamp01(rc.b * rc.a), 1f),
                    Lighting = F(src, "_RimEnableLighting", 1f),
                };
                // A rim lights roughly the outer third of the silhouette.
                rim.Score = Luminance(rim.Factor) * 0.3f * (rim.Mask != null ? MeanLuminance(rim.Mask) : 1f);
            }

            if (matcap != null && rim != null && matcap.Mask != rim.Mask)
            {
                if (rim.Score >= matcap.Score) { matcap = null; _droppedMatcaps++; }
                else { rim = null; _droppedRims++; }
            }

            if (matcap != null)
            {
                ctx.MatcapTexture = matcap.Texture;
                ctx.MatcapColorFactorSrgb = matcap.Factor;
            }
            if (rim != null)
            {
                ctx.ParametricRimColorFactorSrgb = rim.Factor;
                var power = F(src, "_RimFresnelPower", 3.5f);
                var blur = F(src, "_RimBlur", 0.65f);
                ctx.ParametricRimFresnelPowerFactor = power / Mathf.Max(0.001f, blur);
                ctx.ParametricRimLiftFactor = Mathf.Pow(1f - F(src, "_RimBorder", 0.5f), power) * (1f - blur);
            }
            else
            {
                ctx.ParametricRimColorFactorSrgb = Color.black;
            }
            var kept = matcap ?? rim;
            ctx.RimMultiplyTexture = kept?.Mask;
            ctx.RimLightingMixFactor = kept != null ? kept.Lighting : 1f;
        }

        static float Luminance(Color c) => 0.2126f * c.r + 0.7152f * c.g + 0.0722f * c.b;

        readonly Dictionary<Texture, float> _meanLuminance = new Dictionary<Texture, float>();

        /// <summary>Average brightness (0..1) of a texture, measured on a 32×32 copy.</summary>
        float MeanLuminance(Texture tex)
        {
            if (tex == null) return 1f;
            if (_meanLuminance.TryGetValue(tex, out var v)) return v;
            v = 1f;
            try
            {
                var small = Read(tex, 32, 32, true);
                var px = small.GetPixels();
                Object.DestroyImmediate(small);
                var sum = 0f;
                foreach (var p in px) sum += Luminance(p);
                v = px.Length > 0 ? sum / px.Length : 1f;
            }
            catch (Exception)
            {
                // keep 1: treat as unmasked
            }
            _meanLuminance[tex] = v;
            return v;
        }

        /// <summary>Texture pixels through the GPU (works for compressed / non-readable textures), at most maxSize.</summary>
        static Texture2D Read(Texture tex, int width, int height, bool linear)
        {
            var rt = RenderTexture.GetTemporary(width, height, 0, RenderTextureFormat.ARGB32, linear ? RenderTextureReadWrite.Linear : RenderTextureReadWrite.sRGB);
            var previous = RenderTexture.active;
            var result = new Texture2D(width, height, TextureFormat.RGBA32, false, linear);
            try
            {
                Graphics.Blit(tex, rt);
                RenderTexture.active = rt;
                result.ReadPixels(new Rect(0, 0, width, height), 0, 0);
                result.Apply();
            }
            finally
            {
                RenderTexture.active = previous;
                RenderTexture.ReleaseTemporary(rt);
            }
            return result;
        }

        /// <summary>
        /// Shade texture = base × tint × lerp(1, shade colour, strength mask): lilToon darkens only where the
        /// _ShadowStrengthMask allows it. 1024 px at most (shading is low frequency).
        /// </summary>
        Texture2D BakeShade(Material src, Texture baseTex, Texture mask, Color shade, Color tint)
        {
            try
            {
                var width = Mathf.Min(1024, baseTex.width);
                var height = Mathf.Min(1024, baseTex.height);
                var colour = Read(baseTex, width, height, false);
                var weights = Read(mask, width, height, true);
                var px = colour.GetPixels32();
                var mk = weights.GetPixels32();
                Object.DestroyImmediate(weights);
                for (var i = 0; i < px.Length; i++)
                {
                    var m = mk[i].r / 255f;
                    px[i].r = (byte)Mathf.RoundToInt(px[i].r * Mathf.Clamp01(tint.r) * Mathf.Lerp(1f, shade.r, m));
                    px[i].g = (byte)Mathf.RoundToInt(px[i].g * Mathf.Clamp01(tint.g) * Mathf.Lerp(1f, shade.g, m));
                    px[i].b = (byte)Mathf.RoundToInt(px[i].b * Mathf.Clamp01(tint.b) * Mathf.Lerp(1f, shade.b, m));
                }
                colour.SetPixels32(px);
                colour.Apply(true);
                colour.name = src.name + "_shade";
                _temporary.Add(colour);
                _bakedShades++;
                return colour;
            }
            catch (Exception e)
            {
                _result.Warnings.Add($"그림자 텍스처 굽기 실패 ({src.name}): {e.Message}");
                return null;
            }
        }

        /// <summary>lilToon alpha mask: value = mask.r × _AlphaMaskScale + _AlphaMaskValue; 1 replace, 2 multiply, 3 add, 4 subtract.</summary>
        static void ApplyAlphaMask(Material src, Texture2D tex, Texture mask, int mode)
        {
            var rt = RenderTexture.GetTemporary(tex.width, tex.height, 0, RenderTextureFormat.ARGB32, RenderTextureReadWrite.Linear);
            var previous = RenderTexture.active;
            var maskTex = new Texture2D(tex.width, tex.height, TextureFormat.RGBA32, false, true);
            try
            {
                Graphics.Blit(mask, rt);
                RenderTexture.active = rt;
                maskTex.ReadPixels(new Rect(0, 0, tex.width, tex.height), 0, 0);
                maskTex.Apply();
            }
            finally
            {
                RenderTexture.active = previous;
                RenderTexture.ReleaseTemporary(rt);
            }
            var scale = F(src, "_AlphaMaskScale", 1f);
            var value = F(src, "_AlphaMaskValue", 0f);
            var px = tex.GetPixels32();
            var mk = maskTex.GetPixels32();
            Object.DestroyImmediate(maskTex);
            for (var i = 0; i < px.Length; i++)
            {
                var a = px[i].a / 255f;
                var v = mk[i].r / 255f * scale + value;
                switch (mode)
                {
                    case 1: a = v; break;
                    case 2: a *= v; break;
                    case 3: a += v; break;
                    case 4: a -= v; break;
                }
                px[i].a = (byte)Mathf.RoundToInt(Mathf.Clamp01(a) * 255f);
            }
            tex.SetPixels32(px);
            tex.Apply();
        }
    }
}
