# Human Project · 手势放映台

用摄像头注册静态或短动态手势，根据标注试讲学习正反例，再用个人配置控制 PDF 或图片幻灯片。试讲校准可冻结 A/B/C 三组配置，在另一段素材上回放评估。

## 快速运行

```powershell
Set-Location -LiteralPath "./gesture-deck"
npm ci
npm run dev
```

在 Chrome 或 Edge 打开 [手势放映台](http://127.0.0.1:4178/)。需要 Node.js 22.13+（22 系列）或 24+。Windows 下也可双击 `gesture-deck/start-demo.cmd`，让启动器构建并启动项目。首次安装依赖需要联网，构建后的浏览器运行使用本地模型与资源。

在 `gesture-deck/` 运行 `npm test` 检查引擎回归，运行 `npm run build` 生成静态产物。已有校准轨迹可用于无摄像头复现注册配置导入、标注、学习、独立评估与实际翻页。[完整使用与复现步骤](gesture-deck/README.md)

## 技术分析

记录了同轨迹改动前后的校准耗时、A/B/C 对照、目前验证的边界，以及分阶段的算法和流程改进建议。[技术复盘与答辩建议](gesture-deck/TECHNICAL-REVIEW.md)

## 仓库内容

| 位置 | 内容 |
| --- | --- |
| [gesture-deck](gesture-deck/) | 三部分联调版的应用入口、源码、模型、启动器和示例 |
| [HAI_Part1交付包_v4.1](HAI_Part1交付包_v4.1/) | 注册与视频学习原型、旧版 4.1 基线和实验说明 |
| [P02_calibration](P02_calibration/) | 校准轨迹、标注、冻结配置和独立验证报告 |
| [P111_video_study](P111_video_study/) | 较灵敏匹配、既有视频复测，以及浏览器学习和回放证据 |
| [成员 2 接入与分工](TEAM_HANDOFF.md) | 贡献说明、接口、界面任务和下一阶段安排 |
| [历史交接记录](CODEX_HANDOFF.md) | 迭代背景和主要版本变化 |

历史录屏通过 Git LFS 管理。如需查看录屏，在仓库根目录运行 `git lfs pull`。实验标注方法和时间基准详见[成员 3 的校准与实验说明](HAI_Part1交付包_v4.1/04_docs/成员3_校准与实验.md)。
