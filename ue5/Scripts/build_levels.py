"""Headless content step (UnrealEditor-Cmd -run=pythonscript -script=.../build_levels.py).

Creates what the C++ runtime loads by path. Everything else (sky, light, fog, arena, valley terrain,
foliage, characters) is built at runtime from the GameSpec, so this script stays small and deterministic:
  /Game/Ipverse/Materials/M_NeonGrid  emissive world-space grid with a radial pulse (arena floor)
  /Game/Ipverse/Materials/M_Glow      emissive Tint * Glow (neon strips, bolts, pickups, enemy cores)
  /Game/Ipverse/Materials/M_Surface   PBR Tint with world/instance variation (cover, trees, rocks)
  /Game/Ipverse/Materials/M_Terrain   vertex-colour biome * fine detail noise (valley terrain)
  /Game/Ipverse/Materials/M_Water     dark glossy water with animated wave normals
  /Game/Ipverse/Maps/Main             empty world; AIpverseGameMode fills it
Prints IPVERSE_LEVELS_OK at the end; build.sh greps for it.
"""
import unreal

MAT_DIR = "/Game/Ipverse/Materials"
MAP_DIR = "/Game/Ipverse/Maps"
assets = unreal.AssetToolsHelpers.get_asset_tools()
mel = unreal.MaterialEditingLibrary
eal = unreal.EditorAssetLibrary
P = unreal.MaterialProperty


def fresh(path):
    if eal.does_asset_exist(path):
        eal.delete_asset(path)


def new_material(name, instanced=False):
    fresh(f"{MAT_DIR}/{name}")
    mat = assets.create_asset(name, MAT_DIR, unreal.Material, unreal.MaterialFactoryNew())
    if instanced:
        mat.set_editor_property("used_with_instanced_static_meshes", True)
    return mat


def node(mat, cls, x, y):
    return mel.create_material_expression(mat, cls, x, y)


def const(mat, value, x, y):
    c = node(mat, unreal.MaterialExpressionConstant, x, y)
    c.set_editor_property("r", value)
    return c


def scalar(mat, name, value, x, y):
    s = node(mat, unreal.MaterialExpressionScalarParameter, x, y)
    s.set_editor_property("parameter_name", name)
    s.set_editor_property("default_value", value)
    return s


def vector(mat, name, rgb, x, y):
    v = node(mat, unreal.MaterialExpressionVectorParameter, x, y)
    v.set_editor_property("parameter_name", name)
    v.set_editor_property("default_value", unreal.LinearColor(rgb[0], rgb[1], rgb[2], 1.0))
    return v


def world_pos(mat, x, y):
    """Absolute world position as plain floats: Custom nodes cannot take large-world-coordinate inputs."""
    wp = node(mat, unreal.MaterialExpressionWorldPosition, x, y)
    if hasattr(unreal, "MaterialExpressionTruncateLWC"):
        trunc = node(mat, unreal.MaterialExpressionTruncateLWC, x + 150, y)
        mel.connect_material_expressions(wp, "", trunc, "")
        return trunc
    return wp


def custom(mat, code, inputs, x, y, out=unreal.CustomMaterialOutputType.CMOT_FLOAT3):
    """HLSL Custom node; inputs: [(name, expression)]."""
    c = node(mat, unreal.MaterialExpressionCustom, x, y)
    c.set_editor_property("code", code)
    c.set_editor_property("output_type", out)
    pins = []
    for name, _ in inputs:
        pin = unreal.CustomInput()
        pin.set_editor_property("input_name", name)
        pins.append(pin)
    c.set_editor_property("inputs", pins)
    for name, expr in inputs:
        ok = mel.connect_material_expressions(expr, "", c, name)
        if not ok:
            raise RuntimeError(f"connect {name} failed in {mat.get_name()}")
    return c


def wire(mat, expr, prop):
    if not mel.connect_material_property(expr, "", prop):
        raise RuntimeError(f"connect {prop} failed in {mat.get_name()}")


def finish(mat):
    mel.recompile_material(mat)
    eal.save_loaded_asset(mat)
    unreal.log(f"IPVERSE material {mat.get_path_name()}")


# ── M_Glow ────────────────────────────────────────────────────────────────────
m = new_material("M_Glow", instanced=True)
tint = vector(m, "Tint", (0.2, 0.8, 1.0), -600, 0)
glow = scalar(m, "Glow", 20.0, -600, 200)
wire(m, custom(m, "return Tint.rgb * 0.15;", [("Tint", tint)], -300, -100), P.MP_BASE_COLOR)
wire(m, custom(m, "return Tint.rgb * Glow;", [("Tint", tint), ("Glow", glow)], -300, 100), P.MP_EMISSIVE_COLOR)
wire(m, const(m, 0.35, -300, 300), P.MP_ROUGHNESS)
finish(m)

