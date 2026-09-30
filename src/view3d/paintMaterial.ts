import { Color, Matrix3, Matrix4, MeshPhysicalMaterial, Vector4 } from 'three';
import type { Mesh, Material, WebGLProgramParametersWithUniforms } from 'three';

/**
 * Краска кузова с процедурными повреждениями.
 *
 * Ржавчина / вмятины / сколы / царапины рисуются прямо в шейдере по локальным координатам
 * детали: без декалей и без лишней геометрии, идеально ложатся на кривую поверхность,
 * стоят O(1) по памяти, а «ремонт» — это плавное затухание uniform-а strength → 0.
 */
export const MAX_SPOTS = 16;

export const SpotType = { rust: 0, dent: 1, chip: 2, scratch: 3, marker: 4 } as const;
export type SpotTypeId = (typeof SpotType)[keyof typeof SpotType];

export interface PaintFx {
  spotA: Vector4[]; // xyz — центр (локальные коорд.), w — радиус
  spotB: Vector4[]; // x — тип, y — сила (0..1), z — seed
  spotN: Vector4[]; // xyz — нормаль поверхности
  arch: Vector4; // x,y,r — вырез колёсной арки (в плоскости XY локальных координат), w — включён
  hi: { value: number };
  hiColor: { value: Color };
  nm: { value: Matrix3 };
  count: number;
}

const VERT_PARS = /* glsl */ `varying vec3 vLPos;`;
const VERT_MAIN = /* glsl */ `vLPos = position;`;

const FRAG_PARS = /* glsl */ `
#define MAX_SPOTS ${MAX_SPOTS}
uniform vec4 uSpotA[MAX_SPOTS];
uniform vec4 uSpotB[MAX_SPOTS];
uniform vec4 uSpotN[MAX_SPOTS];
uniform vec4 uArch;
uniform float uHi;
uniform vec3 uHiColor;
uniform mat3 uNM;
uniform float uTime;
varying vec3 vLPos;

float h31(vec3 p){ p = fract(p*vec3(.1031,.11369,.13787)); p += dot(p, p.yzx+19.19); return fract((p.x+p.y)*p.z); }
vec3 h33(vec3 p){ p = fract(p*vec3(.1031,.1030,.0973)); p += dot(p, p.yxz+33.33); return fract((p.xxy+p.yxx)*p.zyx); }
float vnoise(vec3 p){
  vec3 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
  return mix(mix(mix(h31(i),h31(i+vec3(1,0,0)),f.x), mix(h31(i+vec3(0,1,0)),h31(i+vec3(1,1,0)),f.x), f.y),
             mix(mix(h31(i+vec3(0,0,1)),h31(i+vec3(1,0,1)),f.x), mix(h31(i+vec3(0,1,1)),h31(i+vec3(1,1,1)),f.x), f.y), f.z);
}
float fbm(vec3 p){ float a=.5, s=0.; for(int k=0;k<4;k++){ s+=a*vnoise(p); p=p*2.03+7.1; a*=.5; } return s; }
`;

const FRAG_ARCH = /* glsl */ `if (uArch.w > 0.5 && length(vLPos.xy - uArch.xy) < uArch.z) discard;`;

