// Things in the sky, drawn on shells around the viewer (the sky group follows the camera, so they sit at infinity):
// the Milky Way, the stars, the Sun's disc and the Earth. All are transparent, depth-tested and drawn after the
// ground, so terrain hides them and their fragment shaders run only on open sky.
import * as THREE from "three";
import type { StarCatalog } from "./celestial";

const DEG = Math.PI / 180;

// 3D value noise on the unit sphere: seamless everywhere, no textures to load or bake. The lattice hash is integer
// arithmetic: a fract()-based float hash depends on how the compiler rounds `i + 1.0` vs. the neighbouring cell's
// floor(p), and those last-bit differences turn into visible seams along lattice planes. Offset keeps it unsigned.
const NOISE_GLSL = /* glsl */ `
  float hash13(vec3 p) {
    uvec3 q = uvec3(floor(p) + 32768.0) * uvec3(1597334673u, 3812015801u, 2798796415u);
    return float((q.x ^ q.y ^ q.z) * 1597334673u) * (1.0 / 4294967295.0);
  }
  float vnoise(vec3 p) {
    vec3 i = floor(p), f = fract(p);
    vec3 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(hash13(i), hash13(i + vec3(1, 0, 0)), u.x),
                   mix(hash13(i + vec3(0, 1, 0)), hash13(i + vec3(1, 1, 0)), u.x), u.y),
               mix(mix(hash13(i + vec3(0, 0, 1)), hash13(i + vec3(1, 0, 1)), u.x),
                   mix(hash13(i + vec3(0, 1, 1)), hash13(i + vec3(1, 1, 1)), u.x), u.y), u.z);
  }
  float fbm(vec3 p, int octaves) {
    float sum = 0.0, amp = 0.5, norm = 0.0;
    for (int i = 0; i < 6; i++) {
      if (i >= octaves) break;
      sum += amp * vnoise(p);
      norm += amp;
      amp *= 0.5;
      p = p * 2.03 + 17.1;
    }
    return sum / norm;
  }`;

