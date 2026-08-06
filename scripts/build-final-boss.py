#!/usr/bin/env python3
"""Build the skinned final-boss GLB from the verified bosstiu Mixamo files."""
from __future__ import annotations

import bpy
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "bosstiu"
TEXTURED = ROOT / "output" / "boss_textured.glb"
TEXTURE = ROOT / "output" / "textures" / "boss_basecolor.png"
OUT_DIR = ROOT / "public" / "assets" / "final-boss"
OUT_GLB = OUT_DIR / "final-boss.glb"
OUT_MANIFEST = OUT_DIR / "manifest.json"

CLIPS = {
    "idle": ("Walking.fbx", True, 0.16, None),
    "walk": ("Walking.fbx", True, 1.0, None),
    "swagger": ("Swagger Walk.fbx", False, 1.0, None),
    "stomp": ("Stomp.fbx", False, 1.0, 0.62),
    "throw": ("Throw Object.fbx", False, 1.35, 0.68),
    "swat": ("Swatting Bugs.fbx", False, 1.5, 0.48),
    "death": ("Two Handed Sword Death.fbx", False, 0.4, None),
}


def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def imported_armature():
    return next((o for o in bpy.context.scene.objects if o.type == "ARMATURE"), None)


def imported_mesh():
    return next((o for o in bpy.context.scene.objects if o.type == "MESH"), None)


def active_action(arm):
    return arm.animation_data.action if arm and arm.animation_data else None


def strip_root_motion(action):
    if not action:
        return
    # Mixamo movement must be driven by gameplay. Keep vertical motion for stomp/death.
    for curve in getattr(action, "fcurves", []):
        if 'pose.bones["mixamorig:Hips"].location' not in curve.data_path:
            continue
        if curve.array_index not in (0, 2):
            continue
        base = curve.keyframe_points[0].co.y if curve.keyframe_points else 0.0
        for key in curve.keyframe_points:
            key.co.y = base
            key.handle_left.y = base
            key.handle_right.y = base


def copy_baked_uv_and_material(target):
    before = set(bpy.context.scene.objects)
    bpy.ops.import_scene.gltf(filepath=str(TEXTURED))
    added = [o for o in bpy.context.scene.objects if o not in before]
    source = next((o for o in added if o.type == "MESH"), None)
    if not source or len(source.data.loops) != len(target.data.loops):
        raise RuntimeError("Textured GLB topology does not match T-Pose loop count")
    source_uv = source.data.uv_layers.active
    if not source_uv:
        raise RuntimeError("Textured GLB has no UV layer")
    while target.data.uv_layers:
        target.data.uv_layers.remove(target.data.uv_layers[0])
    target_uv = target.data.uv_layers.new(name="BossUV")
    for index in range(len(target.data.loops)):
        target_uv.data[index].uv = source_uv.data[index].uv

    image = bpy.data.images.load(str(TEXTURE), check_existing=True)
    image.pack()
    material = bpy.data.materials.new("FinalBoss_Photo")
    material.use_nodes = True
    nodes = material.node_tree.nodes
    links = material.node_tree.links
    bsdf = next(node for node in nodes if node.type == "BSDF_PRINCIPLED")
    tex = nodes.new("ShaderNodeTexImage")
    tex.image = image
    tex.interpolation = "Linear"
    links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
    bsdf.inputs["Roughness"].default_value = 0.68
    target.data.materials.clear()
    target.data.materials.append(material)
    for obj in added:
        bpy.data.objects.remove(obj, do_unlink=True)


def import_clip(logical, filename, base_arm):
    before_objects = set(bpy.context.scene.objects)
    before_actions = set(bpy.data.actions)
    bpy.ops.import_scene.fbx(filepath=str(SOURCE / filename), use_anim=True)
    added_objects = [o for o in bpy.context.scene.objects if o not in before_objects]
    arm = next((o for o in added_objects if o.type == "ARMATURE"), None)
    action = active_action(arm) or next((a for a in bpy.data.actions if a not in before_actions), None)
    if not action:
        raise RuntimeError(f"No action in {filename}")
    action.name = logical
    action.use_fake_user = True
    strip_root_motion(action)
    for obj in added_objects:
        bpy.data.objects.remove(obj, do_unlink=True)
    return action


def main():
    for path in [SOURCE / v[0] for v in CLIPS.values()] + [TEXTURED, TEXTURE]:
        if not path.is_file():
            raise FileNotFoundError(path)
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    reset()
    bpy.ops.import_scene.fbx(filepath=str(SOURCE / "T-Pose.fbx"), use_anim=True)
    arm = imported_armature()
    mesh = imported_mesh()
    if not arm or not mesh or len(arm.data.bones) != 41:
        raise RuntimeError("T-Pose must contain one skinned mesh and the verified 41-bone rig")
    base_action = active_action(arm)
    if arm.animation_data:
        arm.animation_data.action = None
    if base_action:
        bpy.data.actions.remove(base_action)
    copy_baked_uv_and_material(mesh)

    actions = {}
    for logical, (filename, _loop, _speed, _event) in CLIPS.items():
        if logical == "idle":
            continue
        actions[logical] = import_clip(logical, filename, arm)
    # The source has no dedicated idle. A very slow walking loop gives the giant
    # a grounded breathing/weight-shift stance instead of exposing the T-pose.
    actions["idle"] = actions["walk"].copy()
    actions["idle"].name = "idle"
    actions["idle"].use_fake_user = True

    # Export all named actions on the shared Mixamo rig. Runtime scales the root to 36m.
    arm.animation_data_create()
    arm.animation_data.action = actions["idle"]
    bpy.context.scene.render.fps = 30
    bpy.ops.object.select_all(action="DESELECT")
    arm.select_set(True)
    mesh.select_set(True)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.export_scene.gltf(
        filepath=str(OUT_GLB), export_format="GLB", use_selection=True,
        export_animations=True, export_animation_mode="ACTIONS",
        export_skins=True, export_morph=False, export_yup=True,
    )

    manifest = {
        "model": "assets/final-boss/final-boss.glb",
        "source": "bosstiu",
        "mesh": {"vertices": len(mesh.data.vertices), "polygons": len(mesh.data.polygons)},
        "bones": len(arm.data.bones),
        "clips": {},
    }
    for logical, (filename, loop, speed, event) in CLIPS.items():
        action = actions[logical]
        duration = (action.frame_range[1] - action.frame_range[0]) / 30
        manifest["clips"][logical] = {
            "source": filename, "name": action.name, "duration": round(duration, 3),
            "loop": loop, "speed": speed, "event": event,
        }
    OUT_MANIFEST.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"glb": str(OUT_GLB), "bytes": OUT_GLB.stat().st_size, **manifest}, ensure_ascii=False))


if __name__ == "__main__":
    main()