const FRAG_COLOR = /* glsl */ `
float rustM = 0.0, chipM = 0.0, scrM = 0.0, mkM = 0.0;
vec3 dentGrad = vec3(0.0);
float dentShade = 0.0;
vec3 spotCol = vec3(0.0);
{
  vec3 P = vLPos;
  for (int i = 0; i < MAX_SPOTS; i++) {
    float s = uSpotB[i].y;
    if (s <= 0.001) continue;
    vec4 A = uSpotA[i];
    float r = A.w;
    vec3 d = P - A.xyz;
    float dist = length(d);
    if (dist > r * 1.25) continue;
    float seed = uSpotB[i].z;
    int t = int(uSpotB[i].x + 0.5);
    vec3 q = d / r;
    if (t == 0) {
      float n = fbm(q * 3.2 + seed);
      float edge = dist / r + (n - 0.5) * 0.75;
      float m = smoothstep(1.0, 0.62, edge) * s;
      float n2 = fbm(q * 9.0 + seed * 2.0);
      vec3 rc = mix(vec3(0.24, 0.085, 0.03), vec3(0.66, 0.31, 0.09), n2);
      rc = mix(rc, vec3(0.78, 0.45, 0.16), smoothstep(0.55, 0.9, n2) * 0.6);
      // вздувшаяся краска по краю
      float rim = smoothstep(0.62, 0.8, edge) * (1.0 - smoothstep(0.8, 1.0, edge));
      rc = mix(rc, vec3(0.13, 0.05, 0.02), rim * 0.5);
      spotCol = mix(spotCol, rc, m);
      rustM = max(rustM, m);
    } else if (t == 1) {
      float w = r * 0.58;
      float g = exp(-(dist * dist) / (w * w));
      float amp = r * 0.30 * s;
      vec3 dir = dist > 1e-5 ? d / dist : vec3(0.0);
      vec3 grad = dir * (amp * 2.0 * dist / (w * w) * g);
      vec3 nl = uSpotN[i].xyz;
      dentGrad += grad - nl * dot(grad, nl);
      dentShade = max(dentShade, g * s);
    } else if (t == 2) {
      float cs = r * 0.24;
      vec3 c = floor(P / cs);
      float best = 0.0; float core = 0.0;
      for (int a = -1; a <= 1; a++) for (int b = -1; b <= 1; b++) for (int e = -1; e <= 1; e++) {
        vec3 cc = c + vec3(float(a), float(b), float(e));
        vec3 rnd = h33(cc + seed);
        vec3 pc = (cc + 0.2 + 0.6 * rnd) * cs;
        float rad = cs * (0.16 + 0.30 * rnd.x);
        float dd = length(P - pc);
        float fall = 1.0 - smoothstep(0.35, 1.0, length(pc - A.xyz) / r);
        float on = step(0.4, rnd.y + fall * 0.55);
        float m = (1.0 - smoothstep(rad * 0.75, rad, dd)) * on * fall;
        best = max(best, m);
        core = max(core, (1.0 - smoothstep(0.0, rad * 0.6, dd)) * on * fall);
      }
      best *= s;
      vec3 cc2 = mix(vec3(0.10, 0.10, 0.11), vec3(0.62, 0.63, 0.66), core);
      spotCol = mix(spotCol, cc2, best);
      chipM = max(chipM, best);
    } else if (t == 3) {
      vec3 nl = uSpotN[i].xyz;
      vec3 rv = normalize(h33(vec3(seed, 1.3, 2.7)) - 0.5);
      vec3 tv = normalize(cross(nl, rv));
      float m = 0.0;
      for (int k = 0; k < 3; k++) {
        float ang = (h31(vec3(seed, float(k), 5.0)) - 0.5) * 0.09;
        vec3 tk = normalize(tv * cos(ang) + cross(nl, tv) * sin(ang));
        float off = (float(k) - 1.0) * r * 0.2 + (h31(vec3(seed, float(k), 9.0)) - 0.5) * r * 0.1;
        vec3 dd = d - cross(nl, tk) * off;
        float along = dot(dd, tk);
        float perp = length(dd - tk * along - nl * dot(dd, nl));
        float w = r * (0.014 + 0.005 * float(k));
        float jag = vnoise(vec3(along * 60.0 / r, float(k), seed)) * w;
        m = max(m, (1.0 - smoothstep(w * 0.4, w, perp + jag)) * (1.0 - smoothstep(r * (0.45 + 0.15 * float(k)), r * (0.75 + 0.15 * float(k)), abs(along))));
      }
      m *= s;
      spotCol = mix(spotCol, vec3(0.78, 0.8, 0.83), m);
      scrM = max(scrM, m);
    } else {
      float rr = dist / r;
      float pulse = 0.75 + 0.25 * sin(uTime * 5.0);
      float ring = smoothstep(0.78, 0.9, rr) * (1.0 - smoothstep(0.96, 1.0, rr));
      float dot0 = 1.0 - smoothstep(0.05, 0.09, rr);
      mkM = max(mkM, (ring + dot0) * pulse);
    }
  }
  float cover = max(max(rustM, chipM), scrM);
  diffuseColor.rgb = mix(diffuseColor.rgb, spotCol, clamp(cover, 0.0, 1.0));
  diffuseColor.rgb *= 1.0 - 0.22 * dentShade;
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.1, 0.85, 1.0), clamp(mkM, 0.0, 1.0));
}
`;

const FRAG_ROUGH = /* glsl */ `roughnessFactor = mix(roughnessFactor, 0.96, max(rustM, chipM * 0.8));`;
const FRAG_METAL = /* glsl */ `metalnessFactor = mix(metalnessFactor, 0.0, max(rustM, scrM * 0.5));`;
const FRAG_NORMAL = /* glsl */ `normal = normalize(normal - uNM * dentGrad);`;
const FRAG_CLEARCOAT = /* glsl */ `material.clearcoat *= (1.0 - clamp(rustM + chipM, 0.0, 1.0));`;