const SHELL_VERTEX = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`;

/** The faint band of the Milky Way: a bulge toward the galactic centre, clumpy star clouds and a dark dust rift. */
export function buildMilkyWay(radius: number, galactic: THREE.Matrix3, intensity: number): THREE.Mesh {
  const mat = new THREE.ShaderMaterial({
    uniforms: { uGal: { value: galactic }, uIntensity: { value: intensity } },
    vertexShader: SHELL_VERTEX,
    fragmentShader: /* glsl */ `
      uniform mat3 uGal;
      uniform float uIntensity;
      varying vec3 vDir;
      ${NOISE_GLSL}
      void main() {
        vec3 d = normalize(vDir);
        vec3 g = uGal * d; // x: toward the galactic centre, z: galactic pole
        float b = asin(clamp(g.z, -1.0, 1.0));
        float l = atan(g.y, g.x);
        // no atmosphere: the band runs down to the horizon, below it is ground
        float above = smoothstep(-0.01, 0.03, d.y);
        // dither: a gradient this dark bands visibly in 8-bit output
        float dither = (hash13(vec3(gl_FragCoord.xy, 7.0)) - 0.5) * 0.0012;
        // Over 0.6 rad off the galactic plane disc and bulge are both under 6e-4, so the band adds under 2e-5: far
        // below black after tone mapping. Skip its 14 noise octaves there (about half the sky).
        if (abs(b) > 0.6 || above == 0.0) {
          gl_FragColor = vec4(vec3(max(0.0, dither)), 1.0);
          return;
        }
        float clouds = fbm(d * 7.0, 5);
        float fine = fbm(d * 23.0 + 4.0, 3);
        float width = 0.13 + 0.05 * (fbm(d * 2.5 + 9.0, 2) - 0.5);
        float disc = exp(-b * b / (2.0 * width * width)) * (0.25 + 0.75 * smoothstep(0.3, 0.8, clouds));
        float bulge = exp(-l * l / (2.0 * 0.32 * 0.32) - b * b / (2.0 * 0.15 * 0.15));
        // the dust lane is 0.035 rad wide: 0.2 off it, it is exp(-33), so its noise is skipped
        float lane = (b - 0.03 * sin(l * 2.0)) / 0.035;
        float rift = abs(lane) < 5.7 ? exp(-lane * lane) * smoothstep(0.4, 0.62, fbm(d * 11.0 + 2.0, 4)) : 0.0;
        float lum = (disc + 1.6 * bulge) * (1.0 - 0.55 * rift) * (0.7 + 0.6 * fine);
        vec3 tint = mix(vec3(0.78, 0.84, 1.0), vec3(1.0, 0.93, 0.85), bulge / (bulge + disc + 0.05));
        gl_FragColor = vec4(max(vec3(0.0), tint * lum * uIntensity * above + dither), 1.0);
      }`,
    side: THREE.BackSide,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const dome = new THREE.Mesh(new THREE.SphereGeometry(radius, 48, 24), mat);
  dome.renderOrder = -10;
  dome.frustumCulled = false;
  return dome;
}

/**
 * Stars as round, soft points, sized in pixels relative to a 1080p frame: faint ones are small dim dots, bright ones a
 * little larger. Brightness follows magnitude, compressed (flux^0.5) because the eye adapted to a sunlit foreground
 * can't see the faint end; no twinkle in a vacuum. Points are at least 3 px so one pixel sits near the profile's peak:
 * in a 2 px point every pixel centre is half a pixel off it, where the Gaussian has already fallen to an eighth.
 */
export function buildStarfield(radius: number, stars: StarCatalog, gain: number): THREE.Points {
  const geo = new THREE.BufferGeometry();
  const pos = stars.dir.map((c) => c * radius);
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("aColor", new THREE.BufferAttribute(stars.color, 3));
  geo.setAttribute("aMag", new THREE.BufferAttribute(stars.mag, 1));
  const uniforms = { uGain: { value: gain }, uPx: { value: 1 } };
  const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: /* glsl */ `
      attribute vec3 aColor;
      attribute float aMag;
      uniform float uGain;
      uniform float uPx;
      varying vec3 vColor;
      void main() {
        float flux = pow(10.0, -0.4 * aMag);
        vColor = aColor * uGain * sqrt(flux);
        gl_PointSize = (3.0 + 2.5 * smoothstep(3.0, -1.5, aMag)) * uPx;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      varying vec3 vColor;
      void main() {
        vec2 d = gl_PointCoord * 2.0 - 1.0;
        gl_FragColor = vec4(vColor * exp(-2.5 * dot(d, d)), 1.0);
      }`,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const points = new THREE.Points(geo, mat);
  points.renderOrder = -9;
  points.frustumCulled = false;
  const size = new THREE.Vector2();
  points.onBeforeRender = (renderer) => {
    const target = renderer.getRenderTarget();
    const height = target ? target.height : renderer.getDrawingBufferSize(size).y;
    uniforms.uPx.value = Math.max(1, height / 1080);
  };
  return points;
}

/** A quad at `dir` × `distance` that faces the viewer at the origin, `halfDeg` degrees from its centre to its edge. */
function skyQuad(dir: THREE.Vector3, distance: number, halfDeg: number, mat: THREE.Material): THREE.Mesh {
  const half = distance * Math.tan(halfDeg * DEG);
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2 * half, 2 * half), mat);
  quad.position.copy(dir).multiplyScalar(distance);
  quad.lookAt(0, 0, 0);
  quad.frustumCulled = false;
  return quad;
}

const SUN_RADIUS_DEG = 0.2665;

/**
 * The Sun's disc: limb-darkened and brighter than anything else, with a tight aureole of scattered light in the eye
 * and visor that the bloom pass widens into glare. Faint diffraction spikes keep it from reading as a lamp.
 */
export function buildSun(dir: THREE.Vector3, distance: number, color: THREE.Color): THREE.Mesh {
  const halfDeg = 4;
  const mat = new THREE.ShaderMaterial({
    uniforms: { uColor: { value: color }, uHalf: { value: halfDeg } },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uHalf;
      varying vec2 vUv;
      const float R = ${SUN_RADIUS_DEG.toFixed(4)};
      void main() {
        vec2 p = (vUv * 2.0 - 1.0) * uHalf; // degrees
        float r = length(p);
        float aa = fwidth(r);
        float mu = sqrt(max(0.0, 1.0 - r * r / (R * R)));
        float disc = (1.0 - smoothstep(R - aa, R + aa, r)) * (0.4 + 0.6 * mu); // limb darkening
        float x = max(r - R, 0.0);
        float aureole = 0.9 * exp(-x / 0.05) + 0.1 * exp(-x / 0.5) + 0.004 / (0.02 + x * x);
        float angle = atan(p.y, p.x);
        float spikes = pow(abs(cos(angle * 3.0)), 300.0) * exp(-x / 1.1) * 0.25;
        float edge = 1.0 - smoothstep(0.75 * uHalf, uHalf, r);
        // the disc saturates after tone mapping at 10x; much hotter and the bloom's truncated blur kernel would
        // show its square edges around it
        gl_FragColor = vec4(uColor * (10.0 * disc + (aureole + spikes) * edge), 1.0);
      }`,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const sun = skyQuad(dir, distance, halfDeg, mat);
  sun.renderOrder = -7;
  return sun;
}

