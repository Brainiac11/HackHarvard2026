import * as THREE from "three";
import { azEl, galacticFrame, snapToTexels, starCatalog } from "./celestial";
import { buildEarth, buildMilkyWay, buildStarfield, buildSun } from "./skyObjects";

const SUN_ELEVATION_DEG = 6; // the polar Sun skims the horizon; a little higher than reality for visibility
const SUN_AZIMUTH_DEG = 235;
const SUN_COLOR = new THREE.Color(0xfffaf4); // sunlight in space is barely warmer than white
const SUN_INTENSITY = 4.5;
const SHADOW_FILL = 0.12; // light from above, scattered by sunlit regolith (the 6° Sun gives flat ground 0.47)
const EARTH_AZIMUTH_DEG = 95, EARTH_ELEVATION_DEG = 4; // from the south pole the Earth hangs low over the horizon
const EARTH_DIAMETER_DEG = 2.3; // 1.9° in reality: a little larger reads better on screen
const SKY_RADIUS = 4800; // shells for the sky objects, inside the camera's far plane

// Shadow box in light space: x runs across the sunlight, y is nearly vertical. With the Sun 6° up, one texel of y
// spans ~10x more ground along the shadows than across them, so y gets the finer texels; ±SHADOW_Y_HALF of y still
// reaches ±380 m along flat ground. The box sits SHADOW_LEAD m ahead of the player, where they are looking.
const SHADOW_MAP = 4096, SHADOW_X_HALF = 64, SHADOW_Y_HALF = 40, SHADOW_LEAD = 28;
const SHADOW_DEPTH_BACK = 400, SHADOW_DEPTH = 1000; // m of casters toward the Sun / total depth range

export class Environment {
  readonly sun: THREE.DirectionalLight;
  readonly sunDir: THREE.Vector3;
  private sky = new THREE.Group(); // centred on the camera, so everything in it is at infinity
  private shadowX: THREE.Vector3;
  private shadowY: THREE.Vector3;
  private center = new THREE.Vector3();
  private look = new THREE.Vector3();

  constructor(scene: THREE.Scene) {
    scene.background = new THREE.Color(0x000000);
    this.sunDir = azEl(SUN_AZIMUTH_DEG, SUN_ELEVATION_DEG);
    const earthDir = azEl(EARTH_AZIMUTH_DEG, EARTH_ELEVATION_DEG);

    this.sun = new THREE.DirectionalLight(SUN_COLOR, SUN_INTENSITY);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(SHADOW_MAP, SHADOW_MAP);
    Object.assign(this.sun.shadow.camera, { left: -SHADOW_X_HALF, right: SHADOW_X_HALF, top: SHADOW_Y_HALF,
      bottom: -SHADOW_Y_HALF, near: 1, far: SHADOW_DEPTH });
    // At 6° flat ground runs nearly along the light, so one texel spans ~20 cm of it and needs that much depth
    // clearance against acne. A normal offset buys it cheaply (lifting the lookup n above the ground clears
    // ~n / tan 6° = 9.5n of depth) while a constant depth bias would open a gap at every contact: keep that small.
    this.sun.shadow.bias = -0.00005; // x 999 m of depth range: 5 cm
    this.setShadowMapSize(SHADOW_MAP);
    // the shadow camera looks down -sunDir with world up, so these are its texel axes
    this.shadowX = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), this.sunDir).normalize();
    this.shadowY = new THREE.Vector3().crossVectors(this.sunDir, this.shadowX);
    scene.add(this.sun, this.sun.target);

    // no sky to light the shadows: only faint blue earthshine, and warm bounce from sunlit regolith (environment map)
    const earthshine = new THREE.DirectionalLight(0xa4bcff, 0.12);
    earthshine.position.copy(earthDir).multiplyScalar(100);
    scene.add(earthshine);
    scene.environment = regolithBounce(this.sunDir, earthDir);
    scene.environmentIntensity = 1;
    // Sunlit crater walls and rims light the ground in shadow from above, more than the map's few degrees of distant
    // terrain do (a crater's walls fill much of its floor's sky). Without this, every shadow clipped to pure black
    // under ACES's toe and the ground's detail vanished in it. With it shadowed regolith comes out around 6-11/255
    // and sunlit ground 17% brighter, keeping the low Sun's relief. The ground side is black: nothing lights from below.
    scene.add(new THREE.HemisphereLight(SUN_COLOR, 0x000000, SHADOW_FILL));

    // the plane of the Milky Way passes ~30° from the zenith at the lunar south pole (the ecliptic pole)
    const galactic = galacticFrame(330, 30, 14);
    const stars = starCatalog(galactic, { count: 14000, faintest: 7, brightest: -1.4, minElevationDeg: 0.3,
      planeShare: 0.35, seed: 42 });
    this.sky.add(
      buildMilkyWay(SKY_RADIUS, galactic, 0.014),
      buildStarfield(SKY_RADIUS * 0.99, stars, 1.1),
      buildEarth({ dir: earthDir, distance: SKY_RADIUS * 0.95, diameterDeg: EARTH_DIAMETER_DEG, sunDir: this.sunDir,
        sunColor: SUN_COLOR, sunIntensity: SUN_INTENSITY, facingLongitudeDeg: 40,
        north: new THREE.Vector3(0, 1, 0).applyAxisAngle(earthDir, THREE.MathUtils.degToRad(-18)) }),
      buildSun(this.sunDir, SKY_RADIUS * 0.95, SUN_COLOR),
    );
    scene.add(this.sky);
  }

  /** Shadow map resolution (texels a side): the full 4096, or a quarter of the texels for a struggling GPU. */
  setShadowMapSize(texels: number): void {
    const shadow = this.sun.shadow;
    if (shadow.map && shadow.mapSize.x === texels) return;
    shadow.mapSize.set(texels, texels);
    shadow.normalBias = 0.04 * (SHADOW_MAP / texels); // the acne clearance scales with the texel
    shadow.map?.dispose();
    shadow.map = null; // made again at this size on the next shadow update
  }

  /** Keep the sky around the camera and the shadow box over the ground around and ahead of the player. */
  follow(target: THREE.Vector3, camera: THREE.Camera): void {
    this.sky.position.setFromMatrixPosition(camera.matrixWorld);
    camera.getWorldDirection(this.look).setY(0);
    const center = this.center.copy(target);
    if (this.look.lengthSq() > 1e-6) center.addScaledVector(this.look.normalize(), SHADOW_LEAD);
    const texels = this.sun.shadow.mapSize.x;
    snapToTexels(center, this.shadowX, this.shadowY, (2 * SHADOW_X_HALF) / texels, (2 * SHADOW_Y_HALF) / texels);
    this.sun.target.position.copy(center);
    this.sun.position.copy(center).addScaledVector(this.sunDir, SHADOW_DEPTH_BACK);
  }
}

