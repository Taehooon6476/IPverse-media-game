// Authored local contract fixture. These paths are never fetched by Node tests.
export function citySpec({ width = 600, depth = width, seed = 271828 } = {}) {
  return {
    version: 2,
    engine: 'three',
    title: 'Local city contract fixture',
    genre: 'rpg-quest',
    palette: { bg: '#17232c', accent: '#f2bd65', text: '#ffffff' },
    player: { ipId: 'ip_hero', name: '선택 주인공', speed: 2, modelUrl: 'assets/hero.glb' },
    props: [
      { ipId: 'ip_core', name: '선택 코어', effect: 'key', modelUrl: 'assets/core.glb' },
      { ipId: 'ip_guide', name: '선택 안내인', effect: 'score', modelUrl: 'assets/guide.glb' },
    ],
    enemies: [],
    objective: { type: 'talk', target: 1 },
    difficulty: 'normal',
    dialogue: [],
    quest: null,
    world: {
      width, depth, groundColor: '#526550',
      spawn: { x: -3, z: depth * .4 },
      npc: { id: 'guide', propIndex: 1, name: '선택 안내인', x: -12, z: depth * .37 },
      entities: [
        { id: 'delivery', kind: 'beacon', x: width * .3, z: 0, width: 4, height: 2, solid: false },
      ],
      propPlacements: [
        { id: 'core', propIndex: 0, x: -4, z: depth * .16, stageId: 'recover' },
      ],
      enemySpawns: [],
      city: {
        seed,
        trafficCount: 8,
        districts: [
          { id: 'west', name: '산업 지구', style: 'industrial', x: -width / 3, z: 0, width: width / 3, depth: depth / 2 },
          { id: 'center', name: '도심 지구', style: 'downtown', x: 0, z: 0, width: width / 3, depth: depth / 2 },
          { id: 'east', name: '주거 지구', style: 'residential', x: width / 3, z: 0, width: width / 3, depth: depth / 2 },
        ],
        streets: [
          { id: 'east_west_south', axis: 'x', coordinate: -depth * .32, width: 16 },
          { id: 'east_west_center', axis: 'x', coordinate: 0, width: 16 },
          { id: 'east_west_north', axis: 'x', coordinate: depth * .32, width: 16 },
          { id: 'north_south_west', axis: 'z', coordinate: -width * .32, width: 16 },
          { id: 'north_south_center', axis: 'z', coordinate: 0, width: 16 },
          { id: 'north_south_east', axis: 'z', coordinate: width * .32, width: 16 },
        ],
        vehicles: [{ id: 'quest_car', kind: 'suv', x: 0, z: depth * .4 - 4, yaw: 0 }],
        pedestrians: [{
          id: 'walker', propIndex: 1, x: -12, z: depth * .16,
          route: [{ x: -12, z: depth * .16 }, { x: -12, z: depth * .32 + 12 }],
        }],
      },
    },
    mission: {
      title: '도시 코어 운송',
      successText: '운송 완료',
      stages: [
        { id: 'briefing', type: 'talk', label: '안내인에게 임무 받기', target: 1, entityIds: ['guide'], propIndex: 1 },
        { id: 'recover', type: 'collect', label: '선택한 코어 회수', target: 1, entityIds: ['core'], propIndex: 0 },
        { id: 'drive', type: 'drive', label: '지구 사이 코어 운송', target: 1, entityIds: ['quest_car'], distanceMeters: width * .25 },
        { id: 'deliver', type: 'reach', label: '운송 지점 도착', target: 1, entityIds: ['delivery'] },
      ],
    },
  };
}
