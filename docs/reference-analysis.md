# 官方参考界面的静态证据

核对日期：2026-10-18（Asia/Shanghai，约 09:34–09:39）。范围为公开熟悉测试入口及该入口直接引用的静态资源。本轮使用无凭据的 `curl` 和本地文本、SHA-256 检查；未运行 REA。官方文件只用于临时分析，仓库保存下面的元数据与原创分析。

## 实际取得的资源

以下请求均返回 HTTP 200。版本目录 `3.60.0` 是此次观察到的静态发布路径，不据此推断整个 Inspera 产品版本。

| 资源      | 精确 URL                                                                        | 响应字节数 | SHA-256                                                            |
| --------- | ------------------------------------------------------------------------------- | ---------: | ------------------------------------------------------------------ |
| 入口 HTML | <https://demo-ielts.inspera.com/player/?assessmentRunId=131012334&context=exam> |     18,593 | `87ac003ec76d5487a21ea08490813aae1c1c8ea8ce75e88b9132b870e711c9f3` |
| 启动脚本  | <https://d2snzxottmona5.cloudfront.net/releases/3.60.0/playerStartup.js>        |     10,527 | `002c4c53231e04b06b73e084eae43f1967937b84235920b6f87b536281f67b40` |
| 主脚本    | <https://d2snzxottmona5.cloudfront.net/releases/3.60.0/bundle.js>               |  5,322,104 | `4ac70b818b818ee72546d05e70bc7abc999c1d31be372953609c6a3e13796db5` |
| 样式      | <https://d2snzxottmona5.cloudfront.net/releases/3.60.0/player.css>              |    761,075 | `c102c5fc853b6218ab818fb560cfc5fb0a9cf238a7e6cc6b6a179431bd60e135` |

HTML 的散列标识单次响应；动态初始化内容可能使以后请求的散列变化。JS、CSS 的散列可用来核对静态参考是否改变。

入口显式引用启动脚本，并包含主脚本和样式 URL；另有 CloudFront favicon 与 `/testplayer/lib/trackjs/3.7.6/t.js` 引用。后两项仅记录 HTML 中的引用，没有取回或运行。

主脚本存在 `react.production.min.js`、`react-dom.production.min.js` 标记和 `ReactDOM` 符号，支持“包含 React / ReactDOM 生产构建”的判断；也出现 `redux` 文本，具体版本及使用范围未核定。未据字符串缺失推断不存在其他框架。样式中统计到 20 条 `@font-face` 和 108 条 `@media`，表明样式覆盖字体与不同显示条件；这些计数不能代替浏览器视觉验收。

三个静态文件分别声明 `playerStartup.js.map`、`bundle.js.map`、`player.css.map`。本轮只核对声明，未请求映射文件，故不能声称已恢复原始组件源码。

## 对复刻工作的含义

这类浏览器前端已经以 JavaScript、CSS 形式公开交付。REA 或常规静态分析可以辅助整理压缩代码、资源依赖、前端状态与控件实现线索；如果合法公开提供的源码映射可取得，可能进一步定位原始模块。这里更准确的工作是分析构建产物并原创重建可见交互，不能仅因取到 `bundle.js` 就宣称已恢复完整项目。

静态资源有助于理解布局、题型控件、导航、主题、字体和客户端状态处理。具体尺寸、焦点、快捷键、弹窗、拖放及窄屏效果仍应与实际页面逐项比较。本项目依据可见行为和已有材料契约实现自己的界面，不将官方脚本、样式、考试题目或音频纳入 Git。

客户端证据无法还原未交付给浏览器的服务端代码、真实考场管理、身份核验、评分服务、题库授权及监考系统。静态分析没有主动调用身份、会话、试题数据或提交作答接口；浏览器观察仅正常打开公开演示。公开包中出现功能名称也不能证明当前熟悉测试启用了这些功能。

## 熟悉测试与正式考试的边界

[IDP 官方熟悉测试说明](https://ielts.idp.com/about/ielts-familiarisation-tests)说明练习用于熟悉操作，练习不计时，计时、高亮和笔记功能与正式考试存在差别。本轮该页官方搜索索引可读，直接打开返回 403；因此同时用可直接读取的 [IELTS 官方 Academic sample test questions 页面](https://www.ielts.org/take-a-test/preparation-resources/sample-test-questions/academic-test)的 “IELTS practice experience” 段交叉核对，后者也明确说明相同差异。

因此，这个参考可以支撑“熟悉测试界面与操作流程的复现”，不能单凭它保证与当前每个考点的正式考试完全一致。验收应分别记录：参考页实际观察、原创实现结果、真实归档适配和仍未验证的正式考试行为。
