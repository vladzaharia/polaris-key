// GENERATED FILE — do not edit by hand.
//
// Written by `pnpm --filter @polaris-key/brand gen` (packages/brand/scripts/gen.ts) from
// packages/brand/src/tokens/ and the launch kit copy in packages/brand/kit/.
// `pnpm gen:brand -- --check` fails the green gate on any difference. To change a value, edit
// its source and regenerate.

#nullable enable

using System.Collections.Generic;

namespace PolarisKey.Brand
{
    /// <summary>An sRGB brand colour; <c>Hex</c> is 0xRRGGBB.</summary>
    public readonly struct BrandColor
    {
        public readonly uint Hex;

        public BrandColor(uint hex) { Hex = hex; }

        public float R => ((Hex >> 16) & 0xFF) / 255f;
        public float G => ((Hex >> 8) & 0xFF) / 255f;
        public float B => (Hex & 0xFF) / 255f;

        public override string ToString() => "#" + Hex.ToString("x6");
#if GODOT
        public Godot.Color ToColor(float alpha = 1f) => new Godot.Color(R, G, B, alpha);
#endif
    }

    /// <summary>One section's accent in one theme.</summary>
    public readonly struct BrandAccent
    {
        public readonly BrandColor Solid, Fg, On, Subtle;

        public BrandAccent(BrandColor solid, BrandColor fg, BrandColor on, BrandColor subtle)
        {
            Solid = solid; Fg = fg; On = on; Subtle = subtle;
        }
    }

    /// <summary>One role of the type scale (px at 720p; letter spacing in em).</summary>
    public readonly struct KitTypeRole
    {
        public readonly float Size, LineHeight, Tracking;
        public readonly int Weight;
        public readonly bool Mono;

        public KitTypeRole(float size, float lineHeight, int weight, float tracking, bool mono)
        {
            Size = size; LineHeight = lineHeight; Weight = weight; Tracking = tracking; Mono = mono;
        }
    }

    /// <summary>
    /// Polaris Key brand and kit tokens for the Godot .NET facade (the C# twin of PKeyBrand and
    /// PKeyKitTokens; docs/design/UI-KITS.md §2.1). Dark is the default scheme.
    /// </summary>
    public static class PKeyBrand
    {
        public static class Dark
        {
            public static readonly BrandColor SurfacePage = new BrandColor(0x060912);
            public static readonly BrandColor SurfaceRaised = new BrandColor(0x0D111B);
            public static readonly BrandColor SurfaceOverlay = new BrandColor(0x121722);
            public static readonly BrandColor SurfaceSunken = new BrandColor(0x020408);
            public static readonly BrandColor TextStrong = new BrandColor(0xFFFFFF);
            public static readonly BrandColor TextDefault = new BrandColor(0xDBE4FF);
            public static readonly BrandColor TextMuted = new BrandColor(0xB5BED3);
            public static readonly BrandColor TextSubtle = new BrandColor(0x969EB2);
            public static readonly BrandColor TextOnAccent = new BrandColor(0x060912);
            public static readonly BrandColor BorderSubtle = new BrandColor(0x212633);
            public static readonly BrandColor BorderStrong = new BrandColor(0x61697B);
            public static readonly BrandColor Focus = new BrandColor(0x9A5CFF);
            public static readonly BrandColor Success = new BrandColor(0x56D57B);
            public static readonly BrandColor SuccessOn = new BrandColor(0x060912);
            public static readonly BrandColor SuccessBorder = new BrandColor(0x3B9555);
            public static readonly BrandColor SuccessSubtle = new BrandColor(0x10211F);
            public static readonly BrandColor Warning = new BrandColor(0xC38D18);
            public static readonly BrandColor WarningOn = new BrandColor(0x060912);
            public static readonly BrandColor WarningBorder = new BrandColor(0x896100);
            public static readonly BrandColor WarningSubtle = new BrandColor(0x1D1913);
            public static readonly BrandColor Danger = new BrandColor(0xF2513F);
            public static readonly BrandColor DangerOn = new BrandColor(0x060912);
            public static readonly BrandColor DangerBorder = new BrandColor(0xC83B2C);
            public static readonly BrandColor DangerSubtle = new BrandColor(0x221217);
            public static readonly BrandColor Info = new BrandColor(0xB688FE);
            public static readonly BrandColor InfoOn = new BrandColor(0x060912);
            public static readonly BrandColor InfoBorder = new BrandColor(0x8F54DC);
            public static readonly BrandColor InfoSubtle = new BrandColor(0x1B182E);
            public static readonly BrandColor Signed = new BrandColor(0xFFC24D);
            public static readonly BrandColor SignedOn = new BrandColor(0x060912);
            public static readonly BrandColor SignedBorder = new BrandColor(0xBA882E);
            public static readonly BrandColor SignedSubtle = new BrandColor(0x241F19);
            public static readonly BrandColor SignedMark = new BrandColor(0xFFC24D);
            public static readonly BrandColor BrandViolet = new BrandColor(0x9A5CFF);
            public static readonly BrandColor BrandGold = new BrandColor(0xFFC24D);
            public static readonly BrandColor DangerSolid = new BrandColor(0xDB3A2B);
            public static readonly BrandColor DangerSolidOn = new BrandColor(0xFFFFFF);
            public static readonly BrandColor ScrimColor = new BrandColor(0x020408);
        }

