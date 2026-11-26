# Human Project · 手势放映台

用摄像头注册静态或短动态手势，根据标注试讲学习正反例，再用个人配置控制 PDF 或图片幻灯片。试讲校准可冻结 A/B/C 三组配置，在另一段素材上回放评估。

## 快速运行

```powershell
Set-Location -LiteralPath "./gesture-deck"
npm ci
npm run dev
```

在 Chrome 或 Edge 打开 [手势放映台](http://127.0.0.1:4178/)。需要 Node.js 22.13+（22 系列）或 24+。Windows 下也可双击 `gesture-deck/start-demo.cmd`，让启动器构建并启动项目。首次安装依赖需要联网，构建后的浏览器运行使用本地模型与资源。

在 `gesture-deck/` 运行 `npm test` 检查引擎回归，运行 `npm run build` 生成静态产物。右上角的「体验放映示例」可用合成轨迹检查翻页与暂停。[使用与新实验录制步骤](gesture-deck/README.md)

## 技术分析

记录了当前识别与校准的实现、A/B/C 对照方式，以及逐类拒识等改进建议。[技术复盘与答辩建议](gesture-deck/TECHNICAL-REVIEW.md)

## 仓库内容

| 位置 | 内容 |
| --- | --- |
| [gesture-deck](gesture-deck/) | 三部分联调版的应用入口、源码、模型、启动器和示例 |
| [历史分工与接口交接](TEAM_HANDOFF.md) | 贡献说明、接口、界面任务和下一阶段安排 |
| [历史交接记录](CODEX_HANDOFF.md) | 迭代背景和主要版本变化 |
