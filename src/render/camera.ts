/**
 * World (light-units) ↔ screen (device pixels) transform. UI.md § Star map: pan with drag,
 * zoom with wheel, 0.25×–3×, no rotation.
 */

export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 3;

/** Screen pixels per light-unit at 1× zoom. */
export const BASE_SCALE = 1.6;

export interface Camera {
  /** World coordinates at the centre of the viewport. */
  x: number;
  y: number;
  zoom: number;
  /** Viewport size in CSS pixels. */
  width: number;
  height: number;
}

export function makeCamera(width: number, height: number): Camera {
  return { x: 0, y: 0, zoom: 1, width, height };
}

export function scaleOf(camera: Camera): number {
  return BASE_SCALE * camera.zoom;
}

export function worldToScreenX(camera: Camera, worldX: number): number {
  return (worldX - camera.x) * scaleOf(camera) + camera.width / 2;
}

export function worldToScreenY(camera: Camera, worldY: number): number {
  return (worldY - camera.y) * scaleOf(camera) + camera.height / 2;
}

export function screenToWorldX(camera: Camera, screenX: number): number {
  return (screenX - camera.width / 2) / scaleOf(camera) + camera.x;
}

export function screenToWorldY(camera: Camera, screenY: number): number {
  return (screenY - camera.height / 2) / scaleOf(camera) + camera.y;
}

export function panBy(camera: Camera, screenDx: number, screenDy: number): void {
  const scale = scaleOf(camera);
  camera.x -= screenDx / scale;
  camera.y -= screenDy / scale;
}

/**
 * Zoom about a fixed screen point, so the world position under the cursor stays put. Zooming
 * about the centre instead makes the map feel like it is sliding away from you.
 */
export function zoomAt(camera: Camera, factor: number, screenX: number, screenY: number): void {
  const worldX = screenToWorldX(camera, screenX);
  const worldY = screenToWorldY(camera, screenY);

  camera.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, camera.zoom * factor));

  camera.x = worldX - (screenX - camera.width / 2) / scaleOf(camera);
  camera.y = worldY - (screenY - camera.height / 2) / scaleOf(camera);
}

/**
 * Fit a set of points into the viewport, centred on them.
 *
 * Framing the whole cluster radius would open the game zoomed out on 39 stars the player
 * cannot see or reach; framing what they *own* opens on their actual network and still fits a
 * developed one. `minimumRadius` keeps the very first frame — one star at the origin — from
 * zooming to absurdity.
 */
export function frameOn(
  camera: Camera,
  points: readonly { readonly x: number; readonly y: number }[],
  minimumRadius: number,
): void {
  if (points.length === 0) {
    camera.x = 0;
    camera.y = 0;
    camera.zoom = 1;
    return;
  }

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const point of points) {
    minX = Math.min(minX, point.x);
    maxX = Math.max(maxX, point.x);
    minY = Math.min(minY, point.y);
    maxY = Math.max(maxY, point.y);
  }

  camera.x = (minX + maxX) / 2;
  camera.y = (minY + maxY) / 2;

  const radius = Math.max(minimumRadius, (maxX - minX) / 2, (maxY - minY) / 2);
  const shortest = Math.min(camera.width, camera.height);
  const wanted = shortest / (2 * radius * 1.25 * BASE_SCALE);
  camera.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, wanted));
}
