# Human Project

- 当前开发入口是 `01_code/custom-gestures/index.html`。直接改代码和运行机制检查即可推进，P02 真人材料在代码可用后采集。
- 使用现有 MediaPipe Hand Landmarker 和 DTW。首版范围是右手动态轨迹，手势身份和动作功能独立。完整幻灯片播放器由成员2接入。
- `01_code/development-v41/` 及 P01 原配置和验证资料用于旧版回归。保持原数据，复现结果时区分旧版引擎和新版引擎。
- 在交付根目录运行 `node ./01_code/check-custom.mjs` 与 `node ./01_code/check-development.mjs`。合成检查只记录机制结果。P02 真人材料和个人成绩使用 P02 本人的数据。
- 遵守 `body-right-v1` 和严格递增的媒体毫秒时间，保留 `hand: null`。每个新视频源重新创建追踪与识别实例。
- 配置、运行记录和原视频要分别保存，保留实际引擎、特征、参数、绑定、来源和修订。成员2播放器接口与成员3标注、复核和对照接口见 `04_docs/`。