function patch(shader: WebGLProgramParametersWithUniforms, fx: PaintFx, time: { value: number }, full: boolean): void {
  shader.uniforms.uSpotA = { value: fx.spotA };
  shader.uniforms.uSpotB = { value: fx.spotB };
  shader.uniforms.uSpotN = { value: fx.spotN };
  shader.uniforms.uArch = { value: fx.arch };
  shader.uniforms.uHi = fx.hi;
  shader.uniforms.uHiColor = fx.hiColor;
  shader.uniforms.uNM = fx.nm;
  shader.uniforms.uTime = time;
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `#include <common>\n${VERT_PARS}`)
    .replace('#include <begin_vertex>', `#include <begin_vertex>\n${VERT_MAIN}`);
  let f = shader.fragmentShader.replace('#include <common>', `#include <common>\n${FRAG_PARS}`);
  f = f.replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>\n${FRAG_ARCH}`);
  if (full) {
    f = f
      .replace('#include <color_fragment>', `#include <color_fragment>\n${FRAG_COLOR}`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>\n${FRAG_ROUGH}`)
      .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>\n${FRAG_METAL}`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>\n${FRAG_NORMAL}`)
      .replace('#include <lights_physical_fragment>', `#include <lights_physical_fragment>\n${FRAG_CLEARCOAT}`);
  }
  f = f.replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\ntotalEmissiveRadiance += uHiColor * uHi;`);
  shader.fragmentShader = f;
}

export function createFx(): PaintFx {
  return {
    spotA: Array.from({ length: MAX_SPOTS }, () => new Vector4()),
    spotB: Array.from({ length: MAX_SPOTS }, () => new Vector4()),
    spotN: Array.from({ length: MAX_SPOTS }, () => new Vector4(0, 1, 0, 0)),
    arch: new Vector4(0, 0, 0, 0),
    hi: { value: 0 },
    hiColor: { value: new Color(0x2f9bff) },
    nm: { value: new Matrix3() },
    count: 0,
  };
}

export const globalTime = { value: 0 };

const FX_KEY = '__fx';
export function getFx(m: Material): PaintFx | undefined {
  return (m.userData as Record<string, PaintFx | undefined>)[FX_KEY];
}

/** Материал краски с шейдерными повреждениями. */
export type PaintFinish = 'gloss' | 'satin' | 'matte';

/**
 * Параметры лака. «gloss» — для гладких процедурных панелей; «satin» — для моделей из файлов
 * (сканы и чужие меши с шумными нормалями при сильной зеркальности выглядят «хромом»).
 */
const FINISH: Record<PaintFinish, { metalness: number; roughness: number; clearcoat: number; clearcoatRoughness: number; envMapIntensity: number }> = {
  gloss: { metalness: 0.35, roughness: 0.34, clearcoat: 0.9, clearcoatRoughness: 0.08, envMapIntensity: 1.0 },
  satin: { metalness: 0.08, roughness: 0.5, clearcoat: 0.3, clearcoatRoughness: 0.3, envMapIntensity: 0.55 },
  matte: { metalness: 0.025, roughness: 0.63, clearcoat: 0.1, clearcoatRoughness: 0.45, envMapIntensity: 0.38 },
};

export function createPaintMaterial(color: number | string, finish: PaintFinish = 'gloss'): MeshPhysicalMaterial {
  const m = new MeshPhysicalMaterial({ color: new Color(color), ...FINISH[finish] });
  const fx = createFx();
  (m.userData as Record<string, unknown>)[FX_KEY] = fx;
  m.onBeforeCompile = (sh) => patch(sh, fx, globalTime, true);
  m.customProgramCacheKey = () => 'paint-v1';
  return m;
}

/** Любой другой материал: вырез арки + подсветка выбора (без повреждений). */
export function enhanceMaterial<T extends Material>(m: T, arch?: [number, number, number]): T {
  const fx = createFx();
  if (arch) fx.arch.set(arch[0], arch[1], arch[2], 1);
  (m.userData as Record<string, unknown>)[FX_KEY] = fx;
  m.onBeforeCompile = (sh) => patch(sh, fx, globalTime, false);
  m.customProgramCacheKey = () => 'plain-v1';
  return m;
}

export function setArch(m: Material, arch: [number, number, number]): void {
  const fx = getFx(m);
  if (fx) fx.arch.set(arch[0], arch[1], arch[2], 1);
}

export function setHighlight(m: Material, v: number, color?: number): void {
  const fx = getFx(m);
  if (!fx) return;
  fx.hi.value = v;
  if (color !== undefined) fx.hiColor.value.setHex(color);
}

const _m4 = new Matrix4();

/** Вызывается перед отрисовкой каждого paint-меша: нормальная матрица для вмятин. */
export function updateNormalMatrix(mesh: Mesh, viewMatrixInverse: Matrix4): void {
  const fx = getFx(mesh.material as Material);
  if (!fx || fx.count === 0) return;
  _m4.multiplyMatrices(viewMatrixInverse, mesh.matrixWorld);
  fx.nm.value.getNormalMatrix(_m4);
}

export function setSpots(
  material: Material,
  spots: { type: SpotTypeId; strength: number; seed: number; p: [number, number, number]; n: [number, number, number]; r: number }[],
): void {
  const fx = getFx(material);
  if (!fx) return;
  const n = Math.min(spots.length, MAX_SPOTS);
  for (let i = 0; i < MAX_SPOTS; i++) {
    if (i < n) {
      const s = spots[i];
      fx.spotA[i].set(s.p[0], s.p[1], s.p[2], s.r);
      fx.spotB[i].set(s.type, s.strength, s.seed, 0);
      fx.spotN[i].set(s.n[0], s.n[1], s.n[2], 0);
    } else {
      fx.spotB[i].set(0, 0, 0, 0);
    }
  }
  fx.count = n;
}
export type { Mesh };
