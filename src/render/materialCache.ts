import * as THREE from 'three';

const lambert = new Map<string, THREE.MeshLambertMaterial>();
const standard = new Map<string, THREE.MeshStandardMaterial>();

/** Shared Lambert material per color; never dispose the returned material. */
export function lambertMaterial(color: THREE.ColorRepresentation): THREE.MeshLambertMaterial {
  const key = new THREE.Color(color).getHexString();
  let m = lambert.get(key);
  if (!m) {
    m = new THREE.MeshLambertMaterial({ color });
    lambert.set(key, m);
  }
  return m;
}

/** Shared glossy material (car paint, glass) per color/roughness/metalness. */
export function paintMaterial(color: THREE.ColorRepresentation, roughness = 0.35, metalness = 0.4): THREE.MeshStandardMaterial {
  const key = `${new THREE.Color(color).getHexString()}_${roughness}_${metalness}`;
  let m = standard.get(key);
  if (!m) {
    m = new THREE.MeshStandardMaterial({ color, roughness, metalness });
    standard.set(key, m);
  }
  return m;
}

export const unitBox = new THREE.BoxGeometry(1, 1, 1);
