# 听力后的读、聊、写

听力作答保存成功后，每个 Part 创建一份课程，完整套卷的四份课程按同一次听力分组。
生成在后台执行，不阻塞查看成绩或后续阅读、写作考试。旧记录导入不会批量触发生成。
没有可用原文、无法确认 Part、或模型服务未配置时，页面显示实际原因；保留已保存的作答。

## 学习流程

- 阅读保留完整原文与翻译，根据篇幅生成 5–14 道理解题，至少两种题型；作答后返回答案、引用与解释。
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

构建不读取生产配置。独立构建工作流需要私有仓只读 token；生产配置仍由可信部署任务使用 IELTS 专属密钥解密。
当前双镜像生产发布器尚未自动部署第三个 learning 镜像，不能直接把它描述为已上线。首次启用需安装此 overlay、
私有配置和固定镜像，并扩展可信发布器；服务器只拉镜像，不构建。

Daily 原始录音位于 `DAILY_ROOT` 下的私有音频目录；runtime SQLite 位于单独卷。
现有生产备份脚本尚未覆盖这两个新增卷。首次线上启用前，需在停写窗口备份课程数据库、Daily 音频和 runtime 数据库，
并进行恢复验证。旧备份继续可恢复旧功能，不能声称包含新课程音频与任务检查点。

## 验证

使用独立测试数据库与原创样例；浏览器测试的语音输入可由明确标记的测试录音替代。
自动测试验证数据流、授权、保存与恢复，不代表已验证所有真题、真实发音效果或正式 IELTS 评分一致性。
本轮实际执行结果记录在 `coverage.md`，模型网关实测单独注明。
