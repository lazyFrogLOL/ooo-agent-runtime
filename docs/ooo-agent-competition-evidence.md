# Agent OOO / speculation 竞品证据（2026-09 检索）

已阅读用户 README、DSH-OOO-Loop-设计与技术报告。本项目当前核心是非推测的依赖就绪执行、单槽 REASON、后台 TOOL、spawn/reroute、祖先锥提示词；推测、完整副作用提交与 durable recovery 尚属不同程度的 roadmap。不能把 Python 原型有 commit gate 与 DSH 全链路安全已完成混为一谈。

## 关键结论

已经存在直接将 CPU OOO/scoreboard 类比用于 LLM agent 的工作：AI Metropolis（2024），原文明确写“Similar to the scoreboard in out-of-order execution algorithms”。它不是本项目完全同构的单 agent 工具 runtime，但足以否定“首次把 CPU 乱序执行用于 Agent”的泛化表述。[9]

LLMCompiler 不仅是批量并行：论文 §3.4 有动态 replanning，§4.2 有 streamed planner，任务依赖齐备即可执行；不能把它写成静态 DAG 或纯 parallel-join。[1]

| 工作 / 年份 | 已读一手证据、机制 | 与本项目相似 / 差异 | 成熟度边界 |
|---|---|---|---|
| AI Metropolis，2024 | 时空依赖图类似 scoreboard，去除多 agent 模拟的虚假全局同步；论文报告较 parallel-sync 1.3–4.15×。[9] | 最直接的 CPU OOO 类比先例；按真实依赖推进。对象是模拟世界中多个 agent 的时间步，不是工具 DAG 的副作用退休。 | 研究引擎，评测回放 GenAgent traces；论文写计划开源，本次未核实官方公开仓库。 |
| LLMCompiler，2023 预印本 / ICML 2024 | Planner→Task Fetching Unit→Executor；依赖追踪、流式规划、动态重规划；最高 3.7× 是论文相对 ReAct 的报告。[1][10] | 当前最该实跑的机制基线；本项目可差异化在分支局部 continuation/reroute、祖先上下文和安全提交。不能声称对方不动态/不流式。 | 官方开源，LangGraph/LlamaIndex 集成；已读仓库显示最新 main commit 2024-07-10，是研究框架而非完整事务 runtime。 |
| ReWOO，2023 | Planner/Worker/Solver 解耦，先规划变量引用，再收集工具证据，减少反复带历史调用；作者报告 HotpotQA 5× token efficiency。[2] | 都分离推理和工具；ReWOO 强在已可预见计划和 token 成本，而非观察返回后局部动态发现、不阻塞 continuation。 | 官方 MIT 研究实现，有数据/运行命令；不能据此宣称通用 ROB 或恢复系统。 |
| Speculative Actions，2025 / ICLR 2026 Oral | 快 Speculator 预测未来 API 响应/动作，提前发起后续调用；权威 Actor 匹配才复用；明确来自微处理器推测执行。论文最高延迟减少 20%。[7][12] | 比本项目当前版更进一步跨越未知依赖，而不是仅执行 READY；需要验证和可逆/隔离的副作用。 | 会议论文+公开分环境代码；chess/ecommerce/HotpotQA 无损核心，OS tuning 明确是有损扩展，不是现成通用 runtime。[11] |
| PASTE，2026-03 | 从历史调用挖 pattern tuple，预测工具和参数映射；authoritative 优先，推测仅用 slack，可抢占、匹配后 promote；平均完成时间 -48.5% 为论文报告。[3] | 可借鉴 pure 工具预取与预算；它预测尚未权威发出的调用，本项目当前不是 speculative。 | 论文称审稿后开源；策略显式声明安全性，可 dry-run/staging，不自动推断无副作用。未核实公开可安装成品。 |
| B-PASTE，2026-04 | 从单工具推测扩为 bounded branch/DAG beam；关键路径收益、资源干扰、下游解锁价值；CoW 隔离和 commit barriers，引用 Tomasulo。[4] | 与项目 roadmap 很近，尤其“不为利用率而并行”和提前解锁；比当前实现多了分支预测/隔离。 | 预印本、初步内部 Thor-class 实验，up to 1.4×；公开代码和充分复现证据未核实，不能等同成熟实现。 |
| AOSpec，2026-08 | 动作+观察共同推测；EVD 优化隐藏时间而非命中率；JASV 同时验证 action 和 origin state；CoW root hash 验证后复用。[5] | 是安全推测 roadmap 的强参考；只比 action/参数不够，必须比状态。本项目尚无此机制。 | 预印本；依赖匿名审稿中的 CoW runtime；非文件系统输入/副作用明确排除。11.8–32.5% 收益来自固定 actor trajectory 回放、按 token 数与 TPOT 建模，不是九种现场完整端到端运行。 |
| AgentSpec，2026-08 | 在 vLLM 中实现语义分段结构隔离 drafting 和 redundancy-aware token budget。[6] | 名字含 Agent 但仍是 token speculative decoding；不预测并执行外部工具，不提供 DAG/ROB/副作用提交。可与本项目叠加。 | 预印本、有 vLLM 实验实现与配置；未核实已合并 vLLM 主干或公开独立代码。 |
| vLLM speculative decoding，持续维护文档 | draft-model/EAGLE/MTP/ngram/suffix 等；优化 inter-token latency，target 验证候选 token。[8] | 推测的是输出 token，不是外部动作；优化推理时间，不消除 tool join barrier。 | 正式文档、CLI、测试；实际加速依模型/硬件/QPS，不能笼统叫“vLLM 已有 speculative agent runtime”。 |
| Google ADK long-running / streaming tools，当前文档 | 长任务期间 agent 可做其他工作；streaming tool AsyncGenerator 返回中间结果。[13][14] | 直接反例于“所有主流框架都等所有工具再继续”；但不等于自动动态 DAG、推测或事务提交。 | 可用框架功能；所读 streaming 文档明确 Experimental 且仅 ADK Gemini Live APIs，不应推广到所有模型和所有 ADK loop。 |