/**
 * What a sunlit-regolith world looks like from just above the ground, as an environment map (equirectangular, small:
 * it only feeds blurred lighting). Below the horizon, warm grey ground, brighter away from the Sun where the regolith
 * scatters light back toward it; above, distant sunlit terrain fading into black sky, and the Earth. Shaded sides of
 * the rover, the machine and the glove pick up the bounce, and metals reflect the ground instead of going black.
 */
function regolithBounce(sunDir: THREE.Vector3, earthDir: THREE.Vector3): THREE.DataTexture {
  const w = 128, h = 64, data = new Uint16Array(w * h * 4);
  const d = new THREE.Vector3();
  const sunH = new THREE.Vector2(sunDir.x, sunDir.z).normalize();
  const earthCos = Math.cos(THREE.MathUtils.degToRad(1.5));
  const half = THREE.DataUtils.toHalfFloat;
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      // three's equirect convention: u = atan(z, x) / 2π + 0.5, v = asin(y) / π + 0.5, row 0 at the bottom
      const a = ((i + 0.5) / w - 0.5) * 2 * Math.PI, el = ((j + 0.5) / h - 0.5) * Math.PI;
      d.set(Math.cos(el) * Math.cos(a), Math.sin(el), Math.cos(el) * Math.sin(a));
      const away = Math.max(0, -(d.x * sunH.x + d.z * sunH.y) / Math.max(1e-3, Math.hypot(d.x, d.z)));
      const ground = 0.07 * (1 + 0.9 * away * away);
      // above the horizon, distant sunlit rims and highlands stand a few degrees high: the only light that reaches
      // ground in shadow, a few percent of direct sun
      const k = ground * (d.y < 0.03 ? 0.8 + 0.2 * Math.min(1, -d.y * 4 + 0.2) : Math.exp(-(d.y - 0.03) / 0.15));
      let r = k, g = k * 0.93, b = k * 0.84;
      if (d.dot(earthDir) > earthCos) { r += 0.25; g += 0.4; b += 0.7; }
      const o = (j * w + i) * 4;
      data[o] = half(r); data[o + 1] = half(g); data[o + 2] = half(b); data[o + 3] = half(1);
    }
  }
  const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.HalfFloatType);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.magFilter = tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}