export interface EarthOptions {
  dir: THREE.Vector3;
  distance: number;
  diameterDeg: number;
  sunDir: THREE.Vector3;
  sunColor: THREE.Color;
  /** Sunlight on the Earth's day side, in the same units as the scene's sun (radiance = albedo × this / π). */
  sunIntensity: number;
  /** Where the Earth's north pole points (world frame) and which longitude faces the viewer. */
  north: THREE.Vector3;
  facingLongitudeDeg: number;
}

/**
 * The Earth as a lit sphere impostor on a camera-facing quad: procedural oceans, continents with deserts, forest and
 * tundra, ice caps and cloud bands, lit by the real sun direction (so its phase and terminator are right), an ocean
 * sun glint and a thin blue atmosphere that thickens toward the limb and glows just beyond it on the day side.
 */
export function buildEarth(o: EarthOptions): THREE.Mesh {
  const atmosphere = 1.08; // quad half-size in Earth radii: room for the halo
  const halfDeg = (o.diameterDeg / 2) * atmosphere;
  // quad basis seen from the viewer: right, up, toward the viewer
  const fwd = o.dir.clone().negate();
  const right = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), fwd).normalize();
  const up = new THREE.Vector3().crossVectors(fwd, right);
  // Earth body frame: z = north pole, x = the meridian `facingLongitudeDeg` east of the one facing us
  const bz = o.north.clone().normalize();
  const toViewer = fwd.clone().addScaledVector(bz, -fwd.dot(bz)).normalize();
  const lon = o.facingLongitudeDeg * DEG;
  const bx = toViewer.clone().applyAxisAngle(bz, -lon);
  const by = new THREE.Vector3().crossVectors(bz, bx);
  const body = new THREE.Matrix3().set(bx.x, bx.y, bx.z, by.x, by.y, by.z, bz.x, bz.y, bz.z);
  const sunLinear = o.sunColor.clone().multiplyScalar(o.sunIntensity / Math.PI);

  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uRight: { value: right }, uUp: { value: up }, uFwd: { value: fwd }, uBody: { value: body },
      uSun: { value: o.sunDir }, uSunLight: { value: sunLinear }, uScale: { value: atmosphere },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uRight, uUp, uFwd, uSun, uSunLight;
      uniform mat3 uBody;
      uniform float uScale;
      varying vec2 vUv;
      ${NOISE_GLSL}
      const vec3 ATMOSPHERE = vec3(0.30, 0.55, 1.0);

      // surface albedo (linear) at body-frame direction q; also reports how much is open ocean
      vec3 surface(vec3 q, out float ocean) {
        float lat = asin(clamp(q.z, -1.0, 1.0));
        // thresholds near the 70th percentile of this noise: about 30% land, as on the Earth
        float shape = fbm(q * 1.6 + vec3(3.1, 7.7, 1.3), 5) + 0.12 * fbm(q * 7.0, 3);
        float land = smoothstep(0.612, 0.628, shape);
        float shelf = smoothstep(0.58, 0.612, shape) * (1.0 - land);
        ocean = 1.0 - land;
        vec3 water = mix(vec3(0.004, 0.018, 0.055), vec3(0.01, 0.06, 0.09), shelf);
        // deserts under the subtropical highs, forest at the equator and mid-latitudes, tundra toward the poles
        float dry = smoothstep(0.22, 0.0, abs(abs(lat) - 0.42)) * smoothstep(0.35, 0.65, fbm(q * 4.0 + 5.0, 3));
        float cold = smoothstep(0.85, 1.1, abs(lat));
        vec3 green = mix(vec3(0.035, 0.07, 0.025), vec3(0.11, 0.11, 0.05), fbm(q * 9.0, 3));
        vec3 ground = mix(mix(green, vec3(0.42, 0.32, 0.18), dry), vec3(0.2, 0.19, 0.17), cold);
        vec3 albedo = mix(water, ground, land);
        float ice = smoothstep(0.83, 0.87, abs(q.z) + 0.06 * (fbm(q * 6.0, 3) - 0.5) + 0.04 * land);
        ocean *= 1.0 - ice;
        return mix(albedo, vec3(0.8, 0.83, 0.86), ice);
      }

      // cloud cover: wet equator and storm tracks near ±55°, clear subtropics; swirled by domain warping
      float clouds(vec3 q) {
        float lat = asin(clamp(q.z, -1.0, 1.0));
        vec3 warp = vec3(fbm(q * 2.2, 3), fbm(q * 2.2 + 5.2, 3), fbm(q * 2.2 + 9.7, 3)) - 0.5;
        float c = fbm(q * 3.2 + warp * 1.4, 5);
        float wet = 0.62 + 0.22 * cos(lat * 6.0);
        return smoothstep(0.42, 0.68, c * wet + 0.12);
      }

      void main() {
        vec2 p = (vUv * 2.0 - 1.0) * uScale; // in Earth radii
        float r = length(p);
        float aa = fwidth(r);
        float cover = 1.0 - smoothstep(1.0 - aa, 1.0, r);
        float z = sqrt(max(0.0, 1.0 - r * r));
        vec3 n = normalize(uRight * p.x + uUp * p.y + uFwd * z);
        float ndl = dot(n, uSun);
        float lit = smoothstep(-0.1, 0.35, ndl); // the sunlit atmosphere reaches a little past the terminator
        vec3 color = vec3(0.0);
        if (cover > 0.0) {
          vec3 q = uBody * n;
          float ocean;
          vec3 albedo = surface(q, ocean);
          float cloud = clouds(q);
          albedo = mix(albedo, vec3(0.78), cloud);
          float day = max(ndl, 0.0);
          // a soft, slightly reddened terminator: sunlight grazing through the atmosphere
          vec3 twilight = vec3(1.0, 0.6, 0.4) * exp(-pow(ndl / 0.05, 2.0)) * 0.015;
          vec3 h = normalize(uSun + uFwd);
          float glint = ocean * (1.0 - cloud) * pow(max(dot(n, h), 0.0), 90.0) * day * 3.0;
          float haze = pow(1.0 - z, 2.5) * lit;
          color = uSunLight * (albedo * day + twilight + glint) + ATMOSPHERE * haze * 0.6 * uSunLight;
        }
        // the atmosphere glows just beyond the limb where it is sunlit, continuing the haze inside it
        float halo = exp(-max(r - 1.0, 0.0) / 0.018) * lit * (1.0 - cover);
        halo *= 1.0 - smoothstep(uScale - 0.03, uScale, r);
        gl_FragColor = vec4(color * cover + ATMOSPHERE * halo * 0.45 * uSunLight, cover);
      }`,
    transparent: true,
    premultipliedAlpha: true,
    depthWrite: false,
  });
  const earth = skyQuad(o.dir, o.distance, halfDeg, mat);
  earth.renderOrder = -8;
  return earth;
}
