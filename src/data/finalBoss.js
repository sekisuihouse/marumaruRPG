import { assetUrl } from './world.js'

export const FINAL_BOSS = Object.freeze({
  id: 'final', name: '祭典終端巨人・ティウ', modelPath: assetUrl('assets/final-boss/final-boss.glb'),
  displayHeight: 12, sourceRigBoundsRatio: 5.03, baseHp: 3600, color: '#ffcf70',
  rewardItems: ['prototype_core', 'stage_pass', 'boundary_seal', 'chef_medal'],
})

export const FINAL_PART_DEFS = Object.freeze({
  shinL: { id: 'shinL', label: '左すね', hp: 420, bone: 'mixamorig:LeftLeg', radius: 0.9, role: 'shin' },
  shinR: { id: 'shinR', label: '右すね', hp: 420, bone: 'mixamorig:RightLeg', radius: 0.9, role: 'shin' },
  armL: { id: 'armL', label: '左前腕', hp: 360, bone: 'mixamorig:LeftForeArm', radius: 0.8, role: 'arm' },
  armR: { id: 'armR', label: '右前腕', hp: 360, bone: 'mixamorig:RightForeArm', radius: 0.8, role: 'arm' },
  conduitStudent: { id: 'conduitStudent', label: '試作導管', hp: 180, bone: 'mixamorig:Spine1', radius: 0.52, role: 'conduit', color: '#72e4ff', reward: 'prototype_core' },
  conduitStage: { id: 'conduitStage', label: '共鳴導管', hp: 180, bone: 'mixamorig:LeftShoulder', radius: 0.52, role: 'conduit', color: '#f36fff', reward: 'stage_pass' },
  conduitShrine: { id: 'conduitShrine', label: '境界導管', hp: 180, bone: 'mixamorig:RightShoulder', radius: 0.52, role: 'conduit', color: '#ffd36a', reward: 'boundary_seal' },
  conduitFood: { id: 'conduitFood', label: '灼熱導管', hp: 180, bone: 'mixamorig:Spine2', radius: 0.52, role: 'conduit', color: '#ff7b3f', reward: 'chef_medal' },
  crown: { id: 'crown', label: '視界冠', hp: 300, bone: 'mixamorig:Head', radius: 0.72, role: 'crown', color: '#f5edff' },
  core: { id: 'core', label: '胸の祭核', hp: 900, bone: 'mixamorig:Spine2', radius: 0.76, role: 'core', color: '#fff1a8' },
})

export const FINAL_PLATFORM_DEFS = Object.freeze([
  { id: 'shinL', bone: 'mixamorig:LeftLeg', size: [1.2, 0.3, 1.95], fallback: [-0.7, 1.85, 0] },
  { id: 'shinR', bone: 'mixamorig:RightLeg', size: [1.2, 0.3, 1.95], fallback: [0.7, 1.85, 0] },
  { id: 'forearmL', bone: 'mixamorig:LeftForeArm', size: [2.4, 0.35, 1.15], fallback: [-2.2, 5.5, 0] },
  { id: 'forearmR', bone: 'mixamorig:RightForeArm', size: [2.4, 0.35, 1.15], fallback: [2.2, 5.5, 0] },
  { id: 'back', bone: 'mixamorig:Spine1', size: [2.85, 0.4, 2.1], fallback: [0, 7.35, 0.4] },
  { id: 'head', bone: 'mixamorig:Head', size: [1.75, 0.35, 1.6], fallback: [0, 10.7, 0] },
  { id: 'chest', bone: 'mixamorig:Spine2', size: [2.5, 0.35, 1.45], fallback: [0, 8.5, -0.4] },
])

export const FINAL_ATTACKS = Object.freeze({
  stomp: { id: 'stomp', label: '町割り踏み', windup: 1.25, recover: 2.8, radius: 4, damage: 42, anim: 'stomp' },
  throw: { id: 'throw', label: '祭具投擲', windup: 1.6, recover: 1.7, radius: 2.5, damage: 34, anim: 'throw' },
  swat: { id: 'swat', label: '虫払い', windup: 0.9, recover: 1.8, damage: 30, anim: 'swat' },
  shake: { id: 'shake', label: '振り落とし', windup: 0.8, recover: 1.4, damage: 0, anim: 'swat' },
  pulse: { id: 'pulse', label: '祭核鼓動', windup: 1.1, recover: 1.4, damage: 38, anim: 'idle' },
  blindCharge: { id: 'blindCharge', label: '盲進崩し', windup: 1.45, recover: 2.4, radius: 3, damage: 40, anim: 'swagger' },
})

export const FINAL_CLIPS = Object.freeze({
  idle: { loop: true, speed: 0.16 }, walk: { loop: true, speed: 1 }, swagger: { loop: false, speed: 1 },
  stomp: { loop: false, speed: 1 }, throw: { loop: false, speed: 1.35 }, swat: { loop: false, speed: 1.5 }, death: { loop: false, speed: 0.4 },
})