        public static class Light
        {
            public static readonly BrandColor SurfacePage = new BrandColor(0xF6F8FF);
            public static readonly BrandColor SurfaceRaised = new BrandColor(0xFFFFFF);
            public static readonly BrandColor SurfaceOverlay = new BrandColor(0xFFFFFF);
            public static readonly BrandColor SurfaceSunken = new BrandColor(0xEBEEF8);
            public static readonly BrandColor TextStrong = new BrandColor(0x060912);
            public static readonly BrandColor TextDefault = new BrandColor(0x262D40);
            public static readonly BrandColor TextMuted = new BrandColor(0x48536B);
            public static readonly BrandColor TextSubtle = new BrandColor(0x5D667B);
            public static readonly BrandColor TextOnAccent = new BrandColor(0xFFFFFF);
            public static readonly BrandColor BorderSubtle = new BrandColor(0xDADEE9);
            public static readonly BrandColor BorderStrong = new BrandColor(0x7E8699);
            public static readonly BrandColor Focus = new BrandColor(0x7A2FFF);
            public static readonly BrandColor Success = new BrandColor(0x167337);
            public static readonly BrandColor SuccessOn = new BrandColor(0xFFFFFF);
            public static readonly BrandColor SuccessBorder = new BrandColor(0x348F4F);
            public static readonly BrandColor SuccessSubtle = new BrandColor(0xE0EBEB);
            public static readonly BrandColor Warning = new BrandColor(0x814D00);
            public static readonly BrandColor WarningOn = new BrandColor(0xFFFFFF);
            public static readonly BrandColor WarningBorder = new BrandColor(0x9D6726);
            public static readonly BrandColor WarningSubtle = new BrandColor(0xEAE7E6);
            public static readonly BrandColor Danger = new BrandColor(0xBE2323);
            public static readonly BrandColor DangerOn = new BrandColor(0xFFFFFF);
            public static readonly BrandColor DangerBorder = new BrandColor(0xDB423C);
            public static readonly BrandColor DangerSubtle = new BrandColor(0xF0E3E9);
            public static readonly BrandColor Info = new BrandColor(0x7A2FFF);
            public static readonly BrandColor InfoOn = new BrandColor(0xFFFFFF);
            public static readonly BrandColor InfoBorder = new BrandColor(0x8E66F1);
            public static readonly BrandColor InfoSubtle = new BrandColor(0xEAE4FF);
            public static readonly BrandColor Signed = new BrandColor(0xC47300);
            public static readonly BrandColor SignedOn = new BrandColor(0x060912);
            public static readonly BrandColor SignedBorder = new BrandColor(0xBF7101);
            public static readonly BrandColor SignedSubtle = new BrandColor(0xF1EBE6);
            public static readonly BrandColor SignedMark = new BrandColor(0xD07A00);
            public static readonly BrandColor BrandViolet = new BrandColor(0x7A2FFF);
            public static readonly BrandColor BrandGold = new BrandColor(0xD07A00);
            public static readonly BrandColor DangerSolid = new BrandColor(0xBE2323);
            public static readonly BrandColor DangerSolidOn = new BrandColor(0xFFFFFF);
            public static readonly BrandColor ScrimColor = new BrandColor(0x060912);
        }

        private static readonly Dictionary<string, BrandAccent> AccentsDark = new Dictionary<string, BrandAccent>
        {
            ["core"] = new BrandAccent(new BrandColor(0x9A5CFF), new BrandColor(0x9A5CFF), new BrandColor(0x060912), new BrandColor(0x18132E)),
            ["license"] = new BrandAccent(new BrandColor(0xC6E940), new BrandColor(0xC6E940), new BrandColor(0x060912), new BrandColor(0x1D2418)),
            ["config"] = new BrandAccent(new BrandColor(0xFAC700), new BrandColor(0xFAC700), new BrandColor(0x060912), new BrandColor(0x232010)),
            ["release"] = new BrandAccent(new BrandColor(0x00DBFD), new BrandColor(0x00DBFD), new BrandColor(0x060912), new BrandColor(0x05222E)),
            ["distribution"] = new BrandAccent(new BrandColor(0x39D075), new BrandColor(0x39D075), new BrandColor(0x060912), new BrandColor(0x0C211E)),
            ["update"] = new BrandAccent(new BrandColor(0xFE8001), new BrandColor(0xFE8001), new BrandColor(0x060912), new BrandColor(0x241710)),
            ["identity"] = new BrandAccent(new BrandColor(0xD77DF2), new BrandColor(0xD77DF2), new BrandColor(0x060912), new BrandColor(0x1F172D)),
            ["sync"] = new BrandAccent(new BrandColor(0x14F8E1), new BrandColor(0x14F8E1), new BrandColor(0x060912), new BrandColor(0x08262B)),
        };