# ── M_Surface ─────────────────────────────────────────────────────────────────
m = new_material("M_Surface", instanced=True)
tint = vector(m, "Tint", (0.5, 0.5, 0.5), -700, 0)
wp = world_pos(m, -700, 200)
rnd = node(m, unreal.MaterialExpressionPerInstanceRandom, -700, 350)
wire(m, custom(m, """
float3 c = floor(WP / 37.0);
float n = frac(sin(dot(c, float3(12.9898, 78.233, 37.719))) * 43758.5453);
float3 f = floor(WP / 211.0);
float m = frac(sin(dot(f, float3(39.346, 11.135, 83.155))) * 24634.6345);
return Tint.rgb * (0.86 + 0.18 * n) * (0.85 + 0.3 * Rand) * (0.92 + 0.16 * m);
""", [("Tint", tint), ("WP", wp), ("Rand", rnd)], -350, 0), P.MP_BASE_COLOR)
wire(m, scalar(m, "Roughness", 0.6, -350, 250), P.MP_ROUGHNESS)
wire(m, scalar(m, "Metallic", 0.0, -350, 380), P.MP_METALLIC)
finish(m)

# ── M_NeonGrid ────────────────────────────────────────────────────────────────
m = new_material("M_NeonGrid")
tint = vector(m, "Tint", (0.2, 0.8, 1.0), -800, 0)
glow = scalar(m, "Glow", 6.0, -800, 150)
wp = world_pos(m, -800, 300)
t = node(m, unreal.MaterialExpressionTime, -800, 450)
wire(m, custom(m, """
float2 cell = floor(WP.xy / 400.0);
float n = frac(sin(dot(cell, float2(12.9898, 78.233))) * 43758.5453);
return lerp(float3(0.010, 0.012, 0.020), float3(0.025, 0.030, 0.045), n);
""", [("WP", wp)], -400, -150), P.MP_BASE_COLOR)
wire(m, custom(m, """
float2 p = WP.xy / 400.0;
float2 g = abs(frac(p - 0.5) - 0.5) / max(fwidth(p), 1e-4);
float minor = 1.0 - min(min(g.x, g.y), 1.0);
float2 q = WP.xy / 2000.0;
float2 gq = abs(frac(q - 0.5) - 0.5) / max(fwidth(q), 1e-4);
float major = 1.0 - min(min(gq.x, gq.y), 1.0);
float r = length(WP.xy);
float pulse = 0.5 + 0.5 * sin(r / 280.0 - Time * 2.2);
float ring = smoothstep(0.92, 1.0, pulse);
return Tint.rgb * Glow * (minor * 0.55 + major * 1.6) * (0.55 + 0.45 * pulse) + Tint.rgb * ring * minor * Glow * 1.5;
""", [("WP", wp), ("Tint", tint), ("Glow", glow), ("Time", t)], -400, 100), P.MP_EMISSIVE_COLOR)
wire(m, const(m, 0.22, -400, 350), P.MP_ROUGHNESS)
wire(m, const(m, 0.6, -400, 450), P.MP_METALLIC)
finish(m)

# ── M_Terrain ─────────────────────────────────────────────────────────────────
m = new_material("M_Terrain")
vc = node(m, unreal.MaterialExpressionVertexColor, -700, 0)
wp = world_pos(m, -700, 200)
wire(m, custom(m, """
float3 c = floor(WP / 23.0);
float n = frac(sin(dot(c, float3(12.9898, 78.233, 37.719))) * 43758.5453);
float3 f = floor(WP / 97.0);
float k = frac(sin(dot(f, float3(39.346, 11.135, 83.155))) * 24634.6345);
return VC.rgb * (0.88 + 0.16 * n) * (0.9 + 0.2 * k);
""", [("VC", vc), ("WP", wp)], -350, 0), P.MP_BASE_COLOR)
wire(m, const(m, 0.88, -350, 250), P.MP_ROUGHNESS)
finish(m)

# ── M_Water ───────────────────────────────────────────────────────────────────
m = new_material("M_Water")
wp = world_pos(m, -800, 0)
t = node(m, unreal.MaterialExpressionTime, -800, 200)
wire(m, custom(m, "return float3(0.006, 0.035, 0.05);", [], -400, -150), P.MP_BASE_COLOR)
wire(m, custom(m, """
float2 p = WP.xy;
float2 d1 = normalize(float2(1.0, 0.3));
float2 d2 = normalize(float2(-0.4, 1.0));
float2 d3 = normalize(float2(0.7, -0.8));
float s1 = cos(dot(p, d1) * 0.011 + Time * 1.2);
float s2 = cos(dot(p, d2) * 0.023 + Time * 1.9);
float s3 = cos(dot(p, d3) * 0.051 + Time * 2.6);
float2 g = d1 * s1 * 0.10 + d2 * s2 * 0.07 + d3 * s3 * 0.04;
return normalize(float3(-g.x, -g.y, 1.0));
""", [("WP", wp), ("Time", t)], -400, 100), P.MP_NORMAL)
wire(m, const(m, 0.04, -400, 300), P.MP_ROUGHNESS)
wire(m, const(m, 0.9, -400, 400), P.MP_SPECULAR)
finish(m)

# ── Main map ──────────────────────────────────────────────────────────────────
fresh(f"{MAP_DIR}/Main")
world = assets.create_asset("Main", MAP_DIR, unreal.World, unreal.WorldFactory())
if world is None:
    raise RuntimeError("could not create /Game/Ipverse/Maps/Main")
eal.save_loaded_asset(world)

missing = [p for p in [f"{MAT_DIR}/{n}" for n in ("M_Glow", "M_Surface", "M_NeonGrid", "M_Terrain", "M_Water")] + [f"{MAP_DIR}/Main"]
           if not eal.does_asset_exist(p)]
if missing:
    raise RuntimeError(f"missing after build: {missing}")
unreal.log("IPVERSE_LEVELS_OK")
