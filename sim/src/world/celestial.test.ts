import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { azEl, blackbody, bvToKelvin, galacticFrame, snapToTexels, starCatalog } from "./celestial";

const near = (v: THREE.Vector3, x: number, y: number, z: number) => {
  expect(v.x).toBeCloseTo(x, 6);
  expect(v.y).toBeCloseTo(y, 6);
  expect(v.z).toBeCloseTo(z, 6);
};

describe("sky directions", () => {
  it("maps compass azimuth and elevation onto the world axes", () => {
    near(azEl(0, 0), 0, 0, -1); // grid north
    near(azEl(90, 0), 1, 0, 0); // east
    near(azEl(180, 0), 0, 0, 1);
    near(azEl(0, 90), 0, 1, 0);
    expect(azEl(235, 6).y).toBeCloseTo(Math.sin(THREE.MathUtils.degToRad(6)), 6);
  });

  it("builds an orthonormal galactic frame with the requested pole", () => {
    const g = galacticFrame(330, 30, 14);
    const m = new THREE.Matrix3().multiplyMatrices(g, g.clone().transpose()).elements;
    [1, 0, 0, 0, 1, 0, 0, 0, 1].forEach((e, i) => expect(m[i]).toBeCloseTo(e, 6));
    const pole = new THREE.Vector3(g.elements[2], g.elements[5], g.elements[8]); // third row
    expect(pole.angleTo(azEl(330, 30))).toBeLessThan(1e-6);
    expect(g.elements[3]).toBeGreaterThan(0); // first row, y (stored column-major): the centre is above the horizon
  });
});

describe("star catalogue", () => {
  const galactic = galacticFrame(330, 30, 14);
  const opts = { count: 20000, faintest: 7, brightest: -1.4, minElevationDeg: 0.3, planeShare: 0.35, seed: 42 };
  const cat = starCatalog(galactic, opts);

  it("keeps only stars above the horizon, with unit directions, and is deterministic", () => {
    expect(cat.count).toBeGreaterThan(8000);
    expect(cat.count).toBeLessThan(12000);
    for (let i = 0; i < cat.count; i++) {
      const d = new THREE.Vector3().fromArray(cat.dir, i * 3);
      expect(d.length()).toBeCloseTo(1, 4);
      expect(d.y).toBeGreaterThan(Math.sin(THREE.MathUtils.degToRad(0.3)) - 1e-6);
    }
    expect(starCatalog(galactic, opts).mag).toEqual(cat.mag);
  });

  it("follows the sky's magnitude counts: ~3.2x more stars per magnitude", () => {
    const brighter = (m: number) => cat.mag.filter((x) => x < m).length;
    expect(brighter(5) / brighter(4)).toBeGreaterThan(2.6);
    expect(brighter(5) / brighter(4)).toBeLessThan(3.8);
    expect(Math.min(...cat.mag)).toBeGreaterThanOrEqual(-1.4);
    expect(Math.max(...cat.mag)).toBeLessThanOrEqual(7);
  });

  it("crowds stars toward the Milky Way and colours them like stars", () => {
    const pole = new THREE.Vector3(galactic.elements[2], galactic.elements[5], galactic.elements[8]);
    const band = Math.sin(THREE.MathUtils.degToRad(10));
    let inPlane = 0;
    for (let i = 0; i < cat.count; i++) {
      if (Math.abs(new THREE.Vector3().fromArray(cat.dir, i * 3).dot(pole)) < band) inPlane++;
      const c = [cat.color[i * 3], cat.color[i * 3 + 1], cat.color[i * 3 + 2]];
      expect(Math.max(...c)).toBeCloseTo(1, 5);
      expect(Math.min(...c)).toBeGreaterThan(0.4); // the eye sees star colours only faintly
    }
    expect(inPlane / cat.count).toBeGreaterThan(0.3); // a uniform sky would put 17% there
  });

  it("derives colour from temperature", () => {
    expect(bvToKelvin(0.65)).toBeGreaterThan(5500); // the Sun
    expect(bvToKelvin(0.65)).toBeLessThan(6100);
    expect(bvToKelvin(0)).toBeGreaterThan(9000); // Vega
    const [r3, g3, b3] = blackbody(3000), [r15, , b15] = blackbody(15000), white = blackbody(6500);
    expect(r3).toBe(1);
    expect(g3).toBeLessThan(r3);
    expect(b3).toBeLessThan(g3);
    expect(b15).toBe(1);
    expect(r15).toBeLessThan(1);
    white.forEach((c) => expect(c).toBeGreaterThan(0.9));
  });
});

describe("shadow texel snapping", () => {
  const sun = azEl(235, 6), x = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), sun).normalize();
  const y = new THREE.Vector3().crossVectors(sun, x);
  const tx = 128 / 4096, ty = 80 / 4096;

  it("lands on whole texels across the light and leaves depth alone", () => {
    for (const p of [new THREE.Vector3(13.37, 52.1, -290.4), new THREE.Vector3(-0.01, 0, 0.02)]) {
      const s = snapToTexels(p.clone(), x, y, tx, ty);
      expect(Math.abs(s.dot(x) / tx - Math.round(s.dot(x) / tx))).toBeLessThan(1e-6);
      expect(Math.abs(s.dot(y) / ty - Math.round(s.dot(y) / ty))).toBeLessThan(1e-6);
      expect(s.dot(sun)).toBeCloseTo(p.dot(sun), 6);
      expect(s.distanceTo(p)).toBeLessThanOrEqual(Math.hypot(tx, ty) / 2 + 1e-9);
    }
  });

  it("keeps the same texel grid as the player walks", () => {
    const a = snapToTexels(new THREE.Vector3(10, 50, -300), x, y, tx, ty);
    const b = snapToTexels(new THREE.Vector3(10.4, 50, -300.7), x, y, tx, ty);
    const d = b.sub(a);
    expect(Math.abs(d.dot(x) / tx - Math.round(d.dot(x) / tx))).toBeLessThan(1e-6);
    expect(Math.abs(d.dot(y) / ty - Math.round(d.dot(y) / ty))).toBeLessThan(1e-6);
  });
});
