// Post-processing. The scene renders once into a 4x multisampled HDR target; ambient occlusion (GTAO, computed at half
// resolution) darkens contact areas such as the ground under the rover and the machine; bloom spreads the Sun's glare
// and bright lamps; OutputPass applies the renderer's ACES tone mapping and sRGB encoding, the only place either
// happens. Quality: high (all of it), low (no AO, half the multisamples and a quarter of the shadow map's texels), off
// (low without bloom); P cycles, ?gfx= picks. The shadow map belongs to the Sun (main.ts sets it from SHADOW_TEXELS).
import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { GTAOPass } from "three/examples/jsm/postprocessing/GTAOPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { FullScreenQuad, Pass } from "three/examples/jsm/postprocessing/Pass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";

export type GfxQuality = "high" | "low" | "off";
const LEVELS: GfxQuality[] = ["high", "low", "off"];
const LABELS: Record<GfxQuality, string> = {
  high: "high: 4x multisampling, 4096 shadows, ambient occlusion, bloom",
  low: "low: 2x multisampling, 2048 shadows, bloom",
  off: "off: 2x multisampling, 2048 shadows",
};
/** Scene MSAA samples and shadow map texels per level: the two biggest GPU costs after AO. */
export const SAMPLES: Record<GfxQuality, number> = { high: 4, low: 2, off: 2 };
export const SHADOW_TEXELS: Record<GfxQuality, number> = { high: 4096, low: 2048, off: 2048 };

const AO_STRENGTH = 0.75;
export const AO_FAR_M = 60; // contact shading only: beyond this the half-res depth buffer is too coarse for it
// Bloom only from linear HDR luminance above ~2.5: the Sun, its aureole and emissive lamps, not sunlit white paint
// (which tops out near 1.5). Emissive materials need emissiveIntensity well above 1 to glow.
const BLOOM = { strength: 0.32, radius: 0.55, threshold: 2.5 };

const half = (n: number) => Math.max(1, Math.round(n / 2));

/**
 * Only solid, opaque surfaces occlude: sky shells, stars, sprites and glass would darken the ground behind them. An
 * object can also opt out with `userData.skipAO` (the AO pass draws everything with one replacement material, so
 * vertex-shader effects such as the pebbles' distance fade don't apply in it).
 */
function skipsAO(o: THREE.Object3D): boolean {
  if (o.userData.skipAO) return true;
  if ((o as THREE.Points).isPoints || (o as THREE.Line).isLine || (o as THREE.Sprite).isSprite) return true;
  if (!(o as THREE.Mesh).isMesh) return false;
  const m = (o as THREE.Mesh).material;
  return Array.isArray(m) ? m.every((x) => x.transparent) : m.transparent;
}

/** GTAO at half resolution, from its own normal + depth pass over the opaque scene. */
class HalfResGTAO extends GTAOPass {
  private saved = new Map<THREE.Object3D, boolean>();

  overrideVisibility(): void {
    this.scene.traverse((o) => {
      this.saved.set(o, o.visible);
      if (skipsAO(o)) o.visible = false;
    });
  }

  restoreVisibility(): void {
    this.saved.forEach((visible, o) => (o.visible = visible));
    this.saved.clear();
  }

  setSize(width: number, height: number): void {
    super.setSize(half(width), half(height));
  }
}

/**
 * Renders the scene into a multisampled HDR target and writes it to the composer's buffer, darkened by the AO term
 * when AO is on: one full-screen pass instead of GTAOPass's own copy + blend.
 */
class SceneAOPass extends Pass {
  ao = true;
  private target: THREE.WebGLRenderTarget;
  private gtao: HalfResGTAO;
  private quad: FullScreenQuad;
  private uniforms = { tScene: { value: null as THREE.Texture | null }, tAO: { value: null as THREE.Texture | null },
    tDepth: { value: null as THREE.Texture | null }, uStrength: { value: AO_STRENGTH }, uNear: { value: 0.1 },
    uFar: { value: 1000 } };

