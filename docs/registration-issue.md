# 报名 Issue 文案

按活动规则，报名需在活动仓库
[M-China/mcd-developer-innovation-challenge](https://github.com/M-China/mcd-developer-innovation-challenge)
的 Issue 列表中，使用标准格式提交参赛申请。

> **提交前请先替换下文中的占位符**：`<你的GitHub用户名>`。

---

## 复制以下内容提交 Issue

**Issue 标题：**

```text
麦麦双赢 M-Dual Planner：预算 × 营养双目标麦当劳配餐引擎
```

**Issue 正文：**

```text
【参赛申请】
项目名称：麦麦双赢 M-Dual Planner
项目地址：https://github.com/<你的GitHub用户名>/mcd-dual-planner
项目简介：
输入预算和营养目标（热量 / 蛋白质 / 钠），基于麦当劳中国 MCP 的真实菜单、官方营养库、
优惠券与官方算价，求解「花得最少、吃得最对」的那一餐。项目把省钱与营养建模为同一个
约束优化问题的两个目标，输出帕累托前沿与三个可执行结论：达标方案里最便宜的（双赢推荐）、
预算内营养最好的（营养上限）、绝对最便宜的（省钱底线），并生成一张每个数字都可追溯来源的
SVG 战报。零第三方依赖，全程只读，不领券不下单。
```

---

## 提交前自检清单

### 报名资格（官方硬性要求）

| 检查项 | 要求 | 状态 |
|---|---|:--:|
| `README.md` | 项目介绍、安装方法、使用示例、目标用户，文件名不可改动 | ✅ |
| `CONTEST_DECLARATION.md` | **官方原文，文件名与内容均不可改动**（1522 bytes，SHA256 `CD28101B…`） | ✅ |
| `MCP_INTEGRATION.md` | 说明实际使用的 Server / Tool / 调用流程 / 业务价值 | ✅ |
| `mcp-config.example.json` | 脱敏配置示例，**只允许环境变量占位符** | ✅ |
| `workbuddy.md` | 参与 WorkBuddy 专项奖励时必须提交；**需替换为真实会话记录** | ⚠️ 见下 |
| 项目真实使用麦当劳 MCP | 代码中实际调用官方接口 | ✅ |
| 项目真实使用腾讯 WorkBuddy | 需真实使用并提交 `workbuddy.md` | ⚠️ 见下 |
| 仓库公开可访问 | Public 仓库 | ⏳ 建仓后确认 |
| 仓库创建时间 | 2025-12-25 00:00 至 2026-10-25 23:59（北京时间） | ⏳ 建仓即满足 |
| 报名时间 | 2026-10-09 10:30 至 2026-10-25 23:59（北京时间） | ⏳ |
| 参赛者资格 | 中国大陆合法居民，年龄 ≥ 18（或监护人同意） | ⏳ 自行确认 |

### 内容合规

- [x] 不含违法违规、低俗、暴力、歧视等内容；
- [x] 不含恶意代码、病毒、后门、钓鱼链接；
- [x] **不含真实 Token、密钥、密码、账号凭证**（有自动化测试扫描全仓库）；
- [x] 不含他人个人信息（项目不采集手机号、地址、订单号）；
- [x] 不贬低、不对比其他品牌；
- [x] 原创代码，MIT 许可；官方材料与商标归其权利人所有。

### 加分项

- [x] 战报示例图已放入 `examples/`，README 直接可见；
- [x] 48 个单元测试，`npm test` 可复现；
- [x] 零依赖，评审 `git clone` 即可运行；
- [x] 已知限制与未验证项如实列出（`docs/ACCEPTANCE.md`）；
- [x] GitHub Actions 工作流（`.github/workflows/ci.yml`）：跑测试、离线冒烟、SVG 几何校验，
      并**校验参赛声明文件的 SHA256 未被改动**；
- [ ] **建仓后**：补充仓库 Topics（`mcdonalds` `mcp` `workbuddy` `nutrition` `optimization`）；
- [ ] **建仓后**：把 README 顶部徽章换成真实的 Actions 状态徽章。

---

## 建仓与提交步骤

```bash
# 1) 在 GitHub 创建公开仓库（仓库名建议 mcd-dual-planner），然后：

# 2) 关联远端并推送
git init
git add .
git commit -m "feat: 麦麦双赢 M-Dual Planner —— 预算×营养双目标配餐引擎"
git branch -M main
git remote add origin https://github.com/<你的GitHub用户名>/mcd-dual-planner.git
git push -u origin main

# 3) 到活动仓库提交报名 Issue
#    https://github.com/M-China/mcd-developer-innovation-challenge/issues/new
```

## 两个必须由本人完成的动作

1. **接入真实 MCP Token 并跑一次实时验证**：按 [ACCEPTANCE.md](ACCEPTANCE.md) 第 3 节执行，
   回填 12 项验证结果。没有这一步，项目里「实时模式」的部分只能算未验证。
2. **用 WorkBuddy 真实开发并替换 `workbuddy.md`**：当前该文件是复现任务清单，不是真实会话记录。
   请按 [workbuddy.md](../workbuddy.md) 的任务逐条在 WorkBuddy 中执行，导出真实上下文后替换，
   再提交报名。若最终未使用 WorkBuddy，请从报名材料中移除该文件，不要提交非真实记录。

## 排名机制提醒

- 排名依据是**项目在 GitHub 上获得的公开 Star 数**（活动开始前已获得的 Star 也计入）；
- **Star 为 0 的项目不进入排行榜**，Star 数相同则并列；
- 同一账号多个项目只有 Star 最高的一个进榜；
- 定榜数据为 **2026-10-26 00:00（北京时间）**，之后不再变动。

因此建仓后值得做的一件事：把项目**发到开发者社区**（V2EX、LINUX DO、即刻、小红书等）让人
真的去用一遍——一个能被陌生人在 2 分钟内跑出结果的工具，比任何宣传语都更能换来 Star。
