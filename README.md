# IELTS Lab

个人雅思学习与练习工具，支持听力、阅读、写作、口语和基础训练。

提供草稿保存、练习记录与复盘，支持本地运行和个人在线使用。

学习材料及个人数据独立保存，不包含在仓库中。

听力交卷后可自动生成阅读、主题交流与写作练习，按听力 Part 1–4 递进，口语训练目标为 6.5。
AI 执行使用独立私有仓 `yiminspace/agent-runtime`；本仓只定义 IELTS 的课程和教学规则。

基础运行：`npm ci`、`npm run dev`。启用 AI 后运行 `npm run dev:daily`；配置、部署和验证边界见
[听后练习与 runtime](docs/daily-runtime.md)。
