import * as THREE from 'three';
import type { AreaKind, RoadKind } from '../world/chunkTypes';
import {
  facadeTexture,
  groundTexture,
  pavingTexture,
  roadTexture,
  roofTexture,
  sidewalkTexture,
} from './textures';

/** Draw layers for flat ground features; higher layers win where features overlap. */
export const LAYER = {
  landuse: 1,
  green: 2,
  paved: 3,
  water: 4,
  pier: 5,
  sidewalk: 6,
  path: 7,
  minorRoad: 8,
  majorRoad: 9,
  rail: 10,
} as const;

export const layerY = (layer: number) => layer * 0.006;

export const AREA_STYLE: Record<AreaKind, { color: string; layer: number }> = {
  water: { color: '#2f5f7c', layer: LAYER.water },
  park: { color: '#5f8a45', layer: LAYER.green },
  grass: { color: '#6c9650', layer: LAYER.green },
  forest: { color: '#3f6a34', layer: LAYER.green },
  pitch: { color: '#4f8c4a', layer: LAYER.green },
  sand: { color: '#cdb98c', layer: LAYER.green },
  plaza: { color: '#b3ada2', layer: LAYER.paved },
  parking: { color: '#77777a', layer: LAYER.paved },
  pier: { color: '#8f8578', layer: LAYER.pier },
  industrial: { color: '#8d8a84', layer: LAYER.landuse },
  railway: { color: '#85807a', layer: LAYER.landuse },
  residential: { color: '#9a978f', layer: LAYER.landuse },
  commercial: { color: '#9d9890', layer: LAYER.landuse },
};

function flat(layer: number, params: THREE.MeshLambertMaterialParameters): THREE.MeshLambertMaterial {
  const m = new THREE.MeshLambertMaterial(params);
  m.polygonOffset = true;
  m.polygonOffsetFactor = -layer;
  m.polygonOffsetUnits = -layer * 2;
  return m;
}

/** Shared materials for all chunks (one set per game). */
export class WorldMaterials {
  readonly ground: THREE.MeshLambertMaterial;
  readonly areas: THREE.MeshLambertMaterial;
  readonly water: THREE.MeshPhongMaterial;
  readonly roadTwoWay: THREE.MeshLambertMaterial;
  readonly roadOneWay: THREE.MeshLambertMaterial;
  readonly roadPlain: THREE.MeshLambertMaterial;
  readonly sidewalk: THREE.MeshLambertMaterial;
  readonly footway: THREE.MeshLambertMaterial;
  readonly pedestrian: THREE.MeshLambertMaterial;
  readonly rail: THREE.MeshLambertMaterial;
  readonly walls: THREE.MeshLambertMaterial;
  readonly roofs: THREE.MeshLambertMaterial;
  readonly railing: THREE.MeshLambertMaterial;
  readonly trunk: THREE.MeshLambertMaterial;
  readonly canopy: THREE.MeshLambertMaterial;
  private readonly waterUniforms = { uTime: { value: 0 } };

  constructor() {
    const groundTex = groundTexture();
    groundTex.repeat.set(1 / 16, 1 / 16);
    this.ground = new THREE.MeshLambertMaterial({ color: '#8f8c85', map: groundTex });
    this.areas = flat(LAYER.green, { vertexColors: true, map: groundTex });
    this.water = new THREE.MeshPhongMaterial({ color: '#234b62', specular: '#8fb4c8', shininess: 90 });
    this.water.polygonOffset = true;
    this.water.polygonOffsetFactor = -LAYER.water;
    this.water.polygonOffsetUnits = -LAYER.water * 2;
    this.water.onBeforeCompile = (shader) => {
      // Cheap animated ripples: perturb the normal with a few moving sine waves.
      shader.uniforms.uTime = this.waterUniforms.uTime;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vWorldPos;')
        .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vWorldPos;\nuniform float uTime;')
        .replace(
          '#include <normal_fragment_begin>',
          `#include <normal_fragment_begin>
          vec2 wp = vWorldPos.xz;
          float a = sin(wp.x * 0.45 + uTime * 1.3) + sin(wp.y * 0.38 - uTime * 1.1) * 0.8 + sin((wp.x + wp.y) * 0.9 + uTime * 2.1) * 0.4;
          float b = cos(wp.y * 0.41 + uTime * 1.2) + cos(wp.x * 0.33 - uTime * 0.9) * 0.8 + cos((wp.x - wp.y) * 0.8 + uTime * 1.7) * 0.4;
          normal = normalize(normal + (viewMatrix * vec4(a * 0.06, 0.0, b * 0.06, 0.0)).xyz);`,
        );
    };

    this.roadTwoWay = flat(LAYER.majorRoad, { map: roadTexture('twoWay') });
    this.roadOneWay = flat(LAYER.majorRoad, { map: roadTexture('oneWay') });
    this.roadPlain = flat(LAYER.minorRoad, { map: roadTexture('none') });
    this.sidewalk = flat(LAYER.sidewalk, { map: sidewalkTexture() });
    this.footway = flat(LAYER.path, { map: pavingTexture('#b8ad9c', 31, 16) });
    this.pedestrian = flat(LAYER.path, { map: pavingTexture('#a9a39a', 41, 32) });
    this.rail = flat(LAYER.rail, { color: '#5a5550' });
    this.walls = new THREE.MeshLambertMaterial({ vertexColors: true, map: facadeTexture() });
    this.roofs = new THREE.MeshLambertMaterial({ vertexColors: true, map: roofTexture(), side: THREE.DoubleSide });
    this.railing = new THREE.MeshLambertMaterial({ color: '#6d7278' });
    this.trunk = new THREE.MeshLambertMaterial({ color: '#5a4332' });
    this.canopy = new THREE.MeshLambertMaterial({ color: '#ffffff' });
  }

  roadMaterial(kind: RoadKind, oneway: boolean): { material: THREE.Material; layer: number } {
    switch (kind) {
      case 'motorway':
      case 'primary':
      case 'secondary':
      case 'tertiary':
        return { material: oneway ? this.roadOneWay : this.roadTwoWay, layer: LAYER.majorRoad };
      case 'residential':
      case 'service':
        return { material: this.roadPlain, layer: LAYER.minorRoad };
      case 'pedestrian':
        return { material: this.pedestrian, layer: LAYER.path };
      default:
        return { material: this.footway, layer: LAYER.path };
    }
  }

  update(time: number) {
    this.waterUniforms.uTime.value = time;
  }
}