  constructor(private scene: THREE.Scene, private camera: THREE.PerspectiveCamera, width: number, height: number) {
    super();
    this.target = new THREE.WebGLRenderTarget(width, height, { type: THREE.HalfFloatType, samples: SAMPLES.high });
    this.gtao = new HalfResGTAO(scene, camera, half(width), half(height));
    this.gtao.output = GTAOPass.OUTPUT.Off; // compute only: the AO texture is applied below
    // metres: contact shading under wheels, legs and boulders, without haloes around distant ridges. `scale` is an
    // exponent on visibility, raised so the shading still reads in a scene lit almost only by the sun
    this.gtao.updateGtaoMaterial({ radius: 1.2, distanceExponent: 1.6, thickness: 1.5, distanceFallOff: 1,
      scale: 1.8 });
    this.gtao.updatePdMaterial({ radius: 6, samples: 12, rings: 2 });
    this.uniforms.tScene.value = this.target.texture;
    this.uniforms.tAO.value = this.gtao.gtaoMap;
    this.uniforms.tDepth.value = this.gtao.depthTexture;
    this.quad = new FullScreenQuad(new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        #include <packing>
        uniform sampler2D tScene, tAO, tDepth;
        uniform float uStrength, uNear, uFar;
        varying vec2 vUv;
        void main() {
          vec4 c = texture2D(tScene, vUv);
          float dist = -perspectiveDepthToViewZ(texture2D(tDepth, vUv).x, uNear, uFar);
          float k = uStrength * smoothstep(${AO_FAR_M.toFixed(1)}, ${(AO_FAR_M / 2).toFixed(1)}, dist);
          gl_FragColor = vec4(c.rgb * mix(1.0, texture2D(tAO, vUv).r, k), c.a);
        }`,
      depthTest: false,
      depthWrite: false,
    }));
  }

  render(renderer: THREE.WebGLRenderer, writeBuffer: THREE.WebGLRenderTarget): void {
    renderer.shadowMap.needsUpdate = true; // once per frame, not again for the AO pass's render of the scene
    renderer.setRenderTarget(this.target);
    renderer.render(this.scene, this.camera);
    if (this.ao) this.gtao.render(renderer, writeBuffer, this.target, 0, false);
    this.uniforms.uStrength.value = this.ao ? AO_STRENGTH : 0;
    this.uniforms.uNear.value = this.camera.near;
    this.uniforms.uFar.value = this.camera.far;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.quad.render(renderer);
  }

  setSize(width: number, height: number): void {
    this.target.setSize(width, height);
    this.gtao.setSize(width, height);
  }

  setSamples(samples: number): void {
    if (this.target.samples === samples) return;
    this.target.samples = samples;
    this.target.dispose(); // made again with the new sample count on next use
  }

  /**
   * Link every material's program and upload every texture now, hidden objects (the glove) included: three does it on
   * an object's first frame, which stalls the frame the rover first comes into view or the tracker connects. The HDR
   * target is bound meanwhile because programs bake in its output (no tone mapping, linear), unlike the screen's.
   */
  async precompile(renderer: THREE.WebGLRenderer): Promise<void> {
    const before = renderer.getRenderTarget();
    renderer.setRenderTarget(this.target);
    const linked = renderer.compileAsync(this.scene, this.camera);
    renderer.setRenderTarget(before);
    await linked;
    const textures = new Set<THREE.Texture>();
    const collect = (v: unknown) => { if ((v as THREE.Texture)?.isTexture) textures.add(v as THREE.Texture); };
    this.scene.traverse((o) => {
      const m = (o as THREE.Mesh).material;
      for (const mat of m ? (Array.isArray(m) ? m : [m]) : []) {
        Object.values(mat).forEach(collect);
        // shader uniforms, those added in onBeforeCompile too
        const compiled = renderer.properties.get(mat) as { uniforms?: Record<string, THREE.IUniform> };
        const uniforms = { ...(mat as THREE.ShaderMaterial).uniforms, ...compiled.uniforms };
        Object.values(uniforms).forEach((u) => collect((u as THREE.IUniform | undefined)?.value));
      }
    });
    textures.forEach((t) => renderer.initTexture(t));
  }
}

export class PostFX {
  quality: GfxQuality;
  private composer: EffectComposer;
  private scenePass: SceneAOPass;
  private bloom: UnrealBloomPass;

  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera) {
    renderer.shadowMap.autoUpdate = false; // SceneAOPass asks for exactly one shadow update per frame
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    // ping-pong buffers after the scene pass: HDR, no depth, no multisampling (only the scene needs those)
    this.composer = new EffectComposer(renderer,
      new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, depthBuffer: false }));
    this.scenePass = new SceneAOPass(scene, camera, size.x, size.y);
    this.bloom = new UnrealBloomPass(size, BLOOM.strength, BLOOM.radius, BLOOM.threshold);
    this.composer.addPass(this.scenePass);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    // a composer given its own target takes that size as CSS pixels: set the real one
    const css = renderer.getSize(new THREE.Vector2());
    this.composer.setSize(css.x, css.y);
    const asked = new URLSearchParams(location.search).get("gfx") as GfxQuality | null;
    this.quality = asked && LEVELS.includes(asked) ? asked : "high";
    this.setQuality(this.quality);
  }

  setQuality(q: GfxQuality): void {
    this.quality = q;
    this.scenePass.ao = q === "high";
    this.bloom.enabled = q !== "off";
    this.scenePass.setSamples(SAMPLES[q]);
  }

  /** Next quality level; returns a description for a toast. */
  cycle(): string {
    this.setQuality(LEVELS[(LEVELS.indexOf(this.quality) + 1) % LEVELS.length]);
    return LABELS[this.quality];
  }

  /** Shaders and textures for everything in the scene, before the first frame (see SceneAOPass.precompile). */
  precompile(): Promise<void> {
    return this.scenePass.precompile(this.composer.renderer);
  }

  /** CSS pixels, like renderer.setSize. */
  setSize(width: number, height: number): void {
    this.composer.setSize(width, height);
  }

  render(): void {
    this.composer.render();
  }
}
