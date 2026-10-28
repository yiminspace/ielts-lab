# 听力后的读、聊、写

听力作答保存成功后，每个 Part 创建一份课程，完整套卷的四份课程按同一次听力分组。
生成在后台执行，不阻塞查看成绩或后续阅读、写作考试。旧记录导入不会批量触发生成。
没有可用原文、无法确认 Part、或模型服务未配置时，页面显示实际原因；保留已保存的作答。

## 学习流程

- 阅读保留完整原文与翻译，根据篇幅设定出题目标，交付 5–14 道合格理解题并优先覆盖多种题型；作答后返回答案、引用与解释。
- 口语使用 Morning 的主题交流方式：从原文主题开场，逐轮回应最新内容和追问，允许自然转话题。
  可以用文字或录音，按需查看开头提示或请求忠实于原意的英文表达帮助。学习结果不表示正式考试成绩。
- 写作有基础、延伸、挑战三种可选任务，反馈区分语言错误和表达建议，并允许语法追问。
- Part 1 到 Part 4 依次增加具体描述、连贯展开、比较解释、抽象论证要求；口语目标为 6.5。
  这是本应用的课程策略，Part 编号不等于官方分数或 CEFR 等级。发音评分尚未实现。

## 架构

通用执行包来自私有仓 `yiminspace/agent-runtime`，具体提交固定在 `services/learning/pyproject.toml`。
Python 业务服务位于 `services/learning`，使用 Pydantic AI 与 Pydantic Graph。它定义课程、独立验题、
局部修订、交流与写作评价；通用 runtime 不包含 IELTS 或 Engram 教学内容。

Node API 保留 AuthKit 与固定 owner 授权，按实体保存课程及学习记录。线上 PostgreSQL 使用单独迁移角色、
非 owner 运行角色和 FORCE RLS；本机使用独立的原子课程文件。请求具有版本检查与稳定 requestId。
课程生成输入由 API 从允许的资料中读取，不接受浏览器替换原文或标准答案。

runtime 在私有 SQLite 文件中保存任务、已完成步骤和追加事件，使用租约、心跳与 fencing 防止过期 worker 写入。
关闭页面不取消后台任务；进程重启可重新领取任务，并复用已提交步骤。外部模型和语音调用仍可能在中断后重复，
不能保证外部副作用 exactly-once。课程和作答写入的幂等由 IELTS 业务层负责。

## 本机运行

1. 使用有私有仓读取权限的 Git 身份安装依赖：`uv sync --locked --project services/learning`。
2. 将 `services/learning/.env.example` 的字段填入被忽略的 `.local/learning.env`，设置文件权限为 600。
   `IELTS_RUNTIME_TOKEN` 至少 32 字符。模型地址为 OpenAI-compatible 网关，模型与语音能力单独配置。
3. 执行 `npm run dev:daily`；可用 `npm run dev:daily -- --demo` 仅使用原创材料。
   原有 `npm run dev` 继续支持没有 AI 的练习；新课程明确显示配置状态。

所有模型密钥只在服务端使用。不要将 `.env`、SQLite、录音、用户材料或真实作答提交 Git。
独立 virtual key 应仅允许所选文本、ASR 与 TTS 模型；不复用 Engram 应用密钥。

## 部署边界

`deploy/learning.Dockerfile` 从固定的 runtime checkout 构建；需要名为 `agent-runtime` 的构建上下文。
`deploy/learning.compose.yml` 是可选部署 overlay，不发布 Python 服务端口。Node 与 Python 使用一致的内部 token，
网关密钥只放 `learning.env`，Node 的 `api-learning.env` 仅包含内部 token。

构建不读取生产配置。私有 `agent-runtime` 仓的 `consumer-image.yml` 用自身 GitHub Token 读取固定 runtime 提交，
仅接受已进入 IELTS `main` 的完整提交 SHA；离线测试后构建 learning 镜像并返回不可变摘要。
IELTS 的 `Release IELTS` 手动部署入口接收该摘要，构建同一主分支提交的 API/Web 镜像，再由受保护 production job
解密四份 IELTS 专属配置、发布三个镜像。公共仓库不保存跨仓库个人令牌或私有源码工件。

服务器只拉取并校验固定仓库、平台、提交及摘要；learning 没有公开端口。
`data/daily` 与 `data/runtime` 绑定为独立私有目录。format2 备份同时停写 API/learning，捕获 PostgreSQL、
Daily 音频和 SQLite/WAL；旧 format1 仍可恢复。发布和备份共用维护锁。

首次 001→002 为新增表迁移，不删除旧记录；旧版 API 的严格 schema 检查不兼容回退至 schema2。
因此首次升级先做完整备份，并在隔离服务验证受限数据库角色、同版镜像和真实生成链路；数据库不会自动降级。

## 验证

使用独立测试数据库与原创样例；浏览器测试的语音输入可由明确标记的测试录音替代。
自动测试验证数据流、授权、保存与恢复，不代表已验证所有真题、真实发音效果或正式 IELTS 评分一致性。
本轮实际执行结果记录在 `coverage.md`，模型网关实测单独注明。

## 2026-10-28 生产启用

已部署版本 `5144fb5d31f498c26e933b7001ffd1970bb21ed6`，入口为 [IELTS Lab Daily](https://ielts.yiminlab.site/#/daily)。新的听力交卷自动生成课程；历史记录导入不会批量生成。生产启用独立 IELTS virtual key，内部 learning 端口不对公网发布。

实际发布镜像已用原创材料和独立数据库跑通完整学习链路；生产容器也已直接验证内网网关的 LLM/ASR/TTS。平台每日快照升级到 v4，包含音频、SQLite 任务与配置，两个服务在同一维护锁内停写并恢复。具体上线、备份和验收边界见 [coverage](coverage.md#生产部署与实际镜像验收)。

## 交付阈值

8–10 等题量档位是出题目标；正式交付允许 5–14 道通过校验的题，题型覆盖是偏好。少量坏题会被剔除或局部修订，最终只保留通过独立审核的题；合格题不足 5 道时仍需重试，已保存作答和任务检查点保留。固定选项和纯空白差异由程序规范化，原文事实及答案检查继续生效。
