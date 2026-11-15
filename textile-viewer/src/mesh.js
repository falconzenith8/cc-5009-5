// Procedural fabric mesh: a warped grid with analytic position, normal and
// tangent frame so geometry normals and the direction-field tangent space stay
// synchronized under deformation (no static-image stand-ins).
//
// UVs deliberately mirror on alternating tiles: u = |fract*2-1| style folds.
// Sampling uses fract() in the shader, and the texture tile is periodic, so a
// mirrored UV never produces a highlight flip or a visible seam.

import { TAU } from './math-util.js';
import { mirrorFold } from './sampling-spec.js';

export function createFabricMesh(options = {}) {
  const segments = options.segments ?? 96;
  const width = options.width ?? 4;
  const height = options.height ?? 4;
  const bend = options.bend ?? 0.55;      // saddle amplitude
  const ripple = options.ripple ?? 0.12;  // fine ripple amplitude
  const tiles = options.tiles ?? 3;       // texture repeats across the cloth

  const row = segments + 1;
  const vertexCount = row * row;
  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const tangents = new Float32Array(vertexCount * 4); // xyz + handedness sign
  const uvs = new Float32Array(vertexCount * 2);
  const indices = new Uint32Array(segments * segments * 6);

  // Analytic surface over (x,y) in [-width/2, width/2].
  const zAt = (x, y) =>
    bend * (x * x / (width * width) - y * y / (height * height)) +
    ripple * Math.sin(TAU * x / width * 2) * Math.cos(TAU * y / height * 2);

  function fillVertex(i, gx, gy) {
    const x = (gx / segments - 0.5) * width;
    const y = (gy / segments - 0.5) * height;
    const z = zAt(x, y);
    positions[i * 3] = x;
    positions[i * 3 + 1] = y;
    positions[i * 3 + 2] = z;

    // Analytic partial derivatives -> normal and tangent frame.
    const dzdx =
      bend * 2 * x / (width * width) +
      ripple * Math.cos(TAU * x / width * 2) * (TAU * 2 / width) * Math.cos(TAU * y / height * 2);
    const dzdy =
      -bend * 2 * y / (height * height) +
      ripple * Math.sin(TAU * x / width * 2) * (-Math.sin(TAU * y / height * 2)) * (TAU * 2 / height);

    // T = dP/dx, B = dP/dy; normal = normalize(cross(T, B)).
    let tx = 1, ty = 0, tz = dzdx;
    let bxp = 0, by = 1, bz = dzdy;
    let nx = ty * bz - tz * by;
    let ny = tz * bxp - tx * bz;
    let nz = tx * by - ty * bxp;
    const nl = Math.hypot(nx, ny, nz) || 1;
    nx /= nl; ny /= nl; nz /= nl;
    normals[i * 3] = nx;
    normals[i * 3 + 1] = ny;
    normals[i * 3 + 2] = nz;

    // Gram-Schmidt orthogonalize tangent against the (deformed) normal.
    const tdotn = tx * nx + ty * ny + tz * nz;
    tx -= tdotn * nx; ty -= tdotn * ny; tz -= tdotn * nz;
    const tl = Math.hypot(tx, ty, tz) || 1;
    tangents[i * 4] = tx / tl;
    tangents[i * 4 + 1] = ty / tl;
    tangents[i * 4 + 2] = tz / tl;
    // Handedness: sign of determinant(T,B,N); mirrored UV tiles flip it.
    tangents[i * 4 + 3] = 1;

    // Mirrored UV layout. Raw repeat coordinate folds every tile through the
    // shared mirror definition in sampling-spec.js.
    const rawU = (gx / segments) * tiles;
    const rawV = (gy / segments) * tiles;
    uvs[i * 2] = mirrorFold(rawU);
    uvs[i * 2 + 1] = mirrorFold(rawV);
  }

  for (let gy = 0; gy <= segments; gy++) {
    for (let gx = 0; gx <= segments; gx++) {
      fillVertex(gy * row + gx, gx, gy);
    }
  }

  let p = 0;
  for (let gy = 0; gy < segments; gy++) {
    for (let gx = 0; gx < segments; gx++) {
      const a = gy * row + gx;
      const b = a + 1;
      const c = a + row;
      const d = c + 1;
      indices[p++] = a; indices[p++] = c; indices[p++] = b;
      indices[p++] = b; indices[p++] = c; indices[p++] = d;
    }
  }

  // Bounding sphere for camera framing.
  const radius = Math.hypot(width, height) / 2 + Math.abs(bend) + Math.abs(ripple);
  return {
    segments, width, height, bend, ripple, tiles,
    positions, normals, tangents, uvs, indices,
    vertexCount, indexCount: indices.length, radius,
    zAt,
  };
}

// Recompute only normals/tangents after a parameter change; used when the UI
// bends the cloth at runtime to prove the direction field follows the surface.
export function recomputeFrame(mesh) {
  const { segments, width, height, bend, ripple, row } = mesh;
  for (let gy = 0; gy <= segments; gy++) {
    for (let gx = 0; gx <= segments; gx++) {
      const i = gy * row + gx;
      const x = (gx / segments - 0.5) * width;
      const y = (gy / segments - 0.5) * height;
      const dzdx =
        bend * 2 * x / (width * width) +
        ripple * Math.cos(TAU * x / width * 2) * (TAU * 2 / width) * Math.cos(TAU * y / height * 2);
      const dzdy =
        -bend * 2 * y / (height * height) +
        ripple * Math.sin(TAU * x / width * 2) * (-Math.sin(TAU * y / height * 2)) * (TAU * 2 / height);
      let nx = -dzdx, ny = -dzdy, nz = 1;
      const nl = Math.hypot(nx, ny, nz);
      mesh.normals[i * 3] = nx / nl;
      mesh.normals[i * 3 + 1] = ny / nl;
      mesh.normals[i * 3 + 2] = nz / nl;
      let tx = 1, ty = 0, tz = dzdx;
      const tdotn = tx * mesh.normals[i * 3] + tz * mesh.normals[i * 3 + 2];
      tx -= tdotn * mesh.normals[i * 3];
      tz -= tdotn * mesh.normals[i * 3 + 2];
      const tl = Math.hypot(tx, ty, tz) || 1;
      mesh.tangents[i * 4] = tx / tl;
      mesh.tangents[i * 4 + 1] = ty / tl;
      mesh.tangents[i * 4 + 2] = tz / tl;
    }
  }
}
