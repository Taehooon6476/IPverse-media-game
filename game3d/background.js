// A selected prop IP is a static environment, never a floating/collectible item.
// Images remain images. A GLB scene is visual geometry; declared world entities
// supply movement collisions. This module does not infer navigation from pictures.
import { THREE } from './world.js';
import { backgroundCover, backgroundModelScale, validateBackground } from './background-data.js';

export async function loadBackground(mode) {
  const data = mode.spec.world.background;
  if (!data) return null;
  const errors = [];
  validateBackground(data, (ok, error) => { if (!ok) errors.push(error); });
  if (errors.length) throw new Error(errors.join('; '));
  const { world } = mode;
  const result = { ipId: data.ipId, mode: data.mode, loaded: false,
    static: true, collectible: false, collisionSource: 'declared-world-entities' };
  if (data.mode === 'image') {
    if (!data.imageUrl) throw new Error('배경 IP의 원본 이미지가 게임에 연결되지 않았습니다.');
    let texture;
    try { texture = await new THREE.TextureLoader().loadAsync(data.imageUrl); }
    catch { throw new Error('선택한 배경 IP의 원본 이미지를 불러오지 못했습니다.'); }
    const image = texture.image;
    if (!image?.width || !image?.height) { texture.dispose(); throw new Error('배경 이미지가 비어 있습니다.'); }
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
    const oldBackground = world.scene.background;
    const resize = () => {
      const { width, height } = world.renderer.domElement.getBoundingClientRect();
      const crop = backgroundCover(image.width, image.height, Math.max(1, width), Math.max(1, height));
      texture.repeat.set(crop.repeatX, crop.repeatY);
      texture.offset.set(crop.offsetX, crop.offsetY);
      texture.updateMatrix();
      result.crop = crop;
    };
    resize();
    addEventListener('resize', resize);
    world.scene.background = texture;
    Object.assign(result, { loaded: true, sourceUrl: data.imageUrl, width: image.width, height: image.height,
      render: 'original-image-backdrop', automatic3DTerrain: false });
    return { result, dispose() {
      removeEventListener('resize', resize);
      if (world.scene.background === texture) world.scene.background = oldBackground;
      texture.dispose();
    } };
  }
  if (!data.modelUrl) throw new Error('배경 IP의 3D 모델이 게임에 연결되지 않았습니다.');
  const loaded = await world.loadModel(data.modelUrl);
  if (!loaded?.scene) throw new Error('선택한 배경 IP의 3D 모델을 불러오지 못했습니다.');
  const scene = loaded.scene;
  scene.rotation.y = data.rotation ?? 0;
  scene.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(scene);
  const size = box.getSize(new THREE.Vector3()), center = box.getCenter(new THREE.Vector3());
  const scale = backgroundModelScale(size, mode.spec.world.width, mode.spec.world.depth);
  const container = new THREE.Group();
  container.name = `background:${data.ipId}`;
  container.scale.setScalar(scale);
  container.position.set(-center.x * scale, -box.min.y * scale, -center.z * scale);
  container.add(scene);
  let meshes = 0, triangles = 0;
  scene.traverse((node) => {
    if (!node.isMesh) return;
    meshes++;
    triangles += (node.geometry.index?.count ?? node.geometry.attributes.position?.count ?? 0) / 3;
    node.castShadow = node.receiveShadow = true;
  });
  if (!meshes || !triangles) throw new Error('배경 GLB에 표시할 메시가 없습니다.');
  mode.root.add(container);
  container.updateMatrixWorld(true);
  const fitted = new THREE.Box3().setFromObject(container);
  Object.assign(result, { loaded: true, sourceUrl: data.modelUrl, render: 'static-full-GLB-scene',
    meshes, triangles: Math.round(triangles), scale, rotation: data.rotation ?? 0,
    bounds: { min: fitted.min.toArray(), max: fitted.max.toArray() },
    automaticNavigation: false });
  // AuthoredMode owns the container geometry/material lifetime through disposeTree.
  return { result, dispose() { } };
}