        private static readonly Dictionary<string, BrandAccent> AccentsLight = new Dictionary<string, BrandAccent>
        {
            ["core"] = new BrandAccent(new BrandColor(0x7A2FFF), new BrandColor(0x7A2FFF), new BrandColor(0xFFFFFF), new BrandColor(0xEAE4FF)),
            ["license"] = new BrandAccent(new BrandColor(0x708D00), new BrandColor(0x556E00), new BrandColor(0x060912), new BrandColor(0xE9EDE6)),
            ["config"] = new BrandAccent(new BrandColor(0x8B6902), new BrandColor(0x866500), new BrandColor(0xFFFFFF), new BrandColor(0xEBEAE6)),
            ["release"] = new BrandAccent(new BrandColor(0x0390A6), new BrandColor(0x007487), new BrandColor(0x060912), new BrandColor(0xDEEEF6)),
            ["distribution"] = new BrandAccent(new BrandColor(0x05773B), new BrandColor(0x05773B), new BrandColor(0xFFFFFF), new BrandColor(0xDEEBEB)),
            ["update"] = new BrandAccent(new BrandColor(0xB95800), new BrandColor(0xAA5000), new BrandColor(0xFFFFFF), new BrandColor(0xF0E8E6)),
            ["identity"] = new BrandAccent(new BrandColor(0x9E34AE), new BrandColor(0x9E34AE), new BrandColor(0xFFFFFF), new BrandColor(0xEDE4F7)),
            ["sync"] = new BrandAccent(new BrandColor(0x086260), new BrandColor(0x086260), new BrandColor(0xFFFFFF), new BrandColor(0xDEE9EF)),
        };

        /// <summary>A section's accent; unknown ids answer core.</summary>
        public static BrandAccent ServiceAccent(string service, bool dark = true)
        {
            var table = dark ? AccentsDark : AccentsLight;
            return table.TryGetValue(service, out var accent) ? accent : table["core"];
        }
    }

    /// <summary>The Godot kit's component tokens, type scale and motion (px at 720p, ms).</summary>
    public static class PKeyKitTokens
    {
        /// <summary>A radius meaning "fully rounded" (half the control's height).</summary>
        public const float Capsule = -1f;
        public const float ConcentricMin = 8f;

        public const float ControlHeight = 60f;
        public const float RadiusControl = 16f;
        public const float RadiusPanel = 28f;
        public const float CardPad = 44f;
        public const bool FocusSystem = false;
        public const float FocusWidth = 3f;
        public const float FocusOffset = 2f;
        public const float FocusInner = 0f;
        public const float FocusGlow = 8f;
        public const bool HasScrim = true;
        public const float ScrimDarkOpacity = 0.42f;
        public const float ScrimDarkBlur = 0f;
        public const float ScrimLightOpacity = 0.2f;
        public const float ScrimLightBlur = 0f;

        public static readonly KitTypeRole Display = new KitTypeRole(36f, 44f, 600, 0f, false);
        public static readonly KitTypeRole Title = new KitTypeRole(32f, 40f, 600, 0f, false);
        public static readonly KitTypeRole Body = new KitTypeRole(18f, 26f, 400, 0f, false);
        public static readonly KitTypeRole Label = new KitTypeRole(19f, 26f, 500, 0f, false);
        public static readonly KitTypeRole Button = new KitTypeRole(19f, 26f, 500, 0f, false);
        public static readonly KitTypeRole Meta = new KitTypeRole(16f, 22f, 400, 0f, false);
        public static readonly KitTypeRole Footnote = new KitTypeRole(16f, 22f, 400, 0f, false);
        public static readonly KitTypeRole Code = new KitTypeRole(52f, 60f, 600, 0.06f, true);

        public const int MotionStepMs = 220;
        public const int MotionSheetInMs = 280;
        public const int MotionSheetOutMs = 160;
        public const int MotionPressMs = 120;
        public const int MotionProgressMs = 200;
        public const int MotionWaitingMs = 0;
        public const int MotionSuccessMs = 320;

        public static float ConcentricRadius(float outer, float inset) => System.Math.Max(ConcentricMin, outer - inset);
    }
}
