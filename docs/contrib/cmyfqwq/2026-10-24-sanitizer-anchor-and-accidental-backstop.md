# 脱敏正则的两个坑：行首锚定放过带前缀形态；「意外兜底」让漏报例子失真（#508 / PR #516）

## 现象

诊断包出口（`LogSanitizer.sanitizeOrNull`）审计发现两类漏网形态，但初审报告里的一条「漏网例」在实测复查时被证明是**误报**——两种坑都值得记。

## 真因一：行首锚定 vs 带前缀的真实日志形态

`COOKIE_HEADER` 与 `ENV_SECRET_LINE` 都用 `^` 锚定行首：

- curl verbose / HTTP 抓包导出的请求头是 `> Cookie: session=…`——前缀字符 `>` 让 `^(\s*cookie…)` 不命中，整行放过；`SENSITIVE_KV` 键名表里也没有 `session`，无兜底
- `export OPENAI_API_KEY=…` 行首是 `export`，`^[A-Z]…` 不命中

修法各一行正则：`\b` 定位头名（冒号包进捕获组，头名保留）、ENV 允许可选 `export` 前缀。

## 真因二：「意外兜底」让表面例子失真——脱敏断言必须逐规则实测

初审把 `export GITEE_TOKEN=…` 列为漏网例。**实测不成立**：`SENSITIVE_KV` 是**无左边界子串匹配**，`GITEE_TOKEN=` 的尾部 `TOKEN=` 恰好命中裸 `token` 键名——被意外兜住。真漏面收窄为裸 `KEY` 后缀（表中只登记 `api[_-]?key`）。同类教训：`cat ~/".credentials.yaml"` 也被以为能绕过黑名单——`containsMatchIn` 找的是子串，引号在子串**两侧**时路径仍连续，拦得住；只有把字面量**从中拆断**（`'.cred'entials.yaml`）才真绕过。

结论：**脱敏/拦截类正则的漏报断言必须用真实正则逐条跑过再报**，靠读正则脑推会把「规则冗余的意外兜底」错当「缺口」，Issue 勘误的成本比实测高。

## 修法与复验

- PR #516：两条正则 + `LogSanitizerTest` 两正例（原值一个字符不出现 + 键名/无关行保留断言）
- 新增打码面复核：ENV 仍只认 `=`（yaml 的 `:` 根本不在其规则面，无 yaml 摘录误伤）；COOKIE 的 `\b` 对 JSON 形态（`"set-cookie":"x"`）不误伤（引号挡住冒号匹配）
- 实测脚本形态参考 issue #508 / #512 内嵌的 node 单行验证