## 对定位与改进的建议（本次分析）

1. 定位为“针对单 agent 发现式工作流的事件驱动依赖调度原型”，不是首个 agent OOO，也不是已具备完整 speculative ROB。
2. 当前 commit gate 若只检查 depends_on DONE，属于依赖就绪门禁，不自动等于 CPU 的程序序退休、精确异常或外部副作用可回滚；应分开执行完成、验证完成、可见性提交。
3. 必须加入 LLMCompiler streamed + replan 基线；用同模型、同任务、token/成本、质量和 wall-clock 测试，分别报告预知 DAG 与发现式 DAG。
4. 先实现 effect policy、读写集/版本、幂等键、取消传播和恢复一致性，再接 pure-tool speculation；对网络支付/邮件等不可逆动作不能靠“稍后验证”补救。
5. “收益来自提前决策”适合作为本项目实验解释，不是全球新理论。B-PASTE 的 downstream unlock value 与 AOSpec 的 expected time hidden 已有相近优化目标。[4][5]
6. 记录 READY→dispatch、observation-ready→decision、follow-up launch、额外模型调用/token、浪费推测、取消残留和提交违规；保留目前阴性结果，但目前报告的小样本不是总体性能证明。

## 检索限制

确实检索到 OOO/scoreboard 先例；未检索到可验证的“通用 LLM agent 完整 ROB 实现”不能解释为不存在。部分关键词搜索失败/偏向硬件专利，已改查询补检。抽取服务对若干 arXiv HTML 返回过短内容，已用 HTTP 获取全文复核。OpenReview 有验证墙；ICLR 官方页面已 HTTP 200 读取并确认 Oral 标题。未运行竞品代码；成熟度判断基于一手论文和仓库，不等于独立复现。

## Sources

[1] https://arxiv.org/html/2312.04511v3
[2] https://github.com/billxbf/ReWOO
[3] https://arxiv.org/html/2603.18897v1
[4] https://arxiv.org/html/2604.16469v1
[5] https://arxiv.org/html/2608.00881
[6] https://arxiv.org/html/2608.24004
[7] https://arxiv.org/html/2510.04371
[8] https://docs.vllm.ai/en/latest/features/speculative_decoding
[9] https://arxiv.org/html/2411.03519v1
[10] https://github.com/SqueezeAILab/LLMCompiler
[11] https://github.com/naimengye/speculative-action
[12] https://iclr.cc/virtual/2026/oral/10009727
[13] https://google.github.io/adk-docs/tools/function-tools
[14] https://google.github.io/adk-docs/streaming/streaming-tools
