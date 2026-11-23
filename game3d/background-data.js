// Shared background data checks and geometry calculations; no executable model input.
const object = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const finite = (v) => typeof v === 'number' && Number.isFinite(v);

export function validateBackground(background, need) {
  if (background == null) return;
  if (!object(background)) return need(false, 'world.background must be an object');
  const allowed = ['ipId', 'mode', 'rotation', 'imageUrl', 'modelUrl'];
  need(Object.keys(background).every((key) => allowed.includes(key)), 'world.background contains unsupported fields');
  const { ipId, mode, rotation = 0 } = background;
  need(typeof ipId === 'string' && /^ip_[a-zA-Z0-9_-]{1,64}$/.test(ipId), 'world.background.ipId must be an IP identifier');
  need(['image', 'model'].includes(mode), 'world.background.mode must be image or model');
  need(finite(rotation) && Math.abs(rotation) <= Math.PI, 'world.background.rotation must be -pi..pi');
  if (mode === 'image') {
    need(rotation === 0, 'An image backdrop cannot have a 3D rotation');
    need(background.modelUrl == null, 'An image backdrop cannot use modelUrl');
    need(background.imageUrl == null || background.imageUrl === `assets/${ipId}.background.png`,
      'world.background.imageUrl must be the server-owned game copy');
  } else if (mode === 'model') {
    need(background.imageUrl == null, 'A model background cannot use imageUrl');
    need(background.modelUrl == null || background.modelUrl === `assets/${ipId}.background.glb`,
      'world.background.modelUrl must be the server-owned game copy');
  }
}

/** Center-crop, never stretch the original background to a different viewport aspect. */
export function backgroundCover(imageWidth, imageHeight, viewWidth, viewHeight) {
  if (![imageWidth, imageHeight, viewWidth, viewHeight].every((n) => finite(n) && n > 0))
    throw new Error('Background image and viewport dimensions must be positive');
  const imageAspect = imageWidth / imageHeight, viewAspect = viewWidth / viewHeight;
  const repeatX = Math.min(1, viewAspect / imageAspect);
  const repeatY = Math.min(1, imageAspect / viewAspect);
  return { repeatX, repeatY, offsetX: (1 - repeatX) / 2, offsetY: (1 - repeatY) / 2 };
}

/** Keep an entire GLB scene's proportions instead of the 0.85m pickup normalization. */
export function backgroundModelScale(size, width, depth) {
  if (![size.x, size.z].every((n) => finite(n) && n > 0)
    || !finite(size.y) || size.y < 0 || ![width, depth].every((n) => finite(n) && n > 4))
    throw new Error('Background model must have non-empty finite geometry');
  return Math.min((width - 4) / size.x, (depth - 4) / size.z, 40 / Math.max(.1, size.y));
}
