export const sampleRehearsal = {
  url: import.meta.env.BASE_URL + 'rehearsal-demo.mp4',
  intervals: [6400, 14800, 24200].map(start => ({
    startMs: start - 650, endMs: start + 450, name: '右滑示意'
  }))
};

export const sampleSlides = [
  ['项目概览', '手势控制翻页', '录制个人示范，在讲解时用手势控制幻灯片。'],
  ['手势注册', '静态与短动态', '为每个手势录制多次示范，以适应自己的动作习惯。'],
  ['动作绑定', '上一页、下一页、暂停', '同一个手势可以重新绑定，无需重新录制。'],
  ['试讲校准', '学习正例和反例', '标出主动手势区间，生成冻结的 A、B、C 配置。'],
  ['放映控制', '从摄像头到播放器', '暂停时保留识别，恢复手势可以重新打开翻页。'],
  ['独立试讲', '用新录像回放', '使用同一段独立素材比较冻结配置的表现。']
];

export function createPresentationDemo(profiles, trajectories, recognizer) {
  const directions = {
    right: { gestureName: '右滑', actionId: 'next_page', dx: .12, dy: 0 },
    left: { gestureName: '左滑', actionId: 'previous_page', dx: -.12, dy: 0 },
    up: { gestureName: '上移', actionId: 'toggle_gesture_control', dx: 0, dy: -.16 }
  };
  function stroke(key, start) {
    const { dx, dy } = directions[key];
    return Array.from({ length: 25 }, (_, index) => {
      const elapsed = index * 50;
      const progress = Math.min(1, Math.max(0, (elapsed - 200) / 600));
      return {
        tMs: start + elapsed, aspect: 4 / 3, side: 'Right', coordinateSystem: 'body-right-v1',
        hand: Array.from({ length: 21 }, (_, joint) => ({
          x: .45 + dx * progress, y: .55 + dy * progress - joint * .008, z: 0
        }))
      };
    });
  }
  const gestures = Object.entries(directions).map(([key, definition]) => ({
    ...profiles.createGesture(definition.gestureName, definition.actionId, 'dynamic'),
    positives: [profiles.createExample(trajectories.prepareExample(stroke(key, 0)), {
      runId: 'ui-demo-examples', kind: 'synthetic', sourceMirrored: false
    })]
  }));
  const profile = profiles.reviseProfile(profiles.createProfile('示例'), { gestures }, { kind: 'synthetic_registration' });
  const track = recognizer.createRun(profile, { kind: 'synthetic', synthetic: true }, 'capture');
  track.frames = ['right', 'right', 'left', 'up', 'right', 'up', 'right'].flatMap((key, index) => stroke(key, index * 1750));
  return { profile, track };
}
