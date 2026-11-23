# Human Project · 手势控制

用摄像头注册静态或短动态手势，在演示中触发翻页，并从标注视频学习正反例。暂定流程为「注册示范 → 视频校准 → 冻结 A/B/C → 新视频评估」。原型已完成，当前进入成员 2 的界面、用户流程和播放器集成阶段。

## 快速运行

在仓库根目录打开 PowerShell，进入代码目录后启动本地服务。

```powershell
Set-Location -LiteralPath "./HAI_Part1交付包_v4.1/01_code"
.\start-custom-gestures.cmd
```

- [手势注册与识别演示](http://localhost:8766/custom-gestures/index.html)
- [视频学习与评估](http://localhost:8766/custom-gestures/video-study.html)

网页生成的 A、B、C 统一使用较灵敏设置。回放按实验包内冻结的配置运行。

浏览器运行依赖随仓库提供的 MediaPipe 模型和 WASM。两段历史录屏通过 Git LFS 管理。克隆后如看到录屏指针文件，在仓库根目录运行 `git lfs pull`。

## 仓库内容

| 位置 | 内容 |
| --- | --- |
| [HAI_Part1交付包_v4.1](HAI_Part1交付包_v4.1/) | 当前源码、启动器、测试脚本、MediaPipe 资源及旧版基线 |
| [P02_calibration](P02_calibration/) | 校准轨迹、标注、冻结配置和独立验证报告 |
| [P111_video_study](P111_video_study/) | 较灵敏匹配、既有视频复测，以及浏览器学习和回放证据 |
| [成员 2 接入与分工](TEAM_HANDOFF.md) | 贡献说明、接口、界面任务和下一阶段安排 |
| [历史交接记录](CODEX_HANDOFF.md) | 迭代背景和主要版本变化 |

暂定流程的浏览器操作、CLI 入口和实验方法详见[成员 3 的标注与实验说明](HAI_Part1交付包_v4.1/04_docs/成员3_校准与实验.md)。源代码备份按原目录保存在仓库根目录，可用作历史对照。实验目录里的关键点轨迹可用于复现已有回放。

## 本地检查

在 `HAI_Part1交付包_v4.1` 内运行以下命令。

```powershell
node ./01_code/check-custom.mjs
node ./01_code/check-development.mjs
```

两项检查覆盖当前手势流程与旧版回归。真人数据和实验结论的适用范围请以各自报告为准。
