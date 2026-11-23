# Human Project

- 当前开发入口是 `01_code/custom-gestures/index.html`。P02 的已标注视频和冻结实验配置保存在工作区 `P02_calibration`。新录的独立验证视频只做回放与评估。
- `01_code/custom-gestures/video-study.html` 提供本地视频、标注、A/B/C 学习、冻结实验包和回放。已有视频复测结果应单独标记。P111 复测使用当前提交的示范配置。
- v4 使用现有 MediaPipe Hand Landmarker 分别追踪每只手，匹配单手示范。静态手型用近邻，短动态用掌心轨迹和手指形态的 DTW。手势身份和动作功能独立。完整幻灯片播放器由成员2接入。
- `01_code/development-v41/` 及 P01 原配置和验证资料用于旧版回归。保持原数据，复现结果时区分旧版引擎和新版引擎。
- 在交付根目录运行 `node ./01_code/check-custom.mjs` 与 `node ./01_code/check-development.mjs`。合成检查只记录机制结果。P02 真人材料和个人成绩使用 P02 本人的数据。
- 遵守 `body-right-v1` 和严格递增的媒体毫秒时间，保留 `hand: null`。每个新视频源重新创建追踪与识别实例。
- 配置、运行记录和原视频要分别保存，保留实际引擎、特征、参数、绑定、来源和修订。完整意图标注可直接驱动自动取样。成员2播放器接口与成员3标注和对照接口见 `04_docs/`。

